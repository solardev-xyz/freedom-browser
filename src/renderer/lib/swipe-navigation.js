// Two-finger swipe between pages on macOS (#980): the arrow at the page's
// edge and the navigation it commits.
//
// The tab preload (webview-preload.js, "Two-finger swipe between pages")
// reports a sideways scroll the page could not use as `swipe-nav:update`
// messages carrying the distance past the edge, then `swipe-nav:end`, or
// `swipe-nav:cancel` when the page takes the gesture back. tabs.js forwards
// only the active tab's messages. Here the arrow slides in from that edge as
// the distance grows, and the swipe goes back or forward as soon as the
// distance reaches SWIPE_COMMIT_DISTANCE_DIP.
//
// Chrome and Safari navigate when the fingers lift, and a swipe reversed
// before that is cancelled. Freedom cannot do that, so it navigates at that
// distance instead, and a swipe can no longer be taken back once the arrow
// has filled in. The lift is the phase macOS puts on each scroll event
// (NSEvent `phase` / `momentumPhase`), and Electron passes it to no
// JavaScript:
// - a page gets plain wheel events, so the preload cannot tell the momentum
//   macOS keeps sending for a second or more after the lift from the
//   fingers' own movement, and its `swipe-nav:end` comes only once that
//   momentum has died down (waiting for it made every swipe lag);
// - the main process's `input-event` carries only each event's type, and
//   the BrowserWindow `scroll-touch-*` events are gone (not in Electron 45);
// - Chromium itself holds back its scroll-end signal when momentum follows
//   the lift, so nothing downstream of it sees the lift either.
// Navigating on the lift would take a native module that reads the phases
// with an NSEvent local monitor, as Chromium does internally (#980).
//
// A swipe navigates only when all of these hold:
// - "Swipe between pages" with two fingers is on in System Settings (asked of
//   the main process at the start of each swipe, so a change applies to the
//   next one);
// - the tab has an entry in that direction;
// - the Agent does not hold the tab (the toolbar buttons' gate).
// The navigation itself is the toolbar buttons' history traversal.

export const SWIPE_NAV_CHANNELS = Object.freeze([
  'swipe-nav:update',
  'swipe-nav:end',
  'swipe-nav:cancel',
]);

// How far past the edge a swipe must go, in device-independent pixels (the
// trackpad's points), before it navigates.
export const SWIPE_COMMIT_DISTANCE_DIP = 200;
// The arrow hides when the preload stops reporting without an end (the tab
// was switched or the page went away mid-swipe).
const SWIPE_STALE_MS = 500;
// After a swipe navigates, the rest of its scroll is not a new swipe: the
// fingers may still be moving and the momentum goes on, first in the page
// being left and then in the one arriving, whose preload would report it as
// a swipe of its own and go back a second time; a page busy loading hears its
// share only once it is free, possibly after the scroll is over. So every
// swipe message is dropped until the main process, which sees the tab's
// wheel input whatever its page is doing, says the scroll is over, and after
// that so is every gesture that began before the scroll's last wheel event
// (the preload says how long ago each began). This much later still counts
// as before: the two answers travel over IPC, and a new swipe begins only
// after the 150 ms the scroll had to be quiet.
const SWIPE_CARRY_SLACK_MS = 50;
const COMMIT_FADE_MS = 200;
// The arrow's travel: from just outside the edge to its resting inset.
const ARROW_HIDDEN_OFFSET_PX = -48;
const ARROW_REST_OFFSET_PX = 16;

let indicator = null;
let deps = null;
let gesture = null;
let staleTimer = null;
let hideTimer = null;
// The swipe that navigated, while its scroll is not over yet.
let settling = null;
// When that scroll's last wheel event came, on this page's clock.
let scrollEndedAt = -Infinity;

const clearTimer = (timer) => {
  if (timer !== null) clearTimeout(timer);
  return null;
};

const isDirection = (value) => value === 'back' || value === 'forward';

/**
 * @param {object} options
 * @param {() => object|null} options.getActiveWebview
 * @param {() => boolean} options.isNavigationBlocked - true while the Agent holds the active tab
 * @param {(webview: object) => boolean} options.goBack
 * @param {(webview: object) => boolean} options.goForward
 * @param {() => Promise<{ twoFinger: boolean }>} [options.getSwipeSettings]
 * @param {(webview: object) => Promise<{ quietForMs: number }|null>} [options.awaitScrollEnd]
 */
export const initSwipeNavigation = (options) => {
  indicator = document.getElementById('swipe-nav-indicator');
  deps = options;
  gesture = null;
  settling = null;
  scrollEndedAt = -Infinity;
};

const canNavigate = (direction) => {
  if (!deps || deps.isNavigationBlocked?.()) return false;
  const webview = deps.getActiveWebview?.();
  if (!webview) return false;
  try {
    return direction === 'back' ? webview.canGoBack() === true : webview.canGoForward() === true;
  } catch {
    return false;
  }
};

// The preload measures in the page's CSS pixels, which shrink as the page is
// zoomed in; the zoom factor turns them back into the trackpad's points.
const zoomFactor = () => {
  try {
    const factor = deps?.getActiveWebview?.()?.getZoomFactor?.();
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch {
    return 1;
  }
};

const progressOf = (current) =>
  Math.max(0, (current.distance * zoomFactor()) / SWIPE_COMMIT_DISTANCE_DIP);

const render = (current) => {
  if (!indicator) return;
  const progress = Math.min(1, progressOf(current));
  const offset =
    ARROW_HIDDEN_OFFSET_PX + (ARROW_REST_OFFSET_PX - ARROW_HIDDEN_OFFSET_PX) * progress;
  hideTimer = clearTimer(hideTimer);
  indicator.hidden = false;
  indicator.classList.toggle('swipe-nav-indicator--forward', current.direction === 'forward');
  indicator.classList.toggle('swipe-nav-indicator--ready', progress >= 1);
  indicator.classList.remove('swipe-nav-indicator--committed');
  indicator.style.setProperty?.('--swipe-nav-offset', `${offset}px`);
  indicator.style.setProperty?.('--swipe-nav-opacity', String(Math.min(1, progress * 1.5)));
};

const hide = ({ committed = false } = {}) => {
  if (!indicator) return;
  indicator.classList.toggle('swipe-nav-indicator--committed', committed);
  indicator.style.setProperty?.('--swipe-nav-opacity', '0');
  if (!committed)
    indicator.style.setProperty?.('--swipe-nav-offset', `${ARROW_HIDDEN_OFFSET_PX}px`);
  hideTimer = clearTimer(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (gesture) return;
    indicator.hidden = true;
    indicator.classList.remove(
      'swipe-nav-indicator--ready',
      'swipe-nav-indicator--committed',
      'swipe-nav-indicator--forward'
    );
  }, COMMIT_FADE_MS);
};

const finish = ({ committed = false } = {}) => {
  staleTimer = clearTimer(staleTimer);
  const current = gesture;
  gesture = null;
  if (current?.shown) hide({ committed });
};

const waitForScrollEnd = (webview) => {
  const token = {};
  settling = token;
  Promise.resolve()
    .then(() => deps.awaitScrollEnd?.(webview))
    .catch(() => null)
    .then((answer) => {
      if (settling !== token) return;
      settling = null;
      const quietFor = Number(answer?.quietForMs);
      scrollEndedAt = performance.now() - (Number.isFinite(quietFor) ? quietFor : 0);
    });
};

// Part of the scroll of a swipe that already navigated.
const isCarriedOver = (payload) => {
  if (settling) return true;
  const sinceStart = Number(payload?.sinceStart);
  if (!Number.isFinite(sinceStart)) return false;
  return performance.now() - sinceStart < scrollEndedAt + SWIPE_CARRY_SLACK_MS;
};

// Navigate once the swipe has gone far enough, checking the gates again.
const commitIfReady = (current) => {
  if (gesture !== current || current.allowed !== true || progressOf(current) < 1) return false;
  if (!canNavigate(current.direction)) return false;
  finish({ committed: true });
  const webview = deps.getActiveWebview();
  waitForScrollEnd(webview);
  if (current.direction === 'back') deps.goBack(webview);
  else deps.goForward(webview);
  return true;
};

const start = (direction) => {
  const current = { direction, distance: 0, allowed: null, shown: false };
  gesture = current;
  if (!canNavigate(direction)) {
    current.allowed = false;
    return current;
  }
  const settings = deps?.getSwipeSettings
    ? Promise.resolve().then(() => deps.getSwipeSettings())
    : Promise.resolve({ twoFinger: true });
  settings
    .then((state) => state?.twoFinger === true)
    .catch(() => false)
    .then((enabled) => {
      if (gesture !== current) return;
      current.allowed = enabled;
      if (enabled) {
        current.shown = true;
        render(current);
        commitIfReady(current);
      }
    });
  return current;
};

const update = (payload) => {
  const direction = payload?.direction;
  const distance = Number(payload?.distance);
  if (!isDirection(direction) || !Number.isFinite(distance)) return;
  if (gesture && gesture.direction !== direction) finish();
  const current = gesture || start(direction);
  current.distance = distance;
  staleTimer = clearTimer(staleTimer);
  staleTimer = setTimeout(() => finish(), SWIPE_STALE_MS);
  if (current.allowed === true) {
    current.shown = true;
    render(current);
    commitIfReady(current);
  }
};

const end = (payload) => {
  const current = gesture;
  if (!current) return;
  const distance = Number(payload?.distance);
  if (payload?.direction === current.direction && Number.isFinite(distance)) {
    current.distance = distance;
  }
  if (!commitIfReady(current)) finish();
};

/**
 * Handle a swipe message from the active tab's preload.
 *
 * @param {string} channel
 * @param {object} [payload]
 * @returns {boolean} true when `channel` was a swipe message
 */
export const handleSwipeNavigationMessage = (channel, payload) => {
  if (!SWIPE_NAV_CHANNELS.includes(channel)) return false;
  if (isCarriedOver(payload)) return true;
  if (channel === 'swipe-nav:update') update(payload);
  else if (channel === 'swipe-nav:end') end(payload);
  else finish();
  return true;
};

/**
 * Drop a swipe in progress, as when the active tab changes. A swipe that
 * navigated is its tab's: the next tab's swipes are its own, and the answer
 * about that scroll, when it comes, no longer applies.
 */
export const cancelSwipeNavigation = () => {
  settling = null;
  scrollEndedAt = -Infinity;
  finish();
};
