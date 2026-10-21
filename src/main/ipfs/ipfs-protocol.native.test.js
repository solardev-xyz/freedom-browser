/**
 * `ipfs:` in native mode — the real handler, ipfs-manager and
 * `FreedomIpfsNativeNode` (its `NativeGatewayController`: the pull loop,
 * the cancel and the 30 s header deadline) against a fake freedom-ipfs add-on
 * that streams chunks.
 *
 * Roadmap 4.7, design 0006 ("Tests first"). The native add-on is replaced by
 * `test/helpers/fake-freedom-ipfs-addon.js` and its event worker by an
 * in-process dispatcher; everything from the `ipfs:` handler down to the
 * add-on calls is the production code, but the core's planner
 * (`test/helpers/fake-dweb-core.js`, which plans as fc-dweb does).
 * External-gateway mode is in `ipfs-protocol.http.test.js`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const timers = require('timers');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { createFakeFreedomIpfsAddon } = require('../../../test/helpers/fake-freedom-ipfs-addon');
const { createFakeDwebDriver, BODY_IDLE_MS } = require('../../../test/helpers/fake-dweb-core');
const {
  nextTurn,
  readAll,
  readUntilError,
  waitFor,
} = require('../../../test/helpers/fake-http-node');

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CONTENT = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
// What NativeGatewayController reads per call (BUFFER_SIZE).
const READ_BYTES = 64 * 1024;
const NAVIGATION_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
  'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const FIXTURE = 'Hello from IPFS Gateway Checker\n';

let dataDir;
let fake;
let stack;

// ipfs-manager in bundled mode, the real native node wrapper on top of the
// fake add-on, and the protocol module, all in one module registry.
async function loadNativeStack() {
  fake = createFakeFreedomIpfsAddon();
  const driver = createFakeDwebDriver();
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const { mod: manager } = loadMainModule(require.resolve('../ipfs-manager'), {
    extraMocks: {
      // The event worker, in-process: it delivers the fake add-on's events and
      // answers the stop handshake (`stopped`, then exit) like the real one.
      worker_threads: () => {
        const { EventEmitter } = require('events');
        class FakeDispatcher extends EventEmitter {
          constructor() {
            super();
            fake.attachDispatcher(this);
          }
          postMessage(message) {
            if (message?.type !== 'stop') return;
            timers.setImmediate(() => {
              this.emit('message', { type: 'stopped' });
              this.emit('exit', 0);
            });
          }
          terminate() {
            return Promise.resolve(0);
          }
        }
        return { Worker: jest.fn(() => new FakeDispatcher()) };
      },
      [require.resolve('./freedom-ipfs-native-binding')]: () => ({
        loadNativeBinding: () => fake.addon,
        isNativeBindingAvailable: () => true,
      }),
      [require.resolve('../logger')]: () => log,
      [require.resolve('../service-registry')]: () => ({
        MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', DISABLED: 'disabled', NONE: 'none' },
        updateService: jest.fn(),
        setStatusMessage: jest.fn(),
        setErrorState: jest.fn(),
        clearErrorState: jest.fn(),
        clearService: jest.fn(),
      }),
      [require.resolve('../profile-resolver')]: () => ({ getActiveProfile: () => null }),
      [require.resolve('../profile-paths')]: () => ({ getIpfsDataDir: () => dataDir }),
      [require.resolve('../core/naming')]: () => ({ namingDriver: () => driver }),
    },
  });
  const { registerIpfsProtocol } = require('./ipfs-protocol');
  const { ATTEMPT_TIMEOUT_MS } = require('./freedom-ipfs-native-node');
  const handlers = new Map();
  registerIpfsProtocol({ protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) } });
  await manager.startIpfs();
  return {
    manager,
    log,
    ATTEMPT_TIMEOUT_MS,
    ipfs: handlers.get('ipfs'),
    stats: () => JSON.parse(manager.getNativeDiagnostics().nativeGatewayStats),
  };
}

const ipfs = (urlPath, init) => stack.ipfs(new Request(`ipfs://${CID}${urlPath}`, init));

function useFakeClock() {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
}

// An endless body: every read pulls a fresh 64 KiB chunk from the add-on.
function endlessBody(request) {
  request.source = () => Buffer.alloc(READ_BYTES, 0x61);
  fake.respond(request, { headers: { 'content-type': 'application/octet-stream' } });
}

// The add-on, as a development build selects it (FREEDOM_IPFS_BACKEND=addon;
// freedom-core design 0007, Rollback): freedom-ipfsd is the default.
const backendBefore = process.env.FREEDOM_IPFS_BACKEND;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-native-protocol-'));
  process.env.FREEDOM_IPFS_BACKEND = 'addon';
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (backendBefore === undefined) delete process.env.FREEDOM_IPFS_BACKEND;
  else process.env.FREEDOM_IPFS_BACKEND = backendBefore;
});

beforeEach(async () => {
  stack = await loadNativeStack();
});

afterEach(async () => {
  jest.useRealTimers();
  await stack.manager.stopIpfs();
});

describe('ipfs: native mode streaming', () => {
  test('streams the add-on chunks through, Range in and 206 with Content-Range out', async () => {
    fake.onRequest((request) =>
      fake.serve(request, {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 100-199/1000',
          'content-length': 100,
        },
        body: CONTENT.subarray(100, 200),
        chunks: 3,
      })
    );

    const res = await ipfs('/video.mp4', { headers: { Range: 'bytes=100-199' } });
    const [request] = fake.requests;

    expect(request.json).toMatchObject({
      method: 'GET',
      path: `/ipfs/${CID}/video.mp4`,
      top_level_path: `/ipfs/${CID}/video.mp4`,
    });
    expect(request.headers.range).toBe('bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(await readAll(res.body)).toEqual(CONTENT.subarray(100, 200));
    // A body read to its end frees the native handle, without a cancel.
    await waitFor(() => request.freed, { what: 'the handle to be freed' });
    expect(fake.addon.gatewayRequestFree).toHaveBeenCalledTimes(1);
    expect(fake.addon.gatewayRequestCancel).not.toHaveBeenCalled();
    expect(stack.stats().active_native_handles).toBe(0);
  });

  // Design 0006 deviation `native-page-state`: today the native node's
  // answers pass unstripped; now they lose their page state like Ant's and
  // the external gateway's (O-12).
  test("strips Set-Cookie, Set-Cookie2 and Service-Worker-Allowed from the node's answer", async () => {
    fake.onRequest((request) =>
      fake.serve(request, {
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'track=1',
          'set-cookie2': 'legacy=1',
          'service-worker-allowed': '/',
          'cache-control': 'public, max-age=29030400, immutable',
        },
        body: 'page',
      })
    );

    const res = await ipfs('/');

    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('set-cookie2')).toBeNull();
    expect(res.headers.get('service-worker-allowed')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=29030400, immutable');
    expect((await readAll(res.body)).toString()).toBe('page');
  });

  test('HEAD gets the headers and no body', async () => {
    fake.onRequest((request) =>
      fake.respond(request, { headers: { 'content-type': 'video/mp4', 'content-length': 1000 } })
    );

    const res = await ipfs('/video.mp4', { method: 'HEAD' });

    expect(fake.requests[0].json.method).toBe('HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-length')).toBe('1000');
    await waitFor(() => fake.requests[0].freed, { what: 'the handle to be freed' });
  });

  test('pulls from the add-on only while the stream wants more (desiredSize)', async () => {
    fake.onRequest(endlessBody);

    const res = await ipfs('/big.bin');
    const [request] = fake.requests;
    await nextTurn(20);
    // One read ahead of a reader that has not read anything yet.
    expect(request.bytesRead).toBe(READ_BYTES);

    // Readiness events while the stream is full pull nothing more.
    for (let i = 0; i < 5; i++) fake.emit(request, fake.addon.constants.EVENT_BODY_READY);
    await nextTurn(20);
    expect(request.bytesRead).toBe(READ_BYTES);

    const reader = res.body.getReader();
    let consumed = 0;
    for (let i = 0; i < 8; i++) {
      consumed += (await reader.read()).value.byteLength;
      await nextTurn();
      // Never more than one 64 KiB read ahead of the reader.
      expect(request.bytesRead - consumed).toBeLessThanOrEqual(READ_BYTES);
      expect(request.bytesRead).toBeGreaterThanOrEqual(consumed);
    }
    await reader.cancel();
  });

  test('an add-on failure before the headers is a 502 with its message', async () => {
    fake.onRequest((request) => fake.failRequest(request, 'block not found'));

    const res = await ipfs('/missing');

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'block not found' });
    await waitFor(() => fake.requests[0].freed, { what: 'the handle to be freed' });
  });

  test('a body that fails mid-way errors the stream: truncated, not a short success', async () => {
    fake.onRequest((request) => {
      fake.respond(request, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': 100_000 },
      });
      fake.push(request, Buffer.alloc(10_000, 0x61));
      timers.setTimeout(() => fake.failBody(request), 20);
    });

    const res = await ipfs('/file.bin');
    const { bytes, error } = await readUntilError(res.body.getReader());

    expect(bytes).toBe(10_000);
    expect(error?.message).toBe('freedom-ipfs native read failed');
    await waitFor(() => fake.requests[0].freed, { what: 'the handle to be freed' });
  });
});

describe('ipfs: native mode cancel', () => {
  test('aborting the request mid-body cancels the native request, errors the stream and frees it', async () => {
    fake.onRequest(endlessBody);
    const controller = new AbortController();

    const res = await ipfs('/big.bin', { signal: controller.signal });
    const [request] = fake.requests;
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    const { error } = await readUntilError(reader);

    expect(fake.addon.gatewayRequestCancel).toHaveBeenCalledWith('1', request.handle);
    expect(error?.message).toBe('freedom-ipfs native request cancelled');
    await waitFor(() => request.freed, { what: 'the handle to be freed' });
    expect(stack.stats().active_native_handles).toBe(0);
  });

  // A consumer cancel closes the stream, so no read would ever see the
  // add-on's READ_CANCELLED: the stream's cancel frees the handle itself.
  // An abort on Chromium's side cancels the handler's body stream this way
  // (the bzz: equivalent is shown in __tests__/integration/dweb-range-electron.test.js).
  test('cancelling the body cancels the native request and frees its handle', async () => {
    fake.onRequest(endlessBody);

    const res = await ipfs('/big.bin');
    const [request] = fake.requests;
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    await waitFor(() => request.freed, { what: 'the handle to be freed' });

    expect(fake.addon.gatewayRequestCancel).toHaveBeenCalledWith('1', request.handle);
    expect(fake.addon.gatewayRequestFree).toHaveBeenCalledWith('1', request.handle);
    const cancel = fake.addon.gatewayRequestCancel.mock.invocationCallOrder[0];
    const free = fake.addon.gatewayRequestFree.mock.invocationCallOrder[0];
    expect(cancel).toBeLessThan(free);
    expect(request.reads).toBe(2); // nothing read after the cancel
    expect(stack.stats().active_native_handles).toBe(0);
  });

  // An abort mid-body ends a paused body too: nothing would read its
  // READ_CANCELLED while the consumer pulls nothing.
  test('aborting a paused body cancels and frees it at once', async () => {
    fake.onRequest(endlessBody);
    const controller = new AbortController();

    const res = await ipfs('/big.bin', { signal: controller.signal });
    const [request] = fake.requests;
    const reader = res.body.getReader();
    await reader.read();
    // The consumer stops pulling; the stream fills to its high-water mark.
    await nextTurn(20);
    controller.abort();
    await waitFor(() => request.freed, { what: 'the handle to be freed' });

    expect(fake.addon.gatewayRequestCancel).toHaveBeenCalledWith('1', request.handle);
    expect(stack.stats().active_native_handles).toBe(0);
    const { error } = await readUntilError(reader);
    expect(error?.message).toBe('freedom-ipfs native request cancelled');
  });

  // A request aborted before it reaches the node starts no native request at
  // all, and nothing stays registered. Since design 0006 it isn't planned
  // either: the abort cancels `dweb.open`, and the answer goes to nobody.
  test('a request aborted before it starts starts nothing and leaves nothing registered', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await ipfs('/x', { signal: controller.signal });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'Cancelled' });
    expect(fake.addon.gatewayRequestStart).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
    expect(stack.stats().active_native_handles).toBe(0);
  });

  // An abort before the headers settles the request at once and frees its
  // handle; it no longer waits for the 30 s deadline.
  test('aborting before the headers cancels, settles and frees at once', async () => {
    useFakeClock();
    const controller = new AbortController();

    const pending = ipfs('/x', { signal: controller.signal });
    await waitFor(() => fake.requests.length === 1, { what: 'the native request' });
    const [request] = fake.requests;
    controller.abort();
    const res = await pending;

    expect(fake.addon.gatewayRequestCancel).toHaveBeenCalledWith('1', request.handle);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      code: 502,
      message: 'freedom-ipfs native request aborted',
    });
    expect(request.freed).toBe(true);
    expect(stack.stats().active_native_handles).toBe(0);
    // The deadline has nothing left to do.
    await jest.advanceTimersByTimeAsync(stack.ATTEMPT_TIMEOUT_MS);
    expect(fake.addon.gatewayRequestFree).toHaveBeenCalledTimes(1);
  });
});

describe('ipfs: native mode 30 s header deadline', () => {
  test('a request with no headers after exactly 30 s is cancelled, freed and answered 502', async () => {
    useFakeClock();
    let settled = false;

    const pending = ipfs('/x').then((res) => {
      settled = true;
      return res;
    });
    await waitFor(() => fake.requests.length === 1, { what: 'the native request' });
    await jest.advanceTimersByTimeAsync(stack.ATTEMPT_TIMEOUT_MS - 1);
    await nextTurn(10);
    expect(settled).toBe(false);
    expect(fake.addon.gatewayRequestCancel).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const res = await pending;

    expect(stack.ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'freedom-ipfs native request timeout' });
    const cancel = fake.addon.gatewayRequestCancel.mock.invocationCallOrder[0];
    const free = fake.addon.gatewayRequestFree.mock.invocationCallOrder[0];
    expect(cancel).toBeLessThan(free);
  });

  // Design 0006 deviation `body-idle`: the body's own clock runs only while a
  // read is pending, so a reader that has paused is never cut off.
  test('stops applying once the headers arrive: a paused reader is never timed out', async () => {
    useFakeClock();
    fake.onRequest((request) => {
      fake.respond(request, { headers: { 'content-type': 'application/octet-stream' } });
      fake.push(request, 'first ');
    });

    const res = await ipfs('/x');
    const reader = res.body.getReader();
    expect(Buffer.from((await reader.read()).value).toString()).toBe('first ');

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    await nextTurn(10);
    expect(fake.addon.gatewayRequestCancel).not.toHaveBeenCalled();

    const [request] = fake.requests;
    fake.push(request, 'second');
    fake.end(request);
    expect((await readAll(reader)).toString()).toBe('second');
  });

  // Design 0006 deviation `body-idle`: a read left pending for 60 s fails the
  // body as truncated, and the native request is cancelled and freed.
  test('a read left pending for 60 s fails the body and frees the native request', async () => {
    useFakeClock();
    fake.onRequest((request) => {
      fake.respond(request, { headers: { 'content-type': 'application/octet-stream' } });
      fake.push(request, 'first ');
    });

    const res = await ipfs('/x');
    const reader = res.body.getReader();
    await reader.read();
    const stalled = readUntilError(reader);
    await nextTurn(10);
    await jest.advanceTimersByTimeAsync(BODY_IDLE_MS - 1);
    expect(fake.addon.gatewayRequestCancel).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const { error } = await stalled;
    expect(error?.name).toBe('BodyIdleError');
    const [request] = fake.requests;
    await waitFor(() => request.freed, { what: 'the handle to be freed' });
    expect(fake.addon.gatewayRequestCancel).toHaveBeenCalledWith('1', request.handle);
    expect(stack.stats().active_native_handles).toBe(0);
  });
});

describe('ipfs: native node not available', () => {
  test('a stopped node answers 503 at once, without starting a native request', async () => {
    await stack.manager.stopIpfs();

    const res = await ipfs('/index.html');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 503, message: 'freedom-ipfs node is not running' });
    expect(fake.addon.gatewayRequestStart).not.toHaveBeenCalled();
  });

  test('a node whose event dispatcher dies fails its in-flight body and answers 503 after', async () => {
    fake.onRequest(endlessBody);
    const res = await ipfs('/big.bin');
    const reader = res.body.getReader();
    await reader.read();

    fake.dispatcher.emit('exit', 1);
    const { error } = await readUntilError(reader);
    const next = await ipfs('/index.html');

    expect(error?.message).toBe('Native event dispatcher exited with code 1');
    expect(next.status).toBe(503);
    expect(await next.json()).toEqual({ code: 503, message: 'freedom-ipfs node is not running' });
    expect(fake.addon.gatewayRequestStart).toHaveBeenCalledTimes(1);
  });
});

// `small_text` (dweb/response-operations.js): a bare UnixFS file has no name to take a MIME
// type from, so a small UTF-8 `application/octet-stream` document load is
// relabelled `text/plain` + `nosniff` (rendered, never as HTML). Every other
// response streams through untouched, and a response the rule buffered but
// then declined is replayed byte for byte.
describe('ipfs: native mode small-text navigation rule', () => {
  // Serve `body` with the given response headers (`null` deletes a default)
  // to a request with `accept` / `method`, and read what the page gets.
  async function navigate({
    body = FIXTURE,
    status = 200,
    headers = {},
    method = 'GET',
    accept = NAVIGATION_ACCEPT,
    chunks = 1,
  } = {}) {
    const merged = {
      'content-type': 'application/octet-stream',
      'content-length': Buffer.byteLength(body),
      ...headers,
    };
    for (const [name, value] of Object.entries(merged)) if (value === null) delete merged[name];
    fake.onRequest((request) => fake.serve(request, { status, headers: merged, body, chunks }));
    const res = await ipfs('/', { method, headers: accept === null ? {} : { Accept: accept } });
    return { res, upstream: merged, bytes: res.body ? await readAll(res.body) : null };
  }

  test.each([
    ['the gateway checker fixture', {}],
    ['HTML-looking text, still only text', { body: '<script>alert(1)</script>' }],
    ['tab, LF, FF and CR', { body: 'a\tb\nc\fd\re' }],
    [
      'multi-byte UTF-8',
      { body: `caf${String.fromCharCode(0xe9)} ${String.fromCodePoint(0x1f680)}\n` },
    ],
    ['exactly 4096 bytes', { body: 'a'.repeat(4096) }],
    ['a body split into 1-byte chunks', { chunks: Buffer.byteLength(FIXTURE) }],
    [
      'octet-stream with a parameter',
      { headers: { 'content-type': 'application/octet-stream; charset=binary' } },
    ],
    ['an Accept whose first type is text/html in any case', { accept: ' TEXT/HTML ,*/*;q=0.8' }],
  ])('relabels %s as text/plain + nosniff, bytes intact', async (_label, options) => {
    const { res, bytes } = await navigate(options);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(bytes).toEqual(Buffer.from(options.body ?? FIXTURE));
  });

  test.each([
    // Not a navigation (Chromium's subresource Accepts), or not the first type.
    ['a q-valued text/html (text/html;q=0.9 first)', { accept: 'text/html;q=0.9,*/*;q=0.8' }],
    ['text/html that is not the first type', { accept: 'application/xhtml+xml,text/html' }],
    ['a script/fetch Accept', { accept: '*/*' }],
    ['no Accept at all', { accept: null }],
    ['HEAD', { method: 'HEAD' }],
    // Not a whole small 200.
    [
      'a 206 with its Content-Range',
      { status: 206, headers: { 'content-range': 'bytes 0-31/64' } },
    ],
    ['a 206 without a Content-Range', { status: 206 }],
    ['a 404', { status: 404 }],
    ['a 200 with a Content-Range', { headers: { 'content-range': 'bytes 0-31/32' } }],
    ['no Content-Length', { headers: { 'content-length': null } }],
    ['Content-Length 0', { body: '' }],
    ['a non-integer Content-Length', { headers: { 'content-length': '31.5' } }],
    ['4097 bytes', { body: 'a'.repeat(4097) }],
    // Explicit metadata wins.
    ['a Content-Disposition', { headers: { 'content-disposition': 'attachment' } }],
    ['an X-Content-Type-Options', { headers: { 'x-content-type-options': 'nosniff' } }],
    ['text/plain already', { headers: { 'content-type': 'text/plain' } }],
    ['no Content-Type', { headers: { 'content-type': null } }],
    // Buffered, then declined: not text, or not the length it claimed.
    ['a NUL byte', { body: Buffer.from([0x61, 0x00, 0x62]) }],
    ['a DEL byte', { body: Buffer.from([0x61, 0x7f, 0x62]) }],
    ['an ESC byte', { body: Buffer.from([0x61, 0x1b, 0x62]) }],
    ['invalid UTF-8', { body: Buffer.from([0xff, 0xfe, 0x41]) }],
    ['a truncated UTF-8 sequence', { body: Buffer.from([0x41, 0xc3]) }],
    [
      'an understated length (5000 bytes sent)',
      { body: 'a'.repeat(5000), headers: { 'content-length': 32 } },
    ],
    ['an overstated length', { headers: { 'content-length': 100 } }],
  ])('leaves %s as it was, bytes replayed intact', async (_label, options) => {
    const { res, upstream, bytes } = await navigate(options);

    expect(res.status).toBe(options.status ?? 200);
    expect(res.headers.get('content-type')).toBe(upstream['content-type'] ?? null);
    expect(res.headers.get('x-content-type-options')).toBe(
      upstream['x-content-type-options'] ?? null
    );
    if (options.method === 'HEAD') {
      expect(bytes).toBeNull();
    } else {
      expect(bytes).toEqual(Buffer.from(options.body ?? FIXTURE));
    }
  });
});
