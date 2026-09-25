/**
 * External protocol links (magnet:, mailto:, tel:, zoommtg:, steam:, …) — #406
 *
 * Chromium hands a navigation to a scheme it does not handle itself to the
 * embedder as an `openExternal` permission request. Freedom used to deny that
 * request outright, so every such link did nothing. This module holds the
 * policy the permissions manager applies to those requests, plus the two
 * other ways an external URL reaches main:
 *
 *   page navigation (link click, scripted `location` change)
 *     → `openExternal` permission request → permissions-manager.js
 *   `target="_blank"` link / `window.open`
 *     → `setWindowOpenHandler` (webcontents-setup.js) → same gate
 *   typed into the address bar
 *     → `external-protocol:open-from-address-bar` IPC (this module)
 *
 * Policy, in the order it is applied to a page-initiated launch:
 *
 * 1. Scheme blocklist (`BLOCKED_SCHEMES`). Schemes the browser handles
 *    itself or that name local/internal resources never reach the OS, and
 *    neither do OS handlers with a record of turning a link click into code
 *    execution (Follina's `ms-msdt:`, `search-ms:`, …). A blocklist, not an
 *    allowlist, because the point of the feature is the long tail — a
 *    game launcher's `steam:`, a meeting client's `zoommtg:` — and Chrome
 *    and Firefox both ship blocklist + prompt for the same reason. The
 *    prompt (3) is the real gate for every scheme not on the list.
 * 2. Only the top-level document, or a same-origin subframe, may ask, and
 *    only right after the user interacted with the page (see
 *    `consumeUserGesture`): a page cannot pop a prompt — or, once allowed,
 *    launch an app — on load, and an embedded third-party frame (an ad)
 *    cannot ask in the top site's name.
 * 3. The existing per-site prompt, keyed by origin + scheme
 *    (`external:<scheme>`), so allowing `magnet:` for a site never allows
 *    `ms-settings:` for it too. Remembered decisions, the dismissal embargo
 *    and the private-window scoping all come from the permissions manager
 *    unchanged.
 *
 * An allowed launch goes through `shell.openExternal`, escaped the way
 * Chromium escapes external-handler URLs, never through the page's own
 * navigation — the permission callback is always answered `false`.
 */

const { app, ipcMain, shell } = require('electron');
const log = require('./logger');
const IPC = require('../shared/ipc-channels');

// Storage-key prefix for per-scheme decisions in permissions.json.
const EXTERNAL_KEY_PREFIX = 'external:';

// RFC 3986 scheme grammar, lower-cased; capped so a key stays readable.
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,63}$/;

// Schemes that are handled inside the browser (Chromium's own, and
// Freedom's registered dweb schemes), or that point at local or internal
// resources. None of these is an "external app" — handing one to the OS
// would at best do something surprising (xdg-open on a `file:` URL runs the
// file's default handler) and at worst run code.
const INTERNAL_SCHEMES = [
  'http',
  'https',
  'ws',
  'wss',
  'file',
  'filesystem',
  'javascript',
  'vbscript',
  'data',
  'blob',
  'about',
  'chrome',
  'chrome-extension',
  'chrome-untrusted',
  'chrome-error',
  'chrome-search',
  'devtools',
  'view-source',
  // Freedom's own: its registered protocols (src/main/index.js) and the
  // schemes webcontents-setup.js's will-navigate hands to the chrome.
  'freedom',
  'bzz',
  'ipfs',
  'ipns',
  'web3',
  'ens',
  'rad',
  'radapi',
  'ethereum',
];

// OS handlers that have been used to turn a single link click into code
// execution or a credential leak. Mostly Windows, where a protocol handler
// is often a thin wrapper over a powerful local tool; the list follows the
// ones Chromium/Firefox/Edge have blocked or special-cased after real
// exploits. Registered handlers not on this list still need the prompt.
const DANGEROUS_OS_SCHEMES = [
  'ms-msdt', // Follina (CVE-2022-30190)
  'search-ms', // remote search results → run a remote executable
  'search',
  'ms-search',
  'ms-officecmd', // Office/Teams argument injection (2021)
  'ms-word', // ms-word:ofe|u|<remote doc>
  'ms-excel',
  'ms-powerpoint',
  'ms-visio',
  'ms-access',
  'ms-project',
  'ms-publisher',
  'ms-spd',
  'ms-infopath',
  'ms-cxh', // out-of-box/account setup host
  'ms-cxh-full',
  'ms-appinstaller', // disabled by Microsoft after malware abuse
  'ms-its', // compiled HTML help
  'its',
  'mk',
  'hcp', // Help and Support Center (CVE-2010-1885)
  'ms-help',
  'res',
  'shell', // shell: namespace paths
  'jar',
  'x-man-page', // macOS Terminal man-page injection
];

const BLOCKED_SCHEMES = new Set([...INTERNAL_SCHEMES, ...DANGEROUS_OS_SCHEMES]);

// Chromium's transient user activation lasts 5s (kActivationLifespan); a
// launch requested more than that after the last real input is not the
// user's doing.
const USER_GESTURE_WINDOW_MS = 5000;

// Input events that count as user activation. Mouse moves, wheel and focus
// changes don't (the same split Chromium's user activation uses).
const GESTURE_INPUT_TYPES = new Set([
  'mouseDown',
  'mouseUp',
  'keyDown',
  'rawKeyDown',
  'char',
  'touchStart',
  'touchEnd',
  'gestureTap',
]);

// Last user input per webview guest, in ms since epoch.
const lastUserGesture = new WeakMap();

/**
 * Lower-cased scheme of `url`, or null when it has none / an invalid one.
 * Parsed by hand rather than with `new URL()` so an opaque external URL
 * (`mailto:a@b`, `magnet:?xt=…`) and a malformed one fail the same way.
 */
function schemeOf(url) {
  if (typeof url !== 'string') return null;
  const colon = url.indexOf(':');
  if (colon <= 0) return null;
  const scheme = url.slice(0, colon).toLowerCase();
  return SCHEME_RE.test(scheme) ? scheme : null;
}

/**
 * True when `url` carries a scheme the browser does not handle itself — i.e.
 * the kind of URL Chromium would hand to the embedder as `openExternal`.
 * Dangerous OS schemes count (they are external) and are then refused by
 * `isSchemeAllowed`; the split lets callers log a refusal rather than letting
 * a blocked link fall through to a default path.
 */
function isExternalProtocolUrl(url) {
  const scheme = schemeOf(url);
  return !!scheme && !INTERNAL_SCHEMES.includes(scheme);
}

function isSchemeAllowed(scheme) {
  return !!scheme && SCHEME_RE.test(scheme) && !BLOCKED_SCHEMES.has(scheme);
}

/**
 * Permission-store key for an external URL: `external:<scheme>`, or null
 * when the URL has no usable scheme or the scheme is blocked.
 */
function permissionKeyForExternalUrl(url) {
  const scheme = schemeOf(url);
  if (!isSchemeAllowed(scheme)) return null;
  return `${EXTERNAL_KEY_PREFIX}${scheme}`;
}

/**
 * What of an external URL may reach the persistent log: the scheme only.
 * The rest is exactly what the user would not want in a log file — a mail
 * address, a phone number, a torrent's info-hash, a meeting id.
 */
function externalUrlForLog(url) {
  const scheme = schemeOf(url);
  return scheme ? `${scheme}:<redacted>` : 'unknown';
}

// Port of Chromium's base::EscapeExternalHandlerValue (the escaping
// Chromium applies before handing a URL to the OS): percent-escape controls,
// space, non-ASCII and the characters a shell or command line could read as
// syntax, while leaving existing %XX escapes and URL structure intact.
const EXTERNAL_HANDLER_UNSAFE = new Set(['"', '<', '>', '\\', '^', '`', '{', '|', '}']);

function escapeExternalHandlerValue(url) {
  const bytes = Buffer.from(String(url), 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (byte <= 0x20 || byte >= 0x7f || EXTERNAL_HANDLER_UNSAFE.has(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Record user input on a webview guest, so a later external launch can be
 * checked against it. Electron does not expose Chromium's user-gesture bit
 * on `openExternal` requests (the details carry only `externalURL`,
 * `isMainFrame` and `requestingUrl`), so the guest's own input stream stands
 * in for it.
 */
function trackUserGestures(contents) {
  if (!contents || typeof contents.on !== 'function') return;
  contents.on('input-event', (_event, input) => {
    if (GESTURE_INPUT_TYPES.has(input?.type)) {
      lastUserGesture.set(contents, Date.now());
    }
  });
}

/**
 * True, once, when the guest had user input within the activation window.
 * Consumed like Chromium consumes activation for a popup: one interaction
 * buys one launch (or one prompt), so a page cannot turn a single click
 * into a burst of app launches.
 */
function consumeUserGesture(contents, now = Date.now()) {
  if (!contents) return false;
  const at = lastUserGesture.get(contents);
  if (typeof at !== 'number') return false;
  lastUserGesture.delete(contents);
  return now - at <= USER_GESTURE_WINDOW_MS;
}

/**
 * Name of the OS application registered for `scheme`, or '' when none is.
 * Test mode can stub it (`__FREEDOM_TEST_EXTERNAL_PROTOCOL__`), since a CI
 * runner has no handlers registered.
 */
function handlerNameForScheme(scheme) {
  const stub = globalThis.__FREEDOM_TEST_EXTERNAL_PROTOCOL__;
  if (typeof stub?.appNameFor === 'function') return stub.appNameFor(scheme) || '';
  try {
    return app.getApplicationNameForProtocol(`${scheme}:`) || '';
  } catch {
    return '';
  }
}

/**
 * Hand an already-vetted URL to the OS. Test mode records it instead of
 * launching anything.
 */
async function launchExternal(url) {
  const escaped = escapeExternalHandlerValue(url);
  const stub = globalThis.__FREEDOM_TEST_EXTERNAL_PROTOCOL__;
  if (typeof stub?.open === 'function') {
    stub.open(escaped);
    return true;
  }
  try {
    await shell.openExternal(escaped);
    return true;
  } catch (err) {
    log.warn(
      `[external-protocol] ${externalUrlForLog(url)} failed to open: ${err?.message || err}`
    );
    return false;
  }
}

/**
 * Address-bar input. The user typed the whole URL and pressed Enter — the
 * explicit act the page-side prompt exists to ask for — so a typed URL opens
 * without a prompt, but still only past the blocklist. And like Chrome's
 * omnibox, input only counts as an external URL when the OS has a handler
 * registered for its scheme; anything else (`define:word`, `note:milk`)
 * is left to the search fallback.
 *
 * @returns {Promise<{opened: boolean, reason?: string}>}
 */
async function openFromAddressBar(url) {
  const scheme = schemeOf(typeof url === 'string' ? url.trim() : '');
  if (!scheme || !isExternalProtocolUrl(url.trim()))
    return { opened: false, reason: 'not-external' };
  if (!isSchemeAllowed(scheme)) {
    log.info(`[external-protocol] address bar: blocked scheme ${externalUrlForLog(url)}`);
    return { opened: false, reason: 'blocked' };
  }
  if (!handlerNameForScheme(scheme)) {
    return { opened: false, reason: 'no-handler' };
  }
  log.info(`[external-protocol] address bar: opening ${externalUrlForLog(url)}`);
  const opened = await launchExternal(url.trim());
  return opened ? { opened: true } : { opened: false, reason: 'launch-failed' };
}

function registerExternalProtocolIpc() {
  ipcMain.handle(IPC.EXTERNAL_PROTOCOL_OPEN_FROM_ADDRESS_BAR, (event, url) => {
    // Only the browser chrome has an address bar. A webview guest never gets
    // this channel through its preload; refuse it anyway.
    if (event?.sender?.getType?.() === 'webview') {
      return { opened: false, reason: 'not-chrome' };
    }
    return openFromAddressBar(url);
  });
}

module.exports = {
  EXTERNAL_KEY_PREFIX,
  BLOCKED_SCHEMES,
  USER_GESTURE_WINDOW_MS,
  schemeOf,
  isExternalProtocolUrl,
  isSchemeAllowed,
  permissionKeyForExternalUrl,
  externalUrlForLog,
  escapeExternalHandlerValue,
  trackUserGestures,
  consumeUserGesture,
  handlerNameForScheme,
  launchExternal,
  openFromAddressBar,
  registerExternalProtocolIpc,
};
