/* global jest, describe, test */

/**
 * The two Colibri backends (freedom-core design 0014, COL-5) for the
 * contract suite: `colibri-worker-host`, `chain-verified`,
 * `colibri-private-store` and `colibri-outage-parity` run each of their
 * backend-agnostic parts once per backend, here, with the expectations that
 * differ by design marked with the deviation that makes them differ.
 * (`colibri-resolver` runs its lifecycle above fakes of both.)
 *
 * - `wasm`: colibri-worker-host.js, the default, with its real worker
 *   threads (colibri-worker.js on the package's WASM verifier). A worker
 *   runs on Node's own loader, outside Jest's registry, so the real WASM
 *   loads there. Always available.
 * - `service`: colibri-service.js on the real freedom-colibrid binary:
 *   `FREEDOM_COLIBRID_PATH`, or the release `npm run colibrid:download`
 *   installs in `freedom-colibrid-bin/<os>-<arch>/` (colibrid-binary.js's
 *   development layout). Without it the backend's parts are skipped, named
 *   as such; with `FREEDOM_COLIBRID_REQUIRED=1` (CI) a missing binary fails
 *   them instead. A downloaded binary must report the pinned release in its
 *   hello (`expectedColibridVersion`); one `FREEDOM_COLIBRID_PATH` names may
 *   report any, as a developer's own build does in the app.
 *
 * Nothing leaves the machine. The network is a scripted prover on loopback
 * (`proverWorld`): the WASM verifier fetches it itself, and the service's
 * fetches go to it through main's executor (colibri-fetch.js) on a hop over
 * Node's `fetch` (`makeHop`), the session's transport apart. With no proof
 * to be had, what a backend can answer is what the contract fixes byte for
 * byte without one: a failed remote proof (#1059), a refusal, and the
 * processes' lifecycle. test/helpers/colibri-prover-outage.js adds the
 * vectors' outage cases on both.
 *
 * `DEVIATIONS` names each expectation that differs by backend (design 0014,
 * Deviations), with the reason it does; `deviation(tag, backend, expected)`
 * picks the backend's and refuses an unknown tag. The WASM backend is the
 * reference: it deviates from nothing.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENS = path.join(ROOT, 'src', 'main', 'ens');

/** Each expectation that differs by backend, and why (design 0014,
 * Deviations). */
const DEVIATIONS = Object.freeze({
  'colibri-deadline':
    'the service ends a request still waiting at its deadline, with no fault and ' +
    'nothing else ended; a WASM worker that answers its ping keeps it until 60 s past ' +
    'the deadline',
  'colibri-culprit':
    'a service death names only the request whose step was open and sends every other ' +
    'one once more; a WASM worker that exits fails each open request as its own fault',
  'colibri-processes':
    'the service runs at most 3 processes browser-wide, `Colibri service busy` past ' +
    'them; the WASM host starts a worker for every lane',
  // Not seen at the interface, so no case names it.
  'no-initial-chain-id':
    "the WASM client runs a local eth_chainId context on each client's first request; " +
    'the service runs none',
  'fetch-error-text':
    "main's fetch errors name URLs as `<url>`; the WASM fetch's name them",
  'storage-per-chain':
    "a service process keeps its chain's store in `<userData>/colibri/<chain>/`, and a " +
    'refused or unmakeable chain directory stops the lane (`Colibri service ' +
    "unavailable`); the WASM workers share `<userData>/colibri/`, and one that can't " +
    'open it fails its read, the next read spawning another',
  'colibri-unserved':
    "methods outside the service's list (eth_getLogs, eth_chainId, writes): the " +
    'reference asks the prover (eth_chainId: answers from its configuration); the ' +
    'service refuses them, Method <m> is not supported; neither router asks for them',
});

/** Where the freedom-colibrid binary is for tests: colibrid-binary.js's
 * development answer (which needs Electron's `app`). */
function colibridPath(env = process.env) {
  if (env.FREEDOM_COLIBRID_PATH) return env.FREEDOM_COLIBRID_PATH;
  const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
  const name = process.platform === 'win32' ? 'freedom-colibrid.exe' : 'freedom-colibrid';
  return path.join(ROOT, 'freedom-colibrid-bin', `${os}-${process.arch}`, name);
}

const COLIBRID = colibridPath();
const colibridFound = fs.existsSync(COLIBRID);
const colibridRequired = process.env.FREEDOM_COLIBRID_REQUIRED === '1';

const BACKENDS = Object.freeze([
  Object.freeze({ kind: 'wasm', available: true, missing: null }),
  Object.freeze({
    kind: 'service',
    available: colibridFound,
    missing: colibridFound
      ? null
      : `freedom-colibrid not found at ${COLIBRID} ` +
        '(npm run colibrid:download, or FREEDOM_COLIBRID_PATH)',
  }),
]);

const backendOf = (kind) => BACKENDS.find((backend) => backend.kind === kind);

/**
 * `expected[backend.kind]`: an expectation that differs by backend for the
 * deviation `tag`. Both backends' must be given.
 */
function deviation(tag, backend, expected) {
  if (!DEVIATIONS[tag]) throw new Error(`unknown Colibri deviation: ${tag}`);
  for (const { kind } of BACKENDS) {
    if (!(kind in expected)) throw new Error(`deviation ${tag} names no ${kind} expectation`);
  }
  return expected[backend.kind];
}

/**
 * `describe.each` over the backends (`backends`, all by default): `fn(backend)`
 * declares one backend's tests. A backend that isn't available is skipped,
 * its reason in the title, unless FREEDOM_COLIBRID_REQUIRED=1, which fails
 * it instead.
 */
function describeBackends(title, fn, { backends = BACKENDS } = {}) {
  for (const backend of backends) {
    const name = `${title} (${backend.kind})`;
    if (backend.available) {
      describe(name, () => fn(backend));
    } else if (colibridRequired) {
      describe(name, () => {
        test('freedom-colibrid is present (FREEDOM_COLIBRID_REQUIRED=1)', () => {
          throw new Error(backend.missing);
        });
      });
    } else {
      describe.skip(`${name}: ${backend.missing}`, () => fn(backend));
    }
  }
}

// ---- the network ----

/** The scripted prover's default answer: down, with a short body. */
const PROVER_DOWN = Object.freeze({ status: 503, body: 'prover down' });

/**
 * A scripted prover on loopback (`world.url`): every request is answered
 * as `world.answer` says when it arrives: `{ status, body }`, `'transport'`
 * (the connection is dropped: Node's `fetch failed`), or `'hold'` (kept
 * open until `world.release(answer)`). `world.requests` records each
 * (`{ method, body }`), `world.held` those still held.
 */
async function proverWorld() {
  const world = { answer: PROVER_DOWN, requests: [], held: [] };
  const respond = ({ req, res }, answer) => {
    if (answer === 'transport') {
      req.socket.destroy();
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'text/plain' });
    res.end(answer.body);
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      world.requests.push({ method: req.method, body: Buffer.concat(chunks).toString('utf8') });
      if (world.answer === 'hold') world.held.push({ req, res });
      else respond({ req, res }, world.answer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  world.url = `http://127.0.0.1:${server.address().port}`;
  world.release = (answer = PROVER_DOWN) => {
    for (const held of world.held.splice(0)) respond(held, answer);
  };
  /** Resolves once `count` requests have arrived. */
  world.until = async (count, what = `${count} prover request(s)`) => {
    const end = Date.now() + 20_000;
    while (world.requests.length < count) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  world.close = () => {
    world.held.length = 0;
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return world;
}

// ---- the processes ----

// The WASM workers spawned since the last `startBackend`, recorded by
// `workerThreads()`'s Worker.
const workers = [];

/** A real worker thread, recorded: the implementation `workerThreads()`'s
 * Worker has unless a test gives it another. */
function realWorker(file, options) {
  const { Worker } = jest.requireActual('node:worker_threads');
  const worker = new Worker(file, options);
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  const storageDir = options?.workerData?.storageDir ?? null;
  workers.push({
    private: storageDir === null,
    storageDir,
    kill: () => worker.terminate(),
    exited,
  });
  return worker;
}

/**
 * `node:worker_threads` for a suite that records the WASM backend's workers
 * (`jest.mock('node:worker_threads', () => require(…).workerThreads())`):
 * the real module, its Worker a mock whose implementation is `realWorker`.
 */
function workerThreads() {
  const actual = jest.requireActual('node:worker_threads');
  return { ...actual, Worker: jest.fn(realWorker) };
}

/** `child_process.spawn`, recording each freedom-colibrid process as
 * `workerThreads()` records a worker. */
function recordingSpawn(spawned) {
  return (command, args, options) => {
    const child = childProcess.spawn(command, args, options);
    const at = args.indexOf('--data-dir');
    const storageDir = at < 0 ? null : args[at + 1];
    spawned.push({
      private: storageDir === null,
      storageDir,
      args,
      kill: () => child.kill('SIGKILL'),
      exited: new Promise((resolve) => child.once('exit', resolve)),
    });
    return child;
  };
}

/**
 * Starts `backend` afresh with its store under `<userData>/colibri`:
 * `{ host, spawned, close }`. `host` has the WASM host's interface
 * (`createClient`, `ensureWorker`, `endPrivateSession`, …); `spawned`
 * records its processes (`{ private, storageDir, kill(), exited }`; the
 * WASM backend's only in a suite whose Worker is `workerThreads()`'s).
 * `hop` is the service's transport (Node's `fetch` by default). The
 * service's locks are outside `userData`, as the app's are
 * (`<appData>/Freedom/locks`). `close()` stops every process and resolves
 * once each has exited.
 */
async function startBackend(backend, { userData, hop } = {}) {
  const storageDir = path.join(userData, 'colibri');
  if (backend.kind === 'wasm') {
    const host = require(path.join(ENS, 'colibri-worker-host.js'));
    host.resetForTest({ storageDir });
    workers.length = 0;
    return {
      host,
      spawned: workers,
      close: async () => {
        const exits = workers.map((worker) => worker.exited);
        host.resetForTest();
        await Promise.all(exits);
      },
    };
  }
  if (!backend.available) throw new Error(backend.missing);
  const service = require(path.join(ENS, 'colibri-service.js'));
  const { makeHop } = require(path.join(ROOT, 'src', 'main', 'core', 'naming-shell.js'));
  const spawned = [];
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-locks-'));
  await service.resetForTest({
    storageDir,
    lockDir,
    command: COLIBRID,
    serviceVersion: service.expectedColibridVersion({ packaged: false }),
    // Main's grant check needs the profile's roots; colibri-service.test.js
    // and service-grant.test.js have it.
    checkGrant: () => null,
    shellVersion: 'test',
    spawn: recordingSpawn(spawned),
    hop: hop ?? makeHop({ fetch: globalThis.fetch }),
  });
  return {
    host: service,
    spawned,
    close: async () => {
      await service.resetForTest();
      await Promise.all(spawned.map((proc) => proc.exited));
      fs.rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

/** An error as the adapter's caller sees it: the fields the contract fixes. */
function outcomeOf(err) {
  return { name: err?.name, code: err?.code, message: err?.message, data: err?.data };
}

/** The first `units` UTF-16 units of `text`, as `serializeError` and
 * colibri-outcome.js cut an adapter message. */
const cut = (text, units = 2000) => text.slice(0, units);

module.exports = {
  BACKENDS,
  COLIBRID,
  DEVIATIONS,
  PROVER_DOWN,
  backendOf,
  colibridFound,
  colibridPath,
  colibridRequired,
  cut,
  describeBackends,
  deviation,
  outcomeOf,
  proverWorld,
  realWorker,
  recordingSpawn,
  startBackend,
  workerThreads,
};
