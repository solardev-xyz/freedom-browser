/**
 * Radicle Provider — main-process authority.
 *
 * Handles `radicle_*` RPC methods for the page-facing window.radicle
 * provider. This module re-validates EVERYTHING — params, permissions, tier
 * grants — regardless of what the caller did.
 *
 * One caller (freedom-core design 0011, PRQ-8): main's page dispatcher
 * (src/main/page/page-radicle.js), which runs a page's request under the
 * key main attested from the sending frame and shows its prompts itself
 * (`executeRadicleForPage`). The chrome's route, which named the origin it
 * derived from the tab's display URL, is gone (PRQ-8c): no Radicle method
 * runs for a site the chrome names.
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
 * Signed writes (the COB methods) each need the user's approval: main's
 * per-write prompt, or the site's "always allow writes" rule
 * (autoApprove.signing), which this module rate-limits per origin. See
 * SIGNED_WRITE_METHODS below. Each runs under the page's guard, just before
 * the add-on signs and writes it (`page.effect`).
 *
 * Seeding is honest about replication: radicle_seed writes the policy and
 * kicks off a background fetch, returning immediately with an initial
 * status. Progress is pushed through the provider's `seedStatus` event,
 * which main's page requests send to every live document of the site's key
 * (setSeedStatusSink, PRQ-8b);
 * radicle_getSeedStatus remains the snapshot/reload path, and radicle_sync
 * restarts the fetch (the retry path) for repos that are already seeded —
 * it can never start seeding a new one. See seed-status.js.
 *
 * Errors: a page never gets the Radicle add-on's own error text, which can
 * name the user's Radicle storage on disk. Each add-on failure is answered
 * with a fixed text for its category (ADDON_ERROR_TEXTS below), and the
 * add-on's text goes to the log only, through redactForLog (#1073).
 */

const { ipcMain } = require('electron');
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
  radicleWriteRefusal,
  STATUS,
} = require('../radicle-manager');
const cob = require('./cob-service');
const permissions = require('./radicle-permissions');
const { createAutoWriteLimiter } = require('./auto-write-limiter');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { redactForLog } = require('../private/private-log-context');

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
// consent prompt for `radicle_seed`/`radicle_unseed` is main's page
// dispatcher's (`radicle.node`, src/main/page/page-radicle.js, PRQ-8b):
// both are recorded here as needing the connection grant, and each runs
// under the dispatcher's guard after its prompt or the site's node rule.
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
// Each needs the user's approval for that write ('user': main showed the
// per-write prompt), or the site's "always allow writes" rule, whose
// writes autoWriteLimiter counts. Anything else is automatic, and is
// refused unless the rule exists and the limit admits it (R-6).
const SIGNED_WRITE_METHODS = new Set([
  'radicle_createIssue',
  'radicle_commentIssue',
  'radicle_editIssueState',
  'radicle_commentPatch',
]);
const autoWriteLimiter = createAutoWriteLimiter();
const PUSH_METHODS = new Set(['radicle_seed', 'radicle_sync', 'radicle_getSeedStatus']);
// The node actions a page's request runs under main's guard (PRQ-8b).
const NODE_ACTIONS = new Set(['radicle_seed', 'radicle_unseed', 'radicle_sync']);
// Everything a page's request runs under main's guard: the node actions,
// and the signed writes (PRQ-8c).
const GUARDED_METHODS = new Set([...NODE_ACTIONS, ...SIGNED_WRITE_METHODS]);
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

// Where a site's seed statuses go (freedom-core design 0011, "Events";
// PRQ-8b): main's page requests (src/main/page/page-radicle.js), which send
// each to every live document of the site's key. Before, they went to every
// chrome window, which relayed them to the key's webviews.
let seedStatusSink = null;

/** Main's page requests take the sites' seed statuses (`(origin, status)`). */
function setSeedStatusSink(sink) {
  seedStatusSink = typeof sink === 'function' ? sink : null;
}

function getSeedStatusBroadcaster(origin) {
  let broadcast = seedStatusBroadcasters.get(origin);
  if (broadcast) return broadcast;
  // A sink that throws is logged by the tracker, as a window's send was.
  broadcast = (data) => {
    seedStatusSink?.(origin, publicSeedStatus(data));
  };
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
// Method handlers. Origin is the page's key, main's attested one;
// permission checks against it have already been re-done in
// executeRadicleMethod.

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

/**
 * A page's node action runs under main's guard (`page.effect`, from
 * src/main/page/page-radicle.js): the guard's checks and the action in one
 * run, or a refusal (thrown) with nothing done. Any other caller runs it.
 */
async function guarded(effect, run) {
  if (typeof effect !== 'function') return run();
  const outcome = await effect(run);
  if (outcome?.refused) throw outcome.refused;
  return outcome?.value;
}

async function handleSeed(origin, params, onSeedStatus, effect) {
  const rid = requireRidParam(params);
  const result = await guarded(effect, () =>
    onSeedStatus ? seedRepository(rid, onSeedStatus) : seedRepository(rid)
  );
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

async function handleUnseed(origin, params, effect) {
  const rid = requireRidParam(params);
  const result = await guarded(effect, () => unseedRepository(rid));
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

async function handleSync(origin, params, onSeedStatus, effect) {
  const rid = requireRidParam(params);
  // Non-blocking: (re)start the background fetch and report where it
  // stands. Subsequent transitions are emitted as `seedStatus` events. A
  // page's fetch starts under main's guard, after the manager's own wait
  // (the seeding policy's read): the guard owns the node action.
  let refusal = null;
  const guard = async (start) => {
    const outcome = await effect(start);
    if (outcome?.refused) {
      refusal = outcome.refused;
      return null;
    }
    return outcome?.value;
  };
  let result;
  if (typeof effect === 'function') result = await refetchRepository(rid, onSeedStatus, { guard });
  else if (onSeedStatus) result = await refetchRepository(rid, onSeedStatus);
  else result = await refetchRepository(rid);
  if (refusal) throw refusal;
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
  if (err instanceof cob.CobAdmissionError) {
    return providerError(ERRORS.UNAVAILABLE, err.message, { reason: err.reason });
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

/**
 * A COB call. A page's signed write runs under main's guard (`effect`):
 * cob-service validates it, then the guard checks the page again and the
 * add-on signs and writes in the same run; a refusal (thrown) writes
 * nothing.
 */
async function handleCobWrite(method, fn, params, effect) {
  let refusal = null;
  const guard =
    typeof effect === 'function'
      ? async (write) => {
        const outcome = await effect(write);
        if (outcome?.refused) {
          refusal = outcome.refused;
          return null;
        }
        return outcome?.value;
      }
      : undefined;
  let result;
  try {
    result = await fn(params, guard);
  } catch (err) {
    throw err.code ? err : wrapCobError(method, err);
  }
  if (refusal) throw refusal;
  return result;
}

// A cob-service write, with the page's guard when there is one.
const cobWrite = (write) => (p, guard) => (guard ? write(p, { guard }) : write(p));

// ---------------------------------------------------------------------------

/**
 * Execute a provider method with full re-validation. Main's dispatcher
 * has already run consent UX; this is the authority layer.
 * @param {string} method
 * @param {object} params
 * @param {string} origin - the page's key, main's attested one
 * @param {{onSeedStatus?: Function, approval?: string, page?: {effect?: Function}}} [options]
 *   approval: 'user' when the user approved this signed write on its
 *   prompt; page.effect: the guard a node action or signed write runs under.
 *   A private window never reaches this (main's attestation refuses one).
 */
async function executeRadicleMethod(
  method,
  params = {},
  origin,
  { onSeedStatus, approval, page = null } = {}
) {
  // A page's node action (PRQ-8b) or signed write (PRQ-8c), from main's
  // dispatcher: its guard checks the page again just before the effect,
  // records the site's use in that run, and runs the effect.
  const effect = GUARDED_METHODS.has(method) && typeof page?.effect === 'function' ? page.effect : null;
  if (!KNOWN_METHODS.has(method)) {
    throw providerError(ERRORS.UNSUPPORTED_METHOD, `Unknown method: ${method}`);
  }
  if (!origin || typeof origin !== 'string') {
    throw providerError(ERRORS.UNAUTHORIZED, 'Missing origin');
  }
  if (isDisabledForProfile()) {
    throw providerError(ERRORS.UNAVAILABLE, 'Radicle is disabled for this profile', {
      reason: 'profile-disabled',
    });
  }

  const tier = METHOD_TIERS[method];
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
    // Under the service, a node running with a throwaway key can't publish
    // (freedom-core design 0008, `needs_vault`): refused before the rule's
    // rate limit counts it, and before anything is sent. cob-service checks
    // again just before the write.
    const writeRefusal = SIGNED_WRITE_METHODS.has(method) ? radicleWriteRefusal() : null;
    if (writeRefusal) {
      throw providerError(ERRORS.UNAVAILABLE, writeRefusal.message, {
        reason: writeRefusal.reason,
      });
    }
    if (SIGNED_WRITE_METHODS.has(method) && approval !== 'user') {
      if (!permissions.getAutoApprove(origin, 'signing')) {
        throw providerError(ERRORS.UNAUTHORIZED, 'This write needs the user\'s approval', {
          reason: 'approval_required',
        });
      }
      if (!autoWriteLimiter.admit(normalizeOrigin(origin))) {
        throw providerError(
          ERRORS.UNAUTHORIZED,
          'This site has used up its automatic writes for now; this one needs the user\'s approval',
          { reason: 'auto_write_limit' }
        );
      }
    }
    // A page's guarded effect records it in its guard's run.
    if (!effect) permissions.updateLastUsed(origin);
  }

  switch (method) {
    case 'radicle_requestAccess':
      // Reaching here means the permission record exists (tier check above);
      // main granted it on its connection prompt before running it.
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
      return handleSeed(origin, params, onSeedStatus, effect);
    case 'radicle_unseed':
      return handleUnseed(origin, params, effect);
    case 'radicle_sync':
      return handleSync(origin, params, onSeedStatus, effect);
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
      return handleCobWrite(method, cobWrite(cob.createIssue), params, effect);
    case 'radicle_commentIssue':
      return handleCobWrite(method, cobWrite(cob.commentIssue), params, effect);
    case 'radicle_editIssueState':
      return handleCobWrite(method, cobWrite(cob.editIssueState), params, effect);
    case 'radicle_commentPatch':
      return handleCobWrite(method, cobWrite(cob.commentPatch), params, effect);
    /* istanbul ignore next -- KNOWN_METHODS guard makes this unreachable */
    default:
      throw providerError(ERRORS.UNSUPPORTED_METHOD, `Unknown method: ${method}`);
  }
}

/**
 * A failure as a page gets it: a provider error as it is, and anything else
 * (an add-on, io or other failure) as its category's fixed text, never its
 * own (#1073), which goes to the log only.
 */
function answerError(method, err) {
  if (err && typeof err.code === 'number') return err;
  const message = typeof err?.message === 'string' ? err.message : String(err);
  log.error(`[radicle-provider] ${method} failed:`, redactForLog(message));
  return {
    ...ERRORS.INTERNAL,
    message: publicAddonText(message, ERRORS.INTERNAL.message),
  };
}

/**
 * Run a method for main's page dispatcher (src/main/page/page-radicle.js),
 * under the requester's attested key: `{ result }`, or `{ error }` as a page
 * gets it. A page's request never comes from a private window (main's
 * attestation refuses one), so its use is recorded.
 */
async function executeRadicleForPage(method, params, key, options = {}) {
  // A site's seed statuses go to main's page requests (setSeedStatusSink).
  const hadBroadcaster = seedStatusBroadcasters.has(key);
  const onSeedStatus = PUSH_METHODS.has(method) && typeof key === 'string' && key ? getSeedStatusBroadcaster(key) : undefined;
  try {
    return { result: await executeRadicleMethod(method, params, key, { ...options, onSeedStatus }) };
  } catch (err) {
    if (onSeedStatus && !hadBroadcaster) removeSeedStatusBroadcaster(key);
    return { error: answerError(method, err) };
  }
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

  // No `radicle:provider-execute` (freedom-core design 0011, PRQ-8c): every
  // window.radicle method is main's, from the page's own request.
  log.info('[radicle-provider] IPC handlers registered');
}

module.exports = {
  executeRadicleMethod,
  executeRadicleForPage,
  setSeedStatusSink,
  registerRadicleProviderIpc,
  _resetAutoWriteLimiter: () => autoWriteLimiter.reset(),
};
