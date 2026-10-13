/**
 * The response operations a dweb plan names (freedom-core design 0006,
 * "Response operations"). They depend on the bytes, so they stay in main;
 * each is today's code, moved from the handlers and `ipfs-manager.js`, and
 * fc-dweb carries the same operations with the same vectors.
 *
 * Always run, whatever the plan names:
 *  - `strip_page_state` (O-12, #439) on every dweb response, the native IPFS
 *    node's included (deviation `native-page-state`);
 *  - `strip_decoded_encoding` on every response from the external IPFS
 *    gateway.
 *
 * Run when the plan names them: `canonicalize_redirect` and `small_text`.
 *
 * Statuses with no body, and `206`, `416` and `If-Range`, pass through as
 * received.
 */

const { rewriteGatewayLocation } = require('../lib/gateway-location');
const {
  PAGE_STATE_RESPONSE_HEADERS,
  stripPageStateHeaders,
} = require('../lib/gateway-response-headers');

// Response headers that must not survive the external gateway's hop. Both of
// its transports (undici for a loopback gateway, Chromium for a remote one —
// see ipfs/gateway-transport.js) hand back an already-decoded body while still
// reporting the upstream `content-encoding` and its compressed
// `content-length`, so forwarding them would have Chromium decode the
// plaintext a second time — ERR_CONTENT_DECODING_FAILED or a truncated page
// from any nginx/Caddy-fronted or public gateway. The rest are hop-by-hop
// headers that describe the upstream connection, not this response.
const DECODED_ENCODING_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
];

// Ant's redirects that `canonicalize_redirect` rewrites; the gateway's are
// any 3xx.
const ANT_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The most a small-text body may declare and hold. */
const SMALL_TEXT_MAX = 4096;

function stripDecodedEncoding(headers) {
  for (const name of DECODED_ENCODING_HEADERS) headers.delete(name);
  return headers;
}

/**
 * `canonicalize_redirect`: a gateway-space `Location` rewritten into the
 * custom scheme's URL space (`lib/gateway-location.js`, #95).
 *
 * Ant writes its redirects in the gateway's own URL space (`Location:
 * /bzz/<ref>/blog/`, a 308 from `pkg/api/bzz.go`'s directory
 * canonicalisation), and Kubo likewise (`301 Location: /ipfs/<cid>/docs/`),
 * but Chromium resolves them against the `bzz://` / `ipfs://` request URL it
 * issued — it never saw the gateway origin. Left alone, that redirect for
 * `bzz://name.eth/blog` commits `bzz://name.eth/bzz/<resolved-hash>/blog/`: a
 * doubled path that 404s and publishes the resolved hash in the address bar,
 * `window.location` and the storage origin. A same-origin,
 * same-directory-or-below target is re-expressed as a relative reference,
 * which resolves identically in both spaces; cross-origin and up-directory
 * `Location`s are left untouched (Chromium applies the normal cross-origin
 * rules to them, and a hop is never followed in main).
 *
 * - Ant: only a 301, 302, 303, 307 or 308 is rewritten. A redirect's body is
 *   never rendered, so on a rewrite the upstream body is dropped (and
 *   cancelled, freeing the socket) rather than re-streamed with headers that
 *   no longer describe it: the length and encoding headers go too.
 * - The external IPFS gateway: any 3xx is rewritten in place, body kept.
 *
 * Following the redirect here instead is NOT equivalent: Chromium would stay
 * on the slash-less URL, so every relative URL inside the directory would
 * resolve one level too high.
 *
 * @param {{status: number, headers: Headers}} head - rewritten in place
 * @param {string} requestUrl - the URL the node was asked (its origin and
 *   the plan's path)
 * @param {'ant'|'ipfs'} node
 * @returns {'keep'|'drop'} what happens to the body
 */
function canonicalizeRedirect(head, requestUrl, node) {
  const redirect =
    node === 'ant'
      ? ANT_REDIRECT_STATUSES.has(head.status)
      : head.status >= 300 && head.status < 400;
  if (!redirect) return 'keep';
  const location = head.headers.get('location');
  if (!location) return 'keep';
  const rewritten = rewriteGatewayLocation(location, requestUrl);
  if (!rewritten) return 'keep';
  head.headers.set('location', rewritten);
  if (node !== 'ant') return 'keep';
  // Describe the empty body about to be sent, not the upstream one.
  head.headers.delete('content-length');
  head.headers.delete('content-encoding');
  head.headers.delete('transfer-encoding');
  return 'drop';
}

/**
 * `small_text`'s conditions on the response (a bare UnixFS file has no
 * filename to take a MIME type from): a 200 with a body, a media type of
 * exactly `application/octet-stream`, an integer declared length from 1 to
 * 4096 as `Number()` reads it, and no `Content-Disposition`,
 * `X-Content-Type-Options` or `Content-Range`. The declared length when they
 * all hold, else null.
 *
 * The request's conditions (a GET navigation) are the plan's: the core names
 * `small_text` only for one. Relabelling a subresource `text/plain` +
 * `nosniff` is exactly what makes Chromium refuse it, so a script or
 * stylesheet served that way keeps its type.
 */
function smallTextLength(head, bodyPresent) {
  const type = head.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const size = Number(head.headers.get('content-length'));
  const eligible =
    head.status === 200 &&
    bodyPresent &&
    type === 'application/octet-stream' &&
    Number.isInteger(size) &&
    size > 0 &&
    size <= SMALL_TEXT_MAX &&
    !head.headers.has('content-disposition') &&
    !head.headers.has('x-content-type-options') &&
    !head.headers.has('content-range');
  return eligible ? size : null;
}

/** UTF-8 text without control characters other than tab, LF, FF and CR. */
function isSmallText(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return !Array.from(text).some((c) => {
    const code = c.codePointAt(0);
    return code === 127 || (code < 32 && ![9, 10, 12, 13].includes(code));
  });
}

/**
 * The small-text sniff: it reads until it holds more than 4096 bytes or the
 * body ends, so it holds at most 4 KiB plus one upstream chunk (a lying
 * length can deliver a whole chunk at once). A body whose length matches the
 * declared one and reads as text is relabelled `text/plain; charset=utf-8`
 * with `nosniff`; otherwise the buffered bytes are replayed intact. Every
 * byte is replayed either way, then the rest of the body streams on.
 *
 * @param {Headers} headers - relabelled in place
 * @param {ReadableStream} body
 * @param {number} declared - from `smallTextLength`
 * @returns {Promise<ReadableStream>} the body to send
 */
async function sniffSmallText(headers, body, declared) {
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  let done = false;
  while (length <= SMALL_TEXT_MAX) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    length += next.value.byteLength;
  }
  if (done && length === declared && isSmallText(Buffer.concat(chunks))) {
    headers.set('content-type', 'text/plain; charset=utf-8');
    headers.set('x-content-type-options', 'nosniff');
  }
  return new ReadableStream(
    {
      async pull(controller) {
        if (chunks.length) {
          controller.enqueue(chunks.shift());
          return;
        }
        if (done) {
          controller.close();
          return;
        }
        try {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    // Pulled only when the consumer reads, like the body underneath it.
    { highWaterMark: 0 }
  );
}

/**
 * The head operations a fetch's answer gets, in order: those every response
 * gets from its backend (`strip_decoded_encoding` from the external gateway,
 * `strip_page_state` from all), then the plan's. Small text is left to
 * `sniffSmallText`, with the declared length it needs.
 *
 * @param {object} fetch - the plan's `fetch`
 * @param {'ant'|'native'|'gateway'} kind - the backend that answered
 * @param {{status: number, headers: Headers}} head - rewritten in place
 * @param {string} requestUrl - the URL the node was asked
 * @param {boolean} bodyPresent
 * @returns {{body: boolean, smallText: number|null}} whether a body follows,
 *   and the declared length to sniff when small text applies
 */
function respond(fetch, kind, head, requestUrl, bodyPresent) {
  const ops = [];
  if (kind === 'gateway' && !fetch.response.includes('strip_decoded_encoding')) {
    ops.push('strip_decoded_encoding');
  }
  if (!fetch.response.includes('strip_page_state')) ops.push('strip_page_state');
  ops.push(...fetch.response);
  let body = bodyPresent;
  let smallText = null;
  for (const op of ops) {
    if (op === 'strip_decoded_encoding') stripDecodedEncoding(head.headers);
    else if (op === 'strip_page_state') stripPageStateHeaders(head.headers);
    else if (op === 'canonicalize_redirect') {
      if (canonicalizeRedirect(head, requestUrl, fetch.node) === 'drop') body = false;
    } else if (op === 'small_text') smallText = smallTextLength(head, body);
  }
  return { body, smallText };
}

module.exports = {
  respond,
  canonicalizeRedirect,
  sniffSmallText,
  smallTextLength,
  stripDecodedEncoding,
  stripPageStateHeaders,
  DECODED_ENCODING_HEADERS,
  PAGE_STATE_RESPONSE_HEADERS,
};
