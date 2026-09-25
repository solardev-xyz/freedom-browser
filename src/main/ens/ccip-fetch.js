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
 * payload and the name being resolved are all private.
 */

const { isIP } = require('node:net');

const CCIP_TIMEOUT_MS = 15_000;
const CCIP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function ccipReadFetch(transaction, data, urls, signal) {
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
        continue;
      const get = template.includes('{data}');
      const response = await fetch(url, {
        method: get ? 'GET' : 'POST',
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(get ? {} : { 'Content-Type': 'application/json' }),
        },
        body: get ? undefined : JSON.stringify({ sender, data }),
      });
      if (
        !response.ok ||
        Number(response.headers.get('content-length')) > CCIP_MAX_RESPONSE_BYTES
      ) {
        await response.body?.cancel();
        continue;
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
      if (typeof result === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(result)) return result;
    } catch {
      /* Try the next gateway without logging names, URLs or payloads. */
    } finally {
      clearTimeout(timer);
    }
  }
  const error = new Error('CCIP gateways unavailable or returned invalid data');
  error.code = 'CCIP_GATEWAY_FAILED';
  throw error;
}

module.exports = { ccipReadFetch, CCIP_TIMEOUT_MS, CCIP_MAX_RESPONSE_BYTES };
