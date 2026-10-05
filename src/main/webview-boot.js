/**
 * What the tab webview preload needs before any page script runs, handed to
 * it on its renderer's command line instead of over per-load sync IPC (#512).
 *
 * The preload used to make three synchronous calls into the main process on
 * every main-frame load — is this a private window, the internal pages list,
 * the ethereum provider source — each holding the page until the main thread
 * answered, so any main-thread stall delayed every page load. None of the
 * three changes over a webview's life: the pages list and the provider source
 * are fixed for the process, and a webview's partition (which decides private
 * vs. not) is fixed when it attaches. So `will-attach-webview`
 * (webcontents-setup.js) puts them in the guest's `additionalArguments`, and
 * the preload reads `process.argv`.
 *
 * Every renderer process of the webview gets the same arguments; one the
 * process didn't get (a process Chromium started for a different
 * webContents) simply has no such switch, and the preload falls back to the
 * sync IPC it used before — the handlers in ipc-handlers.js still answer.
 *
 * The provider's EIP-6963 uuid is per page load, so it is not in here: the
 * preload mints one for each document (`__FREEDOM_PROVIDER_CONFIG__`).
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const brand = require('../shared/brand.json');
const internalPages = require('../shared/internal-pages.json');

// Keep in sync with the copy in webview-preload.js (a sandboxed preload
// cannot require this module; webview-boot.test.js pins the two together).
const WEBVIEW_BOOT_SWITCH = '--freedom-webview-boot=';

let ethereumInjectSource = null;
let ethereumProviderInfoStatic = null;

// Ethereum provider injection source, read once. The preload is sandboxed
// and cannot `require('fs')` itself.
function getEthereumInjectSource() {
  if (ethereumInjectSource === null) {
    ethereumInjectSource = fs.readFileSync(
      path.join(__dirname, 'webview-preload-ethereum-inject.js'),
      'utf-8'
    );
  }
  return ethereumInjectSource;
}

// EIP-6963 ProviderInfo static fields. Icon is a 96×96 PNG base64-encoded
// (spec recommends square, 96×96 minimum, and requires an RFC-2397 data URI).
// Name and rdns come from src/shared/brand.json. We cannot read them from
// package.json at runtime because electron-builder strips the `build` section
// (which holds productName and appId) from the packaged package.json.
function getEthereumProviderInfoStatic() {
  if (ethereumProviderInfoStatic) return ethereumProviderInfoStatic;
  const { app } = require('electron');
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon-6963.png')
    : path.join(__dirname, '..', '..', 'assets', 'icon-6963.png');
  // Read the icon defensively: a missing/corrupt file must not block
  // main-process startup. Fall back to an empty icon and let the 6963
  // announcement still fire.
  let icon = '';
  try {
    icon = 'data:image/png;base64,' + fs.readFileSync(iconPath, 'base64');
  } catch (err) {
    log.error('[eip6963] Failed to load provider icon:', err.message);
  }
  ethereumProviderInfoStatic = Object.freeze({
    name: brand.productName,
    icon,
    // rdns is EIP-6963's "reverse-DNS" identifier; brand.appId
    // (baby.freedom.browser) is already valid reverse-DNS of freedom.baby, so
    // we reuse it.
    rdns: brand.appId,
  });
  return ethereumProviderInfoStatic;
}

// Escape '<' as \u003c so a future field value containing '</script>' can't
// break out of the injected <script> tag (defense in depth; today's fields
// all come from brand.json).
function serializeProviderInfo(info) {
  return JSON.stringify(info).replace(/</g, '\\u003c');
}

/**
 * The full provider injection source for one page session, as the
 * `internal:get-ethereum-inject-source` fallback serves it.
 */
function buildEthereumInjectSource(uuid) {
  const info = { ...getEthereumProviderInfoStatic(), uuid };
  return `window.__FREEDOM_PROVIDER_CONFIG__ = ${serializeProviderInfo(info)};\n${getEthereumInjectSource()}`;
}

/**
 * The command-line switch for a tab webview's renderer: base64 of a JSON
 * object `{ isPrivate, internalPages, ethereum? }`. A private webview never
 * gets the wallet providers, so its switch leaves the provider out.
 */
function buildWebviewBootSwitch({ isPrivate }) {
  const boot = { isPrivate: isPrivate === true, internalPages };
  if (!boot.isPrivate) {
    boot.ethereum = {
      info: getEthereumProviderInfoStatic(),
      source: getEthereumInjectSource(),
    };
  }
  return WEBVIEW_BOOT_SWITCH + Buffer.from(JSON.stringify(boot), 'utf-8').toString('base64');
}

module.exports = {
  WEBVIEW_BOOT_SWITCH,
  internalPages,
  buildEthereumInjectSource,
  buildWebviewBootSwitch,
};
