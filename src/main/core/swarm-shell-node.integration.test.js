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
 *   it here), and the chunked form of every other write main can send a
 *   remote node, which a POST sent as a one-shot stream would take (point
 *   6, Codex's review of #1343): `chunk_up`, `soc_up`, `pss_send` and
 *   `feed_manifest`. A loopback tap in front of the node reads what
 *   crossed it: each chunked body went whole, its last chunk included,
 *   and the node answered only after it. The node has no postage (no
 *   chain), so an upload it takes fails past its handler, 503 or 500
 *   depending on its state, as the same request with a length does. Where
 *   the handler checks the body first, a body at its bound passes and one
 *   byte more is refused, chunked, so the node measured what it took: a
 *   chunk's 4104 bytes, a PSS message's 4000, a SOC's signature over its
 *   last byte, and a tar it parses (a broken one is malformed).
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

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
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
// A SOC the node takes: `write-soc-no-feed-grant` of the pinned core's
// vectors/swarm-grammar.json (its owner, identifier, signature and body),
// written out since CI's node gate checks out dweb-verify.json alone.
const SOC = {
  path:
    '/soc/a274614c1d3425568fd100b30322287c86085220/' +
    '4242424242424242424242424242424242424242424242424242424242424242',
  sig:
    '5fa3e7d1f3337b04bae5f71fe219360ff73dcb19b4ce7733de72ff7ff755d2aa' +
    '2afcd7de6820a1f0dc48d6e1beb171895491b00d160800ef5e33d9f1401fb6db1c',
  body: Buffer.from('AQAAAAAAAAB4', 'base64'),
};
// The PSS route of the same vectors (`send-pss-sent`).
const PSS =
  '/pss/send/7d37ee8427bc4ef7fa6c30bba155020c46b01043618747ed07cb611ab74a11ee/abcd' +
  '?recipient=023263e186e68d31581a2ac1bec6ca730ba9b9e6b4a194dd78798a36271d0a4a0b';

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
 * Reads one direction of an HTTP/1.1 connection as messages, as they cross
 * it: each one's first line and headers, its framing (`chunked`, `length`
 * or `none`), its body's bytes and SHA-256, and whether it came whole (a
 * chunked body's last chunk and trailer, a length's last byte), with the
 * event it started in (`opened`) and the one it ended in (`closed`).
 */
class MessageReader {
  constructor(onHead) {
    this.onHead = onHead;
    this.buf = Buffer.alloc(0);
    this.state = 'head';
    this.message = null;
    this.left = 0;
  }

  take(bytes) {
    this.message.bytes += bytes.length;
    this.message.hash.update(bytes);
  }

  finish(event) {
    const { message } = this;
    message.whole = true;
    message.closed = event;
    message.digest = message.hash.digest('hex');
    this.state = 'head';
  }

  push(data, event) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    for (;;) {
      if (this.state === 'head') {
        const end = this.buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [first, ...lines] = this.buf.subarray(0, end).toString('latin1').split('\r\n');
        this.buf = this.buf.subarray(end + 4);
        const headers = {};
        for (const line of lines) {
          const colon = line.indexOf(':');
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        const chunked = /chunked/i.test(headers['transfer-encoding'] ?? '');
        const length = headers['content-length'];
        this.message = {
          first,
          contentLength: length ?? null,
          framing: chunked ? 'chunked' : length !== undefined ? 'length' : 'none',
          bytes: 0,
          hash: crypto.createHash('sha256'),
          whole: false,
          opened: event,
          closed: null,
        };
        this.onHead(this.message);
        if (chunked) this.state = 'size';
        else if (length !== undefined && Number(length) > 0) {
          this.left = Number(length);
          this.state = 'fixed';
        } else this.finish(event);
      } else if (this.state === 'fixed' || this.state === 'data') {
        const k = Math.min(this.left, this.buf.length);
        this.take(this.buf.subarray(0, k));
        this.buf = this.buf.subarray(k);
        this.left -= k;
        if (this.left) return;
        if (this.state === 'fixed') this.finish(event);
        else this.state = 'crlf';
      } else if (this.state === 'crlf') {
        if (this.buf.length < 2) return;
        this.buf = this.buf.subarray(2);
        this.state = 'size';
      } else if (this.state === 'size' || this.state === 'trailer') {
        const end = this.buf.indexOf('\r\n');
        if (end < 0) return;
        const line = this.buf.subarray(0, end).toString('latin1');
        this.buf = this.buf.subarray(end + 2);
        if (this.state === 'trailer') {
          if (!line) this.finish(event);
          continue;
        }
        this.left = parseInt(line.split(';')[0], 16);
        this.state = this.left ? 'data' : 'trailer';
      }
    }
  }
}

/**
 * A loopback reverse proxy in front of the node: each connection's bytes
 * relayed untouched, both ways, and read as HTTP/1.1 (`MessageReader`).
 * `requests` holds every request in order, each with the node's answer to
 * it (`answer`: its status and the event it started in).
 */
function startTap(upstreamPort) {
  const requests = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    const unanswered = [];
    let events = 0;
    const asked = new MessageReader((message) => {
      const [method, target] = message.first.split(' ');
      Object.assign(message, { method, target, answer: null });
      requests.push(message);
      unanswered.push(message);
    });
    const answers = new MessageReader((message) => {
      const request = unanswered.shift();
      if (request) {
        request.answer = { status: Number(message.first.split(' ')[1]), opened: message.opened };
      }
    });
    client.on('data', (data) => {
      asked.push(data, ++events);
      upstream.write(data);
    });
    upstream.on('data', (data) => {
      answers.push(data, ++events);
      client.write(data);
    });
    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, server })
    );
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
  let tap;
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
    // Every call goes through the tap, on loopback as the node is.
    tap = await startTap(port);
    mockRegistry.url = tap.url;
  });

  afterAll(async () => {
    tap?.server.close();
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

  test('the switch is on, and the node is the bundled antd on loopback, behind the tap', () => {
    expect(swarmBackendKind()).toBe('core');
    expect(antBackend()).toMatchObject({ url: tap.url, ref: { ant: 'bundled', up: true } });
    expect(tap.url).not.toBe(origin);
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

  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

  /** What the tap saw of the last `method target`, and the node's answer to it. */
  function crossed(method, target) {
    const request = tap.requests.findLast((r) => r.method === method && r.target === target);
    if (!request) throw new Error(`the tap saw no ${method} ${target}`);
    return {
      framing: request.framing,
      contentLength: request.contentLength,
      bytes: request.bytes,
      digest: request.digest,
      whole: request.whole,
      // The node's answer started only once the request was over.
      answeredAfter: request.answer !== null && request.answer.opened > request.closed,
      status: request.answer?.status ?? null,
    };
  }

  /** What crossed the tap for a chunked body of `bytes`, answered `status`. */
  const chunkedWhole = (bytes, status) => ({
    framing: 'chunked',
    contentLength: null,
    bytes: bytes.length,
    digest: sha256(bytes),
    whole: true,
    answeredAfter: true,
    status,
  });

  const messageOf = (body) => (body.length ? JSON.parse(body).message : null);

  /** One POST on the Ant backend: `bytes` with a length (undici), a stream, or none. */
  async function post(pathAndQuery, headers, bytes, { stream = false } = {}) {
    const reply = await callAnt(antBackend(), {
      path: pathAndQuery,
      method: 'POST',
      headers: new Headers([...Object.entries(MAIN_HEADERS), ...headers]),
      body: stream ? streamOf(bytes) : bytes && new Uint8Array(bytes),
      signal: new AbortController().signal,
    });
    const body = Buffer.from(await new Response(reply.body).arrayBuffer());
    return { status: reply.status, message: messageOf(body) };
  }

  /**
   * `bytes` POSTed chunked through the tap, as the session's stack sends a
   * stream body: Node's own client, since undici sends an empty stream with
   * a length and fails a 401 to a streamed body.
   */
  function chunked(target, headers, bytes) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        `${tap.url}${target}`,
        {
          method: 'POST',
          headers: {
            ...MAIN_HEADERS,
            ...Object.fromEntries(headers),
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          const parts = [];
          response.on('data', (part) => parts.push(part));
          response.on('error', reject);
          response.on('end', () =>
            resolve({ status: response.statusCode, message: messageOf(Buffer.concat(parts)) })
          );
        }
      );
      request.on('error', reject);
      if (bytes.length) request.write(bytes);
      request.end();
    });
  }

  // An upload the node took and couldn't push, for want of postage: 503 or
  // 500 depending on its state, never a refusal of the request.
  const failedPastTheHandler = (status) => expect(status).toBeGreaterThanOrEqual(500);

  test('a bzz_file streamed through the executor: the node takes it chunked and whole, as it takes it with a length', async () => {
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
    expect(crossed('POST', '/bzz?name=notes.bin')).toEqual(chunkedWhole(bytes, reply.status));
    failedPastTheHandler(reply.status);
    expect(JSON.parse(reply.body).code).toBe(reply.status);
    const withLength = await post('/bzz?name=notes.bin', headers, bytes);
    expect(crossed('POST', '/bzz?name=notes.bin')).toMatchObject({
      framing: 'length',
      contentLength: String(bytes.length),
      bytes: bytes.length,
      whole: true,
    });
    failedPastTheHandler(withLength.status);
  });

  describe('a bzz_tar streamed through the executor', () => {
    const page = Buffer.from('<h1>Freedom</h1>');
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

    test('the node takes it chunked and whole, as it takes it with a length', async () => {
      const tar = tarOf([{ name: 'index.html', bytes: page }]);
      const whole = await upload(tar);
      expect(crossed('POST', '/bzz')).toEqual(chunkedWhole(tar, whole.status));
      failedPastTheHandler(whole.status);
      const withLength = await post('/bzz', headers, tar);
      expect(crossed('POST', '/bzz')).toMatchObject({ framing: 'length', bytes: tar.length });
      failedPastTheHandler(withLength.status);
    });

    test('the node parses the tar it takes chunked: a broken one of the same length is malformed', async () => {
      const noise = patterned(tarOf([{ name: 'index.html', bytes: page }]).length);
      const broken = await upload(noise);
      expect(crossed('POST', '/bzz')).toEqual(chunkedWhole(noise, 400));
      expect(JSON.parse(broken.body).message).toMatch(/^malformed tar entry/);
    });
  });

  test('a /bytes body streamed on the same transport: taken chunked and whole, as with a length', async () => {
    const bytes = patterned(300_000);
    const headers = [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
    ];
    const streamed = await post('/bytes', headers, bytes, { stream: true });
    expect(crossed('POST', '/bytes')).toEqual(chunkedWhole(bytes, streamed.status));
    failedPastTheHandler(streamed.status);
    const withLength = await post('/bytes', headers, bytes);
    expect(crossed('POST', '/bytes')).toMatchObject({ framing: 'length', bytes: bytes.length });
    failedPastTheHandler(withLength.status);
  });

  // The chunked form of the other writes main sends a node.

  test('chunk_up, chunked: the node measures the chunk it takes (4104 bytes pass its size check, 4105 do not), as with a length', async () => {
    const chunk = Buffer.from(
      Object.values(dwebVerify.swarm.chunks).find((c) => Buffer.from(c, 'base64').length === 4104),
      'base64'
    );
    const headers = [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'false'],
    ];
    const taken = await chunked('/chunks', headers, chunk);
    expect(crossed('POST', '/chunks')).toEqual(chunkedWhole(chunk, taken.status));
    failedPastTheHandler(taken.status);
    failedPastTheHandler((await post('/chunks', headers, chunk)).status);
    const over = Buffer.concat([chunk, Buffer.from([0])]);
    expect(await chunked('/chunks', headers, over)).toEqual({
      status: 400,
      message: 'chunk data exceeds required length',
    });
    expect(crossed('POST', '/chunks')).toEqual(chunkedWhole(over, 400));
  });

  test("soc_up, chunked: the node checks the SOC's signature over the whole body it takes (its last byte changed is an invalid chunk), as with a length", async () => {
    const headers = [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'false'],
    ];
    const target = `${SOC.path}?sig=${SOC.sig}`;
    const taken = await chunked(target, headers, SOC.body);
    expect(crossed('POST', target)).toEqual(chunkedWhole(SOC.body, taken.status));
    failedPastTheHandler(taken.status);
    failedPastTheHandler((await post(target, headers, SOC.body)).status);
    const changed = Buffer.from(SOC.body);
    changed[changed.length - 1] ^= 1;
    expect(await chunked(target, headers, changed)).toEqual({
      status: 401,
      message: 'invalid chunk',
    });
    expect(crossed('POST', target)).toEqual(chunkedWhole(changed, 401));
  });

  // The node refuses a batch it can't use before it sends a message, so a
  // message goes no further than that here: no gate has a usable batch.
  test('pss_send, chunked: the node measures the message it takes (4000 bytes pass its size check, 4001 do not), and an empty one goes chunked', async () => {
    const headers = [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
    ];
    const over = patterned(4001);
    expect(await chunked(PSS, headers, over)).toEqual({
      status: 400,
      message: 'pss message exceeds 4000 bytes',
    });
    expect(crossed('POST', PSS)).toEqual(chunkedWhole(over, 400));
    for (const message of [patterned(4000), Buffer.alloc(0)]) {
      const taken = await chunked(PSS, headers, message);
      expect(crossed('POST', PSS)).toEqual(chunkedWhole(message, taken.status));
      expect(taken.message).not.toMatch(/exceeds/);
      const withLength = await post(PSS, headers, message.length ? message : null);
      expect(withLength.message).not.toMatch(/exceeds/);
    }
  });

  test('feed_manifest, as an empty chunked body: the node reads its last chunk and answers as with no body', async () => {
    const target =
      '/feeds/6fac4d18c912343bf86fa7049364dd4e424ab9c0/' +
      'e006351ebb110409cdcc67a3e7aeb1f72819828835f48a240b0014b20c70e783';
    const headers = [['swarm-postage-batch-id', BATCH]];
    const taken = await chunked(target, headers, Buffer.alloc(0));
    expect(crossed('POST', target)).toEqual(chunkedWhole(Buffer.alloc(0), taken.status));
    failedPastTheHandler(taken.status);
    // As main sends it to the bundled node: undici's `content-length: 0`.
    const without = await post(target, headers, null);
    expect(crossed('POST', target)).toMatchObject({
      framing: 'length',
      contentLength: '0',
      bytes: 0,
      whole: true,
    });
    failedPastTheHandler(without.status);
  });
});
