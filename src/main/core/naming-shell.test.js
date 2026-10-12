const { ethers } = require('ethers');
const { ShellError } = require('./core-client');
const {
  registerNamingShell,
  fetchLoop,
  makeHop,
  gatewayAllowed,
  MAX_ATTEMPTS,
} = require('./naming-shell');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));

const START = 'https://a.rpc.example/';
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

  test('an answer over the cap is too_large', async () => {
    const hop = makeHop({ fetch: fakeFetch({ chunks: ['x'.repeat(10)] }) });
    await expect(hop('https://a.example', { max: 9 })).rejects.toMatchObject({ code: 'too_large' });
  });

  test('a network failure, an onion refusal and inactivity', async () => {
    await expect(
      makeHop({ fetch: fakeFetch({ fail: new Error('ECONNRESET') }) })('https://a.example', {})
    ).rejects.toMatchObject({ code: 'network' });
    const onion = new Error('.onion gateway is not routed through a proxy (resolveProxy: DIRECT)');
    await expect(
      makeHop({ fetch: fakeFetch({ fail: onion }) })('https://a.onion', {})
    ).rejects.toMatchObject({ code: 'refused' });
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
    const redirecting = setUp({
      hop: async () => ({ status: 302, headers: { location: 'https://x' }, body: Buffer.alloc(0) }),
    });
    await expect(
      redirecting.call('shell.gateway', {
        url: 'https://gw.example/',
        method: 'GET',
        generations: { ens: 2 },
      })
    ).rejects.toMatchObject({ code: 'refused' });
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
