/**
 * Embedded Radicle node — napi addon wrapper. The node, repository reads,
 * seeding, identity and COB writes all run in-process.
 *
 * The addon is `libradicle.node`, built from the libradicle repo
 * (rad:z2SzCC9zYnP17QRPZUhrP2RTEwZHj). Load order:
 *   1. FREEDOM_RADICLE_ADDON env override (absolute path)
 *   2. resources/radicle-bin/libradicle.node (packaged app)
 *   3. radicle-bin/<platform>/libradicle.node (development prebuilt)
 *   4. ../libradicle/target/{release,debug}/libradicle.node (dev sibling)
 *
 * Every addon export resolves to a JSON string; this module parses them
 * and throws on `{error}` payloads so callers deal in plain objects.
 */

const log = require('./logger');
const path = require('path');
const fs = require('fs');
const {
  RADICLE_ADDON_VERSION,
  RADICLE_ADDON_REQUIRED_EXPORTS,
} = require('../shared/radicle-addon-version');

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

function candidatePaths() {
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

async function call(name, ...args) {
  const a = loadAddon();
  if (!a) throw new Error('radicle addon not available');
  const raw = await a[name](...args);
  return parseResult(raw);
}

function parseResult(raw) {
  const value = JSON.parse(raw);
  if (value && value.error) {
    throw new Error(value.error);
  }
  return value;
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

async function shutdown() {
  if (!started) return { ok: true };
  started = false;
  return call('shutdown');
}

function isStarted() {
  return started;
}

const connectSeeds = (timeoutMs = 15000) => call('connectSeeds', timeoutMs);
const cloneRepo = (rid, timeoutMs = 120000) => call('cloneRepo', rid, timeoutMs);
async function cloneRepoWithProgress(rid, timeoutMs = 120000, onProgress = () => {}) {
  const a = loadAddon();
  if (!a) throw new Error('radicle addon not available');
  const raw = await a.cloneRepoWithProgress(rid, timeoutMs, (eventRaw) => {
    try {
      onProgress(JSON.parse(eventRaw));
    } catch (err) {
      log.warn('[RadicleEmbedded] Ignoring invalid clone progress event:', err.message);
    }
  });
  return parseResult(raw);
}
const cancelClone = (rid) => call('cancelClone', rid);
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
const repoInfo = (rid) => call('repoInfo', rid);
const commits = (rid, parent, page = 0, perPage = 30) =>
  call('commits', rid, parent, page, perPage);
const commit = (rid, revision) => call('commit', rid, revision);
const tree = (rid, treePath = '') => call('tree', rid, treePath);
const treeAt = (rid, revision, treePath = '') => call('treeAt', rid, revision, treePath);
const blob = (rid, blobPath) => call('blob', rid, blobPath);
const blobAt = (rid, revision, blobPath) => call('blobAt', rid, revision, blobPath);
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
    log.warn('[RadicleEmbedded] seeders() failed:', err.message);
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

async function readmeAt(rid, revision) {
  const { entries } = revision ? await treeAt(rid, revision, '') : await tree(rid, '');
  const names = new Set(entries.filter((e) => e.kind === 'blob').map((e) => e.name));
  for (const candidate of README_CANDIDATES) {
    if (names.has(candidate)) {
      const result = revision ? await blobAt(rid, revision, candidate) : await blob(rid, candidate);
      return { ...result, path: candidate };
    }
  }
  return null;
}

module.exports = {
  candidatePaths,
  REQUIRED_EXPORTS,
  isAvailable,
  getAddonPath,
  getVersion,
  start,
  shutdown,
  isStarted,
  connectSeeds,
  cloneRepo,
  cloneRepoWithProgress,
  cancelClone,
  unseedRepo,
  listRepos,
  listSeededRepos,
  issues,
  issue,
  patches,
  patch,
  identity,
  createIssue,
  commentIssue,
  editIssueState,
  commentPatch,
  importRepo,
  repoInfo,
  commits,
  commit,
  tree,
  treeAt,
  blob,
  blobAt,
  remotes,
  repoStats,
  status,
  seeders,
  buildRepoMeta,
  readme,
  readmeAt,
};
