/* global describe, test */

/**
 * freedom-colibrid for the Colibri suites (freedom-core design 0014):
 * `colibri-service-contract`, `chain-verified`, `colibri-private-store`,
 * `colibri-outage-parity` and `colibri-replay-parity` run on the real
 * binary, held to the reference's recorded outcomes (the WASM verifier's,
 * which COL-6 removed: freedom-core's vectors, and this repository's
 * fixtures recorded from it), with the expectations that differ by design
 * marked with the deviation that makes them differ. (`colibri-resolver`
 * runs its lifecycle above a fake.)
 *
 * The binary is `FREEDOM_COLIBRID_PATH`, or the release
 * `npm run colibrid:download` installs in `freedom-colibrid-bin/<os>-<arch>/`
 * (colibrid-binary.js's development layout). Without it the suites' parts
 * are skipped, named as such; with `FREEDOM_COLIBRID_REQUIRED=1` (CI) a
 * missing binary fails them instead. A downloaded binary must report the
 * pinned release in its hello (`expectedColibridVersion`); one
 * `FREEDOM_COLIBRID_PATH` names may report any, as a developer's own build
 * does in the app.
 *
 * Nothing leaves the machine. The network is a scripted prover on loopback
 * (`proverWorld`), which the service's fetches reach through main's
 * executor (colibri-fetch.js) on a hop over Node's `fetch` (`makeHop`), the
 * session's transport apart. With no proof to be had, what the service can
 * answer is what the contract fixes byte for byte without one: a failed
 * remote proof (#1059), a refusal, and the processes' lifecycle.
 * test/helpers/colibri-prover-outage.js adds the vectors' outage cases, and
 * test/helpers/colibri-replay.js their successful reads, from the recorded
 * answers.
 *
 * `DEVIATIONS` names each way the service's outcome differs from the
 * reference's by design (design 0014, Deviations), with the reason it does;
 * `deviation(tag)` returns it and refuses an unknown tag.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENS = path.join(ROOT, 'src', 'main', 'ens');

/** Each way the service's outcome differs from the reference's, and why
 * (design 0014, Deviations). */
const DEVIATIONS = Object.freeze({
  'colibri-deadline':
    'the service ends a request still waiting at its deadline, with no fault and ' +
    'nothing else ended; a WASM worker that answered its ping kept it until 60 s past ' +
    'the deadline',
  'colibri-culprit':
    'a service death names only the request whose step was open and sends every other ' +
    'one once more; a WASM worker that exited failed each open request as its own fault',
  'colibri-processes':
    'the service runs at most 3 processes browser-wide, `Colibri service busy` past ' +
    'them; the WASM host started a worker for every lane',
  // Not seen at the interface, so no case names it.
  'no-initial-chain-id':
    "the WASM client ran a local eth_chainId context on each client's first request; " +
    'the service runs none',
  'fetch-error-text':
    "main's fetch errors name URLs as `<url>`; the WASM fetch's named them",
  'storage-per-chain':
    "a service process keeps its chain's store in `<userData>/colibri/<chain>/`, and a " +
    'refused or unmakeable chain directory stops the lane (`Colibri service ' +
    "unavailable`); the WASM workers shared `<userData>/colibri/`, and one that couldn't " +
    'open it failed its read, the next read spawning another',
  'colibri-unserved':
    "methods outside the service's list (eth_getLogs, eth_chainId, writes): the " +
    'reference asked the prover (eth_chainId: answered from its configuration); the ' +
    'service refuses them, Method <m> is not supported; neither router asks for them',
  // The vectors' F-1, F-11 and F-12 cases (colibri-replay-parity): what the
  // reference answers there, the service refuses before any context, and
  // the routers no longer ask for it (#1048, #279).
  'colibri-unproofable':
    'eth_gasPrice, eth_feeHistory and reads at pending: the reference answers from a ' +
    'public RPC host without a proof; the service refuses them (Method <m> is not ' +
    'supported, Colibri cannot prove <method> at block "<tag>")',
  'colibri-no-calls':
    'eth_call and eth_estimateGas: the reference runs them on code from a public RPC ' +
    'host; the service refuses them, Method <m> is not supported',
  'colibri-unbound':
    'account reads and blocks at a form Colibri does not tie to the proven block ' +
    '(safe, finalized, a number for an account): the reference answers from whichever ' +
    "block the proof names; the service refuses them with #279's text",
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
/** Why the binary's parts can't run, or null. */
const colibridMissing = colibridFound
  ? null
  : `freedom-colibrid not found at ${COLIBRID} (npm run colibrid:download, or FREEDOM_COLIBRID_PATH)`;

/**
 * A freedom-colibrid built with its `testhooks` feature, which only a debug
 * build may have (freedom-core's `services/freedom-colibrid/build.rs`), for
 * the suites that must fix the C core's clock (`test_clock_ms`), as
 * freedom-core's own replay of the vectors does: FREEDOM_COLIBRID_TESTHOOKS_PATH,
 * or null. A released binary takes no such field.
 */
const COLIBRID_TESTHOOKS = process.env.FREEDOM_COLIBRID_TESTHOOKS_PATH || null;

/** The deviation `tag`'s reason; an unknown tag throws. */
function deviation(tag) {
  if (!DEVIATIONS[tag]) throw new Error(`unknown Colibri deviation: ${tag}`);
  return DEVIATIONS[tag];
}

/**
 * `describe(title, fn)` on the real binary: skipped without it, its reason
 * in the title, unless FREEDOM_COLIBRID_REQUIRED=1, which fails it instead.
 */
function describeService(title, fn) {
  if (colibridFound) {
    describe(title, fn);
  } else if (colibridRequired) {
    describe(title, () => {
      test('freedom-colibrid is present (FREEDOM_COLIBRID_REQUIRED=1)', () => {
        throw new Error(colibridMissing);
      });
    });
  } else {
    describe.skip(`${title}: ${colibridMissing}`, fn);
  }
}

/** A test that needs the binary: skipped without it, its reason in the
 * title, or failed under FREEDOM_COLIBRID_REQUIRED=1. */
function serviceTest(name, fn, timeout) {
  if (colibridFound) return test(name, fn, timeout);
  if (colibridRequired) {
    return test(`${name} (FREEDOM_COLIBRID_REQUIRED=1)`, () => {
      throw new Error(colibridMissing);
    });
  }
  return test.skip(`${name}: ${colibridMissing}`, fn);
}
/** `serviceTest` per row: `%s` in the name is the row's first item. */
serviceTest.each = (rows) => (name, fn, timeout) => {
  for (const row of rows) {
    serviceTest(name.replace('%s', row[0]), () => fn(...row), timeout);
  }
};

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

/** `child_process.spawn`, recording each freedom-colibrid process
 * (`{ private, storageDir, args, kill(), exited }`). */
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
 * Starts colibri-service.js afresh on the binary, its store under
 * `<userData>/colibri`: `{ host, spawned, close }`. `host` is the service
 * (`createClient`, `ensureWorker`, `endPrivateSession`, …); `spawned`
 * records its processes (`recordingSpawn`). `hop` is its transport (Node's
 * `fetch` by default), `now` main's clock (`Date.now`), and `command` and
 * `serviceVersion` another binary and the release its hello must name
 * (null: any). The locks are outside `userData`, as the app's are
 * (`<appData>/Freedom/locks`). `close()` stops every process and resolves
 * once each has exited.
 */
async function startService({
  userData,
  hop,
  now = Date.now,
  command = COLIBRID,
  serviceVersion,
} = {}) {
  if (command === COLIBRID && !colibridFound) throw new Error(colibridMissing);
  const storageDir = path.join(userData, 'colibri');
  const service = require(path.join(ENS, 'colibri-service.js'));
  const { makeHop } = require(path.join(ROOT, 'src', 'main', 'core', 'naming-shell.js'));
  const spawned = [];
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-locks-'));
  await service.resetForTest({
    storageDir,
    lockDir,
    command,
    serviceVersion:
      serviceVersion === undefined
        ? service.expectedColibridVersion({ packaged: false })
        : serviceVersion,
    now,
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

/** The first `units` UTF-16 units of `text`, as colibri-outcome.js cuts an
 * adapter message (and the WASM worker's `serializeError` did). */
const cut = (text, units = 2000) => text.slice(0, units);

module.exports = {
  COLIBRID,
  COLIBRID_TESTHOOKS,
  DEVIATIONS,
  PROVER_DOWN,
  colibridFound,
  colibridMissing,
  colibridPath,
  colibridRequired,
  cut,
  describeService,
  deviation,
  outcomeOf,
  proverWorld,
  recordingSpawn,
  serviceTest,
  startService,
};
