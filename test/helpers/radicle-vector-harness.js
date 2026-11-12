/**
 * Test-only harness for freedom-core's Radicle vectors
 * (`vectors/radicle-*.json`), which `src/main/radicle/radicle-vectors.test.js`
 * replays against today's main.
 *
 * freedom-core's generator (`vectors/generator/radicle-*.js`) recorded each
 * vector's `main` from this repository's own modules at its reference
 * commit: `radicle-embedded.js`, `radicle-api-protocol.js`,
 * `radicle-manager.js`, `radicle/seed-status.js` and `github-bridge.js`, over
 * a scripted add-on. This harness rebuilds the same world around the same
 * modules as they are now, so a case's answer can be compared with the
 * recorded one:
 *
 * - each module is loaded from its source with the generator's stubs for its
 *   own requires, and with the functions the generator calls appended to its
 *   exports (`__internals`), as the generator's `loadWithInternals`
 *   (`vectors/generator/naming.js`) does. Nothing else it requires is
 *   stubbed: those modules load as they are, through jest's registry;
 * - the add-on is scripted: each export main calls, its arguments, and the
 *   JSON text it returns, synchronously, as the generator's add-on answers.
 *   An unscripted call answers `{"error": "unscripted <name>"}` and is
 *   recorded; so is a scripted answer never read;
 * - the logs, `Date.now`, `git`, GitHub's API and the profile's directories
 *   are the generator's, file by file (see each loader).
 *
 * The world has to be the generator's to the microtask: the vectors pin the
 * order of main's add-on calls, which concurrent work interleaves. So the
 * add-on answers synchronously, as the generator's does, and the loaders keep
 * its load order (a file's first case loads the add-on, and logs it).
 *
 * **On the service path** (the radicled plan's B7 on): the same modules with
 * `FREEDOM_RADICLE_BACKEND=service`, over a fake service node whose
 * `rad.read` answers each op with the vector's service text (its `expect`,
 * or the reference's body for the other ops): `loadServiceReadsMain`, with
 * `runServiceNodeInfo` for `node_info`'s `connections` (B7), and
 * `runServiceRead` and `runServiceBlob` for the radapi handlers' answers
 * (B8); and `loadServiceNetworkMain`, a fake service node whose
 * `rad.connect_seeds` and `rad.clone` answer what each `radicle-network.json`
 * case scripts, the clone's progress as the texts of its `rad.progress`
 * events (B9: `runServiceReport`, `runServiceProgress`, `runServiceQueue`
 * and `runServiceResult`).
 *
 * Lives under `test/helpers/` (outside `src/**`) so electron-builder never
 * packages it.
 */

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..');

/** Where main looks for the add-on: FREEDOM_RADICLE_ADDON, which the stubbed
 * `fs` says exists, and whose `require` answers with the script. */
const ADDON = '/freedom-core-vectors/libradicle.node';

/** The generators' fixture repository and revision (`radicle-reads.json`'s
 * `constants`), which `radicle-blob.json` and `radicle-network.json` use
 * too. */
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const REV = 'a'.repeat(40);
/** The repository `connectAndSeedDefault` clones. */
const FREEDOM_BROWSER_RID = 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE';

const errorText = (message) => JSON.stringify({ error: message });
const join = (parts) => parts.map((part) => String(part)).join(' ');
/** What JSON keeps of a value: the form the vectors record. */
const asJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * Loads `rel` from this repository with `stubs` for its own requires (by
 * request string), `internals` appended to its exports as `__internals`, and
 * `extra` appended after that, in the module's scope.
 */
function loadWithInternals(rel, internals, stubs, extra = '') {
  const filename = path.join(ROOT, rel);
  const dirname = path.dirname(filename);
  const source = fs.readFileSync(filename, 'utf8');
  const exposed = `\n;module.exports.__internals = { ${internals.join(', ')} };\n${extra}`;
  const resolve = (request) =>
    request.startsWith('./') || request.startsWith('../')
      ? path.resolve(dirname, request)
      : request;
  const localRequire = (request) =>
    Object.hasOwn(stubs, request) ? stubs[request] : require(resolve(request));
  localRequire.resolve = (request) => require.resolve(resolve(request));
  const mod = { exports: {}, filename, id: filename, loaded: false };
  const compiled = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    `${source}${exposed}\n//# sourceURL=${filename}`
  );
  compiled.call(mod.exports, mod.exports, localRequire, mod, filename, dirname);
  mod.loaded = true;
  return mod.exports;
}

/**
 * The scripted add-on: every export is a function of `world.script`.
 * - `reuse`: an entry answers every matching call (`radicle-reads.js`), or
 *   only the first one not yet answered (`radicle-network.js`,
 *   `radicle-import.js`);
 * - `background`: answers for exports the script doesn't list
 *   (`radicle-network.js`'s peer count and repositories).
 * A function argument is recorded as `<callback>`; an entry with `events`
 * hands each to it before the call returns, as the add-on's
 * ThreadsafeFunction delivers a clone's progress.
 */
function scriptedAddon(world, { reuse = false, background = null } = {}) {
  const answer = (name, args) => {
    const shown = args.map((arg) => (typeof arg === 'function' ? '<callback>' : arg));
    world.calls.push({ export: name, args: shown });
    const found = world.script.find(
      (entry) =>
        entry.export === name && util.isDeepStrictEqual(entry.args, shown) && (reuse || !entry.used)
    );
    if (!found) {
      if (background && Object.hasOwn(background, name)) return background[name];
      world.unscripted.push({ export: name, args: shown });
      return errorText(`unscripted ${name}`);
    }
    found.used = true;
    if (found.events) {
      const callback = args.at(-1);
      for (const event of found.events) callback(event);
    }
    return found.text;
  };
  return new Proxy(
    {},
    { get: (_, name) => (typeof name === 'string' ? (...args) => answer(name, args) : undefined) }
  );
}

function loadEmbedded(log, addon) {
  return loadWithInternals('src/main/radicle-embedded.js', [], {
    './logger': log,
    fs: { ...fs, existsSync: (p) => p === ADDON || fs.existsSync(p) },
    [ADDON]: addon,
  });
}

const managerStubs = (log, embedded, seedStatus) => ({
  electron: {
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    BrowserWindow: { getAllWindows: () => [] },
  },
  './logger': log,
  './radicle-embedded': embedded,
  './profile-paths': {
    getRadicleDataDir: () => '/nonexistent',
    prepareRadicleDataDir: () => '/nonexistent',
  },
  './profile-resolver': { getActiveProfile: () => null },
  './radicle/seed-status': seedStatus,
  './service-registry': { MODE: {}, updateService() {}, setStatusMessage() {}, clearService() {} },
});
const SET_RUNNING = 'module.exports.__setRunning = () => { currentState = STATUS.RUNNING; };';

/** The add-on calls left over from a case: unscripted ones, and scripted
 * answers never read. */
const leftovers = (world) => ({
  unscripted: world.unscripted,
  unread: world.script
    .filter((entry) => !entry.used)
    .map(({ export: name, args }) => ({ export: name, args })),
});

function resetWorld(world, script) {
  world.script = script.map((entry) => ({ ...entry }));
  world.calls = [];
  world.warnings = [];
  world.infos = [];
  world.unscripted = [];
}

// ---- radicle-reads.json and radicle-blob.json (radicle-reads.js' loadMain) ----

/** Main's radapi handlers and manager over a scripted add-on; the log keeps
 * warnings only. */
function loadReadsMain() {
  const world = { script: [], calls: [], warnings: [], infos: [], unscripted: [] };
  const addon = scriptedAddon(world, { reuse: true });
  const log = {
    info() {},
    debug() {},
    error() {},
    log() {},
    warn: (...parts) => world.warnings.push(join(parts)),
  };
  const embedded = loadEmbedded(log, addon);
  const protocol = loadProtocol(log, embedded);
  const manager = loadWithInternals(
    'src/main/radicle-manager.js',
    [],
    managerStubs(log, embedded, {}),
    SET_RUNNING
  );
  return { world, protocol, manager };
}

/** Main's radapi handlers (`radicle-api-protocol.js`) over `embedded`, the
 * generator's stubs around them. */
function loadProtocol(log, embedded) {
  return loadWithInternals(
    'src/main/radicle-api-protocol.js',
    ['serveRepoApi', 'serveNodeApi', 'handleRadicleApiRequest'],
    {
      './logger': log,
      './radicle-embedded': embedded,
      './radicle-manager': { isDisabledForProfile: () => false },
      './webrequest-dispatcher': { registerWebRequestHandler() {} },
      './private/private-log-context': {
        runWithPrivateLogContext: (_, fn) => fn(),
        redactForLog: (value) => value,
      },
    }
  ).__internals;
}

const answered = async (response) => ({ status: response.status, body: await response.text() });

/**
 * A `radicle-reads.json` case's handler answer, as the generator asks for
 * it: the radapi endpoint of its op (serveRepoApi with allowPrivate, or the
 * `/api/v1/repos` listing), `{ status, body }`; for `node_info`, `{ root,
 * stats }` (serveNodeApi's `/` and `/api/v1/stats`).
 */
async function throughHandlers(protocol, c) {
  const repo = (apiPath, search = '') =>
    protocol.serveRepoApi(RID, apiPath, { search, allowPrivate: true }).then(answered);
  switch (c.op) {
    case 'readme_at':
      return repo(`/readme/${c.args.revision}`);
    case 'repo_meta':
      return repo('');
    case 'repos_meta':
      return protocol
        .handleRadicleApiRequest({
          url: 'radapi://local/api/v1/repos',
          method: 'GET',
          referrer: '',
        })
        .then(answered);
    case 'issues_page':
      return repo('/issues', c.query);
    case 'patches_page':
      return repo('/patches', c.query);
    case 'issue':
      return repo(`/issues/${c.args.issue_id}`);
    case 'patch':
      return repo(`/patches/${c.args.patch_id}`);
    case 'remotes':
      return repo('/remotes');
    case 'repo_stats':
      return repo(`/stats/tree/${c.args.revision}`);
    case 'node_info': {
      const root = await protocol.serveNodeApi('/').then(answered);
      const stats = await protocol.serveNodeApi('/api/v1/stats').then(answered);
      return { root, stats };
    }
    default:
      throw new Error(`no op ${c.op}`);
  }
}

/** A `radicle-reads.json` case through main: its `main`, and the add-on
 * calls left over. */
async function runRead(main, c) {
  const { world, protocol, manager } = main;
  resetWorld(world, c.addon);
  let result = await throughHandlers(protocol, c);
  if (c.op === 'node_info') {
    manager.__setRunning();
    result = { ...result, connections: await manager.getConnections() };
  }
  return {
    main: asJson({ ...result, calls: world.calls, warnings: world.warnings }),
    ...leftovers(world),
  };
}

// ---- radicle-reads.json on the service path (the radicled plan's B7) ----

/** The libradicle build a fake service node reports (freedom-radicled
 * v0.1.0's hello reports 0.8.0). */
const SERVICE_LIBRADICLE = '0.8.0';
const SET_SERVICE_NODE =
  'module.exports.__setServiceNode = (node) => { serviceNode = node; ' +
  'embedded.setServiceNodeSource(() => serviceNode); currentState = STATUS.RUNNING; };';

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

/**
 * Main's manager and radapi handlers on the service path, its node running:
 * a fake service node whose `rad.read` answers what `world.reads` scripts,
 * by op (`{ body }`, or `{ error: { code, message } }`, `code` `failed`
 * unless given); the log keeps warnings only. Call within
 * FREEDOM_RADICLE_BACKEND=service.
 */
function loadServiceReadsMain() {
  const world = { script: [], calls: [], warnings: [], infos: [], unscripted: [], reads: {} };
  const addon = scriptedAddon(world, { reuse: true });
  const log = {
    info() {},
    debug() {},
    error() {},
    log() {},
    warn: (...parts) => world.warnings.push(join(parts)),
  };
  const embedded = loadEmbedded(log, addon);
  const { CoreError } = require(path.join(ROOT, 'src/main/core/service-client.js'));
  const node = {
    generation: 1,
    version: SERVICE_LIBRADICLE,
    confinement: { mechanism: 'test' },
    buildInfo: () => ({ service: { version: '0.1.0' } }),
    streamStats: () => null,
    async read(op, args) {
      world.calls.push({ op, args });
      const answer = Object.hasOwn(world.reads, op) ? world.reads[op] : null;
      if (!answer) {
        world.unscripted.push({ op, args });
        throw new CoreError('failed', `unscripted ${op}`);
      }
      if (answer.error) throw new CoreError(answer.error.code ?? 'failed', answer.error.message);
      return readReply(answer.body);
    },
  };
  const manager = loadWithInternals(
    'src/main/radicle-manager.js',
    [],
    managerStubs(log, embedded, {}),
    SET_SERVICE_NODE
  );
  manager.__setServiceNode(node);
  return { world, manager, node, protocol: loadProtocol(log, embedded) };
}

/** A `radicle-reads.json` `node_info` case through the manager on the
 * service: `getConnections` over the case's `expect`, the reads it sent,
 * and what it logged. */
async function runServiceNodeInfo(main, c) {
  const { world, manager } = main;
  resetWorld(world, []);
  world.reads = { node_info: c.expect };
  const connections = await manager.getConnections();
  return asJson({
    connections,
    calls: world.calls,
    warnings: world.warnings,
    unscripted: world.unscripted,
  });
}

/** libradicle's text for a read past one of its byte bounds, which the
 * service answers `too_large` (0008, Errors; deviation `size-caps`). */
const TOO_LARGE_TEXT = /^\d+ bytes is over the limit of \d+$/;

/**
 * What the service answers for a `radicle-reads.json` case whose reference
 * answered `recorded` (`{ status, body }`): for a 200, the same text (the
 * service writes each op's bytes as main did: 0008, Parity); for a failure,
 * the code the service gives the add-on's error: `too_large` for a byte
 * bound, else `not_found` or `failed` by the reference's 404 or 500, which
 * is today's message test (or, for `no readme`, main's own 404).
 */
function serviceAnswer(recorded) {
  if (recorded.status === 200) return { body: recorded.body };
  const { error: message } = JSON.parse(recorded.body);
  let code = recorded.status === 404 ? 'not_found' : 'failed';
  if (TOO_LARGE_TEXT.test(message)) code = 'too_large';
  return { error: { code, message } };
}

/**
 * A `radicle-reads.json` case through main's radapi handlers on the
 * service: the same endpoint as `runRead`, over a fake service node that
 * answers the case's op as the service would (`serviceAnswer`), and, for
 * `node_info`, its `status` as the add-on's text (a pass-through op) and
 * `node_info` as the case's `expect`. The answer, the reads sent, and what
 * main logged.
 */
async function runServiceRead(main, c) {
  const { world, protocol } = main;
  resetWorld(world, []);
  if (c.op === 'node_info') {
    const status = c.addon.find((entry) => entry.export === 'status');
    const value = JSON.parse(status.text);
    world.reads = {
      status: value?.error ? { error: { message: value.error } } : { body: status.text },
      node_info: c.expect,
    };
  } else {
    world.reads = { [c.op]: serviceAnswer(c.main) };
  }
  const result = await throughHandlers(protocol, c);
  return asJson({
    main: result,
    calls: world.calls,
    warnings: world.warnings,
    unscripted: world.unscripted,
  });
}

/** A `radicle-blob.json` file's or error's `/blob/<rev>/<path>` answer on
 * the service: `blob_at` answered with `answer` (`{ body }` or `{ error:
 * { code, message } }`), and the reads sent. */
async function runServiceBlob(main, answer, filePath) {
  const { world, protocol } = main;
  resetWorld(world, []);
  world.reads = { blob_at: answer };
  const response = await protocol.serveRepoApi(RID, `/blob/${REV}/${filePath}`, {
    allowPrivate: true,
  });
  return asJson({
    main: await answered(response),
    calls: world.calls,
    warnings: world.warnings,
    unscripted: world.unscripted,
  });
}

/** The add-on's `blobAt` text for a `radicle-blob.json` file (libradicle's
 * `json::blob`): its name, and its content as UTF-8 unless it is binary. */
function blobText(file) {
  const name = file.path.split('/').pop();
  return file.binary
    ? JSON.stringify({ binary: true, name })
    : JSON.stringify({
        binary: false,
        name,
        content: Buffer.from(file.hex, 'hex').toString('utf8'),
      });
}

/** Main's `/blob/<rev>/<path>` answer over one scripted `blobAt`. */
async function runBlob(main, addonText, filePath) {
  const { world, protocol } = main;
  resetWorld(world, [{ export: 'blobAt', args: [RID, REV, filePath], text: addonText }]);
  const response = await protocol.serveRepoApi(RID, `/blob/${REV}/${filePath}`, {
    allowPrivate: true,
  });
  return { main: await answered(response), ...leftovers(world) };
}

// ---- radicle-network.json and radicle-stats.json (radicle-network.js' loadMain) ----

/** What main asks besides a case's own calls: its peer count and its
 * repositories, for the node info it publishes. */
const BACKGROUND = { status: JSON.stringify({ connectedPeers: 2 }), listRepos: '[]' };

/** Main's manager and seed status over a scripted add-on, its node running;
 * the log keeps info and warning lines. */
function loadNetworkMain() {
  const world = { script: [], calls: [], warnings: [], infos: [], unscripted: [] };
  const addon = scriptedAddon(world, { background: BACKGROUND });
  const log = {
    debug() {},
    error() {},
    log() {},
    info: (...parts) => world.infos.push(join(parts)),
    warn: (...parts) => world.warnings.push(join(parts)),
  };
  const embedded = loadEmbedded(log, addon);
  const seedStatus = loadWithInternals('src/main/radicle/seed-status.js', [], { '../logger': log });
  const manager = loadWithInternals(
    'src/main/radicle-manager.js',
    ['connectAndSeedDefault', 'seedRepository', 'getConnections'],
    managerStubs(log, embedded, seedStatus),
    SET_RUNNING
  );
  manager.__setRunning();
  return { world, manager: manager.__internals, seedStatus };
}

/** Lets every queued callback and timer of main's run. */
const settle = async () => {
  for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
};

/** Runs `run` over `script`, `Date.now` counting up by one from
 * 1700000000000; what it returned with the calls and log lines, and the add-on
 * calls left over. */
async function runNetwork(main, script, run) {
  const { world } = main;
  // Each case starts with no fetch on record.
  main.seedStatus._reset();
  resetWorld(world, script);
  const realNow = Date.now;
  let now = 1700000000000;
  Date.now = () => (now += 1);
  try {
    const result = await run();
    await settle();
    return {
      main: asJson({ ...result, calls: world.calls, infos: world.infos, warnings: world.warnings }),
      ...leftovers(world),
    };
  } finally {
    Date.now = realNow;
  }
}

/** A `radicle-network.json` report: `connectAndSeedDefault` over the
 * report's text, the default repository's clone and the live count. */
function runReport(main, c) {
  const script = [{ export: 'connectSeeds', args: [15000], text: c.text }];
  if (!c.libradicle) {
    script.push({ export: 'cloneRepo', args: [FREEDOM_BROWSER_RID, 120000], text: '{"ok":true}' });
  }
  if (c.status !== undefined) {
    script.push({ export: 'status', args: [], text: JSON.stringify({ connectedPeers: c.status }) });
  }
  return runNetwork(main, script, async () => {
    await main.manager.connectAndSeedDefault();
    return {};
  });
}

const cloneEntry = (text, events) => ({
  export: 'cloneRepoWithProgress',
  args: [RID, 120000, '<callback>'],
  text,
  events,
});

/** A `radicle-network.json` clone's progress: every status `seedRepository`
 * published. */
function runProgress(main, c) {
  const script = [
    cloneEntry(
      c.result_text,
      c.events.map((event) => event.text)
    ),
  ];
  if (JSON.parse(c.result_text).ok) {
    script.push({ export: 'seeders', args: [RID], text: JSON.stringify({ seeding: 2 }) });
  }
  const statuses = [];
  return runNetwork(main, script, async () => {
    const started = await main.manager.seedRepository(RID, (status) =>
      statuses.push(asJson(status))
    );
    if (started.success !== true) throw new Error(`${c.id}: seedRepository refused`);
    await started.status.done;
    return { statuses };
  });
}

/** A `radicle-network.json` clone's end: the last status `seedRepository`
 * published. */
function runResult(main, c) {
  const script = [cloneEntry(c.result_text ?? c.text, [])];
  if (c.result_text !== undefined) {
    script.push({ export: 'seeders', args: [RID], text: JSON.stringify({ seeding: 1 }) });
  }
  const statuses = [];
  return runNetwork(main, script, async () => {
    const started = await main.manager.seedRepository(RID, (status) =>
      statuses.push(asJson(status))
    );
    await started.status.done;
    return { final: statuses.at(-1) };
  });
}

/** A `radicle-stats.json` connection count: `getConnections` over the
 * add-on's `status`. */
function runConnections(main, c) {
  return runNetwork(main, [{ export: 'status', args: [], text: c.status_text }], async () => ({
    connections: await main.manager.getConnections(),
  }));
}

// ---- radicle-network.json on the service path (the radicled plan's B9) ----

/**
 * How the service answers a clone it doesn't answer itself (the vectors'
 * `nothing`): its deadline, or its stop, as freedom-radicled's pools word
 * them.
 */
const SERVICE_ENDINGS = Object.freeze({
  deadline: Object.freeze({ code: 'deadline', message: 'past its deadline' }),
  stop: Object.freeze({ code: 'stopped', message: 'the Radicle service is stopping' }),
});

/** The service's code for libradicle's error `message` (0008, Errors):
 * `not_found` when today's message test matches it, else `failed`. */
const serviceErrorCode = (message) =>
  /not found|does not exist|NotFound/i.test(message) ? 'not_found' : 'failed';

/** A clone's answer for the add-on's result text: `{ result }`, or `{ error
 * }` with the service's code. */
function cloneAnswer(text) {
  const value = JSON.parse(text);
  if (typeof value?.error === 'string') {
    return { error: { code: serviceErrorCode(value.error), message: value.error } };
  }
  return { result: value };
}

/**
 * Main's manager and seed status on the service path, its node running: a
 * fake service node whose `rad.connect_seeds` answers `world.seeds` (`{
 * result }` or `{ error: { code, message, data } }`), each `rad.clone` the
 * next of `world.clones` (`{ events, answer }`: its events' texts, handed to
 * the clone's callback in order before its answer, as the service writes
 * them), and `rad.read` the node info (`world.peers` connected, no
 * repository) and `seeders` (`world.seeding`). The peer count after the
 * seeds is the node's stats', `world.peers`. The log keeps info and warning
 * lines. Call within FREEDOM_RADICLE_BACKEND=service.
 */
function loadServiceNetworkMain() {
  const world = {
    script: [],
    calls: [],
    warnings: [],
    infos: [],
    unscripted: [],
    seeds: null,
    clones: [],
    peers: 2,
    seeding: 2,
  };
  // An add-on that must never be called: any call is unscripted.
  const addon = scriptedAddon(world);
  const log = {
    debug() {},
    error() {},
    log() {},
    info: (...parts) => world.infos.push(join(parts)),
    warn: (...parts) => world.warnings.push(join(parts)),
  };
  const embedded = loadEmbedded(log, addon);
  const seedStatus = loadWithInternals('src/main/radicle/seed-status.js', [], { '../logger': log });
  const { CoreError } = require(path.join(ROOT, 'src/main/core/service-client.js'));
  const answer = (scripted) =>
    scripted.error
      ? Promise.reject(
          new CoreError(scripted.error.code, scripted.error.message, scripted.error.data)
        )
      : Promise.resolve(scripted.result);
  const node = {
    generation: 1,
    version: SERVICE_LIBRADICLE,
    confinement: { mechanism: 'test' },
    buildInfo: () => ({ service: { version: '0.1.0' } }),
    streamStats: () => null,
    connectedPeers: () => world.peers,
    async read(op, args) {
      world.calls.push({ op, args });
      if (op === 'node_info') {
        return readReply(
          JSON.stringify({ connected_peers: world.peers, repos_total: 0, repos_error: null })
        );
      }
      if (op === 'seeders') return readReply(JSON.stringify({ seeding: world.seeding }));
      world.unscripted.push({ op, args });
      throw new CoreError('failed', `unscripted ${op}`);
    },
    connectSeeds(timeoutMs) {
      world.calls.push({ method: 'rad.connect_seeds', params: { timeout_ms: timeoutMs } });
      if (!world.seeds) {
        world.unscripted.push({ method: 'rad.connect_seeds' });
        return Promise.reject(new CoreError('failed', 'unscripted rad.connect_seeds'));
      }
      return answer(world.seeds);
    },
    clone(rid, timeoutMs, { onProgress = null } = {}) {
      world.calls.push({
        method: 'rad.clone',
        params: { rid, timeout_ms: timeoutMs, progress: typeof onProgress === 'function' },
      });
      const scripted = world.clones.shift();
      if (!scripted) {
        world.unscripted.push({ method: 'rad.clone', rid });
        return Promise.reject(new CoreError('failed', 'unscripted rad.clone'));
      }
      for (const text of scripted.events ?? []) onProgress?.(text);
      return answer(scripted.answer);
    },
  };
  const manager = loadWithInternals(
    'src/main/radicle-manager.js',
    ['connectAndSeedDefault', 'serviceNetwork', 'seedRepository'],
    managerStubs(log, embedded, seedStatus),
    SET_SERVICE_NODE
  );
  manager.__setServiceNode(node);
  return { world, manager: manager.__internals, seedStatus, node };
}

/** Runs `run` on the service path with `setup(world)` applied, `Date.now`
 * counting as `runNetwork`'s does: what it returned with the calls and log
 * lines, and what was unscripted or left unanswered. */
async function runServiceNetwork(main, setup, run) {
  const { world } = main;
  main.seedStatus._reset();
  resetWorld(world, []);
  Object.assign(world, { seeds: null, clones: [], peers: 2, seeding: 2 });
  setup(world);
  const realNow = Date.now;
  let now = 1700000000000;
  Date.now = () => (now += 1);
  try {
    const result = await run();
    await settle();
    return {
      main: asJson({ ...result, calls: world.calls, infos: world.infos, warnings: world.warnings }),
      unscripted: world.unscripted,
      // Scripted clones never asked for.
      unanswered: world.clones.length,
    };
  } finally {
    Date.now = realNow;
  }
}

/** A `radicle-network.json` report on the service path: the background
 * network start over the service's answer (`expect`), the default
 * repository's clone and the node's peer count (`status`, else 2). */
function runServiceReport(main, c) {
  return runServiceNetwork(
    main,
    (world) => {
      world.seeds = c.expect.error
        ? { error: c.expect.error }
        : { result: JSON.parse(c.expect.result_text) };
      if (c.status !== undefined) world.peers = c.status;
      if (!c.expect.error) world.clones = [{ answer: { result: { ok: true } } }];
    },
    async () => {
      await main.manager.connectAndSeedDefault(main.manager.serviceNetwork(main.node));
      return {};
    }
  );
}

/** A clone through `seedRepository` on the service path: every status it
 * published. */
async function seedThrough(main) {
  const statuses = [];
  const started = await main.manager.seedRepository(RID, (status) =>
    statuses.push(asJson(status))
  );
  if (started.success !== true) throw new Error('seedRepository refused');
  await started.status.done;
  return statuses;
}

/** A `radicle-network.json` clone's progress on the service path: its
 * events' texts, then its result, and every status `seedRepository`
 * published. */
function runServiceProgress(main, c) {
  return runServiceNetwork(
    main,
    (world) => {
      world.clones = [
        { events: c.events.map((event) => event.text), answer: cloneAnswer(c.result_text) },
      ];
    },
    async () => ({ statuses: await seedThrough(main) })
  );
}

/**
 * A `radicle-network.json` `queue` case on the service path: the envelopes
 * the service wrote (`written`), each a `rad.progress` event of one clone,
 * handed to its callback in order; then the answer its terminal event
 * implies (`done`: `{ ok: true }`, `cancelled`: `{ cancelled: true }`,
 * `failed`: libradicle's error; none: `{ ok: true }`). Every status
 * `seedRepository` published, and the events' texts.
 */
function runServiceQueue(main, c) {
  const events = c.written.map((envelope) => JSON.parse(envelope).data.event);
  const last = JSON.parse(events.at(-1));
  let answerOf = { result: { ok: true } };
  if (last.phase === 'cancelled') answerOf = { result: { cancelled: true } };
  if (last.phase === 'failed') {
    answerOf = { error: { code: serviceErrorCode(last.reason), message: last.reason } };
  }
  return runServiceNetwork(
    main,
    (world) => {
      world.clones = [{ events, answer: answerOf }];
    },
    async () => ({ statuses: await seedThrough(main), events })
  );
}

/**
 * A `radicle-network.json` clone's end on the service path: the service's
 * answer (`expect`: its result, its error, or for `nothing` the `ending`
 * that answers instead, SERVICE_ENDINGS' `deadline` or `stop`), and the
 * last status `seedRepository` published.
 */
function runServiceResult(main, c, ending = null) {
  let answerOf;
  if (c.expect.result) answerOf = { result: c.expect.result };
  else if (c.expect.error) answerOf = { error: c.expect.error };
  else answerOf = { error: SERVICE_ENDINGS[ending] };
  return runServiceNetwork(
    main,
    (world) => {
      world.seeding = 1;
      world.clones = [{ answer: answerOf }];
    },
    async () => ({ final: (await seedThrough(main)).at(-1) })
  );
}

// ---- radicle-import.json (radicle-import.js) ----

/** Main's GitHub bridge over its own embedded module and a scripted add-on,
 * `git`, GitHub and profile; loaded afresh for each case. */
function loadBridge(world, constants) {
  const addon = scriptedAddon(world);
  const log = { debug() {}, error() {}, log() {}, info() {}, warn() {} };
  const embedded = loadEmbedded(log, addon);
  // `execFileAsync = promisify(execFile)`: the scripted git, in order.
  const execFile = () => {
    throw new Error('the callback form of execFile is not used');
  };
  execFile[util.promisify.custom] = async (file, args, options) => {
    world.git.push({ file, args, cwd: options?.cwd ?? null, timeout: options?.timeout ?? null });
    const step = world.gitScript.shift();
    if (!step || step.command !== args[0]) throw new Error(`unscripted git ${args.join(' ')}`);
    if (step.error) throw Object.assign(new Error(step.error), { stderr: step.stderr ?? '' });
    return { stdout: step.stdout ?? '', stderr: '' };
  };
  const https = {
    // The network check: GitHub answers 200.
    request: (url, options, callback) => {
      world.https.push({ method: options.method, url });
      const req = new EventEmitter();
      req.end = () => setImmediate(() => callback({ statusCode: 200, resume() {} }));
      req.destroy = () => {};
      return req;
    },
    // The description: the scripted body.
    get: (url, options, callback) => {
      world.https.push({ method: 'GET', url });
      const req = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => {
        const res = new EventEmitter();
        callback(res);
        res.emit('data', world.description);
        res.emit('end');
      });
      return req;
    },
  };
  return loadWithInternals('src/main/github-bridge.js', ['importGitHubRepo'], {
    electron: { ipcMain: { handle() {} } },
    child_process: { execFile },
    https,
    fs: {
      ...fs,
      existsSync: () => false,
      writeFileSync: (p, data) => world.writes.push({ path: p, data: String(data) }),
    },
    './radicle-manager': {
      getCurrentStatus: () => ({ status: 'running' }),
      isDisabledForProfile: () => false,
      STATUS: { RUNNING: 'running' },
    },
    './radicle-embedded': embedded,
    './profile-paths': {
      createProfileTempDir: (prefix) => {
        world.temp.push(prefix);
        return constants.temp;
      },
      prepareRadicleDataDir: async () => constants.radicle_home,
    },
    './fs-offload': {
      removePath: async (p) => {
        world.removed.push(p);
      },
    },
  }).__internals;
}

/** A `radicle-import.json` import: `importGitHubRepo(url)` whole, and
 * what main did. */
async function runImport(c, constants) {
  const world = {
    script: [{ export: 'importRepo', args: c.addon.args, text: c.addon.text }],
    gitScript: [
      { command: '--version', stdout: 'git version 2.43.0\n' },
      { command: 'clone' },
      c.default_branch === null
        ? { command: 'symbolic-ref', error: 'fatal: ref HEAD is not a symbolic ref' }
        : { command: 'symbolic-ref', stdout: `${c.default_branch}\n` },
    ],
    description: c.description_body,
    calls: [],
    unscripted: [],
    git: [],
    https: [],
    temp: [],
    writes: [],
    removed: [],
    progress: [],
    console: [],
  };
  const bridge = loadBridge(world, constants);
  const sender = {
    isDestroyed: () => false,
    send: (channel, data) => world.progress.push({ channel, data }),
  };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(saved)) {
    console[level] = (...parts) => world.console.push({ level, line: parts.map(String).join(' ') });
  }
  let result;
  try {
    result = await bridge.importGitHubRepo(c.url, sender);
  } finally {
    Object.assign(console, saved);
  }
  return {
    main: asJson({
      result,
      calls: world.calls,
      git: world.git,
      https: world.https,
      temp: world.temp,
      progress: world.progress,
      writes: world.writes,
      removed: world.removed,
      console: world.console,
    }),
    ...leftovers(world),
    gitLeft: world.gitScript.length,
  };
}

module.exports = {
  ADDON,
  RID,
  REV,
  loadWithInternals,
  loadReadsMain,
  runRead,
  loadServiceReadsMain,
  runServiceNodeInfo,
  runServiceRead,
  runServiceBlob,
  serviceAnswer,
  TOO_LARGE_TEXT,
  SERVICE_LIBRADICLE,
  blobText,
  runBlob,
  loadNetworkMain,
  runReport,
  runProgress,
  runResult,
  runConnections,
  loadServiceNetworkMain,
  runServiceReport,
  runServiceProgress,
  runServiceQueue,
  runServiceResult,
  SERVICE_ENDINGS,
  runImport,
};
