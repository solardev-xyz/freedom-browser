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
 * That flow is the REQUEST path. The synchronous CHECK path
 * (`navigator.permissions.query`, `Notification.permission`) is boolean-only
 * in Electron, so it cannot report Chrome's "prompt" state: it answers false
 * only for a recorded deny and reports an undecided permission as allowed.
 * Every capability promptable today stays gated by the REQUEST path, so
 * that answer is a read-side over-report rather than a grant — but it is a
 * per-permission property to re-check, not a blanket one; see the check
 * handler for why (#361).
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
 * Dismissing a prompt (Esc / click-away) is a deny-once that records
 * nothing, so the site can ask again. Chromium bounds that: after three
 * dismissals of the same origin + permission it embargoes the pair and
 * auto-denies without prompting. Freedom does the same (#364) — the
 * embargo is recorded in the existing run-scoped tier (session-only in a
 * normal window, partition-scoped in a private one), so it survives
 * navigation but not a restart, and a revoke clears it along with the
 * dismissal counter — in the scopes that revoke applies to (#366; see
 * `revokeInScope`). Only real user dismissals count: an allow or a block
 * resets the counter, and a request invalidated by navigation or by the
 * window closing never touches it.
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
const { getPartitionForWebContents } = require('../private/private-windows');
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

// Dismissal embargo (#364), Chromium's rule: three dismissals of the same
// origin + permission auto-deny it from then on, without a prompt. Blocks
// and allows are decisions, not dismissals — they reset the counter.
const DISMISS_EMBARGO_THRESHOLD = 3;

// Consecutive prompt dismissals per scope → origin → storage key.
// Map<scopeKey, Map<origin, Map<storageKey, count>>>, where the scope key
// is the private partition or '' for the normal profile — a private
// window's dismissals must not embargo the origin outside it, exactly
// like the decisions they lead to. Never persisted; the count is dropped
// by any revoke, by an allow/block answer, and (for a private partition)
// when the window closes.
const dismissCounts = new Map();

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
  /^(?:[a-z0-9-]+\.(?:eth|box|wei|gwei)|(?:ipfs|ipns|bzz|rad):\/\/[^/?#\s]+|web3:\/\/0x[0-9a-f]{40}(?::[1-9][0-9]*)?|https?:\/\/[^/?#\s]+)$/i;

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
  clearPrivateDismissCounts(partition);
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
  for (const partition of [...privateDecisions.keys()]) {
    if (origin === undefined) {
      if (privateDecisions.get(partition).size > 0) removed = true;
      privateDecisions.delete(partition);
      continue;
    }
    if (clearPrivateDecisionIn(partition, origin, key)) removed = true;
  }
  return removed;
}

/**
 * Drop a live decision in ONE private partition — what a revoke issued from
 * inside that window means (#366). Sibling private windows and the normal
 * profile's own run-scoped tier are left alone.
 *
 * @param {string} partition
 * @param {string} origin
 * @param {string} [key] - omit to clear every key for `origin`
 * @returns {boolean} true if anything was removed
 */
function clearPrivateDecisionIn(partition, origin, key) {
  const origins = privateDecisions.get(partition);
  if (!origins) return false;
  let removed = false;
  if (key === undefined) {
    removed = origins.delete(origin);
  } else {
    const keys = origins.get(origin);
    if (keys?.delete(key)) {
      removed = true;
      if (keys.size === 0) origins.delete(origin);
    }
  }
  if (origins.size === 0) privateDecisions.delete(partition);
  return removed;
}

// Dismissal counters live in the same shape as the decisions they lead to:
// scoped to the private partition when there is one, to the profile
// otherwise. `scopeKey` keeps the two apart in one map.
const dismissScope = (privatePartition) => privatePartition || '';

function getDismissCount(scopeKey, origin, key) {
  return dismissCounts.get(scopeKey)?.get(origin)?.get(key) || 0;
}

/**
 * Record one dismissal of origin+key in `scopeKey`.
 * @returns {number} The new consecutive-dismissal count.
 */
function bumpDismissCount(scopeKey, origin, key) {
  if (!dismissCounts.has(scopeKey)) dismissCounts.set(scopeKey, new Map());
  const origins = dismissCounts.get(scopeKey);
  if (!origins.has(origin)) origins.set(origin, new Map());
  const keys = origins.get(origin);
  const next = (keys.get(key) || 0) + 1;
  keys.set(key, next);
  return next;
}

/**
 * Forget dismissals in ONE scope. With both `origin` and `key` that is what
 * an explicit allow or block means ("the user answered; start counting
 * over"); the wider forms are what a revoke scoped to one window means
 * (#366) — mirrors clearPrivateDecisionIn.
 *
 * @param {string} scopeKey - private partition, or '' for the normal profile
 * @param {string} [origin] - omit to clear every origin in this scope
 * @param {string} [key] - omit to clear every key for `origin`
 */
function clearDismissCountsIn(scopeKey, origin, key) {
  const origins = dismissCounts.get(scopeKey);
  if (!origins) return;
  if (origin === undefined) {
    dismissCounts.delete(scopeKey);
    return;
  }
  if (key === undefined) {
    origins.delete(origin);
  } else {
    const keys = origins.get(origin);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) origins.delete(origin);
  }
  if (origins.size === 0) dismissCounts.delete(scopeKey);
}

/**
 * Forget dismissals across EVERY scope — what a profile-wide revoke means.
 * Settings has no partition to aim at, and an embargo the user just reset
 * must not come back on the next dismissal, so the counter goes with the
 * decision (mirrors clearPrivateDecision).
 *
 * @param {string} [origin] - omit to clear every origin in every scope
 * @param {string} [key] - omit to clear every key for `origin`
 */
function clearDismissCounts(origin, key) {
  for (const scopeKey of [...dismissCounts.keys()]) {
    clearDismissCountsIn(scopeKey, origin, key);
  }
}

/**
 * Drop every dismissal counter for one private partition (window close).
 * Its decisions go the same way via clearPrivateDecisions.
 */
function clearPrivateDismissCounts(partition) {
  dismissCounts.delete(dismissScope(partition));
}

/**
 * True when origin+key is denied because of the dismissal embargo rather
 * than an answer the user gave. Derived from the counter, which any
 * revoke clears — so a reset origin is never reported as embargoed.
 */
function isEmbargoed(origin, key, privatePartition = null) {
  return (
    getDismissCount(dismissScope(privatePartition), origin, key) >= DISMISS_EMBARGO_THRESHOLD &&
    getEffectiveDecision(origin, key, privatePartition) === 'deny'
  );
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
 *   - dismiss (Esc/click-away)   → denied once, nothing recorded, until
 *                                  the third consecutive dismissal of the
 *                                  same origin+key records a run-scoped
 *                                  deny (the embargo, #364)
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

  const scopeKey = dismissScope(entry.privatePartition);

  if (decision === 'allow' || decision === 'deny') {
    for (const key of entry.keys) {
      // The user answered: previous dismissals stop counting toward the
      // embargo, whichever way they answered.
      clearDismissCountsIn(scopeKey, entry.origin, key);
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
    // Dismiss (Esc / click-away): still a deny-once that records nothing —
    // until the third one in a row for the same origin+key, which records
    // the run-scoped deny that stops the site re-raising the prompt
    // indefinitely (#364). Chromium's embargo, minus its expiry: this tier
    // is dropped on restart anyway (and with the private window, for a
    // private partition), and the user can lift it from the address-bar
    // popover, which clears the counter with it.
    const embargoed = [];
    for (const key of entry.keys) {
      const dismissals = bumpDismissCount(scopeKey, entry.origin, key);
      if (dismissals < DISMISS_EMBARGO_THRESHOLD) continue;
      if (entry.privatePartition) {
        setPrivateDecision(entry.privatePartition, entry.origin, key, 'deny');
      } else {
        setSessionDecision(entry.origin, key, 'deny');
      }
      embargoed.push(key);
    }
    log.info(
      `[permissions] dismissed ${entry.keys.join('+')} prompt for ${originForLog(entry.origin, entry.privatePartition)}`
    );
    if (embargoed.length > 0) {
      broadcastChanged();
      log.info(
        `[permissions] embargoed ${embargoed.join('+')} for ${originForLog(entry.origin, entry.privatePartition)}` +
          ` after ${DISMISS_EMBARGO_THRESHOLD} dismissals (this session)`
      );
    }
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

    // Checks (navigator.permissions.query, Notification.permission,
    // enumerateDevices labels) are synchronous and boolean-only: Electron
    // maps false to PermissionStatus::DENIED and offers no way to say
    // "prompt" the way Chrome does (electron/electron#19891). An undecided
    // permission therefore has to report as one of granted/denied, and
    // "denied" is the worse lie (#361): sites that consult the Permissions
    // API before they ask — Google Meet's pre-join screen — read it as a
    // hard block, show their "access is blocked" state and never call
    // getUserMedia, so Freedom's own per-site prompt never fires and the
    // user has nothing to click. So only a RECORDED deny (persistent,
    // session-only, or private-window — i.e. the user already said no)
    // answers false here; undecided reports allowed, which is also
    // Electron's own default when no check handler is installed.
    //
    // For each permission promptable today this does not widen what a site
    // actually gets, because the capability itself is gated by the REQUEST
    // path, which is unchanged: an undecided request still raises the
    // anchored prompt, a Block there still denies, and a recorded deny is
    // still silently refused both here and there. That holds for
    // notifications too, the one capability a page can exercise without
    // ever calling requestPermission(): a bare `new Notification()` from an
    // undecided origin raises the anchored prompt and displays nothing
    // until the user clicks Allow (verified in the running app on
    // 2026-09-15, Electron 44.3.0 — PR #363). What an undecided site does
    // get is the read-side lie this trade-off is about: query() /
    // Notification.permission report "granted" and enumerateDevices()
    // exposes device labels before any decision.
    //
    // That is a per-permission property, not a standing guarantee of this
    // handler. Before making a new permission promptable, check in the
    // running app which handler its capability actually consults: if it is
    // gated on THIS one rather than the request path, answering true while
    // undecided hands the capability over silently, with no prompt and no
    // recorded decision — such a permission has to keep answering false
    // here.
    let keys;
    if (permission === 'media') {
      const key = MEDIA_TYPE_KEYS[details?.mediaType];
      // A media *check* without a concrete device type covers both devices,
      // so a recorded deny on either one answers the check.
      keys = key ? [key] : ['camera', 'microphone'];
    } else {
      keys = permissionKeysForRequest(permission, details);
    }
    // Non-promptable permissions (hid, display-capture, …) stay denied.
    if (!keys) return false;

    const origin = originForRequest(webContents, details, requestingOrigin);
    if (!origin) return false;

    return keys.every((key) => getEffectiveDecision(origin, key, privatePartition) !== 'deny');
  });
}

/**
 * Merged decision view for one origin, as it applies in ONE window.
 * An embargo (#364) is a run-scoped deny like any other, flagged so the
 * chrome can say the site was auto-blocked rather than blocked by the user.
 *
 * The run-scoped tier is read from the same scope the request path answers
 * from (`getEffectiveDecision`): a private window's own partition, the
 * normal-profile session decisions otherwise. Reading the normal-profile
 * tier for every window painted a normal-window "this session" deny —
 * an embargo included — into private windows, where it does not apply and
 * the site still prompts, and offered a Remove there that silently cleared
 * the normal profile's decision; a private window's own embargo, held in
 * the partition tier, showed up nowhere at all.
 *
 * @param {string} origin
 * @param {string|null} [privatePartition] - the asking window's partition
 * @returns {Object} Map of permission -> { decision, remembered, embargoed? }
 */
function getDecisionsForOrigin(origin, privatePartition = null) {
  const key = normalizeOrigin(origin);
  if (!key) return {};

  const result = {};
  const stored = store.getAllDecisions()[key] || {};
  for (const [permission, decision] of Object.entries(stored)) {
    result[permission] = { decision, remembered: true };
  }
  const runScoped = privatePartition
    ? privateDecisions.get(privatePartition)?.get(key)
    : sessionDecisions.get(key);
  for (const [permission, decision] of runScoped || []) {
    // Inside a private window the partition-scoped answer is the more
    // specific one and wins over the store, exactly as
    // `getEffectiveDecision` resolves it; a normal-window session decision
    // never overrides a stored one.
    if (result[permission] && !privatePartition) continue;
    result[permission] = { decision, remembered: false };
    if (isEmbargoed(key, permission, privatePartition)) result[permission].embargoed = true;
  }
  return result;
}

// Every revoke clears the persistent store, a run-scoped decision and the
// dismissal counter behind an embargo (#364) — a reset that left the count at
// the threshold would re-embargo on the site's very next dismissed prompt, so
// "Remove" would not genuinely let the site ask again.
//
// WHICH run-scoped tiers it reaches is the revoke's SCOPE (#366):
//
//   profile-wide (the default; Settings > Site Permissions, "Remove site",
//     "Remove all") — the store, the normal-profile session tier and EVERY
//     live private partition. The private sweep is deliberate: without it a
//     camera grant made inside a still-open private window keeps granting
//     after the user hit "Revoke all", because `getEffectiveDecision`
//     (correctly) prefers the partition-scoped answer and a removal carries
//     no decision that could override it.
//
//   window-scoped (the address-bar popover's "Remove") — exactly the tiers
//     the ASKING window reads: the store, plus its own run-scoped tier and
//     that scope's dismissal counter. A Remove clicked in a private window
//     therefore clears that partition's decision and leaves the normal
//     profile's session decision standing, and a Remove clicked in a normal
//     window leaves every private partition alone. Before this, both
//     directions silently cleared the other scope's decision with no trace
//     in the window the user was looking at (#366).
//
//     The store is shared, so a window-scoped Remove does clear a REMEMBERED
//     decision — including from a private window, which lists the stored tier
//     because it inherits it (`getEffectiveDecision`). That is the answer to
//     #366's open question: the popover lists what applies in this window and
//     its Remove has to lift exactly that, or Remove on an inherited row does
//     nothing visible. It only ever deletes a decision — it can never grant
//     one, and nothing private is written back.
const PROFILE_WIDE_SCOPE = { windowScoped: false, privatePartition: null };

/**
 * @typedef {Object} RevokeScope
 * @property {boolean} windowScoped - true for the popover's window-scoped Remove
 * @property {string|null} privatePartition - the asking window's partition, if private
 */

/**
 * Shared body of revokeDecision/revokeOrigin.
 *
 * @param {string} origin
 * @param {string|undefined} permission - undefined revokes the whole origin
 * @param {RevokeScope} [scope]
 */
function revokeInScope(origin, permission, scope) {
  const { windowScoped = false, privatePartition = null } = scope || PROFILE_WIDE_SCOPE;
  const key = normalizeOrigin(origin);
  const wholeOrigin = permission === undefined;

  // The persistent store is the one tier every window reads.
  let changed = wholeOrigin ? store.removeOrigin(key) : store.removeDecision(key, permission);

  // The normal profile's run-scoped tier: not a tier a private window reads,
  // so a Remove clicked inside one must not touch it.
  if (!windowScoped || !privatePartition) {
    const hadSession = wholeOrigin
      ? sessionDecisions.has(key)
      : getSessionDecision(key, permission) !== null;
    clearSessionDecision(key, permission);
    if (hadSession) changed = true;
  }

  // Live private-window decisions: every partition profile-wide, only the
  // asking window's own when the revoke is window-scoped.
  if (!windowScoped) {
    if (clearPrivateDecision(key, permission)) changed = true;
  } else if (privatePartition) {
    if (clearPrivateDecisionIn(privatePartition, key, permission)) changed = true;
  }

  if (windowScoped) {
    clearDismissCountsIn(dismissScope(privatePartition), key, permission);
  } else {
    clearDismissCounts(key, permission);
  }

  if (changed) broadcastChanged();
  return changed;
}

function revokeDecision(origin, permission, scope) {
  return revokeInScope(origin, permission, scope);
}

function revokeOrigin(origin, scope) {
  return revokeInScope(origin, undefined, scope);
}

function revokeAll() {
  store.clearAll();
  sessionDecisions.clear();
  clearPrivateDecision();
  clearDismissCounts();
  broadcastChanged();
  return true;
}

/**
 * Resolve a revoke's scope (#366). A caller asks for a window-scoped revoke
 * with `{ scope: 'window' }` — the chrome preload marks the address-bar
 * popover's Remove that way, and nothing else does, so Settings stays
 * profile-wide. Which window that is never comes from the renderer: the
 * partition is resolved from the IPC sender through the private-window
 * registry, the same way `permissions:get-for-origin` resolves the scope it
 * answers from, so the read and the revoke behind it can't drift apart.
 *
 * @returns {RevokeScope}
 */
function scopeFromSender(event, options) {
  if (options?.scope !== 'window') return PROFILE_WIDE_SCOPE;
  return {
    windowScoped: true,
    privatePartition: getPartitionForWebContents(event?.sender) || null,
  };
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

  // The indicator/popover query is answered for the asking window's own
  // scope: the sender is that window's chrome renderer, so the partition
  // comes from the private-window registry rather than from the renderer.
  ipcMain.handle(IPC.PERMISSIONS_GET_FOR_ORIGIN, (event, origin) => {
    return getDecisionsForOrigin(origin, getPartitionForWebContents(event?.sender));
  });

  ipcMain.handle(IPC.PERMISSIONS_REVOKE, (event, origin, permission, options) => {
    return revokeDecision(origin, permission, scopeFromSender(event, options));
  });

  ipcMain.handle(IPC.PERMISSIONS_REVOKE_ORIGIN, (event, origin, options) => {
    return revokeOrigin(origin, scopeFromSender(event, options));
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
  dismissCounts.clear();
  guestQueues.clear();
  hostGuests.clear();
  pendingById.clear();
  nextPromptId = 1;
}

// Test-only: read the consecutive-dismissal count behind the embargo.
// Once an embargo lands, the recorded deny shadows the counter (the site
// stops prompting), and every path that removes that deny also clears the
// counter — so "an allow/block reset the count" is not observable from
// behavior alone. This exists so those resets can be pinned directly.
function _getDismissCount(origin, key, { privatePartition = null } = {}) {
  return getDismissCount(dismissScope(privatePartition), normalizeOrigin(origin) || origin, key);
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
  DISMISS_EMBARGO_THRESHOLD,
  _resetState,
  _getDismissCount,
};
