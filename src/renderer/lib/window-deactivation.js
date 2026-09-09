// "The window lost focus" — one definition, for every transient chrome surface
// that dismisses itself when the user leaves the window (#328).
//
// A window `blur` in the browser chrome does not mean the window was
// deactivated. An Electron `<webview>` guest is a separate frame with its own
// widget, so the embedder fires a window `blur` whenever the guest takes the
// keyboard — and since #304 *every* tab activation hands the page focus. That
// focus lands asynchronously: the guest's ack can arrive tens of milliseconds
// after the switch that asked for it, i.e. after the user has already opened a
// menu. The menu is then torn down under the pointer, and the click that was
// on its way lands on the page instead — the hamburger's Downloads row losing
// its click on CI is exactly this, with the guest ack arriving 83 ms after the
// menu opened.
//
// `document.hasFocus()` tells the two apart: it stays `true` for as long as
// focus is anywhere inside this window — a chrome field, a `<webview>` guest,
// nothing at all — and is `false` only when the OS moved focus to another
// window or application, which is the case these listeners exist for. A click
// *into* the page while a surface is open is not one of them either: every
// caller here raises `#menu-backdrop` over the whole window first, so that
// click is caught in the chrome and dismisses the surface through its own
// document-level handler.
//
// The trust popover (navigation.js) and the permission popover
// (site-permissions-ui.js) deliberately keep the raw `blur` listener: neither
// raises the backdrop, so the guest-focus blur is what closes them when the
// user clicks into page content.

// `document.hasFocus` is universal in a browser; the renderer's unit-test
// harnesses build a bare `document` object without it. Treat "cannot tell" as
// deactivated so the dismissal still happens, i.e. fail towards the old
// behaviour rather than towards a surface that never closes.
const windowStillHasFocus = () =>
  typeof document.hasFocus === 'function' ? document.hasFocus() === true : false;

/**
 * Run `handler` when the window is genuinely deactivated, never on a `blur`
 * that only moved the keyboard into one of this window's own `<webview>`
 * guests.
 *
 * @param {() => void} handler
 */
export const onWindowDeactivated = (handler) => {
  // Element `blur` events do not bubble, so a listener registered here (bubble
  // phase) only ever sees window-targeted ones.
  window.addEventListener('blur', () => {
    if (windowStillHasFocus()) return;
    handler();
  });
};
