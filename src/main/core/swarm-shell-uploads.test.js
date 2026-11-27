/**
 * Main's streamed Swarm uploads (core/swarm-shell.js; freedom-core design
 * 0015, Uploads, Streams, Main's Swarm I/O pool, D4 and D13, and SWM-5's
 * calls, points 3, 5, 12 and 13):
 * - **the part rules:** `shell.swarm_part` read strictly; another parent's
 *   part, or one the params don't have, `value`; one asked twice `count`;
 *   one with no streaming call open `order`; one after the parent ended
 *   `ended`; each refused before anything is read, and logged;
 * - **one `swarm.body` per streaming call,** for that call alone, with its
 *   idle watchdog, and none for any other call;
 * - **point 12:** a head of another length is a core fault, withdrawn and
 *   answered `{ failed: "error" }`, undialled; a node that answers early
 *   has the body withdrawn before main answers, so no credit follows;
 * - **point 13:** a picked file that changes size mid-read ends its part
 *   `body_stream_error` with no `error_code`; one that can't be read names
 *   its errno;
 * - **the pool and what main holds:** an upload's charges, released once
 *   its call and its parts are over, and no copy of a part or of the body;
 * - **through a real CoreClient** against a scripted core
 *   (test/helpers/fake-swarm-core.js) and over real loopback HTTP: uploads
 *   sent chunked as the node takes them, a node that stops reading holding
 *   one window in main, four uploads beside reads, the wire order point 12
 *   needs, and the watchdog on the client's clock: a silent core restarted
 *   at 75 s, the part's frames and credit moving it on, the body's terminal
 *   ending it. Each case ends with the pool back at 0.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'bundled' }),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => null }));
jest.mock('./dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('./naming', () => ({ namingDriver: () => null }));

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ShellError, StreamedReply } = require('./core-client');
const { CORE_UPLOAD_ABORT_CODES, KIND_ABORT, KIND_STREAM_CREDIT, WINDOW } = require('./frame');
const { SwarmShell, BODY_PROGRESS_MS, STREAM_CHARGE, wholeCharge } = require('./swarm-shell');
const { SwarmIoPool } = require('./swarm-io-pool');
const { SwarmData } = require('./swarm-typed');
const { antBackend } = require('../swarm/bzz-protocol');
const {
  abortBody,
  drain,
  fakeClock,
  parentOf,
  serveUpload,
  sleep,
  startSwarmCore,
  until,
} = require('../../../test/helpers/fake-swarm-core');
const { startFakeHttpNode, streamBody } = require('../../../test/helpers/fake-http-node');
const { bodyClient, drainBody, zeros } = require('../../../test/helpers/swarm-upload-fixtures');

const KIB = 1024;
const MIB = 1024 * KIB;
const LOOPBACK = 'http://127.0.0.1:1633';
const KEY = 'https://app.example';
const BATCH = 'c3'.repeat(32);
const OWNER = 'd4'.repeat(20);
const TOPIC = 'a1'.repeat(32);
const REFERENCE = 'ab'.repeat(32);
/** A whole upload call's reply room: its `max_bytes` of 64 KiB. */
const REPLY_ROOM = wholeCharge(64 * KIB);

function quietLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** Bytes a page sent where a method reads data, as a part: `{ bytes, part }` read back. */
const partData = (part, length) => new SwarmData('Uint8Array', length, null, part);

/** `n` bytes of a pattern, so a byte out of place shows. */
function patterned(n, seed = 0) {
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The core's `shell.swarm_api` calls an upload makes, main's own two
// headers left out.
const calls = {
  stamps: () => ({
    form: 'stamps',
    method: 'GET',
    path: '/stamps',
    query: [],
    headers: [],
    max_bytes: MIB,
    stream: false,
  }),
  tag: (uid) => ({
    form: 'tag',
    method: 'GET',
    path: `/tags/${uid}`,
    query: [],
    headers: [],
    max_bytes: 65536,
    stream: false,
  }),
  feedLatest: (max = 5 * MIB) => ({
    form: 'feed_latest',
    method: 'GET',
    path: `/feeds/${OWNER}/${TOPIC}`,
    query: [],
    headers: [],
    max_bytes: max,
    stream: true,
  }),
  bzzFile: ({
    name = 'data',
    contentType = 'application/octet-stream',
    deferred = 'false',
    body,
  } = {}) => ({
    form: 'bzz_file',
    method: 'POST',
    path: '/bzz',
    query: [['name', name]],
    headers: [
      ['content-type', contentType],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', deferred],
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
  bzzTar: (body) => ({
    form: 'bzz_tar',
    method: 'POST',
    path: '/bzz',
    query: [],
    headers: [
      ['content-type', 'application/x-tar'],
      ['swarm-collection', 'true'],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'true'],
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
};

/** A node behind a captured backend, its dials scripted by `answer(init)`; `GET /node` answers `{}`. */
function scriptedNode(answer = () => new Response('{"reference":"x"}', { status: 201 })) {
  const node = { dials: [] };
  node.backend = {
    ref: { ant: 'bundled', up: true },
    url: LOOPBACK,
    request: jest.fn(async (init) => {
      node.dials.push(init);
      if (init.path === '/node') return new Response('{}', { status: 200 });
      if (init.path === '/stamps') return new Response('{"stamps":[]}', { status: 200 });
      return answer(init, node.dials.length);
    }),
  };
  node.calls = () => node.dials.filter((init) => init.path !== '/node');
  node.posts = () => node.dials.filter((init) => init.method === 'POST');
  return node;
}

/** A node that takes each upload whole, then answers 201 with its reference. */
function takingNode() {
  const node = scriptedNode(async (init) => {
    const { body } = init;
    node.taken.push(typeof body?.getReader === 'function' ? await drainBody(body) : body.length);
    return new Response(JSON.stringify({ reference: REFERENCE }), { status: 201 });
  });
  node.taken = [];
  return node;
}

let nextAsk = 5000;

/** The context the client calls a handler with; `release()` lets go of its
 * lease as the client does once its reply is written or dropped. */
function context({ generation = 1, pool = null } = {}) {
  const controller = new AbortController();
  const released = [];
  const ctx = {
    id: nextAsk++,
    controller,
    signal: controller.signal,
    generation,
    streams: true,
    held: 0,
    charge: (bytes) => {
      if (pool && !pool.take(bytes)) return false;
      ctx.held += bytes;
      return true;
    },
    shrink: (bytes) => {
      if (bytes >= ctx.held) return;
      pool?.release(ctx.held - bytes);
      ctx.held = bytes;
    },
    onRelease: (fn) => released.push(fn),
    release: () => {
      ctx.shrink(0);
      for (const fn of released.splice(0)) fn();
    },
  };
  return ctx;
}

/** A handler's outcome: `{ rule }` for a refusal, else `{ result }`. */
async function outcome(pending) {
  try {
    return { result: await pending };
  } catch (err) {
    if (err instanceof ShellError && err.code === 'invalid_argument') {
      return { rule: err.data.rule };
    }
    throw err;
  }
}

/** A whole reply's result, parsed from the JsonText the handler gives. */
function parsed(result) {
  if (!result?.parts) return result;
  return JSON.parse(
    result.parts.map((part) => (typeof part === 'string' ? part : part.toString('utf8'))).join('')
  );
}

function makeShell(deps = {}) {
  return new SwarmShell({
    log: quietLog(),
    backendKind: () => 'core',
    nodeUrl: () => LOOPBACK,
    publishReadiness: async () => ({ ok: true }),
    client: bodyClient(),
    ...deps,
  });
}

let nextParent = 1;

/** A parent of `row`, open in `shell`, with its asks: `part(k)` is a `shell.swarm_part`. */
function parent(shell, row, params, { node = takingNode(), generation = 1, ...capture } = {}) {
  const id = nextParent++;
  const handle = shell.open(
    { generation, id },
    { row, params, key: KEY, backend: node.backend, ...capture }
  );
  return {
    id,
    node,
    handle,
    ready: (check) => outcome(shell.ready({ for: id, check }, context({ generation }))),
    api: (call, ctx = context({ generation })) => outcome(shell.api({ for: id, ...call }, ctx)),
    part: (part, ctx = context({ generation })) =>
      outcome(Promise.resolve().then(() => shell.part({ for: id, part }, ctx))),
    ask: (params, ctx = context({ generation })) =>
      outcome(Promise.resolve().then(() => shell.part(params, ctx))),
  };
}

/** A publishData parent of one `size`-byte part, past its ready check and `/stamps`. */
async function publishing(shell, { size = 300 * KIB, source = patterned(size), ...capture } = {}) {
  const params = { data: partData(0, size), contentType: 'application/octet-stream' };
  const p = parent(shell, 'publishData', params, { parts: new Map([[0, source]]), ...capture });
  expect((await p.ready('publish')).result).toEqual({ ok: true });
  expect((await p.api(calls.stamps())).rule).toBeUndefined();
  return p;
}

/** Waits until `predicate()` holds, in real turns. */
const waitFor = (predicate, what) => until(predicate, what);

/** Reads a stream to its end through a BYOB reader of 64 KiB views, as the
 * service client reads a byte stream: `{ bytes, error }`. */
async function readByob(body, { onRead = () => {} } = {}) {
  const reader = body.getReader({ mode: 'byob' });
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(new Uint8Array(64 * KIB));
      if (done) return { bytes: Buffer.concat(parts), error: null };
      parts.push(Buffer.from(value));
      await onRead(parts.reduce((n, p) => n + p.length, 0));
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error };
  }
}

/** A part's body read as the service client reads it: a byte stream
 * through a BYOB reader of 64 KiB views, any other a chunk at a time. */
function partReader(body) {
  try {
    const reader = body.getReader({ mode: 'byob' });
    return () => reader.read(new Uint8Array(64 * KIB));
  } catch {
    const reader = body.getReader();
    return () => reader.read();
  }
}

/** Reads a default stream's chunks to its end. */
async function readChunks(body) {
  const reader = body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

/**
 * Records the Buffers made of at least `min` bytes, by the Buffer function
 * that made them (the outermost call), until `restore()`; a `from` over an
 * ArrayBuffer is a view, and isn't one. (swarm-shell.test.js's.)
 */
function trackAllocations(min) {
  const seen = [];
  const originals = {};
  let depth = 0;
  for (const name of ['alloc', 'allocUnsafe', 'allocUnsafeSlow', 'concat', 'from']) {
    const original = Buffer[name];
    originals[name] = original;
    Buffer[name] = function tracked(...args) {
      depth += 1;
      try {
        const out = original.apply(this, args);
        const view =
          name === 'from' &&
          (args[0] instanceof ArrayBuffer || args[0] instanceof SharedArrayBuffer);
        if (depth === 1 && !view && out.length >= min) seen.push([name, out.length]);
        return out;
      } finally {
        depth -= 1;
      }
    };
  }
  return { seen, restore: () => Object.assign(Buffer, originals) };
}

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-uploads-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A picked file of `bytes`, and its source. */
function pickedFile(name, bytes) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return { file, source: { path: file, bytes: bytes.length } };
}

describe('shell.swarm_part: the part rules (point 5), each refused before anything is read', () => {
  test('read strictly: exactly { for, part }, a part a u32; anything else is form', async () => {
    const bad = (id) => [
      { for: id },
      { part: 0 },
      { for: id, part: -1 },
      { for: id, part: 1.5 },
      { for: id, part: '0' },
      { for: id, part: 2 ** 32 },
      { for: id, part: 0, extra: true },
      { for: 0, part: 0 },
      { for: String(id), part: 0 },
    ];
    for (let i = 0; i < bad(0).length; i++) {
      const shell = makeShell();
      const p = await publishing(shell);
      expect(await p.ask(bad(p.id)[i])).toEqual({ rule: 'form' });
    }
  });

  test('one asked with no streaming call open is order: before its upload, and once it is over', async () => {
    const shell = makeShell();
    const early = await publishing(shell);
    expect(await early.part(0)).toEqual({ rule: 'order' });
    // The parent refuses every later call: its upload is ended, never sent.
    expect(await early.api(calls.bzzFile({ body: { stream: 300 * KIB } }))).toEqual({
      rule: 'ended',
    });
    expect(shell.client.bodies).toHaveLength(0);

    const late = await publishing(shell);
    const upload = late.api(calls.bzzFile({ body: { stream: 300 * KIB } }));
    await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
    shell.client.bodies[0].respond({ bytes: 300 * KIB }, zeros(300 * KIB));
    expect(parsed((await upload).result).status).toBe(201);
    expect(await late.part(0)).toEqual({ rule: 'order' });
  });

  test("another parent's part, or one the params don't have, is value", async () => {
    const shell = makeShell();
    // Another parent holds part 3.
    const other = parent(
      shell,
      'publishData',
      { data: partData(3, 10), contentType: 'application/octet-stream' },
      { parts: new Map([[3, patterned(10)]]) }
    );
    expect(other.handle).toBeDefined();
    for (const number of [3, 7]) {
      const p = await publishing(shell);
      p.api(calls.bzzFile({ body: { stream: 300 * KIB } }));
      await waitFor(() => shell.stats().uploads === 1, 'the upload open');
      expect(await p.part(number)).toEqual({ rule: 'value' });
      p.handle.close();
      await waitFor(() => shell.stats().uploads === 0, 'the upload over');
    }
  });

  test('a part asked a second time is count', async () => {
    const shell = makeShell();
    const p = await publishing(shell);
    p.api(calls.bzzFile({ body: { stream: 300 * KIB } }));
    await waitFor(() => shell.stats().uploads === 1, 'the upload open');
    const first = await p.part(0);
    expect(first.result).toBeInstanceOf(StreamedReply);
    expect(await p.part(0)).toEqual({ rule: 'count' });
    p.handle.close();
  });

  test('after the parent ended: ended, a race logged at debug; a for never sent is ended, logged as a fault', async () => {
    const shell = makeShell();
    const p = await publishing(shell);
    p.handle.close();
    expect(await p.part(0)).toEqual({ rule: 'ended' });
    expect(shell.log.debug).toHaveBeenCalledWith(
      '[Core] shell.swarm_part for a parent that has ended'
    );
    expect(shell.log.warn).not.toHaveBeenCalled();
    expect(await p.ask({ for: p.id + 1000, part: 0 })).toEqual({ rule: 'ended' });
    expect(shell.log.warn).toHaveBeenCalledWith('[Core] shell.swarm_part refused', {
      rule: 'ended',
    });
  });

  test('a refusal is logged at warn with the parent, its step and the rule; the parent refuses every later call, and nothing is read', async () => {
    const openFile = jest.fn((file) => fs.promises.open(file, 'r'));
    const { source } = pickedFile('refused.bin', patterned(300 * KIB));
    const shell = makeShell({ openFile });
    const p = await publishing(shell, { source });
    const upload = p.api(calls.bzzFile({ body: { stream: 300 * KIB } }));
    await waitFor(() => shell.stats().uploads === 1, 'the upload open');
    expect(await p.part(9)).toEqual({ rule: 'value' });
    expect(shell.log.warn).toHaveBeenCalledWith('[Core] shell.swarm_part refused', {
      parent: 'publishData',
      step: 1,
      rule: 'value',
    });
    // Every later ask of the parent: ended, at debug.
    expect(await p.part(0)).toEqual({ rule: 'ended' });
    expect(openFile).not.toHaveBeenCalled();
    shell.client.bodies[0].respond({ bytes: 300 * KIB }, zeros(300 * KIB));
    expect(parsed((await upload).result).status).toBe(201);
  });
});

describe('a streamed upload: one swarm.body for its call alone, piped as the node takes it', () => {
  test("one swarm.body, for the call's ID, with its idle watchdog and an upload's codes; none for any other call", async () => {
    const shell = makeShell();
    const p = await publishing(shell);
    // The ready check and /stamps sent none.
    expect(shell.client.bodies).toHaveLength(0);
    const ctx = context();
    const upload = p.api(calls.bzzFile({ body: { stream: 300 * KIB } }), ctx);
    await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
    const [body] = shell.client.bodies;
    expect(body.method).toBe('swarm.body');
    expect(body.params).toEqual({ for: ctx.id });
    expect(body.context).toEqual({ caller: 'shell' });
    expect(body.options.idleWatchdogMs).toBe(BODY_PROGRESS_MS);
    expect(BODY_PROGRESS_MS).toBe(75_000);
    expect(body.options.takes).toBe(CORE_UPLOAD_ABORT_CODES);
    // Nothing dialled before the core's head.
    expect(p.node.posts()).toHaveLength(0);
    body.respond({ bytes: 300 * KIB }, zeros(300 * KIB));
    const out = parsed((await upload).result);
    expect(out.status).toBe(201);
    expect(JSON.parse(Buffer.from(out.body_base64, 'base64'))).toEqual({ reference: REFERENCE });
    expect(p.node.taken).toEqual([300 * KIB]);
    // A whole upload of one part sends one, and only it.
    expect(shell.client.bodies).toHaveLength(1);
    // A base64 upload sends none.
    const inline = parent(shell, 'publishData', {
      data: new SwarmData('Uint8Array', 5, Buffer.from('hello'), null),
      contentType: 'text/plain',
    });
    await inline.ready('publish');
    await inline.api(calls.stamps());
    const sent = await inline.api(
      calls.bzzFile({ contentType: 'text/plain', body: { base64: 'aGVsbG8=' } })
    );
    expect(parsed(sent.result).status).toBe(201);
    expect(shell.client.bodies).toHaveLength(1);
  });

  test("the charges: the reply's room and the body's 256 KiB to the node's answer, a part's 256 KiB until the call and its parts are over; busy before any swarm.body without room", async () => {
    const pool = new SwarmIoPool();
    const shell = makeShell({ pool });
    let atDial = null;
    const node = scriptedNode(async (init) => {
      atDial = pool.held;
      await drainBody(init.body);
      return new Response('{"reference":"x"}', { status: 201 });
    });
    const p = await publishing(shell, { node, size: 128 * KIB });
    const ctx = context({ pool });
    const upload = p.api(calls.bzzFile({ body: { stream: 128 * KIB } }), ctx);
    await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
    // Charged before the swarm.body went.
    expect(pool.held).toBe(REPLY_ROOM + 2 * STREAM_CHARGE);
    // The core pulls the part: it takes the upload's part room, no more.
    const partCtx = context({ pool });
    const part = await p.part(0, partCtx);
    expect(pool.held).toBe(REPLY_ROOM + 2 * STREAM_CHARGE);
    shell.client.bodies[0].respond({ bytes: 128 * KIB }, part.result.body);
    expect(parsed((await upload).result).status).toBe(201);
    expect(atDial).toBe(REPLY_ROOM + 2 * STREAM_CHARGE);
    // After the node's answer: the reply's own sum (its body in one 4 KiB
    // block, with no declared length), and the part room.
    const reply = '{"reference":"x"}'.length;
    expect(pool.held).toBe(wholeCharge(reply) - reply + 4 * KIB + STREAM_CHARGE);
    // The call's reply written: the part's stream still holds its room.
    ctx.release();
    expect(pool.held).toBe(STREAM_CHARGE);
    partCtx.release();
    expect(pool.held).toBe(0);

    // No room for the part room: busy, before any swarm.body, undialled.
    const tight = new SwarmIoPool(REPLY_ROOM + 2 * STREAM_CHARGE - 1);
    const shellQ = makeShell({ pool: tight });
    const q = await publishing(shellQ, { size: 128 * KIB });
    const call = calls.bzzFile({ body: { stream: 128 * KIB } });
    expect(await q.api(call, context({ pool: tight }))).toEqual({ result: { failed: 'busy' } });
    expect(tight.held).toBe(0);
    expect(shellQ.client.bodies).toHaveLength(0);
    expect(q.node.posts()).toHaveLength(0);
  });

  test.each([
    ['a length other than the call’s', (n) => ({ bytes: n + 1 })],
    ['a shorter one', (n) => ({ bytes: n - 1 })],
    ['a member more', (n) => ({ bytes: n, body: true })],
    ['its length as text', (n) => ({ bytes: String(n) })],
    ['no length', () => ({})],
  ])(
    'point 12: a head with %s is a core fault: the body withdrawn, error, undialled, logged',
    async (_label, head) => {
      const shell = makeShell();
      const p = await publishing(shell);
      const upload = p.api(calls.bzzFile({ body: { stream: 300 * KIB } }));
      await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
      const [body] = shell.client.bodies;
      body.respond(head(300 * KIB), zeros(300 * KIB));
      expect(await upload).toEqual({ result: { failed: 'error' } });
      expect(body.withdrawn).toBe(true);
      expect(p.node.posts()).toHaveLength(0);
      expect(shell.log.warn).toHaveBeenCalledWith('[Core] swarm.body: the core broke its upload', {
        parent: 'publishData',
        step: 1,
        fault: 'head',
      });
      // The call is over, and settled: the parent takes no other upload.
      expect(shell.stats()).toMatchObject({ calls: 0, uploads: 0 });
    }
  );

  test.each([
    ['runs past', 300 * KIB + 1, 'long'],
    ['ends short of', 300 * KIB - 1, 'short'],
  ])(
    "a body that %s its head's length fails the node's request before it takes it: withdrawn, error, logged",
    async (_label, sent, fault) => {
      const shell = makeShell();
      let took = null;
      const node = scriptedNode(async (init) => {
        // The request fails as its body does.
        took = await drainBody(init.body).catch((err) => err);
        throw took;
      });
      const p = await publishing(shell, { node });
      const upload = p.api(calls.bzzFile({ body: { stream: 300 * KIB } }));
      await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
      shell.client.bodies[0].respond({ bytes: 300 * KIB }, zeros(sent));
      expect(await upload).toEqual({ result: { failed: 'error' } });
      expect(took).toBeInstanceOf(Error);
      expect(shell.client.bodies[0].withdrawn).toBe(true);
      expect(shell.log.warn).toHaveBeenCalledWith('[Core] swarm.body: the core broke its upload', {
        parent: 'publishData',
        step: 1,
        fault,
      });
    }
  );

  test("point 12: a node that answers before it has taken the body: the body is withdrawn before main's answer, which is the node's, and nothing more of it is read", async () => {
    const shell = makeShell();
    let transport = null;
    let pulls = 0;
    let duringAnswer = null;
    const node = scriptedNode(async (init) => {
      // The node takes two chunks, then answers: the transport still holds
      // the body, and reads on while main reads the answer.
      transport = init.body.getReader();
      await transport.read();
      await transport.read();
      const answer = new ReadableStream({
        async pull(controller) {
          // Main has the node's head by now.
          await sleep(10);
          const read = await Promise.race([
            transport.read().then(() => 'read'),
            sleep(30).then(() => 'waiting'),
          ]);
          duringAnswer = { read, pulls };
          controller.enqueue(Buffer.from('{"code":413,"message":"too large"}'));
          controller.close();
        },
      });
      return new Response(answer, {
        status: 413,
        statusText: 'Payload Too Large',
        headers: { 'content-type': 'application/json' },
      });
    });
    const p = await publishing(shell, { node, size: 4 * MIB });
    const upload = p.api(calls.bzzFile({ body: { stream: 4 * MIB } }));
    await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
    const body = new ReadableStream(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64 * KIB));
        },
      },
      { highWaterMark: 0 }
    );
    shell.client.bodies[0].respond({ bytes: 4 * MIB }, body);
    let withdrawnAtAnswer = null;
    const answer = upload.then((out) => {
      withdrawnAtAnswer = shell.client.bodies[0].withdrawn;
      return out;
    });
    const out = parsed((await answer).result);
    expect(withdrawnAtAnswer).toBe(true);
    expect({ status: out.status, text: out.status_text }).toEqual({
      status: 413,
      text: 'Payload Too Large',
    });
    expect(Buffer.from(out.body_base64, 'base64').toString()).toBe(
      '{"code":413,"message":"too large"}'
    );
    // From the node's head on, the transport's read waits for good, and
    // nothing more of the core's body is pulled for it: while main reads
    // the answer, and after.
    expect(duringAnswer).toEqual({ read: 'waiting', pulls: 2 });
    const at = pulls;
    expect(at).toBe(2);
    const more = transport.read();
    const result = await Promise.race([more.then(() => 'read'), sleep(30).then(() => 'waiting')]);
    expect(result).toBe('waiting');
    expect(pulls).toBe(at);
    // Its cancel, once the reply is over, lets go of it.
    transport.cancel();
  });

  test("the core's cancel of the call, or the parent's end, withdraws the body in the same turn", async () => {
    const shell = makeShell();
    const p = await publishing(shell);
    const ctx = context();
    const upload = p.api(calls.bzzFile({ body: { stream: 300 * KIB } }), ctx);
    await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
    ctx.controller.abort();
    expect(shell.client.bodies[0].withdrawn).toBe(true);
    expect(await upload).toEqual({ result: { failed: 'aborted' } });

    // A dial the parent's end aborts, as both transports do.
    const node = scriptedNode(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        })
    );
    const q = await publishing(shell, { node });
    const later = q.api(calls.bzzFile({ body: { stream: 300 * KIB } }));
    await waitFor(() => shell.client.bodies.length === 2, 'the second swarm.body');
    shell.client.bodies[1].respond({ bytes: 300 * KIB }, new ReadableStream());
    await waitFor(() => q.node.posts().length === 1, 'the dial');
    q.handle.close();
    expect(shell.client.bodies[1].withdrawn).toBe(true);
    expect(await later).toEqual({ result: { failed: 'aborted' } });
    expect(shell.stats()).toMatchObject({ calls: 0, uploads: 0 });
  });
});

describe('shell.swarm_part: a part as its stream', () => {
  /** A publishFiles parent's open upload, parts 0 and 1 from `sources`. */
  async function collection(shell, sources, sizes) {
    const params = {
      files: sizes.map((size, i) => ({ path: `f${i}.bin`, bytes: partData(i, size) })),
    };
    const p = parent(shell, 'publishFiles', params, {
      parts: new Map(sources.map((s, i) => [i, s])),
    });
    await p.ready('publish');
    await p.api(calls.stamps());
    const ctx = context();
    const upload = p.api(calls.bzzTar({ stream: 4096 }), ctx);
    await waitFor(() => shell.stats().uploads === 1, 'the upload open');
    return { p, upload, ctx };
  }

  test("a held part: its head is { bytes }, its body the buffer's own bytes in views of at most 64 KiB, never copied; its frames are its upload's progress", async () => {
    const shell = makeShell();
    const held = patterned(200 * KIB);
    const { p } = await collection(shell, [held, patterned(10)], [held.length, 10]);
    const { result } = await p.part(0);
    expect(result).toBeInstanceOf(StreamedReply);
    expect(result.result).toEqual({ bytes: held.length });
    expect(result.bodyFlag).toBe(false);
    const chunks = await readChunks(result.body);
    expect(chunks.every((c) => c.buffer === held.buffer && c.byteLength <= 64 * KIB)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(held);
    // The service client reports each frame and credit; the shell moves
    // the upload's swarm.body watchdog on by 75 s.
    result.onProgress();
    const [body] = shell.client.bodies;
    expect(shell.client.progress).toEqual([[1, body.id, 75_000]]);
    p.handle.close();
  });

  test('a picked part: read into the views it is asked with, at its offsets; the file opened once, closed at its end', async () => {
    const bytes = patterned(300 * KIB, 7);
    const { source } = pickedFile('picked.bin', bytes);
    const handles = [];
    const openFile = jest.fn(async (file) => {
      const handle = await fs.promises.open(file, 'r');
      handles.push(handle);
      const close = handle.close.bind(handle);
      handle.closed = false;
      handle.close = async () => {
        handle.closed = true;
        return close();
      };
      return handle;
    });
    const shell = makeShell({ openFile });
    const { p } = await collection(shell, [source, patterned(10)], [bytes.length, 10]);
    const { result } = await p.part(0);
    expect(result.result).toEqual({ bytes: bytes.length });
    const read = await readByob(result.body);
    expect(read.error).toBeNull();
    expect(read.bytes).toEqual(bytes);
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(handles[0].closed).toBe(true);
    p.handle.close();
  });

  test.each([
    ['grows', (file) => fs.appendFileSync(file, Buffer.from('x'))],
    ['shrinks', (file) => fs.truncateSync(file, 100 * KIB)],
  ])(
    'point 13: a picked file that %s while it is read ends body_stream_error naming no code',
    async (label, change) => {
      const bytes = patterned(256 * KIB);
      const { file, source } = pickedFile(`changing-${label}.bin`, bytes);
      const shell = makeShell();
      const { p } = await collection(shell, [source, patterned(10)], [bytes.length, 10]);
      const { result } = await p.part(0);
      // Its head is the length its params gave: never another.
      expect(result.result).toEqual({ bytes: bytes.length });
      let changed = false;
      const read = await readByob(result.body, {
        onRead: (n) => {
          if (!changed && n >= 64 * KIB) {
            changed = true;
            change(file);
          }
        },
      });
      expect(read.error).toMatchObject({ name: 'PartError' });
      expect(read.error.errorCode).toBeUndefined();
      expect(read.bytes.length).toBeLessThanOrEqual(bytes.length);
      p.handle.close();
    }
  );

  test.each([
    ['ENOENT', () => ({ path: path.join(tmp, 'gone.bin'), bytes: 10 })],
    ['EISDIR', () => ({ path: tmp, bytes: 10 })],
  ])('a picked file that cannot be read names its errno: %s', async (code, source) => {
    const shell = makeShell();
    const { p } = await collection(shell, [source(), patterned(10)], [10, 10]);
    const { result } = await p.part(0);
    expect(result.result).toEqual({ bytes: 10 });
    const read = await readByob(result.body);
    expect(read.error.errorCode).toBe(code);
    p.handle.close();
  });

  test("a picked file under swarm.publish (freedom://publish): its part from main's own params, read whole into the node's request", async () => {
    const bytes = patterned(200 * KIB, 13);
    const { source } = pickedFile('publish.bin', bytes);
    const shell = makeShell();
    let took = null;
    const node = scriptedNode(async (init) => {
      const reader = init.body.getReader();
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(Buffer.from(value));
      }
      took = Buffer.concat(parts);
      return new Response('{"reference":"x"}', { status: 201 });
    });
    const params = {
      kind: 'file',
      parts: [{ bytes: bytes.length, part: 4 }],
      name: 'publish.bin',
      pin: true,
      deferred: true,
    };
    const p = parent(shell, 'swarm.publish:data,file', params, {
      node,
      key: null,
      parts: new Map([[4, source]]),
    });
    expect((await p.api(calls.stamps())).rule).toBeUndefined();
    const call = calls.bzzFile({
      name: 'publish.bin',
      deferred: 'true',
      body: { stream: bytes.length },
    });
    const upload = p.api(call);
    await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
    // The params' own part number streams.
    const { result } = await p.part(4);
    shell.client.bodies[0].respond({ bytes: bytes.length }, result.body);
    expect(parsed((await upload).result).status).toBe(201);
    expect(took).toEqual(bytes);
  });

  test("the parent's end fails an open part body_stream_error, naming no code", async () => {
    const shell = makeShell();
    const { p } = await collection(shell, [patterned(300 * KIB), patterned(10)], [300 * KIB, 10]);
    const { result } = await p.part(0);
    const reader = result.body.getReader();
    await reader.read();
    p.handle.close();
    await expect(reader.read()).rejects.toMatchObject({ name: 'PartError' });
  });
});

describe("what main holds of an upload: the pool's charges, and no copy of a part or of the body", () => {
  test('a held part and a picked part of 1 MiB each through one upload: no Buffer of more than 64 KiB is made, and the pool holds the reservations alone', async () => {
    const pool = new SwarmIoPool();
    const shell = makeShell({ pool });
    const held = patterned(MIB, 1);
    const { source } = pickedFile('held-and-picked.bin', patterned(MIB, 2));
    let took = null;
    const node = scriptedNode(async (init) => {
      took = await drainBody(init.body).then((n) => n);
      return new Response('{"reference":"x"}', { status: 201 });
    });
    const params = {
      files: [
        { path: 'a.bin', bytes: partData(0, MIB) },
        { path: 'b.bin', bytes: partData(1, MIB) },
      ],
    };
    const p = parent(shell, 'publishFiles', params, {
      node,
      parts: new Map([
        [0, held],
        [1, source],
      ]),
    });
    await p.ready('publish');
    await p.api(calls.stamps());
    // The core's body: its own bytes around each part, the parts read as
    // the service client reads them, each in turn.
    const header = Buffer.alloc(512, 0x20);
    const end = Buffer.alloc(1024);
    const total = 2 * (512 + MIB) + 1024;
    const allocations = trackAllocations(64 * KIB + 1);
    let out;
    try {
      const ctx = context({ pool });
      const upload = p.api(calls.bzzTar({ stream: total }), ctx);
      await waitFor(() => shell.client.bodies.length === 1, 'the swarm.body');
      const pieces = [header, 0, header, 1, end];
      let read = null;
      const partCtxs = [];
      const body = new ReadableStream(
        {
          async pull(controller) {
            for (;;) {
              if (read) {
                const { done, value } = await read();
                if (!done) {
                  controller.enqueue(value);
                  return;
                }
                read = null;
              }
              const piece = pieces.shift();
              if (piece === undefined) {
                controller.close();
                return;
              }
              if (Buffer.isBuffer(piece)) {
                controller.enqueue(piece);
                return;
              }
              const partCtx = context({ pool });
              partCtxs.push(partCtx);
              const { result } = await p.part(piece, partCtx);
              read = partReader(result.body);
            }
          },
        },
        { highWaterMark: 0 }
      );
      shell.client.bodies[0].respond({ bytes: total }, body);
      out = await upload;
      ctx.release();
      for (const partCtx of partCtxs) partCtx.release();
    } finally {
      allocations.restore();
    }
    expect(parsed(out.result).status).toBe(201);
    expect(took).toBe(total);
    expect(allocations.seen).toEqual([]);
    expect(pool.highWater).toBe(REPLY_ROOM + 2 * STREAM_CHARGE);
    expect(pool.held).toBe(0);
  });
});

describe('through the core client, over loopback HTTP: streamed uploads', () => {
  let harness = null;
  let pool = null;
  let clock = null;
  let log = null;
  const nodes = [];

  async function start(deps = {}, { withClock = false } = {}) {
    pool = deps.pool ?? new SwarmIoPool();
    clock = withClock ? fakeClock() : null;
    log = quietLog();
    harness = await startSwarmCore({
      log,
      clock,
      deps: {
        backendKind: () => 'core',
        nodeUrl: () => mockRegistry.url,
        publishReadiness: async () => ({ ok: true }),
        ...deps,
        pool,
      },
    });
    return harness;
  }

  /**
   * A node that answers `/node` and `/stamps`, takes each upload as it
   * comes (unless `pause`), keeping its method, URL, headers, length and
   * digest, and answers 201 with a reference and a tag.
   */
  async function uploadNode({ pause = false, answer = null } = {}) {
    const uploads = [];
    const node = await startFakeHttpNode({
      handler: (req, res, entry) => {
        if (req.url === '/node') {
          res.end('{}');
          return;
        }
        if (req.url === '/stamps') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"stamps":[]}');
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          streamBody(entry, { total: 300 * KIB });
          return;
        }
        if (answer) {
          answer(req, res);
          return;
        }
        const seen = { method: req.method, url: req.url, headers: req.headers, req, bytes: 0 };
        const hash = crypto.createHash('sha256');
        uploads.push(seen);
        if (pause) req.pause();
        req.on('data', (chunk) => {
          seen.bytes += chunk.length;
          hash.update(chunk);
        });
        req.on('end', () => {
          seen.digest = hash.digest('hex');
          res.writeHead(201, { 'Content-Type': 'application/json', 'Swarm-Tag': '42' });
          res.end(JSON.stringify({ reference: REFERENCE }));
        });
      },
    });
    nodes.push(node);
    node.uploads = uploads;
    mockRegistry.url = node.origin;
    return node;
  }

  /** Main's publishData parent of one part from `source`, past its ready check and `/stamps`. */
  async function publishing(source, size) {
    const params = { data: partData(0, size), contentType: 'application/octet-stream' };
    const p = parentOf(harness.client, harness.shell, {
      row: 'publishData',
      params,
      key: KEY,
      backend: antBackend(),
      parts: new Map([[0, source]]),
    });
    await until(() => p.id !== null, 'the parent sent');
    expect(p.error).toBeNull();
    const core = harness.core();
    const ready = core.ready(p.id, 'publish');
    await until(() => core.reply(ready), 'the ready answer');
    expect(core.reply(ready).result).toEqual({ ok: true });
    const stamps = core.api(p.id, calls.stamps());
    await until(() => core.reply(stamps), 'the stamps answer');
    return p;
  }

  /** The core's upload call for `p`, and main's swarm.body for it. */
  async function uploadCall(p, call) {
    const core = harness.core();
    const id = core.api(p.id, call);
    await until(() => core.bodyFor(id), 'the swarm.body');
    return { id, body: core.bodyFor(id) };
  }

  async function answered(id) {
    await until(() => harness.core().reply(id), `the answer to ${id}`, 10_000);
    return harness.core().reply(id);
  }

  /** The pool back at 0, nothing dialling, uploading or streaming a part. */
  async function settledAtZero() {
    await until(() => {
      const stats = harness.shell.stats();
      return pool.held === 0 && stats.calls === 0 && stats.uploads === 0 && stats.parts === 0;
    }, 'the pool at 0');
  }

  /** Where in main's writes a message (`match`) or stream frame came. */
  const indexOf = (match) => harness.core().wire.findIndex(match);

  afterEach(async () => {
    harness?.core().release();
    if (harness) await harness.client.stop();
    harness = null;
    for (const node of nodes.splice(0)) await node.close();
    mockRegistry.url = null;
  });

  test("one swarm.body per streaming call, for that call alone: a file from a held part and a collection of the core's bytes, a held part and a picked one, each sent chunked as the node takes it", async () => {
    const node = await uploadNode();
    await start();
    const core = () => harness.core();
    // A file of 300 KiB, held.
    const file = patterned(300 * KIB, 3);
    const p = await publishing(file, file.length);
    const { id, body } = await uploadCall(p, calls.bzzFile({ body: { stream: file.length } }));
    expect(body.params).toEqual({ for: id });
    expect(body.context).toEqual({ caller: 'shell' });
    await serveUpload(core(), body.id, { parent: p.id, pieces: [{ part: 0, bytes: file.length }] });
    const reply = await answered(id);
    expect(reply.result.status).toBe(201);
    expect(reply.result.headers).toContainEqual(['swarm-tag', '42']);
    expect(JSON.parse(Buffer.from(reply.result.body_base64, 'base64'))).toEqual({
      reference: REFERENCE,
    });
    expect(node.uploads[0].headers['transfer-encoding']).toBe('chunked');
    expect(node.uploads[0].headers['content-length']).toBeUndefined();
    expect(node.uploads[0].digest).toBe(sha(file));

    // A collection: the core's own bytes around a held part and a picked one.
    const held = patterned(200 * KIB, 4);
    const pickedBytes = patterned(150 * KIB, 5);
    const { source } = pickedFile('wire-picked.bin', pickedBytes);
    const params = {
      files: [
        { path: 'a.bin', bytes: partData(0, held.length) },
        { path: 'b.bin', bytes: partData(1, pickedBytes.length) },
      ],
    };
    const q = parentOf(harness.client, harness.shell, {
      row: 'publishFiles',
      params,
      key: KEY,
      backend: antBackend(),
      parts: new Map([
        [0, held],
        [1, source],
      ]),
    });
    await until(() => q.id !== null, 'the collection sent');
    const ready = core().ready(q.id, 'publish');
    await until(() => core().reply(ready), 'its ready answer');
    const stamps = core().api(q.id, calls.stamps());
    await until(() => core().reply(stamps), 'its stamps');
    const header = Buffer.alloc(512, 0x41);
    const end = Buffer.alloc(1024);
    const total = 512 + held.length + 512 + pickedBytes.length + end.length;
    const tar = await uploadCall(q, calls.bzzTar({ stream: total }));
    const served = await serveUpload(core(), tar.body.id, {
      parent: q.id,
      pieces: [
        { own: header },
        { part: 0, bytes: held.length },
        { own: header },
        { part: 1, bytes: pickedBytes.length },
        { own: end },
      ],
    });
    expect(served.parts).toHaveLength(2);
    expect((await answered(tar.id)).result.status).toBe(201);
    expect(node.uploads[1].bytes).toBe(total);
    expect(node.uploads[1].digest).toBe(
      sha(Buffer.concat([header, held, header, pickedBytes, end]))
    );
    // Each part's head is its length, and it ended.
    for (const [ask, length] of served.parts.map((ask, i) => [
      ask,
      [held, pickedBytes][i].length,
    ])) {
      expect(core().reply(ask).result).toEqual({ bytes: length });
      expect(core().terminal(ask)).toEqual({ end: true });
    }
    // Two streaming calls, two swarm.body, one each; the reads sent none.
    expect(
      core()
        .requests('swarm.body')
        .map((m) => m.params)
    ).toEqual([{ for: id }, { for: tar.id }]);
    await settledAtZero();
  });

  test('a node that stops reading holds one window in main: no credit for the body, none for the part, and the pool at its reservations', async () => {
    const node = await uploadNode({ pause: true });
    await start();
    const core = () => harness.core();
    const size = 32 * MIB;
    const bytes = patterned(size, 9);
    const p = await publishing(bytes, size);
    const { id, body } = await uploadCall(p, calls.bzzFile({ body: { stream: size } }));
    let ask = null;
    const serving = serveUpload(core(), body.id, {
      parent: p.id,
      pieces: [{ part: 0, bytes: size }],
      onPart: (partAsk) => {
        ask = partAsk;
      },
    });
    await until(() => node.uploads.length === 1 && ask !== null, 'the upload started');
    // Wait for the stall: nothing more of the part comes.
    let last = -1;
    for (let stable = 0; stable < 8;) {
      await sleep(25);
      const sent = core().dataOf(ask).length;
      stable = sent === last ? stable + 1 : 0;
      last = sent;
    }
    expect(last).toBeLessThan(size / 2);
    const stats = harness.client.streamStats();
    // Main's swarm.body ring and its part's queue: a window each at most.
    expect(stats.ringBytes).toBeLessThanOrEqual(WINDOW);
    expect(stats.held).toBeLessThanOrEqual(WINDOW);
    // What main sent of the part is what the core forwarded, and a window.
    expect(last - core().creditedOf(ask)).toBeLessThanOrEqual(WINDOW);
    expect(pool.held).toBe(REPLY_ROOM + 2 * STREAM_CHARGE);
    node.uploads[0].req.resume();
    await serving;
    expect((await answered(id)).result.status).toBe(201);
    expect(node.uploads[0].bytes).toBe(size);
    expect(node.uploads[0].digest).toBe(sha(bytes));
    await settledAtZero();
  });

  test('four uploads beside streamed reads: each body whole at the node, the pool within its reservations and back at 0', async () => {
    const node = await uploadNode();
    await start();
    const core = () => harness.core();
    const size = MIB;
    const files = [0, 1, 2, 3].map((i) => patterned(size, 20 + i));
    const parents = [];
    for (const file of files) parents.push(await publishing(file, size));
    // Two streamed reads beside them.
    const reads = [];
    for (let i = 0; i < 2; i++) {
      const r = parentOf(harness.client, harness.shell, {
        row: 'readFeedEntry_latest',
        params: { topic: TOPIC, owner: OWNER },
        key: KEY,
        backend: antBackend(),
      });
      await until(() => r.id !== null, 'the read sent');
      const ready = core().ready(r.id, 'reachable');
      await until(() => core().reply(ready), 'its ready answer');
      reads.push(core().api(r.id, calls.feedLatest()));
    }
    // From here: four uploads and two streamed reads at once.
    pool.highWater = pool.held;
    const ups = [];
    for (const p of parents)
      ups.push(await uploadCall(p, calls.bzzFile({ body: { stream: size } })));
    await Promise.all([
      ...ups.map((u, i) =>
        serveUpload(core(), u.body.id, {
          parent: parents[i].id,
          pieces: [{ part: 0, bytes: size }],
        })
      ),
      ...reads.map(async (read) => {
        await until(() => core().reply(read), 'the read head');
        let credited = 0;
        while (!core().terminal(read)) {
          const got = core().dataOf(read).length;
          if (got > credited) {
            core().credit(read, got - credited);
            credited = got;
          }
          await sleep(1);
        }
      }),
    ]);
    for (const u of ups) expect((await answered(u.id)).result.status).toBe(201);
    for (const read of reads) {
      expect(core().terminal(read)).toEqual({ end: true });
      expect(core().dataOf(read).length).toBe(300 * KIB);
    }
    expect(node.uploads.map((u) => u.digest).sort()).toEqual(files.map(sha).sort());
    await settledAtZero();
    expect(pool.highWater).toBeLessThanOrEqual(
      4 * (REPLY_ROOM + 2 * STREAM_CHARGE) + 2 * STREAM_CHARGE
    );
  });

  test("point 12: a head of another length: main's cancel of the body, then { failed: 'error' }, undialled", async () => {
    const node = await uploadNode();
    await start();
    const core = () => harness.core();
    const p = await publishing(patterned(300 * KIB), 300 * KIB);
    const { id, body } = await uploadCall(p, calls.bzzFile({ body: { stream: 300 * KIB } }));
    core().respond(body.id, { bytes: 300 * KIB + 1 });
    expect((await answered(id)).result).toEqual({ failed: 'error' });
    const cancel = indexOf((w) => w.message?.type === 'cancel' && w.message.id === body.id);
    const answer = indexOf((w) => w.message?.type === 'response' && w.message.id === id);
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(answer);
    expect(node.uploads).toHaveLength(0);
    // The core ends its body, as it reads the cancel.
    abortBody(core(), body.id, 'cancelled');
    await settledAtZero();
  });

  test("point 12: a node that answers early: main's cancel of swarm.body is written before its answer, and no credit for the body after it", async () => {
    await uploadNode({
      answer: (req, res) => {
        req.pause();
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end('{"message":"too large"}');
      },
    });
    await start();
    const core = () => harness.core();
    const size = 4 * MIB;
    const p = await publishing(patterned(size), size);
    const { id, body } = await uploadCall(p, calls.bzzFile({ body: { stream: size } }));
    let ask = null;
    const serving = serveUpload(core(), body.id, {
      parent: p.id,
      pieces: [{ part: 0, bytes: size }],
      onPart: (partAsk) => {
        ask = partAsk;
      },
      stop: () => Boolean(core().reply(id)),
    });
    const reply = await answered(id);
    expect(reply.result.status).toBe(413);
    expect(Buffer.from(reply.result.body_base64, 'base64').toString()).toBe(
      '{"message":"too large"}'
    );
    await serving;
    const cancel = indexOf((w) => w.message?.type === 'cancel' && w.message.id === body.id);
    const answer = indexOf((w) => w.message?.type === 'response' && w.message.id === id);
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(answer);
    const lastCredit = core().wire.reduce(
      (at, w, i) => (w.frame?.kind === KIND_STREAM_CREDIT && w.frame.id === body.id ? i : at),
      -1
    );
    expect(lastCredit).toBeLessThan(cancel);
    // The core ends its body and cancels its part, as it reads the answer.
    abortBody(core(), body.id, 'cancelled');
    if (ask !== null) core().cancel(ask);
    await settledAtZero();
  });

  test("the core's cancel of an upload mid-body: answered cancelled at once, the body withdrawn in the same turn, and no credit for it after the answer (D4)", async () => {
    await uploadNode({ pause: true });
    await start();
    const core = () => harness.core();
    const size = 8 * MIB;
    const p = await publishing(patterned(size), size);
    const { id, body } = await uploadCall(p, calls.bzzFile({ body: { stream: size } }));
    let ask = null;
    let stopped = false;
    const serving = serveUpload(core(), body.id, {
      parent: p.id,
      pieces: [{ part: 0, bytes: size }],
      onPart: (partAsk) => {
        ask = partAsk;
      },
      stop: () => stopped,
    });
    // Mid-body: main has credited some of it.
    await until(() => core().creditOf(body.id) > 0, "main's credit for the body");
    core().cancel(id);
    expect((await answered(id)).error).toEqual({ code: 'cancelled', message: 'Cancelled' });
    stopped = true;
    await serving;
    await sleep(30);
    const answer = indexOf((w) => w.message?.type === 'response' && w.message.id === id);
    const cancel = indexOf((w) => w.message?.type === 'cancel' && w.message.id === body.id);
    expect(cancel).toBeGreaterThan(answer);
    const lastCredit = core().wire.reduce(
      (at, w, i) => (w.frame?.kind === KIND_STREAM_CREDIT && w.frame.id === body.id ? i : at),
      -1
    );
    expect(lastCredit).toBeGreaterThanOrEqual(0);
    expect(lastCredit).toBeLessThan(answer);
    // The core ends its body and its part.
    abortBody(core(), body.id, 'cancelled');
    if (ask !== null) core().cancel(ask);
    nodes[0].uploads[0].req.resume();
    await settledAtZero();
  });

  test('point 13: a picked file whose size changes mid-read ends its part body_stream_error with no error_code; one that cannot be read names its errno', async () => {
    await uploadNode();
    await start();
    const core = () => harness.core();
    const cases = [
      ['shrinks', (file) => fs.truncateSync(file, 200 * KIB), undefined],
      ['grows', (file) => fs.appendFileSync(file, Buffer.from('more')), undefined],
      ['is gone', (file) => fs.rmSync(file), 'ENOENT'],
    ];
    for (const [label, change, errorCode] of cases) {
      const size = 256 * KIB;
      const { file, source } = pickedFile(
        `mid-read-${label.replace(' ', '-')}.bin`,
        patterned(size)
      );
      const params = { data: partData(0, size), contentType: 'application/octet-stream' };
      if (errorCode) change(file);
      const p = parentOf(harness.client, harness.shell, {
        row: 'publishData',
        params,
        key: KEY,
        backend: antBackend(),
        parts: new Map([[0, source]]),
      });
      await until(() => p.id !== null, 'the parent sent');
      const ready = core().ready(p.id, 'publish');
      await until(() => core().reply(ready), 'the ready answer');
      const stamps = core().api(p.id, calls.stamps());
      await until(() => core().reply(stamps), 'the stamps');
      const { id, body } = await uploadCall(p, calls.bzzFile({ body: { stream: size } }));
      core().respond(body.id, { bytes: size });
      const ask = core().part(p.id, 0);
      await until(() => core().reply(ask), 'the part head');
      // Its head is the length its params gave, whatever the file does.
      expect(core().reply(ask).result).toEqual({ bytes: size });
      if (!errorCode) {
        // The first window, then the change, then the core's credit for
        // what main sends, as it forwards it.
        await until(() => core().dataOf(ask).length === WINDOW, 'the first window');
        change(file);
        await drain(core(), ask);
      }
      await until(() => core().terminal(ask), 'the part terminal');
      const terminal = core().terminal(ask);
      expect(terminal.kind).toBe(KIND_ABORT);
      expect(terminal.code).toBe('body_stream_error');
      expect(terminal.errorCode).toBe(errorCode);
      // The core ends the upload: its body, then its call.
      abortBody(core(), body.id, 'body_stream_error');
      core().cancel(id);
      await answered(id);
      p.handle.close();
    }
    await settledAtZero();
  });

  describe("the watchdog (point 3), on the client's clock", () => {
    test('a core silent for 75 s after swarm.body is hung: killed and restarted', async () => {
      await uploadNode();
      await start({}, { withClock: true });
      const core = harness.core();
      const p = await publishing(patterned(300 * KIB), 300 * KIB);
      await uploadCall(p, calls.bzzFile({ body: { stream: 300 * KIB } }));
      await clock.advance(74_999);
      expect(core.killed).toBeNull();
      await clock.advance(1);
      expect(core.killed).toBe('SIGKILL');
      expect(log.error).toHaveBeenCalledWith('[Core] request hung; restarting the core', {
        method: 'swarm.body',
      });
    });

    test("the part's frames and the core's credit on it move it on; the body's terminal ends it", async () => {
      await uploadNode();
      await start({}, { withClock: true });
      const core = harness.core();
      const size = 300 * KIB;
      const bytes = patterned(size, 11);
      const p = await publishing(bytes, size);
      const { id, body } = await uploadCall(p, calls.bzzFile({ body: { stream: size } }));
      // The core's head at 0 s: due at 75 s.
      core.respond(body.id, { bytes: size });
      // At 74 s the core pulls the part: main's head and first window are
      // its progress, due at 149 s.
      await clock.advance(74_000);
      const ask = core.part(p.id, 0);
      await until(() => core.dataOf(ask).length === WINDOW, 'the first window');
      await clock.advance(74_999);
      expect(core.killed).toBeNull();
      // At 148.999 s the core credits the part: due at 223.999 s.
      core.credit(ask, 64 * KIB);
      await until(() => core.dataOf(ask).length === WINDOW + 64 * KIB, 'the credited bytes');
      await clock.advance(74_999);
      expect(core.killed).toBeNull();
      // The body's terminal ends it: the core ends its upload.
      abortBody(core, body.id, 'cancelled');
      core.cancel(ask);
      core.cancel(id);
      await answered(id);
      await clock.advance(3_600_000);
      expect(core.killed).toBeNull();
      expect(harness.client.current.idleWatchdogs.size).toBe(0);
      p.handle.close();
      await settledAtZero();
    });
  });
});
