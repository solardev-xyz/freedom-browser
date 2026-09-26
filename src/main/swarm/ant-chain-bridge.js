const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { Transaction } = require('ethers');

const CHAIN_ID = 100;
const READ_METHODS = new Set([
  'eth_call',
  'eth_getBalance',
  'eth_getLogs',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_blockNumber',
  'eth_getCode',
]);
const MAX_BODY = 256 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const MAX_ACTIVE = 8;
const MAX_LOG_LINE = 64 * 1024;
const MAX_ERROR_MESSAGE = 500;
// A wide log scan gets a longer per-URL budget on the direct path than an
// interactive read would. The direct tier first tries endpoints quorum never
// asked, then retries, at this budget, quorum members that timed out without
// an answer, as far as the bridge's overall deadline allows.
const LOG_SCAN_DIRECT_TIMEOUT_MS = 60000;

// Ant v0.5.45 `is_range_limit_error` (crates/ant-chain/src/discover.rs): its
// eth_getLogs scan shrinks the window only when the error message contains
// one of these needles, and aborts owned-batch/chequebook recovery otherwise.
const ANT_LOG_SCAN_SHRINK_NEEDLES = Object.freeze([
  'block range',
  'range',
  'more than',
  'exceed',
  'too large',
  '10000',
  'limit',
  'logs matched',
  'response size',
  'up to a',
  'query timeout',
  'too many results',
]);

function antShrinksLogScanOn(message) {
  if (typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  return ANT_LOG_SCAN_SHRINK_NEEDLES.some((needle) => lower.includes(needle));
}

// Mirrors chain-data-router's ERROR_RANK (pinned equal by
// ant-chain-bridge.router.test.js); kept local so the bridge does not load the
// router just for three numbers.
const RANK = Object.freeze({ ENDPOINT: 0, TIMEOUT: 1, REQUEST: 2 });
const TIMEOUT_TEXT = /time(?:d)?[\s-]?out/i;
// Ant's needles are broad ("limit", "exceed", "more than", "10000"), so a
// matching reply is not evidence of a range limit by itself: throttles such
// as Infura's -32005 "project ID request rate exceeded", and EIP-1474's
// ambiguous -32005 "limit exceeded", match them too, yet another endpoint may
// answer. Only these
// wordings, which name the query's size (its block range, result count or
// response size), rank as REQUEST and end the request; any other coded reply
// falls through to later endpoints like any endpoint-dependent failure. A bare
// "range" is not enough: "block range extends beyond current head block"
// (reth) names the range but describes how far the endpoint has synced.
const RANGE_SIZE_TEXT =
  /(?:max(?:imum)?|allowed|permitted) (?:block )?range|exceeds? (?:the )?(?:block )?range|(?:block )?range (?:is |of )?(?:too\b|larger|greater|wider|bigger|longer|more than|limit|exceed|limited|capped|size|span)|(?:limited to|up to) (?:an? )?[\w,.]+ (?:block )?range/i;
const REQUEST_LIMIT_TEXT =
  /too many (?:results|logs|blocks)|response size|logs? matched|(?:returned )?more than [\d,]+ (?:results|logs|blocks)|(?:max(?:imum)?|too many) (?:number of )?(?:results|logs|blocks)|result(?:s| set)? (?:size |limit|too large|exceed)/i;
// Wordings that describe the endpoint, not the query, checked first so a
// throttle naming a range ("rate limit: 10 block-range requests per second")
// still falls through.
const ENDPOINT_LIMIT_TEXT =
  /\brate\b|rate[\s-]?limit|too many requests|\b429\b|quota|credits?\b|daily request|capacity|requests? (?:per|limit)|throttl/i;
// An endpoint behind the chain head (reth's "block range extends beyond
// current head block", Erigon's "requested block range [...] is beyond latest
// executed block N (node is still syncing)"): a synced endpoint may answer, so
// it never ends the request. Unlike a throttle its wording is not stripped:
// if it is all that reaches Ant, Ant reacts as it would against that RPC.
const ENDPOINT_STATE_TEXT =
  /beyond (?:the )?(?:current |latest )?(?:executed )?(?:head|latest|chain)|(?:still |is )syncing|not (?:yet )?synced|head block|latest executed block/i;

// How useful a failed eth_getLogs attempt is to Ant, for the router's
// single keep-the-most-useful-error rule:
// - REQUEST: an endpoint answered with a JSON-RPC error naming the query's
//   size (-32005 "query exceeds max block range 50000", "query returned more
//   than 10000 results", "response size exceeded"). It depends on the query,
//   so it ends the request and reaches Ant with its code and text intact.
// - TIMEOUT: a client, source or upstream timeout. Ant halves on it too, but
//   another endpoint or a longer retry may still answer.
// - ENDPOINT: everything else (method not found, internal error, rate limits
//   and other throttles, HTTP errors, transport failures, a source that is not
//   ready, an endpoint behind the chain head). The router keeps going and
//   never lets it displace a better error. When a throttle is what finally
//   reaches Ant, the bridge strips Ant's needles from it (antErrorReply) so
//   Ant does not halve on it; any other wording is forwarded as is, since it
//   may still be a range cap worded outside the lists above.
function rankLogScanError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (
    error?.failureKind === 'timeout' ||
    error?.name === 'AbortError' ||
    TIMEOUT_TEXT.test(message)
  ) {
    return RANK.TIMEOUT;
  }
  if (
    !Number.isSafeInteger(error?.code) ||
    ENDPOINT_LIMIT_TEXT.test(message) ||
    ENDPOINT_STATE_TEXT.test(message)
  ) {
    return RANK.ENDPOINT;
  }
  return (RANGE_SIZE_TEXT.test(message) || REQUEST_LIMIT_TEXT.test(message)) &&
    antShrinksLogScanOn(message)
    ? RANK.REQUEST
    : RANK.ENDPOINT;
}

// Forward the upstream wording (Ant keys retry decisions on it, e.g. "query
// exceeds max block range 50000") without URLs, which may carry RPC API keys,
// control characters or unbounded length.
function sanitizeErrorMessage(message) {
  if (typeof message !== 'string') return '';
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s;,)]+/gi, '[url]')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE);
}

// Router options for Ant's eth_getLogs (window-halving) scans.
const LOG_SCAN_ROUTER_OPTIONS = Object.freeze({
  directTimeoutMs: LOG_SCAN_DIRECT_TIMEOUT_MS,
  rankError: rankLogScanError,
});

// The JSON-RPC error Ant receives for a failed routed request. This is the
// daemon's URL transport, not the FFI callback: real -32000 codes are
// preserved and no second fallback/rebroadcast occurs here.
function antErrorReply(method, error) {
  const code = Number.isSafeInteger(error?.code) ? error.code : -32002;
  const data =
    typeof error?.data === 'string' &&
    /^0x[0-9a-f]*$/i.test(error.data) &&
    error.data.length <= MAX_BODY
      ? error.data
      : undefined;
  let detail = sanitizeErrorMessage(error?.message);
  // A timeout Ant cannot recognise (a source deadline worded without "query
  // timeout") still has to make it halve its window rather than give up.
  if (
    method === 'eth_getLogs' &&
    rankLogScanError(error) === RANK.TIMEOUT &&
    !antShrinksLogScanOn(detail)
  ) {
    detail = `query timeout (${detail})`;
  } else if (
    method === 'eth_getLogs' &&
    rankLogScanError(error) === RANK.ENDPOINT &&
    (!Number.isSafeInteger(error?.code) || ENDPOINT_LIMIT_TEXT.test(detail)) &&
    antShrinksLogScanOn(detail)
  ) {
    // A throttle (e.g. every RPC answered -32005 "rate limit exceeded") must
    // not read as a range limit to Ant, or it halves its window and repeats
    // the scan against the throttle. The code survives; the wording is
    // replaced with one that matches none of Ant's needles. Only a positively
    // identified throttle, or a failure no RPC answered (a source or transport
    // error has no JSON-RPC code), is rewritten: an unrecognised coded reply
    // ("query exceeds limit of 10000 logs", EIP-1474 "limit exceeded") may be
    // a real range cap, and Ant must still halve on it as it would against
    // the RPC directly.
    detail = 'endpoint unavailable';
  }
  const message =
    error?.code === 'MYOTIS_BROADCAST_UNCERTAIN'
      ? 'Broadcast outcome uncertain; reconcile the signed transaction'
      : code === 3
        ? 'Execution reverted'
        : `Chain request failed${detail ? `: ${detail}` : ''}`;
  return { code, message, data };
}

// Private daemon transport, not a renderer/dApp RPC endpoint. The URL capability
// is generated per start, passed only to our child, and never persisted.
async function startAntChainBridge({
  allowBroadcast = false,
  router = require('../networks/chain-data-router'),
  log = require('../logger'),
  timeoutMs = 120000,
} = {}) {
  const token = randomBytes(32).toString('hex');
  const route = `/ant-chain/${token}`;
  const active = new Set();
  let closed = false;
  let closePromise;
  let authority;
  function send(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    // Host check prevents DNS rebinding; Origin/Sec-Fetch rejection and the
    // unguessable path prevent websites from using local node authority.
    if (
      closed ||
      req.headers.host !== authority ||
      req.url !== route ||
      req.headers.origin !== undefined ||
      req.headers['sec-fetch-site'] !== undefined
    ) {
      send(res, 403, { error: 'Forbidden' });
      return;
    }
    if (
      req.method !== 'POST' ||
      !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
    ) {
      send(res, 415, { error: 'JSON POST required' });
      return;
    }
    if (active.size >= MAX_ACTIVE) {
      send(res, 503, { error: 'Chain bridge busy' });
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    let id = null;
    let method;
    const fail = (code, message, data) =>
      send(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      });
    const timer = setTimeout(() => {
      controller.abort();
      fail(
        -32002,
        method === 'eth_sendRawTransaction'
          ? 'Broadcast outcome uncertain; reconcile the signed transaction'
          : 'Chain request failed: query timeout'
      );
      req.destroy();
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    res.on('close', () => controller.abort());
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BODY) {
          fail(-32600, 'Request too large');
          return;
        }
        chunks.push(chunk);
      }
      let request;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        fail(-32700, 'Invalid JSON');
        return;
      }
      if (
        !request ||
        Array.isArray(request) ||
        request.jsonrpc !== '2.0' ||
        !(
          (typeof request.id === 'string' && request.id.length <= 128) ||
          Number.isSafeInteger(request.id)
        ) ||
        !Array.isArray(request.params)
      ) {
        fail(-32600, 'Single JSON-RPC request with id and params required');
        return;
      }
      id = request.id;
      method = request.method;
      if (!READ_METHODS.has(method) && !(allowBroadcast && method === 'eth_sendRawTransaction')) {
        fail(-32601, 'Method not available to Ant');
        return;
      }
      if (method === 'eth_sendRawTransaction') {
        try {
          if (request.params.length !== 1 || typeof request.params[0] !== 'string')
            throw new Error();
          const transaction = Transaction.from(request.params[0]);
          if (!transaction.isSigned() || transaction.chainId !== BigInt(CHAIN_ID))
            throw new Error();
        } catch {
          fail(-32602, 'Expected a signed Gnosis transaction');
          return;
        }
      }
      controller.signal.throwIfAborted();
      const answer =
        method === 'eth_sendRawTransaction'
          ? await router.broadcastRawTransaction(CHAIN_ID, request.params[0], {
              signal: controller.signal,
            })
          : await router.request(CHAIN_ID, method, request.params, {
              signal: controller.signal,
              // Ant's polling must not queue ahead of wallet/app reads.
              background: true,
              ...(method === 'eth_getLogs' ? LOG_SCAN_ROUTER_OPTIONS : {}),
            });
      controller.signal.throwIfAborted();
      if (answer.result === undefined) throw new Error('Missing chain result');
      const body = { jsonrpc: '2.0', id, result: answer.result };
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_RESPONSE) {
        fail(-32002, 'Chain response exceeds bridge limit');
        return;
      }
      // No addresses, calldata, signed transactions, URLs or upstream messages.
      const source = ['myotis', 'colibri', 'quorum', 'direct'].includes(answer.source)
        ? answer.source
        : 'unknown';
      log.info(`[Ant chain] ${method} via ${source}`);
      send(res, 200, body);
    } catch (error) {
      if (!controller.signal.aborted) {
        const { code, message, data } = antErrorReply(method, error);
        fail(code, message, data);
        log.warn(
          `[Ant chain] ${
            READ_METHODS.has(method) || method === 'eth_sendRawTransaction' ? method : 'request'
          } failed (${code})`
        );
      }
    } finally {
      clearTimeout(timer);
      active.delete(controller);
    }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(10000, timeoutMs);
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      authority = `127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  server.on('error', () => log.warn('[Ant chain] Local transport error'));
  return {
    url: `http://${authority}${route}`,
    // Buffer child output by line before redacting, so chunk boundaries cannot
    // split a capability across log calls. An oversized line is redacted, then
    // cut to its first MAX_LOG_LINE characters with a truncation marker, so a
    // long single-line panic still reaches the log.
    pipeLog(stream, write) {
      const redact = (text) => text.split(token).join('[redacted]');
      let line = '';
      let head = null;
      let droppedChars = 0;
      const flush = () => {
        if (head !== null) write(`${head}… [truncated ${droppedChars + line.length} chars]`);
        else write(redact(line));
        line = '';
        head = null;
        droppedChars = 0;
      };
      stream.on('data', (chunk) => {
        for (const part of String(chunk).split(/(\n)/)) {
          if (part === '\n') {
            flush();
            continue;
          }
          line += part;
          if (head === null && line.length >= MAX_LOG_LINE + token.length) {
            // Cut at MAX_LOG_LINE, extended to the end of a capability that
            // straddles the cut, so no partial capability survives redaction.
            const straddling = line.indexOf(token, MAX_LOG_LINE - token.length + 1);
            const cut =
              straddling >= 0 && straddling < MAX_LOG_LINE
                ? straddling + token.length
                : MAX_LOG_LINE;
            head = redact(line.slice(0, cut));
            line = line.slice(cut);
          }
          if (head !== null) {
            droppedChars += line.length;
            line = '';
          }
        }
      });
      stream.on('end', () => {
        if (line || head !== null) flush();
      });
    },
    close() {
      if (!closePromise) {
        closed = true;
        for (const controller of active) controller.abort();
        closePromise = new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
      }
      return closePromise;
    },
  };
}

module.exports = {
  startAntChainBridge,
  antShrinksLogScanOn,
  rankLogScanError,
  antErrorReply,
  LOG_SCAN_ROUTER_OPTIONS,
  LOG_SCAN_ERROR_RANK: RANK,
  ANT_LOG_SCAN_SHRINK_NEEDLES,
};
