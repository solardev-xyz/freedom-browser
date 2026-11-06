/**
 * `{ verify }` plans through the real handler (freedom-core design 0009,
 * `dweb.verify` and Main's side): main's copy of the planning makes the
 * verify plan, a scripted verifier answers `dweb.verify` as the client does
 * (`{ result, body }`, or a failure), and the page gets the head, its
 * verified body, or the error plan as JSON or as the error page.
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../logger', () => mockLog);

let mockDriver = null;
jest.mock('../core/naming', () => ({ namingDriver: () => mockDriver }));
let mockVerifier = null;
jest.mock('../core/dweb-verify', () => ({ dwebVerifier: () => mockVerifier }));
let mockAdmission = null;
jest.mock('./fetch-admission', () => {
  const actual = jest.requireActual('./fetch-admission');
  return {
    ...actual,
    acquireDwebFetch: (request) => mockAdmission.acquire(request),
    fenceDwebSession: (partition) => mockAdmission.fence(partition),
  };
});

const { handleDwebRequest } = require('./dweb-handler');
const { createFetchAdmission } = require('./fetch-admission');
const { CoreError } = require('../core/core-client');
const { createFakeDwebDriver } = require('../../../test/helpers/fake-dweb-core');
const { runWithPrivateLogContext } = require('../private/private-log-context');
const { verificationFailures, _resetVerificationFailures } = require('./verify-failures');

const HASH = 'c0ffee'.repeat(10) + 'beef';
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const NAVIGATION = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const MEMORY = 'This content needs more memory to verify than one request may use';

/** A body as the client hands it over: pulled on demand, cancellable. */
function streamOf(chunks, { fail = null } = {}) {
  const queue = chunks.map((c) => Buffer.from(c));
  const record = { cancelled: false };
  const body = new ReadableStream(
    {
      pull(controller) {
        if (queue.length) controller.enqueue(new Uint8Array(queue.shift()));
        else if (fail) controller.error(fail);
        else controller.close();
      },
      cancel() {
        record.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return Object.assign(body, { record });
}

/**
 * A verifier whose `dweb.verify` answers `answer(params)`: a `{ result,
 * body }`, or a failure to throw. Records each call, and each context's
 * close.
 */
function scriptedVerifier(answer) {
  const calls = [];
  return {
    calls,
    send: jest.fn((gen, params, capture, signal) => {
      const call = { gen, params, capture, signal, closed: 0 };
      calls.push(call);
      const head = (async () => {
        await null;
        if (signal?.aborted) throw new CoreError('cancelled', 'Cancelled');
        const out = await answer(params, signal);
        if (out instanceof Error) throw out;
        return out;
      })();
      return { head, close: () => (call.closed += 1) };
    }),
  };
}

const head = (status, headers, { body = true, content = 'verified', name = null } = {}) => ({
  status,
  headers,
  body,
  trust: { name, content },
});

function backend(kind = 'ant', extra = {}) {
  return {
    ref:
      kind === 'ant'
        ? { ant: 'external', up: true, verify: true }
        : { ipfs: 'gateway', up: true, verify: true },
    url: 'http://127.0.0.1:1633',
    request: jest.fn(),
    release: jest.fn(),
    ...extra,
  };
}

function handle(url, { init = {}, use = backend(), partition = null, onTrust } = {}) {
  return handleDwebRequest(new Request(url, init), {
    backend: use,
    partition,
    tag: '[dweb]',
    onTrust,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDriver = createFakeDwebDriver();
  mockAdmission = createFetchAdmission();
  mockVerifier = null;
  _resetVerificationFailures();
});

describe('a head and its verified body', () => {
  test("GET: the core's head, its trust, and the body read from the stream", async () => {
    const body = streamOf(['<p>hel', 'lo</p>']);
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [
        ['content-type', 'text/html'],
        ['content-length', '12'],
        ['etag', `"${HASH}"`],
        ['set-cookie', 'track=1'],
      ]),
      body,
    }));
    const use = backend();
    const onTrust = jest.fn();
    const res = await handle(`bzz://${HASH}/index.html?x=1`, { use, onTrust });

    const [call] = mockVerifier.calls;
    expect(call.params).toEqual({
      plan: {
        verify: expect.objectContaining({
          node: 'ant',
          root: { swarm: HASH },
          path: '/index.html',
          query: '?x=1',
        }),
      },
      method: 'GET',
      partition: null,
      private: false,
      deadline_ms: 360_000,
    });
    // The pieces' context: this request's backend, plan, signal and session.
    expect(call.capture.backend).toBe(use);
    expect(call.capture.plan).toBe(call.params.plan);
    expect(call.capture.stop).toBeInstanceOf(AbortSignal);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('12');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(onTrust).toHaveBeenCalledWith({ name: null, content: 'verified' });
    expect(mockAdmission.stats().active).toBe(1);
    expect(call.closed).toBe(0);

    expect(await res.text()).toBe('<p>hello</p>');
    // The body's end ends the request: its context, slot and lease.
    expect(call.closed).toBe(1);
    expect(mockAdmission.stats().active).toBe(0);
    expect(use.release).toHaveBeenCalledTimes(1);
    expect(use.request).not.toHaveBeenCalled();
  });

  test('HEAD: the head with no body ends the request at once', async () => {
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [['content-length', '5000']], { body: false }),
      body: null,
    }));
    const use = backend();
    const res = await handle(`bzz://${HASH}/style.css`, { init: { method: 'HEAD' }, use });
    expect(mockVerifier.calls[0].params.method).toBe('HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(mockVerifier.calls[0].closed).toBe(1);
    expect(use.release).toHaveBeenCalledTimes(1);
  });

  test('an IPFS plan says `car` as the backend captured it, false until the probe sets it', async () => {
    mockVerifier = scriptedVerifier(() => ({ result: head(200, [], { body: false }), body: null }));
    await handle(`ipfs://${CID}/`, { use: backend('ipfs') });
    await handle(`ipfs://${CID}/`, { use: backend('ipfs', { car: true }) });
    expect(mockVerifier.calls.map((c) => c.params.car)).toEqual([false, true]);
  });

  test("a private window's request names its partition and is private", async () => {
    mockVerifier = scriptedVerifier(() => ({ result: head(200, [], { body: false }), body: null }));
    await handle(`bzz://${HASH}/`, { partition: 'private-1' });
    await runWithPrivateLogContext(true, () => handle(`bzz://${HASH}/`));
    expect(mockVerifier.calls.map((c) => [c.params.partition, c.params.private])).toEqual([
      ['private-1', true],
      [null, true],
    ]);
  });

  test("a bundled node's 404 the core reproduces is a head: content, never the error page", async () => {
    const json = '{"code":404,"message":"Not Found"}';
    mockVerifier = scriptedVerifier(() => ({
      result: head(404, [['content-type', 'application/json']]),
      body: streamOf([json]),
    }));
    const res = await handle(`bzz://${HASH}/missing.html`, { init: { headers: NAVIGATION } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(json);
  });

  test("Ant's directory redirect, written in Ant's URL space, is rewritten and its body dropped", async () => {
    const body = streamOf(['<a>Permanent Redirect</a>']);
    mockVerifier = scriptedVerifier(() => ({
      result: head(308, [
        ['location', `/bzz/${HASH}/docs/?state=1`],
        ['content-length', '25'],
      ]),
      body,
    }));
    const res = await handle(`bzz://${HASH}/docs?state=1`);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('./docs/?state=1');
    expect(res.body).toBeNull();
    expect(body.record.cancelled).toBe(true);
    expect(mockVerifier.calls[0].closed).toBe(1);
  });

  test('an IPFS head keeps its Content-Length (no strip_decoded_encoding) and gets small_text', async () => {
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [
        ['content-type', 'application/octet-stream'],
        ['content-length', '6'],
        ['content-encoding', 'identity'],
      ]),
      body: streamOf(['hello\n']),
    }));
    const res = await handle(`ipfs://${CID}/readme`, {
      use: backend('ipfs'),
      init: { headers: NAVIGATION },
    });
    expect(mockVerifier.calls[0].params.plan.verify.response).toEqual([
      'strip_page_state',
      'small_text',
    ]);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-length')).toBe('6');
    expect(res.headers.get('content-encoding')).toBe('identity');
    expect(await res.text()).toBe('hello\n');
  });

  test("a head that says `latest_asserted` keeps it; the name's trust is the plan's", async () => {
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [], { body: false, content: 'latest_asserted' }),
      body: null,
    }));
    const onTrust = jest.fn();
    const res = await handle(`bzz://${HASH}/`, { onTrust });
    expect(res.status).toBe(200);
    expect(onTrust).toHaveBeenCalledWith({ name: null, content: 'latest_asserted' });
  });

  test("a head whose small-text sniff fails is main's answer, with no label", async () => {
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [
        ['content-type', 'application/octet-stream'],
        ['content-length', '6'],
      ]),
      body: streamOf([], { fail: new Error('reset') }),
    }));
    const onTrust = jest.fn();
    const res = await handle(`ipfs://${CID}/readme`, {
      use: backend('ipfs'),
      init: { headers: NAVIGATION },
      onTrust,
    });
    expect(res.status).toBe(502);
    expect(onTrust).not.toHaveBeenCalled();
  });

  test('an error plan from dweb.verify carries no label', async () => {
    mockVerifier = scriptedVerifier(() => ({
      result: {
        error: { status: 404, code: 404, message: 'Not found on the external Swarm node' },
      },
      body: null,
    }));
    const onTrust = jest.fn();
    const res = await handle(`bzz://${HASH}/app.js`, { onTrust });
    expect(res.status).toBe(404);
    expect(onTrust).not.toHaveBeenCalled();
  });
});

describe('after the head', () => {
  test("the core's abort truncates the body, logged by its code only", async () => {
    const abort = new CoreError('verification_failed', 'Swarm content verification failed');
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [['content-length', '8192']]),
      body: streamOf(['first bytes'], { fail: abort }),
    }));
    const use = backend();
    const res = await runWithPrivateLogContext(true, () =>
      handle(`bzz://${HASH}/secret.mp4`, { use })
    );
    const reader = res.body.getReader();
    expect(Buffer.from((await reader.read()).value).toString()).toBe('first bytes');
    await expect(reader.read()).rejects.toBe(abort);
    expect(use.release).toHaveBeenCalledTimes(1);
    expect(mockVerifier.calls[0].closed).toBe(1);
    const warned = mockLog.warn.mock.calls.map(([line]) => line);
    expect(warned).toEqual([
      expect.stringContaining('verified body truncated (verification_failed, ant)'),
    ]);
    expect(warned[0]).not.toContain(HASH);
    expect(warned[0]).not.toContain('secret');
  });

  test("the page's cancel of the body ends the request", async () => {
    const body = streamOf(['a', 'b', 'c']);
    mockVerifier = scriptedVerifier(() => ({ result: head(200, []), body }));
    const use = backend();
    const res = await handle(`bzz://${HASH}/`, { use });
    await res.body.cancel();
    expect(body.record.cancelled).toBe(true);
    expect(mockVerifier.calls[0].closed).toBe(1);
    expect(use.release).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  test("the session's close stops a body being read", async () => {
    const body = streamOf(['a', 'b']);
    mockVerifier = scriptedVerifier(() => ({ result: head(200, []), body }));
    const use = backend();
    const res = await handle(`bzz://${HASH}/`, { use, partition: 'private-2' });
    mockAdmission.closeSession('private-2');
    await expect(res.text()).rejects.toThrow('The session closed');
    expect(body.record.cancelled).toBe(true);
    expect(use.release).toHaveBeenCalledTimes(1);
  });
});

describe('error plans and failures before the head', () => {
  const errorPlan = (status, message) => ({
    result: { error: { status, code: status, message } },
    body: null,
  });

  test.each([
    [404, 'Not found on the external Swarm node'],
    [502, 'Swarm content verification failed'],
    [502, "This content can't be verified with the external Swarm node"],
    [502, MEMORY],
    [500, 'The external Swarm node answered 500'],
    [503, 'Too many requests'],
    [504, 'Deadline passed'],
  ])("a subresource gets 0006's JSON body: %i %s", async (status, message) => {
    mockVerifier = scriptedVerifier(() => errorPlan(status, message));
    const use = backend();
    const res = await handle(`bzz://${HASH}/app.js`, { use });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code: status, message });
    expect(mockVerifier.calls[0].closed).toBe(1);
    expect(use.release).toHaveBeenCalledTimes(1);
    expect(mockAdmission.stats().active).toBe(0);
  });

  test('a navigation gets the error page, in plain words: MEMORY', async () => {
    mockVerifier = scriptedVerifier(() => errorPlan(502, MEMORY));
    const url = `bzz://${HASH}/big/`;
    const res = await handle(url, { init: { headers: NAVIGATION } });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('needs more memory than Freedom lets one request use');
    expect(html).toContain('This is Freedom&#39;s limit, not a fault of your node or the content.');
    expect(html).toContain(`502: ${MEMORY}`);
    expect(html).toContain(`<a class="retry" href="${url}">Try again</a>`);
    expect(html).not.toContain('<script');
  });

  test('a navigation that is a HEAD, or a fetch with another Accept, keeps the JSON body', async () => {
    mockVerifier = scriptedVerifier(() => errorPlan(502, MEMORY));
    const headRes = await handle(`bzz://${HASH}/`, {
      init: { method: 'HEAD', headers: NAVIGATION },
    });
    expect(headRes.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const image = await handle(`bzz://${HASH}/`, { init: { headers: { Accept: 'image/*' } } });
    expect(await image.json()).toEqual({ code: 502, message: MEMORY });
  });

  test.each([
    ['busy', 503, 'Too many requests'],
    ['cancelled', 502, 'Cancelled'],
    ['core_unavailable', 503, 'The core is unavailable'],
  ])('a `%s` reply is %i', async (code, status, message) => {
    mockVerifier = scriptedVerifier(() => new CoreError(code, 'x'));
    const res = await handle(`bzz://${HASH}/`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code: status, message });
    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockAdmission.stats().active).toBe(0);
  });

  test('`invalid_argument` is a 502 and a logged core fault', async () => {
    mockVerifier = scriptedVerifier(() => new CoreError('invalid_argument', 'Invalid'));
    const res = await handle(`bzz://${HASH}/`);
    expect(res.status).toBe(502);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('dweb.verify failed (invalid_argument)'),
      { tag: '[dweb]' }
    );
  });

  test.each([
    ['an unknown member', { ...head(200, []), extra: 1 }],
    ['an error plan and a head at once', { ...head(200, []), error: { status: 502 } }],
    ['another trust', head(200, [], { content: 'unverified' })],
    ['a name trust the plan lacks', head(200, [], { name: 'verified' })],
    ['a status outside 200-599', head(101, [])],
    ['a header that is no pair', head(200, [['content-type']])],
    ['an error plan with another code', { error: { status: 404, code: 502, message: 'x' } }],
    ['an error plan with a 3xx', { error: { status: 307, code: 307, message: 'x' } }],
  ])("%s is the core's fault: a 502, logged", async (_what, result) => {
    const body = result.body === true ? streamOf(['x']) : null;
    mockVerifier = scriptedVerifier(() => ({ result, body }));
    const res = await handle(`bzz://${HASH}/`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'dweb verification failed' });
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('dweb.verify answer refused'),
      { tag: '[dweb]' }
    );
    if (body) expect(body.record.cancelled).toBe(true);
    expect(mockAdmission.stats().active).toBe(0);
  });

  test("a HEAD's head with a body is refused, and the body cancelled", async () => {
    const body = streamOf(['x']);
    mockVerifier = scriptedVerifier(() => ({ result: head(200, []), body }));
    const res = await handle(`bzz://${HASH}/`, { init: { method: 'HEAD' } });
    expect(res.status).toBe(502);
    expect(body.record.cancelled).toBe(true);
  });

  test("the page's abort before the head cancels dweb.verify", async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    mockVerifier = scriptedVerifier(async (_params, signal) => {
      await held;
      return signal.aborted ? new CoreError('cancelled', 'Cancelled') : null;
    });
    const page = new AbortController();
    const use = backend();
    const pending = handle(`bzz://${HASH}/`, { init: { signal: page.signal }, use });
    await new Promise((resolve) => setImmediate(resolve));
    page.abort();
    expect(mockVerifier.calls[0].signal.aborted).toBe(true);
    release();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(use.release).toHaveBeenCalledTimes(1);
    expect(mockVerifier.calls[0].closed).toBe(1);
  });
});

// 0009, Failures: "The nodes panel counts verification failures per backend
// [...] The notice informs the user; it switches nothing."
describe("the nodes panel's count of verification failures", () => {
  const NODE = 'http://127.0.0.1:1633';
  const SWARM_FAILED = 'Swarm content verification failed';
  const IPFS_FAILED = 'IPFS content verification failed';
  const errorPlan = (status, message) => ({
    result: { error: { status, code: status, message } },
    body: null,
  });
  const counted = () => ({
    ant: verificationFailures('ant', NODE),
    gateway: verificationFailures('gateway', NODE),
  });

  test("before the head: the error plan with the plan's node's text, against its backend", async () => {
    mockVerifier = scriptedVerifier((params) =>
      errorPlan(502, params.plan.verify.node === 'ant' ? SWARM_FAILED : IPFS_FAILED)
    );
    const swarm = await handle(`bzz://${HASH}/`);
    expect(swarm.status).toBe(502);
    expect(await swarm.json()).toEqual({ code: 502, message: SWARM_FAILED });
    expect(counted()).toEqual({ ant: 1, gateway: 0 });

    const ipfs = await handle(`ipfs://${CID}/`, { use: backend('ipfs') });
    expect(await ipfs.json()).toEqual({ code: 502, message: IPFS_FAILED });
    expect(counted()).toEqual({ ant: 1, gateway: 1 });

    // A navigation's error page counts the same.
    await handle(`bzz://${HASH}/`, { init: { headers: NAVIGATION } });
    expect(counted()).toEqual({ ant: 2, gateway: 1 });
  });

  test.each([
    ["the other node's text", 502, 'IPFS content verification failed'],
    ['unverifiable', 502, "This content can't be verified with the external Swarm node"],
    ['the memory limit', 502, MEMORY],
    ['not found', 404, 'Not found on the external Swarm node'],
    ["the node's own status", 500, 'The external Swarm node answered 500'],
    ['a dial that failed', 503, 'bee gateway unreachable'],
    ['busy', 503, 'Too many requests'],
    ['the deadline', 504, 'Deadline passed'],
  ])('before the head, not %s', async (_what, status, message) => {
    mockVerifier = scriptedVerifier(() => errorPlan(status, message));
    const res = await handle(`bzz://${HASH}/`);
    expect(res.status).toBe(status);
    expect(counted()).toEqual({ ant: 0, gateway: 0 });
  });

  test.each([
    ['an IPFS plan', 'malformed', 'This IPFS content is malformed'],
    [
      'an IPFS plan',
      'unverifiable',
      "This content can't be verified with the external IPFS gateway",
    ],
  ])('before the head, not %s that is %s', async (_plan, _what, message) => {
    mockVerifier = scriptedVerifier(() => errorPlan(502, message));
    await handle(`ipfs://${CID}/`, { use: backend('ipfs') });
    expect(counted()).toEqual({ ant: 0, gateway: 0 });
  });

  test.each(['busy', 'cancelled', 'core_unavailable', 'invalid_argument'])(
    'not a `%s` reply to dweb.verify',
    async (code) => {
      mockVerifier = scriptedVerifier(() => new CoreError(code, 'x'));
      await handle(`bzz://${HASH}/`);
      expect(counted()).toEqual({ ant: 0, gateway: 0 });
    }
  );

  test("not an answer main refuses (the core's fault)", async () => {
    mockVerifier = scriptedVerifier(() => ({
      result: { error: { status: 502, code: 500, message: SWARM_FAILED } },
      body: null,
    }));
    const res = await handle(`bzz://${HASH}/`);
    expect(await res.json()).toEqual({ code: 502, message: 'dweb verification failed' });
    expect(counted()).toEqual({ ant: 0, gateway: 0 });
  });

  test("after the head: the core's abort `verification_failed`", async () => {
    const abort = new CoreError('verification_failed', SWARM_FAILED);
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [['content-length', '8192']]),
      body: streamOf(['first bytes'], { fail: abort }),
    }));
    const res = await handle(`bzz://${HASH}/video.mp4`);
    // Not before the body fails.
    expect(counted()).toEqual({ ant: 0, gateway: 0 });
    await expect(res.arrayBuffer()).rejects.toBe(abort);
    expect(counted()).toEqual({ ant: 1, gateway: 0 });
  });

  test("after the head: one that ends a body main's small-text sniff was reading", async () => {
    const abort = new CoreError('verification_failed', IPFS_FAILED);
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, [
        ['content-type', 'application/octet-stream'],
        ['content-length', '6'],
      ]),
      body: streamOf([], { fail: abort }),
    }));
    const res = await handle(`ipfs://${CID}/readme`, {
      use: backend('ipfs'),
      init: { headers: NAVIGATION },
    });
    expect(res.status).toBe(502);
    expect(counted()).toEqual({ ant: 0, gateway: 1 });
  });

  test.each([
    ['unverifiable', "This content can't be verified with the external Swarm node"],
    ['unverifiable', MEMORY],
    ['malformed', 'This IPFS content is malformed'],
    ['piece_failed', 'The external Swarm node stopped sending'],
    ['busy', 'Too many requests'],
    ['cancelled', 'The request was cancelled'],
  ])('after the head, not the abort `%s` (%s)', async (code, message) => {
    const abort = new CoreError(code, message);
    mockVerifier = scriptedVerifier(() => ({
      result: head(200, []),
      body: streamOf(['x'], { fail: abort }),
    }));
    const res = await handle(`bzz://${HASH}/`);
    await expect(res.arrayBuffer()).rejects.toBe(abort);
    expect(counted()).toEqual({ ant: 0, gateway: 0 });
  });

  test("not the page's cancel, the session's close or the body idle bound", async () => {
    mockVerifier = scriptedVerifier(() => ({ result: head(200, []), body: streamOf(['a', 'b']) }));
    const cancelled = await handle(`bzz://${HASH}/`);
    await cancelled.body.cancel();
    const closing = await handle(`bzz://${HASH}/`, { partition: 'private-3' });
    mockAdmission.closeSession('private-3');
    await expect(closing.text()).rejects.toThrow('The session closed');

    jest.useFakeTimers();
    try {
      const stalled = new ReadableStream({ pull: () => new Promise(() => {}) });
      mockVerifier = scriptedVerifier(() => ({ result: head(200, []), body: stalled }));
      const res = await handle(`bzz://${HASH}/`);
      const read = res.arrayBuffer();
      const failed = expect(read).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      await failed;
    } finally {
      jest.useRealTimers();
    }
    expect(counted()).toEqual({ ant: 0, gateway: 0 });
  });

  test("a private window's failure counts, and the count keeps nothing of the request", async () => {
    mockVerifier = scriptedVerifier(() => errorPlan(502, SWARM_FAILED));
    await runWithPrivateLogContext(true, () =>
      handle(`bzz://${HASH}/secret/page.html`, { partition: 'private-1' })
    );
    expect(counted()).toEqual({ ant: 1, gateway: 0 });
    // The log line is the core's fixed text with the URL redacted, as before.
    const logged = mockLog.info.mock.calls.map(([line]) => line).join('\n');
    expect(logged).not.toContain(HASH);
    expect(logged).not.toContain('secret');
  });

  test('it switches nothing: the next request to the node is verified as usual', async () => {
    let fail = true;
    mockVerifier = scriptedVerifier(() =>
      fail
        ? errorPlan(502, SWARM_FAILED)
        : { result: head(200, [['content-type', 'text/plain']]), body: streamOf(['ok']) }
    );
    const use = backend();
    await handle(`bzz://${HASH}/a`, { use });
    fail = false;
    const res = await handle(`bzz://${HASH}/b`, { use });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(mockVerifier.calls).toHaveLength(2);
    expect(mockVerifier.calls[1].capture.backend).toBe(use);
    expect(counted()).toEqual({ ant: 1, gateway: 0 });
  });

  test('against a core without the verifier (protocol 1), nothing is counted', async () => {
    // A verify plan can't reach it: refused at shape, as before 0009.
    mockVerifier = null;
    await handle(`bzz://${HASH}/`);
    // The capture there keeps the two-key reference, so every plan is a
    // fetch: a node's answer with the core's very text (a 404, final) is
    // the node's content, not a count.
    const twoKey = {
      ref: { ant: 'external', up: true },
      url: NODE,
      request: jest.fn(
        async () =>
          new Response(JSON.stringify({ code: 404, message: SWARM_FAILED }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
      ),
      release: jest.fn(),
    };
    const res = await handle(`bzz://${HASH}/`, { use: twoKey });
    expect(await res.json()).toEqual({ code: 404, message: SWARM_FAILED });
    expect(twoKey.request).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual({ ant: 0, gateway: 0 });
  });
});

describe('against a core without the verifier (protocol 1)', () => {
  test('a verify plan is refused at shape, as before 0009, and nothing is sent', async () => {
    mockVerifier = null;
    const use = backend();
    const res = await handle(`bzz://${HASH}/`, { use, init: { headers: NAVIGATION } });
    expect(res.status).toBe(502);
    // No error page either: the JSON body, as today.
    expect(await res.json()).toEqual({ code: 502, message: 'dweb plan refused' });
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining('dweb plan refused (shape)'),
      { tag: '[dweb]' }
    );
    expect(mockAdmission.stats().active).toBe(0);
    expect(use.release).toHaveBeenCalledTimes(1);
  });

  test("today's error plans keep the JSON body for a navigation", async () => {
    const res = await handle('bzz://not-a-reference/', { init: { headers: NAVIGATION } });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('with the verifier, every { code, message } answer gets the page for a navigation', () => {
  test("an error plan from dweb.open, and the fetch executor's own failure", async () => {
    mockVerifier = scriptedVerifier(() => null);
    const plan = await handle('bzz://not-a-reference/', { init: { headers: NAVIGATION } });
    expect(plan.status).toBe(400);
    expect(plan.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await plan.text()).toContain('400: invalid bzz reference');

    // An unverified fetch (verification off) whose dial fails.
    const off = {
      ref: { ipfs: 'gateway', up: true },
      url: 'http://127.0.0.1:8080',
      request: jest.fn(async () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }),
    };
    const res = await handle(`ipfs://${CID}/`, { use: off, init: { headers: NAVIGATION } });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('502: external IPFS gateway request failed');
    expect(mockVerifier.calls).toEqual([]);
  });
});
