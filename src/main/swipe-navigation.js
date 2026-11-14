/**
 * Trackpad swipes between pages on macOS (#980).
 *
 * Chrome and Safari go back or forward when the user swipes sideways on the
 * trackpad, as System Settings > Trackpad > More Gestures > "Swipe between
 * pages" describes. Electron does neither on its own, so Freedom wires both
 * forms of that setting:
 *
 * - Three fingers: AppKit hands the window a swipe event, which Electron
 *   reports as `BrowserWindow`'s `swipe`. It runs the same `history:back` /
 *   `history:forward` the History menu sends, so Agent custody gates it in
 *   the chrome exactly like the toolbar buttons.
 * - Two fingers: a sideways scroll that the page cannot use. Only the page
 *   sees how far a scroll went (Electron's `input-event` names the gesture
 *   events but carries no deltas), so `webview-preload.js` measures it and
 *   the chrome (`renderer/lib/swipe-navigation.js`) draws the arrow and
 *   navigates. This module answers whether the user has that form on, and
 *   when the scroll of a swipe that navigated is over (awaitScrollEnd).
 */

const log = require('./logger');

// The global default behind "Swipe between pages: scroll left or right with
// two fingers". macOS leaves it unset until the user changes it, and unset
// means on. `getUserDefault(key, 'boolean')` reads unset as false, so it is
// read as a string instead: '' unset, '0' off, '1' on (probed on Electron 45).
const TWO_FINGER_DEFAULT_KEY = 'AppleEnableSwipeNavigateWithScrolls';

/**
 * Whether a two-finger sideways scroll past a page's edge should go back or
 * forward: on macOS, unless the user turned it off in System Settings.
 *
 * @param {object} [deps]
 * @param {string} [deps.platform]
 * @param {(key: string, type: string) => unknown} [deps.getUserDefault]
 * @returns {boolean}
 */
function isTwoFingerSwipeEnabled({ platform = process.platform, getUserDefault } = {}) {
  if (platform !== 'darwin') return false;
  const read =
    getUserDefault ||
    ((key, type) => require('electron').systemPreferences.getUserDefault(key, type));
  try {
    return read(TWO_FINGER_DEFAULT_KEY, 'string') !== '0';
  } catch (err) {
    log.warn('[swipe-navigation] Could not read the swipe-between-pages setting:', err.message);
    return true;
  }
}

/**
 * The swipe-navigation state the chrome asks for at the start of each swipe,
 * so a change in System Settings applies to the next swipe.
 *
 * @returns {{ twoFinger: boolean }}
 */
function getSwipeNavigationState(deps) {
  return { twoFinger: isTwoFingerSwipeEnabled(deps) };
}

// Electron names a three-finger swipe after AppKit's sign: deltaX +1 is
// "left", -1 is "right" (electron_ns_window.mm). Chrome maps that same +1 to
// Back (browser_view.cc: swipe_left → IDC_BACK), as Safari does.
const SWIPE_CHANNELS = Object.freeze({ left: 'history:back', right: 'history:forward' });

/**
 * Go back or forward on a three-finger swipe over `window`.
 *
 * @param {import('electron').BrowserWindow} window
 */
function attachThreeFingerSwipe(window) {
  window.on('swipe', (_event, direction) => {
    const channel = SWIPE_CHANNELS[direction];
    if (!channel || window.isDestroyed()) return;
    window.webContents.send(channel);
  });
}

// A swipe's scroll is over once the tab has had no wheel input for this
// long: the tab preload's own gap between gestures.
const SCROLL_QUIET_MS = 150;

/**
 * Wait until a tab's scroll is over, for the chrome to tell the rest of a
 * swipe that navigated from a new swipe. It sees the scroll here because a
 * page can hide it: macOS keeps sending momentum after the fingers lift, the
 * page arriving gets that tail, and one busy loading hears none of it until
 * it is free again. `input-event` reports every wheel event as the tab
 * receives it, through navigations, whatever its page is doing.
 *
 * There is no time limit: while the wheel input goes on, a new swipe cannot
 * begin either (the preload would count it as the same gesture), and the
 * listener goes with the scroll's end or the tab.
 *
 * @param {import('electron').WebContents} contents - the tab's webview
 * @returns {Promise<{ quietForMs: number }>} how long before resolving its
 *   last wheel event came (or the wait began, when none came), so the chrome
 *   can place it on its own clock
 */
function awaitScrollEnd(
  contents,
  { quietMs = SCROLL_QUIET_MS, now = () => performance.now() } = {}
) {
  return new Promise((resolve) => {
    let lastWheelAt = now();
    let quietTimer = null;
    const done = () => {
      clearTimeout(quietTimer);
      contents.removeListener('input-event', onInput);
      contents.removeListener('destroyed', done);
      resolve({ quietForMs: Math.max(0, now() - lastWheelAt) });
    };
    const waitForQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs);
    };
    function onInput(_event, input) {
      if (input?.type !== 'mouseWheel') return;
      lastWheelAt = now();
      waitForQuiet();
    }
    contents.on('input-event', onInput);
    contents.once('destroyed', done);
    waitForQuiet();
  });
}

module.exports = {
  SCROLL_QUIET_MS,
  TWO_FINGER_DEFAULT_KEY,
  attachThreeFingerSwipe,
  awaitScrollEnd,
  getSwipeNavigationState,
  isTwoFingerSwipeEnabled,
};
