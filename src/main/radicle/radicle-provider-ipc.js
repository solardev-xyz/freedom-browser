/**
 * Radicle Provider — main-process authority.
 *
 * Handles `radicle_*` RPC methods for the page-facing window.radicle
 * provider. Mirrors the Swarm provider's trust model
 * (swarm-provider-ipc.js): the renderer is first-party code that derives
 * the origin from the per-webview display URL and runs the consent UX;
 * this module re-validates EVERYTHING — params, permissions, tier grants —
 * regardless of what the renderer did.
 *
 * Scope: actions only. Reads of public repo data are permission-free
 * `rad:` URL fetches handled by rad-protocol.js, not provider methods.
 *
 * Tiers (see docs/radicle-provider-api.md):
 *  - none:       radicle_getCapabilities
 *  - connection: radicle_getNodeStatus, radicle_listSeededRepos,
 *                radicle_seed, radicle_unseed, radicle_sync,
 *                radicle_getSeedStatus, radicle_disconnect
 *  - signing:    radicle_getIdentity, radicle_createIssue,
 *                radicle_commentIssue, radicle_editIssueState,
 *                radicle_commentPatch
 *
 * Signed writes (the COB methods) each need the user's approval: the
 * renderer's per-write prompt, or the site's "always allow writes" rule
 * (autoApprove.signing), which this module rate-limits per origin. See
 * SIGNED_WRITE_METHODS below.
 *
 * Seeding is honest about replication: radicle_seed writes the policy and
 * kicks off a background fetch, returning immediately with an initial
 * status. Progress is pushed through the provider's `seedStatus` event;
 * radicle_getSeedStatus remains the snapshot/reload path, and radicle_sync
 * restarts the fetch (the retry path) for repos that are already seeded —
 * it can never start seeding a new one. See seed-status.js.
 *
 * Errors: a page never gets the Radicle add-on's own error text, which can
 * name the user's Radicle storage on disk. Each add-on failure is answered
 * with a fixed text for its category (ADDON_ERROR_TEXTS below), and the
 * add-on's text goes to the log only, through redactForLog (#1073).
 */

const { ipcMain, BrowserWindow } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const embedded = require('../radicle-embedded');
const {
  getCurrentStatus,
  getConnections,
  seedRepository,
  unseedRepository,
  getSeedFetchStatus,
  unsubscribeSeedStatus,
  refetchRepository,
  validateAndNormalizeRid,
  getNodeAlias,
  setNodeAlias,
  isDisabledForProfile,
  STATUS,
} = require('../radicle-manager');
const cob = require('./cob-service');
const permissions = require('./radicle-permissions');
const { createAutoWriteLimiter } = require('./auto-write-limiter');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { isAgentPageId, autoApproveRefused } = require('../wallet/agent-tab-custody');
const { isPrivateSender } = require('../private/private-sender');
const { redactForLog, runWithPrivateLogContext } = require('../private/private-log-context');

const SPEC_VERSION = '0.2';

const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Unauthorized' },
  UNSUPPORTED_METHOD: { code: 4200, message: 'Unsupported method' },
  UNAVAILABLE: { code: 4900, message: 'Radicle unavailable' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL: { code: -32603, message: 'Internal error' },
};

function providerError(base, message, data) {
  const err = { code: base.code, message: message || base.message };
  if (data) err.data = data;
  return err;
}

// What a page gets for an add-on error: a fixed text for its category,
// never the add-on's own (#1073). libradicle's text for a repository that
// isn't stored names its storage path, `<radicle home>/storage/<rid>`,
// under the user's profile, and its storage, git and io errors can name
// files there too. The categories and texts are `rad:`'s (#1050):
//  - not found: the test `rad:` decides its 404 on;
//  - too large: libradicle's `TooLarge` and `TooDeep` texts, anchored;
//  - cancelled: libradicle's `Cancelled` text (`clone cancelled` in older
//    add-ons), anchored;
//  - failed: everything else, with the text for what failed: a read, a
//    write, a fetch, or anything else (`Internal error`).
// Each reply's code and data.reason are decided as before, on the add-on's
// own text, so none changes. That text is kept for the decision and for
// the log, through redactForLog.
const MISSING_RE = /not found|does not exist|NotFound/i;
const TOO_LARGE_RE =
  /^(?:\d+ bytes is over the limit of \d+|the tree is nested deeper than \d+ levels)$/;
const CANCELLED_RE = /^(?:clone )?cancelled$/;
const ADDON_ERROR_TEXTS = Object.freeze({
  missing: 'not found',
  tooLarge: 'repository data too large to serve here',
  cancelled: 'request cancelled',
  readFailed: 'the read failed',
  writeFailed: 'the write failed',
  fetchFailed: 'the fetch failed',
});

/** The fixed text for an add-on error's text, `failed` for no category. */
function publicAddonText(message, failed) {
  const text = typeof message === 'string' ? message : '';
  if (MISSING_RE.test(text)) return ADDON_ERROR_TEXTS.missing;
  if (TOO_LARGE_RE.test(text)) return ADDON_ERROR_TEXTS.tooLarge;
  if (CANCELLED_RE.test(text)) return ADDON_ERROR_TEXTS.cancelled;
  return failed;
}

/** Log an add-on error's own text, which no page gets, for `method`. */
function logAddonError(method, message) {
  log.warn(`[radicle-provider] ${method} failed:`, redactForLog(message));
}

// radicle-manager's failures whose text is its own, fixed one. Any other
// failure's text can be the add-on's (UNSEED_FAILED), and is answered by
// its category.
const MANAGER_OWN_TEXTS = new Set(['RADICLE_NOT_RUNNING', 'INVALID_RID', 'NOT_SEEDED']);

function managerFailure(method, error, failed, reason) {
  if (MANAGER_OWN_TEXTS.has(error?.code) && error.message) {
    return providerError(ERRORS.INTERNAL, error.message, { reason });
  }
  logAddonError(method, error?.message);
  return providerError(ERRORS.INTERNAL, publicAddonText(error?.message, failed), { reason });
}

/**
 * A seed status as a page gets it: the fetch's error texts (`lastError`,
 * `progress.reason`, each recent attempt's `error`) are the add-on's, so
 * each gets the fixed text for its category. The tracker keeps and logs
 * the detail (seed-status.js); everything else is unchanged.
 */
function publicSeedStatus(status) {
  if (!status || typeof status !== 'object') return status;
  const text = (message) => publicAddonText(message, ADDON_ERROR_TEXTS.fetchFailed);
  const out = { ...status };
  if (out.lastError != null) out.lastError = text(out.lastError);
  if (out.progress && typeof out.progress === 'object' && out.progress.reason != null) {
    out.progress = { ...out.progress, reason: text(out.progress.reason) };
  }
  if (Array.isArray(out.recentAttempts)) {
    out.recentAttempts = out.recentAttempts.map((attempt) =>
      attempt && typeof attempt === 'object' && attempt.error != null
        ? { ...attempt, error: text(attempt.error) }
        : attempt
    );
  }
  return out;
}

// method -> required grant this process checks. The node-tier per-repo
// consent prompt for `radicle_seed`/`radicle_unseed` is the renderer's
// (radicle-provider.js NODE_METHODS): both are recorded here as needing
// the connection grant, and neither reaches main without its prompt.
const METHOD_TIERS = {
  radicle_requestAccess: 'connection',
  radicle_getCapabilities: 'none',
  radicle_getNodeStatus: 'connection',
  radicle_listSeededRepos: 'connection',
  radicle_seed: 'connection',
  radicle_unseed: 'connection',
  radicle_sync: 'connection',
  radicle_getSeedStatus: 'connection',
  radicle_disconnect: 'connection',
  radicle_getIdentity: 'signing',
  radicle_createIssue: 'signing',
  radicle_commentIssue: 'signing',
  radicle_editIssueState: 'signing',
  radicle_commentPatch: 'signing',
};

const KNOWN_METHODS = new Set(Object.keys(METHOD_TIERS));

// COB writes sign with the user's node identity and publish irrevocably.
// Each needs the user's approval for that write ('user': the renderer
// showed the per-write prompt), or the site's "always allow writes" rule,
// whose writes autoWriteLimiter counts. Anything else is automatic, and
// is refused unless the rule exists and the limit admits it (R-6).
const SIGNED_WRITE_METHODS = new Set([
  'radicle_createIssue',
  'radicle_commentIssue',
  'radicle_editIssueState',
  'radicle_commentPatch',
]);
const autoWriteLimiter = createAutoWriteLimiter();
const PUSH_METHODS = new Set(['radicle_seed', 'radicle_sync', 'radicle_getSeedStatus']);
const seedStatusBroadcasters = new Map();

// Methods that report or change grant/node state rather than requiring a
// running node — a dApp must be able to connect (and disconnect) while
// the node is down.
const WORKS_WHILE_STOPPED = new Set([
  'radicle_getNodeStatus',
  'radicle_requestAccess',
  'radicle_disconnect',
]);

function nodeRunning() {
  return getCurrentStatus().status === STATUS.RUNNING;
}

// Every window's chrome routes a provider event to its own open pages of
// `origin` (radicle-provider.js's onEvent handler). `exceptSender` skips the
// window that asked, which has already told its own pages.
function broadcastProviderEvent(event, origin, data, exceptSender = null) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed() && win.webContents !== exceptSender) {
      win.webContents.send(IPC.RADICLE_PROVIDER_EVENT, { event, origin, data });
    }
  }
}

function getSeedStatusBroadcaster(origin) {
  let broadcast = seedStatusBroadcasters.get(origin);
  if (broadcast) return broadcast;
  // The page gets the add-on's texts in a seed status as fixed category
  // texts, never raw (#1073): publicSeedStatus before the event leaves main.
  broadcast = (data) => broadcastProviderEvent('seedStatus', origin, publicSeedStatus(data));
  seedStatusBroadcasters.set(origin, broadcast);
  return broadcast;
}

function removeSeedStatusBroadcaster(origin) {
  const broadcast = seedStatusBroadcasters.get(origin);
  if (broadcast) unsubscribeSeedStatus(broadcast);
  seedStatusBroadcasters.delete(origin);
}

function unavailableReason(origin) {
  if (isDisabledForProfile()) return 'profile-disabled';
  if (!permissions.getPermission(origin)) return 'not-connected';
  const { status } = getCurrentStatus();
  if (status !== STATUS.RUNNING) {
    return status === STATUS.STARTING ? 'node-not-ready' : 'node-stopped';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Method handlers. Origin is the renderer-derived display origin; permission
// checks against it have already been re-done in executeRadicleMethod.

async function handleGetCapabilities(origin) {
  const reason = unavailableReason(origin);
  return {
    specVersion: SPEC_VERSION,
    canUseNode: reason === null,
    reason,
    writes: ['issue', 'issueComment', 'issueState', 'patchComment'],
  };
}

async function handleGetNodeStatus(origin) {
  const { status } = getCurrentStatus();
  const result = { running: status === STATUS.RUNNING, status };
  if (status === STATUS.RUNNING) {
    const conn = await getConnections();
    if (conn.success) result.peers = conn.count;
  }
  // The alias is public data (gossiped network-wide with the node
  // announcement), so a connected origin may see it. The NID stays behind
  // the signing grant — it pins the user to a specific node identity.
  if (status === STATUS.RUNNING) {
    try {
      const identity = await cob.getIdentity();
      result.alias = identity.alias;
      if (permissions.hasSigningGrant(origin)) result.nid = identity.nid;
    } catch (err) {
      // PRIVATE MODE GUARD: the add-on's text can name its storage path.
      log.warn(
        '[radicle-provider] getNodeStatus identity lookup failed:',
        redactForLog(err.message)
      );
    }
  }
  return result;
}

async function handleListSeededRepos() {
  try {
    return await embedded.listSeededRepos();
  } catch (err) {
    logAddonError('radicle_listSeededRepos', err.message);
    throw providerError(
      ERRORS.INTERNAL,
      publicAddonText(err.message, ADDON_ERROR_TEXTS.readFailed)
    );
  }
}

function requireRidParam(params) {
  const fullRid = validateAndNormalizeRid(params?.rid);
  if (!fullRid) {
    throw providerError(ERRORS.INVALID_PARAMS, 'Invalid Radicle repository ID', {
      reason: 'invalid_rid',
    });
  }
  return fullRid;
}

async function handleSeed(origin, params, onSeedStatus) {
  const rid = requireRidParam(params);
  const result = onSeedStatus
    ? await seedRepository(rid, onSeedStatus)
    : await seedRepository(rid);
  if (!result.success) {
    throw managerFailure(
      'radicle_seed',
      result.error,
      ADDON_ERROR_TEXTS.writeFailed,
      'seed_failed'
    );
  }
  return { rid, seeded: true, status: publicSeedStatus(result.status) };
}

async function handleUnseed(origin, params) {
  const rid = requireRidParam(params);
  const result = await unseedRepository(rid);
  if (!result.success) {
    throw managerFailure(
      'radicle_unseed',
      result.error,
      ADDON_ERROR_TEXTS.writeFailed,
      'unseed_failed'
    );
  }
  return { rid, seeded: false };
}

async function handleSync(origin, params, onSeedStatus) {
  const rid = requireRidParam(params);
  // Non-blocking: (re)start the background fetch and report where it
  // stands. Subsequent transitions are emitted as `seedStatus` events.
  const result = onSeedStatus
    ? await refetchRepository(rid, onSeedStatus)
    : await refetchRepository(rid);
  if (!result.success) {
    // sync is the retry path for a repo the user already seeded; it must
    // not become a second, promptless way to start seeding one (the
    // native fetch writes the policy). radicle_seed — with its per-repo
    // consent prompt — is the only way in.
    if (result.error?.code === 'NOT_SEEDED') {
      throw providerError(ERRORS.INVALID_PARAMS, result.error.message, {
        reason: 'not_seeded',
      });
    }
    throw managerFailure(
      'radicle_sync',
      result.error,
      ADDON_ERROR_TEXTS.writeFailed,
      'sync_failed'
    );
  }
  return { rid, status: publicSeedStatus(result.status) };
}

async function handleGetSeedStatus(origin, params, onSeedStatus) {
  const rid = requireRidParam(params);
  const result = onSeedStatus
    ? await getSeedFetchStatus(rid, onSeedStatus)
    : await getSeedFetchStatus(rid);
  if (!result.success) {
    throw managerFailure(
      'radicle_getSeedStatus',
      result.error,
      ADDON_ERROR_TEXTS.readFailed,
      'status_failed'
    );
  }
  return publicSeedStatus(result.status); // includes rid
}

/**
 * Translate cob-service errors into provider errors. A validation error's
 * text is cob-service's own; any other is the add-on's, so the page gets
 * its category's text, and the reason cob-service decided on its text.
 */
function wrapCobError(method, err) {
  if (err instanceof cob.CobValidationError) {
    return providerError(ERRORS.INVALID_PARAMS, err.message, { reason: err.reason });
  }
  logAddonError(method, err.message);
  const failed = SIGNED_WRITE_METHODS.has(method)
    ? ADDON_ERROR_TEXTS.writeFailed
    : ADDON_ERROR_TEXTS.readFailed;
  return providerError(
    ERRORS.INTERNAL,
    publicAddonText(err.message, failed),
    err.reason ? { reason: err.reason } : null
  );
}

async function handleCobWrite(method, fn, params) {
  try {
    return await fn(params);
  } catch (err) {
    throw err.code ? err : wrapCobError(method, err);
  }
}

// The only COB write failure known to come before anything is signed is a
// parameter error: cob-service validates every field before it calls the
// node. A native failure — including one cob-service tags `repo_not_found`
// because its message matches /not found/ (an unknown repo, but also a
// missing issue, patch or replyTo the page chose) — may come after the
// change was signed and stored, so it keeps its automatic-write charge;
// otherwise a page could repeat it without the limit ever applying.
function failedBeforeSigning(err) {
  return err?.code === ERRORS.INVALID_PARAMS.code;
}

/**
 * A signed write. A rule-answered write that fails before signing gives its
 * limiter charge back, so a site retrying a bad write doesn't burn its
 * daily budget on writes that never published.
 */
async function handleSignedWrite(method, fn, params, refundAutoWrite) {
  try {
    return await handleCobWrite(method, fn, params);
  } catch (err) {
    if (refundAutoWrite && failedBeforeSigning(err)) refundAutoWrite();
    throw err;
  }
}

// ---------------------------------------------------------------------------

/**
 * Execute a provider method with full re-validation. The renderer has
 * already run consent UX; this is the authority layer.
 * @param {string} method
 * @param {object} params
 * @param {string} origin - display-URL-derived origin from the renderer
 * @param {{onSeedStatus?: Function, approval?: 'user'|'auto', privateSender?: boolean}} [options]
 *   approval: how the renderer answered a signed write (`meta.approval`).
 *   Only 'user' (the per-write prompt was shown and accepted) skips the
 *   rule gate; the private-window, tier and node checks still apply.
 *   Anything else, including leaving it out, is rule-gated: refused with
 *   `approval_required` unless the site's "always allow writes" rule
 *   exists, then charged against autoWriteLimiter (`auto_write_limit`
 *   once used up) (R-6).
 *   privateSender: the request came from a private (or unclassifiable)
 *   window. Lasting changes are refused, and use is not recorded (R-9).
 */
async function executeRadicleMethod(
  method,
  params = {},
  origin,
  { onSeedStatus, approval, privateSender = false } = {}
) {
  if (!KNOWN_METHODS.has(method)) {
    throw providerError(ERRORS.UNSUPPORTED_METHOD, `Unknown method: ${method}`);
  }
  const privateRefusal = privateWindowRefusal(privateSender, method);
  if (privateRefusal) throw privateRefusal;
  // Snapshot-only for a private window, whatever the caller passed.
  if (privateSender) onSeedStatus = undefined;
  if (!origin || typeof origin !== 'string') {
    throw providerError(ERRORS.UNAUTHORIZED, 'Missing origin');
  }
  // Disconnecting only forgets this site's record and rule, so it stays
  // possible on a profile with Radicle disabled: the sidebar's × and its
  // Disconnect must still clear a site connected before Radicle was turned
  // off.
  if (isDisabledForProfile() && method !== 'radicle_disconnect') {
    throw providerError(ERRORS.UNAVAILABLE, 'Radicle is disabled for this profile', {
      reason: 'profile-disabled',
    });
  }

  const tier = METHOD_TIERS[method];
  // Set when the "always allow writes" rule answered this write: the
  // limiter's charge for it, returned if the write fails before signing.
  let refundAutoWrite = null;
  if (tier !== 'none') {
    if (!permissions.getPermission(origin)) {
      throw providerError(ERRORS.UNAUTHORIZED, 'Origin not connected', {
        reason: 'not_connected',
      });
    }
    if (tier === 'signing' && !permissions.hasSigningGrant(origin)) {
      throw providerError(ERRORS.UNAUTHORIZED, 'Origin lacks the signing grant', {
        reason: 'signing_not_granted',
      });
    }
    if (!nodeRunning() && !WORKS_WHILE_STOPPED.has(method)) {
      throw providerError(ERRORS.UNAVAILABLE, 'Radicle node is not running', {
        reason: 'node-stopped',
      });
    }
    if (SIGNED_WRITE_METHODS.has(method) && approval !== 'user') {
      if (!permissions.getAutoApprove(origin, 'signing')) {
        throw providerError(ERRORS.UNAUTHORIZED, 'This write needs the user\'s approval', {
          reason: 'approval_required',
        });
      }
      refundAutoWrite = autoWriteLimiter.admit(normalizeOrigin(origin));
      if (!refundAutoWrite) {
        throw providerError(
          ERRORS.UNAUTHORIZED,
          'This site has used up its automatic writes for now; this one needs the user\'s approval',
          { reason: 'auto_write_limit' }
        );
      }
    }
    // A private window's use is not recorded (R-9).
    if (!privateSender) permissions.updateLastUsed(origin);
  }

  switch (method) {
    case 'radicle_requestAccess':
      // Reaching here means the permission record exists (tier check above);
      // the renderer granted it via the consent prompt before forwarding.
      return {
        connected: true,
        origin: permissions.getPermission(origin).origin,
        capabilities: await handleGetCapabilities(origin),
      };
    case 'radicle_getCapabilities':
      return handleGetCapabilities(origin);
    case 'radicle_getNodeStatus':
      return handleGetNodeStatus(origin);
    case 'radicle_listSeededRepos':
      return handleListSeededRepos();
    case 'radicle_seed':
      return handleSeed(origin, params, onSeedStatus);
    case 'radicle_unseed':
      return handleUnseed(origin, params);
    case 'radicle_sync':
      return handleSync(origin, params, onSeedStatus);
    case 'radicle_getSeedStatus':
      return handleGetSeedStatus(origin, params, onSeedStatus);
    case 'radicle_disconnect':
      // An origin may relinquish its own grant (connection AND signing) —
      // the inverse of requestAccess, no consent needed.
      permissions.revokePermission(origin);
      removeSeedStatusBroadcaster(origin);
      autoWriteLimiter.forget(normalizeOrigin(origin));
      return { connected: false };
    case 'radicle_getIdentity':
      return handleCobWrite(method, () => cob.getIdentity(), params);
    case 'radicle_createIssue':
      return handleSignedWrite(method, (p) => cob.createIssue(p), params, refundAutoWrite);
    case 'radicle_commentIssue':
      return handleSignedWrite(method, (p) => cob.commentIssue(p), params, refundAutoWrite);
    case 'radicle_editIssueState':
      return handleSignedWrite(method, (p) => cob.editIssueState(p), params, refundAutoWrite);
    case 'radicle_commentPatch':
      return handleSignedWrite(method, (p) => cob.commentPatch(p), params, refundAutoWrite);
    /* istanbul ignore next -- KNOWN_METHODS guard makes this unreachable */
    default:
      throw providerError(ERRORS.UNSUPPORTED_METHOD, `Unknown method: ${method}`);
  }
}

// Seed/unseed run without a prompt only when the site's node auto-approve
// rule answers. The renderer reports the path it took in `meta.approval`
// ('user' after the prompt, 'auto' when the rule answered) and names the
// requesting guest in `meta.webContentsId`. A guest in Agent custody, or an
// automatic request main cannot attribute to a guest of the sending window,
// is refused on main's own custody reading — the refusal wallet-ipc.js
// applies to dApp auto-approve rules.
const AUTO_APPROVABLE_METHODS = new Set(['radicle_seed', 'radicle_unseed']);

// A signed write the site's "always allow writes" rule answers is the same
// kind of automatic approval: only 'user' (the renderer showed the
// per-write prompt) skips the check, and a request that names no path is
// read as automatic.
function agentCustodyRefusal(sender, method, meta) {
  const signedWrite = SIGNED_WRITE_METHODS.has(method);
  if (!signedWrite && !AUTO_APPROVABLE_METHODS.has(method)) return null;
  if (meta?.approval === 'user') return null;
  const webContentsId = meta?.webContentsId;
  const automatic = signedWrite || meta?.approval === 'auto';
  if (
    isAgentPageId(webContentsId) ||
    (automatic && autoApproveRefused(sender, webContentsId))
  ) {
    return providerError(
      ERRORS.UNAUTHORIZED,
      'A page in Agent custody needs approval for this action',
      { reason: 'agent_custody' }
    );
  }
  return null;
}

// PRIVATE MODE GUARD (R-9): a private window must leave nothing behind.
// The provider is not installed in private windows, but the chrome
// renderer forwards any guest's provider message, so main decides on the
// sender it can see, the window's chrome renderer, and fails closed: a
// sender it cannot classify as a known public window counts as private
// (private-sender.js). From such a sender:
//  - every method that changes lasting state is refused: the seeding
//    policy and fetched repositories (seed, unseed, sync), signed COB
//    writes, and the origin's grant (disconnect revokes it);
//  - the reads that stay allowed do not record their use: no lastUsed
//    write to radicle-permissions.json.
const PRIVATE_REFUSED_METHODS = new Set([
  'radicle_seed',
  'radicle_unseed',
  'radicle_sync',
  'radicle_disconnect',
  ...SIGNED_WRITE_METHODS,
]);

function privateWindowRefusal(privateSender, method) {
  if (!privateSender || !PRIVATE_REFUSED_METHODS.has(method)) return null;
  return providerError(ERRORS.UNAUTHORIZED, 'Not available in private windows', {
    reason: 'private_window',
  });
}

function registerRadicleProviderIpc() {
  // Chrome-facing alias management (sidebar Nodes tab). Registered here —
  // not in radicle-manager — because the alias write must also invalidate
  // cob-service's memoized identity, and cob-service depends on the
  // manager (registering there would create a require cycle).
  ipcMain.handle(IPC.RADICLE_GET_ALIAS, () => getNodeAlias());
  ipcMain.handle(IPC.RADICLE_SET_ALIAS, async (_event, alias) => {
    const result = await setNodeAlias(alias);
    if (result.success) cob.clearIdentityCache();
    return result;
  });

  ipcMain.handle(IPC.RADICLE_PROVIDER_EXECUTE, async (event, { method, params, origin, meta } = {}) => {
    // PRIVATE MODE GUARD (#1073): the log lines below keep the add-on's
    // text, which can name the user's Radicle storage, through
    // redactForLog, which redacts only in a private log context. A private
    // window's request runs in one. main decides on the sender it can see
    // and fails closed: a sender it cannot place in a known public window
    // counts as private (private-sender.js).
    const privateSender = isPrivateSender(event);
    return runWithPrivateLogContext(privateSender, async () => {
      // Before the seed-status broadcaster or the backend is touched.
      const privateRefusal = privateWindowRefusal(privateSender, method);
      if (privateRefusal) return { error: privateRefusal };
      const refusal = agentCustodyRefusal(event?.sender, method, meta);
      if (refusal) return { error: refusal };
      const hadBroadcaster = seedStatusBroadcasters.has(origin);
      // A private window's seed-status read is a snapshot: no broadcaster
      // for its origin and no subscription to the fetch, since nothing a
      // private window does may outlive it, and the disconnect that would
      // remove them is refused to it (R-9).
      const onSeedStatus =
        PUSH_METHODS.has(method) && !privateSender ? getSeedStatusBroadcaster(origin) : undefined;
      try {
        const result = await executeRadicleMethod(method, params, origin, {
          onSeedStatus,
          approval: meta?.approval,
          privateSender,
        });
        if (method === 'radicle_disconnect') {
          // The site may be open in other windows too. The asking window tells
          // its own pages and repaints its banner (radicle-provider.js); every
          // other window learns here, so its pages get the disconnect event
          // and its Radicle banner stops showing the site as connected.
          broadcastProviderEvent('disconnect', origin, { origin }, event?.sender ?? null);
        }
        return { result };
      } catch (err) {
        if (onSeedStatus && !hadBroadcaster) removeSeedStatusBroadcaster(origin);
        if (err && typeof err.code === 'number') {
          return { error: err };
        }
        // Not a provider error: an add-on, io or other failure, whose text
        // the page doesn't get (#1073).
        const message = typeof err?.message === 'string' ? err.message : String(err);
        log.error(`[radicle-provider] ${method} failed:`, redactForLog(message));
        return {
          error: {
            ...ERRORS.INTERNAL,
            message: publicAddonText(message, ERRORS.INTERNAL.message),
          },
        };
      }
    });
  });
  log.info('[radicle-provider] IPC handler registered');
}

module.exports = {
  executeRadicleMethod,
  registerRadicleProviderIpc,
  _resetAutoWriteLimiter: () => autoWriteLimiter.reset(),
};
