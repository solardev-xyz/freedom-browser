'use strict';

/**
 * Which chrome window a main-side operation runs for (freedom-core design
 * 0011, APS-4: "Phone jobs").
 *
 * A phone account's job goes to a chrome's openlv session through main's
 * bridge (`wallet/remote/bridge.js`), and its QR shows in that window's
 * sidebar, where the approvals panel's device wait points. The window is
 * the one that asked: a page's request runs for the window that hosts its
 * tab (`page-requests.js`), a wallet handler for the chrome that called it
 * (`wallet-ipc.js`, `intent-ipc.js`, the remote account's check in
 * `identity-manager.js`), a Safe board for the window it shows in, and an
 * x402 payment for the window that hosts its tab (`x402/sign-flow.js`,
 * APS-5). Each entry point runs its work inside `runInWindow`, and the
 * bridge reads the window back with `requestWindowId`, however many layers
 * lie between.
 *
 * Outside every entry point (the agent), there is no window, and the bridge
 * keeps its old target: the focused window.
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** Run `fn` for window `windowId`; with no window id, as it is. */
function runInWindow(windowId, fn) {
  if (!Number.isInteger(windowId)) return fn();
  return storage.run(Object.freeze({ windowId }), fn);
}

/** The window the current operation runs for, or null. */
function requestWindowId() {
  const store = storage.getStore();
  return Number.isInteger(store?.windowId) ? store.windowId : null;
}

/** The id of the chrome window whose webContents is `contents`, or null. */
function chromeWindowIdOf(contents) {
  try {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(contents);
    if (!win || win.isDestroyed() || win.webContents !== contents) return null;
    return Number.isInteger(win.id) ? win.id : null;
  } catch {
    return null;
  }
}

/**
 * An IPC listener that runs for the window of the chrome that sent it:
 * `listener(event, ...args)` inside `runInWindow`.
 */
function forSenderWindow(listener) {
  return (event, ...args) => runInWindow(chromeWindowIdOf(event?.sender), () => listener(event, ...args));
}

module.exports = { runInWindow, requestWindowId, chromeWindowIdOf, forSenderWindow };
