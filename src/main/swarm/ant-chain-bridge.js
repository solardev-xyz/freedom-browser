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
// Ant's scan_logs only shrinks its eth_getLogs window when the error text
// matches a range-limit/timeout needle, so a wide scan gets a longer per-URL
// budget on the direct path than an interactive read would.
const LOG_SCAN_DIRECT_TIMEOUT_MS = 60000;

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
              ...(method === 'eth_getLogs' ? { directTimeoutMs: LOG_SCAN_DIRECT_TIMEOUT_MS } : {}),
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
        // This is the daemon's URL transport, not the FFI callback. Preserve
        // real -32000 codes; no second fallback/rebroadcast occurs here.
        const code = Number.isSafeInteger(error.code) ? error.code : -32002;
        const data =
          typeof error.data === 'string' &&
          /^0x[0-9a-f]*$/i.test(error.data) &&
          error.data.length <= MAX_BODY
            ? error.data
            : undefined;
        const detail = sanitizeErrorMessage(error.message);
        const message =
          error.code === 'MYOTIS_BROADCAST_UNCERTAIN'
            ? 'Broadcast outcome uncertain; reconcile the signed transaction'
            : code === 3
              ? 'Execution reverted'
              : `Chain request failed${detail ? `: ${detail}` : ''}`;
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

module.exports = { startAntChainBridge };
