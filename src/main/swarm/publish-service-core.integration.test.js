/**
 * freedom://publish on both Swarm backends (freedom-core design 0015,
 * "Methods main calls", Uploads, Bounds, SWM-8's Done-when and the
 * 2026-11-28 amendment; the SWM-6 to SWM-9 plan's PR 8.3): the IPC
 * handlers of publish-service.js and stamp-service.js in a development
 * build on `js` (bee-js, main's own publish-history.sqlite) and on `core`
 * (FREEDOM_SWARM_BACKEND=core: the build's own hello, the real
 * freedom-cored 0.33.0, main's executor as production registers it),
 * against the same node on loopback.
 *
 * - **The IPC cases:** each `shell` case of the pinned core's
 *   `vectors/swarm.json` that records freedom://publish's handler
 *   (`swarm:publish-data`, `-file`, `-directory`), its node scripted with
 *   the case's replies: on each backend the handler's answer is the
 *   reference's (on `core`, a case marked `picked-read-text` answers the
 *   core's text), the newest history row is the reference's (the core's
 *   for `picked-read-text`), and the node took the reference's requests
 *   (method, path, query, the headers bee-js sends, the body; a tar by its
 *   entries). On `core` main sent the case's `swarm.publish` params
 *   exactly, and kept no row itself. The `swarm.stamps` and
 *   `swarm.upload_status` cases through `swarm:get-stamps` and
 *   `swarm:get-upload-status` answer the same on both backends, and as the
 *   reference read them. The handlers' own refusals (no data, no file, no
 *   folder, a spent token) answer the same.
 * - **F-3:** a picked folder named in 124 UTF-8 bytes, holding a file and
 *   a subfolder each named in 124 bytes: on `core` every path reaches the
 *   node whole in the tar and the row keeps the folder's name; on `js`
 *   bee-js's tar writer cuts both names to 100 bytes (upstream's bug,
 *   design 0015's `tar-paths`).
 * - **U13:** a picked file that grows, or shrinks, after main read its size
 *   and before the upload reads it: on `core` freedom://publish answers
 *   `Internal error` and the row keeps that text; on `js` bee-js's
 *   transport text shows instead.
 * - **A folder past one request frame** (26,200 empty files, a named
 *   difference pending the user's decision): on `core` refused before
 *   anything is sent, `This folder has too many files to publish through
 *   the core`, its row failed with that text, the node asked nothing; on
 *   `js` bee-js uploads it, and its row is kept.
 * - **A history row that can't be inserted** (a corrupt
 *   publish-history.sqlite): each handler's invoke rejects on both
 *   backends, as js's `addEntry` throws before the handler's `try`, and
 *   the node is asked nothing.
 *
 * Skipped without the binary; FREEDOM_CORED_STORES_TEST=1 requires it (npm
 * run core:download), as FREEDOM_CORED_PATH names one. The vector cases
 * also need freedom-core's `vectors/swarm.json` (test/helpers/swarm-vectors.js),
 * required where FREEDOM_CORE_SWARM_VECTORS names the directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');
const { swarmVectors, swarmVectorsRequired } = require('../../../test/helpers/swarm-vectors');

jest.setTimeout(180_000);

const SRC = path.join(__dirname, '..');
const SRC_PATH = (rel) => path.join(SRC, rel);

/** The pinned freedom-cored, or null (the suite skips). */
function coredBinary() {
  const required = process.env.FREEDOM_CORED_STORES_TEST === '1';
  const binary =
    process.env.FREEDOM_CORED_PATH ||
    (required ? jest.requireActual(SRC_PATH('core/cored-binary.js')).getCoredBinaryPath() : null);
  if (required && (!binary || !fs.existsSync(binary))) {
    throw new Error('FREEDOM_CORED_STORES_TEST=1 needs freedom-cored: run npm run core:download');
  }
  return binary && fs.existsSync(binary) ? binary : null;
}

const BINARY = coredBinary();
const describeIfCore = BINARY ? describe : describe.skip;
const VECTORS = swarmVectors('swarm.json');
if (swarmVectorsRequired && !VECTORS)
  throw new Error('FREEDOM_CORE_SWARM_VECTORS has no swarm.json');
const testIfVectors = VECTORS ? test : test.skip;

const SILENT = { info() {}, warn() {}, error() {}, debug() {}, log() {}, verbose() {} };
const SENDER = Object.freeze({ id: 7, once() {} });
const BATCH = 'a1'.repeat(32);
const STAMPS = {
  stamps: [
    {
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
    },
  ],
};
const REFERENCE = 'b2'.repeat(32);
const TAG = 101;
/** The core's text for a history it can't open, read or write (stores.rs `HISTORY_FAILED`). */
const HISTORY_FAILED = 'The publish history could not be read or written';
const FOLDER_TOO_LARGE = 'This folder has too many files to publish through the core';
/** Codex's folder: this many empty files, f0 onwards. */
const MANY_FILES = 26_200;

/** freedom://publish's handler cases, the stamps' and the upload status's. */
const CASES = VECTORS ? VECTORS.shell : [];
const HANDLER_CASES = CASES.filter(
  (c) => c.method === 'swarm.publish' && c.steps.length === 1 && c.steps[0].handler
);
const STAMPS_CASES = CASES.filter((c) => c.method === 'swarm.stamps' && !c.steps[0].params.id);
const STATUS_CASES = CASES.filter((c) => c.method === 'swarm.upload_status');

const b64 = (base64) => Buffer.from(base64, 'base64');
/** A recorded body: `{ bytes, base64 }`. */
const bodyOf = (body) => (body ? b64(body.base64 ?? '') : Buffer.alloc(0));
/** The headers bee-js's requests carry that say what the node is to do. */
const SAID = (name) => name === 'content-type' || name.startsWith('swarm-');

/**
 * The entries of a tar as bee-js's TarStream or the core's writer makes
 * it: each file's path (a GNU long link's, else the ustar prefix and name,
 * read as UTF-8), and its bytes.
 */
function tarEntries(buf) {
  const out = [];
  let at = 0;
  let longName = null;
  const text = (bytes) => {
    const end = bytes.indexOf(0);
    return (end < 0 ? bytes : bytes.subarray(0, end)).toString('utf8');
  };
  while (at + 512 <= buf.length) {
    const header = buf.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const data = Buffer.from(buf.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = text(data);
      continue;
    }
    const name = text(header.subarray(0, 100));
    const prefix = text(header.subarray(345, 500));
    out.push({ path: longName ?? (prefix ? `${prefix}/${name}` : name), data });
    longName = null;
  }
  return out;
}

/** A request as the comparisons read it: what it asked the node to do. */
function asked({ method, url, headers, body }) {
  const { pathname, search } = new URL(url, 'http://node');
  const said = Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => SAID(name))
      .sort(([a], [b]) => a.localeCompare(b))
  );
  const tar = said['content-type'] === 'application/x-tar';
  return {
    method,
    path: `${pathname}${search}`,
    headers: said,
    body: tar ? tarEntries(body) : body.toString('base64'),
  };
}

/** A vector's recorded request, in `asked`'s form. */
function recorded(request) {
  const query = request.query?.length ? `?${new URLSearchParams(request.query)}` : '';
  return asked({
    method: request.method,
    url: `${request.path}${query}`,
    headers: Object.fromEntries(request.headers),
    body: bodyOf(request.body),
  });
}

/** A history row without the clock's members and its id. */
const rowOf = (row) => {
  const { id: _id, timestamp: _timestamp, completedAt: _completedAt, ...rest } = row;
  return rest;
};

/**
 * A node on loopback: each request kept (`seen`) with its whole body, and
 * answered by `answer(request)` (`{ status, statusText, headers, body }`),
 * the case's script, or a 500 nothing scripted. `onRequest(request)` sees
 * each before its answer.
 */
async function startScriptedNode() {
  const state = { seen: [], answer: null, onRequest: null };
  const node = await startFakeHttpNode({
    handler: (req, res) => {
      const parts = [];
      req.on('data', (part) => parts.push(part));
      req.on('end', async () => {
        const request = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(parts),
        };
        state.seen.push(request);
        await state.onRequest?.(request);
        const reply = state.answer?.(request) ?? {
          status: 500,
          statusText: 'Internal Server Error',
          headers: [['content-type', 'application/json']],
          body: Buffer.from(
            JSON.stringify({ code: 500, message: `unscripted ${req.method} ${req.url}` })
          ),
        };
        const headers = Object.fromEntries(
          reply.headers.filter(([name]) => name !== 'content-length')
        );
        headers['content-length'] = String(reply.body.length);
        res.writeHead(reply.status, reply.statusText, headers);
        res.end(reply.body);
      });
    },
  });
  return Object.assign(node, { state });
}

/** The answers of a case's recorded requests, by method and path, in order (the last repeats). */
function scriptOf(requests) {
  const queues = new Map();
  for (const r of requests) {
    const key = `${r.method} ${r.path}`;
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push({
      status: r.reply.status,
      statusText: r.reply.status_text,
      headers: r.reply.headers,
      body: bodyOf(r.reply.body),
    });
  }
  return (request) => {
    const queue = queues.get(`${request.method} ${new URL(request.url, 'http://node').pathname}`);
    if (!queue) return null;
    return queue.length > 1 ? queue.shift() : queue[0];
  };
}

/** A node that answers `/stamps` with STAMPS and every `/bzz` upload with REFERENCE and TAG. */
function storingScript(request) {
  const json = (status, body, extra = []) => ({
    status,
    statusText: status === 200 ? 'OK' : 'Created',
    headers: [['content-type', 'application/json; charset=utf-8'], ...extra],
    body: Buffer.from(JSON.stringify(body)),
  });
  const { pathname } = new URL(request.url, 'http://node');
  if (request.method === 'GET' && pathname === '/stamps') return json(200, STAMPS);
  if (request.method === 'POST' && pathname === '/bzz') {
    return json(201, { reference: REFERENCE }, [['swarm-tag', String(TAG)]]);
  }
  return null;
}

const world = {
  root: null,
  node: null,
  // The backend loaded now: its IPC handlers, its profile, its core.
  current: null,
};

/** Main's boundaries for a fresh registry: Electron, the profile, the node's URL, the core's process. */
function mockBoundaries() {
  const mock = (rel, factory) => jest.doMock(SRC_PATH(rel), factory);
  jest.doMock(
    'electron',
    () => ({
      ipcMain: {
        handle: (channel, fn) => world.current.ipc.set(channel, fn),
        on() {},
        removeHandler: (channel) => world.current.ipc.delete(channel),
      },
      app: {
        getPath: () => world.current.dir,
        getVersion: () => '0.0.0-jest',
        isPackaged: false,
        on() {},
        whenReady: async () => {},
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [world.current.pick] }),
      },
      BrowserWindow: { getAllWindows: () => [], fromId: () => null, getFocusedWindow: () => null },
      session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      webContents: { fromId: () => null, getAllWebContents: () => [] },
      nativeTheme: {},
      shell: {},
    }),
    { virtual: true }
  );
  jest.doMock('electron-log', () => SILENT);
  mock('logger.js', () => SILENT);
  mock('service-registry.js', () => ({
    ...jest.requireActual(SRC_PATH('service-registry.js')),
    getAntApiUrl: () => world.node.origin,
    getService: (name) => (name === 'ant' ? { mode: 'bundled' } : null),
    onServiceChange: () => () => {},
  }));
  mock('freedom-root.js', () => ({
    ...jest.requireActual(SRC_PATH('freedom-root.js')),
    getFreedomDataDir: () => world.current.dir,
    getFreedomDataPath: (name) => path.join(world.current.dir, name),
  }));
  mock('private/private-windows.js', () => ({
    isPrivateWebContents: () => false,
    getPartitionForWebContents: () => null,
  }));
  mock('swarm/publish-setup-service.js', () => ({
    getPublishReadiness: async () => ({ ok: true }),
  }));
  mock('ant-manager.js', () => ({ restartingUrl: () => null }));
  mock('core/dweb-verify.js', () => ({ dwebVerifier: () => null }));
  mock('core/naming.js', () => ({ namingDriver: () => null }));
  mock('profile-resolver.js', () => ({ getActiveProfile: () => ({ id: 'default' }) }));
  mock('core/core-process.js', () => ({
    getCoreClient: () => world.current.client,
    getSwarmShell: () => world.current.shell,
    isCoreRunning: () => Boolean(world.current.client),
  }));
}

/**
 * The build on `backend`, as main runs it: the switch read once from
 * FREEDOM_SWARM_BACKEND, the IPC handlers registered as index.js does, and
 * on `core` the pinned core started with the build's own hello and main's
 * executor registered on it. Each request main sends the core is kept in
 * `sent` (`{ method, params }`). `beforeStart(dir)` sees the profile's
 * directory first.
 */
async function loadBackend(backend, { beforeStart = null } = {}) {
  const dir = fs.mkdtempSync(path.join(world.root, `${backend}-`));
  // The profile as it is before the build starts (its stores' files).
  beforeStart?.(dir);
  const current = { backend, dir, ipc: new Map(), pick: null, client: null, shell: null, sent: [] };
  world.current = current;
  process.env.FREEDOM_SWARM_BACKEND = backend;
  jest.resetModules();
  mockBoundaries();
  if (backend === 'core') {
    const { CoreClient } = require(SRC_PATH('core/core-client.js'));
    const client = new CoreClient({
      spawn,
      command: BINARY,
      args: [
        'serve',
        '--data-dir',
        path.join(dir, 'identity'),
        '--lock-dir',
        path.join(dir, 'locks'),
      ],
      log: SILENT,
      shellVersion: 'jest',
      grantRoot: dir,
      userDataDir: dir,
    });
    const request = client.request.bind(client);
    client.request = (method, params, ...rest) => {
      current.sent.push({ method, params });
      return request(method, params, ...rest);
    };
    current.client = client;
    current.shell = require(SRC_PATH('core/swarm-shell.js')).registerSwarmShell(client);
    current.hello = await client.start();
    current.exits = [];
    client.current.child.on('exit', (code, signal) => current.exits.push(code ?? signal));
  }
  require(SRC_PATH('swarm/publish-service.js')).registerPublishIpc();
  require(SRC_PATH('swarm/stamp-service.js')).registerSwarmIpc();
  require(SRC_PATH('swarm/publish-history.js')).registerPublishHistoryIpc();
  current.kind = require(SRC_PATH('swarm/swarm-backend-kind.js')).swarmBackendKind();
  current.storesNamed = require(SRC_PATH('core/core-client.js')).swarmStoresNamed();
  return current;
}

async function unload(current) {
  if (!current) return;
  if (current.backend === 'js') {
    try {
      require(SRC_PATH('swarm/publish-history.js')).closeDb();
    } catch {
      // Never opened.
    }
  }
  await current.client?.stop();
}

/** An IPC handler of the backend loaded now, as the chrome's invoke reaches it. */
function invoke(channel, ...args) {
  const handler = world.current.ipc.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({ sender: SENDER }, ...args);
}

/** A pick of `chosen` (an absolute path) through the native dialog: its token. */
async function pick(kind, chosen) {
  world.current.pick = chosen;
  const picked = await invoke(kind === 'file' ? 'swarm:pick-file' : 'swarm:pick-directory');
  expect(picked).toEqual({ success: true, token: expect.any(String), name: path.basename(chosen) });
  return picked.token;
}

/** The newest history row, through the chrome's handler. */
async function newestRow() {
  const history = await invoke('swarm:get-publish-history');
  expect(history.success).toBe(true);
  return history.entries[0] ?? null;
}

/**
 * A handler case's input made real in `dir`: the data, or the picked
 * file or folder (the vector names it `<the picked …>`), and the channel
 * with its argument.
 */
async function inputOf(c, dir) {
  const [step] = c.steps;
  const { params } = step;
  const channel = step.handler.channel;
  if (channel === 'swarm:publish-data') {
    const [arg] = step.reference.args.array;
    return { channel, arg: Buffer.from(arg.base64, 'base64') };
  }
  const caseDir = fs.mkdtempSync(path.join(dir, 'case-'));
  if (channel === 'swarm:publish-file') {
    const file = path.join(caseDir, params.name);
    if (c.deviation === 'picked-read-text') fs.mkdirSync(file);
    else fs.writeFileSync(file, bodyOf(step.parts[0]));
    return { channel, arg: await pick('file', file) };
  }
  const folder = path.join(caseDir, params.history.name);
  params.parts.forEach((part, i) => {
    const file = path.join(folder, ...part.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bodyOf(step.parts[i]));
  });
  return { channel, arg: await pick('directory', folder) };
}

/**
 * Plays handler case `c` on the backend loaded now: `{ answer, row,
 * requests, sent }`, the requests the node took and, on `core`, the
 * `swarm.publish` params main sent.
 */
async function playHandlerCase(c) {
  await invoke('swarm:clear-publish-history');
  const input = await inputOf(c, world.current.dir);
  world.node.state.seen = [];
  world.node.state.answer = scriptOf(c.steps[0].requests);
  const before = world.current.sent.length;
  const answer = await invoke(input.channel, input.arg);
  const requests = world.node.state.seen.map(asked);
  const sent = world.current.sent.slice(before).filter((s) => s.method === 'swarm.publish');
  return { answer, row: await newestRow(), requests, sent, input };
}

/** The 124-byte names of F-3's folder: 60 two-byte characters and `.txt`, and 62 of them. */
const LONG_FILE = `${'é'.repeat(60)}.txt`;
const LONG_DIR = 'é'.repeat(62);

/** F-3's picked folder: named in 124 bytes, with a file and a subfolder each named in 124 bytes. */
function longNamedFolder(dir) {
  const folder = path.join(fs.mkdtempSync(path.join(dir, 'f3-')), LONG_DIR);
  fs.mkdirSync(path.join(folder, LONG_DIR), { recursive: true });
  fs.writeFileSync(path.join(folder, LONG_FILE), 'a long name');
  fs.writeFileSync(path.join(folder, LONG_DIR, 'index.html'), '<h1>f3</h1>');
  return folder;
}

/** U13: a picked file whose size changes once main has read it, as the node is asked for `/stamps`. */
async function publishChangingFile(change) {
  const dir = fs.mkdtempSync(path.join(world.current.dir, 'u13-'));
  const file = path.join(dir, 'draft.txt');
  fs.writeFileSync(file, 'x'.repeat(1000));
  const token = await pick('file', file);
  await invoke('swarm:clear-publish-history');
  world.node.state.seen = [];
  world.node.state.answer = storingScript;
  world.node.state.onRequest = (request) => {
    if (request.method !== 'GET' || request.url !== '/stamps') return;
    if (change === 'grows') fs.appendFileSync(file, 'y'.repeat(10));
    else fs.truncateSync(file, 500);
  };
  try {
    const answer = await invoke('swarm:publish-file', token);
    return { answer, row: await newestRow() };
  } finally {
    world.node.state.onRequest = null;
  }
}

/** Codex's picked folder, made once: MANY_FILES empty files, f0 onwards. */
function manyFilesFolder() {
  const folder = path.join(world.root, 'many');
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder);
    for (let i = 0; i < MANY_FILES; i += 1) fs.writeFileSync(path.join(folder, `f${i}`), '');
  }
  return folder;
}

/** The answers both backends gave, by case. */
const answers = { js: new Map(), core: new Map() };

describeIfCore('freedom://publish on js and on the core (real freedom-cored)', () => {
  let savedBackend;

  beforeAll(async () => {
    savedBackend = process.env.FREEDOM_SWARM_BACKEND;
    world.root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-core-'));
    world.node = await startScriptedNode();
  });

  afterAll(async () => {
    await unload(world.current);
    await world.node?.close();
    if (savedBackend === undefined) delete process.env.FREEDOM_SWARM_BACKEND;
    else process.env.FREEDOM_SWARM_BACKEND = savedBackend;
    fs.rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  for (const backend of ['js', 'core']) {
    describe(`on ${backend}`, () => {
      beforeAll(async () => {
        await unload(world.current);
        await loadBackend(backend);
      });

      test("the switch and the hello are the build's own", () => {
        expect(world.current.kind).toBe(backend);
        expect(world.current.storesNamed).toBe(backend === 'core');
        if (backend === 'core') expect(world.current.hello.store_moved).toContain('swarm_stores');
      });

      testIfVectors(
        "each of freedom://publish's handler cases answers the reference's, its row the reference's, its requests the reference's",
        async () => {
          expect(HANDLER_CASES.map((c) => c.id).sort()).toEqual([
            'publish-data-history',
            'publish-data-history-no-stamps',
            'publish-data-history-node-500',
            'publish-data-history-not-yet-known',
            'publish-directory-history',
            'publish-directory-history-not-yet-known',
            'publish-file-history',
            'publish-file-history-node-500',
            'publish-file-history-not-yet-known',
            'publish-file-history-unreadable',
          ]);
          for (const c of HANDLER_CASES) {
            const [step] = c.steps;
            const played = await playHandlerCase(c);
            const coreText = backend === 'core' && c.deviation === 'picked-read-text';
            const expected = coreText
              ? { success: false, error: c.core.answers[0].error_typed.object[0][1].string }
              : step.handler.answer;
            expect({ id: c.id, answer: played.answer }).toEqual({ id: c.id, answer: expected });
            const row = (coreText ? c.core.history : c.after.history)[0];
            expect({ id: c.id, row: rowOf(played.row) }).toEqual({ id: c.id, row: rowOf(row) });
            // The core made its upload call for picked-read-text, which main's
            // part ended; bee-js's fetch failed before the node took it.
            const expectedRequests = step.requests.map(recorded);
            if (c.deviation === 'picked-read-text') {
              expect(played.requests.slice(0, expectedRequests.length)).toEqual(expectedRequests);
            } else {
              expect({ id: c.id, requests: played.requests }).toEqual({
                id: c.id,
                requests: expectedRequests,
              });
            }
            if (backend === 'core') {
              // Main sent the case's params; a folder picked as a file is the size its stat gave.
              const params = structuredClone(step.params);
              if (c.deviation === 'picked-read-text') {
                params.parts[0].bytes = fs.statSync(world.current.pick).size;
              }
              expect({ id: c.id, sent: played.sent }).toEqual({
                id: c.id,
                sent: [{ method: 'swarm.publish', params }],
              });
            }
            answers[backend].set(c.id, played.answer);
          }
        }
      );

      testIfVectors(
        'the stamps and the upload status answer as the reference read them',
        async () => {
          expect(STAMPS_CASES.length).toBeGreaterThanOrEqual(3);
          for (const c of STAMPS_CASES) {
            const [step] = c.steps;
            world.node.state.answer = scriptOf(step.requests);
            const answer = await invoke('swarm:get-stamps');
            const reference = step.reference;
            if (reference.error) {
              expect({ id: c.id, answer }).toEqual({
                id: c.id,
                answer: { success: false, error: reference.error.message },
              });
            } else {
              expect(answer.success).toBe(true);
              expect(
                answer.stamps.map(({ batchId, sizeBytes, remainingBytes, ttlSeconds, usable }) => ({
                  batchId,
                  sizeBytes,
                  remainingBytes,
                  ttlSeconds,
                  usable,
                }))
              ).toEqual(
                reference.result.map((b) => ({
                  batchId: b.batchID,
                  sizeBytes: b.size,
                  remainingBytes: b.remainingSize,
                  ttlSeconds: b.duration,
                  usable: b.usable,
                }))
              );
            }
            answers[backend].set(c.id, answer);
          }
          expect(STATUS_CASES.length).toBeGreaterThanOrEqual(3);
          for (const c of STATUS_CASES) {
            const [step] = c.steps;
            world.node.state.answer = scriptOf(step.requests);
            const answer = await invoke('swarm:get-upload-status', step.params.tag_uid);
            const expected = step.reference.error
              ? { success: false, error: step.reference.error.message }
              : { success: true, ...step.reference.result };
            expect({ id: c.id, answer }).toEqual({ id: c.id, answer: expected });
            answers[backend].set(c.id, answer);
          }
        }
      );

      test("the handlers' own refusals answer the same", async () => {
        expect(await invoke('swarm:publish-data', null)).toEqual({
          success: false,
          error: 'Data is required',
        });
        const dir = fs.mkdtempSync(path.join(world.current.dir, 'gone-'));
        const file = path.join(dir, 'gone.txt');
        fs.writeFileSync(file, 'soon gone');
        const fileToken = await pick('file', file);
        fs.rmSync(file);
        expect(await invoke('swarm:publish-file', fileToken)).toEqual({
          success: false,
          error: 'File not found: gone.txt',
        });
        // Spent.
        expect(await invoke('swarm:publish-file', fileToken)).toEqual({
          success: false,
          error: 'That selection is no longer valid. Choose the file or folder again.',
        });
        const folder = path.join(dir, 'site');
        fs.mkdirSync(folder);
        const folderToken = await pick('directory', folder);
        fs.rmSync(folder, { recursive: true });
        expect(await invoke('swarm:publish-directory', folderToken)).toEqual({
          success: false,
          error: 'Directory not found: site',
        });
        expect(await invoke('swarm:get-upload-status', 'x')).toEqual({
          success: false,
          error: 'Tag UID is required',
        });
      });

      test('an empty folder goes as an empty tar, and its row is kept', async () => {
        const empty = path.join(fs.mkdtempSync(path.join(world.current.dir, 'empty-')), 'nothing');
        fs.mkdirSync(empty);
        const token = await pick('directory', empty);
        await invoke('swarm:clear-publish-history');
        world.node.state.seen = [];
        world.node.state.answer = storingScript;
        const answer = await invoke('swarm:publish-directory', token);
        expect(answer).toEqual({
          success: true,
          reference: REFERENCE,
          bzzUrl: `bzz://${REFERENCE}`,
          tagUid: TAG,
        });
        const upload = world.node.state.seen.find((r) => r.method === 'POST');
        expect(upload.body).toEqual(Buffer.alloc(1024));
        expect(rowOf(await newestRow())).toMatchObject({
          type: 'directory',
          name: 'nothing',
          status: 'completed',
          bytesSize: 0,
        });
        answers[backend].set('empty-folder', answer);
      });

      test(
        backend === 'core'
          ? 'F-3: a folder with 124-byte names reaches the node with every name whole'
          : "F-3: bee-js's tar writer cuts a folder's 124-byte names to 100 bytes",
        async () => {
          expect(Buffer.byteLength(LONG_FILE)).toBe(124);
          expect(Buffer.byteLength(LONG_DIR)).toBe(124);
          const folder = longNamedFolder(world.current.dir);
          const token = await pick('directory', folder);
          await invoke('swarm:clear-publish-history');
          world.node.state.seen = [];
          world.node.state.answer = storingScript;
          const answer = await invoke('swarm:publish-directory', token);
          expect(answer).toEqual({
            success: true,
            reference: REFERENCE,
            bzzUrl: `bzz://${REFERENCE}`,
            tagUid: TAG,
          });
          const upload = world.node.state.seen.find((r) => r.method === 'POST');
          const entries = tarEntries(upload.body).map((e) => [e.path, e.data.toString('utf8')]);
          const whole = [
            [`${LONG_DIR}/index.html`, '<h1>f3</h1>'],
            [LONG_FILE, 'a long name'],
          ];
          if (backend === 'core') {
            expect(entries.sort()).toEqual(whole.sort());
          } else {
            // Upstream's bug, design 0015's tar-paths: each cut to 100 bytes.
            for (const [name] of entries) expect(Buffer.byteLength(name)).toBe(100);
            expect(entries.map(([name]) => name)).not.toContain(LONG_FILE);
          }
          expect(rowOf(await newestRow())).toMatchObject({
            type: 'directory',
            name: LONG_DIR,
            status: 'completed',
            reference: REFERENCE,
          });
        }
      );

      for (const change of ['grows', 'shrinks']) {
        test(
          backend === 'core'
            ? `U13: a picked file that ${change} mid-upload shows "Internal error"`
            : `U13: a picked file that ${change} mid-upload shows bee-js's transport text`,
          async () => {
            const { answer, row } = await publishChangingFile(change);
            expect(answer.success).toBe(false);
            if (backend === 'core') {
              expect(answer).toEqual({ success: false, error: 'Internal error' });
              expect(rowOf(row)).toMatchObject({
                type: 'file',
                name: 'draft.txt',
                status: 'failed',
                errorMessage: 'Internal error',
              });
            } else {
              expect(answer.error).not.toBe('Internal error');
              expect(rowOf(row)).toMatchObject({
                type: 'file',
                name: 'draft.txt',
                status: 'failed',
                errorMessage: answer.error,
              });
            }
          }
        );
      }

      test(
        backend === 'core'
          ? `a folder of ${MANY_FILES} files, past one request frame: refused before anything is sent, its row failed (a named difference)`
          : `a folder of ${MANY_FILES} files: bee-js uploads it, and its row is kept`,
        async () => {
          const folder = manyFilesFolder();
          const token = await pick('directory', folder);
          await invoke('swarm:clear-publish-history');
          world.node.state.seen = [];
          world.node.state.answer = storingScript;
          const before = world.current.sent.length;
          const answer = await invoke('swarm:publish-directory', token);
          const row = rowOf(await newestRow());
          if (backend === 'core') {
            expect(answer).toEqual({ success: false, error: FOLDER_TOO_LARGE });
            expect(row).toMatchObject({
              type: 'directory',
              name: 'many',
              status: 'failed',
              errorMessage: FOLDER_TOO_LARGE,
              origin: 'freedom://publish',
            });
            expect(world.node.state.seen).toEqual([]);
            // No swarm.publish went; the row is the core's swarm.history's.
            const sent = world.current.sent.slice(before).map((s) => s.method);
            expect(sent).not.toContain('swarm.publish');
            expect(sent).toContain('swarm.history');
            // Its request, as the client would have framed it, passes 1 MiB.
            const own = require(SRC_PATH('core/swarm-own-calls.js'));
            const parts = (await own.walkDirectory(folder)).map(({ path: p, file, size }) => ({
              path: p,
              file,
              size,
            }));
            expect(parts).toHaveLength(MANY_FILES);
            const { params } = own.publishParams({
              kind: 'collection',
              parts,
              deferred: true,
              history: { type: 'directory', name: 'many' },
            });
            expect(own.requestBytes('swarm.publish', params)).toBeGreaterThan(1024 * 1024);
          } else {
            expect(answer).toEqual({
              success: true,
              reference: REFERENCE,
              bzzUrl: `bzz://${REFERENCE}`,
              tagUid: TAG,
            });
            const upload = world.node.state.seen.find((r) => r.method === 'POST');
            expect(tarEntries(upload.body)).toHaveLength(MANY_FILES);
            expect(row).toMatchObject({
              type: 'directory',
              name: 'many',
              status: 'completed',
              reference: REFERENCE,
            });
          }
        }
      );

      if (backend === 'core') {
        test('the core never restarted, and every request went with its parent', () => {
          expect(world.current.exits).toEqual([]);
          expect(world.current.shell.stats()).toMatchObject({
            parents: 0,
            calls: 0,
            uploads: 0,
            parts: 0,
          });
        });
      }

      // Last: on a build of its own, whose profile has a corrupt history.
      test(
        backend === 'core'
          ? "a row the core can't insert rejects each handler's invoke, as js's addEntry throws, and the node is asked nothing"
          : "a row main can't insert rejects each handler's invoke (addEntry throws before the handler's try)",
        async () => {
          await unload(world.current);
          await loadBackend(backend, {
            beforeStart: (dir) =>
              fs.writeFileSync(path.join(dir, 'publish-history.sqlite'), Buffer.alloc(4096, 0x78)),
          });
          const dir = fs.mkdtempSync(path.join(world.current.dir, 'unkept-'));
          const file = path.join(dir, 'notes.txt');
          fs.writeFileSync(file, 'notes');
          const folder = path.join(dir, 'site');
          fs.mkdirSync(folder);
          fs.writeFileSync(path.join(folder, 'index.html'), '<h1>site</h1>');
          const inputs = [
            ['swarm:publish-data', 'hello'],
            ['swarm:publish-file', await pick('file', file)],
            ['swarm:publish-directory', await pick('directory', folder)],
          ];
          world.node.state.seen = [];
          world.node.state.answer = storingScript;
          const before = world.current.sent.length;
          for (const [channel, arg] of inputs) {
            const played = await invoke(channel, arg).then(
              (answer) => ({ channel, answer }),
              (error) => ({ channel, error })
            );
            // Rejected, never a publish result.
            expect({ channel, answer: played.answer }).toEqual({ channel, answer: undefined });
            expect(played.error).toBeInstanceOf(Error);
            if (backend === 'core') expect(played.error.message).toBe(HISTORY_FAILED);
            else expect(played.error.message).toMatch(/not a database/);
          }
          expect(world.node.state.seen).toEqual([]);
          if (backend === 'core') {
            // Each went as its swarm.publish with history, which the core
            // answered before it asked main anything.
            const sent = world.current.sent.slice(before);
            expect(sent.map((s) => [s.method, s.params.history?.type])).toEqual([
              ['swarm.publish', 'data'],
              ['swarm.publish', 'file'],
              ['swarm.publish', 'directory'],
            ]);
            expect(world.current.exits).toEqual([]);
            expect(world.current.shell.stats()).toMatchObject({ parents: 0, calls: 0 });
          }
        }
      );
    });
  }

  testIfVectors('both backends gave every case the same answer', () => {
    expect(answers.core.size).toBe(answers.js.size);
    for (const [id, js] of answers.js) {
      const core = answers.core.get(id);
      const c = CASES.find((x) => x.id === id);
      if (c?.deviation === 'picked-read-text') continue;
      if (Array.isArray(js?.stamps)) {
        // A batch's rough expiry is counted from each read's own clock.
        const strip = (a) => ({
          ...a,
          stamps: a.stamps.map(({ expiresApprox: _expires, ...s }) => s),
        });
        expect({ id, answer: strip(core) }).toEqual({ id, answer: strip(js) });
        js.stamps.forEach((s, i) => {
          if (s.expiresApprox === null) expect(core.stamps[i].expiresApprox).toBeNull();
          else
            expect(
              Math.abs(Date.parse(core.stamps[i].expiresApprox) - Date.parse(s.expiresApprox))
            ).toBeLessThan(60_000);
        });
        continue;
      }
      expect({ id, answer: core }).toEqual({ id, answer: js });
    }
  });
});
