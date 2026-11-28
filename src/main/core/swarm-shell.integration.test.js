/**
 * Main's Swarm executor against the real freedom-cored, with the switch on
 * (freedom-core design 0015, SWM-5's gates; the SWM-5 plan's PR 7):
 * FREEDOM_SWARM_BACKEND=core in a development build, as the real switch
 * (swarm/swarm-backend-kind.js) reads it. Main sends its own Swarm requests
 * (`swarm.stamps`, `swarm.publish`) and opens each in its executor
 * (core/swarm-shell.js) from its `onSent`, as SWM-8's senders will; the
 * core's swarm thread asks for the node calls (`shell.swarm_api`), the
 * upload's body (`swarm.body`) and its parts (`shell.swarm_part`), and main
 * makes each call on the node's transport (undici on loopback, chunked for
 * a streamed body) to a node on loopback.
 *
 * The point is the core's strict readers: every reply, head, stream frame
 * and credit main writes is read by the release main pins, which ends the
 * connection (exit 76) on any it doesn't take. So each case also checks
 * that the core is the one it started (no restart), that main logged no
 * refusal or fault, and that the Swarm I/O pool is back at 0.
 *
 * - `swarm.stamps`, the list and one batch: one `GET /stamps` or `GET
 *   /stamps/<id>` each, the core's answer read from the node's reply;
 * - a 50 MiB `swarm.publish` of 100 files without history, half held
 *   buffers and half picked files (the vectors'
 *   `publish-files-100-files-50mib` shape): one `GET /stamps`, then one
 *   chunked `POST /bzz` whose tar holds every file byte for byte, its
 *   parts asked one at a time; the answer is the node's reference and tag.
 *
 * The publish is main's first `swarm.publish`, whose idle watchdog its
 * progress doesn't move on yet (SWM-8's): it has 75 s, which a 50 MiB
 * upload on loopback is far inside.
 *
 * **Peaks and resident memory** (design 0015, Main's Swarm I/O pool,
 * "Peaks"), gated by FREEDOM_SWARM_PEAKS=1: main's resident memory (Linux's
 * VmHWM, else sampled) through the largest whole reply (a 1 MiB `/stamps`)
 * 16 times in turn, against one call's charge; through 64 concurrent
 * maximum calls, from the real core (which asks a few at a time) and from a
 * scripted core (64 at once: the pool fills to 64 MiB and the rest are
 * busy); and through the 50 MiB publish of picked files. Resident memory
 * depends on the allocator and the machine, so CI never runs them; each
 * prints its figures.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/core/swarm-shell.integration
 * or FREEDOM_CORED_SWARM_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'bundled' }),
}));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => null }));
jest.mock('./dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('./naming', () => ({ namingDriver: () => null }));

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const v8 = require('v8');
const vm = require('vm');
const { CoreClient } = require('./core-client');
const { idleWatchdogMs, watchdogMs } = require('./core-deadlines');
const { registerSwarmShell, wholeCharge } = require('./swarm-shell');
const { rowFor } = require('./swarm-grammar');
const { readTyped } = require('./swarm-typed');
const { SwarmIoPool, swarmIoPool } = require('./swarm-io-pool');
const { antBackend } = require('../swarm/bzz-protocol');
const { swarmBackendKind } = require('../swarm/swarm-backend-kind');
const { content } = require('../../../test/helpers/swarm-vectors');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');
const { parentOf, startSwarmCore, until } = require('../../../test/helpers/fake-swarm-core');
const log = require('../logger');

const required = process.env.FREEDOM_CORED_SWARM_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH ||
  (required ? require('./cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_SWARM_TEST=1 needs freedom-cored: run npm run core:download');
}
const peaks = process.env.FREEDOM_SWARM_PEAKS === '1';
/** `describe`, or `describe.skip` with why in its name. */
const gated = (skipped) =>
  skipped ? (name, fn) => describe.skip(`${name} (skipped: ${skipped})`, fn) : describe;
const NO_CORE = 'no freedom-cored: set FREEDOM_CORED_PATH, or FREEDOM_CORED_SWARM_TEST=1';
const NO_PEAKS = 'FREEDOM_SWARM_PEAKS is not 1';
const describeIfBinary = gated(!binary && NO_CORE);
const describeIfPeaks = gated((!peaks && NO_PEAKS) || (!binary && NO_CORE));
const describePeaksScripted = gated(!peaks && NO_PEAKS);

// A real core on real timers; a 50 MiB upload on a slow runner.
jest.setTimeout(180_000);

const KIB = 1024;
const MIB = 1024 * KIB;
const BATCH = 'a1'.repeat(32);
const TAG = 7;
/** design 0015's Q22: 100 files and 50 MiB, as the vectors' largest publish. */
const FILES = 100;
const FILE_BYTES = (50 * MIB) / FILES;
/** The usable batch the core chooses (fc-swarm-provider's tests' own). */
const STAMP = {
  batchID: BATCH,
  utilization: 0,
  usable: true,
  label: 'freedom',
  depth: 22,
  amount: '100000000000',
  bucketDepth: 16,
  blockNumber: 1000,
  immutableFlag: true,
  exists: true,
  batchTTL: 864000,
};
const STAMPS = JSON.stringify({ stamps: [STAMP] });

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Reads a ustar archive as bee-js's TarStream writes it (512-byte headers,
 * each entry padded to 512 bytes, the name in the first 100 bytes, its size
 * in octal): each entry's name, length and SHA-256.
 */
function tarEntries(tar) {
  const entries = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, ''), 8);
    const start = at + 512;
    entries.push({ name, bytes: size, sha256: sha256(tar.subarray(start, start + size)) });
    at = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Takes a request's whole body, hashed as it comes: its length and
 * SHA-256, and its bytes when `keep` (to read a tar back).
 */
function takeBody(req, keep) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
      if (keep) chunks.push(chunk);
    });
    req.on('end', () =>
      resolve({ bytes, sha256: hash.digest('hex'), body: keep ? Buffer.concat(chunks) : null })
    );
    req.on('error', reject);
  });
}

/**
 * The node's answers: `/stamps` from `stamps()` and `/stamps/<id>`, and a
 * `/bzz` upload taken whole and answered as Ant answers one, its reference
 * the SHA-256 of what it took (the core checks nothing more of a `/bzz`
 * answer than its form, design 0015, What the core checks); each upload
 * kept in `node.uploads`, its bytes too when `keep`.
 */
function nodeHandler(node, { stamps = () => STAMPS, keep = true } = {}) {
  return async (req, res) => {
    const { pathname } = new URL(req.url, 'http://node');
    if (req.method === 'GET' && pathname === '/stamps') {
      const body = stamps();
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && pathname === `/stamps/${BATCH}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(STAMP));
      return;
    }
    if (req.method === 'POST' && pathname === '/bzz') {
      const taken = await takeBody(req, keep);
      node.uploads.push({ url: req.url, headers: req.headers, ...taken });
      res.writeHead(201, { 'content-type': 'application/json', 'swarm-tag': String(TAG) });
      res.end(JSON.stringify({ reference: taken.sha256 }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
  };
}

async function startNode() {
  const node = await startFakeHttpNode();
  node.uploads = [];
  node.handle(nodeHandler(node));
  return node;
}

/** A collection of FILES files of FILE_BYTES each, the vectors' contents:
 * the params main sends, the files' names, lengths and digests, and a
 * source for each part (`picked(k)` true for a picked file in `dir`, else
 * a held buffer). */
function collection(dir, picked) {
  const files = [];
  const parts = new Map();
  for (let k = 0; k < FILES; k++) {
    const bytes = content(`publish-files/50mib/${k}`, FILE_BYTES);
    const name = `files/${String(k).padStart(3, '0')}.bin`;
    files.push({ name, bytes: FILE_BYTES, sha256: sha256(bytes) });
    if (picked(k)) {
      const file = path.join(dir, `${k}.bin`);
      fs.writeFileSync(file, bytes);
      parts.set(k, { path: file, bytes: FILE_BYTES });
    } else {
      parts.set(k, bytes);
    }
  }
  const params = {
    kind: 'collection',
    parts: files.map((file, k) => ({ path: file.name, bytes: file.bytes, part: k })),
    pin: true,
    deferred: true,
  };
  return { params, files, parts };
}

// ---- Resident memory (gated) ------------------------------------------------

/** A full GC, the flag exposed only once a measurement asks for it. */
let collect = null;
function gc() {
  if (!collect) {
    v8.setFlagsFromString('--expose-gc');
    collect = vm.runInNewContext('gc');
  }
  collect();
}
const kib = (bytes) => `${Math.round(bytes / KIB)} KiB`;

/** Linux's peak resident memory, VmHWM, reset to the current resident
 * memory (`clear_refs`); false where there is none. */
function resetPeak() {
  try {
    fs.writeFileSync('/proc/self/clear_refs', '5');
    return true;
  } catch {
    return false;
  }
}
function readPeak() {
  const match = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
  return match ? Number(match[1]) * KIB : 0;
}

/**
 * Main's resident memory through `run()`: what it was after a full GC, and
 * its peak, Linux's VmHWM since a reset where there is one, else sampled
 * every 2 ms.
 */
async function measured(run) {
  gc();
  gc();
  const before = process.memoryUsage.rss();
  const hwm = resetPeak();
  let sampled = before;
  const timer = setInterval(() => {
    sampled = Math.max(sampled, process.memoryUsage.rss());
  }, 2);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  const peak = hwm ? Math.max(readPeak(), sampled) : sampled;
  return { before, peak, up: peak - before, how: hwm ? 'VmHWM since clear_refs' : 'sampled' };
}

function report(what, { before, up, how }, beside) {
  process.stdout.write(
    `[swarm-shell peaks] ${what}: main's resident memory ${kib(before)} before, ` +
      `peak +${kib(up)} (${how}); ${beside}\n`
  );
}

/** The core, its stores and grants in a directory of their own. */
function startCore(root) {
  const client = new CoreClient({
    spawn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      path.join(root, 'identity'),
      '--lock-dir',
      path.join(root, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    log: { info() {}, warn() {}, error() {}, debug() {} },
    shellVersion: 'jest',
    grantRoot: root,
  });
  return client;
}

/**
 * Sends one of main's Swarm requests and opens it in the executor from its
 * `onSent`, as SWM-8's senders will: its row from its params, the node's
 * backend captured with it, `parts` the source of each part its params
 * name. The parent closes with main's request. Resolves with the core's
 * answer, or `{ error }` with its code and message.
 */
async function send(client, shell, method, params, { parts = null } = {}) {
  const row = rowFor(method, params);
  const backend = antBackend();
  let handle = null;
  const deadline =
    method === 'swarm.publish'
      ? { idleWatchdogMs: idleWatchdogMs(method) }
      : { watchdogMs: watchdogMs(method) };
  try {
    // A pooled request resolves with `{ result, release }`: its charge is
    // held until the result is handed on, which is here.
    const { result, release } = await client.request(
      method,
      params,
      { caller: 'shell' },
      {
        ...deadline,
        pool: swarmIoPool,
        onSent: (id, generation) => {
          handle = shell.open({ id, generation }, { row, params, backend, parts });
        },
      }
    );
    release();
    return { result };
  } catch (err) {
    return { error: { code: err.code, message: err.message } };
  } finally {
    handle?.close();
  }
}

/** What main logged at warn or error: a refusal, a core fault, a restart. */
const complaints = () => [...log.warn.mock.calls, ...log.error.mock.calls].map((c) => c.join(' '));

describeIfBinary("main's Swarm executor with the real freedom-cored (switch on)", () => {
  let root;
  let node;
  let client;
  let shell;
  let pid;
  let savedSwitch;
  // The core's exits: a wire mismatch is exit 76 (design 0001, a protocol
  // error), and the client would start another.
  const exits = [];

  beforeAll(async () => {
    savedSwitch = process.env.FREEDOM_SWARM_BACKEND;
    process.env.FREEDOM_SWARM_BACKEND = 'core';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-swarm-core-'));
    node = await startNode();
    mockRegistry.url = node.origin;
    client = startCore(root);
    shell = registerSwarmShell(client, { publishReadiness: async () => ({ ok: true }) });
    await client.start();
    const { child } = client.current;
    pid = child.pid;
    child.on('exit', (code, signal) => exits.push(code ?? signal));
  });

  afterAll(async () => {
    await client?.stop();
    await node?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (savedSwitch === undefined) delete process.env.FREEDOM_SWARM_BACKEND;
    else process.env.FREEDOM_SWARM_BACKEND = savedSwitch;
  });

  beforeEach(() => {
    log.warn.mockClear();
    log.error.mockClear();
    node.requests.length = 0;
    node.uploads.length = 0;
    node.handle(nodeHandler(node));
  });

  // The same core throughout: none of main's frames ended its connection;
  // nothing refused, held or left open. A call's charges go back once its
  // last frame is written, which can land just after its answer is read
  // (seen on Windows): wait, bounded, for the pool and the shell to empty.
  afterEach(async () => {
    const idle = { parents: 0, calls: 0, walks: 0, uploads: 0, parts: 0 };
    await until(
      () => swarmIoPool.held === 0 && JSON.stringify(shell.stats()) === JSON.stringify(idle),
      'the pool and the shell empty',
    ).catch(() => {});
    // After the wait, so a last write that failed meanwhile (and retired
    // the connection, emptying the pool) still shows here.
    expect(exits).toEqual([]);
    expect(client.current?.child?.pid).toBe(pid);
    expect(complaints()).toEqual([]);
    expect(swarmIoPool.held).toBe(0);
    expect(shell.stats()).toEqual(idle);
  });

  test('the switch is on: the real switch reads core, so the registry admits parents', () => {
    expect(swarmBackendKind()).toBe('core');
    expect(pid).toEqual(expect.any(Number));
  });

  test('swarm.stamps: the list, one GET /stamps, read by the core from the node', async () => {
    const answer = await send(client, shell, 'swarm.stamps', {});
    expect(answer.error).toBeUndefined();
    // bee-js's getAllPostageBatch, in the typed form.
    const [stamp, ...others] = readTyped(answer.result.result_typed);
    expect(others).toEqual([]);
    expect(stamp).toMatchObject({ batchID: BATCH, usable: true, depth: 22, duration: 864000 });
    expect(node.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /stamps']);
    // Main's two headers on the node's transport.
    expect(node.requests[0].headers).toMatchObject({
      accept: 'application/json, text/plain, */*',
      'accept-encoding': 'identity',
    });
  });

  test('swarm.stamps: one batch, one GET /stamps/<id>', async () => {
    const answer = await send(client, shell, 'swarm.stamps', { id: BATCH });
    expect(answer.error).toBeUndefined();
    expect(readTyped(answer.result.result_typed)).toMatchObject({ batchID: BATCH, usable: true });
    expect(node.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET /stamps/${BATCH}`]);
  });

  test('a 50 MiB swarm.publish of 100 files without history: one chunked POST /bzz, every file byte for byte', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-swarm-picked-'));
    try {
      // Half held buffers (a page's IPC values), half picked files
      // (freedom://publish's).
      const { params, files, parts } = collection(dir, (k) => k % 2 === 1);
      const started = Date.now();
      const answer = await send(client, shell, 'swarm.publish', params, { parts });
      const took = Date.now() - started;

      expect(answer.error).toBeUndefined();
      expect(node.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        'GET /stamps',
        'POST /bzz',
      ]);
      const [upload] = node.uploads;
      // Streamed: chunked, with no length (design 0015, The transport).
      expect(upload.headers).toMatchObject({
        'content-type': 'application/x-tar',
        'swarm-collection': 'true',
        'swarm-postage-batch-id': BATCH,
        'swarm-pin': 'true',
        'swarm-deferred-upload': 'true',
        'transfer-encoding': 'chunked',
      });
      expect(upload.headers['content-length']).toBeUndefined();
      expect(tarEntries(upload.body)).toEqual(files);
      // The node's reference and tag, the batch the core chose, the bytes.
      expect(readTyped(answer.result.result_typed)).toEqual({
        reference: upload.sha256,
        tag_uid: TAG,
        batch: BATCH,
        bytes: 50 * MIB,
      });
      process.stdout.write(
        `[swarm-shell gate] 50 MiB publish of ${FILES} files: a ${upload.bytes}-byte tar ` +
          `in ${took} ms (${((50 * 1000) / took).toFixed(1)} MiB/s)\n`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describeIfPeaks('peaks and resident memory (FREEDOM_SWARM_PEAKS=1)', () => {
    /** A `/stamps` reply of exactly `bytes`: one usable batch, then white space. */
    const paddedStamps = (bytes) => STAMPS.padEnd(bytes, ' ');

    test("the largest whole reply, a 1 MiB /stamps, 16 times in turn: main's peak stays within one call's charge, not their sum", async () => {
      const reply = paddedStamps(MIB);
      node.handle(nodeHandler(node, { stamps: () => reply }));
      // Warm: the transport's, the client's and the heap's first growth.
      for (let k = 0; k < 4; k++) await send(client, shell, 'swarm.stamps', {});
      const peak = await measured(async () => {
        for (let k = 0; k < 16; k++) {
          const answer = await send(client, shell, 'swarm.stamps', {});
          expect(answer.error).toBeUndefined();
        }
      });
      const charge = wholeCharge(MIB);
      report(
        '16 of the largest whole reply (a 1 MiB /stamps) in turn',
        peak,
        `one charge ${kib(charge)}`
      );
      expect(peak.up).toBeLessThan(charge + 8 * MIB);
    });

    test('64 concurrent maximum calls through the core: within the pool, and resident memory follows its charges', async () => {
      const reply = paddedStamps(MIB);
      node.handle(nodeHandler(node, { stamps: () => reply }));
      swarmIoPool.highWater = 0;
      let answers;
      const peak = await measured(async () => {
        answers = await Promise.all(
          Array.from({ length: 64 }, () => send(client, shell, 'swarm.stamps', {}))
        );
      });
      // The core charges its own 64 MiB more for each than main does (its
      // reader's charge), so it asks main for a few at a time, never 64.
      report(
        '64 concurrent maximum calls through the core',
        peak,
        `the pool's high-water mark ${kib(swarmIoPool.highWater)} of 64 MiB ` +
          `(${kib(wholeCharge(MIB))} a call)`
      );
      expect(answers.filter((a) => a.error)).toEqual([]);
      expect(node.requests).toHaveLength(64);
      expect(swarmIoPool.highWater).toBeLessThanOrEqual(64 * MIB);
      expect(peak.up).toBeLessThan(64 * MIB + 32 * MIB);
    });

    test('a 50 MiB publish of picked files: resident memory up by its streams, not its size', async () => {
      // The node hashes what it takes and keeps none of it.
      node.handle(nodeHandler(node, { keep: false }));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-swarm-picked-'));
      try {
        const { params, parts } = collection(dir, () => true);
        const peak = await measured(async () => {
          const answer = await send(client, shell, 'swarm.publish', params, { parts });
          expect(answer.error).toBeUndefined();
        });
        report('a 50 MiB publish of 100 picked files', peak, `a ${node.uploads[0].bytes}-byte tar`);
        expect(peak.up).toBeLessThan(16 * MIB);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * The real core asks main for a few maximum calls at a time (its own 64 MiB
 * charges each more than main's pool does), so main's pool never fills
 * against it. A scripted core (test/helpers/fake-swarm-core.js) asks for 64
 * at once, as design 0015's pool test has it: as many as fit in the 64 MiB
 * are dialled, the rest are busy, undialled, and main's resident memory is
 * sampled throughout. The scripted core drops each reply's body as it
 * reads it, so what it keeps of main's replies isn't counted as main's.
 */
describePeaksScripted(
  '64 concurrent maximum calls from a scripted core (FREEDOM_SWARM_PEAKS=1)',
  () => {
    test('the pool fills to 64 MiB and no further, the rest busy, and resident memory follows the pool', async () => {
      const reply = STAMPS.padEnd(MIB, ' ');
      const fits = Math.floor((64 * MIB) / wholeCharge(MIB));
      const held = [];
      const node = await startFakeHttpNode({
        handler: (req, res) => {
          held.push(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(reply);
          });
          if (held.length === fits) for (const answer of held.splice(0)) answer();
        },
      });
      mockRegistry.url = node.origin;
      const pool = new SwarmIoPool();
      // The registry admits parents as on the core's backend: the switch
      // itself is read once per process (swarm-backend-kind.js), and this
      // case is the pool's.
      const harness = await startSwarmCore({
        log: { info() {}, warn() {}, error() {}, debug() {} },
        deps: { nodeUrl: () => node.origin, pool, backendKind: () => 'core' },
      });
      const parents = [];
      try {
        const core = harness.core();
        // What the scripted core keeps of each reply: its form, not its bytes.
        const keep = core.messages.push.bind(core.messages);
        core.messages.push = (message) => {
          if (typeof message?.result?.body_base64 === 'string') {
            message.result.body_base64 = message.result.body_base64.length;
          }
          return keep(message);
        };
        // 64 parents, each asked its one maximum call at once.
        const round = async () => {
          const batch = [];
          for (let k = 0; k < 64; k++) {
            batch.push(
              parentOf(harness.client, harness.shell, {
                row: 'swarm.stamps',
                params: {},
                backend: antBackend(),
              })
            );
          }
          parents.push(...batch);
          await until(() => batch.every((p) => p.id !== null), 'the parents sent');
          const asks = batch.map((p) =>
            core.api(p.id, {
              form: 'stamps',
              method: 'GET',
              path: '/stamps',
              query: [],
              headers: [],
              max_bytes: MIB,
              stream: false,
            })
          );
          await until(() => asks.every((id) => core.reply(id)), 'every answer', 60_000);
          for (const p of batch) p.handle?.close();
          await until(() => pool.held === 0, 'the pool at 0');
          return asks.map((id) => core.reply(id).result);
        };
        // Warm: the first round grows what any first use does.
        await round();
        node.requests.length = 0;
        pool.highWater = 0;
        let results;
        const peak = await measured(async () => {
          results = await round();
        });
        expect(results.filter((r) => r.status === 200)).toHaveLength(fits);
        expect(results.filter((r) => r.failed === 'busy')).toHaveLength(64 - fits);
        report(
          `64 concurrent maximum calls from a scripted core (${fits} dialled, ${64 - fits} busy)`,
          peak,
          `the pool's high-water mark ${kib(pool.highWater)} of 64 MiB`
        );
        expect(node.requests).toHaveLength(fits);
        expect(pool.highWater).toBeLessThanOrEqual(64 * MIB);
        expect(pool.highWater).toBe(fits * wholeCharge(MIB));
        // The pool, and the scripted core's own reading of main's replies in
        // this process beside it.
        expect(peak.up).toBeLessThan(2 * 64 * MIB);
      } finally {
        for (const p of parents) p.handle?.close();
        await harness.client.stop();
        await node.close();
      }
    });
  }
);
