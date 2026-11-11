/**
 * Sign-In with Ethereum over HTTP authentication (#1152): main-process
 * plumbing. The sidebar's sign-in card (renderer, wallet/siwe-signin.js)
 * is the only consent surface; nothing here signs on its own.
 *
 *   `siwe-detect` (onHeadersReceived): a top-level page load answered
 *     `401` with a `WWW-Authenticate: SIWE …` challenge (challenge.js) that
 *     binds to the page actually loaded. The response passes through, so
 *     the page shows the site's own 401 body behind the card, and the
 *     tab's window is told to show the card.
 *
 *   A challenge lives until the user answers it, a newer 401 replaces it,
 *     the tab navigates away or closes, or it expires; the window is told
 *     (`siwe:challenge-closed`) so the card goes with it.
 *
 *   IPC from the card: `siwe:prepare` builds the ERC-4361 message for the
 *     chosen account; the card signs it through the wallet's normal
 *     confirmation path (`wallet:sign-message`); `siwe:complete` checks the
 *     signature recovers to that account, stashes the `Authorization`
 *     header and reloads the page; `siwe:cancel` drops the challenge.
 *
 *   `siwe-inject` (onBeforeSendHeaders): attaches the stashed header to
 *     that reload, once, for the exact URL, on top-level requests only. A
 *     redirect doesn't carry it on, and if the site still answers 401 the
 *     detector doesn't ask again for that response (loop guard).
 *
 * Top-level GET loads only in this version: a 401 on a subresource, or on a
 * form POST, reaches the page untouched, and so does one in a tab the Agent
 * is driving. Not attached to private sessions (index.js excludes `siwe-*`
 * there). See docs/protocols/siwe-http.md.
 */

const { app, ipcMain, webContents } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyMessage, getAddress } = require('ethers');

const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { registerWebRequestHandler } = require('../webrequest-dispatcher');
const { isGatewayTransportRequest } = require('../ipfs/gateway-transport');
const { getDerivedWallets } = require('../identity-manager');
const { isAgentPageId } = require('../wallet/agent-tab-custody');
const { parseSocksEndpoint } = require('../../shared/socks-endpoint');
const { findSiweChallenge, bindChallenge, needsTorRoute } = require('./challenge');
const { buildSiweMessage, authorizationValue } = require('./message');

// A challenge the user hasn't answered expires after this (or at its own
// expiration time, if sooner); a signed header waiting for its reload
// after this.
const DETECTION_TTL_MS = 10 * 60 * 1000;
const PENDING_AUTH_TTL_MS = 60 * 1000;
const ARMED_TTL_MS = 2 * 60 * 1000;
const STORE_FILE = 'siwe-accounts.json';

// Latest challenge per tab (webContentsId). A newer 401 in the same tab
// replaces it, and the card holding the old id is refused (`stale`).
const detections = new Map();
// Signed header waiting for the reload, per tab: { url, value, expiresAt }.
const pendingAuth = new Map();
// Request ids that carried a header we attached → when, for the loop guard.
const armedRequests = new Map();

let storeCache = null;

/** The page's web origin (scheme, host, port), or null. */
function webOrigin(url) {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

// --- Last account used per site ------------------------------------------

function storePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function loadStore() {
  if (storeCache) return storeCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    storeCache =
      parsed && typeof parsed.origins === 'object' ? parsed : { version: 1, origins: {} };
  } catch {
    storeCache = { version: 1, origins: {} };
  }
  return storeCache;
}

function saveStore() {
  const file = storePath();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(storeCache, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function rememberedAddress(origin) {
  return loadStore().origins[origin]?.address || null;
}

function rememberAccount(origin, address) {
  const store = loadStore();
  store.origins[origin] = { address, lastUsedAt: Date.now() };
  try {
    saveStore();
  } catch (err) {
    log.warn(`[SIWE] could not save the account used for ${origin}: ${err.message}`);
  }
}

/** Forget the account remembered for a site (for "forget this site"). */
function forgetOrigin(origin) {
  const store = loadStore();
  if (!store.origins[origin]) return false;
  delete store.origins[origin];
  saveStore();
  return true;
}

// --- Host window ----------------------------------------------------------

function sendTo(host, channel, payload) {
  if (!host || host.isDestroyed?.()) return;
  host.send(channel, payload);
}

function publicView(detection) {
  const { challenge } = detection;
  return {
    id: detection.id,
    webContentsId: detection.webContentsId,
    url: detection.url,
    origin: detection.origin,
    domain: challenge.domain,
    statement: challenge.statement,
    uri: challenge.uri,
    chainId: challenge.chainId,
    expirationTime: challenge.expirationTime,
    rememberedAddress: rememberedAddress(detection.origin),
  };
}

function detectionExpired(detection, now = Date.now()) {
  if (now - detection.createdAt > DETECTION_TTL_MS) return true;
  const expires =
    detection.challenge.expirationTime && Date.parse(detection.challenge.expirationTime);
  return Boolean(expires) && expires <= now;
}

/**
 * Drop a tab's challenge. `notify` tells its window, so the card closes
 * (not needed when the card itself asked, or when a newer challenge for
 * the same tab is about to replace it).
 */
function dropDetection(detection, { notify = true } = {}) {
  if (detections.get(detection.webContentsId) === detection) {
    detections.delete(detection.webContentsId);
  }
  detection.unwatch?.();
  detection.unwatch = null;
  if (notify) sendTo(detection.host, IPC.SIWE_CHALLENGE_CLOSED, { id: detection.id });
}

/**
 * The challenge belongs to the page that answered 401. When the tab starts
 * another top-level navigation (a link, reload, back, a script) or closes,
 * the challenge goes. The 401 load's own navigation started before its
 * response arrived, so it never trips this.
 */
function watchTab(detection, tab) {
  const onStart = (event, legacyUrl, legacyInPlace, legacyMainFrame) => {
    const isMainFrame = event?.isMainFrame ?? legacyMainFrame;
    const isSameDocument = event?.isSameDocument ?? legacyInPlace;
    if (!isMainFrame || isSameDocument) return;
    dropDetection(detection);
  };
  const onDestroyed = () => dropDetection(detection);
  tab.on('did-start-navigation', onStart);
  tab.once('destroyed', onDestroyed);
  return () => {
    if (tab.isDestroyed()) return;
    tab.removeListener('did-start-navigation', onStart);
    tab.removeListener('destroyed', onDestroyed);
  };
}

function findDetection(id) {
  if (typeof id !== 'string') return null;
  for (const detection of detections.values()) {
    if (detection.id === id) return detection;
  }
  return null;
}

// --- webRequest handlers --------------------------------------------------

function sweepArmed(now = Date.now()) {
  for (const [id, at] of armedRequests) {
    if (now - at > ARMED_TTL_MS) armedRequests.delete(id);
  }
}

function detectHandler(details, context) {
  if (details.statusCode !== 401) return null;
  if (details.resourceType !== 'mainFrame') return null;
  if (!details.webContentsId) return null;
  if (isGatewayTransportRequest(details)) return null;
  // The Agent never signs in, and never asks the user to sign in for it.
  if (isAgentPageId(details.webContentsId)) return null;

  // Loop guard: this response answers a request that carried our header.
  // The site refused the sign-in; let the page show it, and don't ask again.
  if (armedRequests.has(details.id)) {
    armedRequests.delete(details.id);
    log.warn(`[SIWE] ${sanitizeUrl(details.url)} refused the sign-in`);
    return null;
  }

  const found = findSiweChallenge(details.responseHeaders);
  if (!found) return null;
  if ((details.method || 'GET').toUpperCase() !== 'GET') return null;

  // A plain-HTTP onion service is safe to sign in to only if this load went
  // over Tor: ask the session how it routes the page. A navigation started
  // meanwhile (another page, a newer challenge) makes this answer stale.
  if (needsTorRoute(details.url)) {
    const tab = webContents.fromId(details.webContentsId);
    if (!tab || tab.isDestroyed()) return null;
    let navigated = false;
    const onStart = (event, legacyUrl, legacyInPlace, legacyMainFrame) => {
      const isMainFrame = event?.isMainFrame ?? legacyMainFrame;
      const isSameDocument = event?.isSameDocument ?? legacyInPlace;
      if (isMainFrame && !isSameDocument) navigated = true;
    };
    tab.on('did-start-navigation', onStart);
    return routedOverTor(context?.session, details.url).then((overTor) => {
      if (!tab.isDestroyed()) tab.removeListener('did-start-navigation', onStart);
      return navigated ? null : openDetection(details, found, overTor);
    });
  }
  return openDetection(details, found, false);
}

function openDetection(details, found, overTor) {
  // Checked again here: the Agent may have taken the tab during a lookup.
  if (isAgentPageId(details.webContentsId)) return null;
  const bound = bindChallenge(found.params, details.url, Date.now(), { overTor });
  if (!bound.ok) {
    log.warn(`[SIWE] ignoring the challenge from ${sanitizeUrl(details.url)}: ${bound.reason}`);
    return null;
  }

  const tab = webContents.fromId(details.webContentsId);
  const host = tab?.hostWebContents;
  if (!tab || tab.isDestroyed() || !host) return null;

  const previous = detections.get(details.webContentsId);
  if (previous) dropDetection(previous, { notify: false });

  const detection = {
    id: crypto.randomUUID(),
    webContentsId: details.webContentsId,
    url: details.url,
    origin: webOrigin(details.url),
    challenge: bound.challenge,
    createdAt: Date.now(),
    prepared: new Map(),
    host,
    unwatch: null,
  };
  detection.unwatch = watchTab(detection, tab);
  detections.set(details.webContentsId, detection);
  sendTo(host, IPC.SIWE_CHALLENGE, publicView(detection));
  return null;
}

function injectHandler(details, context) {
  if (details.resourceType !== 'mainFrame') return null;
  const pending = pendingAuth.get(details.webContentsId);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt || isAgentPageId(details.webContentsId)) {
    pendingAuth.delete(details.webContentsId);
    return null;
  }
  // Only the GET reload of the exact page that asked: never a form POST or
  // another page the tab goes to instead.
  if (pending.url !== details.url || (details.method || 'GET').toUpperCase() !== 'GET') return null;
  pendingAuth.delete(details.webContentsId);
  // Tor may have stopped since the challenge: then the onion name would go
  // to the system's DNS, and the signed sign-in to whoever answers there.
  if (needsTorRoute(details.url)) {
    return routedOverTor(context?.session, details.url).then((overTor) => {
      // The Agent may have taken the tab during the lookup.
      if (isAgentPageId(details.webContentsId)) return null;
      if (overTor) return attachAuthorization(details, pending);
      log.warn(`[SIWE] not signing in to ${sanitizeUrl(details.url)}: Tor no longer routes it`);
      return null;
    });
  }
  return attachAuthorization(details, pending);
}

function attachAuthorization(details, pending) {
  sweepArmed();
  armedRequests.set(details.id, Date.now());
  const requestHeaders = { ...details.requestHeaders };
  for (const name of Object.keys(requestHeaders)) {
    if (name.toLowerCase() === 'authorization') delete requestHeaders[name];
  }
  requestHeaders.Authorization = pending.value;
  return { requestHeaders };
}

/**
 * Tor on this machine only: the bundled Arti, or a Tor the user runs
 * locally. A SOCKS endpoint elsewhere on the network would carry the signed
 * sign-in there in the clear before Tor ever saw it.
 */
function isLoopbackSocks(endpoint) {
  const host = parseSocksEndpoint(endpoint)?.host?.toLowerCase() || '';
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether `session` sends `url` through Freedom's own Tor proxy (the PAC
 * tor-proxy.js installs while Tor runs), rather than DIRECT, where an onion
 * name would go to the system's DNS. Asks the session itself, so a session
 * without the PAC answers false.
 * @returns {Promise<boolean>}
 */
async function routedOverTor(session, url) {
  const tor = require('../tor-manager');
  const endpoint = tor.getOnionRoutingEndpoint();
  if (!endpoint || !isLoopbackSocks(endpoint)) return false;
  if (typeof session?.resolveProxy !== 'function') return false;
  let proxy;
  try {
    proxy = String(await session.resolveProxy(url)).trim();
  } catch {
    return false;
  }
  // Tor may have stopped, or moved to another proxy, while the session
  // answered: the answer counts only for the routing still in force.
  return proxy === `SOCKS5 ${endpoint}` && tor.getOnionRoutingEndpoint() === endpoint;
}

function installSiweInterception() {
  registerWebRequestHandler('onHeadersReceived', 'siwe-detect', detectHandler);
  registerWebRequestHandler('onBeforeSendHeaders', 'siwe-inject', injectHandler);
}

// --- IPC from the sign-in card --------------------------------------------

async function prepare({ id, walletIndex } = {}) {
  const detection = findDetection(id);
  if (!detection || detections.get(detection.webContentsId) !== detection) {
    return { success: false, error: 'This sign-in request is no longer open.', code: 'stale' };
  }
  if (detectionExpired(detection)) {
    dropDetection(detection, { notify: false });
    return {
      success: false,
      error: 'This sign-in request has expired. Reload the page.',
      code: 'expired',
    };
  }
  if (isAgentPageId(detection.webContentsId)) {
    dropDetection(detection);
    return { success: false, error: 'The Agent is using this tab.', code: 'stale' };
  }
  const wallets = await getDerivedWallets();
  const wallet = wallets.find((w) => w.index === walletIndex);
  if (!wallet || !wallet.address) {
    return { success: false, error: 'That account is not available.', code: 'no_account' };
  }
  if (wallet.type === 'safe') {
    return {
      success: false,
      error: "Multi-owner (Safe) accounts can't sign in yet.",
      code: 'unsupported_account',
    };
  }
  const address = getAddress(wallet.address);
  const message = buildSiweMessage({
    ...detection.challenge,
    address,
    issuedAt: new Date().toISOString(),
  });
  detection.prepared.set(walletIndex, { address, message });
  return { success: true, address, message };
}

async function complete({ id, walletIndex, signature } = {}) {
  const detection = findDetection(id);
  if (!detection || detections.get(detection.webContentsId) !== detection) {
    return { success: false, error: 'This sign-in request is no longer open.', code: 'stale' };
  }
  const prepared = detection.prepared.get(walletIndex);
  if (!prepared) {
    return {
      success: false,
      error: 'Nothing was prepared for that account.',
      code: 'not_prepared',
    };
  }
  if (detectionExpired(detection)) {
    dropDetection(detection, { notify: false });
    return {
      success: false,
      error: 'This sign-in request has expired. Reload the page.',
      code: 'expired',
    };
  }
  let signer;
  try {
    signer = verifyMessage(prepared.message, signature);
  } catch {
    return { success: false, error: 'The signature is not valid.', code: 'bad_signature' };
  }
  if (signer.toLowerCase() !== prepared.address.toLowerCase()) {
    return {
      success: false,
      error: 'The signature is from another account.',
      code: 'bad_signature',
    };
  }

  const tab = webContents.fromId(detection.webContentsId);
  if (!tab || tab.isDestroyed()) {
    dropDetection(detection, { notify: false });
    return { success: false, error: 'The tab is gone.', code: 'stale' };
  }
  // The Agent may have taken the tab while the card was open.
  if (isAgentPageId(detection.webContentsId)) {
    dropDetection(detection, { notify: false });
    return { success: false, error: 'The Agent is using this tab.', code: 'stale' };
  }
  // The page asking must still be the one on screen.
  if (webOrigin(tab.getURL()) !== detection.origin) {
    dropDetection(detection, { notify: false });
    return { success: false, error: 'The page changed before you signed in.', code: 'stale' };
  }

  // Unwatch before the reload below, which is a navigation of its own.
  dropDetection(detection, { notify: false });
  const pending = {
    url: detection.url,
    value: authorizationValue(prepared.message, signature),
    expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
  };
  pendingAuth.set(detection.webContentsId, pending);
  rememberAccount(detection.origin, prepared.address);
  // The header has gone out by the time the load settles; if the load
  // failed first, it must not wait for a later one.
  const settled = () => {
    if (pendingAuth.get(detection.webContentsId) === pending)
      pendingAuth.delete(detection.webContentsId);
  };
  tab.loadURL(detection.url).then(settled, (err) => {
    settled();
    log.warn(`[SIWE] reload of ${sanitizeUrl(detection.url)} failed: ${err.message}`);
  });
  return { success: true };
}

function cancel({ id } = {}) {
  const detection = findDetection(id);
  if (detection) dropDetection(detection, { notify: false });
  return { success: true };
}

function getChallenge({ id } = {}) {
  const detection = findDetection(id);
  if (!detection || detections.get(detection.webContentsId) !== detection) return null;
  if (detectionExpired(detection) || isAgentPageId(detection.webContentsId)) {
    dropDetection(detection);
    return null;
  }
  return publicView(detection);
}

function registerSiweIpc() {
  ipcMain.handle(IPC.SIWE_GET_CHALLENGE, (_event, args) => getChallenge(args));
  ipcMain.handle(IPC.SIWE_PREPARE, (_event, args) => prepare(args));
  ipcMain.handle(IPC.SIWE_COMPLETE, (_event, args) => complete(args));
  ipcMain.handle(IPC.SIWE_CANCEL, (_event, args) => cancel(args));
}

function _resetForTests() {
  for (const detection of detections.values()) detection.unwatch?.();
  detections.clear();
  pendingAuth.clear();
  armedRequests.clear();
  storeCache = null;
}

module.exports = {
  installSiweInterception,
  registerSiweIpc,
  detectHandler,
  injectHandler,
  prepare,
  complete,
  cancel,
  getChallenge,
  forgetOrigin,
  _resetForTests,
};
