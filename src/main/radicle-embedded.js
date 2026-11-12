/**
 * Embedded Radicle node — napi addon wrapper. The node, repository reads,
 * seeding, identity and COB writes all run in-process.
 *
 * The addon is `libradicle.node`, built from the libradicle repo
 * (rad:z2SzCC9zYnP17QRPZUhrP2RTEwZHj). A packaged build loads only the one
 * it ships, resources/radicle-bin/libradicle.node (R-7). A development
 * build tries, in order:
 *   1. FREEDOM_RADICLE_ADDON env override (absolute path)
 *   2. resources/radicle-bin/libradicle.node
 *   3. radicle-bin/<platform>/libradicle.node (development prebuilt)
 *   4. ../libradicle/target/{release,debug}/libradicle.node (dev sibling)
 *
 * Every addon export resolves to a JSON string; this module parses them
 * and throws on `{error}` payloads so callers deal in plain objects. The
 * `*Raw` reads are the exception: they hand back the addon's JSON text
 * unparsed, for responses the main process only forwards (see `callRaw`).
 *
 * **Under the freedom-radicled service** (`FREEDOM_RADICLE_BACKEND=service`,
 * development builds only; freedom-core design 0008, "Main's side"), the
 * exports keep their shapes, and the reads go to the service node
 * radicle-manager.js runs, through radicle/radicle-service-backend.js:
 * - **`callStream`, `callScoped`**, `collectionBudget` and `streamStats`
 *   are the service's own routes: a head and a body stream for the
 *   handlers' reads, and a parsed value inside a scope for the closed list
 *   of collected results, whose callers use the value there;
 * - **`identity` and `status`** are collected and handed out, as 0008 lets
 *   a value under 4 KiB outlive its scope (a larger one is `too_large`);
 * - **the network operations** are the service's methods: `connectSeeds`
 *   is `rad.connect_seeds`, `cloneRepo` and `cloneRepoWithProgress` are
 *   `rad.clone`, whose `rad.progress` events reach the callback parsed, as
 *   the add-on's did, and `cancelClone(rid)` cancels the request of that
 *   RID's progress clone, which then settles `{ cancelled: true }` once it
 *   stops;
 * - **the writes** are `rad.write` and `rad.unseed` (0008, Writes):
 *   `createIssue`, `commentIssue`, `editIssueState` and `commentPatch`
 *   with today's arguments and results, and `unseedRepo`. Each picks the
 *   running generation when it is called, before it returns, and goes to
 *   no other; a write whose outcome main can't know fails
 *   `outcome_unknown`, and is never sent again;
 * - **every other export** answers "Not available on the Radicle service
 *   yet" (`RADICLE_SERVICE_UNSUPPORTED`) until its own step moves it: the
 *   other collected results as values (`repoInfo`, `seeders`,
 *   `listSeededRepos`, `listRepos`), whose callers move into scopes; the
 *   handlers' parsed and `*Raw` reads, which the `rad:` and `radapi:`
 *   handlers don't call on the service (they read through `callStream`
 *   and `callScoped`, in their request's dweb admission); and the import.
 *   `isStarted` says whether the service node runs.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const log = require('./logger');
const { redactForLog } = require('./private/private-log-context');
const path = require('path');
const fs = require('fs');
const {
  RADICLE_ADDON_VERSION,
  RADICLE_ADDON_REQUIRED_EXPORTS,
} = require('../shared/radicle-addon-version');
const { radicleBackendKind } = require('./radicle/radicle-backend-kind');

let addon = null;
let addonPath = null;
let started = false;

const REQUIRED_EXPORTS = RADICLE_ADDON_REQUIRED_EXPORTS;

function platformKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `mac-${arch}`;
  if (process.platform === 'win32') return `win-${arch}`;
  return `linux-${arch}`;
}

// Under Jest `require('electron')` is the binary's path, not the API: no
// `app`, so a development build.
function isPackagedBuild() {
  try {
    return require('electron').app?.isPackaged === true;
  } catch {
    return false;
  }
}

function candidatePaths() {
  // R-7: anything else would let an environment variable, or a file beside
  // the app, load native code into the main process of a shipped build.
  if (isPackagedBuild()) {
    return process.resourcesPath
      ? [path.join(process.resourcesPath, 'radicle-bin', 'libradicle.node')]
      : [];
  }
  const candidates = [];
  if (process.env.FREEDOM_RADICLE_ADDON) {
    candidates.push(process.env.FREEDOM_RADICLE_ADDON);
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'radicle-bin', 'libradicle.node'));
  }
  candidates.push(
    path.join(__dirname, '..', '..', 'radicle-bin', platformKey(), 'libradicle.node')
  );
  for (const profile of ['release', 'debug']) {
    candidates.push(
      path.join(__dirname, '..', '..', '..', 'libradicle', 'target', profile, 'libradicle.node')
    );
  }
  return candidates;
}

/**
 * Load the addon if present. A missing addon is a packaging/startup error;
 * there is deliberately no executable fallback.
 */
function loadAddon() {
  if (addon) return addon;
  for (const candidate of candidatePaths()) {
    if (fs.existsSync(candidate)) {
      try {
        const loaded = require(candidate);
        const missing = REQUIRED_EXPORTS.filter((name) => typeof loaded[name] !== 'function');
        if (missing.length) {
          log.warn('[RadicleEmbedded] Incompatible addon at', candidate, 'missing:', missing);
          continue;
        }
        addon = loaded;
        addonPath = candidate;
        log.info('[RadicleEmbedded] Loaded addon from', candidate);
        return addon;
      } catch (err) {
        log.warn('[RadicleEmbedded] Failed to load addon at', candidate, err.message);
      }
    }
  }
  return null;
}

function isAvailable() {
  return loadAddon() !== null;
}

function getAddonPath() {
  loadAddon();
  return addonPath;
}

function getVersion() {
  return RADICLE_ADDON_VERSION;
}

// ---- the freedom-radicled service (freedom-core design 0008) ----

/** What an export answers on the service until its own step moves it. */
const NOT_ON_SERVICE = 'Not available on the Radicle service yet';

class RadicleServiceUnsupported extends Error {
  constructor(name) {
    super(NOT_ON_SERVICE);
    this.name = 'RadicleServiceUnsupported';
    this.code = 'RADICLE_SERVICE_UNSUPPORTED';
    this.export = name;
  }
}

const onService = () => radicleBackendKind() === 'service';

// The service node radicle-manager.js runs (setServiceNodeSource), and the
// reads' backend on it, made at its first use.
let serviceNodeSource = () => null;
let serviceBackend = null;

/** radicle-manager.js names its service node: `source()` is the node
 * (radicle/radicled-node.js) while it starts, runs or restarts, or null. */
function setServiceNodeSource(source) {
  serviceNodeSource = typeof source === 'function' ? source : () => null;
}

function service() {
  if (!serviceBackend) {
    const { RadicleServiceBackend } = require('./radicle/radicle-service-backend');
    serviceBackend = new RadicleServiceBackend({ node: () => serviceNodeSource() });
  }
  return serviceBackend;
}

/** `name` on the add-on, or, on the service, `route` if it has one there,
 * else RADICLE_SERVICE_UNSUPPORTED. */
function routed(name, addonRoute, serviceRoute = null) {
  return (...args) => {
    if (!onService()) return addonRoute(...args);
    if (serviceRoute) return serviceRoute(...args);
    return Promise.reject(new RadicleServiceUnsupported(name));
  };
}

/** A collected `identity` or `status` on the service, under 4 KiB, handed
 * out of its scope. */
const kept = (op) => service().keep(op, {});

function serviceOnly(name) {
  if (!onService()) throw new Error(`${name} is the Radicle service's: the add-on has no streams`);
  return service();
}

/**
 * A read passed through on the service (0008, "JSON results"): `{ head:
 * { content_type, bytes }, body }`, `body` a byte stream of the JSON. For
 * the handlers' reads. `signal`, or the body's `cancel()`, cancels it.
 * `admitted`: the caller's request holds a slot of main's dweb admission
 * (the `rad:` and `radapi:` handlers), so the read takes none of the other
 * callers' (radicle/radicle-service-backend.js).
 */
function callStream(op, args = {}, { signal = null, admitted = false } = {}) {
  try {
    return serviceOnly('callStream').callStream(op, args, { signal, admitted });
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * A collected result on the service, parsed in a scope: resolves to what
 * `scope(value, { signal, bytes })` resolves to, once the value is parsed;
 * main's collection budget holds it until the scope settles. The value
 * itself can't be what the scope resolves to: it is used there. Only the
 * closed list of small results (radicle/radicle-service-backend.js's
 * COLLECTED_CAPS). `admitted` is callStream's.
 */
function callScoped(op, args, scope, { signal = null, admitted = false } = {}) {
  try {
    return serviceOnly('callScoped').callScoped(op, args, scope, { signal, admitted });
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Main's collection budget on the service: `{ held, limit }`, in bytes. */
function collectionBudget() {
  return serviceOnly('collectionBudget').collectionBudget();
}

/** What main holds for the service's streams: `{ streams, buffered }`. */
function streamStats() {
  return serviceOnly('streamStats').streamStats();
}

// A read's bounds (R-3): `rad:` reads run under withReadBounds, so every
// addon call they make, including the composed reads' later ones, checks
// them. Other callers run unbounded.
const readBounds = new AsyncLocalStorage();

/** The read has ended for its caller (gone, or out of time): no further
 * addon call starts, and nothing more is parsed. */
class ReadEnded extends Error {
  constructor() {
    super('This Radicle read has ended');
    this.name = 'ReadEnded';
  }
}

/** An addon reply longer than the read's cap, refused before it is parsed. */
class ReplyTooLarge extends Error {
  constructor(name) {
    super(`radicle addon reply from ${name} is too large to serve`);
    this.name = 'ReplyTooLarge';
  }
}

/**
 * Run `fn` with a read's bounds: `signal` ends the read (no addon call
 * starts after it aborts, and a reply that returns after it is dropped
 * unparsed), and `maxReplyChars` caps each addon reply's text, checked
 * before it is parsed or passed on.
 */
function withReadBounds({ signal = null, maxReplyChars = null } = {}, fn) {
  return readBounds.run({ signal, maxReplyChars }, fn);
}

async function addonCall(name, args) {
  const a = loadAddon();
  if (!a) throw new Error('radicle addon not available');
  // Taken before the call: the checks after it must not depend on the
  // context surviving the addon's promise.
  const bounds = readBounds.getStore();
  if (bounds?.signal?.aborted) throw new ReadEnded();
  const raw = await a[name](...args);
  if (bounds?.signal?.aborted) throw new ReadEnded();
  if (
    bounds?.maxReplyChars !== null &&
    bounds?.maxReplyChars !== undefined &&
    typeof raw === 'string' &&
    raw.length > bounds.maxReplyChars
  ) {
    throw new ReplyTooLarge(name);
  }
  return raw;
}

async function call(name, ...args) {
  return parseResult(await addonCall(name, args));
}

function parseResult(raw) {
  const value = JSON.parse(raw);
  if (value && value.error) {
    throw new Error(value.error);
  }
  return value;
}

// The addon reports a failure as a one-key `{"error": "..."}` object; no
// read whose text `callRaw` passes through has an `error` field of its own.
const ERROR_PAYLOAD_RE = /^\s*\{\s*"error"\s*:/;

/**
 * Like `call`, but resolves to the addon's JSON text instead of a parsed
 * object. For responses the main process only passes on (blob, commit
 * diff, tree, commit page served by `radapi:`/`rad:`): parsing a
 * multi-megabyte file or diff and stringifying it again costs one long
 * synchronous stall on main for nothing (#514). Error payloads are still
 * parsed and thrown, exactly as `call` does.
 */
async function callRaw(name, ...args) {
  const raw = await addonCall(name, args);
  if (typeof raw !== 'string') {
    throw new Error(`radicle addon returned no JSON text from ${name}`);
  }
  if (ERROR_PAYLOAD_RE.test(raw.slice(0, 64))) parseResult(raw);
  return raw;
}

/**
 * Start the embedded node. Resolves to `{ did }`.
 * @param {string} home - Radicle home directory (keys, storage, node dbs)
 * @param {string} alias - Alias used when initializing a fresh profile
 */
async function start(home, alias) {
  const result = await call('start', home, alias);
  started = true;
  return result;
}

// The node counts as stopped only on the add-on's proof: its shutdown
// resolves after the node's thread has joined. A rejection proves nothing
// (the thread may still hold the home's files), so the node still counts as
// started, and a re-key refuses to wipe under it (R-8).
async function shutdown() {
  if (!started) return { ok: true };
  const result = await call('shutdown');
  started = false;
  return result;
}

function isStarted() {
  return started;
}

const connectSeeds = (timeoutMs = 15000) => call('connectSeeds', timeoutMs);
const cloneRepo = (rid, timeoutMs = 120000) => call('cloneRepo', rid, timeoutMs);

/** A clone's progress callback for each event's JSON text, parsed, as the
 * add-on and the service both hand it on. */
function parsedProgress(onProgress) {
  return (eventRaw) => {
    try {
      onProgress(JSON.parse(eventRaw));
    } catch (err) {
      // PRIVATE MODE GUARD (#1073): a private window's seed or sync gets
      // here in its log context, and JSON.parse's text quotes part of the
      // event, whose fetch errors can name the Radicle storage path.
      log.warn(
        '[RadicleEmbedded] Ignoring invalid clone progress event:',
        redactForLog(err.message)
      );
    }
  };
}

async function cloneRepoWithProgress(rid, timeoutMs = 120000, onProgress = () => {}) {
  const a = loadAddon();
  if (!a) throw new Error('radicle addon not available');
  const raw = await a.cloneRepoWithProgress(rid, timeoutMs, parsedProgress(onProgress));
  return parseResult(raw);
}
const cancelClone = (rid) => call('cancelClone', rid);

// The network operations on the service (0008, Methods): the same
// arguments, defaults and results.
const serviceConnectSeeds = async (timeoutMs = 15000) => service().connectSeeds(timeoutMs);
const serviceCloneRepo = async (rid, timeoutMs = 120000) => service().cloneRepo(rid, timeoutMs);
const serviceCloneRepoWithProgress = async (rid, timeoutMs = 120000, onProgress = () => {}) =>
  service().cloneRepoWithProgress(rid, timeoutMs, parsedProgress(onProgress));
const serviceCancelClone = async (rid) => service().cancelClone(rid);

// The writes on the service (0008, Methods `rad.write` and `rad.unseed`):
// today's arguments, by name, and today's results. Not async: each picks
// its generation before it returns, in its caller's run (cob-service.js
// checks that generation's identity just before).
const serviceCreateIssue = (rid, title, description, labels = []) =>
  service().write('create_issue', { rid, title, description, labels });
const serviceCommentIssue = (rid, issueId, body, replyTo) =>
  service().write('comment_issue', { rid, issue_id: issueId, body, reply_to: replyTo ?? null });
const serviceEditIssueState = (rid, issueId, state) =>
  service().write('edit_issue_state', { rid, issue_id: issueId, state });
const serviceCommentPatch = (rid, revisionId, body) =>
  service().write('comment_patch', { rid, revision_id: revisionId, body });
const serviceUnseedRepo = (rid) => service().unseed(rid);
const unseedRepo = (rid) => call('unseedRepo', rid);
const listRepos = () => call('listRepos');
const listSeededRepos = () => call('listSeededRepos');
const issues = (rid) => call('issues', rid);
const issue = (rid, issueId) => call('issue', rid, issueId);
const patches = (rid) => call('patches', rid);
const patch = (rid, patchId) => call('patch', rid, patchId);
const identity = () => call('identity');
const createIssue = (rid, title, description, labels = []) =>
  call('createIssue', rid, title, description, JSON.stringify(labels));
const commentIssue = (rid, issueId, body, replyTo) =>
  call('commentIssue', rid, issueId, body, replyTo);
const editIssueState = (rid, issueId, state) =>
  call('editIssueState', rid, issueId, state);
const commentPatch = (rid, revisionId, body) =>
  call('commentPatch', rid, revisionId, body);
const importRepo = (repoPath, name, description, defaultBranch) =>
  call('importRepo', repoPath, name, description, defaultBranch);

// The import on the service (0010, D5; plan B14): radicle-manager.js's
// (setServiceImport), which stops the node, runs the one-shot import
// process on the working copy and starts the node again. Today's arguments
// and result, `{ rid }`.
let serviceImport = null;

/** radicle-manager.js names its import on the service: `(repoPath, name,
 * description, defaultBranch) => Promise<{ rid }>`. */
function setServiceImport(run) {
  serviceImport = typeof run === 'function' ? run : null;
}

const serviceImportRepo = (repoPath, name, description, defaultBranch) =>
  serviceImport
    ? serviceImport(repoPath, name, description, defaultBranch)
    : Promise.reject(new RadicleServiceUnsupported('importRepo'));
const repoInfo = (rid) => call('repoInfo', rid);
const commits = (rid, parent, page = 0, perPage = 30) =>
  call('commits', rid, parent, page, perPage);
const commit = (rid, revision) => call('commit', rid, revision);
const tree = (rid, treePath = '') => call('tree', rid, treePath);
const treeAt = (rid, revision, treePath = '') => call('treeAt', rid, revision, treePath);
const blob = (rid, blobPath) => call('blob', rid, blobPath);
const blobAt = (rid, revision, blobPath) => call('blobAt', rid, revision, blobPath);
const commitsRaw = (rid, parent, page = 0, perPage = 30) =>
  callRaw('commits', rid, parent, page, perPage);
const commitRaw = (rid, revision) => callRaw('commit', rid, revision);
const treeAtRaw = (rid, revision, treePath = '') => callRaw('treeAt', rid, revision, treePath);
const blobRaw = (rid, blobPath) => callRaw('blob', rid, blobPath);
const blobAtRaw = (rid, revision, blobPath) => callRaw('blobAt', rid, revision, blobPath);
const remotes = (rid) => call('remotes', rid);
const repoStats = (rid, revision) => call('repoStats', rid, revision);
const status = () => call('status');
const seeders = (rid) => call('seeders', rid);

/**
 * Repo metadata covering the fields pages/scripts/rad-browser.js consumes.
 */
async function buildRepoMeta(rid) {
  const info = await repoInfo(rid);
  let seeding = 0;
  try {
    seeding = (await seeders(rid)).seeding;
  } catch (err) {
    // PRIVATE MODE GUARD: the failure is swallowed here, so the protocol's
    // redacted catch never sees it, and its text can name the repository's
    // storage path (#1050).
    log.warn('[RadicleEmbedded] seeders() failed:', redactForLog(err.message));
  }
  return {
    rid: info.rid,
    payloads: {
      'xyz.radicle.project': {
        data: {
          name: info.name,
          description: info.description,
          defaultBranch: info.defaultBranch,
        },
        meta: {
          head: info.head,
          issues: { open: info.issuesOpen },
          patches: { open: info.patchesOpen },
        },
      },
    },
    delegates: info.delegates || [],
    threshold: info.threshold ?? 1,
    visibility: info.visibility || { type: 'public' },
    seeding,
  };
}

const README_CANDIDATES = [
  'README.md',
  'README.markdown',
  'README.txt',
  'README',
  'readme.md',
];

/**
 * First readme blob found at the repository root, or null.
 * Shaped like a blob response: `{ binary, content, name, path }`.
 */
async function readme(rid) {
  return readmeAt(rid);
}

async function findReadme(rid, revision) {
  const { entries } = revision ? await treeAt(rid, revision, '') : await tree(rid, '');
  const names = new Set(entries.filter((e) => e.kind === 'blob').map((e) => e.name));
  return README_CANDIDATES.find((candidate) => names.has(candidate)) || null;
}

async function readmeAt(rid, revision) {
  const candidate = await findReadme(rid, revision);
  if (!candidate) return null;
  const result = revision ? await blobAt(rid, revision, candidate) : await blob(rid, candidate);
  return { ...result, path: candidate };
}

/**
 * `readmeAt(rid, revision)` as JSON text: the blob text with `path` added
 * by splicing it in before the closing brace, instead of parsing the
 * readme (which can be megabytes) to add one field. A later duplicate key
 * wins in JSON.parse, so this matches the `{ ...result, path }` spread.
 */
async function readmeAtRaw(rid, revision) {
  const candidate = await findReadme(rid, revision);
  if (!candidate) return null;
  const raw = revision
    ? await blobAtRaw(rid, revision, candidate)
    : await blobRaw(rid, candidate);
  const end = raw.lastIndexOf('}');
  if (!/^\s*\{\s*"/.test(raw) || end === -1 || raw.slice(end + 1).trim() !== '') {
    // Not the non-empty object a blob always is; take the slow, exact path.
    return JSON.stringify({ ...parseResult(raw), path: candidate });
  }
  return `${raw.slice(0, end)},"path":${JSON.stringify(candidate)}${raw.slice(end)}`;
}

/** Whether the service node runs: a generation whose `rad.start` succeeded
 * serves. */
function serviceStarted() {
  const generation = serviceNodeSource()?.generation;
  return generation !== null && generation !== undefined;
}

module.exports = {
  withReadBounds,
  ReadEnded,
  ReplyTooLarge,
  RadicleServiceUnsupported,
  NOT_ON_SERVICE,
  candidatePaths,
  REQUIRED_EXPORTS,
  isAvailable,
  getAddonPath,
  getVersion,
  // The service's routes, and the node they read from.
  setServiceNodeSource,
  setServiceImport,
  callStream,
  callScoped,
  collectionBudget,
  streamStats,
  // The node's life is radicle-manager.js's on the service.
  start: routed('start', start),
  shutdown: routed('shutdown', shutdown),
  isStarted: () => (onService() ? serviceStarted() : isStarted()),
  // The network operations: the service's methods.
  connectSeeds: routed('connectSeeds', connectSeeds, serviceConnectSeeds),
  cloneRepo: routed('cloneRepo', cloneRepo, serviceCloneRepo),
  cloneRepoWithProgress: routed(
    'cloneRepoWithProgress',
    cloneRepoWithProgress,
    serviceCloneRepoWithProgress
  ),
  cancelClone: routed('cancelClone', cancelClone, serviceCancelClone),
  // The writes: the service's `rad.write` and `rad.unseed`.
  unseedRepo: routed('unseedRepo', unseedRepo, serviceUnseedRepo),
  createIssue: routed('createIssue', createIssue, serviceCreateIssue),
  commentIssue: routed('commentIssue', commentIssue, serviceCommentIssue),
  editIssueState: routed('editIssueState', editIssueState, serviceEditIssueState),
  commentPatch: routed('commentPatch', commentPatch, serviceCommentPatch),
  // The import: the one-shot import process on the service.
  importRepo: routed('importRepo', importRepo, serviceImportRepo),
  // The collected results that may outlive their scope (0008, "JSON
  // results"); the others are read in callScoped, where their callers use
  // them.
  identity: routed('identity', identity, () => kept('identity')),
  status: routed('status', status, () => kept('status')),
  listRepos: routed('listRepos', listRepos),
  listSeededRepos: routed('listSeededRepos', listSeededRepos),
  repoInfo: routed('repoInfo', repoInfo),
  seeders: routed('seeders', seeders),
  // The handlers' reads on the add-on: on the service, the handlers read
  // through callStream instead (radicle-api-protocol.js).
  issues: routed('issues', issues),
  issue: routed('issue', issue),
  patches: routed('patches', patches),
  patch: routed('patch', patch),
  commits: routed('commits', commits),
  commit: routed('commit', commit),
  tree: routed('tree', tree),
  treeAt: routed('treeAt', treeAt),
  blob: routed('blob', blob),
  blobAt: routed('blobAt', blobAt),
  commitsRaw: routed('commitsRaw', commitsRaw),
  commitRaw: routed('commitRaw', commitRaw),
  treeAtRaw: routed('treeAtRaw', treeAtRaw),
  blobRaw: routed('blobRaw', blobRaw),
  blobAtRaw: routed('blobAtRaw', blobAtRaw),
  remotes: routed('remotes', remotes),
  repoStats: routed('repoStats', repoStats),
  buildRepoMeta: routed('buildRepoMeta', buildRepoMeta),
  readme: routed('readme', readme),
  readmeAt: routed('readmeAt', readmeAt),
  readmeAtRaw: routed('readmeAtRaw', readmeAtRaw),
};
