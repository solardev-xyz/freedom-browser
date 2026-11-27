/**
 * Main's Swarm executor (core/swarm-shell.js; freedom-core design 0015,
 * Node access, Main's Swarm I/O pool, and SWM-5's calls):
 * - **the switch:** FREEDOM_SWARM_BACKEND's states, the registry admitting
 *   nothing on `js`, and the handlers registered either way, so a stray ask
 *   is `ended`;
 * - **the registry:** a parent's ends (`close()`, its signal, its session's
 *   stop, its deadline), `ended` for a race and a fault for a `for` never
 *   sent, and a ready check of an ended parent answered `cancelled` only;
 * - **the strict readers** of both asks;
 * - **design 0015's refusal tests**, each refused before any dial by its
 *   rule and logged with the parent's row, its step and the rule;
 * - **every scenario of vectors/swarm-grammar.json** through the shell,
 *   refused and admitted call for call as main's Admission plays it, and
 *   every admitted call dialled once;
 * - **the pool tests**, through a real CoreClient against a scripted core
 *   (test/helpers/fake-swarm-core.js) and over real loopback HTTP
 *   (test/helpers/fake-http-node.js), each ending with the pool at 0: the
 *   caps, a core that stops reading, each Content-Length case, chunked,
 *   gzip, a trickle, error bodies, and four cancels;
 * - **the readiness checks** and the remote node's header rule.
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

const http = require('http');
const net = require('net');
const zlib = require('zlib');
const { ShellError, StreamedReply } = require('./core-client');
const { KIND_ABORT, KIND_DATA, WINDOW } = require('./frame');
const {
  SwarmShell,
  ERROR_BODY,
  STREAM_CHARGE,
  WALK_CHARGE,
  postCharge,
  wholeCharge,
} = require('./swarm-shell');
const { SwarmIoPool } = require('./swarm-io-pool');
const { feedUpdateAddress, pageTopic, topicOf } = require('./swarm-grammar');
const { SwarmData } = require('./swarm-typed');
const { swarmBackendKind } = require('../swarm/swarm-backend-kind');
const { antBackend } = require('../swarm/bzz-protocol');
const {
  coreCall,
  playScenario,
  replyOf,
  scenarioParams,
  swarmVectors,
  uploadReferences,
} = require('../../../test/helpers/swarm-vectors');
const {
  drain,
  parentOf,
  sleep,
  startSwarmCore,
  until,
} = require('../../../test/helpers/fake-swarm-core');
const { startFakeHttpNode, streamBody } = require('../../../test/helpers/fake-http-node');

const KIB = 1024;
const MIB = 1024 * KIB;
const LOOPBACK = 'http://127.0.0.1:1633';
const KEY = 'https://app.example';
const A = 'a1'.repeat(32);
const A2 = 'b2'.repeat(32);
const BATCH = 'c3'.repeat(32);
const OWNER = 'd4'.repeat(20);
const OWNER2 = 'e5'.repeat(20);
const ID = 'f6'.repeat(32);
const SIG = '17'.repeat(65);
const RECIPIENT = `02${'28'.repeat(32)}`;

function quietLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** Bytes a page sent where a method reads data, as swarm-typed.js reads them back. */
const data = (bytes, kind = 'Uint8Array') => new SwarmData(kind, bytes.length, bytes, null);
const text = (string) => {
  const bytes = Buffer.from(string, 'utf8');
  return new SwarmData('string', bytes.length, bytes, null);
};
/** An 8-byte little-endian span. */
function span(n) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
  return out;
}

// The core's `shell.swarm_api` calls, by form: what main reads, main's own
// two headers left out.
const calls = {
  chunk: (a, extra = {}) => ({
    form: 'chunk',
    method: 'GET',
    path: `/chunks/${a}`,
    query: [],
    headers: [],
    max_bytes: 4201,
    stream: false,
    ...extra,
  }),
  bytes: (a, max, range = null) => ({
    form: 'bytes',
    method: 'GET',
    path: `/bytes/${a}`,
    query: [],
    headers: range ? [['range', range]] : [],
    max_bytes: max,
    stream: true,
  }),
  feedHead: (o, t) => ({
    form: 'feed_head',
    method: 'GET',
    path: `/feeds/${o}/${t}`,
    query: [],
    headers: [['swarm-only-root-chunk', 'true']],
    max_bytes: 4201,
    stream: false,
  }),
  feedLatest: (o, t, max = 5 * MIB) => ({
    form: 'feed_latest',
    method: 'GET',
    path: `/feeds/${o}/${t}`,
    query: [],
    headers: [],
    max_bytes: max,
    stream: true,
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
  addresses: () => ({
    form: 'addresses',
    method: 'GET',
    path: '/addresses',
    query: [],
    headers: [],
    max_bytes: 65536,
    stream: false,
  }),
  stamps: () => ({
    form: 'stamps',
    method: 'GET',
    path: '/stamps',
    query: [],
    headers: [],
    max_bytes: MIB,
    stream: false,
  }),
  stamp: (b) => ({
    form: 'stamp',
    method: 'GET',
    path: `/stamps/${b}`,
    query: [],
    headers: [],
    max_bytes: 65536,
    stream: false,
  }),
  bzzFile: ({
    name = 'data',
    contentType = 'text/plain',
    deferred = 'false',
    body = { base64: '' },
    extra = [],
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
      ...extra,
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
  bzzTar: (body = { stream: 1024 }, extra = []) => ({
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
      ...extra,
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
  bytesUp: (body = { stream: 5000 }) => ({
    form: 'bytes_up',
    method: 'POST',
    path: '/bytes',
    query: [],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
  chunkUp: (body) => ({
    form: 'chunk_up',
    method: 'POST',
    path: '/chunks',
    query: [],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'false'],
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
  socUp: (o, id, body, { raw = false } = {}) => ({
    form: 'soc_up',
    method: 'POST',
    path: `/soc/${o}/${id}`,
    query: [['sig', SIG]],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
      ...(raw
        ? [
            ['swarm-pin', 'true'],
            ['swarm-deferred-upload', 'false'],
          ]
        : []),
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
  feedManifest: (o, t) => ({
    form: 'feed_manifest',
    method: 'POST',
    path: `/feeds/${o}/${t}`,
    query: [],
    headers: [['swarm-postage-batch-id', BATCH]],
    max_bytes: 65536,
    stream: false,
  }),
  pssSend: (t, x, body, recipient = RECIPIENT) => ({
    form: 'pss_send',
    method: 'POST',
    path: `/pss/send/${t}/${x}`,
    query: [['recipient', recipient]],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
    ],
    body,
    max_bytes: 65536,
    stream: false,
  }),
};

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/**
 * A node behind a captured backend, its dials scripted: `answer(init)`
 * gives each dial's Response (or throws). `GET /node` answers `{}` unless
 * `answer` takes it. Every dial's `init` is kept.
 */
function scriptedNode(
  answer = (init) => (init.path === '/node' ? undefined : new Response('', { status: 200 })),
  url = LOOPBACK
) {
  const node = { dials: [] };
  node.backend = {
    ref: { ant: 'bundled', up: true },
    url,
    request: jest.fn(async (init) => {
      node.dials.push(init);
      const out = answer(init, node.dials.length);
      if (out === undefined && init.path === '/node') return new Response('{}', { status: 200 });
      return out;
    }),
  };
  node.calls = () => node.dials.filter((init) => init.path !== '/node');
  return node;
}

/** The context the client calls a handler with: its signal, its lease. */
function context({ generation = 1, pool = null } = {}) {
  const controller = new AbortController();
  const ctx = {
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
  };
  return ctx;
}

/** `call` without its member `key`. */
function without(call, key) {
  const out = { ...call };
  delete out[key];
  return out;
}

/** `b64(m)`, 4⌈m / 3⌉. */
const b64Length = (bytes) => 4 * Math.ceil(bytes / 3);

/**
 * Records what main allocates of at least `min` bytes until `restore()`:
 * the Buffers, by the Buffer function that made them (the outermost call
 * only: `concat`'s own `allocUnsafe` isn't counted twice; a `from` over an
 * ArrayBuffer is a view, and isn't one), and the base64 strings Buffers
 * write (`toString('base64')`, as `base64`), each with what `at()` gives
 * as it is made (the pool's charge then, say).
 */
function trackAllocations(min, at = () => null) {
  const seen = [];
  const originals = {};
  let depth = 0;
  const record = (name, length) => {
    if (depth !== 1 || length < min) return;
    const held = at();
    seen.push(held === null ? [name, length] : [name, length, held]);
  };
  const isArrayBuffer = (value) =>
    ['[object ArrayBuffer]', '[object SharedArrayBuffer]'].includes(
      Object.prototype.toString.call(value)
    );
  for (const name of ['alloc', 'allocUnsafe', 'allocUnsafeSlow', 'concat', 'from']) {
    const original = Buffer[name];
    originals[name] = original;
    Buffer[name] = function tracked(...args) {
      depth += 1;
      try {
        const out = original.apply(this, args);
        if (!(name === 'from' && isArrayBuffer(args[0]))) record(name, out.length);
        return out;
      } finally {
        depth -= 1;
      }
    };
  }
  const toString = Buffer.prototype.toString;
  Buffer.prototype.toString = function tracked(...args) {
    depth += 1;
    try {
      const out = toString.apply(this, args);
      if (args[0] === 'base64') record('base64', out.length);
      return out;
    } finally {
      depth -= 1;
    }
  };
  return {
    seen,
    restore: () => {
      Object.assign(Buffer, originals);
      Buffer.prototype.toString = toString;
    },
  };
}

/** A handler's outcome: `{ rule }` for a refusal, else `{ result }`. */
async function outcome(pending) {
  try {
    return { result: await pending };
  } catch (err) {
    if (err instanceof ShellError && err.code === 'invalid_argument')
      return { rule: err.data.rule };
    throw err;
  }
}

function makeShell(deps = {}) {
  return new SwarmShell({
    log: quietLog(),
    backendKind: () => 'core',
    nodeUrl: () => LOOPBACK,
    publishReadiness: async () => ({ ok: true, reason: undefined, message: undefined }),
    ...deps,
  });
}

let nextParent = 1;

/** A parent of `row`, open in `shell`, with its asks. */
function parent(shell, row, params, { node = scriptedNode(), generation = 1, ...capture } = {}) {
  const id = nextParent++;
  const handle = shell.open(
    { generation, id },
    { row, params, key: KEY, backend: node.backend, ...capture }
  );
  return {
    id,
    node,
    handle,
    ready: (check, ctx = context({ generation })) => outcome(shell.ready({ for: id, check }, ctx)),
    api: (call, ctx = context({ generation })) => outcome(shell.api({ for: id, ...call }, ctx)),
  };
}

/** Reads a streamed reply's body to its end: its bytes, or its error. */
async function readStream(body) {
  const reader = body.getReader();
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(parts) };
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error };
  }
}

/** A whole reply's result, parsed from the JsonText the handler gives. */
function parsed(result) {
  if (!result?.parts) return result;
  return JSON.parse(
    result.parts.map((part) => (typeof part === 'string' ? part : part.toString('utf8'))).join('')
  );
}

describe('the switch (FREEDOM_SWARM_BACKEND)', () => {
  test.each([
    ['a development build, by default', 'js', false, undefined],
    ['a development build, the JS backend named', 'js', false, 'js'],
    ["a development build, the core's named", 'core', false, 'core'],
    ['a development build, an unknown value', 'js', false, 'rust'],
    ['a packaged build, by default', 'js', true, undefined],
    ["a packaged build, the core's named", 'js', true, 'core'],
  ])('%s: runs %s', (_label, runs, packaged, value) => {
    const log = require('../logger');
    log.warn.mockClear();
    const env = value === undefined ? {} : { FREEDOM_SWARM_BACKEND: value };
    expect(swarmBackendKind({ packaged, env })).toBe(runs);
    if (value === 'rust') {
      expect(log.warn).toHaveBeenCalledWith(
        '[Swarm] Unknown FREEDOM_SWARM_BACKEND=rust; using the JS backend'
      );
    } else {
      expect(log.warn).not.toHaveBeenCalled();
    }
  });

  test('an unknown value is warned of once', () => {
    const log = require('../logger');
    log.warn.mockClear();
    const env = { FREEDOM_SWARM_BACKEND: 'bee-js' };
    expect(swarmBackendKind({ packaged: false, env })).toBe('js');
    expect(swarmBackendKind({ packaged: false, env })).toBe('js');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("the registry's open() throws unless the switch runs the core; with it, a parent opens", () => {
    const node = scriptedNode();
    const capture = { row: 'readChunk', params: { reference: A }, backend: node.backend };
    for (const kind of ['js', 'anything']) {
      const shell = makeShell({ backendKind: () => kind });
      expect(() => shell.open({ generation: 1, id: 1 }, capture)).toThrow(/JS backend/);
      expect(shell.stats().parents).toBe(0);
    }
    const shell = makeShell();
    shell.open({ generation: 1, id: 1 }, capture);
    expect(shell.stats().parents).toBe(1);
  });

  test('the default switch reads the environment: a development build without the variable runs js, and admits nothing', () => {
    const saved = process.env.FREEDOM_SWARM_BACKEND;
    delete process.env.FREEDOM_SWARM_BACKEND;
    try {
      const shell = new SwarmShell({ log: quietLog() });
      const node = scriptedNode();
      expect(() =>
        shell.open(
          { generation: 1, id: 1 },
          { row: 'readChunk', params: { reference: A }, backend: node.backend }
        )
      ).toThrow(/JS backend/);
      process.env.FREEDOM_SWARM_BACKEND = 'core';
      expect(() =>
        shell.open(
          { generation: 1, id: 1 },
          { row: 'readChunk', params: { reference: A }, backend: node.backend }
        )
      ).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.FREEDOM_SWARM_BACKEND;
      else process.env.FREEDOM_SWARM_BACKEND = saved;
    }
  });

  test('on js the handlers are registered still: a stray ask of the core is answered ended, never unknown_method', async () => {
    const log = quietLog();
    const { client, core } = await startSwarmCore({ log, deps: { backendKind: () => 'js' } });
    try {
      const api = core().api(7, calls.chunk(A));
      const ready = core().ready(7, 'reachable');
      await until(() => core().reply(api) && core().reply(ready), 'the answers');
      for (const id of [api, ready]) {
        expect(core().reply(id).error).toEqual({
          code: 'invalid_argument',
          message: 'Invalid argument',
          data: { rule: 'ended' },
        });
      }
    } finally {
      await client.stop();
    }
  });
});

describe('the parent registry', () => {
  test('open() takes a row, an ID and a backend, once per parent', () => {
    const shell = makeShell();
    const { backend } = scriptedNode();
    const ok = { row: 'readChunk', params: { reference: A }, backend };
    expect(() => shell.open({ generation: 1, id: 0 }, ok)).toThrow('no request ID');
    expect(() => shell.open({ generation: 1.5, id: 1 }, ok)).toThrow('no request ID');
    expect(() => shell.open({ generation: 1, id: 1 }, { ...ok, row: 'readEverything' })).toThrow(
      'no grammar row'
    );
    expect(() => shell.open({ generation: 1, id: 1 }, { ...ok, backend: {} })).toThrow(
      'no backend'
    );
    expect(() => shell.open({ generation: 1, id: 1 }, { ...ok, deadlineAt: 'soon' })).toThrow(
      'a deadline is a time'
    );
    shell.open({ generation: 1, id: 1 }, ok);
    expect(() => shell.open({ generation: 1, id: 1 }, ok)).toThrow('open already');
    // Another generation's ID 1 is another parent.
    shell.open({ generation: 2, id: 1 }, ok);
    expect(shell.stats().parents).toBe(2);
  });

  test("a parent's end, each way, admits nothing more: its later calls are ended, a race logged at debug", async () => {
    const shell = makeShell();
    const ends = {
      close: (p) => p.handle.close(),
      signal: (p, s) => s.signal.abort(),
      stop: (p, s) => s.stop.abort(),
    };
    for (const [how, end] of Object.entries(ends)) {
      const sources = { signal: new AbortController(), stop: new AbortController() };
      const node = scriptedNode();
      const p = parent(
        shell,
        'readChunk',
        { reference: A },
        {
          node,
          signal: sources.signal.signal,
          stop: sources.stop.signal,
        }
      );
      end(p, sources);
      expect({ how, parents: shell.stats().parents }).toEqual({ how, parents: 0 });
      expect(await p.api(calls.chunk(A))).toEqual({ rule: 'ended' });
      expect(node.dials).toHaveLength(0);
    }
    expect(shell.log.warn).not.toHaveBeenCalled();
    expect(shell.log.debug).toHaveBeenCalledWith(
      '[Core] shell.swarm_api for a parent that has ended'
    );
  });

  test('a parent opened ended (its signal already aborted) is never live', async () => {
    const shell = makeShell();
    const p = parent(shell, 'readChunk', { reference: A }, { signal: AbortSignal.abort() });
    expect(shell.stats().parents).toBe(0);
    expect(await p.api(calls.chunk(A))).toEqual({ rule: 'ended' });
  });

  test('its deadline ends it, and the call dialling then is aborted', async () => {
    const timers = [];
    let clock = 1000;
    const shell = makeShell({
      now: () => clock,
      setTimer: (fn, ms) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        timer.cleared = true;
      },
    });
    let dialled;
    const node = scriptedNode(
      (init) =>
        new Promise((_resolve, reject) => {
          dialled = init;
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    const p = parent(shell, 'getUploadStatus', { tagUid: 5 }, { node, deadlineAt: 1500 });
    expect(timers.map((t) => t.ms)).toEqual([500]);
    const pending = p.api(calls.tag(5));
    await until(() => dialled, 'the dial');
    clock = 1500;
    timers[0].fn();
    expect(await pending).toEqual({ result: { failed: 'aborted' } });
    expect(shell.stats()).toEqual({ parents: 0, calls: 0, walks: 0 });
    expect(await p.api(calls.tag(5))).toEqual({ rule: 'ended' });
  });

  test('a for above every ID opened in its generation was never sent: ended, logged as a fault', async () => {
    const shell = makeShell();
    const p = parent(shell, 'readChunk', { reference: A });
    const never = await outcome(shell.api({ for: p.id + 100, ...calls.chunk(A) }, context()));
    expect(never).toEqual({ rule: 'ended' });
    expect(shell.log.warn).toHaveBeenCalledWith('[Core] shell.swarm_api refused', {
      rule: 'ended',
    });
    // Another generation's: never sent there either.
    const other = await outcome(
      shell.api({ for: p.id, ...calls.chunk(A) }, context({ generation: 9 }))
    );
    expect(other).toEqual({ rule: 'ended' });
    const ready = await outcome(shell.ready({ for: p.id + 100, check: 'reachable' }, context()));
    expect(ready).toEqual({ rule: 'ended' });
    expect(p.node.dials).toHaveLength(0);
  });

  test("a ready check of a parent main ended is never refused: it waits for the core's cancel, which is answered cancelled", async () => {
    const shell = makeShell();
    const p = parent(shell, 'readChunk', { reference: A });
    p.handle.close();
    const ctx = context();
    let settled = false;
    const pending = shell.ready({ for: p.id, check: 'reachable' }, ctx).then((value) => {
      settled = true;
      return value;
    });
    await sleep(20);
    expect(settled).toBe(false);
    ctx.controller.abort();
    await pending;
    expect(p.node.dials).toHaveLength(0);
    expect(shell.log.warn).not.toHaveBeenCalled();
  });

  test('a parent that ends while its ready check probes waits for the cancel too', async () => {
    const shell = makeShell();
    let probing;
    const node = scriptedNode(
      (init) =>
        new Promise((_resolve, reject) => {
          probing = init;
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    const p = parent(shell, 'readChunk', { reference: A }, { node });
    const ctx = context();
    let settled = false;
    const pending = shell.ready({ for: p.id, check: 'reachable' }, ctx).then(() => {
      settled = true;
    });
    await until(() => probing, 'the probe');
    p.handle.close();
    await sleep(20);
    expect(probing.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    ctx.controller.abort();
    await pending;
  });
});

describe('read strictly', () => {
  test('shell.swarm_ready is exactly { for, check }: anything else is refused form, logged', async () => {
    const shell = makeShell();
    const p = parent(shell, 'readChunk', { reference: A });
    const bad = [
      null,
      [],
      { for: p.id },
      { check: 'reachable' },
      { for: p.id, check: 'reachable', extra: 1 },
      { for: String(p.id), check: 'reachable' },
      { for: 0, check: 'reachable' },
      { for: p.id, check: 'open' },
      { for: p.id, check: 1 },
    ];
    for (const params of bad) {
      expect(await outcome(shell.ready(params, context()))).toEqual({ rule: 'form' });
    }
    expect(p.node.dials).toHaveLength(0);
  });

  test("a ready check its row doesn't name, a second one, or none where the row has none, is refused", async () => {
    const shell = makeShell();
    const wrong = parent(shell, 'readChunk', { reference: A });
    expect(await wrong.ready('publish')).toEqual({ rule: 'value' });
    const twice = parent(shell, 'readChunk', { reference: A });
    expect(await twice.ready('reachable')).toEqual({ result: { ok: true } });
    expect(await twice.ready('reachable')).toEqual({ rule: 'count' });
    const none = parent(shell, 'getUploadStatus', { tagUid: 5 });
    expect(await none.ready('reachable')).toEqual({ rule: 'form' });
    // Each refused parent refuses every later call.
    for (const p of [wrong, twice]) expect(await p.api(calls.chunk(A))).toEqual({ rule: 'ended' });
    expect(await none.api(calls.tag(5))).toEqual({ rule: 'ended' });
    expect(none.node.dials).toHaveLength(0);
  });

  test("shell.swarm_api is exactly the core's members; feed and tree exactly theirs", async () => {
    const shell = makeShell();
    const base = calls.chunk(A);
    const cases = [
      [{ ...base, extra: true }, 'form'],
      [without(base, 'stream'), 'form'],
      [without(base, 'query'), 'form'],
      [{ ...base, body: null }, 'body'],
      [{ ...base, body: 'AQI=' }, 'body'],
      [{ ...base, feed: { owner: OWNER, index: 0, more: 1 } }, 'value'],
      [{ ...base, feed: null }, 'value'],
      [{ ...base, tree: { length: 4096 } }, 'value'],
      [{ ...base, tree: { length: 4096, depth: 1, start: 0 } }, 'value'],
    ];
    for (const [call, rule] of cases) {
      const p = parent(shell, 'readChunk', { reference: A });
      await p.ready('reachable');
      expect(await p.api(call)).toEqual({ rule });
      // And the parent refuses every later call.
      expect(await p.api(base)).toEqual({ rule: 'ended' });
      expect(p.node.calls()).toHaveLength(0);
    }
    for (const params of [null, { ...base, for: 'x' }, { ...base, for: -1 }]) {
      expect(await outcome(shell.api(params, context()))).toEqual({ rule: 'form' });
    }
  });

  test('a refusal is logged at warn with the parent, its step and the rule, never a path or a value', async () => {
    const shell = makeShell();
    const p = parent(shell, 'readChunk', { reference: A });
    await p.ready('reachable');
    expect(await p.api(calls.chunk(A2))).toEqual({ rule: 'value' });
    expect(shell.log.warn).toHaveBeenCalledTimes(1);
    expect(shell.log.warn).toHaveBeenCalledWith('[Core] shell.swarm_api refused', {
      parent: 'readChunk',
      step: -1,
      rule: 'value',
    });
    expect(JSON.stringify(shell.log.warn.mock.calls)).not.toContain(A2);
    // Later calls are ended, at debug.
    expect(await p.api(calls.chunk(A))).toEqual({ rule: 'ended' });
    expect(shell.log.warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * One of design 0015's refusal tests: a parent of `row`, its ready check
 * answered `ok`, the `prefix` calls admitted and answered, then `call`
 * refused by `rule` before any dial, and logged with the parent's row and
 * the rule.
 */
async function refusedAfter({ row, params, ready = null, prefix = [], call, rule }) {
  const shell = makeShell();
  const queue = [];
  const node = scriptedNode((init) =>
    init.path === '/node' ? undefined : (queue.shift() ?? new Response('', { status: 200 }))
  );
  const p = parent(shell, row, params, { node });
  if (ready) expect(await p.ready(ready)).toEqual({ result: { ok: true } });
  for (const [admitted, reply] of prefix) {
    queue.push(reply ?? new Response('', { status: 200 }));
    const out = await p.api(admitted);
    expect({ form: admitted.form, rule: out.rule }).toEqual({ form: admitted.form });
    if (out.result instanceof StreamedReply) await readStream(out.result.body);
  }
  const dialled = node.calls().length;
  shell.log.warn.mockClear();
  expect({ form: call.form, outcome: await p.api(call) }).toEqual({
    form: call.form,
    outcome: { rule },
  });
  expect(node.calls()).toHaveLength(dialled);
  expect(shell.log.warn).toHaveBeenCalledWith(
    '[Core] shell.swarm_api refused',
    expect.objectContaining({ parent: row, rule })
  );
  return { shell, node, p };
}

const PUBLISH_DATA = { data: text('hello'), contentType: 'text/plain' };
const HELLO = { base64: b64('hello') };
const SOC_X = { base64: b64(Buffer.concat([span(1), Buffer.from('x')])) };
const PSS = { topic: 'chat', targets: 'AB12', recipient: RECIPIENT, data: text('hi') };
const FEED_TOPIC = pageTopic(KEY, 'f');
const headFound = () =>
  new Response('', {
    status: 200,
    headers: {
      'swarm-feed-index': '0000000000000000',
      'swarm-feed-index-next': '0000000000000001',
    },
  });
const MAIN_DATA = { kind: 'data', parts: [{ bytes: 5, base64: b64('hello') }], pin: true };

describe("design 0015's refusal tests: each refused before any dial, and logged with its rule", () => {
  describe('cross-operation', () => {
    test.each([
      ['POST /bzz', calls.bzzFile({ body: HELLO })],
      ['GET /stamps', calls.stamps()],
      ['GET /addresses', calls.addresses()],
      ['POST /soc', calls.socUp(OWNER, ID, SOC_X)],
      ['POST /pss/send', calls.pssSend(topicOf('chat'), 'ab12', { base64: b64('hi') })],
      ['feed_latest', calls.feedLatest(OWNER, A)],
    ])('under readChunk: %s is form', async (_name, call) => {
      await refusedAfter({
        row: 'readChunk',
        params: { reference: A },
        ready: 'reachable',
        call,
        rule: 'form',
      });
    });

    test.each([
      ['bzz_tar', calls.bzzTar(), 'form'],
      [
        'chunk_up',
        calls.chunkUp({ base64: b64(Buffer.concat([span(5), Buffer.from('hello')])) }),
        'form',
      ],
      [
        'a swarm-collection header',
        calls.bzzFile({ body: HELLO, extra: [['swarm-collection', 'true']] }),
        'header',
      ],
    ])('under publishData: %s is %s', async (_name, call, rule) => {
      await refusedAfter({
        row: 'publishData',
        params: PUBLISH_DATA,
        ready: 'publish',
        prefix: [[calls.stamps()]],
        call,
        rule,
      });
    });

    test.each([
      ['feed_manifest', calls.feedManifest(OWNER, A)],
      ['bytes_up', calls.bytesUp()],
    ])('under writeSingleOwnerChunk: %s is form', async (_name, call) => {
      await refusedAfter({
        row: 'writeSingleOwnerChunk',
        params: { identifier: ID, data: data(Buffer.from('x')) },
        ready: 'publish',
        prefix: [[calls.stamps()]],
        call,
        rule: 'form',
      });
    });

    test("under getUploadStatus: another tag than the page's is value", async () => {
      await refusedAfter({
        row: 'getUploadStatus',
        params: { tagUid: 5 },
        call: calls.tag(6),
        rule: 'value',
      });
    });

    test.each([
      ['bzz_file', calls.bzzFile({ body: HELLO })],
      ['bzz_tar', calls.bzzTar()],
      ['bytes_up', calls.bytesUp()],
      ['chunk_up', calls.chunkUp(SOC_X)],
      ['soc_up', calls.socUp(OWNER, ID, SOC_X)],
      ['feed_manifest', calls.feedManifest(OWNER, A)],
      ['pss_send', calls.pssSend(topicOf('chat'), 'ab12', { base64: b64('hi') })],
    ])('under swarm.stamps: any write (%s) is form', async (_name, call) => {
      await refusedAfter({ row: 'swarm.stamps', params: {}, call, rule: 'form' });
    });

    test("one parent's for with a call only another parent's row has is form", async () => {
      const shell = makeShell();
      const reader = parent(shell, 'readChunk', { reference: A });
      const status = parent(shell, 'getUploadStatus', { tagUid: 5 });
      await reader.ready('reachable');
      expect(await reader.api(calls.tag(5))).toEqual({ rule: 'form' });
      expect(reader.node.calls()).toHaveLength(0);
      // The other parent's own call is still its own.
      expect((await status.api(calls.tag(5))).rule).toBeUndefined();
    });
  });

  describe('cross-phase', () => {
    test('an upload before its stamps is order, and a second stamps count', async () => {
      await refusedAfter({
        row: 'publishData',
        params: PUBLISH_DATA,
        ready: 'publish',
        call: calls.bzzFile({ body: HELLO }),
        rule: 'order',
      });
      await refusedAfter({
        row: 'publishData',
        params: PUBLISH_DATA,
        ready: 'publish',
        prefix: [[calls.stamps()]],
        call: calls.stamps(),
        rule: 'count',
      });
    });

    test('a call before the ready check, or after one that answered ok: false, is order', async () => {
      await refusedAfter({
        row: 'readChunk',
        params: { reference: A },
        call: calls.chunk(A),
        rule: 'order',
      });
      const shell = makeShell();
      const node = scriptedNode(
        (init) => new Response('', { status: init.path === '/node' ? 503 : 200 })
      );
      const p = parent(shell, 'readChunk', { reference: A }, { node });
      expect(await p.ready('reachable')).toEqual({ result: { ok: false, reason: 'node-stopped' } });
      expect(await p.api(calls.chunk(A))).toEqual({ rule: 'order' });
      expect(node.calls()).toHaveLength(0);
    });

    test("a feed write's soc_up before its index lookup, or before its bytes_up, is order", async () => {
      await refusedAfter({
        row: 'writeFeedEntry',
        params: { name: 'f', data: text('small') },
        ready: 'publish',
        prefix: [[calls.stamps()]],
        call: calls.socUp(OWNER, ID, SOC_X),
        rule: 'order',
      });
      await refusedAfter({
        row: 'writeFeedEntry',
        params: { name: 'f', data: data(Buffer.alloc(5000, 1)) },
        ready: 'publish',
        prefix: [[calls.stamps()], [calls.feedHead(OWNER, FEED_TOPIC), headFound()]],
        call: calls.socUp(OWNER, ID, SOC_X),
        rule: 'order',
      });
    });

    test('a bytes_up for a feed entry of 4,096 bytes or less is order', async () => {
      await refusedAfter({
        row: 'writeFeedEntry',
        params: { name: 'f', data: data(Buffer.alloc(4096, 1)) },
        ready: 'publish',
        prefix: [[calls.stamps()], [calls.feedHead(OWNER, FEED_TOPIC), headFound()]],
        call: calls.bytesUp({ stream: 4096 }),
        rule: 'order',
      });
    });

    test('a second upload is count', async () => {
      await refusedAfter({
        row: 'publishData',
        params: PUBLISH_DATA,
        ready: 'publish',
        prefix: [
          [calls.stamps()],
          [calls.bzzFile({ body: HELLO }), new Response('{}', { status: 201 })],
        ],
        call: calls.bzzFile({ body: HELLO }),
        rule: 'count',
      });
    });

    test('an 82nd probe chunk is count', async () => {
      const { HeadProbe } = require('./swarm-grammar');
      const probe = new HeadProbe();
      const prefix = [
        [calls.stamps()],
        [calls.feedHead(OWNER, FEED_TOPIC), new Response('', { status: 404 })],
      ];
      for (let i = 0; i < 81; i++) {
        const index = probe.nextIndex;
        const status = index < 2 ** 40 ? 200 : 404;
        probe.asked();
        probe.answer(status);
        prefix.push([
          calls.chunk(feedUpdateAddress(FEED_TOPIC, OWNER, BigInt(index)), {
            feed: { owner: OWNER, index },
          }),
          new Response(status === 200 ? Buffer.alloc(120) : '', { status }),
        ]);
      }
      await refusedAfter({
        row: 'updateFeed',
        params: { feedId: 'f', reference: A },
        ready: 'publish',
        prefix,
        call: calls.chunk(feedUpdateAddress(FEED_TOPIC, OWNER, 0n), {
          feed: { owner: OWNER, index: 0 },
        }),
        rule: 'count',
      });
    });

    test('a call while another of the same parent is open is order', async () => {
      const shell = makeShell();
      const node = scriptedNode((init) =>
        init.path === '/node' ? undefined : new Promise(() => {})
      );
      const p = parent(shell, 'readChunk', { reference: A }, { node });
      await p.ready('reachable');
      p.api(calls.chunk(A));
      await until(() => node.calls().length === 1, 'the first dial');
      expect(await p.api(calls.chunk(A))).toEqual({ rule: 'order' });
      expect(node.calls()).toHaveLength(1);
      p.handle.close();
    });

    test('any call after the parent ended is ended', async () => {
      const shell = makeShell();
      const p = parent(shell, 'getUploadStatus', { tagUid: 5 });
      expect((await p.api(calls.tag(5))).rule).toBeUndefined();
      p.handle.close();
      expect(await p.api(calls.tag(5))).toEqual({ rule: 'ended' });
      expect(p.node.calls()).toHaveLength(1);
    });
  });

  describe('values', () => {
    test.each([
      ['another reference', 'readChunk', { reference: A }, 'reachable', [], calls.chunk(A2)],
      [
        'another identifier',
        'writeSingleOwnerChunk',
        { identifier: ID, data: data(Buffer.from('x')) },
        'publish',
        [[calls.stamps()]],
        calls.socUp(OWNER, A2, SOC_X, { raw: true }),
      ],
      [
        'another topic',
        'sendPss',
        PSS,
        'publish',
        [[calls.stamps()]],
        calls.pssSend(topicOf('other'), 'ab12', { base64: b64('hi') }),
      ],
      [
        'another recipient',
        'sendPss',
        PSS,
        'publish',
        [[calls.stamps()]],
        calls.pssSend(topicOf('chat'), 'ab12', { base64: b64('hi') }, `03${'28'.repeat(32)}`),
      ],
      [
        'another target',
        'sendPss',
        PSS,
        'publish',
        [[calls.stamps()]],
        calls.pssSend(topicOf('chat'), 'ab13', { base64: b64('hi') }),
      ],
      [
        'upper-case targets',
        'sendPss',
        PSS,
        'publish',
        [[calls.stamps()]],
        calls.pssSend(topicOf('chat'), 'AB12', { base64: b64('hi') }),
      ],
      [
        'a second <o> within one request',
        'updateFeed',
        { feedId: 'f', reference: A },
        'publish',
        [[calls.stamps()], [calls.feedHead(OWNER, FEED_TOPIC), new Response('', { status: 404 })]],
        calls.chunk(feedUpdateAddress(FEED_TOPIC, OWNER2, 0n), {
          feed: { owner: OWNER2, index: 0 },
        }),
      ],
      [
        'another <t>',
        'createFeed',
        { name: 'f' },
        'publish',
        [[calls.stamps()]],
        calls.feedManifest(OWNER, pageTopic(KEY, 'g')),
      ],
      [
        'swarm-deferred-upload: true for publishData',
        'publishData',
        PUBLISH_DATA,
        'publish',
        [[calls.stamps()]],
        calls.bzzFile({ body: HELLO, deferred: 'true' }),
      ],
      [
        "another content-type than the page's",
        'publishData',
        PUBLISH_DATA,
        'publish',
        [[calls.stamps()]],
        calls.bzzFile({ body: HELLO, contentType: 'text/html' }),
      ],
    ])('%s is value', async (_name, row, params, ready, prefix, call) => {
      await refusedAfter({ row, params, ready, prefix, call, rule: 'value' });
    });

    test('swarm-encrypt under swarm.request, or under swarm.publish without encrypt, is header', async () => {
      const encrypt = [['swarm-encrypt', 'true']];
      await refusedAfter({
        row: 'publishData',
        params: PUBLISH_DATA,
        ready: 'publish',
        prefix: [[calls.stamps()]],
        call: calls.bzzFile({ body: HELLO, extra: encrypt }),
        rule: 'header',
      });
      await refusedAfter({
        row: 'swarm.publish:data,file',
        params: { ...MAIN_DATA, deferred: false },
        prefix: [[calls.stamps()]],
        call: calls.bzzFile({ body: HELLO, extra: encrypt }),
        rule: 'header',
      });
    });
  });

  describe('bodies', () => {
    test.each([
      ["a length other than the row's", calls.bzzFile({ body: { base64: b64('hell') } })],
      [
        "base64 bytes that differ from the page's",
        calls.bzzFile({ body: { base64: b64('hellp') } }),
      ],
      ['{ stream } where the row has { base64 }', calls.chunkUp({ stream: 13 })],
      ["a max_bytes past the form's cap", { ...calls.bzzFile({ body: HELLO }), max_bytes: 65537 }],
    ])('%s is body', async (_name, call) => {
      const row = call.form === 'chunk_up' ? 'publishChunk' : 'publishData';
      const params = row === 'publishChunk' ? { data: data(Buffer.from('hello')) } : PUBLISH_DATA;
      await refusedAfter({
        row,
        params,
        ready: 'publish',
        prefix: [[calls.stamps()]],
        call,
        rule: 'body',
      });
    });

    test('{ base64 } where the row has { stream }, and a chunk past its 4,201 bytes, are body', async () => {
      await refusedAfter({
        row: 'publishFiles',
        params: { files: [{ path: 'index.html', bytes: data(Buffer.from('<p>')) }] },
        ready: 'publish',
        prefix: [[calls.stamps()]],
        call: calls.bzzTar({ base64: b64('tar') }, [['swarm-index-document', 'index.html']]),
        rule: 'body',
      });
      await refusedAfter({
        row: 'readChunk',
        params: { reference: A },
        ready: 'reachable',
        call: { ...calls.chunk(A), max_bytes: 4202 },
        rule: 'body',
      });
    });
  });
});

const grammar = swarmVectors('swarm-grammar.json');
const swarmFile = swarmVectors('swarm.json');
const dwebVerify = swarmVectors('dweb-verify.json');
const vectorFiles = { grammar, swarm: swarmFile, dwebVerify };
const describeIfVectors = grammar && swarmFile && dwebVerify ? describe : describe.skip;

/** A scenario's reply as the node would give it: a Response, or a throw. */
function nodeAnswer(reply) {
  if (!reply || reply.status === null) {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  }
  return new Response(reply.body ?? null, {
    status: reply.status,
    headers: reply.headers,
  });
}

/**
 * Plays a grammar scenario through the shell, call by call, the node
 * answering each dial with the scenario's reply: `{ at, rule }` for the
 * first refusal, `{ upload }` for the first streamed upload (admitted and
 * answered `{ failed: "error" }`, undialled: SWM-5's sixth step), or null.
 * Each admitted call is dialled exactly once, a refused one never.
 */
async function playThroughShell(s) {
  const params = scenarioParams(s);
  const references = uploadReferences(s, grammar, swarmFile);
  let pending = null;
  const node = scriptedNode((init) => {
    if (init.path === '/node') {
      return new Response(s.ready?.ok ? '{}' : '', { status: s.ready?.ok ? 200 : 503 });
    }
    const reply = pending;
    pending = null;
    return nodeAnswer(reply);
  });
  const shell = makeShell({
    nodeUrl: () => node.backend.url,
    publishReadiness: async () =>
      s.ready?.ok ? { ok: true } : { ok: false, reason: 'node-not-ready', message: 'x' },
  });
  const id = nextParent++;
  shell.open(
    { generation: 1, id },
    { row: s.row, params, key: s.key ?? null, backend: node.backend }
  );
  if (s.ready) {
    const ready = await outcome(shell.ready({ for: id, check: s.ready.check }, context()));
    if (ready.rule) return { at: -1, rule: ready.rule };
    expect(ready.result.ok).toBe(s.ready.ok);
  }
  for (const [at, c] of s.calls.entries()) {
    const call = coreCall(c, params);
    pending = replyOf(c, dwebVerify.swarm.chunks, references);
    const dialled = node.calls().length;
    const out = await outcome(shell.api({ for: id, ...call }, context()));
    if (out.rule) {
      expect(node.calls()).toHaveLength(dialled);
      return { at, rule: out.rule };
    }
    if (call.body?.stream !== undefined) {
      expect(out.result).toEqual({ failed: 'error' });
      expect(node.calls()).toHaveLength(dialled);
      return { upload: at };
    }
    if (out.result instanceof StreamedReply) await readStream(out.result.body);
    expect(node.calls()).toHaveLength(dialled + 1);
  }
  return null;
}

describeIfVectors('every scenario of vectors/swarm-grammar.json through the shell', () => {
  /**
   * The shell refuses and admits exactly what main's Admission does with
   * the scenario's own replies (`playScenario`, which
   * swarm-grammar.vectors.test.js holds to the file), with the replies main
   * forwarded from the node in their place; a streamed upload ends the play
   * here, before what main's Admission would decide after it.
   */
  async function compare(list) {
    const wrong = [];
    let played = 0;
    let uploads = 0;
    for (const s of grammar[list]) {
      const expected = playScenario(s, vectorFiles);
      const got = await playThroughShell(s);
      played += 1;
      if (got?.upload !== undefined) {
        uploads += 1;
        if (expected && expected.at <= got.upload) wrong.push({ id: s.id, expected, got });
        continue;
      }
      const want = expected && { at: expected.at, rule: expected.rule };
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push({ id: s.id, want, got });
    }
    return { wrong, played, uploads };
  }

  test("every honest scenario: the Admission's verdict, call by call, each admitted call dialled once", async () => {
    const { wrong, played, uploads } = await compare('honest');
    expect(wrong).toEqual([]);
    expect(played).toBe(grammar.honest.length);
    expect(played).toBeGreaterThanOrEqual(370);
    // The streamed uploads among them stop at the upload, for SWM-5's sixth step.
    expect(uploads).toBeGreaterThan(0);
  });

  test('every forbidden scenario: refused where the Admission refuses it, by its rule, undialled', async () => {
    const { wrong, played } = await compare('forbidden');
    expect(wrong).toEqual([]);
    expect(played).toBe(grammar.forbidden.length);
    expect(played).toBeGreaterThanOrEqual(73);
  });
});

/**
 * A raw HTTP node on loopback: `respond(socket, head)` writes each answer
 * byte for byte (a body delimited by the connection's close, which Node's
 * server never writes for HTTP/1.1).
 */
async function rawNode(respond) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      respond(socket, head.subarray(0, end).toString('latin1'));
    };
    socket.on('data', onData);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('through the core client, over loopback HTTP: the pool, the bodies, the cancels', () => {
  let harness = null;
  let pool = null;
  const nodes = [];

  async function start(deps = {}) {
    pool = deps.pool ?? new SwarmIoPool();
    harness = await startSwarmCore({
      log: quietLog(),
      deps: { backendKind: () => 'core', nodeUrl: () => mockRegistry.url, ...deps, pool },
    });
    return harness;
  }

  async function httpNode(handler) {
    const node = await startFakeHttpNode({ handler });
    nodes.push(node);
    mockRegistry.url = node.origin;
    return node;
  }

  async function raw(respond) {
    const node = await rawNode(respond);
    nodes.push(node);
    mockRegistry.url = node.origin;
    return node;
  }

  /** Main's parent of `row`, open in the shell on the node's backend. */
  async function open(row, params, extra = {}) {
    const p = parentOf(harness.client, harness.shell, {
      row,
      params,
      key: KEY,
      backend: antBackend(),
      ...extra,
    });
    await until(() => p.id !== null, 'the parent sent');
    expect(p.error).toBeNull();
    return p;
  }

  /** Opens a parent and passes its ready check. */
  async function ready(row, params, check, extra) {
    const p = await open(row, params, extra);
    const id = harness.core().ready(p.id, check);
    await until(() => harness.core().reply(id), 'the ready answer');
    expect(harness.core().reply(id).result).toEqual({ ok: true });
    return p;
  }

  async function answered(id) {
    await until(() => harness.core().reply(id), `the answer to ${id}`);
    return harness.core().reply(id);
  }

  /** The pool back at 0, nothing dialling or streaming. */
  async function settledAtZero() {
    await until(() => pool.held === 0 && harness.shell.stats().calls === 0, 'the pool at 0');
  }

  afterEach(async () => {
    // A core a test left not reading reads again, so it can be stopped.
    harness?.core().release();
    if (harness) await harness.client.stop();
    harness = null;
    for (const node of nodes.splice(0)) await node.close();
    mockRegistry.url = null;
  });

  describe('the forms on the wire', () => {
    test("a whole call: one dial with main's headers, the five reply headers the core reads in Headers' order, the body as base64, charged to the Swarm pool only", async () => {
      const node = await httpNode((req, res) => {
        if (req.url === '/node') {
          res.end('{}');
          return;
        }
        res.writeHead(200, {
          'Content-Length': 11,
          'Content-Type': 'application/octet-stream',
          'X-Other': 'not forwarded',
          'Swarm-Tag': '7',
          'Set-Cookie': 'a=b',
        });
        res.end('chunk bytes');
      });
      await start();
      const chainTake = jest.spyOn(harness.client.pool, 'take');
      const p = await ready('readChunk', { reference: A }, 'reachable');
      const id = harness.core().api(p.id, calls.chunk(A));
      expect((await answered(id)).result).toEqual({
        status: 200,
        status_text: 'OK',
        headers: [
          ['content-length', '11'],
          ['content-type', 'application/octet-stream'],
          ['swarm-tag', '7'],
        ],
        body_base64: b64('chunk bytes'),
      });
      const dial = node.requests.find((r) => r.url === `/chunks/${A}`);
      expect(dial.method).toBe('GET');
      expect(dial.headers.accept).toBe('application/json, text/plain, */*');
      expect(dial.headers['accept-encoding']).toBe('identity');
      expect(node.requests.map((r) => r.url)).toEqual(['/node', `/chunks/${A}`]);
      await settledAtZero();
      expect(pool.highWater).toBe(wholeCharge(8192));
      expect(chainTake).not.toHaveBeenCalled();
    });

    test('a base64 POST: its query encoded as URLSearchParams does, its bytes sent, and a 500 answered whole and never retried', async () => {
      const bodies = [];
      const node = await httpNode((req, res) => {
        const parts = [];
        req.on('data', (chunk) => parts.push(chunk));
        req.on('end', () => {
          bodies.push(Buffer.concat(parts));
          if (req.url === '/stamps') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"stamps":[]}');
            return;
          }
          res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': 29 });
          res.end('{"code":500,"message":"boom"}');
        });
      });
      await start({ publishReadiness: async () => ({ ok: true }) });
      const params = { data: text('hello'), contentType: 'text/plain', name: 'a b&c/d.txt' };
      const p = await ready('publishData', params, 'publish');
      const stamps = harness.core().api(p.id, calls.stamps());
      expect((await answered(stamps)).result.status).toBe(200);
      const upload = harness.core().api(p.id, calls.bzzFile({ name: 'a b&c/d.txt', body: HELLO }));
      expect((await answered(upload)).result).toEqual({
        status: 500,
        status_text: 'Internal Server Error',
        headers: [
          ['content-length', '29'],
          ['content-type', 'application/json'],
        ],
        body_base64: b64('{"code":500,"message":"boom"}'),
      });
      const posts = node.requests.filter((r) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe('/bzz?name=a+b%26c%2Fd.txt');
      expect(posts[0].headers['content-type']).toBe('text/plain');
      expect(posts[0].headers['swarm-postage-batch-id']).toBe(BATCH);
      expect(posts[0].headers['content-length']).toBe('5');
      expect(bodies[bodies.length - 1].toString()).toBe('hello');
      await settledAtZero();
    });

    test("a streamed read: its head carries no body member, its bytes go only under the core's credit, and its 256 KiB go at its terminal", async () => {
      const total = 300 * KIB;
      await httpNode((req, res, entry) => {
        if (req.url === '/node') {
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        streamBody(entry, { total });
      });
      await start();
      const p = await ready('readFeedEntry_latest', { topic: A, owner: OWNER }, 'reachable');
      const id = harness.core().api(p.id, calls.feedLatest(OWNER, A));
      expect((await answered(id)).result).toEqual({
        status: 200,
        status_text: 'OK',
        headers: [['content-type', 'application/octet-stream']],
      });
      await until(() => harness.core().dataOf(id).length === WINDOW, 'the first window');
      await sleep(50);
      // No credit, no more than the window.
      expect(harness.core().dataOf(id).length).toBe(WINDOW);
      expect(pool.held).toBe(STREAM_CHARGE);
      await drain(harness.core(), id);
      expect(harness.core().terminal(id)).toEqual({ end: true });
      expect(harness.core().dataOf(id).length).toBe(total);
      await settledAtZero();
    });
  });

  describe('the caps', () => {
    test('whole calls at their caps until their charges would pass 64 MiB, streamed reads beside them: the pool never passes 64 MiB, and a call that does not fit is busy, undialled', async () => {
      const held = [];
      const node = await httpNode((req, res, entry) => {
        if (req.url === '/node') {
          res.end('{}');
          return;
        }
        held.push(entry);
      });
      await start({ pool: new SwarmIoPool() });
      const stamps = wholeCharge(MIB);
      const fit = Math.floor((64 * MIB) / stamps);
      const parents = [];
      const asks = [];
      for (let i = 0; i < fit; i++) {
        const p = await open('swarm.stamps', {});
        parents.push(p);
        asks.push(harness.core().api(p.id, calls.stamps()));
      }
      await until(() => held.length === fit, 'every /stamps dial');
      expect(pool.held).toBe(fit * stamps);
      // Streamed reads beside them, while they fit.
      const streams = [];
      while (pool.held + STREAM_CHARGE + wholeCharge(8192) <= 64 * MIB) {
        const p = await ready('readFeedEntry_latest', { topic: A, owner: OWNER }, 'reachable');
        streams.push(harness.core().api(p.id, calls.feedLatest(OWNER, A)));
        await until(() => held.length === fit + streams.length, 'the streamed dial');
      }
      expect(streams.length).toBeGreaterThan(0);
      // One /stamps more doesn't fit: busy, and nothing is dialled for it.
      const extra = await open('swarm.stamps', {});
      const busy = harness.core().api(extra.id, calls.stamps());
      expect((await answered(busy)).result).toEqual({ failed: 'busy' });
      expect(node.requests.filter((r) => r.url === '/stamps')).toHaveLength(fit);
      // A chunk still fits.
      const small = await ready('readChunk', { reference: A }, 'reachable');
      const chunk = harness.core().api(small.id, calls.chunk(A));
      await until(() => held.length === fit + streams.length + 1, 'the chunk dial');
      expect(pool.highWater).toBeLessThanOrEqual(64 * MIB);
      for (const entry of held) {
        entry.res.writeHead(200);
        entry.res.end('[]');
      }
      for (const id of [...asks, chunk]) expect((await answered(id)).result.status).toBe(200);
      for (const id of streams) await drain(harness.core(), id);
      await settledAtZero();
      expect(pool.highWater).toBeLessThanOrEqual(64 * MIB);
    });

    test('a core that stops reading: replies wait unwritten until the pool is full; a new call is busy, while ready answers, cancels and stream heads still go out', async () => {
      await httpNode((req, res, entry) => {
        if (req.url === '/node') {
          res.end('{}');
          return;
        }
        if (req.url.startsWith('/feeds/')) {
          res.writeHead(200);
          streamBody(entry, { total: 200 * KIB });
          return;
        }
        // A declared length: the body is one exact block.
        res.writeHead(200, { 'Content-Length': 60 * KIB });
        res.end(Buffer.alloc(60 * KIB, 0x61));
      });
      const replied = wholeCharge(60 * KIB);
      await start({ pool: new SwarmIoPool(2 * replied + STREAM_CHARGE + 100 * KIB) });
      const tags = [];
      for (const uid of [1, 2]) tags.push([await open('getUploadStatus', { tagUid: uid }), uid]);
      const reader = await ready('readFeedEntry_latest', { topic: A, owner: OWNER }, 'reachable');
      const fresh = await open('readChunk', { reference: A });
      const leaving = new AbortController();
      const cancelled = await open('readChunk', { reference: A2 }, { signal: leaving.signal });
      const core = harness.core();
      core.stuck = true;
      const asks = tags.map(([p, uid]) => core.api(p.id, calls.tag(uid)));
      const stream = core.api(reader.id, calls.feedLatest(OWNER, A));
      await until(
        () => pool.held === 2 * replied + STREAM_CHARGE,
        'the pool full of waiting replies'
      );
      // A new call is busy, and nothing is dialled for it.
      const late = await open('getUploadStatus', { tagUid: 3 });
      const busy = core.api(late.id, calls.tag(3));
      // A ready check is answered, and main's cancel of a parent goes.
      const check = core.ready(fresh.id, 'reachable');
      const lateCheck = core.ready(cancelled.id, 'reachable');
      leaving.abort();
      await sleep(50);
      expect(pool.held).toBe(2 * replied + STREAM_CHARGE);
      core.release();
      expect((await answered(busy)).result).toEqual({ failed: 'busy' });
      for (const id of asks) expect((await answered(id)).result.status).toBe(200);
      expect((await answered(stream)).result.status).toBe(200);
      expect((await answered(check)).result).toEqual({ ok: true });
      await until(() => core.messages.some((m) => m.type === 'cancel'), "main's cancel");
      // The ready check of a parent main cancelled waits for the core's cancel.
      core.cancel(lateCheck);
      expect((await answered(lateCheck)).error).toEqual({
        code: 'cancelled',
        message: 'Cancelled',
      });
      await drain(core, stream);
      await settledAtZero();
      expect(pool.highWater).toBeLessThanOrEqual(pool.limit);
    });

    test("readData's walk reserves its occurrence map when the root it returned walks, until the parent ends; without room its later calls are busy", async () => {
      const root = Buffer.concat([span(10_000), Buffer.alloc(64, 1)]);
      await httpNode((req, res) => {
        res.end(req.url === '/node' ? '{}' : root);
      });
      await start();
      const p = await ready('readData', { reference: A }, 'reachable');
      const id = harness.core().api(p.id, calls.chunk(A));
      expect((await answered(id)).result.status).toBe(200);
      await until(() => harness.shell.stats().walks === 1, 'the walk');
      expect(pool.held).toBe(WALK_CHARGE);
      p.handle.close();
      expect(pool.held).toBe(0);
      // Without room for the map, the walk's calls are busy.
      const tight = makeShell({ pool: new SwarmIoPool(WALK_CHARGE - 1) });
      const node = scriptedNode((init) => (init.path === '/node' ? undefined : new Response(root)));
      const q = parent(tight, 'readData', { reference: A }, { node });
      await q.ready('reachable');
      expect((await q.api(calls.chunk(A))).result).toBeDefined();
      expect(tight.stats().walks).toBe(0);
      const next = await q.api(calls.bytes(A, 10_000, 'bytes=0-9999'));
      expect(next).toEqual({ result: { failed: 'busy' } });
      expect(node.calls()).toHaveLength(1);
    });
  });

  describe('the bodies', () => {
    /** One whole `tag` call (64 KiB at most) of a fresh parent. */
    async function tagCall(uid = 5) {
      const p = await open('getUploadStatus', { tagUid: uid });
      return answered(harness.core().api(p.id, calls.tag(uid)));
    }

    /** One streamed `feed_latest` call of a fresh parent, at most `max`. */
    async function latest(max) {
      const p = await ready('readFeedEntry_latest', { topic: A, owner: OWNER }, 'reachable');
      const id = harness.core().api(p.id, calls.feedLatest(OWNER, A, max));
      return { id, head: await answered(id) };
    }

    const nodeOk = (req, res) => {
      if (req.url !== '/node') return false;
      res.end('{}');
      return true;
    };

    test('a missing Content-Length: the body read to its close, as one without a length; past max_bytes, too_large', async () => {
      let size = 1000;
      await raw((socket) => {
        socket.end(
          Buffer.concat([
            Buffer.from('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n'),
            Buffer.alloc(size, 0x62),
          ])
        );
      });
      await start();
      const whole = await tagCall();
      expect(whole.result).toEqual({
        status: 200,
        status_text: 'OK',
        headers: [],
        body_base64: b64(Buffer.alloc(1000, 0x62)),
      });
      size = 64 * KIB + 1;
      expect((await tagCall(6)).result).toEqual({ failed: 'too_large' });
      await settledAtZero();
    });

    test('a Content-Length over max_bytes: a whole call too_large before its body; a stream its head, then too_large before any piece', async () => {
      const node = await httpNode((req, res, entry) => {
        if (nodeOk(req, res)) return;
        res.writeHead(200, { 'Content-Length': 200 * KIB });
        streamBody(entry, { total: 200 * KIB });
      });
      await start();
      expect((await tagCall()).result).toEqual({ failed: 'too_large' });
      const { id, head } = await latest(100 * KIB);
      expect(head.result).toEqual({
        status: 200,
        status_text: 'OK',
        headers: [['content-length', String(200 * KIB)]],
      });
      await until(() => harness.core().terminal(id), 'the terminal');
      expect(harness.core().terminal(id)).toMatchObject({ kind: KIND_ABORT, code: 'too_large' });
      expect(harness.core().framesOf(KIND_DATA, id)).toHaveLength(0);
      // The node's body was let go of, not read to its end.
      await until(() => node.requests.slice(1).every((r) => r.closed), 'the dials closed');
      await settledAtZero();
    });

    test('a Content-Length that lies low is a hint only: main stops at max_bytes, whole or streamed', async () => {
      // No transport carries more than its framing says, so the lie is the
      // backend's: a declared 10 bytes over 100.
      const node = scriptedNode((init) =>
        init.path === '/node'
          ? undefined
          : new Response(Buffer.alloc(100, 0x63), { headers: { 'content-length': '10' } })
      );
      const shell = makeShell();
      const whole = parent(shell, 'getUploadStatus', { tagUid: 5 }, { node });
      expect(await whole.api({ ...calls.tag(5), max_bytes: 50 })).toEqual({
        result: { failed: 'too_large' },
      });
      const streamed = parent(shell, 'readFeedEntry_latest', { topic: A, owner: OWNER }, { node });
      await streamed.ready('reachable');
      const out = await streamed.api(calls.feedLatest(OWNER, A, 50));
      expect(out.result).toBeInstanceOf(StreamedReply);
      const read = await readStream(out.result.body);
      expect(read.bytes.length).toBeLessThanOrEqual(50);
      expect(read.error.abortCode).toBe('too_large');
    });

    test('a Content-Length that lies high fails at the short end: a whole call error, a stream body_stream_error', async () => {
      await httpNode((req, res) => {
        if (nodeOk(req, res)) return;
        res.writeHead(200, { 'Content-Length': 1000 });
        res.write(Buffer.alloc(500, 0x64));
        setTimeout(() => res.destroy(), 20);
      });
      await start();
      expect((await tagCall()).result).toEqual({ failed: 'error' });
      const { id } = await latest(4096);
      await drain(harness.core(), id);
      expect(harness.core().terminal(id)).toMatchObject({ code: 'body_stream_error' });
      await settledAtZero();
    });

    test('a chunked body is read as one without a length, and held to max_bytes', async () => {
      let size = 3000;
      await httpNode((req, res) => {
        if (nodeOk(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        for (let sent = 0; sent < size; sent += 1000) res.write(Buffer.alloc(1000, 0x65));
        res.end();
      });
      await start();
      const whole = await tagCall();
      expect(whole.result.headers).toEqual([['content-type', 'application/json']]);
      expect(Buffer.from(whole.result.body_base64, 'base64')).toEqual(Buffer.alloc(3000, 0x65));
      size = 70_000;
      expect((await tagCall(6)).result).toEqual({ failed: 'too_large' });
      await settledAtZero();
    });

    test('a gzip body sent despite identity: decoded bytes count, so one that inflates past max_bytes is too_large; its encoded length is never forwarded', async () => {
      let plain = Buffer.alloc(1000, 0x66);
      await httpNode((req, res) => {
        if (nodeOk(req, res)) return;
        const gz = zlib.gzipSync(plain);
        res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
        res.end(gz);
      });
      await start();
      const small = await tagCall();
      expect(small.result.headers).toEqual([]);
      expect(Buffer.from(small.result.body_base64, 'base64')).toEqual(plain);
      plain = Buffer.alloc(MIB, 0);
      expect((await tagCall(6)).result).toEqual({ failed: 'too_large' });
      const { id, head } = await latest(64 * KIB);
      expect(head.result.headers).toEqual([]);
      await drain(harness.core(), id);
      expect(harness.core().terminal(id)).toMatchObject({ code: 'too_large' });
      expect(harness.core().dataOf(id).length).toBeLessThanOrEqual(64 * KIB);
      await settledAtZero();
    });

    test("a body that trickles: the idle bound fails a whole call error and a stream stalled; one that trickles under it ends at its request's deadline", async () => {
      let trickle = false;
      const entries = [];
      await httpNode((req, res, entry) => {
        if (nodeOk(req, res)) return;
        entries.push(entry);
        res.writeHead(200);
        res.write('x');
        if (!trickle) return;
        const timer = setInterval(() => {
          if (entry.closed) clearInterval(timer);
          else res.write('x');
        }, 40);
      });
      await start({ idleMs: 200 });
      expect((await tagCall()).result).toEqual({ failed: 'error' });
      const { id } = await latest(4096);
      await until(() => harness.core().terminal(id), 'the stall');
      expect(harness.core().terminal(id)).toMatchObject({ code: 'stalled' });
      // Under the idle bound, until the deadline.
      trickle = true;
      const p = await open('getUploadStatus', { tagUid: 9 }, { deadlineAt: Date.now() + 500 });
      const ask = harness.core().api(p.id, calls.tag(9));
      expect((await answered(ask)).result).toEqual({ failed: 'aborted' });
      await until(() => entries.every((e) => e.closed), 'the dials closed');
      await settledAtZero();
    });

    test('error bodies are answered whole, 8 KiB at most: empty, JSON, text, and longer ones cut', async () => {
      const bodies = {
        404: '',
        500: '{"code":500,"message":"Internal Server Error"}',
        400: 'bad request',
        503: 'y'.repeat(20 * KIB),
      };
      let status = 404;
      await httpNode((req, res) => {
        if (nodeOk(req, res)) return;
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(bodies[status]);
      });
      await start();
      for (const code of [404, 500, 400, 503]) {
        status = code;
        const { result } = await tagCall(code);
        expect(result.status).toBe(code);
        const body = Buffer.from(result.body_base64, 'base64').toString();
        expect(body).toBe(bodies[code].slice(0, ERROR_BODY));
      }
      // A streaming call's error status is answered whole too, never streamed.
      status = 500;
      const { id, head } = await latest(MIB);
      expect(head.result.body_base64).toBe(b64(bodies[500]));
      expect(harness.core().terminal(id)).toBeNull();
      await settledAtZero();
    });
  });

  describe('the four cancels: each answered cancelled at once, each charge released once nothing of it is held', () => {
    test('mid-dial', async () => {
      const node = await httpNode((req, res) => {
        if (req.url === '/node') res.end('{}');
      });
      await start();
      const p = await open('getUploadStatus', { tagUid: 5 });
      const id = harness.core().api(p.id, calls.tag(5));
      await until(() => node.requests.length === 1, 'the dial');
      expect(pool.held).toBe(wholeCharge(65536));
      harness.core().cancel(id);
      expect((await answered(id)).error).toEqual({ code: 'cancelled', message: 'Cancelled' });
      await until(() => node.requests[0].closed, 'the dial aborted');
      await settledAtZero();
    });

    test('mid-body', async () => {
      const node = await httpNode((req, res) => {
        res.writeHead(200);
        res.write('{"uid":');
      });
      await start();
      const p = await open('getUploadStatus', { tagUid: 5 });
      const id = harness.core().api(p.id, calls.tag(5));
      await until(() => node.requests.length === 1, 'the dial');
      await sleep(30);
      harness.core().cancel(id);
      expect((await answered(id)).error).toEqual({ code: 'cancelled', message: 'Cancelled' });
      await until(() => node.requests[0].aborted, 'the body let go of');
      await settledAtZero();
    });

    test('mid-stream', async () => {
      const node = await httpNode((req, res, entry) => {
        if (req.url === '/node') {
          res.end('{}');
          return;
        }
        res.writeHead(200);
        // Endless, so only main's cancel ends it: a sent 1 MiB would sit
        // whole in the sockets' buffers.
        streamBody(entry, { total: Infinity });
      });
      await start();
      const { id } = await (async () => {
        const p = await ready('readFeedEntry_latest', { topic: A, owner: OWNER }, 'reachable');
        const ask = harness.core().api(p.id, calls.feedLatest(OWNER, A, MIB));
        await answered(ask);
        return { id: ask };
      })();
      await until(() => harness.core().dataOf(id).length === WINDOW, 'the first window');
      harness.core().cancel(id);
      await until(() => harness.core().terminal(id), 'the abort');
      expect(harness.core().terminal(id)).toMatchObject({ code: 'cancelled' });
      await until(() => node.requests[1].aborted, 'the node let go of');
      await settledAtZero();
    });

    test('after the reply is serialized, before it is written', async () => {
      await httpNode((req, res) => {
        const body =
          req.url === '/stamps' ? Buffer.alloc(900 * KIB, 0x67) : Buffer.alloc(60 * KIB, 1);
        // A declared length: the body is one exact block.
        res.writeHead(200, { 'Content-Length': body.length });
        res.end(body);
      });
      await start();
      const small = await open('getUploadStatus', { tagUid: 5 });
      const large = await open('swarm.stamps', {});
      const core = harness.core();
      core.stuck = true;
      const first = core.api(small.id, calls.tag(5));
      const charge = wholeCharge(60 * KIB);
      await until(
        () => harness.shell.stats().calls === 0 && pool.held === charge,
        'the first reply waiting'
      );
      // The large reply's base64 passes one frame: it goes fragmented.
      const second = core.api(large.id, calls.stamps());
      await until(
        () => harness.shell.stats().calls === 0 && pool.held === charge + wholeCharge(900 * KIB),
        'the second reply waiting'
      );
      core.cancel(first);
      core.cancel(second);
      await sleep(30);
      // The bytes main still holds keep their charge: at least the first's,
      // written already into the pipe; a fragmented one not yet begun goes.
      expect(pool.held).toBeGreaterThanOrEqual(charge);
      core.release();
      // Each is answered once: its reply, which the core drops, or the
      // cancelled that replaced one not begun.
      expect((await answered(first)).result.status).toBe(200);
      const late = await answered(second);
      expect(late.error ?? late.result.status).toEqual(
        late.error ? { code: 'cancelled', message: 'Cancelled' } : 200
      );
      await settledAtZero();
    });
  });

  test('a parent that ends mid-stream aborts its body body_stream_error; one that ends mid-dial answers aborted', async () => {
    const node = await httpNode((req, res, entry) => {
      if (req.url === '/node') {
        res.end('{}');
        return;
      }
      if (req.url.startsWith('/tags/')) return;
      res.writeHead(200);
      streamBody(entry, { total: Infinity });
    });
    await start();
    const reader = await ready('readFeedEntry_latest', { topic: A, owner: OWNER }, 'reachable');
    const id = harness.core().api(reader.id, calls.feedLatest(OWNER, A, MIB));
    await answered(id);
    reader.handle.close();
    await until(() => harness.core().terminal(id), 'the abort');
    expect(harness.core().terminal(id)).toMatchObject({ code: 'body_stream_error' });
    const status = await open('getUploadStatus', { tagUid: 5 });
    const ask = harness.core().api(status.id, calls.tag(5));
    await until(() => node.requests.some((r) => r.url === '/tags/5'), 'the dial');
    status.handle.close();
    expect((await answered(ask)).result).toEqual({ failed: 'aborted' });
    await settledAtZero();
  });

  describe("what main holds beyond the pool's view (Codex round 1 on #1340)", () => {
    /**
     * Stops the core reading, behind one small write it holds: what main
     * writes after it waits in main, never reaching the scripted core's
     * decoder, so main's own allocations are the only ones made.
     */
    async function stall() {
      const core = harness.core();
      const fresh = await open('getUploadStatus', { tagUid: 99 });
      core.stuck = true;
      // A reply the core holds unfinished: everything after it waits in main.
      core.api(fresh.id, { ...calls.tag(99), extra: true });
      await until(() => core.held.length === 1, 'the held write');
      return core;
    }

    test('a whole reply holds one decoded body, the chunks it was read in: no copy of it is made whole, and its frame is serialized once', async () => {
      // 40 writes of 16 KiB, read in as many chunks or fewer.
      const length = 640 * KIB;
      await httpNode((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        let sent = 0;
        const step = () => {
          if (sent >= length) {
            res.end();
            return;
          }
          res.write(Buffer.alloc(16 * KIB, 0x30));
          sent += 16 * KIB;
          setImmediate(step);
        };
        step();
      });
      await start();
      const p = await open('swarm.stamps', {});
      const core = await stall();
      const allocations = trackAllocations(length / 2);
      let id;
      try {
        id = core.api(p.id, calls.stamps());
        await until(
          () => harness.shell.stats().calls === 0 && pool.held === wholeCharge(length),
          'the reply serialized, waiting'
        );
      } finally {
        allocations.restore();
      }
      // Nothing m-sized but the one frame: no whole copy of the body, no
      // second copy of the frame.
      const frame = 5 + JSON.stringify({ type: 'response', id }).length + b64Length(length) + 60;
      expect(allocations.seen).toHaveLength(1);
      expect(allocations.seen[0][0]).toBe('allocUnsafe');
      expect(allocations.seen[0][1]).toBeGreaterThan(b64Length(length));
      expect(allocations.seen[0][1]).toBeLessThan(frame + 1024);
      core.release();
      const reply = await answered(id);
      expect(Buffer.from(reply.result.body_base64, 'base64')).toEqual(Buffer.alloc(length, 0x30));
      await settledAtZero();
    });

    test('an answer the grammar reads is copied once, and that copy is charged: m + 2 x b64(m) + 16 KiB and m more', async () => {
      // A readData root of one chunk (its span 4,096: no walk), which the
      // grammar reads for its size.
      const root = Buffer.concat([span(4096), Buffer.alloc(4096, 7)]);
      await httpNode((req, res) => {
        res.end(req.url === '/node' ? '{}' : root);
      });
      await start();
      const p = await ready('readData', { reference: A }, 'reachable');
      const core = await stall();
      const allocations = trackAllocations(root.length);
      let id;
      try {
        id = core.api(p.id, calls.chunk(A));
        await until(
          () =>
            harness.shell.stats().calls === 0 &&
            pool.held === wholeCharge(root.length) + root.length,
          'the reply serialized, waiting'
        );
      } finally {
        allocations.restore();
      }
      // The body's one block (its declared length), and the grammar's copy.
      expect(allocations.seen.filter(([, n]) => n === root.length)).toEqual([
        ['allocUnsafeSlow', root.length],
        ['concat', root.length],
      ]);
      core.release();
      expect((await answered(id)).result.body_base64).toBe(b64(root));
      await settledAtZero();
    });
  });
});

describe("readData's walk map, reserved before its root may fill it (Codex round 1 on #1340)", () => {
  // A root of 8,192 logical bytes: two leaves, which its answer adds to the
  // occurrence map.
  const LEAVES = ['33'.repeat(32), '44'.repeat(32)];
  const ROOT = Buffer.concat([span(8192), ...LEAVES.map((leaf) => Buffer.from(leaf, 'hex'))]);
  const treeOf = (shell, p) => shell.live.get(`1:${p.id}`)?.admission.tree;

  test('many open readData parents with a tight pool: each walk without room leaves no map, and its calls are busy, undialled', async () => {
    const pool = new SwarmIoPool(2 * WALK_CHARGE + WALK_CHARGE / 2);
    const shell = makeShell({ pool });
    const parents = [];
    for (let i = 0; i < 5; i++) {
      const node = scriptedNode((init) => (init.path === '/node' ? undefined : new Response(ROOT)));
      const p = parent(shell, 'readData', { reference: A }, { node });
      await p.ready('reachable');
      expect(await p.api(calls.chunk(A))).toEqual({ result: expect.any(Object) });
      parents.push(p);
    }
    expect(pool.held).toBe(2 * WALK_CHARGE);
    expect(shell.stats().walks).toBe(2);
    const [first, second, ...without] = parents;
    for (const p of [first, second]) {
      expect(treeOf(shell, p).slots).toBe(2);
      // Its leaves are the walk's to fetch.
      const leaf = calls.chunk(LEAVES[0], { tree: { length: 4096, depth: 1 } });
      expect((await p.api(leaf)).rule).toBeUndefined();
    }
    for (const p of without) {
      const tree = treeOf(shell, p);
      expect({ slots: tree.slots, keys: tree.map.size }).toEqual({ slots: 0, keys: 0 });
      const leaf = calls.chunk(LEAVES[0], { tree: { length: 4096, depth: 1 } });
      expect(await p.api(leaf)).toEqual({ result: { failed: 'busy' } });
      expect(await p.api(calls.bytes(A, 8192, 'bytes=0-8191'))).toEqual({
        result: { failed: 'busy' },
      });
      expect(p.node.calls()).toHaveLength(1);
    }
    for (const p of parents) p.handle.close();
    expect(pool.held).toBe(0);
  });
});

describe("a base64 POST's body: decoded once, charged before it exists, to the dial's end", () => {
  const n = 40 * KIB;
  const bytes = Buffer.alloc(n, 0x5a);
  const params = { data: data(bytes), contentType: 'application/octet-stream' };
  const upload = (body = bytes) =>
    calls.bzzFile({ contentType: 'application/octet-stream', body: { base64: b64(body) } });
  const ROOM = wholeCharge(65536);

  /** A publishData parent past its ready check and `/stamps`, on `node`. */
  async function publishing(shell, node) {
    const p = parent(shell, 'publishData', params, { node });
    await p.ready('publish');
    expect((await p.api(calls.stamps())).rule).toBeUndefined();
    return p;
  }

  test('one decoded copy, made after its charge: the dial sends it, and its charge goes when the dial ends', async () => {
    const pool = new SwarmIoPool();
    const shell = makeShell();
    let atDial = null;
    let sent = null;
    const node = scriptedNode((init) => {
      if (init.method !== 'POST') return undefined;
      atDial = pool.held;
      sent = init.body;
      return new Response('{"reference":"x"}', { status: 201 });
    });
    const p = await publishing(shell, node);
    const call = upload();
    const ctx = context({ pool });
    const allocations = trackAllocations(n, () => pool.held);
    let out;
    try {
      out = await p.api(call, ctx);
    } finally {
      allocations.restore();
    }
    expect(parsed(out.result).status).toBe(201);
    // Decoded once, by the grammar's check, with its charge already taken,
    // and no base64 written back to check it: the core's string is the
    // only one.
    expect(allocations.seen.filter(([, size]) => size === n)).toEqual([['from', n, postCharge(n)]]);
    expect(allocations.seen.filter(([name]) => name === 'base64')).toEqual([]);
    expect(Buffer.from(sent)).toEqual(bytes);
    // During the dial: the body's charge and the reply's reservation.
    expect(atDial).toBe(postCharge(n) + ROOM);
    // After it: the reply's alone.
    // (Its 17 bytes, undeclared, in the first 4 KiB block.)
    expect(pool.held).toBe(4 * KIB + 2 * b64Length(17) + 16 * KIB);
  });

  test('released on every path: a failed dial, a refusal, no room for the reply', async () => {
    const failing = scriptedNode((init) => {
      if (init.method !== 'POST') return undefined;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    const pool = new SwarmIoPool();
    const p = await publishing(makeShell(), failing);
    expect(await p.api(upload(), context({ pool }))).toEqual({ result: { failed: 'unreachable' } });
    expect(pool.held).toBe(0);
    // Another body than the page's: refused, its charge gone.
    const refused = await publishing(makeShell(), scriptedNode());
    expect(await refused.api(upload(Buffer.alloc(n, 1)), context({ pool }))).toEqual({
      rule: 'body',
    });
    expect(pool.held).toBe(0);
    // Room for the body but not the reply: busy, nothing held, undialled.
    const tight = new SwarmIoPool(postCharge(n) + ROOM - 1);
    const node = scriptedNode();
    const q = await publishing(makeShell(), node);
    expect(await q.api(upload(), context({ pool: tight }))).toEqual({
      result: { failed: 'busy' },
    });
    expect(tight.held).toBe(0);
    expect(node.calls()).toHaveLength(1);
  });

  test('no room for the body: busy before the grammar decodes it, undialled, and the call still unadmitted', async () => {
    const shell = makeShell();
    const node = scriptedNode();
    const p = await publishing(shell, node);
    const tight = new SwarmIoPool(postCharge(n) - 1);
    const call = upload();
    const allocations = trackAllocations(n);
    let out;
    try {
      out = await p.api(call, context({ pool: tight }));
    } finally {
      allocations.restore();
    }
    expect(out).toEqual({ result: { failed: 'busy' } });
    expect(allocations.seen).toEqual([]);
    expect(tight.held).toBe(0);
    expect(node.calls()).toHaveLength(1);
    // Nothing was admitted: the upload is still the parent's next call.
    expect((await p.api(upload(), context({ pool: new SwarmIoPool() }))).rule).toBeUndefined();
  });

  test('a base64 past the inline bound is refused by its length, never decoded or charged', async () => {
    const shell = makeShell();
    const p = await publishing(shell, scriptedNode());
    const huge = { ...upload(), body: { base64: 'A'.repeat(4 * Math.ceil((64 * KIB) / 3) + 4) } };
    const pool = new SwarmIoPool();
    const allocations = trackAllocations(64 * KIB);
    let out;
    try {
      out = await p.api(huge, context({ pool }));
    } finally {
      allocations.restore();
    }
    expect(out).toEqual({ rule: 'body' });
    expect(allocations.seen).toEqual([]);
    expect(pool.highWater).toBe(0);
  });
});

describe('bodies in one-byte chunks: O(blocks) held, never O(chunks) (Codex round 2 on #1340)', () => {
  /** A body of `total` bytes of `byte`, one byte a chunk, pulled only when read. */
  function oneByteChunks(total, byte = 0x7b) {
    const state = { sent: 0 };
    state.stream = new ReadableStream(
      {
        pull(controller) {
          if (state.sent >= total) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array([byte]));
          state.sent += 1;
        },
      },
      { highWaterMark: 0 }
    );
    return state;
  }

  test("a whole reply at its form's largest, a 1 MiB /stamps, in one-byte chunks: a bounded count of blocks and runs, and every byte held within the charge", async () => {
    const total = MIB;
    const node = scriptedNode((init) =>
      init.path === '/stamps' ? new Response(oneByteChunks(total).stream) : undefined
    );
    const shell = makeShell();
    const pool = new SwarmIoPool();
    const p = parent(shell, 'swarm.stamps', {}, { node });
    const ctx = context({ pool });
    const tracked = trackAllocations(1);
    let out;
    try {
      out = await p.api(calls.stamps(), ctx);
    } finally {
      tracked.restore();
    }
    const kinds = (name) => tracked.seen.filter(([kind]) => kind === name);
    const sum = (list) => list.reduce((bytes, [, n]) => bytes + n, 0);
    const blocks = kinds('allocUnsafeSlow');
    const runs = kinds('base64');
    // About 20 blocks (4 KiB doubling to 64 KiB), never a Buffer a chunk.
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThanOrEqual(24);
    expect(sum(blocks)).toBe(total);
    expect(runs.length).toBeLessThanOrEqual(2 * blocks.length);
    expect(sum(runs)).toBe(b64Length(total));
    // Each other Buffer is a run's carry, at most a few bytes, one a block.
    const others = tracked.seen.filter(([kind]) => kind !== 'allocUnsafeSlow' && kind !== 'base64');
    expect(others.length).toBeLessThanOrEqual(2 * blocks.length);
    expect(others.every(([, n]) => n <= 3)).toBe(true);
    // The reply's parts: O(blocks) too.
    expect(out.result.parts.length).toBeLessThanOrEqual(7 + 2 * blocks.length);
    // What is held, the blocks and the runs, with the serialized reply still
    // to come, is within the charge.
    expect(sum(blocks) + sum(runs) + out.result.length).toBeLessThanOrEqual(ctx.held);
    expect(ctx.held).toBe(wholeCharge(total));
    expect(Buffer.from(parsed(out.result).body_base64, 'base64')).toEqual(
      Buffer.alloc(total, 0x7b)
    );
  }, 60_000);

  test('a declared length is one block, exactly that', async () => {
    const node = scriptedNode((init) =>
      init.path === '/stamps'
        ? new Response(oneByteChunks(5000).stream, { headers: { 'content-length': '5000' } })
        : undefined
    );
    const shell = makeShell();
    const p = parent(shell, 'swarm.stamps', {}, { node });
    const tracked = trackAllocations(1);
    try {
      await p.api(calls.stamps());
    } finally {
      tracked.restore();
    }
    expect(tracked.seen.filter(([kind]) => kind === 'allocUnsafeSlow')).toEqual([
      ['allocUnsafeSlow', 5000],
    ]);
  });

  test('a streamed reply in one-byte chunks reaches the core intact, through one read buffer reused', async () => {
    const total = 200 * KIB;
    const harness = await startSwarmCore({
      log: quietLog(),
      deps: { backendKind: () => 'core', nodeUrl: () => LOOPBACK },
    });
    try {
      const node = scriptedNode((init) =>
        init.path === '/node' ? undefined : new Response(oneByteChunks(total, 0x6c).stream)
      );
      const p = parentOf(harness.client, harness.shell, {
        row: 'readFeedEntry_latest',
        params: { topic: A, owner: OWNER },
        key: KEY,
        backend: node.backend,
      });
      await until(() => p.id !== null, 'the parent');
      const check = harness.core().ready(p.id, 'reachable');
      await until(() => harness.core().reply(check), 'the ready answer');
      const id = harness.core().api(p.id, calls.feedLatest(OWNER, A, total));
      await until(() => harness.core().reply(id), 'the head');
      await drain(harness.core(), id);
      expect(harness.core().terminal(id)).toEqual({ end: true });
      expect(harness.core().dataOf(id)).toEqual(Buffer.alloc(total, 0x6c));
    } finally {
      await harness.client.stop();
    }
  }, 60_000);
});

describe('shell.swarm_ready', () => {
  test("reachable: GET /node on the parent's transport, answered ok for a 2xx of JSON, node-stopped otherwise", async () => {
    const answers = [
      [() => new Response('{"bee":true}'), { ok: true }],
      [() => new Response('﻿{}'), { ok: true }],
      [() => new Response('{}', { status: 503 }), { ok: false, reason: 'node-stopped' }],
      [() => new Response('<html>'), { ok: false, reason: 'node-stopped' }],
      [() => new Response(''), { ok: false, reason: 'node-stopped' }],
      [() => new Response(`"${'x'.repeat(64 * KIB)}"`), { ok: false, reason: 'node-stopped' }],
      [
        () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        },
        { ok: false, reason: 'node-stopped' },
      ],
    ];
    for (const [answer, expected] of answers) {
      const shell = makeShell();
      const node = scriptedNode((init) => (init.path === '/node' ? answer() : undefined));
      const p = parent(shell, 'readChunk', { reference: A }, { node });
      expect(await p.ready('reachable')).toEqual({ result: expected });
      expect(node.dials.map((d) => [d.method, d.path])).toEqual([['GET', '/node']]);
      expect([...node.dials[0].headers]).toEqual([
        ['accept', 'application/json, text/plain, */*'],
        ['accept-encoding', 'identity'],
      ]);
    }
  });

  test('reachable: 5 s in all, then node-stopped; and with no node, no dial', async () => {
    const shell = makeShell({ setTimer: (fn, ms) => setTimeout(fn, ms === 5000 ? 30 : ms) });
    const node = scriptedNode((init) =>
      init.path === '/node'
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{'));
              },
            })
          )
        : undefined
    );
    const p = parent(shell, 'readChunk', { reference: A }, { node });
    expect(await p.ready('reachable')).toEqual({ result: { ok: false, reason: 'node-stopped' } });
    const stopped = makeShell({ nodeUrl: () => null });
    const q = parent(stopped, 'readChunk', { reference: A });
    expect(await q.ready('reachable')).toEqual({ result: { ok: false, reason: 'node-stopped' } });
    expect(q.node.dials).toHaveLength(0);
  });

  test('publish: getPublishReadiness() as it stands, its ok and reason only; a throw is node-stopped', async () => {
    const cases = [
      [{ ok: true, reason: undefined, message: undefined }, { ok: true }],
      [
        { ok: false, reason: 'no-usable-stamps', message: 'Buy storage' },
        { ok: false, reason: 'no-usable-stamps' },
      ],
      [
        { ok: false, reason: '' },
        { ok: false, reason: 'node-stopped' },
      ],
      [null, { ok: false, reason: 'node-stopped' }],
      ['throw', { ok: false, reason: 'node-stopped' }],
    ];
    for (const [readiness, expected] of cases) {
      const shell = makeShell({
        publishReadiness: async () => {
          if (readiness === 'throw') throw new Error('down');
          return readiness;
        },
      });
      const p = parent(shell, 'publishData', PUBLISH_DATA);
      expect(await p.ready('publish')).toEqual({ result: expected });
      expect(p.node.dials).toHaveLength(0);
    }
  });

  test("subscribe: the proxy seam's reason, else the probe", async () => {
    const refusing = makeShell({ subscribeCheck: () => 'proxy-or-tor' });
    const p = parent(refusing, 'subscribe', {});
    expect(await p.ready('subscribe')).toEqual({ result: { ok: false, reason: 'proxy-or-tor' } });
    expect(p.node.dials).toHaveLength(0);
    const seam = jest.fn(async () => null);
    const passing = makeShell({ subscribeCheck: seam });
    const q = parent(passing, 'subscribe', {});
    expect(await q.ready('subscribe')).toEqual({ result: { ok: true } });
    expect(seam).toHaveBeenCalledWith({ backend: q.node.backend });
    expect(q.node.dials.map((d) => d.path)).toEqual(['/node']);
  });

  test('through the client: the answer is exactly { ok: true } or { ok: false, reason }', async () => {
    const harness = await startSwarmCore({
      log: quietLog(),
      deps: {
        backendKind: () => 'core',
        nodeUrl: () => LOOPBACK,
        publishReadiness: async () => ({ ok: false, reason: 'node-not-ready', message: 'm' }),
      },
    });
    try {
      const node = scriptedNode();
      const opened = parentOf(harness.client, harness.shell, {
        row: 'readChunk',
        params: { reference: A },
        backend: node.backend,
      });
      const publish = parentOf(harness.client, harness.shell, {
        row: 'publishData',
        params: PUBLISH_DATA,
        backend: node.backend,
      });
      await until(() => opened.id && publish.id, 'the parents');
      const a = harness.core().ready(opened.id, 'reachable');
      const b = harness.core().ready(publish.id, 'publish');
      await until(() => harness.core().reply(a) && harness.core().reply(b), 'the answers');
      expect(harness.core().reply(a)).toEqual({ type: 'response', id: a, result: { ok: true } });
      expect(harness.core().reply(b)).toEqual({
        type: 'response',
        id: b,
        result: { ok: false, reason: 'node-not-ready' },
      });
    } finally {
      await harness.client.stop();
    }
  });
});

describe('the dial', () => {
  test('stopped: no node to dial after the ready answer (its URL went, or the backend has none), undialled', async () => {
    let url = LOOPBACK;
    const shell = makeShell({ nodeUrl: () => url });
    const p = parent(shell, 'readChunk', { reference: A });
    await p.ready('reachable');
    url = null;
    expect(await p.api(calls.chunk(A))).toEqual({ result: { failed: 'stopped' } });
    const none = scriptedNode(undefined, null);
    const q = parent(makeShell(), 'getUploadStatus', { tagUid: 5 }, { node: none });
    expect(await q.api(calls.tag(5))).toEqual({ result: { failed: 'stopped' } });
    expect(p.node.calls()).toHaveLength(0);
    expect(none.dials).toHaveLength(0);
  });

  test('busy: no room in the pool, nothing dialled', async () => {
    const shell = makeShell();
    const p = parent(shell, 'getUploadStatus', { tagUid: 5 });
    const pool = new SwarmIoPool(wholeCharge(65536) - 1);
    expect(await p.api(calls.tag(5), context({ pool }))).toEqual({ result: { failed: 'busy' } });
    expect(p.node.dials).toHaveLength(0);
    expect(pool.held).toBe(0);
  });

  test('one dial per admitted call: a failure is its class, never retried', async () => {
    const failures = [
      [{ cause: { code: 'ECONNREFUSED' } }, 'unreachable'],
      [{ code: 'ECONNRESET' }, 'unreachable'],
      [{ cause: { code: 'ENOTFOUND' } }, 'unreachable'],
      [{ name: 'AbortError' }, 'aborted'],
      [{ cause: { code: 'UND_ERR_SOCKET' } }, 'error'],
    ];
    for (const [shape, failed] of failures) {
      const shell = makeShell();
      const node = scriptedNode(() => {
        throw Object.assign(new Error('x'), shape);
      });
      const p = parent(shell, 'getUploadStatus', { tagUid: 5 }, { node });
      expect(await p.api(calls.tag(5))).toEqual({ result: { failed } });
      expect(node.dials).toHaveLength(1);
      expect(node.dials[0].headersTimeoutMs).toBeNull();
    }
  });

  test('a reply past the bounds the core holds it to fails error: a header value or a reason phrase past 1 KiB', async () => {
    for (const init of [
      { headers: { 'content-type': 'x'.repeat(1025) } },
      { statusText: 'y'.repeat(1025) },
    ]) {
      const shell = makeShell();
      const node = scriptedNode(() => new Response('{}', init));
      const p = parent(shell, 'getUploadStatus', { tagUid: 5 }, { node });
      expect(await p.api(calls.tag(5))).toEqual({ result: { failed: 'error' } });
      expect(shell.log.warn).toHaveBeenCalledWith(
        '[Core] shell.swarm_api: the node answered past the reply bounds',
        { parent: 'getUploadStatus', step: 0 }
      );
    }
  });

  test('a streamed upload is admitted and answered error, never dialled (SWM-5 PR 6)', async () => {
    const shell = makeShell();
    const p = parent(shell, 'publishFiles', {
      files: [{ path: 'a.txt', bytes: data(Buffer.from('a')) }],
    });
    await p.ready('publish');
    await p.api(calls.stamps());
    expect(await p.api(calls.bzzTar({ stream: 2048 }))).toEqual({ result: { failed: 'error' } });
    expect(p.node.calls()).toHaveLength(1);
  });

  test('a value past U+00FF fails the request, as the reference does, undialled', async () => {
    const shell = makeShell();
    const params = { data: text('hello'), contentType: 'text/plain; x=Ā' };
    const p = parent(shell, 'publishData', params);
    await p.ready('publish');
    await p.api(calls.stamps());
    const call = calls.bzzFile({ body: HELLO, contentType: 'text/plain; x=Ā' });
    expect(await p.api(call)).toEqual({ result: { failed: 'error' } });
    expect(p.node.calls()).toHaveLength(1);
  });
});

describe("a remote node's header bytes (0015's amendment, #1338)", () => {
  const LATIN = 'text/plain; charset=café';

  test('a remote node: a value in U+0080 to U+00FF is refused header before the dial, and the parent refuses the rest', async () => {
    const shell = makeShell({ nodeUrl: () => 'http://node.example:1633' });
    const node = scriptedNode(undefined, 'http://node.example:1633');
    const p = parent(shell, 'publishData', { data: text('hello'), contentType: LATIN }, { node });
    await p.ready('publish');
    await p.api(calls.stamps());
    const upload = calls.bzzFile({ body: HELLO, contentType: LATIN });
    expect(await p.api(upload)).toEqual({ rule: 'header' });
    expect(node.calls()).toHaveLength(1);
    expect(shell.log.warn).toHaveBeenCalledWith('[Core] shell.swarm_api refused', {
      parent: 'publishData',
      step: 1,
      rule: 'header',
    });
    // An ASCII value goes to a remote node as it is.
    const ascii = parent(shell, 'publishData', PUBLISH_DATA, { node });
    await ascii.ready('publish');
    await ascii.api(calls.stamps());
    expect((await ascii.api(calls.bzzFile({ body: HELLO }))).rule).toBeUndefined();
    expect(node.calls()).toHaveLength(3);
  });

  test('loopback: the same value is sent, each character as one byte', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.rawHeaders);
      req.resume();
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('{"reference":"x"}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockRegistry.url = `http://127.0.0.1:${server.address().port}`;
    try {
      const shell = makeShell({ nodeUrl: () => mockRegistry.url });
      const backend = antBackend();
      const p = parent(
        shell,
        'publishData',
        { data: text('hello'), contentType: LATIN },
        { node: { backend } }
      );
      await shell.ready({ for: p.id, check: 'publish' }, context());
      await p.api(calls.stamps());
      const out = await p.api(calls.bzzFile({ body: HELLO, contentType: LATIN }));
      expect(parsed(out.result).status).toBe(201);
      // Node's parser reads header bytes as latin1: one byte, U+00E9.
      const headers = seen[seen.length - 1];
      expect(headers[headers.indexOf('content-type') + 1]).toBe(LATIN);
    } finally {
      mockRegistry.url = null;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
