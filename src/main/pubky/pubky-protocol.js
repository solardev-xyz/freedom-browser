/**
 * pubky:// protocol handler
 *
 * Serves `pubky://<public-key>/pub/<path>`: a public file on the homeserver
 * the key publishes in its Pkarr record. The Pubky SDK resolves the
 * homeserver through Pkarr relays and fetches the file; the homeserver's
 * response (status, content type, body) goes back to the page unchanged.
 *
 * `pubky` is a standard scheme (see `registerSchemesAsPrivileged` in
 * index.js), so each key is its own origin. z-base-32 keys are lowercase,
 * so Chromium's host lowercasing is harmless.
 *
 * Contract:
 *  - GET / HEAD only, and only under `/pub/`. Writes and private data need
 *    a signed-in session, which this handler never has.
 *  - Request URLs are not logged: they name the key being read.
 */

const log = require('../logger');

// 52 z-base-32 characters; the unused final bits are zero, so the last
// character is `y` or `o`. Same rule as Pubky Chromium's IDENTIFIERS.md.
const PUBLIC_KEY_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

// ponytail: the SDK loads its WASM on first use, so a profile that never
// opens a pubky:// address never pays for it.
let sdk;
const loadSdk = () => {
  if (!sdk) {
    const { Pubky, resolvePubky } = require('@synonymdev/pubky');
    sdk = { client: new Pubky().client, resolvePubky };
  }
  return sdk;
};

const textResponse = (status, message) =>
  new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

/**
 * Returns `pubky<key>/<path>` (the SDK's address form) for a valid
 * `pubky://<key>/pub/...` URL, or null.
 */
function toPubkyAddress(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'pubky:' || url.port || !PUBLIC_KEY_RE.test(url.hostname)) return null;
  // The URL parser has already collapsed `.` and `..` segments.
  if (!url.pathname.startsWith('/pub/')) return null;
  return `pubky${url.hostname}${url.pathname}${url.search}`;
}

async function handlePubkyRequest(request) {
  const method = (request.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return textResponse(405, 'Method not allowed');

  const address = toPubkyAddress(request.url);
  if (!address) {
    return textResponse(400, 'Expected pubky://<public-key>/pub/<path>');
  }

  try {
    const { client, resolvePubky } = loadSdk();
    return await client.fetch(resolvePubky(address), { method });
  } catch (err) {
    log.warn(`[pubky-protocol] request failed: ${err?.name || 'Error'}`);
    return textResponse(502, `Could not reach the homeserver: ${err?.message || err}`);
  }
}

function registerPubkyProtocol(targetSession) {
  try {
    targetSession.protocol.handle('pubky', handlePubkyRequest);
    log.info('[pubky-protocol] handler registered');
  } catch (err) {
    log.error('[pubky-protocol] failed to register handler:', err);
  }
}

module.exports = { registerPubkyProtocol, handlePubkyRequest, toPubkyAddress };
