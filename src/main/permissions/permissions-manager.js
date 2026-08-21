/**
 * Site Permissions Manager
 *
 * Owns Electron's session permission hooks (`setPermissionRequestHandler`
 * + `setPermissionCheckHandler`) for the sessions webviews run on, and
 * turns the old blanket deny into a per-site ask flow:
 *
 *   stored decision (permissions.json)   → applied silently
 *   session-only decision (this run)     → applied silently
 *   no decision, promptable permission   → anchored prompt in the
 *                                          requesting window's renderer
 *   anything else                        → denied (deny-by-default keeps)
 *
 * `pointerLock` and `fullscreen` stay auto-allowed (status quo). `hid`
 * is deliberately NOT promptable: Ledger hardware-wallet support drives
 * HID through its own connect flow, so web-page HID requests keep the
 * pre-existing always-deny behavior.
 *
 * Decisions are keyed by the shared origin normalization
 * (src/shared/origin-utils.js) — the same representation the dApp and
 * Swarm permission stores use, so `bzz://name.eth` and the resolved
 * hash stay distinct origins exactly like they do for wallet grants.
 *
 * Prompts are queued per requesting webContents (the guest webview) —
 * one prompt in flight per tab — and identical origin+permission
 * requests from the same tab are coalesced onto one prompt. Every
 * prompt carries the requesting guest's webContents id so the renderer
 * can scope display to that tab, plus a navigation generation: when the
 * requesting document navigates away or its webContents is destroyed,
 * the request is invalidated (denied once) and the renderer is told to
 * withdraw the prompt. A background tab can therefore never park a
 * prompt under the active tab's address bar, and the active tab's
 * navigation never dismisses a background tab's pending request.
 */

const { ipcMain, systemPreferences } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const store = require('./permissions-store');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { broadcastToAllWebContents } = require('../lib/broadcast-to-all-webcontents');

// Auto-allowed without prompting. pointerLock/fullscreen were the status
// quo before this manager. Sanitized clipboard WRITES (writeText/copy)
// are write-only — nothing to exfiltrate — and every major browser grants
// them without a prompt (Chrome reports clipboard-write as 'granted' by
// default); reading stays behind the clipboard-read prompt.
const ALWAYS_ALLOWED = new Set(['pointerLock', 'fullscreen', 'clipboard-sanitized-write']);

// Media types → storage keys. `media` requests are split so the prompt
// names the right device and decisions stay per-device.
const MEDIA_TYPE_KEYS = {
  video: 'camera',
  audio: 'microphone',
};

// In-memory, session-only decisions (unremembered prompt answers):
// Map<origin, Map<storageKey, 'allow'|'deny'>>. Never persisted.
const sessionDecisions = new Map();

// PRIVATE MODE GUARD (permissions): decisions made in private windows are
// scoped to that window's ephemeral partition and NEVER persisted — even
// when the user ticks "remember". Map<partition, Map<origin, Map<key,
// decision>>>, dropped via clearPrivateDecisions() when the window closes.
// Reads still consult the persistent store first (a profile-level
// allow/deny applies inside private windows, mirroring Chromium's
// incognito content-settings inheritance), but nothing flows back.
const privateDecisions = new Map();

// Per-guest prompt queues (one prompt in flight per requesting tab):
// Map<guestWebContentsId, {guest, host, hostId, generation, active, queue}>
// `generation` increments on every committed main-frame navigation of the
// guest; entries remember the generation they were created under so an
// answer can never apply to a request made by a since-replaced document.
const guestQueues = new Map();

// Guests per host window, so closing the window tears down every queue
// that would have rendered into it:
// Map<hostWebContentsId, {host, onHostDestroyed, guests: Set<GuestState>}>
// The host and its armed destroyed-listener are kept so the listener can be
// disarmed when the last guest leaves — re-arming on the next prompt cycle
// would otherwise accumulate one listener per cycle.
const hostGuests = new Map();

// Pending prompt entries by prompt id (for the renderer's response).
const pendingById = new Map();

let nextPromptId = 1;

/**
 * Map an Electron permission request to the storage keys it covers.
 * Returns null when the permission is not promptable (stays denied).
 *
 * @param {string} permission - Electron permission name
 * @param {Object} [details] - Request details (mediaTypes for 'media')
 * @returns {string[]|null}
 */
function permissionKeysForRequest(permission, details) {
  switch (permission) {
    case 'media': {
      const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
      const keys = [...new Set(mediaTypes.map((t) => MEDIA_TYPE_KEYS[t]).filter(Boolean))];
      // A media request that names neither camera nor microphone (e.g.
      // screen-capture style requests) is not covered by this prompt set.
      return keys.length > 0 ? keys : null;
    }
    case 'notifications':
      return ['notifications'];
    case 'clipboard-read':
      return ['clipboard-read'];
    case 'geolocation':
      return ['geolocation'];
    // Chromium requests plain MIDI as 'midi' and SysEx-capable MIDI as
    // 'midiSysex'; one stored decision covers both.
    case 'midi':
    case 'midiSysex':
      return ['midi'];
    default:
      return null;
  }
}

// The shapes getPermissionKey produces for real sites: a bare Ethereum
// name, a dweb-scheme key, or a scheme://host[:port] web origin. Anything
// else is its raw-string fallback and must not become a storage key.
const VALID_ORIGIN_KEY_SHAPE =
  /^(?:[a-z0-9-]+\.(?:eth|box|wei|gwei)|(?:ipfs|ipns|bzz|rad):\/\/[^/?#\s]+|https?:\/\/[^/?#\s]+)$/i;

/**
 * Derive the permission-store origin for a request. Uses the frame's
 * actual URL — webviews load `bzz://name.eth` (not the resolved hash)
 * directly, so this matches the display-origin the rest of the codebase
 * keys permissions by. Note: this keys by the requesting FRAME's origin,
 * so a cross-origin iframe (reachable only when the embedder delegates
 * via permissions policy) prompts and remembers under the iframe origin,
 * not the top site — double-keying like Chrome is a possible follow-up.
 *
 * @returns {string|null} Normalized origin, or null when unusable
 */
function originForRequest(webContents, details, requestingOrigin) {
  const rawUrl =
    details?.requestingUrl ||
    (typeof webContents?.getURL === 'function' ? webContents.getURL() : '') ||
    requestingOrigin ||
    '';
  if (!rawUrl) return null;
  // Internal pages (file://) and other non-site surfaces never get
  // prompted; they have privileged IPC paths instead.
  if (rawUrl.startsWith('file:') || rawUrl.startsWith('devtools:') || rawUrl === 'about:blank') {
    return null;
  }
  const origin = normalizeOrigin(rawUrl);
  if (!origin) return null;
  // getPermissionKey falls back to the raw input string for null-origin
  // documents (data:, about:srcdoc) and unparseable URLs. Such a "key" is
  // an unbounded attacker-chosen string that would render verbatim in the
  // prompt, and a remembered allow under it could key too broadly — refuse
  // to prompt unless the key has one of the known origin shapes.
  if (!VALID_ORIGIN_KEY_SHAPE.test(origin)) return null;
  return origin;
}

function getSessionDecision(origin, key) {
  return sessionDecisions.get(origin)?.get(key) || null;
}

function setSessionDecision(origin, key, decision) {
  if (!sessionDecisions.has(origin)) {
    sessionDecisions.set(origin, new Map());
  }
  sessionDecisions.get(origin).set(key, decision);
}

function getPrivateDecision(partition, origin, key) {
  return privateDecisions.get(partition)?.get(origin)?.get(key) || null;
}

function setPrivateDecision(partition, origin, key, decision) {
  if (!privateDecisions.has(partition)) {
    privateDecisions.set(partition, new Map());
  }
  const origins = privateDecisions.get(partition);
  if (!origins.has(origin)) {
    origins.set(origin, new Map());
  }
  origins.get(origin).set(key, decision);
}

/**
 * Drop every decision made inside the private window on `partition`.
 * Called from the private-window close cleanup (src/main/index.js).
 */
function clearPrivateDecisions(partition) {
  return privateDecisions.delete(partition);
}

/**
 * Drop a live private-window decision across EVERY open private partition.
 *
 * The settings UI's revoke actions are profile-wide and have no partition to
 * aim at, but "revoke" has to mean revoked: without this, a camera grant made
 * inside a still-open private window keeps granting after the user hit
 * "Revoke all", because `getEffectiveDecision` now (correctly) prefers the
 * partition-scoped answer. Unlike an explicitly stored deny, a removal
 * carries no decision that could override a live private grant — so the live
 * grant has to be removed too. Mirrors `clearSessionDecision`.
 *
 * @param {string} [origin] - omit to clear every origin in every partition
 * @param {string} [key] - omit to clear every key for `origin`
 * @returns {boolean} true if anything was removed
 */
function clearPrivateDecision(origin, key) {
  let removed = false;
  for (const [partition, origins] of privateDecisions) {
    if (origin === undefined) {
      if (origins.size > 0) removed = true;
      privateDecisions.delete(partition);
      continue;
    }
    const keys = origins.get(origin);
    if (!keys) continue;
    if (key === undefined) {
      origins.delete(origin);
      removed = true;
    } else if (keys.delete(key)) {
      removed = true;
      if (keys.size === 0) origins.delete(origin);
    }
    if (origins.size === 0) privateDecisions.delete(partition);
  }
  return removed;
}

function clearSessionDecision(origin, key) {
  const map = sessionDecisions.get(origin);
  if (!map) return;
  if (key === undefined) {
    sessionDecisions.delete(origin);
    return;
  }
  map.delete(key);
  if (map.size === 0) sessionDecisions.delete(origin);
}

/**
 * Effective decision for origin+key: persistent store first, then the
 * run-scoped decisions. Private windows read their own partition-scoped
 * decisions instead of the normal-window session decisions (a "this
 * session" answer in a normal window must not leak into private, and
 * vice versa). Returns 'allow' | 'deny' | null.
 *
 * For private partitions the partition-scoped answer wins over the profile
 * store: inheriting the profile decision when the user has not answered
 * inside the private window is the useful default, but once they HAVE
 * answered there, that answer is the more specific and more recent
 * expression of intent. With the store consulted first, a normal window
 * persisting "allow" for an origin later would silently override a "deny"
 * the user gave in a still-open private window. Chromium gives an explicit
 * incognito decision precedence within incognito for the same reason.
 */
function getEffectiveDecision(origin, key, privatePartition = null) {
  if (privatePartition) {
    return getPrivateDecision(privatePartition, origin, key) || store.getDecision(origin, key);
  }
  return store.getDecision(origin, key) || getSessionDecision(origin, key);
}

/**
 * PRIVATE MODE GUARD (permission logging): `log.info` is written to the
 * persistent <userData>/logs/main.log, which outlives the private window and
 * the app — so an origin a private tab prompted for must never appear there.
 * Private decisions are deliberately kept partition-scoped and dropped on
 * close (clearPrivateDecisions); logging the origin would reinstate exactly
 * the durable record that guard exists to prevent. The event still logs, its
 * origin does not.
 */
function originForLog(origin, privatePartition) {
  return privatePartition ? '<private>' : origin;
}

function broadcastChanged() {
  broadcastToAllWebContents(IPC.PERMISSIONS_CHANGED, {});
}

/**
 * macOS gate for camera/microphone: after the user allows a site, the OS
 * must also allow Freedom itself. Returns the storage keys the OS
 * blocked (empty array = all good). Non-macOS platforms always pass.
 *
 * @param {string[]} keys - Storage keys being granted
 * @returns {Promise<string[]>} Keys blocked at the OS level
 */
async function getOsBlockedMediaKeys(keys) {
  if (process.platform !== 'darwin') return [];
  if (typeof systemPreferences?.askForMediaAccess !== 'function') return [];

  const OS_MEDIA_TYPES = { camera: 'camera', microphone: 'microphone' };
  const blocked = [];
  for (const key of keys) {
    const osType = OS_MEDIA_TYPES[key];
    if (!osType) continue;
    try {
      const granted = await systemPreferences.askForMediaAccess(osType);
      if (!granted) blocked.push(key);
    } catch (err) {
      log.warn(`[permissions] askForMediaAccess(${osType}) failed:`, err?.message || err);
      blocked.push(key);
    }
  }
  return blocked;
}

/**
 * Resolve a media grant through the OS gate; on OS-level denial the
 * request fails and the window gets a distinct notice (the site-level
 * grant stays recorded — it applies as soon as the OS setting flips).
 */
async function grantWithOsGate({ permission, keys, origin, host, callbacks, privatePartition = null }) {
  let allowed = true;
  if (permission === 'media') {
    const blocked = await getOsBlockedMediaKeys(keys.filter((k) => k === 'camera' || k === 'microphone'));
    if (blocked.length > 0) {
      allowed = false;
      log.info(
        `[permissions] macOS blocks ${blocked.join('+')} for ${originForLog(origin, privatePartition)}`
      );
      try {
        if (host && !host.isDestroyed()) {
          host.send(IPC.PERMISSIONS_OS_DENIED, { origin, permissions: blocked });
        }
      } catch {
        // Host window may be closing
      }
    }
  }
  for (const cb of callbacks) {
    try {
      cb(allowed);
    } catch {
      // Requesting webContents may be gone
    }
  }
}

function denyAll(callbacks) {
  for (const cb of callbacks) {
    try {
      cb(false);
    } catch {
      // Requesting webContents may be gone
    }
  }
}

/**
 * Resolve the BrowserWindow-side webContents that hosts a webview's
 * contents (where the prompt UI lives).
 */
function hostForWebContents(webContents) {
  return webContents?.hostWebContents || webContents || null;
}

/**
 * Deny-once and drop every pending entry of one guest. The prompt the
 * renderer is currently showing (if any) is withdrawn via
 * PERMISSIONS_PROMPT_CANCEL so it disappears instead of lingering for a
 * document that no longer exists.
 */
function invalidateGuestEntries(state, reason) {
  const entries = [state.active, ...state.queue].filter(Boolean);
  const active = state.active;
  state.active = null;
  state.queue = [];
  if (entries.length === 0) return;
  for (const entry of entries) {
    pendingById.delete(entry.id);
    denyAll(entry.callbacks);
  }
  if (active) {
    try {
      if (state.host && !state.host.isDestroyed()) {
        state.host.send(IPC.PERMISSIONS_PROMPT_CANCEL, { id: active.id });
      }
    } catch {
      // Host window may be closing
    }
  }
  log.info(
    `[permissions] invalidated ${entries.length} pending prompt(s) for guest ${state.guestId} (${reason})`
  );
}

function teardownGuestState(state, reason) {
  invalidateGuestEntries(state, reason);
  if (typeof state.guest?.removeListener === 'function') {
    state.guest.removeListener('did-navigate', state.onDidNavigate);
    state.guest.removeListener('destroyed', state.onDestroyed);
  }
  guestQueues.delete(state.guestId);
  const entry = hostGuests.get(state.hostId);
  if (entry) {
    entry.guests.delete(state);
    if (entry.guests.size === 0) {
      hostGuests.delete(state.hostId);
      if (typeof entry.host?.removeListener === 'function') {
        entry.host.removeListener('destroyed', entry.onHostDestroyed);
      }
    }
  }
}

/**
 * Track (once per host window) that this guest renders its prompts into
 * `host`, so window destruction cleans up all of its guests' queues.
 */
function trackHostGuest(host, state) {
  const hostId = host.id;
  let entry = hostGuests.get(hostId);
  if (!entry) {
    const onHostDestroyed = () => {
      const current = hostGuests.get(hostId);
      hostGuests.delete(hostId);
      if (!current) return;
      for (const guestState of [...current.guests]) {
        teardownGuestState(guestState, 'window closed');
      }
    };
    entry = { host, onHostDestroyed, guests: new Set() };
    hostGuests.set(hostId, entry);
    host.once('destroyed', onHostDestroyed);
  }
  entry.guests.add(state);
}

/**
 * Queue state for one requesting webContents. Installs the lifecycle
 * hooks that carry the reviewer-facing guarantees: a committed
 * main-frame navigation of the guest bumps its generation and
 * invalidates everything it had pending, and destruction tears the
 * whole queue down.
 */
function getGuestState(guest, host) {
  const id = guest.id;
  let state = guestQueues.get(id);
  if (state) return state;

  state = {
    guest,
    guestId: id,
    host,
    hostId: host.id,
    generation: 0,
    active: null,
    queue: [],
  };
  state.onDidNavigate = () => {
    state.generation += 1;
    invalidateGuestEntries(state, 'document navigated');
  };
  state.onDestroyed = () => {
    teardownGuestState(state, 'webContents destroyed');
  };
  guest.on('did-navigate', state.onDidNavigate);
  guest.once('destroyed', state.onDestroyed);
  guestQueues.set(id, state);
  trackHostGuest(host, state);
  return state;
}

function sendNextPrompt(state) {
  if (state.active || state.queue.length === 0) return;
  state.active = state.queue.shift();
  const { id, origin, permission, keys, guestId } = state.active;
  try {
    state.host.send(IPC.PERMISSIONS_PROMPT_REQUEST, { id, origin, permission, keys, guestId });
  } catch {
    // Host went away between queueing and sending
    const entry = state.active;
    state.active = null;
    pendingById.delete(entry.id);
    denyAll(entry.callbacks);
    sendNextPrompt(state);
  }
}

/**
 * Queue a prompt for the requesting guest. Coalesces with an existing
 * pending prompt from the SAME guest for the same origin + key set;
 * same-origin requests from different tabs stay separate prompts so
 * each answer binds to the tab the user is actually looking at. The
 * private partition is part of the coalescing signature so a private and
 * a normal request can never share one prompt (and therefore one answer).
 */
function enqueuePrompt({
  host,
  guest,
  origin,
  permission,
  keys,
  callback,
  privatePartition = null,
}) {
  const state = getGuestState(guest, host);
  const signature = `${privatePartition || ''} ${origin} ${[...keys].sort().join(',')}`;

  const existing = [state.active, ...state.queue].find(
    (entry) => entry && entry.signature === signature
  );
  if (existing) {
    existing.callbacks.push(callback);
    return;
  }

  const entry = {
    id: nextPromptId++,
    guestId: state.guestId,
    generation: state.generation,
    origin,
    permission,
    keys,
    signature,
    privatePartition,
    callbacks: [callback],
  };
  pendingById.set(entry.id, entry);
  state.queue.push(entry);
  sendNextPrompt(state);
}

/**
 * Apply the renderer's answer for a pending prompt.
 *
 * decision: 'allow' | 'deny' | 'dismiss'
 *   - allow/deny + remember      → persisted to permissions.json
 *   - allow/deny, not remembered → session-only decision
 *   - dismiss (Esc/click-away)   → denied once, nothing recorded
 */
function resolvePrompt({ id, decision, remember }) {
  const entry = pendingById.get(id);
  if (!entry) return false;
  pendingById.delete(id);

  const state = guestQueues.get(entry.guestId);
  if (state && state.active === entry) {
    state.active = null;
  }

  // Defensive: an answer must never apply to a request made by a document
  // that has since been replaced. Navigation/destruction invalidates
  // entries eagerly (removing them from pendingById), so this only fires
  // if a stale answer races that cleanup — deny once, record nothing.
  if (!state || entry.generation !== state.generation) {
    log.info(
      `[permissions] stale prompt answer for ${originForLog(entry.origin, entry.privatePartition)} ignored (denied once)`
    );
    denyAll(entry.callbacks);
    if (state) sendNextPrompt(state);
    return true;
  }

  if (decision === 'allow' || decision === 'deny') {
    for (const key of entry.keys) {
      if (entry.privatePartition) {
        // PRIVATE MODE GUARD (permissions): never persisted, "remember"
        // included — the decision lives exactly as long as the window.
        setPrivateDecision(entry.privatePartition, entry.origin, key, decision);
      } else if (remember) {
        store.setDecision(entry.origin, key, decision);
        // A stale session answer must not shadow future revokes.
        clearSessionDecision(entry.origin, key);
      } else {
        setSessionDecision(entry.origin, key, decision);
      }
    }
    broadcastChanged();
    log.info(
      `[permissions] ${decision} ${entry.keys.join('+')} for ${originForLog(entry.origin, entry.privatePartition)}` +
        (entry.privatePartition
          ? ' (private window)'
          : remember
            ? ' (remembered)'
            : ' (this session)')
    );
  } else {
    log.info(
      `[permissions] dismissed ${entry.keys.join('+')} prompt for ${originForLog(entry.origin, entry.privatePartition)}`
    );
  }

  if (decision === 'allow') {
    grantWithOsGate({
      permission: entry.permission,
      keys: entry.keys,
      origin: entry.origin,
      host: state?.host || null,
      callbacks: entry.callbacks,
      privatePartition: entry.privatePartition,
    });
  } else {
    denyAll(entry.callbacks);
  }

  if (state) sendNextPrompt(state);
  return true;
}

/**
 * Install the request + check handlers on a session (the default
 * session — webviews carry no `partition` attribute, so they share it —
 * or a private window's ephemeral partition session, in which case
 * `privatePartition` names it and every decision stays session-only).
 */
function installPermissionHandlers(targetSession, { privatePartition = null } = {}) {
  if (!targetSession || typeof targetSession.setPermissionRequestHandler !== 'function') {
    return;
  }

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (ALWAYS_ALLOWED.has(permission)) {
      callback(true);
      return;
    }

    const keys = permissionKeysForRequest(permission, details);
    if (!keys) {
      callback(false);
      return;
    }

    const origin = originForRequest(webContents, details);
    if (!origin) {
      callback(false);
      return;
    }

    const decisions = keys.map((key) => getEffectiveDecision(origin, key, privatePartition));

    if (decisions.some((d) => d === 'deny')) {
      callback(false);
      return;
    }

    const host = hostForWebContents(webContents);

    if (decisions.every((d) => d === 'allow')) {
      grantWithOsGate({ permission, keys, origin, host, callbacks: [callback], privatePartition });
      return;
    }

    if (!host || host.isDestroyed()) {
      callback(false);
      return;
    }

    // A prompt is only meaningful while the requesting webContents can be
    // tracked (navigation/destroy invalidation, tab-scoped display).
    if (
      typeof webContents?.id !== 'number' ||
      typeof webContents.on !== 'function' ||
      webContents.isDestroyed?.()
    ) {
      callback(false);
      return;
    }

    enqueuePrompt({
      host,
      guest: webContents,
      origin,
      permission,
      keys,
      callback,
      privatePartition,
    });
  });

  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (ALWAYS_ALLOWED.has(permission)) {
      return true;
    }

    // Checks are synchronous, so only recorded allows pass. An undecided
    // permission reports "denied" — the request path still prompts when
    // the page actually asks.
    let keys;
    if (permission === 'media') {
      const key = MEDIA_TYPE_KEYS[details?.mediaType];
      // A media *check* without a concrete device type passes only when
      // both devices are allowed.
      keys = key ? [key] : ['camera', 'microphone'];
    } else {
      keys = permissionKeysForRequest(permission, details);
    }
    if (!keys) return false;

    const origin = originForRequest(webContents, details, requestingOrigin);
    if (!origin) return false;

    return keys.every((key) => getEffectiveDecision(origin, key, privatePartition) === 'allow');
  });
}

/**
 * Merged decision view for one origin (persistent + session-only).
 * @returns {Object} Map of permission -> { decision, remembered }
 */
function getDecisionsForOrigin(origin) {
  const key = normalizeOrigin(origin);
  if (!key) return {};

  const result = {};
  const stored = store.getAllDecisions()[key] || {};
  for (const [permission, decision] of Object.entries(stored)) {
    result[permission] = { decision, remembered: true };
  }
  for (const [permission, decision] of sessionDecisions.get(key) || []) {
    if (!result[permission]) {
      result[permission] = { decision, remembered: false };
    }
  }
  return result;
}

// The three revoke entry points clear the persistent store, the run-scoped
// session decisions AND the live private-window decisions. All three tiers
// are what "revoke" means to the user; leaving the private tier behind left
// an open private window silently granting until it closed.
function revokeDecision(origin, permission) {
  const key = normalizeOrigin(origin);
  const removed = store.removeDecision(key, permission);
  const hadSession = getSessionDecision(key, permission) !== null;
  clearSessionDecision(key, permission);
  const hadPrivate = clearPrivateDecision(key, permission);
  if (removed || hadSession || hadPrivate) broadcastChanged();
  return removed || hadSession || hadPrivate;
}

function revokeOrigin(origin) {
  const key = normalizeOrigin(origin);
  const removed = store.removeOrigin(key);
  const hadSession = sessionDecisions.has(key);
  clearSessionDecision(key);
  const hadPrivate = clearPrivateDecision(key);
  if (removed || hadSession || hadPrivate) broadcastChanged();
  return removed || hadSession || hadPrivate;
}

function revokeAll() {
  store.clearAll();
  sessionDecisions.clear();
  clearPrivateDecision();
  broadcastChanged();
  return true;
}

/**
 * Register IPC handlers (prompt responses + settings/indicator queries).
 */
function registerPermissionsIpc() {
  ipcMain.handle(IPC.PERMISSIONS_PROMPT_RESPONSE, (_event, response) => {
    if (!response || typeof response.id !== 'number') return false;
    const decision = ['allow', 'deny', 'dismiss'].includes(response.decision)
      ? response.decision
      : 'dismiss';
    return resolvePrompt({
      id: response.id,
      decision,
      remember: response.remember === true,
    });
  });

  ipcMain.handle(IPC.PERMISSIONS_GET_ALL, () => {
    return store.getAllDecisions();
  });

  ipcMain.handle(IPC.PERMISSIONS_GET_FOR_ORIGIN, (_event, origin) => {
    return getDecisionsForOrigin(origin);
  });

  ipcMain.handle(IPC.PERMISSIONS_REVOKE, (_event, origin, permission) => {
    return revokeDecision(origin, permission);
  });

  ipcMain.handle(IPC.PERMISSIONS_REVOKE_ORIGIN, (_event, origin) => {
    return revokeOrigin(origin);
  });

  ipcMain.handle(IPC.PERMISSIONS_REVOKE_ALL, () => {
    return revokeAll();
  });

  log.info('[permissions] IPC handlers registered');
}

// Test-only: reset all in-memory state (queues, session decisions).
function _resetState() {
  sessionDecisions.clear();
  privateDecisions.clear();
  guestQueues.clear();
  hostGuests.clear();
  pendingById.clear();
  nextPromptId = 1;
}

module.exports = {
  installPermissionHandlers,
  registerPermissionsIpc,
  permissionKeysForRequest,
  getDecisionsForOrigin,
  clearPrivateDecisions,
  revokeDecision,
  revokeOrigin,
  revokeAll,
  _resetState,
};
