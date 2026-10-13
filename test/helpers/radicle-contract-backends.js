/* global jest */

/**
 * The backends the Radicle backend contract suite
 * (`src/main/radicle-backend.contract.test.js`, freedom-core design 0008,
 * "Tests first") runs against, chosen by `FREEDOM_RADICLE_CONTRACT_BACKEND`:
 *
 * - `addon`: today's libradicle v0.8.0 N-API add-on (`npm run
 *   radicle:download`), loaded by the production `radicle-embedded.js` from
 *   `radicle-bin/<platform>/`, and driven through the production
 *   `radicle-manager.js`, `radicle-api-protocol.js` and
 *   `radicle/rad-protocol.js`.
 * - `radicled` (design 0008 step 7): the freedom-radicled service. Not
 *   written yet; it gets an entry here, and the suite stays as it is.
 *
 * Each backend serves one Radicle home (`home`), restored from the
 * fixture's snapshot, and returns:
 *
 * - `manager`, `embedded`, `api` (`radicle-api-protocol.js`) and `rad`
 *   (`radicle/rad-protocol.js`), loaded together in one module registry;
 * - `readText(op, args)`: a `rad.read` op's JSON text, exactly as the
 *   backend produces it, or a rejection with its error's message. This is
 *   the contract boundary: the suite compares the text byte for byte. For
 *   the add-on, the reference for each class: a pass-through op is the
 *   export's own text; a serialized op is what main's `JSON.stringify`
 *   writes for the parsed result, as `serveRepoApi` does today; a composed
 *   op is what main's own code composes today. An error payload rejects
 *   with its message, as `radicle-embedded.js` does;
 * - `failNext(name, message)`: makes the next `embedded[name]()` call reject
 *   with `message`, for the contracts that hold when a read fails; it
 *   returns the function that undoes it;
 * - `stop()` and `close()`.
 *
 * Network operations are not part of the suite: `connectSeeds` and the
 * clones answer without dialling, and the home names no peer
 * (`radicle-fixture.js`). Nothing leaves the machine.
 *
 * `BACKENDS` lists, beside each loader, the design's features beyond
 * today's contract that the backend honours; the suite's tests for the
 * others are pending. Those tests use what only the service has:
 * - `call(method, params)` for its methods;
 * - in `embedded`: `callStream(op, args)`, `callScoped(op, args, callback,
 *   { signal })`, `collectionBudget()` (`{ held, limit }`, in bytes) and
 *   `streamStats()` (`{ streams, buffered }`: main's live streams and the
 *   bytes their rings hold). Failures carry the design's `code`;
 * - test hooks:
 *   - `hooks.holdRepair(rid)` holds a repository under repair until the
 *     function it returns is called;
 *   - `hooks.inflate(op, bytes)` makes the op's results that many bytes of
 *     JSON until the function it returns is called;
 *   - `hooks.scriptedClone(rid, { failures, reason })` runs a clone whose
 *     candidates fail as scripted, and resolves to the `rad.progress`
 *     envelopes main received, each exactly as encoded on the wire.
 */

const path = require('path');
const { loadMainModule } = require('./main-process-test-utils');

const SRC = path.join(__dirname, '..', '..', 'src', 'main');

/**
 * The design's features beyond today's contract (0008), each pending until
 * a backend honours it:
 * - `dirty-marker`: `node/dirty` is present for a whole run and cleared by a
 *   clean stop (Reconciliation);
 * - `quarantine`: `rad.quarantine_list` and `rad.remove_repo`, bound to a
 *   record's `qid` (the escape);
 * - `repository-gate`: COB reads answer 503 while a repository is repaired
 *   or quarantined, and its file reads keep working (the repository gate);
 * - `call-stream`: handlers' reads as a head and a body stream, with main
 *   holding one ring per stream, and `call-scoped`: collected results
 *   inside a scope, under their caps and the collection budget (JSON
 *   results);
 * - `size-caps`: a blob over 64 MiB is `too_large`, 413 at the handlers
 *   (deviation `size-caps`);
 * - `malformed-utf8`: a text blob that isn't valid UTF-8 reads as the
 *   lossy JSON text, byte for byte. Recorded against the service in its
 *   own step (the blob API: the JSON endpoint stays);
 * - `node-info`: the composed `node_info` read (Methods);
 * - `progress-summary`: clone progress past 8 peer failures folds into one
 *   summary, within 4 KiB, before the terminal event (Progress);
 * - `import-in-process`: an import leaves the working copy untouched
 *   (Writes);
 * - `blob-api`: `/raw/` with raw bytes, Range, HEAD and inert headers (the
 *   blob API).
 */
const FEATURES = [
  'dirty-marker',
  'quarantine',
  'repository-gate',
  'call-stream',
  'call-scoped',
  'node-info',
  'progress-summary',
  'import-in-process',
  'blob-api',
  'size-caps',
  'malformed-utf8',
];

/** The ops whose text is main's `JSON.stringify` of the parsed result. */
const SERIALIZED = new Set(['issue', 'patch', 'remotes', 'repo_stats']);

/** Whether parsed add-on output is its one-key error payload. */
const isErrorPayload = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'error' in value;

/** The add-on export, and its positional arguments, for each read op. */
const ADDON_READS = {
  repo_info: ({ rid }) => ['repoInfo', rid],
  tree: ({ rid, path: treePath = '' }) => ['tree', rid, treePath],
  tree_at: ({ rid, revision, path: treePath = '' }) => ['treeAt', rid, revision, treePath],
  blob: ({ rid, path: blobPath }) => ['blob', rid, blobPath],
  blob_at: ({ rid, revision, path: blobPath }) => ['blobAt', rid, revision, blobPath],
  commits: ({ rid, parent, page, per_page: perPage }) => ['commits', rid, parent, page, perPage],
  commit: ({ rid, revision }) => ['commit', rid, revision],
  issues: ({ rid }) => ['issues', rid],
  issue: ({ rid, id }) => ['issue', rid, id],
  patches: ({ rid }) => ['patches', rid],
  patch: ({ rid, id }) => ['patch', rid, id],
  list_repos: () => ['listRepos'],
  list_seeded_repos: () => ['listSeededRepos'],
  seeders: ({ rid }) => ['seeders', rid],
  identity: () => ['identity'],
  status: () => ['status'],
  remotes: ({ rid }) => ['remotes', rid],
  repo_stats: ({ rid, revision }) => ['repoStats', rid, revision],
};

const notDialled = () => new Error('network operations are not part of the contract suite');

async function loadAddonBackend({ home }) {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const { mod: manager } = loadMainModule(path.join(SRC, 'radicle-manager.js'), {
    extraMocks: {
      [path.join(SRC, 'logger.js')]: () => log,
      [path.join(SRC, 'profile-paths.js')]: () => ({
        getRadicleDataDir: () => home,
        prepareRadicleDataDir: async () => home,
      }),
      [path.join(SRC, 'profile-resolver.js')]: () => ({ getActiveProfile: () => null }),
      [path.join(SRC, 'core', 'node-identity-guard.js')]: () => ({ nodeBlockReason: () => null }),
      [path.join(SRC, 'service-registry.js')]: () => ({
        MODE: { EMBEDDED: 'embedded', DISABLED: 'disabled', NONE: 'none' },
        updateService: jest.fn(),
        setStatusMessage: jest.fn(),
        clearService: jest.fn(),
      }),
    },
  });
  const embedded = require(path.join(SRC, 'radicle-embedded.js'));
  if (!embedded.isAvailable()) {
    throw new Error(
      'FREEDOM_RADICLE_CONTRACT_BACKEND=addon needs the add-on: run npm run radicle:download'
    );
  }
  embedded.connectSeeds = async () => ({ connected: 0, attempted: 0, targetReached: false });
  embedded.cloneRepo = async () => {
    throw notDialled();
  };
  embedded.cloneRepoWithProgress = async () => {
    throw notDialled();
  };
  const api = require(path.join(SRC, 'radicle-api-protocol.js'));
  const rad = require(path.join(SRC, 'radicle', 'rad-protocol.js'));
  const addon = require(embedded.getAddonPath());

  // A handler answer's body, or a rejection with its error's message.
  const bodyOf = async (res) => {
    const text = await res.text();
    if (res.status !== 200) throw new Error(JSON.parse(text).error);
    return text;
  };
  // The page ops' query, from their raw `status`, `page` and `per_page`.
  const pageQuery = ({ status, page, per_page: perPage }) => {
    const params = new URLSearchParams();
    if (status !== null && status !== undefined) params.set('status', status);
    if (page !== null && page !== undefined) params.set('page', page);
    if (perPage !== null && perPage !== undefined) params.set('perPage', perPage);
    return params.toString();
  };
  // What main composes today, by its own code.
  const composed = {
    readme_at: async ({ rid, revision }) => {
      const text = await embedded.readmeAtRaw(rid, revision);
      if (text === null) throw new Error('no readme');
      return text;
    },
    repo_meta: async ({ rid }) => JSON.stringify(await embedded.buildRepoMeta(rid)),
    repos_meta: async () =>
      bodyOf(await api.handleRadicleApiRequest(new Request('radapi://local/api/v1/repos'))),
    issues_page: async (args) =>
      bodyOf(await api.serveRepoApi(args.rid, '/issues', { search: pageQuery(args) })),
    patches_page: async (args) =>
      bodyOf(await api.serveRepoApi(args.rid, '/patches', { search: pageQuery(args) })),
  };

  return {
    name: 'addon',
    home,
    manager,
    embedded,
    api,
    rad,
    log,
    async start() {
      const status = await manager.startRadicle();
      if (status.status !== 'running') {
        throw new Error(`the Radicle node did not start: ${status.error}`);
      }
    },
    async readText(op, args = {}) {
      if (composed[op]) return composed[op](args);
      const route = ADDON_READS[op];
      if (!route) throw new Error(`no add-on export for the read op ${op}`);
      const [name, ...positional] = route(args);
      const text = await addon[name](...positional);
      const value = JSON.parse(text);
      if (isErrorPayload(value)) throw new Error(value.error);
      return SERIALIZED.has(op) ? JSON.stringify(value) : text;
    },
    failNext(name, message) {
      const original = embedded[name];
      embedded[name] = async () => {
        embedded[name] = original;
        throw new Error(message);
      };
      return () => {
        embedded[name] = original;
      };
    },
    async stop() {
      await manager.stopRadicle();
    },
    async close() {
      await manager.stopRadicle();
    },
  };
}

/**
 * The backends, each with the features it honours. A feature's pending
 * tests run against a backend that lists it here.
 */
const BACKENDS = {
  addon: { load: loadAddonBackend, honours: [] },
};

/** The backend named by FREEDOM_RADICLE_CONTRACT_BACKEND, or null when unset. */
function contractBackendName() {
  const name = process.env.FREEDOM_RADICLE_CONTRACT_BACKEND || '';
  if (!name) return null;
  if (!BACKENDS[name]) {
    throw new Error(
      `FREEDOM_RADICLE_CONTRACT_BACKEND=${name} is not a backend: ${Object.keys(BACKENDS).join(', ')}`
    );
  }
  return name;
}

/**
 * The pending features a run turns on anyway (FREEDOM_RADICLE_CONTRACT_PENDING:
 * `all`, or a comma-separated list), to see what a backend still lacks.
 */
function forcedFeatures() {
  const value = process.env.FREEDOM_RADICLE_CONTRACT_PENDING || '';
  if (value === 'all') return new Set(FEATURES);
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!FEATURES.includes(name)) throw new Error(`unknown contract feature: ${name}`);
  }
  return new Set(names);
}

module.exports = {
  BACKENDS,
  FEATURES,
  contractBackendName,
  forcedFeatures,
};
