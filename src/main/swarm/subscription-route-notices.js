/**
 * Subscription route notices: telling the user when live messages are off
 * (freedom-core design 0015, Messaging, question 4, decided 2026-11-24 "with
 * the user told whenever it applies"; SWM-6 to SWM-9's plan, point 10;
 * SWM-7's PR 7.5).
 *
 * A subscription's socket is Node's own `WebSocket`, which no session proxy
 * and no Tor carries. So the subscription registry refuses one to a node the
 * session reaches through either, and ends the open ones when a proxy or Tor
 * comes on (subscription-registry.js, `routeRefusal`). The user is told in
 * three places, all worded here and all driven from main:
 * - **A notice in the chrome**, once per site per browser session, when one
 *   of a site's subscriptions is refused or ended this way (the registry's
 *   `onRefused`). The sites already told are a set of site keys that lives
 *   as long as this process. The notice goes to the browser window the user
 *   is in (`swarm:messages-notice`), and a site counts as told only once a
 *   window took it.
 * - **A line in the Nodes panel**, and
 * - **a note under the Swarm node in Settings > Nodes**, both while the node
 *   in use is one the refusal covers: the registry's own test, run on the
 *   node's URL now (an external node not on loopback that the session
 *   reaches through a proxy or Tor). Never for the bundled node or an
 *   external node on loopback, which the test passes without asking for a
 *   proxy. Both read it with `swarm:messages-route-get`. Main pushes it to
 *   the chrome (`swarm:messages-route`) when it changes: at each change of
 *   Tor's state or the node (provider-ipc calls `refresh`), and at each read
 *   that finds it changed, since a system or PAC proxy changes with no event
 *   and the surfaces read it again as they poll.
 *
 * The texts name Tor ("while Tor is on") only when the node's resolved route
 * is Arti's endpoint, and "your proxy" for any other proxy (the refusal's
 * `via`). An onion node is refused whatever its route; with neither in the
 * way (Tor off, say) its texts say what holds then: the node is an .onion
 * address, and live messages can't go through Tor. U-1, still with the
 * user, may change the test (`routeRefusal`) and these words: each is in one
 * place, the words in TEXTS below.
 */

const IPC = require('../../shared/ipc-channels');

// The longest site key a notice shows in full; a longer one is cut short.
const MAX_SITE_CHARS = 120;

/** What is in the way, as the texts name it: Arti's endpoint, or any other proxy. */
const inTheWay = (via) => (via === 'tor' ? 'Tor' : 'your proxy');

/** Why live messages are off, after "Live messages … are off". */
const why = (via, node) =>
  via === 'onion'
    ? `: ${node} is an .onion address, and they can't go through Tor`
    : ` while ${inTheWay(via)} is on: they would go around it to ${node}`;

/**
 * Every word question 4's surfaces show, in one place.
 * - `notice(site, via)`: the chrome's notice, for a site's subscription
 *   refused or ended;
 * - `panel(via)`: the Nodes panel's line, while it applies;
 * - `settings(via)`: Settings > Nodes, under the Swarm node, while it
 *   applies (the panel's words, as a sentence of the page's help text).
 */
const TEXTS = Object.freeze({
  notice: (site, via) => `Live messages from ${site} are off${why(via, 'your external Swarm node')}`,
  panel: (via) => `Live messages are off${why(via, 'your external node')}`,
  settings: (via) => `Live messages are off${why(via, 'your external node')}.`,
});

/** None of the surfaces' lines: the condition doesn't apply. */
const NO_LINES = Object.freeze({ panel: null, settings: null });

/**
 * A site's key as a notice shows it: control and format characters (a
 * bidi override among them) dropped, and cut short past MAX_SITE_CHARS.
 */
function displaySite(site) {
  const visible = [...String(site).replace(/[\p{Cc}\p{Cf}]/gu, '').trim()];
  if (visible.length <= MAX_SITE_CHARS) return visible.join('');
  return `${visible.slice(0, MAX_SITE_CHARS - 1).join('')}…`;
}

/**
 * @param {object} deps
 * @param {(nodeUrl: string|null) => Promise<null|{via: string}>} deps.checkRoute -
 *   the registry's route test on a node's URL (`checkRoute`, with no site:
 *   nothing reported)
 * @param {() => (string|null)} deps.nodeUrl - the Swarm node in use now
 * @param {() => (object|null)} deps.noticeWindow - the browser window the
 *   user is in, for a notice
 * @param {() => object[]} deps.chromeWindows - every browser window, for
 *   the line's push
 */
function createSubscriptionRouteNotices({ checkRoute, nodeUrl, noticeWindow, chromeWindows }) {
  // The sites told this session.
  const told = new Set();
  // The lines last pushed (JSON), and the newest read: an older read that
  // resolves late answers the newest read's lines, and never pushes its own.
  let pushed = null;
  let newest = null;

  function send(win, channel, payload) {
    if (!win || win.isDestroyed?.() || win.webContents?.isDestroyed?.()) return false;
    try {
      win.webContents.send(channel, payload);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The registry's `onRefused`: a site's subscription refused, or ended
   * (`ended`), with what was in the way (`via`). The first for a site this
   * session is shown; the rest aren't.
   */
  function onRefused(event) {
    const site = typeof event?.origin === 'string' ? event.origin : '';
    if (site === '' || told.has(site)) return;
    let win;
    try {
      win = noticeWindow();
    } catch {
      win = null;
    }
    const text = TEXTS.notice(displaySite(site), event.via);
    if (send(win, IPC.SWARM_MESSAGES_NOTICE, { site, text })) told.add(site);
  }

  /** The lines for the node in use now: its route refused, or none. */
  async function lines() {
    let refusal;
    try {
      refusal = await checkRoute(nodeUrl() || null);
    } catch {
      // The test itself fails closed (a proxy it can't resolve is
      // refused); a failure around it says nothing about the route.
      return NO_LINES;
    }
    if (!refusal) return NO_LINES;
    return { panel: TEXTS.panel(refusal.via), settings: TEXTS.settings(refusal.via) };
  }

  /**
   * The lines now, pushed to every browser window when they changed since
   * the last push. A read that a newer one overtook answers the newest
   * read's lines, so a surface's late reply never stands over a newer push.
   * @returns {Promise<{panel: string|null, settings: string|null}>}
   */
  async function refresh() {
    let read = lines();
    newest = read;
    let now = await read;
    while (newest !== read) {
      read = newest;
      now = await read;
    }
    const key = JSON.stringify(now);
    if (key !== pushed) {
      pushed = key;
      let windows;
      try {
        windows = chromeWindows() || [];
      } catch {
        windows = [];
      }
      for (const win of windows) send(win, IPC.SWARM_MESSAGES_ROUTE, now);
    }
    return now;
  }

  return { onRefused, refresh };
}

/** The main browser window the user is in: the focused one, else the one focused last. */
function windowUserIsIn() {
  const { BrowserWindow } = require('electron');
  const { isMainBrowserWindow, getLastFocusedMainWindow } = require('../windows/mainWindow');
  const focused = BrowserWindow.getFocusedWindow?.();
  if (focused && isMainBrowserWindow(focused)) return focused;
  return getLastFocusedMainWindow();
}

/**
 * Main's notices, with the line's IPC handler registered
 * (`swarm:messages-route-get`, for the chrome and Settings).
 * @param {{checkRoute: Function, nodeUrl: Function}} deps - as
 *   createSubscriptionRouteNotices takes them; the windows are main's own
 * @returns {{onRefused: Function, refresh: Function}}
 */
function registerSubscriptionRouteNotices({ checkRoute, nodeUrl }) {
  const notices = createSubscriptionRouteNotices({
    checkRoute,
    nodeUrl,
    noticeWindow: windowUserIsIn,
    chromeWindows: () => require('../windows/mainWindow').getMainWindows(),
  });
  require('electron').ipcMain.handle(IPC.SWARM_MESSAGES_ROUTE_GET, () => notices.refresh());
  return notices;
}

module.exports = {
  TEXTS,
  MAX_SITE_CHARS,
  displaySite,
  createSubscriptionRouteNotices,
  registerSubscriptionRouteNotices,
};
