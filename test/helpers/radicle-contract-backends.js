/* global jest */

/**
 * The backends the Radicle backend contract suite
 * (`src/main/radicle-backend.contract.test.js`, freedom-core design 0008,
 * "Tests first") runs against, chosen by `FREEDOM_RADICLE_CONTRACT_BACKEND`:
 *
 * - `addon`: development builds' rollback, the libradicle v0.8.0 N-API
 *   add-on (`npm run radicle:download`), loaded by the production
 *   `radicle-embedded.js` from `radicle-bin/<platform>/`, and driven through
 *   the production `radicle-manager.js`, `radicle-api-protocol.js` and
 *   `radicle/rad-protocol.js` as `FREEDOM_RADICLE_BACKEND=addon` runs it.
 *   It needs freedom-radicled downloaded too (`npm run radicled:download`,
 *   or `FREEDOM_RADICLED_PATH`): the rollback runs only under the binary's
 *   `hold-lock` on its home (design 0008, Rollback), its gate here in a
 *   lock directory of the run's own, and its start is refused without it.
 * - `radicled` (design 0008 step 7), the default: the freedom-radicled
 *   service (`npm run
 *   radicled:download`, or `FREEDOM_RADICLED_PATH`), driven through the
 *   production `radicle-manager.js` and `radicle-embedded.js` under
 *   `FREEDOM_RADICLE_BACKEND=service`: the real node on the real binary,
 *   its reads through `callStream` and `callScoped`, its writes `rad.write`
 *   and `rad.unseed`, its import the one-shot import process (`importRepo`:
 *   the node stopped, the binary's `import` on the working copy, the node
 *   started again; plan B14). Its key is the
 *   fixture's, sealed to the process as the core's `nodes.seal_radicle_key`
 *   would seal it (`radicle-seal.js`), so the home holds no key file (the
 *   service refuses one: 0008, "The switch"). It runs under a SOCKS policy
 *   at a closed loopback port, and the manager's background seeds and
 *   clone answer without dialling: a clone would write a seeding policy
 *   into the fixture's home. With `{ networkOnBinary: true }` they run on
 *   the binary instead, for radicled-network.integration.test.js; nothing
 *   leaves the machine either way. Main's code for what it doesn't serve
 *   yet stays on the add-on (`lacks`).
 *
 * Each backend serves one Radicle home (`home`), restored from the
 * fixture's snapshot, and returns:
 *
 * - `manager`, `embedded`, `api` (`radicle-api-protocol.js`), `rad`
 *   (`radicle/rad-protocol.js`) and `admission` (main's dweb admission,
 *   `dweb/fetch-admission.js`, which the handlers take on the service),
 *   loaded together in one module registry;
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
 *   returns the function that undoes it. On the service, which composes
 *   `node_info` itself, the next `node_info` answers as the service does
 *   when that part fails: `listRepos` gives `repos_total: null` with the
 *   message as `repos_error`, and `status` fails the read, or the next
 *   `status` read, whichever comes first (radapi's `/` reads `status`
 *   alone);
 * - `getConnections()`: the manager's answer, as the vectors record it (on
 *   the service, without its diagnostics, `confinement` and `service`);
 * - `stop()` and `close()`.
 *
 * Network operations are not part of the suite: `connectSeeds` and the
 * clones answer without dialling, and the home names no peer
 * (`radicle-fixture.js`). Nothing leaves the machine.
 * radicled-network.integration.test.js runs them on the binary.
 *
 * `BACKENDS` lists, beside each loader:
 * - `honours`: the design's features beyond today's contract that the
 *   backend honours; the suite's tests for the others are pending;
 * - `lacks`: the parts of today's contract it doesn't serve (`PARTS`), not
 *   yet or not by design; their tests are skipped for it, named as such;
 * - `hooks`: the test hooks it has. A pending test that needs one it
 *   lacks is skipped too;
 * - `deviations`: the golden read vectors it answers otherwise, by design,
 *   by case: the design's deviation, why, and `differs(record, vector)`,
 *   which holds when its answer differs from the vector in that way and no
 *   other. A listed case that matches its vector fails, until it is
 *   removed from the list. `handlerDeviations(fx)` lists the handler
 *   vectors' the same way, for the fixture `fx`.
 *
 * The pending tests use what only the service has:
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

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { loadMainModule } = require('./main-process-test-utils');
const { fixtureSeed } = require('./radicle-fixture');
const { sealRadicleKey } = require('./radicle-seal');

const SRC = path.join(__dirname, '..', '..', 'src', 'main');

/**
 * Where main asks which backend runs (`radicleBackendKind`). Each loader
 * fixes the answer for the modules it loads, its own kind whatever
 * FREEDOM_RADICLE_BACKEND says later: main reads the switch at every call,
 * so two backends loaded in one process (the cost measurement,
 * `radicle-backend.cost.test.js`) would otherwise both follow the last
 * value set.
 */
const KIND_MODULE = path.join(SRC, 'radicle', 'radicle-backend-kind.js');

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

/**
 * The parts of today's contract, each a group of the suite's tests, that a
 * backend may not serve:
 * - `handlers`: the `rad:` and `radapi:` handlers' answers;
 * - `parsed-reads`: reads handed out as parsed values or as text, outside
 *   a scope: the handlers' (`tree`, `treeAt`, `blob`, `blobAt`, `commits`,
 *   `commit`, `issues`, `issue`, `patches`, `patch`, `remotes`,
 *   `repoStats`, the `*Raw` exports, `readme` and `readmeAt`), and the
 *   collected `repoInfo`, `seeders`, `listSeededRepos` and `listRepos`.
 *   The service streams the first (`callStream`), and parses the others
 *   only inside a scope (`callScoped`); only `identity` and `status` leave
 *   theirs, under 4 KiB;
 * - `network`: seeds, clones and their cancel;
 * - `writes`: the COB writes and unseeding;
 * - `import`: `importRepo`.
 */
const PARTS = ['handlers', 'parsed-reads', 'network', 'writes', 'import'];

/** The test hooks a pending test may need (see the module's doc). */
const HOOKS = ['holdRepair', 'inflate', 'scriptedClone'];

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
  // The home's gate, where the binary is there, goes in a lock directory of
  // the run's own, outside the home: made once the add-on is known to be
  // there (below), and removed by close().
  let lockDir = null;
  const { mod: manager } = loadMainModule(path.join(SRC, 'radicle-manager.js'), {
    extraMocks: {
      [path.join(SRC, 'logger.js')]: () => log,
      [path.join(SRC, 'service-locks.js')]: () => ({ getLockDir: () => lockDir }),
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
      [KIND_MODULE]: () => ({ radicleBackendKind: () => 'addon' }),
    },
  });
  const embedded = require(path.join(SRC, 'radicle-embedded.js'));
  if (!embedded.isAvailable()) {
    throw new Error(
      'FREEDOM_RADICLE_CONTRACT_BACKEND=addon needs the add-on: run npm run radicle:download'
    );
  }
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-radicle-contract-locks-'));
  embedded.connectSeeds = async () => ({ connected: 0, attempted: 0, targetReached: false });
  embedded.cloneRepo = async () => {
    throw notDialled();
  };
  embedded.cloneRepoWithProgress = async () => {
    throw notDialled();
  };
  const api = require(path.join(SRC, 'radicle-api-protocol.js'));
  const rad = require(path.join(SRC, 'radicle', 'rad-protocol.js'));
  const admission = require(path.join(SRC, 'dweb', 'fetch-admission.js'));
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
    lockDir,
    manager,
    embedded,
    api,
    rad,
    admission,
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
    getConnections: () => manager.getConnections(),
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
      fs.rmSync(lockDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** A loopback port nothing listens on: bound, then closed. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** The freedom-radicled binary a run uses: FREEDOM_RADICLED_PATH, or the
 * downloaded one for this platform. */
function radicledBinary() {
  if (process.env.FREEDOM_RADICLED_PATH) return process.env.FREEDOM_RADICLED_PATH;
  const os_ = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
  const name = process.platform === 'win32' ? 'freedom-radicled.exe' : 'freedom-radicled';
  return path.join(SRC, '..', '..', 'freedom-radicled-bin', `${os_}-${process.arch}`, name);
}

/** The arguments `rad.read` takes for a contract case's: the COB reads name
 * their ID by its kind. */
function serviceArgs(op, args) {
  if (op === 'issue') return { rid: args.rid, issue_id: args.id };
  if (op === 'patch') return { rid: args.rid, patch_id: args.id };
  return args;
}

/** A read's body as text. */
async function bodyText(body) {
  return Buffer.from(await new Response(body).arrayBuffer()).toString('utf8');
}

/** A `rad.read` reply of `text`, as the client hands one over. */
function readReply(text) {
  const bytes = Buffer.from(text);
  return {
    result: { content_type: 'application/json', bytes: bytes.length, body: true },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

async function loadRadicledBackend({ home, networkOnBinary = false }) {
  const binary = radicledBinary();
  if (!fs.existsSync(binary)) {
    throw new Error(
      'FREEDOM_RADICLE_CONTRACT_BACKEND=radicled needs freedom-radicled: run npm run ' +
        'radicled:download, or set FREEDOM_RADICLED_PATH'
    );
  }
  // Main's log, the service's lines among them, kept for a test that has
  // to say what happened (`recentLog`, `note`): the last 2000 lines.
  const logged = [];
  const keep =
    (level) =>
    (...parts) => {
      const text = parts
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
        .join(' ');
      logged.push(`${new Date().toISOString()} ${level} ${text}`);
      if (logged.length > 2000) logged.shift();
    };
  const log = {
    info: jest.fn(keep('info')),
    warn: jest.fn(keep('warn')),
    error: jest.fn(keep('error')),
    debug: jest.fn(),
  };
  // The service refuses a home with a key file: the key reaches the node
  // sealed instead, as from the core, and the home is as a switched one.
  fs.rmSync(path.join(home, 'keys'), { recursive: true, force: true });
  // Main's grant check compares canonical paths, and refuses a Windows short
  // name it can't (the runners' temporary directory has one): the real path.
  const realHome = fs.realpathSync.native(home);
  // The profile's directory, outside the home: the service's own HOME and
  // the run's lock directory. Removed by close().
  const userData = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-radicled-contract-'))
  );
  const ownHome = path.join(userData, 'radicled-home');
  const lockDir = path.join(userData, 'locks');
  fs.mkdirSync(lockDir);
  const network = { mode: 'socks5', ip: '127.0.0.1', port: await closedPort() };
  const seed = fixtureSeed();
  const env = {
    FREEDOM_RADICLE_BACKEND: process.env.FREEDOM_RADICLE_BACKEND,
    FREEDOM_RADICLED_PATH: process.env.FREEDOM_RADICLED_PATH,
  };
  process.env.FREEDOM_RADICLE_BACKEND = 'service';
  process.env.FREEDOM_RADICLED_PATH = binary;
  // The nodes the manager made, the last one current; and what the next
  // node_info answers instead, if anything (failNext).
  const nodes = [];
  let nodeInfoFailure = null;

  const { mod: manager } = loadMainModule(path.join(SRC, 'radicle-manager.js'), {
    userDataDir: userData,
    extraMocks: {
      [path.join(SRC, 'logger.js')]: () => log,
      [path.join(SRC, 'service-locks.js')]: () => ({ getLockDir: () => lockDir }),
      // The rest is the real profile's, which main's grant check reads.
      [path.join(SRC, 'profile-paths.js')]: () => ({
        ...jest.requireActual(path.join(SRC, 'profile-paths.js')),
        getRadicleDataDir: () => realHome,
        getRadicledHomeDir: () => ownHome,
        prepareRadicleDataDir: async () => realHome,
      }),
      [path.join(SRC, 'profile-resolver.js')]: () => ({ getActiveProfile: () => null }),
      [path.join(SRC, 'core', 'node-identity-guard.js')]: () => ({ nodeBlockReason: () => null }),
      [path.join(SRC, 'service-registry.js')]: () => ({
        MODE: { EMBEDDED: 'embedded', DISABLED: 'disabled', NONE: 'none' },
        updateService: jest.fn(),
        setStatusMessage: jest.fn(),
        clearService: jest.fn(),
      }),
      [KIND_MODULE]: () => ({ radicleBackendKind: () => 'service' }),
      [path.join(SRC, 'radicle', 'radicled-node.js')]: () => {
        const actual = jest.requireActual(path.join(SRC, 'radicle', 'radicled-node.js'));
        class ContractNode extends actual.RadicledNode {
          constructor(options) {
            super({
              ...options,
              network,
              // The fixture's key, sealed to this process's recipient.
              keys: {
                status: async () => ({ exists: true, unlocked: true }),
                seal: async (recipient) => sealRadicleKey(recipient, seed),
                switchHome: async () => {
                  throw new Error('the contract home holds no key file to switch');
                },
                onVaultEvent: () => () => {},
              },
              guard: { blockReason: () => null, block() {}, unblock() {} },
            });
            nodes.push(this);
          }

          // Not dialled: the suite runs no network operation, unless asked.
          async connectSeeds(timeoutMs, options) {
            if (networkOnBinary) return super.connectSeeds(timeoutMs, options);
            return { connected: 0, attempted: 0, targetReached: false };
          }

          async clone(rid, timeoutMs, options) {
            if (networkOnBinary) return super.clone(rid, timeoutMs, options);
            throw notDialled();
          }

          async read(op, args, options) {
            // The next node_info, or for a failed `status` the next status
            // read too (radapi's `/` reads it alone), answers the failure.
            const failure =
              op === 'node_info' || (op === 'status' && nodeInfoFailure?.name === 'status')
                ? nodeInfoFailure
                : null;
            if (!failure) return super.read(op, args, options);
            nodeInfoFailure = null;
            if (failure.name === 'status') {
              const { CoreError } = jest.requireActual(path.join(SRC, 'core', 'service-client.js'));
              throw new CoreError('failed', failure.message);
            }
            const { body } = await super.read(op, args, options);
            const info = JSON.parse(await bodyText(body));
            return readReply(
              JSON.stringify({ ...info, repos_total: null, repos_error: failure.message })
            );
          }
        }
        return { ...actual, RadicledNode: ContractNode };
      },
      // The import process takes the same key, sealed to its own recipient.
      [path.join(SRC, 'radicle', 'radicled-import.js')]: () => {
        const actual = jest.requireActual(path.join(SRC, 'radicle', 'radicled-import.js'));
        return {
          ...actual,
          runRadicledImport: (options) =>
            actual.runRadicledImport({
              ...options,
              keys: {
                status: async () => ({ exists: true, unlocked: true }),
                seal: async (recipient) => sealRadicleKey(recipient, seed),
                onVaultEvent: () => () => {},
              },
            }),
        };
      },
    },
  });
  const embedded = require(path.join(SRC, 'radicle-embedded.js'));
  const api = require(path.join(SRC, 'radicle-api-protocol.js'));
  const rad = require(path.join(SRC, 'radicle', 'rad-protocol.js'));
  const admission = require(path.join(SRC, 'dweb', 'fetch-admission.js'));
  const current = () => {
    const node = nodes.at(-1);
    const gen = node?.liveActive()?.gen;
    if (!gen) throw new Error('the Radicle node is not running');
    return { node, gen };
  };

  return {
    name: 'radicled',
    home,
    /** Main's last log lines, the service's among them. */
    recentLog: () => [...logged],
    /** A line of the test's own among them. */
    note: (text) => keep('note')(text),
    lockDir,
    manager,
    embedded,
    api,
    rad,
    admission,
    log,
    async start() {
      const status = await manager.startRadicle();
      if (status.status !== 'running') {
        throw new Error(`the Radicle node did not start: ${status.error}`);
      }
    },
    async readText(op, args = {}) {
      const { body } = await embedded.callStream(op, serviceArgs(op, args));
      return bodyText(body);
    },
    /** One of the service's methods on the running node, as main sends it. */
    call(method, params = {}) {
      const { node, gen } = current();
      return node.client.requestTo(
        gen,
        method,
        params,
        { caller: 'shell' },
        { watchdogMs: 75_000 }
      );
    },
    failNext(name, message) {
      if (name !== 'listRepos' && name !== 'status') {
        throw new Error(`failNext(${name}): the service composes node_info alone`);
      }
      nodeInfoFailure = { name, message };
      return () => {
        nodeInfoFailure = null;
      };
    },
    async getConnections() {
      const answer = await manager.getConnections();
      // The service's diagnostics, beside what the add-on answered.
      const { confinement, service, ...rest } = answer;
      if (answer.success) {
        if (!confinement || typeof service !== 'string') {
          throw new Error('getConnections on the service carries no diagnostics');
        }
      }
      return rest;
    },
    async stop() {
      await manager.stopRadicle();
    },
    async close() {
      try {
        await manager.stopRadicle();
      } finally {
        for (const [name, value] of Object.entries(env)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
  };
}

/** The unknown ID the COB vectors read. */
const UNKNOWN_COB = '0'.repeat(40);
/** v0.8.0's text for an unknown COB, as the vectors record it. */
const ADDON_COB_NOT_FOUND = `revspec '${UNKNOWN_COB}' not found; class=Reference (4); code=NotFound (-3)`;

/** Whether `record` is exactly `expected`, and `vector` exactly what v0.8.0
 * recorded, `recorded`: the one difference, pinned on both sides. */
const exactly = (expected, recorded) => (record, vector) =>
  isDeepStrictEqual(record, expected) && isDeepStrictEqual(vector, recorded);

/**
 * The golden read vectors freedom-radicled answers otherwise (see the
 * module's doc): each case, the deviation, why, and the only difference,
 * pinned to the service's exact record.
 */
const RADICLED_DEVIATIONS = {
  'commit second': {
    deviation: 'size-caps',
    reason:
      "The second commit adds the fixture's 70 MiB file. Its diff loads that blob, and the " +
      "service's walk charges what it loads to its 16 MiB budget for loads, so the read is " +
      'too_large (413 at the handlers), where v0.8.0 answered the diff.',
    // The vector's body is v0.8.0's diff, recorded; the service's answer is
    // the blob's exact size against the walk's 16 MiB of loads.
    differs: (record, vector) =>
      isDeepStrictEqual(record, { error: '73400320 bytes is over the limit of 16777216' }) &&
      Object.keys(vector).length === 1 &&
      typeof vector.body === 'string' &&
      vector.body.includes('"path":"big.bin","diff":{"type":"binary"}'),
  },
  // The libradicle the service links words an unknown COB's not-found
  // otherwise than v0.8.0 did: 404 at the handlers either way. To be named
  // in 0008 as `libradicle-text`.
  'issue unknown': {
    deviation: 'libradicle-text',
    reason:
      "An unknown issue is libradicle's not-found either way (404 at the handlers), worded " +
      "by the libradicle the service links, which names the COB it didn't find, where " +
      "v0.8.0's named the revspec it failed to resolve.",
    differs: exactly(
      { error: `node thread: issue ${UNKNOWN_COB} not found` },
      { error: ADDON_COB_NOT_FOUND }
    ),
  },
  'patch unknown': {
    deviation: 'libradicle-text',
    reason: "As for an unknown issue: libradicle's not-found, worded by the service's libradicle.",
    differs: exactly(
      { error: `node thread: patch ${UNKNOWN_COB} not found` },
      { error: ADDON_COB_NOT_FOUND }
    ),
  },
};

/**
 * The handlers' answers freedom-radicled gives otherwise, by design, for the
 * fixture `fx`: as RADICLED_DEVIATIONS, by handler vector.
 */
const radicledHandlerDeviations = (fx) => ({
  [`rad GET /commits/${fx.commits.second}`]: {
    deviation: 'size-caps',
    reason:
      "The second commit's diff is too_large on the service ('commit second' above), so the " +
      "handler answers 413 with main's fixed text, where v0.8.0 answered the diff.",
    // As JSON: a header entry is an array of another realm's (undici's).
    differs: (record, vector) =>
      JSON.stringify(record) ===
        JSON.stringify({
          status: 413,
          headers: vector.headers,
          body: JSON.stringify({ error: 'repository data too large to serve here' }),
        }) &&
      vector.status === 200 &&
      vector.body.includes('"path":"big.bin","diff":{"type":"binary"}'),
  },
});

/**
 * The backends, each with the features it honours. A feature's pending
 * tests run against a backend that lists it here. `handlerDeviations(fx)`
 * is `deviations`' for the handler vectors, whose names hold the fixture's
 * commits.
 */
const BACKENDS = {
  addon: {
    load: loadAddonBackend,
    honours: [],
    lacks: [],
    hooks: [],
    deviations: {},
    handlerDeviations: () => ({}),
  },
  // The release binary: no test hooks (they are a debug build's).
  radicled: {
    load: loadRadicledBackend,
    honours: [
      'call-stream',
      'call-scoped',
      'node-info',
      'dirty-marker',
      'quarantine',
      'size-caps',
      // Its test needs the scriptedClone hook (plan C4), which no release has.
      'progress-summary',
      'import-in-process',
    ],
    lacks: ['parsed-reads'],
    hooks: [],
    deviations: RADICLED_DEVIATIONS,
    handlerDeviations: radicledHandlerDeviations,
  },
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
  PARTS,
  HOOKS,
  contractBackendName,
  forcedFeatures,
};
