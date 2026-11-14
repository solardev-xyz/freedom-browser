// `.onion` addresses in normal and private windows (#1248).
//
// Those windows send `.onion` hosts, and only those, through Tor
// (tor-proxy.js's PAC). While Tor isn't running there is no route: the
// session goes DIRECT, Chromium hands the onion name to the system resolver,
// and the page fails with the generic error page. So this gate cancels every
// `.onion` request a session can't send through a running Tor, and a page
// load it holds back starts Tor and opens once Tor is connected
// (tor-held-loads.js):
//
//   - With Tor turned on in Settings, any `.onion` page load starts it.
//   - With Tor turned off, only the user turns it on: an address they typed
//     or opened from a bookmark (the chrome asks first, over
//     IPC.TOR_START_FOR_ONION), or the Start Tor button on the notice. A page
//     that links or redirects to an `.onion` address gets the notice with
//     that button: starting Tor shows on the network (the provider sees a
//     connection to Tor), so a site shouldn't be able to start it.
//
// The notice is the error page, which keeps the `.onion` address in the
// address bar and out of history. Tor windows have their own gate
// (tor-window.js), which holds back everything.

const path = require('path');
const { pathToFileURL } = require('url');
const { holdLoad, resumeHeldLoads } = require('./tor-held-loads');

const ERROR_PAGE_URL = pathToFileURL(
  path.join(__dirname, '..', 'renderer', 'pages', 'error.html')
).href;

// The error page's codes for the two notices (renderer/pages/scripts/error.js).
const ONION_NOTICE = Object.freeze({ waiting: 'tor_starting', ask: 'tor_off' });
const ONION_NOTICE_CODES = new Set(Object.values(ONION_NOTICE));

// What can carry an `.onion` host out of the machine.
const ONION_GATED_URL = /^(https?|wss?):/i;

/** Whether `hostname` is an onion service's, as the PAC matches it. */
function isOnionHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  return host === 'onion' || host.endsWith('.onion');
}

function isOnionUrl(url) {
  if (!ONION_GATED_URL.test(url || '')) return false;
  try {
    return isOnionHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The error page's notice for a held-back `.onion` load. */
function onionNoticeUrl(url, notice) {
  const page = new URL(ERROR_PAGE_URL);
  page.searchParams.set('error', ONION_NOTICE[notice] || ONION_NOTICE.ask);
  page.searchParams.set('url', url);
  return page.toString();
}

/** Whether `candidate` is the notice shown for `url`, in either state. */
function isOnionNotice(candidate, url) {
  if (typeof candidate !== 'string' || !candidate.startsWith('file:')) return false;
  try {
    const page = new URL(candidate);
    return (
      page.pathname.endsWith('/renderer/pages/error.html') &&
      ONION_NOTICE_CODES.has(page.searchParams.get('error')) &&
      page.searchParams.get('url') === url
    );
  } catch {
    return false;
  }
}

// A held-back `.onion` page load (tor-held-loads.js): it starts Tor if Tor is
// on in Settings, and waits; otherwise the notice asks.
const ONION_HOLD = Object.freeze({
  prepare: ({ promptWindow }) =>
    require('./tor-manager').ensureTorForOnion({ promptWindow }) ? 'waiting' : 'ask',
  isLive: (targetSession) => require('./tor-manager').isOnionRouteLive(targetSession),
  noticeUrl: (hold, notice) => onionNoticeUrl(hold.url, notice),
  isNotice: (url, hold) => isOnionNotice(url, hold.url),
});

/**
 * The onBeforeRequest gate for `.onion` requests outside Tor windows; see the
 * header.
 *
 * @param {{ isTorSession: Function, isRouteLive: Function, onHeldBack?: Function }} deps
 */
function makeOnionGate({ isTorSession, isRouteLive, onHeldBack = () => {} }) {
  return (details, { session: targetSession } = {}) => {
    if (!isOnionUrl(details?.url)) return null;
    if (isTorSession(targetSession)) return null;
    if (isRouteLive(targetSession)) return null;
    if (details?.resourceType === 'mainFrame') {
      try {
        onHeldBack(details);
      } catch {
        // Showing the notice is a courtesy; the request stays cancelled.
      }
    }
    return { cancel: true };
  };
}

/** The gate held back an `.onion` page load. */
const notifyOnionHeldBack = (details) => holdLoad(details, ONION_HOLD);

/** Register the gate; before attachWebRequestDispatcher, first in the chain. */
function installOnionGate() {
  const { registerWebRequestHandler } = require('./webrequest-dispatcher');
  const { isTorSession } = require('./private/private-windows');
  const { isOnionRouteLive, onOnionRoutingLive } = require('./tor-manager');
  onOnionRoutingLive(resumeHeldLoads);
  registerWebRequestHandler(
    'onBeforeRequest',
    'tor-onion-gate',
    makeOnionGate({
      isTorSession,
      isRouteLive: isOnionRouteLive,
      onHeldBack: notifyOnionHeldBack,
    }),
    { failClosed: true }
  );
}

module.exports = {
  isOnionUrl,
  onionNoticeUrl,
  isOnionNotice,
  makeOnionGate,
  notifyOnionHeldBack,
  installOnionGate,
};
