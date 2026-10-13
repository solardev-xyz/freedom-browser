const { ethers } = require('ethers');
const { ShellError } = require('./core-client');
const { OnionGateRefusal } = require('../ipfs/onion-gate');
const { isOnionGatewayUrl } = require('../ipfs/gateway-transport');
const { LookupsExhausted } = require('../networks/blockscout-logs');
const {
  registerNamingShell,
  unlessAborted,
  fetchLoop,
  makeHop,
  gatewayAllowed,
  redirectAllowed,
  isOk,
  MAX_ATTEMPTS,
  MAX_ABANDONED,
} = require('./naming-shell');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));

const START = 'https://a.rpc.example/';
const tick = () => new Promise(setImmediate);

/** A body that streams `first`, then never ends; `state.cancelled` records
 * its cancel. */
function endless(first = '') {
  const state = { cancelled: false };
  const stream = new ReadableStream({
    start(controller) {
      if (first) controller.enqueue(new Uint8Array(Buffer.from(first)));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** A fetch that never settles by itself and ignores its signal (a proxy
 * lookup that doesn't observe the abort); `settle[i]` settles call i. */
function stuckFetch() {
  const settle = [];
  const fetch = jest.fn(() => new Promise((resolve) => settle.push(resolve)));
  return { fetch, settle };
}
const BODY = '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}';

/** Answers in order: { status, headers?, body? }. */
function script(answers) {
  return answers.map((a) => ({ headers: {}, body: '', ...a }));
}

/** ethers' own FetchRequest on the script, its clock and Math.random faked. */
async function viaEthers(answers, draws) {
  jest.useFakeTimers({ now: 0 });
  const random = jest.spyOn(Math, 'random');
  draws.forEach((r) => random.mockReturnValueOnce(r));
  const calls = [];
  ethers.FetchRequest.registerGetUrl(async (req) => {
    const answer = answers[calls.length];
    calls.push({ url: req.url, at: Date.now() });
    return {
      statusCode: answer.status,
      statusMessage: '',
      headers: answer.headers,
      body: Buffer.from(answer.body),
    };
  });
  try {
    const req = new ethers.FetchRequest(START);
    req.body = BODY;
    const sent = req.send().then(
      (response) => ({
        status: response.statusCode,
        body: Buffer.from(response.body ?? []).toString(),
      }),
      (err) => ({ error: err.code })
    );
    await jest.runAllTimersAsync();
    return { calls, outcome: await sent };
  } finally {
    ethers.FetchRequest.registerGetUrl(ethers.FetchRequest.createGetUrlFunc());
    random.mockRestore();
    jest.useRealTimers();
  }
}

/** Main's loop on the same script and draws. */
async function viaLoop(answers, draws, allowed = () => true) {
  let t = 0;
  const calls = [];
  const queue = [...draws];
  const outcome = await fetchLoop(START, BODY, {
    hop: async (url, init) => {
      expect(init).toMatchObject({
        method: 'POST',
        body: BODY,
        headers: { 'content-type': 'application/json' },
      });
      const answer = answers[calls.length];
      calls.push({ url, at: t });
      return { status: answer.status, headers: answer.headers, body: Buffer.from(answer.body) };
    },
    allowed,
    now: () => t,
    random: () => queue.shift(),
    wait: async (ms) => {
      t += ms;
    },
  }).then(
    (response) => ({ status: response.status, body: response.body.toString() }),
    (err) => ({ error: err instanceof ShellError ? err.code : String(err) })
  );
  return { calls, outcome };
}

describe("main's FetchRequest loop matches ethers'", () => {
  const cases = {
    'a plain answer': [script([{ status: 200, body: 'ok' }]), []],
    'redirects followed at once': [
      script([
        { status: 301, headers: { location: 'https://b.rpc.example/x' } },
        { status: 307, headers: { location: 'https://c.rpc.example/y' } },
        { status: 302, headers: { location: 'https://d.rpc.example/z' } },
        { status: 200, body: 'ok' },
      ]),
      [],
    ],
    'a relative redirect is the answer': [
      script([{ status: 302, headers: { location: '/elsewhere' } }]),
      [],
    ],
    'a downgrade to http is the answer': [
      script([{ status: 308, headers: { location: 'http://b.rpc.example/' } }]),
      [],
    ],
    'an upper-case scheme is the answer': [
      script([{ status: 302, headers: { location: 'HTTPS://b.rpc.example/' } }]),
      [],
    ],
    'a redirect without a location is the answer': [script([{ status: 302 }]), []],
    'Retry-After in milliseconds': [
      script([
        { status: 429, headers: { 'retry-after': '7' } },
        { status: 200, body: 'ok' },
      ]),
      [0.99],
    ],
    'a Retry-After that is not a positive integer': [
      script([
        { status: 429, headers: { 'retry-after': '0' } },
        { status: 429, headers: { 'retry-after': '1.5' } },
        { status: 200 },
      ]),
      [0.9, 0.6],
    ],
    'random back-off between 429s': [
      script([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200, body: 'ok' }]),
      [0.9, 0.5, 0.99],
    ],
    'a redirect after a 429': [
      script([
        { status: 429 },
        { status: 302, headers: { location: 'https://r.rpc.example/' } },
        { status: 200 },
      ]),
      [0.7],
    ],
    'twelve 429s: the last answer as a 599': [
      script(Array.from({ length: MAX_ATTEMPTS }, (_, i) => ({ status: 429, body: `n${i}` }))),
      Array.from({ length: MAX_ATTEMPTS }, () => 0.5),
    ],
    'the exchange expires before a later attempt': [
      script([
        { status: 429, headers: { 'retry-after': '400000' } },
        { status: 429 },
        { status: 200 },
      ]),
      [0.5, 0.5],
    ],
  };
  for (const [name, [answers, draws]] of Object.entries(cases)) {
    test(name, async () => {
      const reference = await viaEthers(answers, draws);
      const main = await viaLoop(answers, draws);
      expect(main.calls).toEqual(reference.calls);
      const expected =
        reference.outcome.error === 'TIMEOUT' ? { error: 'timeout' } : reference.outcome;
      expect(main.outcome).toEqual(expected);
    });
  }

  test("chain data's plain policy: a 429 is the answer, redirects still followed", async () => {
    let t = 0;
    const answers = script([
      { status: 302, headers: { location: 'https://b.rpc.example/' } },
      { status: 429, headers: { 'retry-after': '7' }, body: 'slow down' },
      { status: 200 },
    ]);
    const calls = [];
    const response = await fetchLoop(START, BODY, {
      hop: async (url, init) => {
        const next = answers[calls.length];
        calls.push({ url, read: init.read, max: init.max, charge: init.charge });
        return { status: next.status, headers: next.headers, body: Buffer.from(next.body) };
      },
      allowed: () => true,
      plain: true,
      read: isOk,
      max: 1000,
      charge: () => true,
      now: () => t,
      wait: async (ms) => {
        t += ms;
      },
    });
    expect(response.status).toBe(429);
    expect(calls.map((c) => c.url)).toEqual([START, 'https://b.rpc.example/']);
    expect(calls.every((c) => c.read === isOk && c.max === 1000 && c.charge)).toBe(true);
    expect(t).toBe(0);
  });

  test('a hop the endpoint policy refuses ends the exchange (deviation rpc-redirects)', async () => {
    const answers = script([
      { status: 302, headers: { location: 'https://10.0.0.1/' } },
      { status: 200 },
    ]);
    const main = await viaLoop(answers, [], (url) => !url.includes('10.0.0.1'));
    expect(main.calls).toHaveLength(1);
    expect(main.outcome).toEqual({ error: 'refused' });
  });
});

// Review of #692 (security, M2): an endpoint the user configured doesn't
// make a redirect target one.
describe("an RPC redirect's target", () => {
  const PUBLIC = [{ address: '104.18.12.34', family: 4 }];
  const check = (location, origin, lookup = jest.fn(async () => PUBLIC), signal) =>
    redirectAllowed(location, origin, { lookup, signal });

  test("on the configured endpoint's origin, as a node the user runs redirects within itself", async () => {
    const lookup = jest.fn();
    expect(await check('http://127.0.0.1:8545/rpc', 'http://127.0.0.1:8545', lookup)).toBe(true);
    expect(await check('http://localhost:8545/v2', 'http://localhost:8545', lookup)).toBe(true);
    expect(await check('https://a.rpc.example/v2', 'https://a.rpc.example', lookup)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  test.each([
    ['another loopback port', 'http://127.0.0.1:9443/admin', 'http://127.0.0.1:8545'],
    ['loopback, from a public host', 'https://127.0.0.1:9443/admin', 'https://public.example'],
    ['a shorthand loopback', 'https://127.1/', 'https://public.example'],
    ['IPv6 loopback', 'https://[::1]/', 'https://public.example'],
    ['mapped loopback', 'https://[::ffff:127.0.0.1]/', 'https://public.example'],
    ['localhost', 'https://localhost/', 'https://public.example'],
    ['a .localhost name', 'https://wallet.localhost/', 'https://public.example'],
    ['a private address', 'https://192.168.1.1/', 'https://public.example'],
    ['a link-local address', 'https://169.254.169.254/', 'https://public.example'],
    ['plain http', 'http://b.rpc.example/', 'https://a.rpc.example'],
  ])('off its origin, %s is refused unresolved', async (_name, location, origin) => {
    const lookup = jest.fn(async () => PUBLIC);
    expect(await check(location, origin, lookup)).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a clearnet name off its origin is followed only once it resolves to no local address', async () => {
    const local = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    expect(await check('https://rebind.example/', 'https://a.rpc.example', local)).toBe(false);
    expect(local).toHaveBeenCalledWith('rebind.example', { all: true, verbatim: true });
    const mixed = jest.fn(async () => [...PUBLIC, { address: '10.1.2.3', family: 4 }]);
    expect(await check('https://mixed.example/', 'https://a.rpc.example', mixed)).toBe(false);
    const failing = jest.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    expect(await check('https://nowhere.example/', 'https://a.rpc.example', failing)).toBe(false);
    expect(await check('https://b.rpc.example/', 'https://a.rpc.example')).toBe(true);
    // A public address literal needs no lookup.
    const lookup = jest.fn();
    expect(await check('https://8.8.8.8/', 'https://a.rpc.example', lookup)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('an .onion name goes to the onion gate, never to the system resolver', async () => {
    const lookup = jest.fn(async () => PUBLIC);
    for (const location of [
      'https://next.onion/',
      'https://NEXT.ONION../',
      'https://next%2eonion/',
    ]) {
      expect(await check(location, 'https://a.rpc.example', lookup)).toBe(true);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  // Review of #692 (security, round 2): one onion test on both sides.
  test('the onion gate takes every name the check passes to it unresolved', async () => {
    for (const location of [
      'https://next.onion/',
      'https://NEXT.ONION./',
      'https://next.onion../',
      'https://next%2eonion/',
    ]) {
      const lookup = jest.fn(async () => PUBLIC);
      expect(await check(location, 'https://a.rpc.example', lookup)).toBe(true);
      expect(lookup).not.toHaveBeenCalled();
      expect(isOnionGatewayUrl(location)).toBe(true);
    }
    // And a name that only looks onion is resolved, never gated.
    for (const location of ['https://onion.example/', 'https://next.onion.example/']) {
      const lookup = jest.fn(async () => PUBLIC);
      expect(await check(location, 'https://a.rpc.example', lookup)).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(isOnionGatewayUrl(location)).toBe(false);
    }
  });

  test('its lookup ends with the exchange, and past the lookup bound it is busy', async () => {
    const cancel = new AbortController();
    const pending = check(
      'https://slow.example/',
      'https://a.rpc.example',
      jest.fn(() => new Promise(() => {})),
      cancel.signal
    ).catch((e) => e);
    cancel.abort();
    expect(await pending).toBeInstanceOf(Error);
    const exhausted = jest.fn(async () => {
      throw new LookupsExhausted();
    });
    await expect(
      check('https://b.rpc.example/', 'https://a.rpc.example', exhausted)
    ).rejects.toMatchObject({
      code: 'busy',
    });
  });
});

describe('a hop', () => {
  /** A fetch answering `status`, `headers` and body `chunks`. */
  function fakeFetch({ status = 200, headers = {}, chunks = [], fail, hang }) {
    return jest.fn(async (_url, init) => {
      if (fail) throw fail;
      if (hang) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        });
      }
      return new Response(
        chunks.length ? new Blob(chunks.map((c) => Buffer.from(c))).stream() : null,
        {
          status,
          headers,
        }
      );
    });
  }

  test('reads the answer with its headers, lower-cased', async () => {
    const hop = makeHop({
      fetch: fakeFetch({ headers: { 'Retry-After': '3' }, chunks: ['ab', 'cd'] }),
    });
    const response = await hop('https://a.example', { method: 'POST', body: 'x' });
    expect(response.status).toBe(200);
    expect(response.headers['retry-after']).toBe('3');
    expect(response.body.toString()).toBe('abcd');
  });

  test('each chunk is charged as it is read; one past the pool is busy, and cancelled', async () => {
    const charged = [];
    const chunks = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('ab')));
        controller.enqueue(new Uint8Array(Buffer.from('cde')));
        controller.close();
      },
    });
    const hop = makeHop({ fetch: jest.fn(async () => new Response(chunks)) });
    const charge = (bytes) => {
      charged.push(bytes);
      return true;
    };
    const response = await hop('https://a.example', { charge });
    expect(response.body.toString()).toBe('abcde');
    expect(charged).toEqual([2, 3]);
    const { stream, state } = endless('x'.repeat(10));
    const refusing = makeHop({ fetch: jest.fn(async () => new Response(stream)) });
    await expect(refusing('https://a.example', { charge: () => false })).rejects.toMatchObject({
      code: 'busy',
    });
    await tick();
    expect(state.cancelled).toBe(true);
  });

  test('a browser-style opaque redirect, whose target is hidden, is refused', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null };
    const hop = makeHop({ fetch: jest.fn(async () => opaque) });
    await expect(hop('https://a.example', {})).rejects.toMatchObject({ code: 'refused' });
  });

  test('an answer over the cap is too_large', async () => {
    const hop = makeHop({ fetch: fakeFetch({ chunks: ['x'.repeat(10)] }) });
    await expect(hop('https://a.example', { max: 9 })).rejects.toMatchObject({ code: 'too_large' });
  });

  test("a body the caller doesn't want is cancelled unread, however large or silent", async () => {
    for (const first of ['', 'x'.repeat(100)]) {
      const { stream, state } = endless(first);
      const hop = makeHop({
        fetch: jest.fn(async () => new Response(stream, { status: 404 })),
        inactivityMs: 1000,
      });
      const response = await hop('https://t.example/x', {
        max: 10,
        read: (status) => status === 200,
      });
      expect(response.status).toBe(404);
      expect(response.body.length).toBe(0);
      await tick();
      expect(state.cancelled).toBe(true);
    }
  });

  test('a declared length over the cap is refused unread', async () => {
    const { stream, state } = endless();
    const hop = makeHop({
      fetch: jest.fn(
        async () => new Response(stream, { status: 200, headers: { 'content-length': '11' } })
      ),
    });
    await expect(hop('https://a.example', { max: 10 })).rejects.toMatchObject({
      code: 'too_large',
    });
    await tick();
    expect(state.cancelled).toBe(true);
  });

  test('a fetch that ignores the abort is abandoned: the hop settles, the work is bounded', async () => {
    const { fetch, settle } = stuckFetch();
    const hop = makeHop({ fetch, inactivityMs: 60_000 });
    const cancel = new AbortController();
    const pending = hop('https://a.onion', { signal: cancel.signal }).catch((e) => e);
    await tick();
    cancel.abort();
    expect((await pending).name).toBe('AbortError');
    expect(hop.abandoned()).toBe(1);
    // Inactivity likewise ends it, as timeout.
    const idle = makeHop({ fetch: stuckFetch().fetch, inactivityMs: 5 });
    await expect(idle('https://a.onion', {})).rejects.toMatchObject({ code: 'timeout' });
    expect(idle.abandoned()).toBe(1);
    // Its late response is discarded, and it no longer counts.
    const { stream, state } = endless('x');
    settle[0](new Response(stream));
    await tick();
    await tick();
    expect(state.cancelled).toBe(true);
    expect(hop.abandoned()).toBe(0);
    // With MAX_ABANDONED of them stuck, a new hop fails at once.
    for (let i = 0; i < MAX_ABANDONED; i++) {
      const c = new AbortController();
      const p = hop('https://a.onion', { signal: c.signal }).catch(() => {});
      await tick();
      c.abort();
      await p;
    }
    expect(hop.abandoned()).toBe(MAX_ABANDONED);
    const dialled = fetch.mock.calls.length;
    await expect(hop('https://b.example', {})).rejects.toMatchObject({ code: 'network' });
    expect(fetch.mock.calls.length).toBe(dialled);
  });

  test('a body that stalls, its stream deaf to the abort, still ends', async () => {
    const cancel = new AbortController();
    const first = endless('x');
    const hop = makeHop({
      fetch: jest.fn(async () => new Response(first.stream)),
      inactivityMs: 60_000,
    });
    const pending = hop('https://a.example', { signal: cancel.signal }).catch((e) => e);
    await tick();
    cancel.abort();
    expect((await pending).name).toBe('AbortError');
    await tick();
    expect(first.state.cancelled).toBe(true);
    const second = endless('x');
    const idle = makeHop({
      fetch: jest.fn(async () => new Response(second.stream)),
      inactivityMs: 5,
    });
    await expect(idle('https://a.example', {})).rejects.toMatchObject({ code: 'timeout' });
  });

  test('a cancel between reads starts no further read and leaves nothing unhandled', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // An already-rejected wait, already aborted: still observed.
      const aborted = new AbortController();
      aborted.abort();
      await expect(unlessAborted(Promise.reject(new Error('late')), aborted.signal)).rejects.toBe(
        aborted.signal.reason
      );
      // The cancel lands after a read has won its race, before the loop
      // goes round: no further read starts.
      const cancel = new AbortController();
      let reads = 0;
      const reader = {
        read: () => {
          reads += 1;
          if (reads > 1)
            return Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' }));
          const first = Promise.resolve({ done: false, value: new Uint8Array([1]) });
          first.then(() => queueMicrotask(() => cancel.abort()));
          return first;
        },
        cancel: async () => {},
      };
      const response = {
        status: 200,
        headers: new Headers(),
        body: { getReader: () => reader, cancel: async () => {} },
      };
      const hop = makeHop({ fetch: jest.fn(async () => response) });
      const err = await hop('https://a.example', { signal: cancel.signal }).catch((e) => e);
      expect(err.name).toBe('AbortError');
      await tick();
      expect(reads).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  // Review of #692 (security, M1): a body that fails, even with a refusal
  // in hand, never proves the request unsent.
  test("a body's failure is the network, whatever it says", async () => {
    for (const thrown of [
      new Error('.onion gateway read failed'),
      new OnionGateRefusal('.onion gateway is not routed through a proxy'),
    ]) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        pull(controller) {
          controller.error(thrown);
        },
      });
      const err = await makeHop({ fetch: jest.fn(async () => new Response(stream)) })(
        'https://a.example',
        {}
      ).catch((e) => e);
      expect(err).toMatchObject({ code: 'network' });
      expect(err.unsent).toBeUndefined();
    }
  });

  test('a network failure, an onion refusal and inactivity', async () => {
    await expect(
      makeHop({ fetch: fakeFetch({ fail: new Error('ECONNRESET') }) })('https://a.example', {})
    ).rejects.toMatchObject({ code: 'network' });
    // The onion gate refuses before the request exists: nothing was sent.
    const onion = new OnionGateRefusal(
      '.onion gateway is not routed through a proxy (resolveProxy: DIRECT)'
    );
    await expect(
      makeHop({ fetch: fakeFetch({ fail: onion }) })('https://a.onion', {})
    ).rejects.toMatchObject({ code: 'refused', unsent: true });
    // Only the gate's own refusal: the same text from anything else may
    // follow a send.
    const said = new Error('.onion gateway is not routed through a proxy (resolveProxy: DIRECT)');
    const lookalike = await makeHop({ fetch: fakeFetch({ fail: said }) })(
      'https://a.onion',
      {}
    ).catch((e) => e);
    expect(lookalike).toMatchObject({ code: 'network' });
    expect(lookalike.unsent).toBeUndefined();
    await expect(
      makeHop({ fetch: fakeFetch({ hang: true }), inactivityMs: 5 })('https://a.example', {})
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('the executors', () => {
  function setUp(overrides = {}) {
    const handlers = new Map();
    const client = { handle: (method, fn) => handlers.set(method, fn) };
    const urls = new Map([
      ['e1', 'https://a.rpc.example'],
      ['e2', 'http://public.example'],
      ['e3', 'http://127.0.0.1:8545'],
      ['t1', 'https://t1.tez.example'],
    ]);
    const config = {
      endpointUrl: (ref) => urls.get(ref),
      generations: { ens: 2, tezos: 1, lifecycle: 0 },
    };
    const hop = jest.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('{"ok":1}') }));
    const prefetch = jest.fn(() => ({ abort: jest.fn(), done: Promise.resolve() }));
    registerNamingShell(client, config, { hop, prefetch, ...overrides });
    // As the client calls a handler: inside a promise, so a throw is a
    // rejection.
    const call = (method, params, signal = new AbortController().signal) =>
      Promise.resolve().then(() => handlers.get(method)(params, { signal }));
    return { call, hop, prefetch, config };
  }

  test('shell.rpc maps the reference, posts the body and answers in base64', async () => {
    const { call, hop } = setUp();
    const result = await call('shell.rpc', {
      endpoint: 'e1',
      body: BODY,
      generations: { ens: 2 },
      deadline_ms: 1000,
    });
    expect(result).toEqual({ status: 200, body: Buffer.from('{"ok":1}').toString('base64') });
    expect(hop).toHaveBeenCalledWith(
      'https://a.rpc.example',
      expect.objectContaining({ method: 'POST', body: BODY })
    );
  });

  test('an older generation is refused before anything is done; a newer one is not', async () => {
    const { call, hop } = setUp();
    await expect(
      call('shell.rpc', { endpoint: 'e1', body: BODY, generations: { ens: 1 } })
    ).rejects.toMatchObject({ code: 'stale_generation' });
    await expect(
      call('shell.tezos', { endpoint: 't1', path: '/x', generations: { tezos: 0 } })
    ).rejects.toMatchObject({ code: 'stale_generation' });
    expect(hop).not.toHaveBeenCalled();
    await call('shell.rpc', { endpoint: 'e1', body: BODY, generations: { ens: 3 } });
    expect(hop).toHaveBeenCalledTimes(1);
  });

  test("a redirect off the endpoint's origin to a local one is refused, before it is dialled", async () => {
    const lookup = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    for (const location of ['http://127.0.0.1:9443/admin', 'https://rebind.example/']) {
      const hop = jest.fn(async () => ({
        status: 307,
        headers: { location },
        body: Buffer.alloc(0),
      }));
      const { call } = setUp({ hop, lookup });
      await expect(
        call('shell.rpc', { endpoint: 'e3', body: BODY, generations: { ens: 2 } })
      ).rejects.toMatchObject({ code: 'refused' });
      expect(hop).toHaveBeenCalledTimes(1);
    }
    // Within the node's own origin, it is followed.
    const hop = jest
      .fn()
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: 'http://127.0.0.1:8545/rpc' },
        body: Buffer.alloc(0),
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: Buffer.from('{}') });
    const { call } = setUp({ hop, lookup });
    await call('shell.rpc', { endpoint: 'e3', body: BODY, generations: { ens: 2 } });
    expect(hop.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:8545',
      'http://127.0.0.1:8545/rpc',
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('the first RPC hop meets the endpoint policy too', async () => {
    const { call, hop } = setUp();
    await expect(
      call('shell.rpc', { endpoint: 'e2', body: BODY, generations: { ens: 2 } })
    ).rejects.toMatchObject({ code: 'refused' });
    expect(hop).not.toHaveBeenCalled();
    await call('shell.rpc', { endpoint: 'e3', body: BODY, generations: { ens: 2 } });
    expect(hop).toHaveBeenCalledWith('http://127.0.0.1:8545', expect.anything());
  });

  test("RPC reads any status's body; Tezos and gateways only a 2xx's, as today", async () => {
    const answer = (status, first) => {
      const { stream, state } = endless(first);
      return { state, fetch: jest.fn(async () => new Response(stream, { status })) };
    };
    // ethers keeps a 500's body: here it ends, so it is read.
    const rpc = setUp({
      hop: makeHop({
        fetch: jest.fn(async () => new Response('node error', { status: 500 })),
      }),
    });
    expect(
      await rpc.call('shell.rpc', { endpoint: 'e1', body: BODY, generations: { ens: 2 } })
    ).toEqual({ status: 500, body: Buffer.from('node error').toString('base64') });
    // A silent or huge 404 from a Tezos node is a 404 at once.
    for (const first of ['', 'x'.repeat(800 * 1024)]) {
      const { state, fetch } = answer(404, first);
      const tezos = setUp({ hop: makeHop({ fetch, inactivityMs: 60_000 }) });
      expect(
        await tezos.call('shell.tezos', { endpoint: 't1', path: '/x', generations: { tezos: 1 } })
      ).toEqual({ status: 404, body: '' });
      await tick();
      expect(state.cancelled).toBe(true);
    }
    const { state, fetch } = answer(500, 'x');
    const gateway = setUp({ hop: makeHop({ fetch, inactivityMs: 60_000 }) });
    expect(
      await gateway.call('shell.gateway', {
        url: 'https://gw.example/',
        method: 'GET',
        generations: { ens: 2 },
      })
    ).toEqual({ status: 500, body: '' });
    await tick();
    expect(state.cancelled).toBe(true);
  });

  test('a stuck transport ends with the deadline or the cancel; a prefetch too', async () => {
    const { call } = setUp({ hop: makeHop({ fetch: stuckFetch().fetch, inactivityMs: 60_000 }) });
    await expect(
      call('shell.rpc', { endpoint: 'e1', body: BODY, generations: { ens: 2 }, deadline_ms: 10 })
    ).rejects.toMatchObject({ code: 'timeout' });
    const cancel = new AbortController();
    const cancelled = call(
      'shell.tezos',
      { endpoint: 't1', path: '/x', generations: { tezos: 1 } },
      cancel.signal
    ).catch((e) => e);
    await tick();
    cancel.abort();
    expect((await cancelled).name).toBe('AbortError');
    // A prefetch whose own wait never ends.
    const abort = jest.fn();
    const stuck = setUp({ prefetch: jest.fn(() => ({ abort, done: new Promise(() => {}) })) });
    await expect(
      stuck.call('shell.prefetch', { uri: 'ipfs://bafy', generations: { ens: 2 }, deadline_ms: 10 })
    ).resolves.toEqual({});
    expect(abort).toHaveBeenCalled();
  });

  test('abandoned prefetches count until they end; past the bound, new ones are skipped', async () => {
    const pending = [];
    const prefetch = jest.fn(() => {
      let end;
      const done = new Promise((resolve) => (end = resolve));
      pending.push(end);
      return { abort: jest.fn(), done };
    });
    const { call } = setUp({ prefetch });
    const params = { uri: 'ipfs://bafy', generations: { ens: 2 }, deadline_ms: 1 };
    for (let i = 0; i < MAX_ABANDONED; i++) {
      await expect(call('shell.prefetch', params)).resolves.toEqual({});
    }
    expect(prefetch).toHaveBeenCalledTimes(MAX_ABANDONED);
    // At the bound: replied at once, nothing started.
    await expect(call('shell.prefetch', params)).resolves.toEqual({});
    expect(prefetch).toHaveBeenCalledTimes(MAX_ABANDONED);
    // One ends: room for one more.
    pending[0]();
    await tick();
    await expect(call('shell.prefetch', params)).resolves.toEqual({});
    expect(prefetch).toHaveBeenCalledTimes(MAX_ABANDONED + 1);
  });

  test('a prefetch that ends leaves no listener; its abort comes only with the request', async () => {
    const abort = jest.fn();
    const { call } = setUp({ prefetch: jest.fn(() => ({ abort, done: Promise.resolve() })) });
    const signal = new AbortController();
    const added = jest.spyOn(AbortSignal, 'any');
    await expect(
      call('shell.prefetch', { uri: 'ipfs://bafy', generations: { ens: 2 } }, signal.signal)
    ).resolves.toEqual({});
    const within = added.mock.results.at(-1).value;
    added.mockRestore();
    const { getEventListeners } = require('events');
    expect(getEventListeners(within, 'abort')).toEqual([]);
    expect(getEventListeners(signal.signal, 'abort')).toEqual([]);
    signal.abort();
    expect(abort).not.toHaveBeenCalled();
  });

  test('an unknown reference is refused', async () => {
    const { call } = setUp();
    await expect(
      call('shell.rpc', { endpoint: 'e9', body: BODY, generations: { ens: 2 } })
    ).rejects.toMatchObject({ code: 'refused' });
  });

  test("the deadline ends the exchange as timeout; a cancel is the core's", async () => {
    const hanging = jest.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    const { call } = setUp({ hop: hanging });
    await expect(
      call('shell.rpc', { endpoint: 'e1', body: BODY, generations: { ens: 2 }, deadline_ms: 5 })
    ).rejects.toMatchObject({ code: 'timeout' });
    const cancel = new AbortController();
    const pending = call(
      'shell.rpc',
      { endpoint: 'e1', body: BODY, generations: { ens: 2 } },
      cancel.signal
    );
    cancel.abort();
    const err = await pending.catch((e) => e);
    expect(err).not.toBeInstanceOf(ShellError);
  });

  test('shell.tezos appends the path and refuses a redirect', async () => {
    const { call, hop } = setUp();
    await call('shell.tezos', {
      endpoint: 't1',
      method: 'POST',
      path: '/chains/main',
      body: '{"a":1}',
      generations: { tezos: 1 },
    });
    expect(hop).toHaveBeenCalledWith(
      'https://t1.tez.example/chains/main',
      expect.objectContaining({
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      })
    );
    const redirecting = setUp({
      hop: async () => ({ status: 303, headers: { location: 'https://x' }, body: Buffer.alloc(0) }),
    });
    await expect(
      redirecting.call('shell.tezos', { endpoint: 't1', path: '/', generations: { tezos: 1 } })
    ).rejects.toMatchObject({ code: 'refused' });
  });

  test("shell.gateway keeps ccipReadFetch's policy, headers and redirect refusal", async () => {
    const { call, hop } = setUp();
    await call('shell.gateway', {
      url: 'https://gw.example/x.json',
      method: 'POST',
      body: '{"d":1}',
      generations: { ens: 2 },
    });
    expect(hop).toHaveBeenCalledWith(
      'https://gw.example/x.json',
      expect.objectContaining({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      })
    );
    for (const url of [
      'http://gw.example/',
      'https://127.0.0.1/',
      'https://gw/',
      'https://a:b@gw.example/',
      'https://x.local/',
    ]) {
      expect(gatewayAllowed(url)).toBe(false);
      await expect(
        call('shell.gateway', { url, method: 'GET', generations: { ens: 2 } })
      ).rejects.toMatchObject({ code: 'refused' });
    }
    // redirect: 'error' refuses every redirect status with a Location; one
    // without is an ordinary answer.
    for (const status of [301, 302, 303, 307, 308]) {
      const redirecting = setUp({
        hop: async () => ({ status, headers: { location: 'https://x' }, body: Buffer.alloc(0) }),
      });
      await expect(
        redirecting.call('shell.gateway', {
          url: 'https://gw.example/',
          method: 'GET',
          generations: { ens: 2 },
        })
      ).rejects.toMatchObject({ code: 'refused' });
    }
    const bare = setUp({
      hop: async () => ({ status: 302, headers: {}, body: Buffer.alloc(0) }),
    });
    expect(
      await bare.call('shell.gateway', {
        url: 'https://gw.example/',
        method: 'GET',
        generations: { ens: 2 },
      })
    ).toEqual({ status: 302, body: '' });
  });

  test('shell.prefetch replies when the prefetch ends, and a cancel aborts it', async () => {
    let finish;
    const abort = jest.fn();
    const prefetch = jest.fn(() => ({ abort, done: new Promise((resolve) => (finish = resolve)) }));
    const { call } = setUp({ prefetch });
    const cancel = new AbortController();
    const pending = call(
      'shell.prefetch',
      { uri: 'ipfs://bafy', generations: { ens: 2 } },
      cancel.signal
    );
    await Promise.resolve();
    expect(prefetch).toHaveBeenCalledWith('ipfs://bafy');
    cancel.abort();
    expect(abort).toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toEqual({});
    // Cancelled before it started: it never does.
    const early = new AbortController();
    early.abort();
    await expect(
      call('shell.prefetch', { uri: 'ipfs://bafy', generations: { ens: 2 } }, early.signal)
    ).resolves.toEqual({});
    expect(prefetch).toHaveBeenCalledTimes(1);
  });
});
