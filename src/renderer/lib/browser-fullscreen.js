/**
 * Browser full screen hides the chrome (#78).
 *
 * The main process reports the window's full-screen state on every change
 * (src/main/browser-fullscreen.js), whatever started it: F11, View → Enter
 * Full Screen, the hamburger menu's full-screen button, macOS's green button,
 * a page's own Fullscreen API request. While the window is full screen the
 * body carries `browser-fullscreen` and the stylesheet hides the tab strip,
 * toolbar and bookmarks bar, so the active tab's webview takes the screen.
 *
 * Nothing is closed or toggled to get there, only hidden: the bookmarks bar
 * keeps its own on/off setting and an open sidebar stays open underneath
 * (sidebar.js `setFullscreenConcealed`), so leaving full screen puts back
 * exactly what was there before.
 *
 * Escape does not leave full screen, as in Chrome's and Firefox's F11 mode:
 * it stays the page's (a modal's close, an editor's normal mode, a game's
 * pause) and the chrome's (its menus, find bar and dialogs). The full-screen
 * binding, View → Exit Full Screen and macOS's green button leave.
 *
 * The state report is listened for from the moment the chrome's script runs
 * (`listenForFullscreenChanges`), not from `initBrowserFullscreen`: main
 * re-sends the state on `did-finish-load`, which can land while the chrome's
 * async start-up is still awaiting settings, and a report with no listener
 * yet is simply lost. One that arrives early is held and applied on init.
 *
 * Free Mode (the toggle at the tab strip's top right, View → Toggle Free
 * Mode, or its shortcut) hides the chrome the same way while the window stays
 * a window, for screen recordings and live streams. Main reports it on its
 * own channel; either state puts `browser-fullscreen` on the body, so every
 * rule that hides the chrome for full screen covers it too, and Free Mode
 * additionally carries `browser-free-mode`. Full screen shows an exit hint
 * when it starts; Free Mode shows none, as anything on screen as it starts
 * would be in the recording. Pointing at the very top edge asks main to reveal a
 * thin bar to move the window by; main also folds it, the moment the pointer
 * leaves (src/main/browser-fullscreen.js has why main does both).
 */

import { formatAccelerator, getEffectiveAccelerator } from './shortcuts.js';

const BODY_CLASS = 'browser-fullscreen';
const FREE_MODE_CLASS = 'browser-free-mode';
// How long the "press … to exit" hint stays up after entering, like Chrome's.
export const EXIT_HINT_MS = 4000;

let active = false;
let fullscreen = false;
let freeMode = false;
let hintTimer = null;
let listening = false;
let applyState = null;
let applyFreeMode = null;
let pendingState = null;
let pendingFreeMode = null;

const exitHintText = (platform) => {
  const key = formatAccelerator(getEffectiveAccelerator('view.fullscreen'), platform);
  return key
    ? `Press ${key} to exit full screen`
    : 'Use View → Exit Full Screen to leave full screen';
};

const hideHint = (hint) => {
  clearTimeout(hintTimer);
  hintTimer = null;
  if (hint) hint.hidden = true;
};

const showHint = (hint, text) => {
  if (!hint) return;
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hideHint(hint), EXIT_HINT_MS);
};

export const isBrowserFullscreen = () => fullscreen;
export const isFreeMode = () => freeMode;

/**
 * Start listening for the window's full-screen reports. Call as early as the
 * chrome's script runs; a report before `initBrowserFullscreen` is held.
 */
export function listenForFullscreenChanges(api = window.electronAPI) {
  if (listening || !api?.onFullscreenChanged) return;
  listening = true;
  api.onFullscreenChanged((isFullScreen) => {
    if (applyState) applyState(isFullScreen);
    else pendingState = isFullScreen;
  });
  api.onFreeModeChanged?.((isFreeModeNow) => {
    if (applyFreeMode) applyFreeMode(isFreeModeNow);
    else pendingFreeMode = isFreeModeNow;
  });
}

/**
 * @param {object} deps
 * @param {(on: boolean) => void} [deps.setSidebarConcealed]
 * @param {() => void} [deps.closeMenus] closes any chrome menu still open
 * @param {string} [deps.platform]
 */
export function initBrowserFullscreen({
  setSidebarConcealed = () => {},
  closeMenus = () => {},
  platform = window.electronAPI?.platform,
} = {}) {
  const hint = document.getElementById('fullscreen-exit-hint');
  const api = window.electronAPI;
  const bar = document.getElementById('free-mode-bar');
  // The bar slides rather than appearing and vanishing (fullscreen.css), so
  // it is shown by a class, not by `hidden`, which would cut the slide out.
  const isRevealed = () => Boolean(bar?.classList?.contains('revealed'));
  const setRevealed = (on) => {
    bar?.classList?.toggle('revealed', on);
    if (!on) endDrag();
  };
  const revealBar = () => {
    if (freeMode && !fullscreen && bar && !isRevealed()) api?.revealFreeModeBar?.();
  };
  const sensor = document.getElementById('free-mode-sensor');
  sensor?.addEventListener?.('mouseenter', revealBar);
  sensor?.addEventListener?.('mousemove', revealBar);
  api?.onFreeModeBarChanged?.((revealed) => {
    setRevealed(revealed && freeMode && !fullscreen);
  });
  // The bar moves the window itself (main has why it is not a drag region).
  // The pointer is captured on press, so the drag carries on when the pointer
  // outruns the bar onto the page.
  let dragging = false;
  const onToggle = (event) => Boolean(event.target?.closest?.('.free-mode-toggle'));
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    api?.dragFreeModeBar?.('end');
  };
  bar?.addEventListener?.('pointerdown', (event) => {
    if (event.button !== 0 || onToggle(event)) return;
    dragging = true;
    bar.setPointerCapture?.(event.pointerId);
    api?.dragFreeModeBar?.('start');
  });
  bar?.addEventListener?.('pointermove', () => {
    if (dragging) api?.dragFreeModeBar?.('move');
  });
  bar?.addEventListener?.('pointerup', endDrag);
  bar?.addEventListener?.('lostpointercapture', endDrag);
  // As on a title bar: a double click zooms the window.
  bar?.addEventListener?.('dblclick', (event) => {
    if (!onToggle(event)) api?.maximizeWindow?.();
  });

  for (const id of ['free-mode-toggle', 'free-mode-bar-toggle']) {
    document.getElementById(id)?.addEventListener?.('click', () => api?.toggleFreeMode?.());
  }

  // The chrome is hidden while either state holds.
  const conceal = (next) => {
    document.body.classList.toggle(FREE_MODE_CLASS, freeMode && !fullscreen);
    if (next === active) return;
    active = next;
    document.body.classList.toggle(BODY_CLASS, active);
    setSidebarConcealed(active);
    if (active) {
      // A menu anchored to the toolbar would float over the page with
      // nothing under it once the toolbar is gone.
      closeMenus();
      // The toolbar stays in view while it holds focus (fullscreen.css), so
      // that Ctrl+L and a new tab's address bar can be typed into. Entering
      // from the address bar, or from a toolbar button, would otherwise keep
      // it on screen: let go of that focus, leaving the keyboard with the
      // chrome's document as hiding the toolbar outright used to.
      const toolbar = document.querySelector?.('.toolbar');
      const workspaceNav = document.querySelector?.('.agent-workspace-nav');
      const focused = document.activeElement;
      if (focused && focused !== document.body &&
          (toolbar?.contains?.(focused) || workspaceNav?.contains?.(focused))) {
        focused.blur?.();
      }
    } else {
      hideHint(hint);
    }
  };

  const apply = (isFullScreen) => {
    const next = isFullScreen === true;
    if (next === fullscreen) return;
    fullscreen = next;
    conceal(fullscreen || freeMode);
    if (fullscreen) showHint(hint, exitHintText(platform));
    else if (freeMode) hideHint(hint);
  };

  const setFreeMode = (isFreeModeNow) => {
    const next = isFreeModeNow === true;
    if (next === freeMode) return;
    freeMode = next;
    if (!freeMode) setRevealed(false);
    conceal(fullscreen || freeMode);
  };

  applyState = apply;
  applyFreeMode = setFreeMode;
  listenForFullscreenChanges();
  if (pendingState !== null) {
    const held = pendingState;
    pendingState = null;
    apply(held);
  }
  if (pendingFreeMode !== null) {
    const held = pendingFreeMode;
    pendingFreeMode = null;
    setFreeMode(held);
  }

  return { apply, setFreeMode };
}
