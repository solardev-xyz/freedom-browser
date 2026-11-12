'use strict';

/**
 * The chain each window's chain switcher selected, in main (freedom-core
 * design 0011, "Events": the selected chain moves to main; step PRQ-3).
 *
 * The chain switcher is the chrome's, one per window (`chain-switcher.js`),
 * and it reports every change here (`wallet:select-chain`), its own and
 * the ones a page's `wallet_switchEthereumChain` makes through it. The
 * Ethereum reads that main answers for a page (`page/page-ethereum.js`)
 * read the chain of the page's own window from here, as the chrome read its
 * own state before.
 *
 * A page's `wallet_switchEthereumChain` is main's from PRQ-4
 * (`page/page-ethereum.js`): main selects the chain for the page's window
 * itself (`selectChainForPage`) and tells that window's chrome
 * (`wallet:page-selected-chain`), whose switcher then shows it, and reports
 * nothing back.
 *
 * The user's own selection is told to the window's pages by main from PRQ-6
 * (`page/page-events.js`, which listens with `onChromeSelection`): main
 * sends `chainChanged` to every live document of the window whose chain
 * follows the selection. The chrome sends no page an event.
 *
 * A window that has reported nothing has the switcher's default, Gnosis
 * (100). `null` is the switcher's "All Chains", which reads as Gnosis too.
 * A compromised chrome can change this; that is no approval (the design's
 * "Events"), and an onchain app's own chain never comes from here.
 */

const CHANNEL = 'wallet:select-chain';
// main -> chrome: a page's switch selected this chain for the window.
const PAGE_SELECTED_CHANNEL = 'wallet:page-selected-chain';

// The chain switcher's own default (`walletState.selectedChainId`).
const DEFAULT_SELECTED_CHAIN_ID = 100;

// window id -> chain id, or null for "All Chains"
const selected = new Map();
const watched = new Set();
// Called with { window, previous, next } when a window's chrome changes its
// selection (`wallet:select-chain`).
const chromeListeners = new Set();

const isChainId = (value) => Number.isSafeInteger(value) && value > 0;

/** The chain window `windowId`'s switcher selected: a chain id, or null. */
function selectedChainOf(windowId) {
  return selected.has(windowId) ? selected.get(windowId) : DEFAULT_SELECTED_CHAIN_ID;
}

/** Record window `windowId`'s selection. False for a malformed one. */
function selectChain(windowId, chainId) {
  if (!Number.isInteger(windowId)) return false;
  if (chainId !== null && !isChainId(chainId)) return false;
  selected.set(windowId, chainId);
  return true;
}

function forgetWindow(windowId) {
  selected.delete(windowId);
  watched.delete(windowId);
}

function watch(win) {
  const windowId = win.id;
  if (watched.has(windowId)) return;
  watched.add(windowId);
  win.once('closed', () => forgetWindow(windowId));
}

/**
 * A page's `wallet_switchEthereumChain` selects `chainId` for its window:
 * main records it, and tells that window's chrome so its switcher shows
 * it. False for a malformed chain or a window that has gone.
 */
function selectChainForPage(
  windowId,
  chainId,
  { windowFromId = (id) => require('electron').BrowserWindow.fromId(id) } = {}
) {
  if (!isChainId(chainId)) return false;
  let win;
  try {
    win = windowFromId(windowId);
  } catch {
    return false;
  }
  if (!win || win.isDestroyed?.()) return false;
  if (!selectChain(windowId, chainId)) return false;
  watch(win);
  try {
    if (!win.webContents.isDestroyed?.()) win.webContents.send(PAGE_SELECTED_CHANNEL, chainId);
  } catch {
    // The window is closing; its selection goes with it.
  }
  return true;
}

/**
 * Hear of every change a window's chrome makes to its selection, the
 * user's pick in its switcher (`{ window, previous, next }`), but not of a
 * page's switch, which tells its own pages. Returns a function that stops
 * it.
 */
function onChromeSelection(listener) {
  if (typeof listener !== 'function') return () => {};
  chromeListeners.add(listener);
  return () => chromeListeners.delete(listener);
}

/**
 * `wallet:select-chain`, a `send` from the chrome (the sender policy lets
 * only the chrome call a channel no webview tier lists). Main records the
 * selection before it tells any page (`onChromeSelection`), so a page that
 * asks on its `chainChanged` reads the new chain.
 */
function registerSelectedChainIpc(
  ipcMain = require('electron').ipcMain,
  { windowOf = (contents) => require('electron').BrowserWindow.fromWebContents(contents) } = {}
) {
  ipcMain.on(CHANNEL, (event, chainId) => {
    let win;
    try {
      win = windowOf(event.sender);
    } catch {
      return;
    }
    if (!win || win.isDestroyed?.() || !Number.isInteger(win.id)) return;
    const previous = selectedChainOf(win.id);
    if (!selectChain(win.id, chainId)) return;
    watch(win);
    if (previous === chainId) return;
    const change = Object.freeze({ window: win.id, previous, next: chainId });
    for (const listener of chromeListeners) {
      try {
        listener(change);
      } catch {
        // One listener's failure must not keep the others from hearing it.
      }
    }
  });
}

/** Test only: forget every window's selection. */
function resetSelectedChains() {
  selected.clear();
  watched.clear();
}

module.exports = {
  CHANNEL,
  PAGE_SELECTED_CHANNEL,
  DEFAULT_SELECTED_CHAIN_ID,
  selectedChainOf,
  selectChain,
  selectChainForPage,
  onChromeSelection,
  registerSelectedChainIpc,
  resetSelectedChains,
};
