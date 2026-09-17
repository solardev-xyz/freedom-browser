// Shared menu backdrop for catching clicks on drag regions.
//
// While it is up, the chrome owns the window's input. The pointer half has
// always been here: the backdrop covers the window, so a click meant for the
// page is caught in the chrome and dismisses the surface instead.
//
// The keyboard needs the same rule (#328). An Electron `<webview>` guest is a
// separate frame that can take the keyboard on its own: every tab activation
// hands the page focus (#304) and the guest's ack lands asynchronously — tens
// of milliseconds later, i.e. after the user has already opened a menu. The
// guest then holds the keyboard while the menu is still up, and neither
// Escape (#306) nor Enter on a row reaches the shell's `document` handlers at
// all, leaving a menu that can only be dismissed with the mouse. So the
// backdrop takes the keyboard straight back, to the chrome element that had it
// when the guest cut in — the same ownership `page-context-menu.js` has taken
// since #319, applied once for every surface that raises the backdrop
// (hamburger and Nodes menus, the Profiles flyout, autocomplete, the bookmark,
// tab, page and chrome-input context menus).
import { onGuestTookKeyboard } from './window-deactivation.js';

let backdrop = null;
let closeAllMenusCallback = null;
// The last chrome element to hold the keyboard, so the reclaim puts it back
// where the user left it (the button that opened the menu, the address bar
// under autocomplete, the page context menu itself) rather than somewhere of
// this module's choosing.
let lastChromeFocus = null;

const isBackdropUp = () => backdrop?.classList?.contains('hidden') === false;

const rememberChromeFocus = (event) => {
  const element = event?.target;
  if (!element || typeof element.focus !== 'function') return;
  // A `<webview>` is the guest, not chrome — remembering it would make the
  // reclaim below hand the keyboard straight back to the page.
  if (element.tagName === 'WEBVIEW') return;
  lastChromeFocus = element;
};

const takeKeyboardBack = () => {
  if (!isBackdropUp()) return;
  const active = document.activeElement;
  // Only take it back from a guest. `activeElement` is the `<webview>` host
  // element once the guest has it, and `<body>` for the moment in between; any
  // real chrome element still holding the keyboard is left alone, so a click
  // that moved focus within the chrome is never undone.
  if (active && active.tagName !== 'WEBVIEW' && active !== document.body) return;
  if (!lastChromeFocus || lastChromeFocus.isConnected === false) return;
  lastChromeFocus.focus?.();
};

const reclaimKeyboardForChrome = () => {
  if (!isBackdropUp()) return;
  // Deferred, not done in the handler: the transfer is still in flight when
  // this `blur` fires, and focusing now only puts the embedder's
  // `activeElement` back — the guest's frame still ends up with the keyboard,
  // so keys keep going to the page while the chrome believes it has them,
  // which is worse than not reclaiming at all. One turn of the event loop is
  // enough for the guest to land; the conditions are re-read there because the
  // surface may have closed, or the user may have left the window, in between.
  setTimeout(takeKeyboardBack, 0);
};

export const initMenuBackdrop = (closeAllMenus) => {
  backdrop = document.getElementById('menu-backdrop');
  closeAllMenusCallback = closeAllMenus;

  backdrop?.addEventListener('mousedown', () => {
    if (closeAllMenusCallback) {
      closeAllMenusCallback();
    }
  });

  // `focusin` bubbles (unlike `focus`), so one listener sees every chrome
  // element that takes the keyboard.
  document.addEventListener?.('focusin', rememberChromeFocus, true);
  onGuestTookKeyboard(reclaimKeyboardForChrome);
};

export const showMenuBackdrop = () => {
  backdrop?.classList.remove('hidden');
};

export const hideMenuBackdrop = () => {
  backdrop?.classList.add('hidden');
};
