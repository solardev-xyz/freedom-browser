/**
 * Bounded ERC-3668 (CCIP-Read) gateway fetch.
 *
 * ethers' own `AbstractProvider.ccipReadFetch` is built on `FetchRequest`,
 * whose default timeout is 300s and which applies no response-size cap. The
 * URLs it fetches come out of an `OffchainLookup` revert — i.e. they are
 * named by the contract being resolved, not by us — so a hostile or wedged
 * gateway can stall an address-bar or wallet resolution for minutes per URL,
 * or stream unbounded bytes into the main process.
 *
 * This is the implementation all ENS resolution paths use: the Myotis
 * and Colibri providers' automatic CCIP callbacks and the block-pinned RPC
 * legs' manual CCIP loop (`ens-resolver.js#callUniversalResolver`). Keeping
 * them on one function is what stops their bounds from drifting apart.
 *
 * Bounds, per gateway URL:
 *  - 15s wall clock, enforced with a real `AbortController` so the socket
 *    is torn down rather than merely abandoned.
 *  - 4MB response body, checked against `content-length` up front and again
 *    while reading, since `content-length` may be absent or a lie.
 *
 * A gateway that fails any check is skipped and the next URL is tried, per
 * ERC-3668. Errors are swallowed without logging: the URL, the request
 * payload and the name being resolved are all private. Each skip is a thrown
 * error inside the loop, handed to the `onGatewayError` test seam when one is
 * passed — production passes none, so nothing leaves the function.
 *
 * VALIDATING THE ANSWER (#478)
 *
 * The answer's `data` is checked with `isHexData`, never with a pattern like
 * `/^0x(?:[0-9a-fA-F]{2})*$/`. V8 runs that one in constant stack only when it
 * compiles it with optimisation: unrolling the `{2}` into fixed-length text is
 * what lets the outer `*` become a greedy loop that keeps no backtrack entries
 * (`regexp-compiler-tonode.cc`). V8 compiles every new regexp *without*
 * optimisation once the isolate has generated over 1 MB of regexp code and has
 * over 16 MB of executable memory committed (`TooMuchRegExpCode`, `regexp.cc`;
 * both read at V8 13.6.233.17, Node 24.21.0's). Then the loop pushes backtrack
 * state per byte pair and overflows V8's 64 MB regexp stack between 2 and 4 MB
 * of input — measured on Node 24.21.0 with `--no-regexp-optimization` — as
 * `RangeError: Maximum call stack size exceeded`, which the per-gateway catch
 * turned into a silently skipped gateway. Both thresholds are isolate-wide and
 * the first only ever grows, so a long-running Electron main process can cross
 * them too and then reject a valid answer near the 4 MB cap. In CI it was the
 * intermittent `accepts a body of exactly the cap` failure: a long in-band
 * coverage run sits right at the threshold, and executable memory moves with
 * GC. `ccip-fetch.test.js` pins this in a `--no-regexp-optimization` child.
 *
 * TRANSPORT (#359)
 *
 * Gateways are dialled through `netGatewayFetch` (`ipfs/gateway-transport.js`),
 * i.e. Chromium's network stack, not Node's global `fetch`. undici has its own
 * sockets and never sees `session.setProxy`, so a resolver whose
 * `OffchainLookup` named `https://<name>.onion/…` had its onion hostname handed
 * to the system resolver (a DNS leak of which gateway the name uses) and the
 * lookup then failed. Through Chromium the request follows the session's proxy
 * policy — today the Tor PAC, which routes `.onion` via Arti and leaves every
 * clearnet host DIRECT — and an onion gateway is refused, never resolved
 * locally, while that PAC is not yet on the session. The transport also sends
 * no cookies or stored credentials and neither reads nor writes Chromium's
 * HTTP cache, which is what undici did too. Redirects are never followed:
 * `redirect: 'error'` fails the gateway on any 3xx, same as before.
 *
 * There is no loopback carve-out here (unlike `gatewayFetch`): the URL checks
 * below already refuse IP literals and loopback-ish names, so every URL that
 * reaches the transport is remote by construction.
 */

const { isIP } = require('node:net');
const { netGatewayFetch } = require('../ipfs/gateway-transport');

const CCIP_TIMEOUT_MS = 15_000;
const CCIP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// Non-backtracking: one negated class, no quantifier, so V8 needs no backtrack
// stack whatever the input length or regexp tier (see VALIDATING THE ANSWER).
const NON_HEX_DIGIT = /[^0-9a-fA-F]/;

/** True for a `0x`-prefixed, even-length hex string, in constant stack. */
function isHexData(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('0x') &&
    value.length % 2 === 0 &&
    !NON_HEX_DIGIT.test(value.slice(2))
  );
}

/**
 * @param {{to: string}} transaction
 * @param {string} data
 * @param {string[]} urls - ERC-3668 URL templates from the `OffchainLookup`
 * @param {AbortSignal} [signal]
 * @param {{requestImpl?: Function, resolveProxy?: Function, onGatewayError?: Function}} [deps]
 *   test seams: `requestImpl`/`resolveProxy` are passed through to `netGatewayFetch`
 *   (`net.request`, `session.resolveProxy`); `onGatewayError(error)` is called
 *   with the reason each skipped gateway was skipped. The error is raw — it can
 *   quote the gateway's body — so it is for tests only and must never be logged.
 */
async function ccipReadFetch(transaction, data, urls, signal, deps = {}) {
  for (const template of urls) {
    if (signal?.aborted) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CCIP_TIMEOUT_MS);
    try {
      const sender = transaction.to.toLowerCase();
      const url = template.replaceAll('{sender}', sender).replaceAll('{data}', data);
      const parsed = new URL(url);
      const host = parsed.hostname
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '')
        .toLowerCase();
      // Resolver-controlled URLs must not become POSTs to the browser's
      // unauthenticated local node APIs. HTTPS also authenticates the DNS
      // hostname at connection time; never follow a redirect back to HTTP.
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        isIP(host) ||
        !host.includes('.') ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal')
      )
        throw new Error('CCIP gateway URL refused');
      const get = template.includes('{data}');
      const response = await netGatewayFetch(
        url,
        {
          method: get ? 'GET' : 'POST',
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            ...(get ? {} : { 'Content-Type': 'application/json' }),
          },
          body: get ? undefined : JSON.stringify({ sender, data }),
        },
        deps
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`CCIP gateway answered HTTP ${response.status}`);
      }
      if (Number(response.headers.get('content-length')) > CCIP_MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error('CCIP response too large');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > CCIP_MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('CCIP response too large');
        }
        chunks.push(next.value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')).data;
      if (isHexData(result)) return result;
      throw new Error('CCIP response data is not hex');
    } catch (err) {
      // Try the next gateway without logging names, URLs or payloads.
      deps.onGatewayError?.(err);
    } finally {
      clearTimeout(timer);
    }
  }
  const error = new Error('CCIP gateways unavailable or returned invalid data');
  error.code = 'CCIP_GATEWAY_FAILED';
  throw error;
}

module.exports = { ccipReadFetch, isHexData, CCIP_TIMEOUT_MS, CCIP_MAX_RESPONSE_BYTES };
