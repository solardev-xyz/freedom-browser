// Window-blur dismissal for the hamburger family (hamburger menu, Nodes menu,
// the Profiles flyout that hangs off the hamburger).
//
// The renderer's `window` `blur` event is *not* "this window lost focus". It
// also fires when focus moves *into* one of this window's own `<webview>`
// guests, because a guest is a separate frame tree: `<webview>.focus()`
// returns immediately and the guest takes focus a beat later (the same
// asynchrony #304/#319 had to work around for tab activation). So every tab
// activation that hands the page the keyboard emits a blur here, at a moment
// nothing in the chrome controls.
//
// Dismissing on that blur closes a menu the user has just opened: switch tabs,
// open the hamburger, and if the switch's guest-focus transfer lands in the
// meantime the menu disappears under the pointer. That is what made
// `menus.spec.js`'s second Downloads open fail in CI (three retries, and on
// `main` before this branch merged it) — the menu closed between opening it
// and clicking the row, so the click reached the page and the row never ran.
//
// The genuine signal already exists and is more accurate: `mainWindow.js`
// sends `menus:close` from the BrowserWindow's own `blur`, which fires only
// when the OS window loses focus, and `index.js` routes it into
// `closeAllMenus()`. So the in-window case can simply be dropped here.
//
// Scope: only the hamburger family is on this helper. The other chrome
// surfaces that dismiss on `blur` are deliberately left alone —
//   - the trust popover (`navigation.js`), the chrome-input context menu, the
//     permission-indicator popover and the address-bar autocomplete raise no
//     backdrop and *use* the guest-focus blur as their click-into-the-page
//     dismissal (each says so where it listens);
//   - the page context menu is raised from inside the guest and already owns
//     the keyboard while open (#319), so the guest-focus blur is its own
//     hand-back;
//   - the tab context menu and the bookmark menus are the same shape as the
//     hamburger, but neither takes keyboard ownership the way `keepKeyboard`
//     below gives the hamburger, so moving them here would trade a menu that
//     vanishes for one Escape can no longer reach. Tracked in #339 — which is
//     the follow-up, rather than this paragraph.

// One verdict per blur, shared by every handler registered here. `activeElement`
// is read the first time a given event is seen and cached for the rest of that
// dispatch: a `keepKeyboard` callback pulls focus back into the chrome
// synchronously, so a later listener re-reading `activeElement` for the *same*
// blur would see the chrome element and dismiss after all — the hamburger would
// survive while its own Profiles flyout collapsed under it. Registration order
// must not decide behaviour.
let seenBlur = null;
let seenBlurWentToOwnGuest = false;

/**
 * True when the blur that just fired handed focus to a `<webview>` guest of
 * this window, i.e. focus never left the window at all.
 *
 * @param {Event} [event] - the blur being handled, for the per-dispatch cache.
 * @returns {boolean}
 */
export const blurWentToOwnGuest = (event) => {
  if (!event || event !== seenBlur) {
    seenBlur = event || null;
    seenBlurWentToOwnGuest = document.activeElement?.tagName === 'WEBVIEW';
  }
  return seenBlurWentToOwnGuest;
};

/**
 * Register a dismissal handler for a real window-level focus loss.
 *
 * @param {() => void} dismiss - called on blur, unless focus stayed in this
 *   window's own guest `<webview>`.
 * @param {() => void} [keepKeyboard] - called instead, for that in-window
 *   case: the surface is still open, so it takes the keyboard back (an open
 *   menu owns it, the way `page-context-menu.js` does on open — otherwise
 *   Escape, a listener on this window, never fires again and the menu is
 *   mouse-only).
 */
export const onWindowLostFocus = (dismiss, keepKeyboard) => {
  window.addEventListener('blur', (event) => {
    if (blurWentToOwnGuest(event)) {
      keepKeyboard?.();
      return;
    }
    dismiss();
  });
};
