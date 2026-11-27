/**
 * Main's Swarm executor against the bundled node (freedom-core design 0015,
 * SWM-5's gates; the SWM-5 plan's PR 7), with the switch on: the antd
 * `npm run ant:download` fetched, on loopback, through main's executor
 * (core/swarm-shell.js) and the real Ant backend (undici on loopback, a
 * streamed body chunked).
 *
 * - **The index lookup** (0015's "against the bundled node, an index lookup
 *   with `swarm-only-root-chunk` returns `swarm-feed-index`"): `feed-v1` of
 *   the pinned core's `vectors/dweb-verify.json`, a `swarm.feed` read's
 *   `feed_head`, answered with `swarm-feed-index` and
 *   `swarm-feed-index-next` and the feed's root chunk, as the vectors
 *   recorded Ant answering it.
 * - **Chunked uploads** (0015, The transport: "whether Ant takes a chunked
 *   `/bzz` and `/bytes` upload is for SWM-5's node gate to show"; PR 6 left
 *   it here): a `bzz_file` and a `bzz_tar` streamed through the executor,
 *   and a `/bytes` body streamed on the same transport, each taken whole
 *   and answered as the same bytes sent with a length are. The node has no
 *   postage (no chain), so it answers every upload 503 `uploads not
 *   configured` once it has read and split the body; a broken tar sent
 *   chunked is refused as malformed, so the node read the tar it took.
 * - **The ready probe and a chunk read** through the executor, as a reader
 *   asks them.
 *
 * The node runs offline: its chunk cache is seeded with the vectors' chunk
 * store before it starts (`chunks.sqlite`, Ant's own layout), and its one
 * bootnode is a closed loopback port, so nothing leaves the machine.
 *
 * Gated: runs only with SWARM_NODE_E2E=1, which then requires antd
 * (ant-bin/<os>-<arch>/antd) and the Swarm vectors
 * (FREEDOM_CORE_SWARM_VECTORS, test/helpers/swarm-vectors.js), e.g.
 *   SWARM_NODE_E2E=1 FREEDOM_CORE_SWARM_VECTORS=…/freedom-core/vectors npx jest src/main/core/swarm-shell-node
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

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ShellError } = require('./core-client');
const { SwarmShell } = require('./swarm-shell');
const { MAIN_HEADERS } = require('./swarm-grammar');
const { antBackend } = require('../swarm/bzz-protocol');
const { callAnt } = require('../swarm/ant-api-call');
const { swarmBackendKind } = require('../swarm/swarm-backend-kind');
const { swarmVectors } = require('../../../test/helpers/swarm-vectors');
const { bodyClient } = require('../../../test/helpers/swarm-upload-fixtures');
const log = require('../logger');

const RUN = process.env.SWARM_NODE_E2E === '1';
const PLATFORM = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
const ANTD = path.join(
  __dirname,
  '../../../ant-bin',
  `${PLATFORM}-${process.arch}`,
  process.platform === 'win32' ? 'antd.exe' : 'antd'
);
const dwebVerify = RUN ? swarmVectors('dweb-verify.json') : null;
if (RUN && !fs.existsSync(ANTD)) {
  throw new Error(`SWARM_NODE_E2E=1 needs antd at ${ANTD}: run npm run ant:download`);
}
if (RUN && !dwebVerify) {
  throw new Error(
    "SWARM_NODE_E2E=1 needs freedom-core's Swarm vectors: set FREEDOM_CORE_SWARM_VECTORS"
  );
}
const describeIfNode = RUN
  ? describe
  : (name, fn) => describe.skip(`${name} (skipped: SWARM_NODE_E2E is not 1)`, fn);

// A node's start, and a feed walk on a cold cache.
jest.setTimeout(60_000);

const BATCH = 'c3'.repeat(32);
// A peer that can't be dialled: the node's one bootnode, a closed port.
const BOOTNODE = '/ip4/127.0.0.1/tcp/9/p2p/16Uiu2HAm4v86W3bmT1BiH6oSPzcsSr24iDQpSN5Qa992BCjjwgrD';
const NO_UPLOADS =
  'push chunk failed: uploads not configured: node cannot stamp ' +
  '(set a blockchain-rpc-endpoint or pass --postage-batch at startup)';

/** A free loopback port, as the node's API address. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Ant's chunk cache (ant-retrieval's `disk_cache.rs`, `chunks.sqlite` in
 * its data directory) holding every chunk of the vectors' store, by its
 * address: the node serves a cache hit as stored, with no peer.
 */
function seedCache(file, chunks) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE chunks (
      address BLOB PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL,
      last_access INTEGER NOT NULL, inserted_at INTEGER NOT NULL,
      pin_count INTEGER NOT NULL DEFAULT 0)`);
    const insert = db.prepare(
      'INSERT INTO chunks (address, data, size, last_access, inserted_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Math.floor(Date.now() / 1000);
    for (const [address, base64] of Object.entries(chunks)) {
      const data = Buffer.from(base64, 'base64');
      insert.run(Buffer.from(address, 'hex'), data, data.length, now, now);
    }
  } finally {
    db.close();
  }
}

/** The context the core's client calls a handler with (swarm-shell-uploads.test.js's). */
let nextAsk = 1;
function context() {
  const controller = new AbortController();
  const answered = [];
  const released = [];
  return {
    id: nextAsk++,
    signal: controller.signal,
    generation: 1,
    streams: true,
    charge: () => true,
    shrink: () => {},
    onRelease: (fn) => released.push(fn),
    onAnswer: (fn) => answered.push(fn),
    abortStream: () => {},
    release: () => {
      for (const fn of answered.splice(0)) fn();
      for (const fn of released.splice(0)) fn();
    },
  };
}

/** A whole reply as the core reads it: its JsonText parsed, the body decoded. */
function wholeOf(result) {
  const text = result.parts
    .map((part) => (typeof part === 'string' ? part : part.toString('utf8')))
    .join('');
  const reply = JSON.parse(text);
  return { ...reply, body: Buffer.from(reply.body_base64, 'base64') };
}

/** `bytes` as the core's body: a byte stream of 64 KiB views. */
function streamOf(bytes) {
  let at = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(bytes.subarray(at, at + 64 * 1024)));
        at += 64 * 1024;
      },
    },
    { highWaterMark: 0 }
  );
}

/** A ustar archive of `files` as bee-js's TarStream writes one. */
function tarOf(files) {
  const blocks = [];
  for (const { name, bytes } of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000777\0', 100);
    header.write('0001750\0', 108);
    header.write('0001750\0', 116);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, '0')}\0`,
      136
    );
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** `n` bytes of a pattern. */
function patterned(n) {
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describeIfNode('main’s Swarm executor against the bundled antd (SWARM_NODE_E2E=1)', () => {
  let dir;
  let antd;
  let origin;
  let savedSwitch;
  let stderr = '';

  beforeAll(async () => {
    savedSwitch = process.env.FREEDOM_SWARM_BACKEND;
    process.env.FREEDOM_SWARM_BACKEND = 'core';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-swarm-antd-'));
    seedCache(path.join(dir, 'chunks.sqlite'), dwebVerify.swarm.chunks);
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    antd = spawn(
      ANTD,
      [
        '--data-dir',
        dir,
        '--api-addr',
        `127.0.0.1:${port}`,
        '--no-control-socket',
        '--no-peerstore',
        '--bootnodes',
        BOOTNODE,
        '--gnosis-logs-rpc-url=',
        '--log-level',
        'warn',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GNOSIS_RPC_URL: '' } }
    );
    antd.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    // Up once its API answers.
    for (let waited = 0; ; waited += 200) {
      try {
        const res = await fetch(`${origin}/node`);
        if (res.ok) break;
      } catch {
        // Not yet listening.
      }
      if (waited > 30_000 || antd.exitCode !== null) {
        throw new Error(`antd did not start (exit ${antd.exitCode}):\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    mockRegistry.url = origin;
  });

  afterAll(async () => {
    if (antd && antd.exitCode === null) {
      const exited = new Promise((resolve) => antd.once('exit', resolve));
      antd.kill('SIGTERM');
      const timer = setTimeout(() => antd.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (savedSwitch === undefined) delete process.env.FREEDOM_SWARM_BACKEND;
    else process.env.FREEDOM_SWARM_BACKEND = savedSwitch;
  });

  beforeEach(() => log.warn.mockClear());
  afterEach(() => expect(log.warn).not.toHaveBeenCalled());

  /** The executor with the switch on, `swarm.body` answered with `body`. */
  function executor(body = null) {
    const client = bodyClient({
      answer: () => ({ result: { bytes: body.length }, body: streamOf(body) }),
    });
    return {
      client,
      shell: new SwarmShell({
        client,
        log,
        nodeUrl: () => mockRegistry.url,
        publishReadiness: async () => ({ ok: true }),
      }),
    };
  }

  let nextParent = 1;
  function parent(shell, row, params, parts = null) {
    const id = nextParent++;
    shell.open({ generation: 1, id }, { row, params, backend: antBackend(), parts });
    return {
      ready: async (check) => shell.ready({ for: id, check }, context()),
      api: async (call) => {
        const ctx = context();
        try {
          return await shell.api({ for: id, ...call }, ctx);
        } catch (err) {
          if (err instanceof ShellError) return { rule: err.data?.rule ?? err.code };
          throw err;
        } finally {
          ctx.release();
        }
      },
    };
  }

  test('the switch is on, and the node is the bundled antd on loopback', () => {
    expect(swarmBackendKind()).toBe('core');
    expect(antBackend()).toMatchObject({ url: origin, ref: { ant: 'bundled', up: true } });
  });

  test("feed-v1's index lookup: feed_head with swarm-only-root-chunk answers swarm-feed-index, as the vectors recorded", async () => {
    const feed = dwebVerify.swarm.feeds.find((f) => f.id === 'feed-v1');
    const recorded = dwebVerify.swarm.exchanges.find(
      (e) =>
        e.case === 'feed-v1' &&
        e.request.path === `/feeds/${feed.owner}/${feed.topic}` &&
        e.request.headers.some(([name]) => name === 'swarm-only-root-chunk')
    );
    const { shell } = executor();
    const reader = parent(shell, 'swarm.feed:read', {
      op: 'read',
      key: { kind: 'bee_wallet' },
      topic: feed.topic,
    });
    const reply = wholeOf(
      await reader.api({
        form: 'feed_head',
        method: 'GET',
        path: `/feeds/${feed.owner}/${feed.topic}`,
        query: [],
        headers: [['swarm-only-root-chunk', 'true']],
        max_bytes: 4201,
        stream: false,
      })
    );
    const header = (pairs, name) => pairs.find(([key]) => key === name)?.[1];
    expect(reply.status).toBe(200);
    expect(header(reply.headers, 'swarm-feed-index')).toBe('0000000000000002');
    expect(header(reply.headers, 'swarm-feed-index-next')).toBe('0000000000000003');
    // The latest update's root chunk, byte for byte the recorded answer's.
    expect(recorded.response.status).toBe(200);
    for (const name of ['swarm-feed-index', 'swarm-feed-index-next', 'content-length']) {
      expect(header(reply.headers, name)).toBe(header(recorded.response.headers, name));
    }
    expect(reply.body.toString('base64')).toBe(recorded.response.body.base64);
  });

  test('the ready probe and a chunk read: GET /node answers reachable, GET /chunks/<a> the stored chunk', async () => {
    const [address, base64] = Object.entries(dwebVerify.swarm.chunks).find(
      ([, data]) => Buffer.from(data, 'base64').length === 4104
    );
    const { shell } = executor();
    const reader = parent(shell, 'readChunk', { reference: address });
    expect(await reader.ready('reachable')).toEqual({ ok: true });
    const reply = wholeOf(
      await reader.api({
        form: 'chunk',
        method: 'GET',
        path: `/chunks/${address}`,
        query: [],
        headers: [],
        max_bytes: 4201,
        stream: false,
      })
    );
    expect(reply.status).toBe(200);
    expect(reply.body.toString('base64')).toBe(base64);
  });

  /** The same body sent with a length, on the same transport. */
  async function withLength(pathAndQuery, headers, bytes) {
    const reply = await callAnt(antBackend(), {
      path: pathAndQuery,
      method: 'POST',
      headers: new Headers([...Object.entries(MAIN_HEADERS), ...headers]),
      body: new Uint8Array(bytes),
      signal: new AbortController().signal,
    });
    return {
      status: reply.status,
      body: Buffer.from(await new Response(reply.body).arrayBuffer()),
    };
  }

  test('a bzz_file streamed through the executor: taken chunked and whole, answered as with a length', async () => {
    const bytes = patterned(300_000);
    const { shell, client } = executor(bytes);
    const headers = [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'true'],
    ];
    const publisher = parent(
      shell,
      'swarm.publish:data,file',
      {
        kind: 'file',
        parts: [{ bytes: bytes.length, part: 0 }],
        name: 'notes.bin',
        batch: BATCH,
        pin: true,
        deferred: true,
      },
      new Map([[0, bytes]])
    );
    const reply = wholeOf(
      await publisher.api({
        form: 'bzz_file',
        method: 'POST',
        path: '/bzz',
        query: [['name', 'notes.bin']],
        headers,
        body: { stream: bytes.length },
        max_bytes: 65536,
        stream: false,
      })
    );
    // One swarm.body, read to its end.
    expect(client.bodies).toHaveLength(1);
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body)).toEqual({ code: 503, message: NO_UPLOADS });
    expect(await withLength('/bzz?name=notes.bin', headers, bytes)).toEqual({
      status: 503,
      body: reply.body,
    });
  });

  test('a bzz_tar streamed through the executor: the node reads the tar it took (a broken one is malformed), and answers a whole one as with a length', async () => {
    const page = Buffer.from('<h1>Freedom</h1>');
    const tar = tarOf([{ name: 'index.html', bytes: page }]);
    const headers = [
      ['content-type', 'application/x-tar'],
      ['swarm-collection', 'true'],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'true'],
      ['swarm-index-document', 'index.html'],
    ];
    const upload = async (body) => {
      const { shell } = executor(body);
      const publisher = parent(
        shell,
        'swarm.publish:collection',
        {
          kind: 'collection',
          parts: [{ path: 'index.html', bytes: page.length, part: 0 }],
          batch: BATCH,
          pin: true,
          deferred: true,
        },
        new Map([[0, page]])
      );
      return wholeOf(
        await publisher.api({
          form: 'bzz_tar',
          method: 'POST',
          path: '/bzz',
          query: [],
          headers,
          body: { stream: body.length },
          max_bytes: 65536,
          stream: false,
        })
      );
    };
    const whole = await upload(tar);
    expect(whole.status).toBe(503);
    expect(JSON.parse(whole.body)).toEqual({ code: 503, message: NO_UPLOADS });
    expect(await withLength('/bzz', headers, tar)).toEqual({ status: 503, body: whole.body });
    // The same length of noise: the node parsed what it took.
    const broken = await upload(patterned(tar.length));
    expect(broken.status).toBe(400);
    expect(JSON.parse(broken.body).message).toMatch(/^malformed tar entry/);
  });

  test('a /bytes body streamed on the same transport: taken chunked, answered as with a length', async () => {
    const bytes = patterned(300_000);
    const headers = [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
    ];
    const reply = await callAnt(antBackend(), {
      path: '/bytes',
      method: 'POST',
      headers: new Headers([...Object.entries(MAIN_HEADERS), ...headers]),
      body: streamOf(bytes),
      signal: new AbortController().signal,
    });
    const body = Buffer.from(await new Response(reply.body).arrayBuffer());
    expect(reply.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ code: 503, message: NO_UPLOADS });
    expect(await withLength('/bytes', headers, bytes)).toEqual({ status: 503, body });
  });
});
