// Page loads held back until Tor is connected (#473, #1248).
//
// Two gates cancel a page load that can't go through Tor yet: a Tor window's
// (tor-window.js), which holds back everything while the window's route isn't
// live, and the `.onion` gate (tor-onion-gate.js), which holds back `.onion`
// addresses in normal and private windows while Tor isn't routing them.
// Chromium drops a cancelled navigation without a did-fail-load, so the tab
// would sit on its old page and seem to ignore the address. The gate hands
// the load here instead: the tab shows a notice, and the page opens once Tor
// is connected. All of that runs here in main, in one order, so a notice can't
// land on a page that already opened.
//
// Each gate brings its own policy, a `kind`:
//   prepare({ promptWindow }) start Tor if it may; returns which notice to show
//   isLive(session)           whether the page can go out through Tor now
//   noticeUrl(hold, notice)   the notice page
//   isNotice(url, hold)       whether `url` is the notice shown for `hold`

// Where the main-frame navigation each tab started last is going, by
// webContents id: its URL, or the URL a server redirected it to. A held-back
// load is only shown or opened while it's still the tab's.
const currentNavigation = new Map();

// The page load each tab had held back, by webContents id. Only the tab's
// latest counts: a newer one replaces it.
const heldLoads = new Map();

const tracked = new WeakSet();

/** Follow a tab's main-frame navigations (webcontents-setup.js). */
function trackTabNavigation(contents) {
  const id = contents?.id;
  if (!id || typeof contents.on !== 'function' || tracked.has(contents)) return;
  tracked.add(contents);
  const follow = (details, url, _isInPlace, isMainFrame) => {
    const mainFrame = details?.isMainFrame ?? isMainFrame;
    if (mainFrame) currentNavigation.set(id, details?.url ?? url);
  };
  contents.on('did-start-navigation', follow);
  // A page that redirects to an `.onion` address: the gate holds back the
  // redirect's target, which is then where the navigation is going (#1248).
  contents.on('did-redirect-navigation', follow);
  contents.once?.('destroyed', () => {
    currentNavigation.delete(id);
    heldLoads.delete(id);
  });
}

/**
 * A gate held back a tab's page load. It is noted at once, so Tor coming up
 * right after can't miss it (resumeHeldLoads); a turn later, Tor is started
 * if the kind may start it, and the tab shows the notice, unless the load
 * isn't pending any more: the user moved on, a newer load replaced it, or Tor
 * came up in between and it opened.
 */
function holdLoad(details, kind) {
  const id = details?.webContentsId;
  if (!id || !details.url) return;
  // Only a GET opens again by itself: a form sent again unasked could act
  // twice, or act at all when the user has given up on it.
  const hold = {
    kind,
    url: details.url,
    reopen: (details.method || 'GET') === 'GET',
    waiting: false,
  };
  heldLoads.set(id, hold);
  setImmediate(() => showHeldLoad(id, hold));
}

function showHeldLoad(id, hold) {
  const { BrowserWindow, webContents } = require('electron');
  const guest = webContents.fromId(id);
  if (!guest || guest.isDestroyed()) {
    heldLoads.delete(id);
    return;
  }
  const host = guest.hostWebContents;
  const notice = hold.kind.prepare({
    promptWindow: host && !host.isDestroyed() ? BrowserWindow.fromWebContents(host) : null,
  });
  if (heldLoads.get(id) !== hold) return;
  if (currentNavigation.get(id) !== hold.url) {
    heldLoads.delete(id);
    return;
  }
  if (hold.reopen && hold.kind.isLive(guest.session)) {
    heldLoads.delete(id);
    guest.loadURL(hold.url).catch(() => {});
    return;
  }
  if (hold.reopen) hold.waiting = true;
  else heldLoads.delete(id);
  guest.loadURL(hold.kind.noticeUrl(hold, notice)).catch(() => {});
}

/**
 * Tor routes a session again: open what each tab held back, if the tab is
 * still on that load or on the notice shown for it, and its kind's route is
 * live. A tab the user has sent somewhere else since keeps its page.
 */
function resumeHeldLoads() {
  const { webContents } = require('electron');
  for (const [id, hold] of heldLoads) {
    const guest = webContents.fromId(id);
    const latest = currentNavigation.get(id);
    const pending = latest === hold.url || (hold.waiting && hold.kind.isNotice(latest, hold));
    if (!guest || guest.isDestroyed() || !pending) {
      heldLoads.delete(id);
      continue;
    }
    // A form waits for showHeldLoad's notice, and isn't sent again.
    if (!hold.reopen || !hold.kind.isLive(guest.session)) continue;
    heldLoads.delete(id);
    guest.loadURL(hold.url).catch(() => {});
  }
}

module.exports = {
  trackTabNavigation,
  holdLoad,
  resumeHeldLoads,
};
