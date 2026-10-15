/**
 * Browser full screen: the chrome steps aside for the page (#78).
 *
 * F11, View → Enter Full Screen and the hamburger menu's full-screen button
 * all call `BrowserWindow.setFullScreen()`. On its own that only makes the
 * *window* fill the screen, with the tab strip, toolbar, bookmarks bar and
 * sidebar still stacked above the page. Every browser instead hides its own
 * chrome and lets the active page have the screen, so the window's state is
 * reported to its chrome renderer, which hides itself (lib/browser-fullscreen.js).
 *
 * The report rides the window's own `enter-full-screen`/`leave-full-screen`
 * events rather than the three call sites, so every way into or out of full
 * screen is covered the same: the menu, F11 (accelerator or the renderer's
 * fallback), the toolbar button, macOS's green button and a page's own
 * Fullscreen API request. It is re-sent whenever the chrome finishes loading,
 * so a reloaded chrome starts in the right state.
 *
 * Escape is the page's, as in Chrome's and Firefox's F11 mode: only the
 * full-screen binding (F11), View → Exit Full Screen or macOS's green button
 * leave. Claiming Escape would take it from every web app that uses it (a
 * modal's close, an editor's normal mode, a game's pause menu), and a page in
 * its own Fullscreen API full screen already gets Chromium's Escape to leave
 * that one.
 */

const IPC = require('../shared/ipc-channels');

function sendFullscreenState(win) {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (!contents || contents.isDestroyed?.()) return;
  contents.send(IPC.WINDOW_FULLSCREEN_CHANGED, win.isFullScreen());
}

/**
 * Report a chrome window's full-screen state to its renderer, now and on
 * every change.
 */
function attachFullscreenChromeSync(win) {
  win.on('enter-full-screen', () => sendFullscreenState(win));
  win.on('leave-full-screen', () => sendFullscreenState(win));
  win.webContents?.on('did-finish-load', () => sendFullscreenState(win));
}

module.exports = { attachFullscreenChromeSync };
