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
 */

import { formatAccelerator, getEffectiveAccelerator } from './shortcuts.js';

const BODY_CLASS = 'browser-fullscreen';
// How long the "press … to exit" hint stays up after entering, like Chrome's.
export const EXIT_HINT_MS = 4000;

let active = false;
let hintTimer = null;
let listening = false;
let applyState = null;
let pendingState = null;

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

const showHint = (hint, platform) => {
  if (!hint) return;
  hint.textContent = exitHintText(platform);
  hint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hideHint(hint), EXIT_HINT_MS);
};

export const isBrowserFullscreen = () => active;

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

  const apply = (isFullScreen) => {
    const next = isFullScreen === true;
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
      showHint(hint, platform);
    } else {
      hideHint(hint);
    }
  };

  applyState = apply;
  listenForFullscreenChanges();
  if (pendingState !== null) {
    const held = pendingState;
    pendingState = null;
    apply(held);
  }

  return { apply };
}
