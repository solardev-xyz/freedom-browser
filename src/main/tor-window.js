'use strict';

// Tor windows (#473): what a Tor window's session does besides routing.
//
// A Tor window is a private window whose session sends every request through
// Arti (tor-proxy.js#buildTorWindowProxyConfig, tor-manager.js keeps it
// pointed there). Some of what Freedom opens doesn't travel as page requests:
//
//   - Swarm, IPFS, Radicle and on-chain apps (`bzz:`, `ipfs:`, `ipns:`,
//     `rad:`, `radapi:`, `web3:`) are served by main from the user's own
//     nodes, whose traffic doesn't go through Tor;
//   - ENS and Tezos names are looked up through blockchain RPC providers,
//     outside Tor too.
//
// So a Tor window doesn't open them: the chrome sends such an address to the
// Tor page's notice (renderer/lib/tor-window.js), the scheme handlers on the
// session answer with a notice page for any that still arrive (a link on a
// page, a redirect), and the name-lookup IPC refuses a Tor window's chrome.
// Routing the nodes themselves through Tor is a separate stream of work.
//
// WebRTC: `disable_non_proxied_udp` keeps STUN from reaching out over UDP,
// which SOCKS can't carry, so it can't reveal the real IP address. The
// preload also takes WebRTC out of the pages; what a blank frame can still do
// with it is #1247.
//
// Location: the OS knows where the machine is, Tor or not, so a Tor window
// refuses it without asking, whatever the profile has allowed
// (TOR_DENIED_PERMISSIONS, permissions-manager.js#installPermissionHandlers).
//
// The gate: a Tor window's proxy points at Arti's port from the moment the
// window opens, but a port nobody owns yet (Tor off, or still starting) or
// one Arti left behind could be taken by something else. So every network
// request on a Tor window's session is cancelled unless Tor is running and
// this session's proxy points at the endpoint it validated
// (tor-manager.js#isTorWindowRouteLive). It runs first in the webRequest
// chain and fails closed.
//
// Starting Tor: opening a Tor window starts it (openTorWindow), and so does a
// page load the gate holds back, should Tor have stopped since. The tab shows
// the Tor page's "waiting for Tor" notice meanwhile, and the page it asked
// for opens once Tor is connected (tor-held-loads.js, with TOR_WINDOW_HOLD).

const path = require('path');
const { pathToFileURL } = require('url');
const { holdLoad, resumeHeldLoads } = require('./tor-held-loads');

const TOR_BLOCKED_SCHEMES = ['bzz', 'ipfs', 'ipns', 'rad', 'radapi', 'web3'];

// The Tor page with its "waiting for Tor" notice (renderer/pages/tor.html).
const TOR_WAITING_PAGE_URL = `${
  pathToFileURL(path.join(__dirname, '..', 'renderer', 'pages', 'tor.html')).href
}#offline`;
const isWaitingNotice = (url) =>
  typeof url === 'string' && url.startsWith('file:') && url.endsWith('/pages/tor.html#offline');

const TOR_WEBRTC_POLICY = 'disable_non_proxied_udp';

const TOR_DENIED_PERMISSIONS = Object.freeze(['geolocation']);

// What the gate holds back: everything that leaves the machine. Freedom's own
// pages (`file:`), `data:` and `blob:` don't.
const TOR_GATED_URL = /^(https?|wss?):/i;

// What the name-lookup IPC answers a Tor window with. `type: 'error'` is the
// shape the renderer already handles as a failed lookup.
const TOR_NAME_LOOKUP_REFUSAL = Object.freeze({
  type: 'error',
  reason: 'TOR_WINDOW',
  error: "Name lookups are off in Tor windows: they'd go to RPC providers outside Tor.",
});

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );

/** The page a blocked scheme answers with in a Tor window. */
function torBlockedPageHtml(url) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Not available in a Tor window</title>
<style>
  html { color-scheme: dark; }
  body { margin: 0; padding: 48px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #13221e; color: #c4dcd2; line-height: 1.6; }
  h1 { font-size: 24px; margin: 0 0 12px; color: #e2f1ea; }
  code { color: #e2f1ea; word-break: break-all; }
  p { max-width: 640px; }
</style></head>
<body>
  <h1>Not available in a Tor window</h1>
  <p><code>${escapeHtml(url)}</code></p>
  <p>Swarm, IPFS, Radicle and on-chain addresses load through your own nodes and
  blockchain RPC providers, which don't go through Tor. Open it in a normal or
  private window instead.</p>
</body></html>`;
}

/**
 * Answer every dweb scheme on a Tor window's session with the notice page.
 * Replaces any handler already there (the test harness's stubs).
 *
 * @param {import('electron').Session} targetSession
 */
function blockDwebSchemes(targetSession) {
  const protocol = targetSession?.protocol;
  if (!protocol?.handle) throw new Error('session.protocol.handle unavailable');
  for (const scheme of TOR_BLOCKED_SCHEMES) {
    if (protocol.isProtocolHandled?.(scheme)) protocol.unhandle(scheme);
    protocol.handle(
      scheme,
      (request) =>
        new Response(torBlockedPageHtml(request.url), {
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
    );
  }
}

/**
 * The onBeforeRequest gate for Tor window sessions; see the header.
 *
 * @param {{ isTorSession: Function, isRouteLive: Function }} deps
 */
function makeTorWindowGate({ isTorSession, isRouteLive, onHeldBack = () => {} }) {
  return (details, { session: targetSession } = {}) => {
    if (!isTorSession(targetSession)) return null;
    if (!TOR_GATED_URL.test(details?.url || '')) return null;
    if (isRouteLive(targetSession)) return null;
    // Chromium drops a cancelled navigation without a did-fail-load, so the
    // tab would sit on its old page and seem to ignore the address. It is
    // shown why instead, and the page opens once Tor is up (notifyHeldBack).
    if (details?.resourceType === 'mainFrame') {
      try {
        onHeldBack(details);
      } catch {
        // Telling the window is a courtesy; the request stays cancelled.
      }
    }
    return { cancel: true };
  };
}

// A held-back page load in a Tor window (tor-held-loads.js): it starts Tor,
// turning it on if it's off, and waits on the Tor page's notice.
const TOR_WINDOW_HOLD = Object.freeze({
  prepare: ({ promptWindow }) => {
    require('./tor-manager').ensureTorForTorWindow({ promptWindow });
  },
  isLive: (targetSession) => require('./tor-manager').isTorWindowRouteLive(targetSession),
  noticeUrl: () => TOR_WAITING_PAGE_URL,
  isNotice: (url) => isWaitingNotice(url),
});

/** The gate held back a Tor window tab's page load. */
const notifyHeldBack = (details) => holdLoad(details, TOR_WINDOW_HOLD);

/** Register the gate; before attachWebRequestDispatcher, first in the chain. */
function installTorWindowGate() {
  const { registerWebRequestHandler } = require('./webrequest-dispatcher');
  const { isTorSession } = require('./private/private-windows');
  const { isTorWindowRouteLive, onTorWindowsLive } = require('./tor-manager');
  onTorWindowsLive(resumeHeldLoads);
  registerWebRequestHandler(
    'onBeforeRequest',
    'tor-window-gate',
    makeTorWindowGate({
      isTorSession,
      isRouteLive: isTorWindowRouteLive,
      onHeldBack: notifyHeldBack,
    }),
    { failClosed: true }
  );
}

/** Keep WebRTC from sending UDP outside the proxy. */
function applyTorWebRtcPolicy(contents) {
  contents?.setWebRTCIPHandlingPolicy?.(TOR_WEBRTC_POLICY);
}

/**
 * Open a Tor window: route its new session through Arti, open it only once
 * that's in place, then start Tor if it isn't running, turning it on in
 * Settings if it's off. Resolves null (nothing opened) when the route can't be
 * set up.
 * The requires are lazy: the name resolvers load this module for its refusal
 * and shouldn't pull in the window and Tor managers with it.
 *
 * @param {string|null} initialUrl
 * @returns {Promise<Electron.BrowserWindow|null>}
 */
async function openTorWindow(initialUrl = null) {
  const { createTorWindow } = require('./private/private-windows');
  const { registerTorWindowSession, ensureTorForTorWindow } = require('./tor-manager');
  const window = await createTorWindow(initialUrl, { routeThroughTor: registerTorWindowSession });
  if (window) ensureTorForTorWindow({ promptWindow: window });
  return window;
}

module.exports = {
  openTorWindow,
  notifyHeldBack,
  TOR_WAITING_PAGE_URL,
  makeTorWindowGate,
  installTorWindowGate,
  TOR_BLOCKED_SCHEMES,
  TOR_WEBRTC_POLICY,
  TOR_DENIED_PERMISSIONS,
  TOR_NAME_LOOKUP_REFUSAL,
  torBlockedPageHtml,
  blockDwebSchemes,
  applyTorWebRtcPolicy,
};
