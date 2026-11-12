/**
 * Screen sharing (#951): `getDisplayMedia()` through Freedom's own picker.
 *
 * A site asks to share the screen; Freedom shows its picker (a tab, a window
 * or the entire screen) over the requesting tab, and the user's pick is the
 * consent. Nothing is remembered: every share is picked anew, as in Chrome.
 *
 * Electron 45 raises one `display-capture` permission request for every
 * screen, window or tab capture, and only once that request is granted does
 * it call the session's display-media handler. The request covers two routes,
 * and its details do not say which one asked (they carry `mediaTypes`,
 * `requestingUrl`, `isMainFrame` and `securityOrigin` for both):
 *
 *   getDisplayMedia()                     the standard API. Granting the
 *                                         permission calls the display-media
 *                                         handler, which hands over the pick.
 *   getUserMedia({ chromeMediaSource })   Electron's older route. Granting the
 *                                         permission captures whatever source
 *                                         id the page named (`screen:1:0` is
 *                                         guessable) and the display-media
 *                                         handler never runs, so the pick is
 *                                         skipped. Chrome gives this route to
 *                                         extensions only; no website uses it.
 *
 * So the picker opens at the permission request, and the permission is
 * answered only when the user has picked, together with the pick: the
 * display-media handler runs synchronously inside the permission callback
 * (checked against Electron 45.2.1), which hands it the pick through the
 * `grant` slot below. When the callback returns without that handler having
 * run, the page took the older route, and its renderer is ended before the
 * capture it was granted can reach it (checked the same way: the page never
 * received its stream). The user still saw the picker and chose to share
 * with that site, so this guard bounds what the site gets to what was picked.
 *
 * Gates before the picker, each logged with the origin hidden for a private
 * window:
 *
 *   no usable requesting origin     → refused (internal pages, data:, …)
 *   picker already open (this tab)  → refused (one picker per tab)
 *   no recent user input            → refused (a page cannot pop the picker
 *                                     on load, or again and again)
 *
 * Agent workspace previews run on their own session, which refuses every
 * permission (src/main/agent/workspace-preview-network.js). Onchain apps send
 * `Permissions-Policy: display-capture=()`, which Electron enforces on both
 * routes before any request reaches this module.
 */

const crypto = require('crypto');
const {
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  systemPreferences,
  shell,
  webContents: webContentsModule,
  webFrameMain,
} = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { consumeUserGesture } = require('../external-protocol');
const { getPartitionForWebContents } = require('../private/private-windows');

const KINDS = new Set(['tab', 'window', 'screen']);

// The grid's thumbnails.
const THUMBNAIL_SIZE = { width: 320, height: 180 };

// Electron reports no end to a share, so a shared tab is polled until nothing
// captures it any more. For a grace period after each grant the watch never
// ends: the new capture may not have started yet, and what `isBeingCaptured()`
// sees then may be an earlier share of the same tab that is about to stop.
const SHARE_POLL_MS = 1000;
const SHARE_START_GRACE_POLLS = 10;

const MACOS_SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

// Open pickers by id, and by the tab they were raised for.
const pickers = new Map();
const pickerByGuest = new Map();

// Shared tabs being watched for the end of their share, by webContents id.
const sharedTabs = new Map();

// The pick being handed over right now. Set only for the duration of the
// permission callback, which is when getDisplayMedia() reaches
// handleDisplayMediaRequest (see the module comment).
let grant = null;

// Picker ids are random for the same reason prompt ids are
// (docs/security-audit-electron.md, O-12): an id is the capability to answer.
function newPickerId() {
  let id;
  do {
    id = crypto.randomInt(1, 2 ** 48);
  } while (pickers.has(id));
  return id;
}

// PRIVATE MODE GUARD (logging): the log outlives a private window, so its
// origins never appear there. Same rule as the permissions manager.
const originForLog = (origin, privatePartition) =>
  privatePartition ? '<private>' : origin || 'a page with no site origin';

const isAlive = (contents) =>
  Boolean(contents) && typeof contents.isDestroyed === 'function' && !contents.isDestroyed();

// Test mode (src/main/test-harness.js) answers the desktop sources and the
// macOS access state, so no test run lists or records a real screen.
const testStub = () => globalThis.__FREEDOM_TEST_SCREEN_SHARE__ || null;

/**
 * Whether macOS lets Freedom record windows and screens: 'granted',
 * 'denied', 'restricted', 'not-determined' or 'unknown'. Tab sharing never
 * needs it. Other platforms have no such gate.
 */
function screenRecordingAccess() {
  const stub = testStub();
  if (typeof stub?.screenRecordingAccess === 'function') return stub.screenRecordingAccess();
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

const screenRecordingBlocked = () => {
  const access = screenRecordingAccess();
  return access === 'denied' || access === 'restricted';
};

/** Which panes may offer audio: a tab's own audio, and on Windows the system's. */
function audioOptions(audioRequested) {
  return {
    tab: audioRequested,
    screen: audioRequested && process.platform === 'win32',
  };
}

function sendToHost(entry, channel, payload) {
  try {
    if (isAlive(entry.host)) entry.host.send(channel, payload);
  } catch {
    // The window is closing
  }
}

/** Drop a picker's bookkeeping and listeners. Returns false if already done. */
function release(entry) {
  if (!pickers.has(entry.id)) return false;
  pickers.delete(entry.id);
  if (pickerByGuest.get(entry.guestId) === entry) pickerByGuest.delete(entry.guestId);
  try {
    entry.guest.removeListener('did-navigate', entry.onGone);
    entry.guest.removeListener('destroyed', entry.onGone);
  } catch {
    // Already destroyed
  }
  try {
    entry.host.removeListener('destroyed', entry.onGone);
  } catch {
    // Already destroyed
  }
  return true;
}

/** Close a picker without a pick: the page's request is refused. */
function cancelPicker(entry, reason) {
  if (!release(entry)) return;
  log.info(
    `[screen-share] ${originForLog(entry.origin, entry.privatePartition)}: no share (${reason})`
  );
  sendToHost(entry, IPC.SCREEN_SHARE_PICKER_CLOSE, { id: entry.id });
  try {
    entry.callback(false);
  } catch {
    // The requesting page is gone
  }
}

/**
 * A `display-capture` permission request from a tab. Opens the picker in the
 * tab's window, or refuses.
 *
 * @param {Object} request
 * @param {Electron.WebContents} request.guest - the requesting tab
 * @param {Electron.WebContents|null} request.host - its window's chrome
 * @param {string|null} request.origin - the requesting frame's origin
 * @param {Object} [request.details] - Electron's MediaAccessPermissionRequest
 * @param {(granted: boolean) => void} request.callback
 * @param {string|null} [request.privatePartition]
 * @returns {boolean} true when the picker opened
 */
function requestScreenShare({
  guest,
  host,
  origin,
  details = {},
  callback,
  privatePartition = null,
}) {
  const refuse = (why) => {
    log.info(`[screen-share] ${originForLog(origin, privatePartition)} refused: ${why}`);
    callback(false);
    return false;
  };

  if (!origin) return refuse('no site origin');
  if (!isAlive(host)) return refuse('no window to ask in');
  if (!isAlive(guest) || typeof guest.id !== 'number' || typeof guest.on !== 'function') {
    return refuse('the requesting tab is gone');
  }
  if (pickerByGuest.has(guest.id)) return refuse('a picker is already open for this tab');
  if (!consumeUserGesture(guest)) return refuse('no recent user input');

  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  const isMainFrame = details.isMainFrame !== false;
  const requestingUrl = typeof details.requestingUrl === 'string' ? details.requestingUrl : '';
  const entry = {
    id: newPickerId(),
    guest,
    guestId: guest.id,
    host,
    hostId: host.id,
    origin,
    privatePartition,
    // The document that asked, for the older-route guard (see
    // requestingFrameGone).
    requestingFrames: frameTokensOf(guest, { isMainFrame, requestingUrl }),
    audioRequested: mediaTypes.includes('audio'),
    callback,
    // Everything the picker was shown, by source id: a pick must be one of
    // these, so the chrome can only choose among what Freedom listed.
    offered: new Map(),
  };
  // A new document in the tab, the tab closing or its window closing all end
  // the request the picker was raised for.
  entry.onGone = () => cancelPicker(entry, 'the requesting tab navigated or closed');
  guest.on('did-navigate', entry.onGone);
  guest.once('destroyed', entry.onGone);
  host.once('destroyed', entry.onGone);
  pickers.set(entry.id, entry);
  pickerByGuest.set(entry.guestId, entry);

  sendToHost(entry, IPC.SCREEN_SHARE_PICKER_OPEN, {
    id: entry.id,
    guestId: entry.guestId,
    origin,
    audio: audioOptions(entry.audioRequested),
    platform: process.platform,
  });
  log.info(`[screen-share] picker for ${originForLog(origin, privatePartition)}`);
  return true;
}

/** The picker this window's chrome may act on, or null. */
function pickerFor(id, senderId) {
  const entry = typeof id === 'number' ? pickers.get(id) : null;
  if (!entry) return null;
  // Only the window the picker was sent to may answer it or list for it.
  if (senderId !== entry.hostId) {
    log.warn('[screen-share] picker message from a window that does not own the picker ignored');
    return null;
  }
  return entry;
}

function displayUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

// The favicon cache sits on the history database; it is loaded on first use
// so this module stays cheap to load before that database is open.
function cachedFavicon(url) {
  try {
    const icon = require('../favicons').getCachedFavicon(url);
    // Only an image the chrome can show; the cache also holds other markers.
    return typeof icon === 'string' && icon.startsWith('data:image/') ? icon : null;
  } catch {
    return null;
  }
}

/** The open tabs of the requester's own profile: a normal window's, or its private window's. */
function listTabs(entry) {
  const tabs = [];
  for (const contents of webContentsModule.getAllWebContents()) {
    if (!isAlive(contents) || contents.getType?.() !== 'webview') continue;
    if (!isAlive(contents.hostWebContents)) continue;
    if ((getPartitionForWebContents(contents) || null) !== (entry.privatePartition || null)) {
      continue;
    }
    const url = contents.getURL() || '';
    tabs.push({
      kind: 'tab',
      id: `tab:${contents.id}`,
      contentsId: contents.id,
      name: contents.getTitle() || url || 'Untitled',
      detail: displayUrl(url),
      favicon: url ? cachedFavicon(url) : null,
      current: contents.id === entry.guestId,
    });
  }
  return tabs;
}

async function listDesktopSources(kind) {
  const stub = testStub();
  if (typeof stub?.sources === 'function') {
    return (stub.sources(kind) || []).map((source) => ({ kind, icon: null, ...source }));
  }
  const sources = await desktopCapturer.getSources({
    types: [kind],
    thumbnailSize: THUMBNAIL_SIZE,
    fetchWindowIcons: kind === 'window',
  });
  return sources.map((source) => ({
    kind,
    id: source.id,
    name: source.name || (kind === 'screen' ? 'Screen' : 'Window'),
    thumbnail:
      source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null,
    icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
  }));
}

/**
 * The sources one pane of the picker offers. Windows and screens need macOS's
 * Screen Recording permission; without it the pane says so instead.
 *
 * @returns {Promise<{kind, sources: Object[], blocked?: string, error?: boolean}|null>}
 */
async function listSources({ id, kind, senderId }) {
  const entry = pickerFor(id, senderId);
  if (!entry || !KINDS.has(kind)) return null;

  let sources;
  if (kind === 'tab') {
    sources = listTabs(entry);
  } else {
    if (screenRecordingBlocked()) return { kind, sources: [], blocked: 'screen-recording' };
    try {
      // On a Mac that has not been asked yet, this is what raises macOS's own
      // Screen Recording prompt, as Chrome's picker does.
      sources = await listDesktopSources(kind);
    } catch (err) {
      log.warn(`[screen-share] listing ${kind}s failed:`, err?.message || err);
      return { kind, sources: [], error: true };
    }
    if (!pickers.has(id)) return null;
    if (
      screenRecordingBlocked() ||
      (process.platform === 'darwin' && screenRecordingAccess() !== 'granted')
    ) {
      return { kind, sources: [], blocked: 'screen-recording' };
    }
  }

  for (const source of sources) entry.offered.set(source.id, source);
  return {
    kind,
    sources: sources.map(({ contentsId: _contentsId, ...shown }) => shown),
  };
}

/**
 * The frames that may have asked, by renderer process and frame token. A
 * token names one document: `history.replaceState` keeps it, and Electron
 * forgets it once that document is gone. Matched by URL here only because the
 * request names no frame; at this moment the URL is the frame's current one.
 */
function frameTokensOf(guest, { isMainFrame, requestingUrl }) {
  try {
    const frames = isMainFrame
      ? [guest.mainFrame]
      : guest.mainFrame.framesInSubtree.filter(
          (frame) => frame !== guest.mainFrame && frame.url === requestingUrl
        );
    return frames.map((frame) => ({ processId: frame.processId, frameToken: frame.frameToken }));
  } catch {
    return [];
  }
}

/**
 * Whether the document that asked is certainly gone. Electron then drops the
 * request before the display-media handler and nothing was captured, so the
 * older-route guard has nothing to stop. Anything less than certain (no frame
 * was identified, a lookup failed) counts as still there.
 */
function requestingFrameGone(entry) {
  if (entry.requestingFrames.length === 0) return false;
  return entry.requestingFrames.every(({ processId, frameToken }) => {
    try {
      return !webFrameMain.fromFrameToken(processId, frameToken);
    } catch {
      return false;
    }
  });
}

/**
 * The page asked through getUserMedia's chromeMediaSource, which captures
 * the source id it names and skips the pick. Its renderer is ended before the
 * capture reaches it, and the window says why.
 */
function stopOlderRouteCapture(entry) {
  const who = originForLog(entry.origin, entry.privatePartition);
  if (!isAlive(entry.guest) || requestingFrameGone(entry)) {
    log.info(`[screen-share] ${who}: the requesting frame left before the share started`);
    return;
  }
  log.warn(
    `[screen-share] ${who} asked through getUserMedia's chromeMediaSource, which skips the ` +
      'picker; its page was stopped'
  );
  try {
    entry.guest.forcefullyCrashRenderer();
  } catch (err) {
    log.error('[screen-share] could not stop the page:', err?.message || err);
  }
  sendToHost(entry, IPC.SCREEN_SHARE_BLOCKED, { origin: entry.origin, guestId: entry.guestId });
}

/**
 * The user's answer from the picker: a source id from the list it was shown,
 * or null to cancel.
 *
 * @returns {boolean} true when the answer applied to an open picker
 */
function respond({ id, sourceId, audio, senderId }) {
  const entry = pickerFor(id, senderId);
  if (!entry) return false;

  if (sourceId === null || sourceId === undefined) {
    cancelPicker(entry, 'cancelled');
    return true;
  }
  const source = entry.offered.get(sourceId);
  if (!source) {
    cancelPicker(entry, 'the pick was not one Freedom offered');
    return false;
  }
  let target = null;
  if (source.kind === 'tab') {
    target = webContentsModule.fromId(source.contentsId);
    if (!isAlive(target)) {
      cancelPicker(entry, 'the picked tab closed');
      return true;
    }
  }
  if (!isAlive(entry.guest)) {
    cancelPicker(entry, 'the requesting tab closed');
    return true;
  }

  release(entry);
  const withAudio = audio === true && (source.kind === 'tab' || source.kind === 'screen');
  const handover = { entry, source, target, audio: withAudio, consumed: false };
  grant = handover;
  try {
    entry.callback(true);
  } catch (err) {
    log.warn('[screen-share] granting the request failed:', err?.message || err);
  } finally {
    grant = null;
  }
  if (!handover.consumed) stopOlderRouteCapture(entry);
  return true;
}

/** The streams a pick grants, or null. */
function streamsFor(handover, request) {
  const { source, target } = handover;
  const withAudio = handover.audio && request.audioRequested === true;
  if (source.kind === 'tab') {
    if (!isAlive(target) || !target.mainFrame) return null;
    const streams = { video: target.mainFrame };
    if (withAudio) {
      // Chrome keeps playing a shared tab's audio locally; so does Freedom.
      streams.audio = target.mainFrame;
      streams.enableLocalEcho = true;
    }
    return streams;
  }
  const streams = { video: { id: source.id, name: source.name } };
  if (withAudio && source.kind === 'screen' && process.platform === 'win32') {
    streams.audio = 'loopback';
  }
  return streams;
}

/** The tab a frame belongs to, or null when the frame is gone. */
function contentsOfFrame(frame) {
  if (!frame) return null;
  try {
    return webContentsModule.fromFrame(frame) || null;
  } catch {
    return null;
  }
}

function sendTo(contents, channel, payload) {
  try {
    if (isAlive(contents)) contents.send(channel, payload);
  } catch {
    // The window is closing
  }
}

/**
 * Tell a shared tab's window, which shows it, as Chrome does, and keeps
 * painting it while another tab is in front: a tab Freedom does not paint
 * gives the share no frames. The window is told again when the share ends.
 */
function announceTabShare(target, entry) {
  const host = target.hostWebContents;
  sendTo(host, IPC.SCREEN_SHARE_TAB_SHARED, { guestId: target.id });
  if (host !== entry.host) {
    try {
      BrowserWindow.fromWebContents(host)?.focus();
    } catch {
      // The window is closing
    }
  }
  // A new share of a tab already watched starts the grace period again.
  const watched = sharedTabs.get(target.id);
  if (watched) {
    watched.graceEnd = watched.polls + SHARE_START_GRACE_POLLS;
    return;
  }
  const watch = { polls: 0, graceEnd: SHARE_START_GRACE_POLLS, timer: null };
  watch.timer = setInterval(() => {
    watch.polls += 1;
    if (watch.polls < watch.graceEnd) return;
    if (isAlive(target) && target.isBeingCaptured()) return;
    clearInterval(watch.timer);
    sharedTabs.delete(target.id);
    if (isAlive(target)) {
      sendTo(target.hostWebContents, IPC.SCREEN_SHARE_TAB_UNSHARED, { guestId: target.id });
    }
  }, SHARE_POLL_MS);
  watch.timer.unref?.();
  sharedTabs.set(target.id, watch);
}

/**
 * The session's display-media handler. It only ever hands over the pick that
 * is being granted at this moment; anything else is refused.
 */
function handleDisplayMediaRequest(request, callback) {
  const handover = grant;
  if (!handover) {
    log.warn('[screen-share] display-media request with no pick being granted refused');
    callback(null);
    return;
  }
  handover.consumed = true;
  const { entry, source } = handover;

  const requester = contentsOfFrame(request?.frame);
  const sameRequester =
    requester?.id === entry.guestId &&
    normalizeOrigin(request.securityOrigin || '') === entry.origin;
  const streams = sameRequester ? streamsFor(handover, request) : null;
  const who = originForLog(entry.origin, entry.privatePartition);
  if (!streams) {
    log.warn(`[screen-share] ${who}: the pick could not be handed over; refused`);
    callback(null);
    return;
  }
  try {
    callback(streams);
    log.info(
      `[screen-share] ${who} shares a ${source.kind}` + (streams.audio ? ' with audio' : '')
    );
    if (source.kind === 'tab') announceTabShare(handover.target, entry);
  } catch (err) {
    log.warn(`[screen-share] ${who}: handing over the pick failed:`, err?.message || err);
  }
}

/** Install the display-media handler on a session the tabs run on. */
function installScreenShareHandler(targetSession) {
  if (typeof targetSession?.setDisplayMediaRequestHandler !== 'function') return;
  targetSession.setDisplayMediaRequestHandler(handleDisplayMediaRequest);
}

function registerScreenShareIpc() {
  ipcMain.handle(IPC.SCREEN_SHARE_LIST_SOURCES, (event, request) =>
    listSources({ id: request?.id, kind: request?.kind, senderId: event?.sender?.id })
  );
  ipcMain.handle(IPC.SCREEN_SHARE_RESPOND, (event, response) =>
    respond({
      id: response?.id,
      sourceId: typeof response?.sourceId === 'string' ? response.sourceId : null,
      audio: response?.audio === true,
      senderId: event?.sender?.id,
    })
  );
  ipcMain.handle(IPC.SCREEN_SHARE_OPEN_SYSTEM_SETTINGS, (event, request) => {
    if (process.platform !== 'darwin') return false;
    if (!pickerFor(request?.id, event?.sender?.id)) return false;
    shell.openExternal(MACOS_SCREEN_RECORDING_SETTINGS).catch((err) => {
      log.warn('[screen-share] opening System Settings failed:', err?.message || err);
    });
    return true;
  });
}

// Test-only: forget every picker.
function _resetState() {
  pickers.clear();
  pickerByGuest.clear();
  for (const watch of sharedTabs.values()) clearInterval(watch.timer);
  sharedTabs.clear();
  grant = null;
}

module.exports = {
  requestScreenShare,
  handleDisplayMediaRequest,
  installScreenShareHandler,
  registerScreenShareIpc,
  listSources,
  respond,
  screenRecordingAccess,
  MACOS_SCREEN_RECORDING_SETTINGS,
  _resetState,
};
