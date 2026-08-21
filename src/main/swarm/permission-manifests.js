/**
 * Main-process authority for bzz-hosted Swarm permission manifests.
 *
 * The renderer receives only display data and an opaque, short-lived token.
 * Manifest bytes, persisted decisions, grant projection, and pruning stay here.
 */

const { app, ipcMain } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { handleBzzRequest } = require('./bzz-protocol');
const permissions = require('./swarm-permissions');
const feeds = require('./feed-store');
const { withOriginLock } = require('./origin-mutation-lock');

const STORE_FILE = 'swarm-manifest-grants.json';
const MAX_BYTES = 8 * 1024;
// The per-attempt fetch timeout in `bzz-protocol.js` is cleared the moment
// response headers arrive, so nothing bounds the body after that: a gateway
// that answers 200 and then stalls half-open would keep this read pending
// until undici's ~5 min default body timeout, and every non-public swarm
// method for the origin queues behind the cached check promise. Each read
// gets its own inactivity deadline — a slow-but-steady body keeps going, a
// stalled one is aborted and classified transient, like any dropped socket.
const BODY_IDLE_TIMEOUT_MS = 15_000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_RECEIPTS = 20;
const UNRESOLVED_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000];
const CAPABILITY_KEYS = ['publish', 'feeds', 'signing', 'messaging'];
const CAPABILITY_META = {
  publish: { label: 'Publish content', detail: 'Use your postage stamps and bandwidth.' },
  feeds: { label: 'Manage feeds', detail: 'Create and update app feeds without repeated approval.' },
  signing: { label: 'Sign Swarm content', detail: 'Use an app-scoped publisher identity.' },
  messaging: { label: 'Send and receive messages', detail: 'Use PSS and GSOC messaging.' },
};
const PROJECTIONS = {
  publish: ['connection', 'autoApprove.publish'],
  feeds: ['connection', 'identity', 'feedGrant', 'autoApprove.feeds'],
  signing: ['connection', 'identity', 'feedGrant', 'autoApprove.signing'],
  messaging: ['connection', 'messagingGrant', 'autoApprove.messaging'],
};

let storeCache = null;
let storeLoadedFromBackup = false;
let faultInjector = null;
const tokens = new Map();
const completedTokens = new Map();
const unresolvedBackoff = new Map();

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function emptyStore() {
  return { version: 1, records: {} };
}

function loadStore() {
  if (storeCache) return storeCache;
  const filePath = getStorePath();
  if (!fs.existsSync(filePath)) {
    storeCache = emptyStore();
    return storeCache;
  }
  try {
    storeCache = { ...emptyStore(), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (err) {
    const backupPath = `${filePath}.bak`;
    try {
      storeCache = { ...emptyStore(), ...JSON.parse(fs.readFileSync(backupPath, 'utf8')) };
      storeLoadedFromBackup = true;
      console.warn('[PermissionManifests] Recovered state from backup:', err.message);
    } catch {
      console.error('[PermissionManifests] Failed to load state:', err);
      throw err;
    }
  }
  return storeCache;
}

function saveStore() {
  const filePath = getStorePath();
  const tempPath = `${filePath}.tmp`;
  try {
    if (!storeLoadedFromBackup && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    }
    fs.writeFileSync(tempPath, JSON.stringify(storeCache, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    storeLoadedFromBackup = false;
  } catch (err) {
    storeCache = null;
    throw err;
  }
}

function hasUnsafeText(value, maxLength) {
  if (typeof value !== 'string' || Array.from(value).length > maxLength) return true;
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function validateManifest(value) {
  assertExactKeys(value, ['schema', 'name', 'description', 'capabilities'], 'manifest');
  if (value.schema !== 'freedom-manifest/1') throw new Error('unsupported manifest schema');
  if (hasUnsafeText(value.name, 32) || value.name.trim() === '') throw new Error('invalid manifest name');
  if (value.description !== undefined && hasUnsafeText(value.description, 160)) throw new Error('invalid manifest description');
  assertExactKeys(value.capabilities, ['swarm'], 'capabilities');
  assertExactKeys(value.capabilities.swarm, CAPABILITY_KEYS, 'capabilities.swarm');
  if (Object.keys(value.capabilities.swarm).length === 0) throw new Error('capabilities.swarm must not be empty');

  const capabilities = {};
  for (const key of CAPABILITY_KEYS) {
    const row = value.capabilities.swarm[key];
    if (row === undefined) continue;
    assertExactKeys(row, ['why'], `capability ${key}`);
    if (hasUnsafeText(row.why, 140) || row.why.trim() === '') throw new Error(`invalid reason for ${key}`);
    capabilities[key] = { why: row.why };
  }
  return {
    schema: value.schema,
    name: value.name,
    description: value.description || '',
    capabilities,
  };
}

// A body that starts arriving and then dies — bee restart, dropped socket — is
// a transport failure, indistinguishable in outcome from one that never got
// past the request. It must feed the `unresolved` backoff like any other
// transient hiccup, never the `invalid` path that prunes the origin's
// manifest-managed authority. Only bytes we actually hold and cannot accept
// (oversized, non-JSON, schema-violating) are `invalid`.
function transportError(err) {
  const wrapped = new Error(err?.message || String(err));
  wrapped.transport = true;
  return wrapped;
}

// Resolves with `promise`, or rejects once `timeoutMs` passes with no answer.
// Applied per read, so the deadline is an inactivity one: every chunk that
// arrives restarts it.
function withIdleDeadline(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('manifest body read stalled')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readLimitedBody(response, idleTimeoutMs = BODY_IDLE_TIMEOUT_MS) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    let buffer;
    try {
      buffer = Buffer.from(await withIdleDeadline(response.arrayBuffer(), idleTimeoutMs));
    }
    catch (err) {
      throw transportError(err);
    }
    if (buffer.length > MAX_BYTES) throw new Error('manifest exceeds 8 KiB');
    return buffer;
  }
  const chunks = [];
  let length = 0;
  while (true) {
    let chunk;
    try {
      chunk = await withIdleDeadline(reader.read(), idleTimeoutMs);
    }
    catch (err) {
      await reader.cancel().catch(() => {});
      throw transportError(err);
    }
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('manifest exceeds 8 KiB');
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks);
}

async function readLimitedJson(response) {
  const raw = await readLimitedBody(response);
  return { raw, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) };
}

// Semantic fingerprint: schema plus sorted capability keys, per
// research/permission-manifest-design.md §6.1. It deliberately excludes the
// `why` texts — a wording-only redeploy must not re-ask for authority the
// user already granted. Receipt provenance is kept honest instead by binding
// each consent token to the `rawHash` of the bytes its sheet was built from
// (see `checkManifest`/`decideManifest`), so a receipt never pairs the
// wording one manifest showed with the hash of another.
function fingerprint(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify({
    schema: manifest.schema,
    capabilities: Object.keys(manifest.capabilities).sort(),
  })).digest('hex');
}

async function discover(committedUrl, fetchManifest = handleBzzRequest) {
  let url;
  try {
    url = new URL(committedUrl);
  } catch {
    return { status: 'unsupported' };
  }
  if (url.protocol !== 'bzz:') return { status: 'unsupported' };

  const manifestUrl = `bzz://${url.host}/freedom-manifest.json`;
  let response;
  try {
    response = await fetchManifest(new Request(manifestUrl));
  } catch (err) {
    return { status: 'unresolved', error: err.message };
  }
  if (response.status === 404) return { status: 'absent' };
  if (!response.ok) return { status: response.status >= 400 && response.status < 500 ? 'invalid' : 'unresolved' };
  try {
    const { raw, value } = await readLimitedJson(response);
    const manifest = validateManifest(value);
    return {
      status: 'found',
      manifest,
      rawHash: crypto.createHash('sha256').update(raw).digest('hex'),
      fingerprint: fingerprint(manifest),
    };
  } catch (err) {
    return { status: err.transport ? 'unresolved' : 'invalid', error: err.message };
  }
}

function currentProjectionValue(origin, key) {
  if (key === 'connection') return !!permissions.getPermission(origin);
  if (key === 'feedGrant') return feeds.hasFeedGrant(origin);
  if (key === 'identity') return feeds.hasIdentityMode(origin);
  if (key === 'messagingGrant') return permissions.hasMessagingGrant(origin);
  if (key.startsWith('autoApprove.')) return permissions.getAutoApprove(origin, key.slice(12));
  return false;
}

function applyProjectionValue(origin, key, enabled) {
  if (key === 'connection') {
    if (enabled && !permissions.getPermission(origin)) permissions.grantPermission(origin);
    if (!enabled) permissions.revokePermission(origin, { source: 'manifest' });
  } else if (key === 'feedGrant') {
    // `source: 'manifest'` keeps these projections out of the feed store's
    // user-mutation notifications — a manifest applying its own grant must
    // not detach the ownership it is establishing.
    if (enabled) feeds.grantFeedAccess(origin, { source: 'manifest' });
    else feeds.revokeFeedAccess(origin, { source: 'manifest' });
  } else if (key === 'identity') {
    if (enabled && !feeds.hasIdentityMode(origin)) {
      feeds.createAppScopedIdentity(origin, { activate: true, source: 'manifest' });
    }
  } else if (key === 'messagingGrant') {
    if (enabled) permissions.grantMessaging(origin, { source: 'manifest' });
    else permissions.revokeMessaging(origin, { source: 'manifest' });
  } else if (key.startsWith('autoApprove.')) {
    permissions.setAutoApprove(origin, key.slice(12), enabled, { source: 'manifest' });
  }
}

function removeOwners(record, capabilities) {
  const operations = [];
  record.managed ||= {};
  for (const [projection, owners] of Object.entries(record.managed)) {
    const remaining = owners.filter((owner) => !capabilities.includes(owner));
    if (remaining.length === 0) {
      if (projection !== 'identity') operations.push({ projection, enabled: false });
      delete record.managed[projection];
    } else {
      record.managed[projection] = remaining;
    }
  }
  return operations.sort((left, right) => Number(left.projection === 'connection') - Number(right.projection === 'connection'));
}

function addManagedCapability(origin, record, capability) {
  const operations = [];
  record.managed ||= {};
  for (const projection of PROJECTIONS[capability]) {
    if (record.detached?.[projection]) continue;
    const owners = record.managed[projection] || [];
    if (owners.length > 0) {
      if (!owners.includes(capability)) record.managed[projection] = [...owners, capability];
      continue;
    }
    if (!currentProjectionValue(origin, projection)) {
      record.managed[projection] = [capability];
      operations.push({ projection, enabled: true });
    }
  }
  return operations;
}

function runTransaction(origin, record, operations) {
  const state = loadStore();
  state.pending = { origin, record, operations };
  saveStore();
  faultInjector?.('after-journal');
  for (const [index, operation] of operations.entries()) {
    applyProjectionValue(origin, operation.projection, operation.enabled);
    faultInjector?.(`after-operation:${index}:${operation.projection}`);
  }
  if (record) state.records[origin] = record;
  else delete state.records[origin];
  delete state.pending;
  faultInjector?.('before-commit');
  saveStore();
}

function recoverPending() {
  const state = loadStore();
  if (!state.pending) return;
  const { origin, record, operations } = state.pending;
  for (const operation of operations) applyProjectionValue(origin, operation.projection, operation.enabled);
  if (record) state.records[origin] = record;
  else delete state.records[origin];
  delete state.pending;
  saveStore();
}

function pruneRecord(origin) {
  const state = loadStore();
  const record = state.records[origin];
  if (!record) return;
  const operations = removeOwners(record, CAPABILITY_KEYS);
  runTransaction(origin, null, operations);
}

function detachManaged(origin, projection) {
  recoverPending();
  const key = normalizeOrigin(origin);
  if (projection === 'connection') {
    disconnect(key);
    return;
  }
  const state = loadStore();
  const record = state.records[key];
  if (!record) return;
  record.detached ||= {};
  record.detached[projection] = true;
  if (record.managed) delete record.managed[projection];
  record.revision = (record.revision || 0) + 1;
  runTransaction(key, record, []);
}

// `firstContact` is deliberately not compared: the first check of a fresh
// origin persists its observation, so a sibling tab checking a moment later
// sees a record and computes `false`. The outstanding token's value is the
// truthful one — the record it sees exists only because of that check — and
// keeping it is what still drops the observation on a denial.
function sameConsent(left, right) {
  return left.origin === right.origin
    && left.fingerprint === right.fingerprint
    && left.baseRevision === right.baseRevision
    && left.changed.length === right.changed.length
    && left.changed.every((capability, index) => capability === right.changed[index]);
}

/**
 * Two tabs of the same app check concurrently, see identical state, and would
 * otherwise each mint their own token off the same baseRevision. The user then
 * answers two identical sheets, and the second decision fails the revision
 * guard because the first one bumped the revision. One outstanding consent per
 * (origin, manifest, state) instead: the second decide() replays the recorded
 * result, and the renderer coalesces the duplicate sheet on the shared token.
 */
function outstandingToken(candidate) {
  const now = Date.now();
  let match = null;
  for (const [token, pending] of tokens) {
    if (pending.expiresAt < now) {
      tokens.delete(token);
      continue;
    }
    if (!match && sameConsent(pending, candidate)) match = token;
  }
  return match;
}

function buildConsentModel(origin, record, manifest, changed, removed) {
  return {
    origin,
    name: manifest.name,
    description: manifest.description,
    changed: changed.map((key) => ({ key, ...CAPABILITY_META[key], why: manifest.capabilities[key].why })),
    removed: removed.map((key) => ({ key, label: CAPABILITY_META[key].label })),
    createsIdentity: changed.some((key) => ['feeds', 'signing'].includes(key)) && !feeds.hasIdentityMode(origin),
    preservedIdentity: changed.some((key) => ['feeds', 'signing'].includes(key)) && feeds.hasIdentityMode(origin),
    isUpdate: !!record,
  };
}

async function checkManifest({ origin, committedUrl, eager = false }, deps = {}) {
  recoverPending();
  const key = normalizeOrigin(origin);
  const state = loadStore();
  const existing = state.records[key];
  const firstContact = !existing && !permissions.getPermission(key);
  if (!existing && !eager) return { kind: 'legacy' };

  const backoff = unresolvedBackoff.get(key);
  if (backoff && Date.now() < backoff.retryAt) {
    return existing
      ? { kind: 'unresolved', retryAt: backoff.retryAt }
      : { kind: 'legacy', reason: 'unresolved-backoff', retryAt: backoff.retryAt };
  }

  const found = await discover(committedUrl, deps.fetchManifest);
  if (found.status === 'unresolved') {
    const failures = (backoff?.failures || 0) + 1;
    const delay = UNRESOLVED_BACKOFF_MS[Math.min(failures - 1, UNRESOLVED_BACKOFF_MS.length - 1)];
    const retryAt = Date.now() + delay;
    unresolvedBackoff.set(key, { failures, retryAt });
    return existing ? { kind: 'unresolved', retryAt } : { kind: 'legacy', reason: 'unresolved', retryAt };
  }
  unresolvedBackoff.delete(key);
  // Defense-in-depth: bail before any prune if the origin and committedUrl
  // don't agree, so origin A's record can never be pruned on origin B's
  // manifest state. (Unreachable from today's renderer — both derive from the
  // same displayUrl — but cheap to enforce here.)
  if (normalizeOrigin(committedUrl) !== key) return { kind: 'legacy' };
  if (found.status !== 'found') {
    if (existing) pruneRecord(key);
    return { kind: 'legacy', pruned: !!existing, reason: found.status };
  }

  const manifest = found.manifest;
  const nextKeys = Object.keys(manifest.capabilities);
  const acknowledged = existing?.acknowledged || {};
  const removed = Object.keys(acknowledged).filter((capability) => !nextKeys.includes(capability));
  const additions = nextKeys.filter((capability) => !acknowledged[capability]);

  const record = structuredClone(existing || { managed: {}, acknowledged: {} });
  const removalOperations = removeOwners(record, removed);
  for (const capability of removed) delete record.acknowledged[capability];
  record.observed = { fingerprint: found.fingerprint, rawHash: found.rawHash, capabilities: manifest.capabilities, checkedAt: Date.now() };
  record.app = { name: manifest.name, description: manifest.description };
  const satisfied = additions.filter((capability) => (
    PROJECTIONS[capability].every((projection) => currentProjectionValue(key, projection))
  ));
  for (const capability of satisfied) {
    record.acknowledged[capability] = {
      decision: 'individual',
      source: 'existing-grant',
      decidedAt: Date.now(),
    };
  }
  const changed = additions.filter((capability) => !satisfied.includes(capability));
  record.revision = existing?.revision || 0;
  if (removalOperations.length > 0 || removed.length > 0 || satisfied.length > 0) {
    record.revision += 1;
    runTransaction(key, record, removalOperations);
  }
  else {
    // `state` was read before the discover() await. `saveStore()` serializes
    // whatever `storeCache` is *now* — a concurrent operation on another
    // origin that failed its save meanwhile has nulled it — so re-read the
    // store and mutate that, exactly as `runTransaction` does.
    const current = loadStore();
    current.records[key] = record;
    saveStore();
  }

  if (changed.length === 0) return { kind: 'ready' };
  const pending = {
    origin: key,
    manifest,
    fingerprint: found.fingerprint,
    // The bytes this sheet's wording came from. `record.observed.rawHash` can
    // move under an outstanding token (a wording-only redeploy re-checked by
    // another tab updates it without bumping the revision), so the receipt
    // must attest this hash, not the latest one.
    rawHash: found.rawHash,
    baseRevision: record.revision,
    firstContact,
    changed,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  let token = outstandingToken(pending);
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    tokens.set(token, pending);
  } else {
    // A fresh tab just coalesced onto this consent — extend the window so the
    // shared token doesn't expire on the earliest requester's clock (a sheet
    // reused 4.5 min into a 5 min TTL would otherwise die 30 s later).
    tokens.get(token).expiresAt = pending.expiresAt;
  }
  return { kind: 'consent', token, model: buildConsentModel(key, existing, manifest, changed, removed) };
}

function decideManifest(token, outcome) {
  recoverPending();
  if (completedTokens.has(token)) return completedTokens.get(token);
  const pending = tokens.get(token);
  if (!pending || pending.expiresAt < Date.now()) throw new Error('Manifest consent expired');
  if (!['allow', 'individual', 'deny'].includes(outcome)) throw new Error('Invalid manifest decision');

  const state = loadStore();
  if (state.records[pending.origin]?.observed?.fingerprint !== pending.fingerprint) {
    tokens.delete(token);
    throw new Error('Manifest consent is stale');
  }
  if ((state.records[pending.origin]?.revision || 0) !== pending.baseRevision) {
    tokens.delete(token);
    throw new Error('Manifest consent is stale');
  }
  const record = structuredClone(state.records[pending.origin] || { managed: {}, acknowledged: {} });
  const operations = [];
  if (outcome !== 'deny') {
    if (outcome === 'individual') {
      record.detached ||= {};
      record.detached.connection = true;
      delete record.managed?.connection;
      // Journaled like every other mutation in this flow rather than applied
      // ahead of `runTransaction`: a crash between the grant and the journal
      // would otherwise leave the origin connected with no record, receipt or
      // acknowledgement, and nothing for `recoverPending` to replay.
      if (!permissions.getPermission(pending.origin)) {
        operations.push({ projection: 'connection', enabled: true });
      }
    }
    for (const capability of pending.changed) {
      record.acknowledged[capability] = {
        decision: outcome === 'allow' ? 'managed' : 'individual',
        source: 'sheet',
        whyShown: pending.manifest.capabilities[capability].why,
        decidedAt: Date.now(),
      };
      if (outcome === 'allow') operations.push(...addManagedCapability(pending.origin, record, capability));
      else operations.push(...removeOwners(record, [capability]));
    }
    record.receipts ||= [];
    record.receipts.push({
      decidedAt: Date.now(),
      outcome: outcome === 'allow' ? 'managed' : 'individual',
      originShown: pending.origin,
      manifestNameShown: pending.manifest.name,
      manifestDescriptionShown: pending.manifest.description,
      rows: pending.changed.map((capability) => ({
        capability,
        browserLabelVersion: 1,
        whyShown: pending.manifest.capabilities[capability].why,
      })),
      rawHash: pending.rawHash,
    });
    record.receipts = record.receipts.slice(-MAX_RECEIPTS);
    record.revision = pending.baseRevision + 1;
    runTransaction(pending.origin, record, operations);
  } else if (pending.firstContact) {
    runTransaction(pending.origin, null, []);
  }
  const result = { allowed: outcome !== 'deny', mode: outcome };
  tokens.delete(token);
  completedTokens.set(token, result);
  if (completedTokens.size > 100) completedTokens.delete(completedTokens.keys().next().value);
  return result;
}

function useIndividual(origin, capability) {
  recoverPending();
  if (!CAPABILITY_KEYS.includes(capability)) throw new Error('Unknown capability');
  const key = normalizeOrigin(origin);
  const record = structuredClone(getRecord(key));
  if (!record?.acknowledged?.[capability]) return false;
  record.detached ||= {};
  record.detached.connection = true;
  delete record.managed?.connection;
  const operations = removeOwners(record, [capability]);
  record.acknowledged[capability] = {
    ...record.acknowledged[capability],
    decision: 'individual',
    decidedAt: Date.now(),
  };
  record.revision = (record.revision || 0) + 1;
  runTransaction(key, record, operations);
  return true;
}

function disconnect(origin) {
  recoverPending();
  const key = normalizeOrigin(origin);
  runTransaction(key, null, [
    { projection: 'feedGrant', enabled: false },
    { projection: 'connection', enabled: false },
  ]);
  return true;
}

function getRecord(origin) {
  recoverPending();
  return loadStore().records[normalizeOrigin(origin)] || null;
}

function registerPermissionManifestIpc() {
  recoverPending();
  // Both stores that hold manifest-projected state report user mutations, so
  // a grant the user changes by hand (revoking feed access, switching the
  // publisher identity) drops manifest ownership instead of leaving a record
  // that claims it — and can re-assert it on the next projection.
  permissions.onManifestMutation(detachManaged);
  feeds.onManifestMutation(detachManaged);
  ipcMain.handle(IPC.SWARM_MANIFEST_CHECK, (_event, request) => (
    withOriginLock(request.origin, () => checkManifest(request))
  ));
  ipcMain.handle(IPC.SWARM_MANIFEST_DECIDE, (_event, { token, outcome }) => {
    const origin = tokens.get(token)?.origin || `consent-token:${token}`;
    return withOriginLock(origin, () => decideManifest(token, outcome));
  });
  ipcMain.handle(IPC.SWARM_MANIFEST_GET, (_event, origin) => (
    withOriginLock(origin, () => getRecord(origin))
  ));
  ipcMain.handle(IPC.SWARM_MANIFEST_USE_INDIVIDUAL, (_event, { origin, capability }) => (
    withOriginLock(origin, () => useIndividual(origin, capability))
  ));
  ipcMain.handle(IPC.SWARM_MANIFEST_DISCONNECT, (_event, origin) => (
    withOriginLock(origin, () => disconnect(origin))
  ));
  console.log('[PermissionManifests] IPC handlers registered');
}

function _resetForTests() {
  storeCache = null;
  storeLoadedFromBackup = false;
  tokens.clear();
  completedTokens.clear();
  unresolvedBackoff.clear();
  faultInjector = null;
}

function _setFaultInjectorForTests(injector) {
  faultInjector = injector;
}

module.exports = {
  BODY_IDLE_TIMEOUT_MS,
  validateManifest,
  discover,
  checkManifest,
  decideManifest,
  detachManaged,
  disconnect,
  getRecord,
  useIndividual,
  registerPermissionManifestIpc,
  _resetForTests,
  _setFaultInjectorForTests,
};
