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
 * Seeding is honest about replication: radicle_seed writes the policy and
 * kicks off a background fetch, returning immediately with an initial
 * status. Progress is polled via radicle_getSeedStatus; radicle_sync
 * restarts the fetch (the retry path). See seed-status.js.
 */

const { ipcMain } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { loadSettings } = require('../settings-store');
const { getRadicleApiUrl } = require('../service-registry');
const {
  getCurrentStatus,
  getConnections,
  seedRepository,
  unseedRepository,
  getSeedFetchStatus,
  refetchRepository,
  validateAndNormalizeRid,
  getNodeAlias,
  setNodeAlias,
  STATUS,
} = require('../radicle-manager');
const cob = require('./cob-service');
const permissions = require('./radicle-permissions');

const SPEC_VERSION = '0.1';

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

// method -> required tier
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

// Methods that report or change grant/node state rather than requiring a
// running node — a dApp must be able to connect (and disconnect) while
// the node is down.
const WORKS_WHILE_STOPPED = new Set([
  'radicle_getNodeStatus',
  'radicle_requestAccess',
  'radicle_disconnect',
]);

function integrationEnabled() {
  return loadSettings().enableRadicleIntegration === true;
}

function nodeRunning() {
  return getCurrentStatus().status === STATUS.RUNNING;
}

function unavailableReason(origin) {
  if (!integrationEnabled()) return 'integration-disabled';
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
      log.warn(`[radicle-provider] getNodeStatus identity lookup failed: ${err.message}`);
    }
  }
  return result;
}

async function handleListSeededRepos() {
  // The local httpd's repo listing is the cheapest structured source.
  const apiUrl = getRadicleApiUrl();
  if (!apiUrl) throw providerError(ERRORS.UNAVAILABLE, 'Radicle node is not ready');
  let res;
  try {
    res = await fetch(`${apiUrl}/api/v1/repos?show=all&perPage=500`);
  } catch {
    throw providerError(ERRORS.UNAVAILABLE, 'Radicle httpd unreachable');
  }
  if (!res.ok) throw providerError(ERRORS.INTERNAL, `repo listing failed (${res.status})`);
  const repos = await res.json();
  return repos.map((repo) => {
    const project = repo?.payloads?.['xyz.radicle.project']?.data ?? {};
    return {
      rid: repo.rid,
      name: project.name ?? repo.rid,
      description: project.description ?? '',
    };
  });
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

async function handleSeed(origin, params) {
  const rid = requireRidParam(params);
  const result = await seedRepository(rid);
  if (!result.success) {
    throw providerError(ERRORS.INTERNAL, result.error?.message || 'seed failed', {
      reason: 'seed_failed',
    });
  }
  return { rid, seeded: true, status: result.status };
}

async function handleUnseed(origin, params) {
  const rid = requireRidParam(params);
  const result = await unseedRepository(rid);
  if (!result.success) {
    throw providerError(ERRORS.INTERNAL, result.error?.message || 'unseed failed', {
      reason: 'unseed_failed',
    });
  }
  return { rid, seeded: false };
}

async function handleSync(origin, params) {
  const rid = requireRidParam(params);
  // Non-blocking: (re)start the background fetch and report where it
  // stands. The dApp polls radicle_getSeedStatus for the outcome.
  const result = refetchRepository(rid);
  if (!result.success) {
    throw providerError(ERRORS.INTERNAL, result.error?.message || 'sync failed', {
      reason: 'sync_failed',
    });
  }
  return { rid, status: result.status };
}

async function handleGetSeedStatus(origin, params) {
  const rid = requireRidParam(params);
  const result = getSeedFetchStatus(rid);
  if (!result.success) {
    throw providerError(ERRORS.INTERNAL, result.error?.message || 'status unavailable', {
      reason: 'status_failed',
    });
  }
  return result.status; // includes rid
}

/** Translate cob-service errors into provider errors. */
function wrapCobError(err) {
  if (err instanceof cob.CobValidationError) {
    return providerError(ERRORS.INVALID_PARAMS, err.message, { reason: err.reason });
  }
  return providerError(ERRORS.INTERNAL, err.message, err.reason ? { reason: err.reason } : null);
}

async function handleCobWrite(fn, params) {
  try {
    return await fn(params);
  } catch (err) {
    throw err.code ? err : wrapCobError(err);
  }
}

// ---------------------------------------------------------------------------

/**
 * Execute a provider method with full re-validation. The renderer has
 * already run consent UX; this is the authority layer.
 * @param {string} method
 * @param {object} params
 * @param {string} origin - display-URL-derived origin from the renderer
 */
async function executeRadicleMethod(method, params = {}, origin) {
  if (!KNOWN_METHODS.has(method)) {
    throw providerError(ERRORS.UNSUPPORTED_METHOD, `Unknown method: ${method}`);
  }
  if (!origin || typeof origin !== 'string') {
    throw providerError(ERRORS.UNAUTHORIZED, 'Missing origin');
  }
  if (!integrationEnabled()) {
    throw providerError(ERRORS.UNAVAILABLE, 'Radicle integration is disabled', {
      reason: 'integration-disabled',
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
    permissions.updateLastUsed(origin);
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
      return handleSeed(origin, params);
    case 'radicle_unseed':
      return handleUnseed(origin, params);
    case 'radicle_sync':
      return handleSync(origin, params);
    case 'radicle_getSeedStatus':
      return handleGetSeedStatus(origin, params);
    case 'radicle_disconnect':
      // An origin may relinquish its own grant (connection AND signing) —
      // the inverse of requestAccess, no consent needed.
      permissions.revokePermission(origin);
      return { connected: false };
    case 'radicle_getIdentity':
      return handleCobWrite(() => cob.getIdentity(), params);
    case 'radicle_createIssue':
      return handleCobWrite((p) => cob.createIssue(p), params);
    case 'radicle_commentIssue':
      return handleCobWrite((p) => cob.commentIssue(p), params);
    case 'radicle_editIssueState':
      return handleCobWrite((p) => cob.editIssueState(p), params);
    case 'radicle_commentPatch':
      return handleCobWrite((p) => cob.commentPatch(p), params);
    /* istanbul ignore next -- KNOWN_METHODS guard makes this unreachable */
    default:
      throw providerError(ERRORS.UNSUPPORTED_METHOD, `Unknown method: ${method}`);
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

  ipcMain.handle(IPC.RADICLE_PROVIDER_EXECUTE, async (_event, { method, params, origin } = {}) => {
    try {
      const result = await executeRadicleMethod(method, params, origin);
      return { result };
    } catch (err) {
      if (err && typeof err.code === 'number') {
        return { error: err };
      }
      log.error(`[radicle-provider] ${method} failed: ${err?.message || err}`);
      return { error: { ...ERRORS.INTERNAL, message: err?.message || 'Internal error' } };
    }
  });
  log.info('[radicle-provider] IPC handler registered');
}

module.exports = {
  executeRadicleMethod,
  registerRadicleProviderIpc,
};
