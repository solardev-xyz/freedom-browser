/**
 * Main-process authority for bzz-hosted Swarm permission manifests.
 *
 * The renderer receives only display data and an opaque, short-lived token.
 * Manifest bytes, persisted decisions, grant projection, and pruning stay here.
 *
 * **Where it lives** (freedom-core design 0015, D3, D6 and D17; the SWM-6
 * to SWM-9 plan's PR 6.3 and its points 5 and 6): main's own file,
 * swarm-manifest-grants.json, unless this process's hello names
 * `swarm_stores` (core-client.js `swarmStoresNamed()`: a process on the
 * core's Swarm backend, from SWM-7's flip, PR 7.4; on `js`, no build's).
 * Then the store, its decisions and its projections onto the Swarm grants
 * are the core's `swarm.manifest`, and main never opens the file:
 * - the page path (page/page-swarm.js) runs `check`, `decide` and
 *   `release`: `checkPageManifest` makes the window checks it makes today
 *   (the window read when the check comes in, then again once the site's
 *   lock is free) and sends `check`; `decidePageManifest` reads the guard
 *   (`recheck()`, then `holds()`) just before it sends `decide` with its
 *   answer as `live`; `releasePageManifest` sends `release`;
 * - the chrome's three handlers send `get`, `use-individual` and
 *   `disconnect`, as `shell` (the core's callers), under the site's lock;
 * - every site key goes as its permission key (`normalizeOrigin`): the core
 *   keys the store by the keys main gives it, where the functions below
 *   normalize each;
 * - a check's manifest is still main's fetch: the core asks
 *   `shell.swarm_manifest { for, url }` (core/swarm-shell.js registers
 *   `answerManifestAsk`), and main fetches it on the asking window's
 *   session as `discover` does, or answers `{ failed: true }`;
 * - main's detach hooks and its journal replay are off: the core detaches
 *   a projection the user changed (D17) and replays its own journal;
 * - every function below that reads or writes the file throws, unrun
 *   (`loadStore`, `saveStore`).
 * Off (the JS backend, every packaged build until SWM-9), all of this
 * behaves as before the move.
 */

const { ipcMain } = require('electron');
const { getFreedomDataPath } = require('../freedom-root');
const crypto = require('crypto');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { handleBzzRequest } = require('./bzz-protocol');
const permissions = require('./swarm-permissions');
const feeds = require('./feed-store');
const { withOriginLock } = require('./origin-mutation-lock');
const { watchdogMs } = require('../core/core-deadlines');

const STORE_FILE = 'swarm-manifest-grants.json';
const MAX_BYTES = 8 * 1024;
// The per-attempt fetch timeout in the `bzz:` handler is cleared the moment
// response headers arrive, and its body idle bound (60 s, freedom-core design
// 0006) is far longer than this check can wait: every non-public swarm method
// for the origin queues behind the cached check promise. Each read gets its
// own, tighter inactivity deadline — a slow-but-steady body keeps going, a
// stalled one is aborted and classified transient, like any dropped socket.
const BODY_IDLE_TIMEOUT_MS = 15_000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
// Main's page consents waiting on a decision, at most (PRQ-7b): past it the
// oldest goes, and its decision fails as expired.
const MAX_PAGE_TOKENS = 64;
const MAX_RECEIPTS = 20;
const UNRESOLVED_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000];
// How long an allowed decide on the core's store waits for main's mirror to
// read the site's grant back: a grant read's own watchdog, past which the
// core is taken for hung.
const GRANT_READ_BACK_MS = watchdogMs('approval.grants');
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
// The in-process callers' consents (`checkManifest` with no owner): shared
// between their checks, and replayed once decided. The chrome's own channels
// for them (`swarm:manifest-check` / `swarm:manifest-decide`) are gone
// (freedom-core design 0011, PRQ-7d): only main checks a page's manifest.
const tokens = new Map();
const completedTokens = new Map();
// Main's own consents for a page's request (freedom-core design 0011,
// PRQ-7b; `checkPageManifest` / `decidePageManifest`): a pool of their own,
// which the chrome's channels never read, so the chrome is never handed a
// page's token nor can decide one. Each is single-use: never shared between
// two requests, and never replayed, so a second sheet the user answers
// differently fails as stale instead of silently taking the first answer.
const pageTokens = new Map();

// Drop the page consents past their time: on every page check and decision.
function sweepPageTokens(now = Date.now()) {
  for (const [token, pending] of pageTokens) {
    if (pending.expiresAt < now) pageTokens.delete(token);
  }
}

/**
 * A page's request is done with its consent (decided, refused, or closed
 * some other way: its document gone, its deadline, its window): the token
 * goes. Idempotent.
 */
function releasePageManifest(token) {
  // The core's consent: its `release`, which never fails its caller.
  if (storeIsCore()) {
    return Promise.resolve()
      .then(() => coreManifest('release', { token }))
      .then(
        () => undefined,
        () => undefined
      );
  }
  pageTokens.delete(token);
}
const unresolvedBackoff = new Map();

function getStorePath() {
  return getFreedomDataPath(STORE_FILE);
}

/** Whether the manifest store is the core's (core-client.js `swarmStoresNamed`). */
function storeIsCore() {
  return require('../core/core-client').swarmStoresNamed();
}

/**
 * Throws once the manifest store is the core's: main then never opens
 * swarm-manifest-grants.json, its backup or its temporary file (design
 * 0015, D3; the SWM-6 to SWM-9 plan, section 5).
 */
function assertMainStore() {
  if (storeIsCore()) {
    throw new Error(`${STORE_FILE} is the identity core's: main doesn't open it`);
  }
}

/** The core's `swarm.manifest` op `op`, main's own (core/swarm-stores.js). */
function coreManifest(op, members, options) {
  return require('../core/swarm-stores').manifest(op, members, options);
}

function emptyStore() {
  return { version: 1, records: {} };
}

function loadStore() {
  // Every read and write of the file comes through here or `saveStore`.
  assertMainStore();
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
  assertMainStore();
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

// The manifest goes through the bzz: handler in process, on the session of
// the window that asked and with its private context (freedom-core design
// 0006, "Other callers"): a private window's lookup is private to the core
// and redacted in the log, its fetch stops with the window, and a remote Ant
// is dialled on that session's network stack.
//
// The window is read when the check comes in, before it queues behind the
// origin's lock: by the time the lock is free the window may be gone, and
// what it was must not be guessed then. A sender that is gone, or one known
// to be private whose partition can't be named, gets no context: its check
// is refused, never fetched on the default session.
function privateWindows() {
  return require('../private/private-windows');
}

function manifestFetchContext(sender) {
  if (typeof sender?.isDestroyed !== 'function' || sender.isDestroyed()) return null;
  const { session } = require('electron');
  const { getPartitionForWebContents, isPrivateWebContents } = privateWindows();
  const partition = getPartitionForWebContents(sender);
  const isPrivate = Boolean(partition) || isPrivateWebContents(sender);
  if (isPrivate && !partition) return null;
  return {
    session: partition ? session.fromPartition(partition) : session.defaultSession,
    partition,
    isPrivate,
  };
}

// Whether the window a queued check was taken from is still there, on the
// same partition: a check that outlived its window fetches nothing.
function stillAsking(sender, fetchContext) {
  return (
    !sender.isDestroyed() &&
    privateWindows().getPartitionForWebContents(sender) === fetchContext.partition
  );
}

/**
 * Where a committed URL's manifest is: `bzz://<host>/freedom-manifest.json`,
 * or null for a URL that doesn't parse or isn't `bzz:` (`unsupported`).
 */
function manifestUrlOf(committedUrl) {
  let url;
  try {
    url = new URL(committedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'bzz:') return null;
  return `bzz://${url.host}/freedom-manifest.json`;
}

async function discover(committedUrl, fetchManifest = handleBzzRequest, fetchContext = {}) {
  const manifestUrl = manifestUrlOf(committedUrl);
  if (manifestUrl === null) return { status: 'unsupported' };

  let response;
  try {
    response = await fetchManifest(new Request(manifestUrl), fetchContext);
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

// The Swarm grants a projection writes go to the identity core as main's
// own (`shell`, naming the key: design 0012, "The model"; APB-3), and each
// resolves once main has read the key back.
async function applyProjectionValue(origin, key, enabled) {
  if (key === 'connection') {
    if (enabled && !permissions.getPermission(origin)) await permissions.grantPermission(origin, { source: 'manifest' });
    if (!enabled) await permissions.revokePermission(origin, { source: 'manifest' });
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
    if (enabled) await permissions.grantMessaging(origin, { source: 'manifest' });
    else await permissions.revokeMessaging(origin, { source: 'manifest' });
  } else if (key.startsWith('autoApprove.')) {
    await permissions.setAutoApprove(origin, key.slice(12), enabled, { source: 'manifest' });
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

// The projections that only mean something with a usable publisher
// identity: the identity itself (which a manifest never created here), a
// feed grant, and the auto-approve flags of the capabilities that need one
// (feeds, signing).
const IDENTITY_PROJECTIONS = ['identity', 'feedGrant', 'autoApprove.feeds', 'autoApprove.signing'];

/**
 * A journaled transaction, as it may be replayed for an origin whose
 * active publisher identity is a stored ethereum-wallet one (#89): it
 * grants none of the identity's projections and manages none of them, so
 * no managed permission stands that couldn't work. The identity is kept;
 * nothing picks another owner. Only a journal written before the mode was
 * removed can hold one: a decision now is refused before it is journaled.
 */
function withoutUnavailableIdentity(origin, record, operations) {
  if (!feeds.hasUnavailableIdentity(origin)) return { record, operations };
  if (record?.managed) {
    for (const projection of IDENTITY_PROJECTIONS) delete record.managed[projection];
  }
  return {
    record,
    operations: operations.filter(
      (operation) => !(operation.enabled && IDENTITY_PROJECTIONS.includes(operation.projection))
    ),
  };
}

// The store's changes, one at a time: a transaction's journal, its writes
// to the identity core (each waited for) and its commit run before the
// next change reads the store, and recovery replays only a journal no
// running transaction holds.
let changes = Promise.resolve();

function inOrder(task) {
  const run = changes.then(task);
  changes = run.catch(() => {});
  return run;
}

async function runTransaction(origin, record, operations) {
  const state = loadStore();
  state.pending = { origin, record, operations };
  saveStore();
  faultInjector?.('after-journal');
  for (const [index, operation] of operations.entries()) {
    await applyProjectionValue(origin, operation.projection, operation.enabled);
    faultInjector?.(`after-operation:${index}:${operation.projection}`);
  }
  if (record) state.records[origin] = record;
  else delete state.records[origin];
  delete state.pending;
  faultInjector?.('before-commit');
  saveStore();
}

// A journal a transaction left (a crash, a failed write), replayed once the
// Swarm grants have been read from the core: with none read, every
// projection would read as off, and a connection replayed over a site's
// own would replace it. Until then the journal waits for the next change.
async function replayPending() {
  const state = loadStore();
  if (!state.pending) return;
  if (!(await permissions.whenLoaded())) return;
  const { origin } = state.pending;
  const { record, operations } = withoutUnavailableIdentity(
    origin,
    state.pending.record,
    state.pending.operations
  );
  for (const operation of operations) await applyProjectionValue(origin, operation.projection, operation.enabled);
  if (record) state.records[origin] = record;
  else delete state.records[origin];
  delete state.pending;
  saveStore();
}

function recoverPending() {
  return inOrder(replayPending);
}

async function pruneRecord(origin) {
  const state = loadStore();
  const record = state.records[origin];
  if (!record) return;
  const operations = removeOwners(record, CAPABILITY_KEYS);
  await runTransaction(origin, null, operations);
}

function detachManaged(origin, projection) {
  const key = normalizeOrigin(origin);
  if (projection === 'connection') return disconnect(key);
  return inOrder(async () => {
    await replayPending();
    const state = loadStore();
    const record = state.records[key];
    if (!record) return;
    record.detached ||= {};
    record.detached[projection] = true;
    if (record.managed) delete record.managed[projection];
    record.revision = (record.revision || 0) + 1;
    await runTransaction(key, record, []);
  });
}

// A store's report of a user's change, which doesn't wait for it.
function detachManagedLater(origin, projection) {
  detachManaged(origin, projection).catch((err) => {
    console.error('[PermissionManifests] Could not detach a managed permission:', err);
  });
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

/**
 * `deps.owner` says whose consent this is: `page` (main's own, for a page's
 * request: `checkPageManifest`), or none (in-process callers that decide
 * themselves, tests).
 */
async function checkManifest({ origin, committedUrl, eager = false }, deps = {}) {
  const forPage = deps.owner === 'page';
  await recoverPending();
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

  const found = await discover(committedUrl, deps.fetchManifest, deps.fetchContext);
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
    if (existing) await inOrder(() => pruneRecord(key));
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
    await inOrder(() => runTransaction(key, record, removalOperations));
  }
  else {
    // `state` was read before the discover() await. `saveStore()` serializes
    // whatever `storeCache` is *now* — a concurrent operation on another
    // origin that failed its save meanwhile has nulled it — so re-read the
    // store and mutate that, exactly as `runTransaction` does.
    await inOrder(() => {
      const current = loadStore();
      current.records[key] = record;
      saveStore();
    });
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
  if (forPage) {
    // A page's consent is its request's own: never coalesced. The pool is
    // swept and bounded first: the oldest waiting consent goes past the
    // bound.
    sweepPageTokens();
    while (pageTokens.size >= MAX_PAGE_TOKENS) pageTokens.delete(pageTokens.keys().next().value);
    const token = crypto.randomBytes(24).toString('base64url');
    pageTokens.set(token, pending);
    return { kind: 'consent', token, model: buildConsentModel(key, existing, manifest, changed, removed) };
  }
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

/**
 * Decide a consent. By default from the in-process callers' shared pool,
 * which replays a decided token's result. A page's (`owner: 'page'`, from
 * `decidePageManifest` only) comes from main's own pool, once.
 */
function decideManifest(token, outcome, options = {}) {
  return inOrder(async () => {
    await replayPending();
    return decideInOrder(token, outcome, options);
  });
}

async function decideInOrder(token, outcome, { owner = null } = {}) {
  const forPage = owner === 'page';
  const pool = forPage ? pageTokens : tokens;
  if (forPage) sweepPageTokens();
  if (!forPage && completedTokens.has(token)) return completedTokens.get(token);
  const pending = pool.get(token);
  if (!pending || pending.expiresAt < Date.now()) {
    pool.delete(token);
    throw new Error('Manifest consent expired');
  }
  if (!['allow', 'individual', 'deny'].includes(outcome)) throw new Error('Invalid manifest decision');

  const state = loadStore();
  if (state.records[pending.origin]?.observed?.fingerprint !== pending.fingerprint) {
    pool.delete(token);
    throw new Error('Manifest consent is stale');
  }
  if ((state.records[pending.origin]?.revision || 0) !== pending.baseRevision) {
    pool.delete(token);
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
    // A stored ethereum-wallet identity (#89) can't take a feed grant: a
    // manifest asking for feeds or signing is refused with the mode's own
    // error, before anything is journaled or applied. The identity is
    // kept, and the user has to switch it explicitly.
    if (
      outcome === 'allow' &&
      pending.changed.some((capability) => ['feeds', 'signing'].includes(capability))
    ) {
      feeds.assertFeedGrantable(pending.origin);
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
    await runTransaction(pending.origin, record, operations);
  } else if (pending.firstContact) {
    await runTransaction(pending.origin, null, []);
  }
  const result = { allowed: outcome !== 'deny', mode: outcome };
  pool.delete(token);
  if (!forPage) {
    completedTokens.set(token, result);
    if (completedTokens.size > 100) completedTokens.delete(completedTokens.keys().next().value);
  }
  return result;
}

function useIndividual(origin, capability) {
  return inOrder(async () => {
    await replayPending();
    return useIndividualInOrder(origin, capability);
  });
}

async function useIndividualInOrder(origin, capability) {
  if (!CAPABILITY_KEYS.includes(capability)) throw new Error('Unknown capability');
  const key = normalizeOrigin(origin);
  const record = structuredClone(loadStore().records[key] || null);
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
  await runTransaction(key, record, operations);
  return true;
}

function disconnect(origin) {
  const key = normalizeOrigin(origin);
  return inOrder(async () => {
    await replayPending();
    await runTransaction(key, null, [
      { projection: 'feedGrant', enabled: false },
      { projection: 'connection', enabled: false },
    ]);
    return true;
  });
}

async function getRecord(origin) {
  await recoverPending();
  return loadStore().records[normalizeOrigin(origin)] || null;
}

/**
 * The manifest check for a page's request through main (freedom-core design
 * 0011, PRQ-7b): for the requester's attested key and its own committed URL,
 * fetched on the guest's own session, under the key's lock. Nothing here is
 * the chrome's: main names the site and the URL. A consent answer's token
 * stays in main, which shows the sheet as its own prompt
 * (`swarm.manifest`) and decides it (`decidePageManifest`).
 *
 * @param {{ key: string, url: string, guest: object, eager?: boolean }} request
 * @returns {Promise<{ kind: string, token?: string, model?: object }>}
 */
function checkPageManifest({ key, url, guest, eager = false }) {
  const fetchContext = manifestFetchContext(guest);
  if (!fetchContext) return Promise.resolve({ kind: 'unresolved' });
  return withOriginLock(key, () => {
    if (!stillAsking(guest, fetchContext)) return { kind: 'unresolved' };
    if (storeIsCore()) return checkThroughCore({ key, url, eager }, { guest, fetchContext });
    return checkManifest({ origin: key, committedUrl: url, eager }, { fetchContext, owner: 'page' });
  });
}

// ---- The core's store: the page path's check and its manifest ----

/**
 * The checks main has sent the core, while each runs (design 0015, D6):
 * `${generation}:${id}`, the check's envelope ID in the process it went to,
 * to `{ guest, fetchContext, url }`, the window that asked, what it was
 * when its check came in, and its committed URL. The core's
 * `shell.swarm_manifest` names the check as `for`; main fetches for that
 * window only, and only that URL's manifest. One entry per check in
 * flight, gone once it is answered, so at most the core's outstanding
 * requests.
 */
const manifestAsks = new Map();
const askKey = (generation, id) => `${generation}:${id}`;

/**
 * The core's `check` for a page (design 0015, D6), after main's window
 * checks: the site's key normalized, the window that asked kept for the
 * fetch the core asks for it while the check runs.
 */
async function checkThroughCore({ key, url, eager }, { guest, fetchContext }) {
  let sent = null;
  try {
    return await coreManifest(
      'check',
      { key: normalizeOrigin(key), url, eager: Boolean(eager) },
      {
        onSent: (id, generation) => {
          sent = askKey(generation, id);
          manifestAsks.set(sent, { guest, fetchContext, url });
        },
      }
    );
  } finally {
    if (sent !== null) manifestAsks.delete(sent);
  }
}

/** `shell.swarm_manifest`'s failure: the check reads it as unresolved. */
const ASK_FAILED = Object.freeze({ failed: true });
/** The most of a manifest's body main reads and sends: 8 KiB and a byte. */
const ASK_MOST = MAX_BYTES + 1;

/**
 * What main holds for an answer whose body is `n` bytes, the reply's room
 * of design 0015's D6 (`n + 2 × b64(n) + 16 KiB`): the body, its base64
 * and the reply that carries it. About 45 KiB for the most it reads.
 */
function askCharge(n) {
  return n + 2 * 4 * Math.ceil(n / 3) + 16 * 1024;
}

/** `{ for, url }` exactly, `for` an envelope ID and `url` a string; else null. */
function readManifestAsk(params) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  const keys = Object.keys(params);
  if (keys.length !== 2 || !Object.hasOwn(params, 'for') || !Object.hasOwn(params, 'url')) {
    return null;
  }
  if (!Number.isSafeInteger(params.for) || params.for < 1 || typeof params.url !== 'string') {
    return null;
  }
  return { for: params.for, url: params.url };
}

/**
 * A 2xx manifest's body, as `readLimitedBody` reads it (each read under
 * the 15 s idle bound), but kept, not refused, past 8 KiB: at most 8 KiB
 * and a byte, which the core refuses as `invalid`, as the reference refuses
 * the body. A read that fails, stalls or is cancelled (`signal`) throws.
 */
async function readAskedBody(response, signal, idleTimeoutMs = BODY_IDLE_TIMEOUT_MS) {
  // The capped bytes go into storage of exactly the cap that main owns, so
  // nothing larger than the charge stays reachable from the answer (a short
  // view of a copied 64 KiB piece would keep the whole piece alive).
  const body = Buffer.alloc(ASK_MOST);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const whole = new Uint8Array(await withIdleDeadline(response.arrayBuffer(), idleTimeoutMs));
    const take = Math.min(whole.length, ASK_MOST);
    body.set(whole.subarray(0, take));
    return body.subarray(0, take);
  }
  const stop = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  try {
    let length = 0;
    while (length < ASK_MOST) {
      if (signal?.aborted) throw new Error('manifest fetch cancelled');
      let chunk;
      try {
        chunk = await withIdleDeadline(reader.read(), idleTimeoutMs);
      } catch (err) {
        await stop();
        throw err;
      }
      if (chunk.done) break;
      const value = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value);
      const take = Math.min(value.length, ASK_MOST - length);
      body.set(value.subarray(0, take), length);
      length += take;
    }
    if (signal?.aborted) throw new Error('manifest fetch cancelled');
    if (length >= ASK_MOST) await stop();
    return body.subarray(0, length);
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

/**
 * Main's answer to the core's `shell.swarm_manifest { for, url }` (design
 * 0015, D6; the SWM-6 to SWM-9 plan, point 6), its handler's context the
 * service client's (`signal`, `charge`, `shrink` on the Swarm I/O pool,
 * `generation`). `for` must name a check main sent that is still running
 * (`manifestAsks`) and `url` that check's manifest, the `bzz:` address
 * `discover` would fetch: anything else, a non-`bzz:` URL among it, is
 * fetched never, and answered `{ failed: true }`, as is a check whose
 * window has gone or moved partition since. Otherwise today's fetch:
 * `handleBzzRequest` on that window's session with its private context,
 * its 2xx body read under the 15 s idle bound to at most 8 KiB and a byte
 * (another status's body unread), answered `{ status, body_base64 }`; a
 * fetch that throws, a body that breaks or stalls, is `{ failed: true }`.
 * The reply's room (`askCharge`, about 45 KiB) is charged before the
 * fetch, `{ failed: true }` without it, and shrunk to the body read.
 */
async function answerManifestAsk(params, context = {}) {
  const { signal = null, charge = () => true, shrink = () => {}, generation = null } = context;
  const ask = readManifestAsk(params);
  if (!ask) {
    console.warn('[PermissionManifests] A malformed manifest ask was answered failed');
    return ASK_FAILED;
  }
  const entry = manifestAsks.get(askKey(generation, ask.for));
  // No check of main's running under that ID: nothing to fetch for.
  if (!entry) return ASK_FAILED;
  // Only the check's own manifest, at its `bzz:` address.
  if (ask.url !== manifestUrlOf(entry.url)) {
    console.warn('[PermissionManifests] A manifest ask for another address was answered failed');
    return ASK_FAILED;
  }
  if (!stillAsking(entry.guest, entry.fetchContext)) return ASK_FAILED;
  if (!charge(askCharge(ASK_MOST))) return ASK_FAILED;
  const failed = () => {
    shrink(0);
    return ASK_FAILED;
  };
  let response;
  try {
    response = await handleBzzRequest(
      new Request(ask.url, signal ? { signal } : {}),
      entry.fetchContext
    );
  } catch {
    return failed();
  }
  const status = response?.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return failed();
  let body = Buffer.alloc(0);
  if (status >= 200 && status <= 299) {
    try {
      body = await readAskedBody(response, signal);
    } catch {
      return failed();
    }
  } else {
    try {
      response.body?.cancel?.()?.catch?.(() => {});
    } catch {
      // Nothing more to read.
    }
  }
  shrink(askCharge(body.length));
  return { status, body_base64: body.toString('base64') };
}

/**
 * Decide a consent main showed for a page (PRQ-7b), under the key's lock:
 * inside it, `recheck()` checks the name again, and `holds()`, the document
 * still holding its key, runs in the same run as the decision's grant
 * writes. Resolves `{ refused: true }` with nothing written, or the
 * decision.
 */
function decidePageManifest(key, token, outcome, { recheck, holds }) {
  if (storeIsCore()) return decideThroughCore(key, token, outcome, { recheck, holds });
  return withOriginLock(key, async () => {
    sweepPageTokens();
    // Only a page consent main issued for this very key.
    if (pageTokens.get(token)?.origin !== normalizeOrigin(key)) throw new Error('Manifest consent expired');
    // A refused decision spends the consent too: its request answers
    // keyless, and nothing decides it after.
    if (!(await recheck()) || !holds()) {
      pageTokens.delete(token);
      return { refused: true };
    }
    return decideManifest(token, outcome, { owner: 'page' });
  });
}

/**
 * The core's `decide` for a page (design 0015, D6): the guard read just
 * before it is sent, `recheck()` and then, if it passed, `holds()`, as the
 * reference reads them, and sent as `live` with the site's key normalized.
 * The core checks the consent is the key's (else `Manifest consent
 * expired`, as main answers for no token at all, unsent), spends it on
 * `live: false` (`{ refused: true }`), and makes the decision's writes
 * itself, in its own order for the site: main's lock isn't held, since none
 * of the writes is main's.
 */
async function decideThroughCore(key, token, outcome, { recheck, holds }) {
  // No token is no consent of the core's, as no page consent is the key's.
  if (typeof token !== 'string') throw new Error('Manifest consent expired');
  const live = Boolean(await recheck()) && Boolean(holds());
  const origin = normalizeOrigin(key);
  const decided = await coreManifest('decide', { key: origin, token, outcome, live });
  if (decided?.allowed) await grantReadBack(origin);
  return decided;
}

/**
 * After an allowed decide, the site's grant as the core now holds it, in
 * main's mirror (swarm-permissions.js `readBack`). The core writes the
 * decision's projection, the connection among it, inside the decide, and
 * main's mirror would read the key again only at the core's
 * `approval.changed`, a moment later: a caller reading the grant at once
 * (page-swarm.js's requestAccess, after the consent) would find none and
 * ask the user to connect a second time. As main's own grant writes
 * resolve once main has read the key back, so does the decide. Bounded by
 * a grant read's own watchdog: a mirror that doesn't catch up, or a read
 * that fails, rejects, so nothing is asked again and no grant is assumed.
 */
async function grantReadBack(origin) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), GRANT_READ_BACK_MS);
  });
  try {
    if (!(await Promise.race([permissions.readBack(origin), late]))) {
      throw new Error("The permission manifest decision was saved, but main couldn't read the site's grant back");
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The chrome's request on the manifest store: the core's op `op` with the
 * site's key normalized, on the core's store; else `local()`.
 */
function chromeRequest(op, origin, members, local) {
  if (!storeIsCore()) return local();
  return coreManifest(op, { origin: normalizeOrigin(origin), ...members });
}

function registerPermissionManifestIpc() {
  // On the core's store, the core replays its journal and detaches what
  // the user changed (design 0015, D17): main neither reads the file nor
  // listens.
  if (!storeIsCore()) {
    recoverPending().catch((err) => {
      console.error('[PermissionManifests] Could not finish an interrupted change:', err);
    });
    // Both stores that hold manifest-projected state report user mutations, so
    // a grant the user changes by hand (revoking feed access, switching the
    // publisher identity) drops manifest ownership instead of leaving a record
    // that claims it — and can re-assert it on the next projection.
    permissions.onManifestMutation(detachManagedLater);
    feeds.onManifestMutation(detachManagedLater);
  }
  // No check or decide for the chrome (freedom-core design 0011, PRQ-7d):
  // main checks a page's manifest itself, for the document's own key and
  // URL, and decides the consent on its own prompt (checkPageManifest,
  // decidePageManifest). The chrome reads a site's record, and narrows it.
  ipcMain.handle(IPC.SWARM_MANIFEST_GET, (_event, origin) => (
    withOriginLock(origin, () => chromeRequest('get', origin, {}, () => getRecord(origin)))
  ));
  ipcMain.handle(IPC.SWARM_MANIFEST_USE_INDIVIDUAL, (_event, { origin, capability }) => (
    withOriginLock(origin, () => (
      chromeRequest('use-individual', origin, { capability }, () => useIndividual(origin, capability))
    ))
  ));
  ipcMain.handle(IPC.SWARM_MANIFEST_DISCONNECT, (_event, origin) => (
    withOriginLock(origin, () => chromeRequest('disconnect', origin, {}, () => disconnect(origin)))
  ));
  console.log('[PermissionManifests] IPC handlers registered');
}

function _resetForTests() {
  changes = Promise.resolve();
  storeCache = null;
  storeLoadedFromBackup = false;
  tokens.clear();
  completedTokens.clear();
  pageTokens.clear();
  unresolvedBackoff.clear();
  manifestAsks.clear();
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
  checkPageManifest,
  decidePageManifest,
  releasePageManifest,
  answerManifestAsk,
  MAX_PAGE_TOKENS,
  _pageTokenCountForTests: () => pageTokens.size,
  _manifestAskCountForTests: () => manifestAsks.size,
  _readAskedBodyForTests: readAskedBody,
  detachManaged,
  disconnect,
  getRecord,
  useIndividual,
  registerPermissionManifestIpc,
  _resetForTests,
  _setFaultInjectorForTests,
};
