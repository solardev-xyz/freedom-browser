/**
 * Main executes a dweb fetch plan (freedom-core design 0006): the retry
 * loop, its cancel, the response operations, the body idle bound (deviation
 * `body-idle`), the session's stop and every terminal path, against a fake
 * backend. The real transports are in the handlers' own tests.
 */

const { executeFetch, BodyIdleError } = require('./plan-executor');

const HASH = 'ab'.repeat(32);
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const DELAYS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000];

const ANT_FETCH = {
  node: 'ant',
  path: `/bzz/${HASH}/x`,
  headers: [
    ['accept', '*/*'],
    ['swarm-chunk-retrieval-timeout', '30s'],
  ],
  retry: { statuses: [500, 502, 503, 504], on_error: true, attempts: 10, delays_ms: DELAYS },
  timers: { queue_ms: null, headers_ms: 30000, body_idle_ms: 60000 },
  response: ['canonicalize_redirect', 'strip_page_state'],
  trust: { name: null, content: 'node_asserted' },
};
const NATIVE_FETCH = {
  node: 'ipfs',
  path: `/ipfs/${CID}/`,
  headers: [['accept', 'text/html']],
  retry: { statuses: [], on_error: false, attempts: 1, delays_ms: [] },
  timers: { queue_ms: 15000, headers_ms: 30000, body_idle_ms: 60000 },
  response: ['strip_page_state', 'small_text'],
  trust: { name: null, content: 'node_asserted' },
};
const GATEWAY_FETCH = {
  ...NATIVE_FETCH,
  timers: { queue_ms: null, headers_ms: null, body_idle_ms: 60000 },
  response: ['strip_decoded_encoding', 'strip_page_state', 'canonicalize_redirect'],
  trust: { name: null, content: 'unverified' },
};

const BACKENDS = {
  ant: { ref: { ant: 'bundled', up: true }, url: 'http://127.0.0.1:1633' },
  native: { ref: { ipfs: 'native', up: true }, url: null },
  gateway: { ref: { ipfs: 'gateway', up: true }, url: 'http://127.0.0.1:8080' },
};

let log;
beforeEach(() => {
  log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});
afterEach(() => jest.useRealTimers());

/** A body the test feeds by hand, recording reads and its cancel. */
function manualBody() {
  const state = { reads: 0, cancelled: null, controller: null, pending: null };
  const stream = new ReadableStream(
    {
      start(controller) {
        state.controller = controller;
      },
      pull() {
        state.reads += 1;
        return new Promise((resolve) => {
          state.pending = resolve;
        });
      },
      cancel(reason) {
        state.cancelled = reason ?? true;
      },
    },
    { highWaterMark: 0 }
  );
  const push = (text) => {
    state.controller.enqueue(new TextEncoder().encode(text));
    state.pending?.();
  };
  return { stream, state, push };
}

function run(fetch, kind, answers, options = {}) {
  const calls = [];
  const backend = {
    ...BACKENDS[kind],
    request: jest.fn(async (init) => {
      calls.push(init);
      const answer = answers[Math.min(calls.length, answers.length) - 1];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(init) : answer;
    }),
  };
  const onEnd = jest.fn();
  const response = executeFetch(fetch, {
    backend,
    method: 'GET',
    log,
    tag: '[test]',
    redactUrl: (url) => url,
    onEnd,
    ...options,
  });
  return { response, backend, calls, onEnd };
}

const fakeClock = () =>
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
const turn = () => new Promise((resolve) => setImmediate(resolve));

describe('the retry loop', () => {
  test("retries the plan's statuses after its delays, cancelling each answer it drops", async () => {
    fakeClock();
    const dropped = [manualBody(), manualBody()];
    const { response, calls } = run(ANT_FETCH, 'ant', [
      new Response(dropped[0].stream, { status: 503 }),
      new Response(dropped[1].stream, { status: 502 }),
      new Response('served'),
    ]);
    await turn();
    expect(calls).toHaveLength(1);
    expect(dropped[0].state.cancelled).toBeTruthy();
    await jest.advanceTimersByTimeAsync(DELAYS[0] - 1);
    expect(calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(DELAYS[1]);
    const res = await response;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('served');
    expect(dropped[1].state.cancelled).toBeTruthy();
    // The plan's headers, deadline and method reach the backend each time.
    expect(calls.map((init) => [init.path, init.method, init.headersTimeoutMs])).toEqual(
      Array(3).fill([`/bzz/${HASH}/x`, 'GET', 30000])
    );
    expect([...calls[0].headers]).toEqual(ANT_FETCH.headers);
  });

  test("stops at the plan's attempts and passes the last answer on", async () => {
    fakeClock();
    const { response, calls } = run(ANT_FETCH, 'ant', [
      () => new Response('busy', { status: 503 }),
    ]);
    await jest.advanceTimersByTimeAsync(DELAYS.reduce((a, b) => a + b));
    const res = await response;
    expect(calls).toHaveLength(10);
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toBe('busy');
  });

  test('retries a thrown dial only when the plan says so', async () => {
    fakeClock();
    const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const ant = run(ANT_FETCH, 'ant', [refused, new Response('second')]);
    await jest.advanceTimersByTimeAsync(DELAYS[0]);
    await expect((await ant.response).text()).resolves.toBe('second');

    const native = run(NATIVE_FETCH, 'native', [new Error('block not found')]);
    const res = await native.response;
    expect(native.calls).toHaveLength(1);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 502, message: 'block not found' });
  });

  test("the page's abort ends the back-off at once, with nothing more dialled", async () => {
    fakeClock();
    const controller = new AbortController();
    const dropped = manualBody();
    const { response, calls, onEnd } = run(
      ANT_FETCH,
      'ant',
      [new Response(dropped.stream, { status: 503, headers: { 'set-cookie': 'a=1' } })],
      { signal: controller.signal }
    );
    await turn();
    expect(jest.getTimerCount()).toBe(1);
    controller.abort();
    const res = await response;
    expect(jest.getTimerCount()).toBe(0);
    expect(calls).toHaveLength(1);
    // Nobody reads it, and it still went through the operations.
    expect(res.status).toBe(503);
    expect(res.body).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('after the dial', () => {
  test.each([
    ['Ant, refused', 'ant', { cause: { code: 'ECONNREFUSED' } }, 503, 'bee gateway unreachable'],
    ['Ant, reset', 'ant', { code: 'ECONNRESET' }, 503, 'bee gateway unreachable'],
    ['Ant, timed out', 'ant', { code: 'ATTEMPT_TIMEOUT' }, 502, 'bee gateway error'],
    ['the native node', 'native', {}, 502, 'boom'],
    ['the gateway', 'gateway', {}, 502, 'external IPFS gateway request failed'],
    ['the gateway, aborted', 'gateway', { name: 'AbortError' }, 502, 'boom'],
  ])('%s: %i %s', async (_label, kind, props, status, message) => {
    fakeClock();
    const fetch = kind === 'ant' ? ANT_FETCH : kind === 'native' ? NATIVE_FETCH : GATEWAY_FETCH;
    const { response, onEnd } = run(fetch, kind, [Object.assign(new Error('boom'), props)]);
    await jest.advanceTimersByTimeAsync(DELAYS.reduce((a, b) => a + b));
    const res = await response;
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code: status, message });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('the response operations', () => {
  test('page state is stripped whatever the plan names (deviation native-page-state)', async () => {
    const fetch = { ...NATIVE_FETCH, response: [] };
    const { response } = run(fetch, 'native', [
      new Response('x', {
        headers: { 'set-cookie': 'a=1', 'service-worker-allowed': '/', 'set-cookie2': 'b' },
      }),
    ]);
    const res = await response;
    expect([...res.headers.keys()]).toEqual(['content-type']);
  });

  test("the gateway's decoded encoding goes whatever the plan names", async () => {
    const fetch = { ...GATEWAY_FETCH, response: ['canonicalize_redirect'] };
    const { response } = run(fetch, 'gateway', [
      new Response('decoded', {
        headers: { 'content-encoding': 'gzip', 'content-length': '3', 'keep-alive': 'x' },
      }),
    ]);
    const res = await response;
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('keep-alive')).toBeNull();
    await expect(res.text()).resolves.toBe('decoded');
  });

  test("Ant's rewritten redirect drops and cancels its body", async () => {
    const body = manualBody();
    const { response, onEnd } = run(ANT_FETCH, 'ant', [
      new Response(body.stream, {
        status: 308,
        headers: { location: `/bzz/${HASH}/x/`, 'content-length': '9' },
      }),
    ]);
    const res = await response;
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('./x/');
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.body).toBeNull();
    expect(body.state.cancelled).toBeTruthy();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('a status with no body never carries one', async () => {
    const upstream = new Response(null, { status: 304, headers: { etag: '"v1"' } });
    const { response, onEnd } = run(ANT_FETCH, 'ant', [upstream]);
    const res = await response;
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('206 and Content-Range pass through as received', async () => {
    const { response } = run(ANT_FETCH, 'ant', [
      new Response('0123456789', {
        status: 206,
        headers: { 'content-range': 'bytes 0-9/100', 'content-length': '10' },
      }),
    ]);
    const res = await response;
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100');
    expect(res.headers.get('content-length')).toBe('10');
    await expect(res.text()).resolves.toBe('0123456789');
  });

  test('small text relabels a small octet-stream navigation; a failed sniff is a 502', async () => {
    const text = run(NATIVE_FETCH, 'native', [
      new Response('hello\n', {
        headers: { 'content-type': 'application/octet-stream', 'content-length': '6' },
      }),
    ]);
    const res = await text.response;
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(res.text()).resolves.toBe('hello\n');

    const failing = new ReadableStream({
      pull(controller) {
        controller.error(new Error('freedom-ipfs native read failed'));
      },
    });
    const broken = run(NATIVE_FETCH, 'native', [
      new Response(failing, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': '6' },
      }),
    ]);
    const failed = await broken.response;
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ code: 502, message: 'freedom-ipfs native read failed' });
    expect(broken.onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('the body idle bound (deviation body-idle)', () => {
  test('a read left pending for 60 s fails the body as truncated and frees the upstream', async () => {
    fakeClock();
    const body = manualBody();
    const { response, onEnd } = run(ANT_FETCH, 'ant', [new Response(body.stream)]);
    const reader = (await response).body.getReader();
    const read = reader.read();
    await turn();
    body.push('first');
    expect(new TextDecoder().decode((await read).value)).toBe('first');
    // Nothing pending: no clock.
    expect(jest.getTimerCount()).toBe(0);

    const stalled = reader.read().catch((err) => err);
    await turn();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(body.state.cancelled).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    const err = await stalled;
    expect(err).toBeInstanceOf(BodyIdleError);
    expect(body.state.cancelled).toBeInstanceOf(BodyIdleError);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('a paused reader is never cut off, and each read gets its own 60 s', async () => {
    fakeClock();
    const body = manualBody();
    const { response, onEnd } = run(ANT_FETCH, 'ant', [new Response(body.stream)]);
    const reader = (await response).body.getReader();
    // Paused: nothing asked for, for ten minutes.
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(jest.getTimerCount()).toBe(0);
    for (const chunk of ['a', 'b', 'c']) {
      const read = reader.read();
      await turn();
      await jest.advanceTimersByTimeAsync(59_000);
      body.push(chunk);
      expect(new TextDecoder().decode((await read).value)).toBe(chunk);
    }
    body.state.controller.close();
    body.state.pending?.();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(body.state.cancelled).toBeNull();
  });

  test('the plan sets the bound', async () => {
    fakeClock();
    const body = manualBody();
    const fetch = { ...ANT_FETCH, timers: { ...ANT_FETCH.timers, body_idle_ms: 5000 } };
    const { response } = run(fetch, 'ant', [new Response(body.stream)]);
    const stalled = (await response).body
      .getReader()
      .read()
      .catch((err) => err);
    await turn();
    await jest.advanceTimersByTimeAsync(5000);
    expect(await stalled).toBeInstanceOf(BodyIdleError);
  });
});

describe('terminal paths', () => {
  test('a consumer cancel frees the upstream and ends the fetch once', async () => {
    const body = manualBody();
    const { response, onEnd } = run(ANT_FETCH, 'ant', [new Response(body.stream)]);
    await (await response).body.cancel('gone');
    expect(body.state.cancelled).toBe('gone');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('an upstream error reaches the consumer as it is: truncated, not a short success', async () => {
    const body = manualBody();
    const { response, onEnd } = run(ANT_FETCH, 'ant', [new Response(body.stream)]);
    const read = (await response).body
      .getReader()
      .read()
      .catch((err) => err);
    await turn();
    const terminated = new TypeError('terminated');
    body.state.controller.error(terminated);
    body.state.pending?.();
    expect(await read).toBe(terminated);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("the session's stop ends a streaming body and frees the upstream", async () => {
    const stop = new AbortController();
    const body = manualBody();
    const { response, onEnd } = run(ANT_FETCH, 'ant', [new Response(body.stream)], {
      stop: stop.signal,
    });
    const reader = (await response).body.getReader();
    const read = reader.read().catch((err) => err);
    await turn();
    const closed = new Error('The session closed');
    stop.abort(closed);
    expect(await read).toBe(closed);
    expect(body.state.cancelled).toBe(closed);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("the session's stop reaches a dial in flight", async () => {
    const stop = new AbortController();
    const { response, calls } = run(
      NATIVE_FETCH,
      'native',
      [
        ({ signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          ),
      ],
      { stop: stop.signal, signal: new AbortController().signal }
    );
    await turn();
    expect(calls).toHaveLength(1);
    stop.abort();
    expect((await response).status).toBe(502);
  });
});
