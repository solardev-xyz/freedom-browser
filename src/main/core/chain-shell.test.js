const { ShellError } = require('./core-client');
const { makeHop } = require('./naming-shell');
const { netGatewayFetch } = require('../ipfs/gateway-transport');
const { MAX_LOOKUPS } = require('../networks/blockscout-logs');
const { FakeClientRequest } = require('../../../test/helpers/fake-electron-net');
const {
  registerChainShell,
  isChainRequest,
  NOT_SENT,
  ANSWER_BYTES,
  PAGE_BYTES,
} = require('./chain-shell');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));

const BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';
const MIB = 1024 * 1024;
const tick = () => new Promise(setImmediate);
const base64 = (text) => Buffer.from(text).toString('base64');

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

/** A hop's answer. */
const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: Buffer.from(body),
});

/**
 * The executors on a client that records their registrations: chain 1's
 * endpoints at generation 2, chain 100's at 5. `call` runs a handler as the
 * client does, `charge` standing in for main's pool.
 */
function setUp({ hop, lookup, charge = () => true } = {}) {
  const routes = [];
  const client = { handle: (method, fn, options) => routes.push({ method, fn, options }) };
  const endpoints = new Map([
    ['e1', { url: 'https://a.rpc.example', chainId: 1 }],
    ['e2', { url: 'http://public.example', chainId: 1 }],
    ['e3', { url: 'http://127.0.0.1:8545', chainId: 1 }],
    ['e4', { url: 'https://hidden.onion', chainId: 1 }],
    ['b1', { url: 'https://gnosis.blockscout.com/api', chainId: 100 }],
  ]);
  const generations = new Map([
    [1, 2],
    [100, 5],
  ]);
  const config = {
    endpoint: (ref) => endpoints.get(ref) ?? null,
    generation: (chainId) => generations.get(chainId) ?? 0,
  };
  hop = hop || jest.fn(async () => answer(200, '{"result":"0x1"}'));
  lookup = lookup || jest.fn(async () => [{ address: '104.18.12.34', family: 4 }]);
  registerChainShell(client, config, { hop, lookup });
  const call = (method, params, signal = new AbortController().signal) => {
    const route = routes.find((r) => r.method === method);
    expect(route.options.when(params)).toBe(true);
    return Promise.resolve().then(() => route.fn(params, { signal, charge }));
  };
  return { call, hop, lookup, routes, generations };
}

const rpc = (extra = {}) => ({
  endpoint: 'e1',
  body: BODY,
  policy: 'plain',
  max_bytes: ANSWER_BYTES,
  generation: 2,
  deadline_ms: 5000,
  ...extra,
});

const QUERY =
  '/v2/addresses/0x1111111111111111111111111111111111111111/token-transfers?type=ERC-20&filter=from&token=0xdbf3ea6f5bee45c02255b2c26a16f300502f68da&block_number=10001&index=0';
const page = (extra = {}) => ({
  endpoint: 'b1',
  query: QUERY,
  max_bytes: PAGE_BYTES,
  generation: 5,
  deadline_ms: 5000,
  ...extra,
});

/** The failure code a call ends with. */
const failure = (pending) =>
  pending.then(
    (result) => ({ result }),
    (err) => (err instanceof ShellError ? err.code : err)
  );

describe('the chain executors', () => {
  test("take the chain thread's requests, by their params, and leave naming's", () => {
    const { routes } = setUp();
    expect(routes.map((r) => r.method)).toEqual(['shell.rpc', 'shell.blockscout']);
    expect(isChainRequest({ generation: 1 })).toBe(true);
    expect(isChainRequest({})).toBe(true);
    expect(isChainRequest({ generations: { ens: 1 } })).toBe(false);
  });
});

describe('shell.rpc', () => {
  test('one POST of the body to the endpoint behind the reference, answered in base64', async () => {
    const { call, hop } = setUp();
    expect(await call('shell.rpc', rpc())).toEqual({
      status: 200,
      body: base64('{"result":"0x1"}'),
    });
    expect(hop).toHaveBeenCalledTimes(1);
    expect(hop).toHaveBeenCalledWith(
      'https://a.rpc.example',
      expect.objectContaining({
        method: 'POST',
        body: BODY,
        headers: { 'content-type': 'application/json' },
        max: ANSWER_BYTES,
      })
    );
  });

  test('a 429 is the answer: no back-off, no second attempt', async () => {
    const hop = jest.fn(async () => answer(429, '', { 'retry-after': '1' }));
    const { call } = setUp({ hop });
    expect(await call('shell.rpc', rpc())).toEqual({ status: 429, body: '' });
    expect(hop).toHaveBeenCalledTimes(1);
  });

  test('a non-2xx answer is its status, its body cancelled unread', async () => {
    for (const status of [500, 404, 401]) {
      const { stream, state } = endless('x'.repeat(100));
      const { call } = setUp({
        hop: makeHop({ fetch: jest.fn(async () => new Response(stream, { status })) }),
      });
      expect(await call('shell.rpc', rpc())).toEqual({ status, body: '' });
      await tick();
      expect(state.cancelled).toBe(true);
    }
  });

  test("redirects follow naming's rule: method and body kept, each hop checked", async () => {
    const hop = jest
      .fn()
      .mockResolvedValueOnce(answer(307, '', { location: 'https://b.rpc.example/x' }))
      .mockResolvedValueOnce(answer(200, 'ok'));
    const { call } = setUp({ hop });
    expect(await call('shell.rpc', rpc())).toEqual({ status: 200, body: base64('ok') });
    expect(hop.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ['https://a.rpc.example', 'POST', BODY],
      ['https://b.rpc.example/x', 'POST', BODY],
    ]);
    // A hop the endpoint policy refuses: `refused`, after a send.
    const refusing = setUp({
      hop: jest.fn(async () => answer(302, '', { location: 'https://10.0.0.1/' })),
    });
    expect(await failure(refusing.call('shell.rpc', rpc()))).toBe('refused');
    // A relative redirect, or a downgrade to http, is the answer itself.
    for (const location of ['/elsewhere', 'http://b.rpc.example/']) {
      const kept = setUp({ hop: jest.fn(async () => answer(302, '', { location })) });
      expect(await kept.call('shell.rpc', rpc())).toEqual({ status: 302, body: '' });
    }
  });

  test('main performs nothing for a stale generation or an unknown reference: not_sent', async () => {
    const { call, hop } = setUp();
    for (const params of [
      rpc({ generation: 1 }),
      rpc({ generation: '2' }),
      rpc({ generation: undefined }),
      rpc({ endpoint: 'nope' }),
      rpc({ endpoint: undefined }),
    ]) {
      expect(await call('shell.rpc', params)).toEqual(NOT_SENT);
    }
    expect(hop).not.toHaveBeenCalled();
    // A generation main hasn't seen yet is newer, never stale.
    expect(await call('shell.rpc', rpc({ generation: 3 }))).toMatchObject({ status: 200 });
  });

  test('nor for an endpoint refused before connecting, or a request cancelled first', async () => {
    const { call, hop } = setUp();
    // Plain http off this machine: the endpoint policy refuses it.
    expect(await call('shell.rpc', rpc({ endpoint: 'e2' }))).toEqual(NOT_SENT);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await call('shell.rpc', rpc(), cancelled.signal)).toEqual(NOT_SENT);
    expect(hop).not.toHaveBeenCalled();
    // Loopback http is allowed.
    await call('shell.rpc', rpc({ endpoint: 'e3' }));
    expect(hop).toHaveBeenCalledWith('http://127.0.0.1:8545', expect.anything());
  });

  /** The session's own transport, its proxy lookup answering `proxy`, and
   * `requestImpl` for the requests it makes. */
  const session = ({ proxy = 'DIRECT', requestImpl = jest.fn() } = {}) =>
    makeHop({
      fetch: (url, init) =>
        netGatewayFetch(url, init, { resolveProxy: async () => proxy, requestImpl }),
    });

  test("the onion gate's refusal of the first hop is not_sent; of a later hop, refused", async () => {
    const requestImpl = jest.fn();
    const first = setUp({ hop: session({ requestImpl }) });
    expect(await first.call('shell.rpc', rpc({ endpoint: 'e4' }))).toEqual(NOT_SENT);
    expect(requestImpl).not.toHaveBeenCalled();
    // After a hop that was sent, the gate's refusal proves nothing more.
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: 'https://next.onion/' } })
      )
      .mockImplementationOnce((url, init) =>
        netGatewayFetch(url, init, { resolveProxy: async () => 'DIRECT', requestImpl })
      );
    const later = setUp({ hop: makeHop({ fetch }) });
    expect(await failure(later.call('shell.rpc', rpc()))).toBe('refused');
    expect(fetch).toHaveBeenCalledTimes(2);
    // Any other failure may have followed a send.
    const reset = setUp({
      hop: makeHop({ fetch: jest.fn(async () => Promise.reject(new Error('ECONNRESET'))) }),
    });
    expect(await failure(reset.call('shell.rpc', rpc()))).toBe('network');
  });

  // Review of #692 (security, M1): only the gate's own refusal is evidence;
  // text naming it is not.
  test('a request that fails once written is the network, whatever its error says', async () => {
    const written = [];
    const requestImpl = jest.fn((options) => {
      const request = new FakeClientRequest(options);
      request.write = (chunk) => written.push(Buffer.from(chunk));
      request.end = () =>
        setImmediate(() =>
          request.emit('error', new Error('.onion gateway connection lost after the write'))
        );
      return request;
    });
    const { call } = setUp({ hop: session({ requestImpl }) });
    expect(await failure(call('shell.rpc', rpc()))).toBe('network');
    expect(Buffer.concat(written).toString()).toBe(BODY);
  });

  test('a body that fails after the answer began is the network, whatever its error says', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('{"res')));
      },
      pull(controller) {
        controller.error(new Error('.onion gateway read failed'));
      },
    });
    const { call } = setUp({ hop: makeHop({ fetch: jest.fn(async () => new Response(body)) }) });
    expect(await failure(call('shell.rpc', rpc()))).toBe('network');
  });

  test('the answer cap is the smaller of max_bytes and 18 MiB, enforced while reading', async () => {
    const { call, hop } = setUp();
    await call('shell.rpc', rpc({ max_bytes: 64 * MIB }));
    expect(hop.mock.calls[0][1].max).toBe(18 * MIB);
    await call('shell.rpc', rpc({ max_bytes: 1000 }));
    expect(hop.mock.calls[1][1].max).toBe(1000);
    const over = setUp({
      hop: makeHop({
        fetch: jest.fn(async () => new Response(new Blob(['x'.repeat(600), 'y'.repeat(600)]))),
      }),
    });
    expect(await failure(over.call('shell.rpc', rpc({ max_bytes: 1000 })))).toBe('too_large');
    const declared = setUp({
      hop: makeHop({
        fetch: jest.fn(
          async () => new Response('x', { headers: { 'content-length': String(19 * MIB) } })
        ),
      }),
    });
    expect(await failure(declared.call('shell.rpc', rpc({ max_bytes: 32 * MIB })))).toBe(
      'too_large'
    );
  });

  test("a body past main's pool is busy, its stream cancelled", async () => {
    const { stream, state } = endless('x'.repeat(1000));
    const charged = [];
    const { call } = setUp({
      hop: makeHop({ fetch: jest.fn(async () => new Response(stream)) }),
      charge: (bytes) => {
        charged.push(bytes);
        return false;
      },
    });
    expect(await failure(call('shell.rpc', rpc()))).toBe('busy');
    expect(charged).toEqual([1000]);
    await tick();
    expect(state.cancelled).toBe(true);
  });

  test('a request main cannot read is refused, before anything is sent', async () => {
    const { call, hop } = setUp();
    for (const params of [
      rpc({ policy: 'ethers' }),
      rpc({ policy: undefined }),
      rpc({ body: { method: 'x' } }),
      rpc({ max_bytes: -1 }),
      rpc({ max_bytes: 1.5 }),
      rpc({ max_bytes: undefined }),
    ]) {
      expect(await failure(call('shell.rpc', params))).toBe('refused');
    }
    expect(hop).not.toHaveBeenCalled();
  });

  test('past its deadline it is timeout; cancelled by the core, cancelled', async () => {
    const hang = jest.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    const { call } = setUp({ hop: hang });
    expect(await failure(call('shell.rpc', rpc({ deadline_ms: 5 })))).toBe('timeout');
    const cancel = new AbortController();
    const pending = failure(call('shell.rpc', rpc(), cancel.signal));
    await tick();
    cancel.abort();
    expect(await pending).toBe('cancelled');
  });

  test("every other failure is one of the chain thread's codes, never internal", async () => {
    for (const thrown of [
      new TypeError('boom'),
      new ShellError('internal'),
      new ShellError('unknown_method'),
      'a string',
    ]) {
      const { call } = setUp({ hop: jest.fn(async () => Promise.reject(thrown)) });
      expect(await failure(call('shell.rpc', rpc()))).toBe('network');
    }
  });
});

describe('shell.blockscout', () => {
  const URL_OF_PAGE = `https://gnosis.blockscout.com/api${QUERY}`;

  test("one GET of the endpoint's page: status, the headers the core reads, the body", async () => {
    const hop = jest.fn(async () =>
      answer(200, '{"items":[],"next_page_params":null}', {
        'content-length': '36',
        'x-ratelimit-reset': '1000',
        'retry-after': '5',
        'x-ratelimit-limit': '180',
        'set-cookie': 'a=b',
        'content-type': 'application/json',
        server: 'nginx',
        date: 'today',
        via: 'proxy',
        'cache-control': 'no-store',
      })
    );
    const { call } = setUp({ hop });
    expect(await call('shell.blockscout', page())).toEqual({
      status: 200,
      headers: { 'content-length': '36', 'x-ratelimit-reset': '1000', 'retry-after': '5' },
      body: base64('{"items":[],"next_page_params":null}'),
    });
    expect(hop).toHaveBeenCalledWith(
      URL_OF_PAGE,
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        max: PAGE_BYTES,
      })
    );
  });

  test('sends only the headers the page has, and none it lacks', async () => {
    const { call } = setUp({ hop: jest.fn(async () => answer(429, '', { 'retry-after': '7' })) });
    expect(await call('shell.blockscout', page())).toEqual({
      status: 429,
      headers: { 'retry-after': '7' },
      body: '',
    });
    const bare = setUp({ hop: jest.fn(async () => answer(200, '{}')) });
    expect((await bare.call('shell.blockscout', page())).headers).toEqual({});
  });

  test('a non-2xx page is answered unread, its status for the core to judge', async () => {
    const { stream, state } = endless('x');
    const { call } = setUp({
      hop: makeHop({ fetch: jest.fn(async () => new Response(stream, { status: 503 })) }),
    });
    expect(await call('shell.blockscout', page())).toEqual({ status: 503, headers: {}, body: '' });
    await tick();
    expect(state.cancelled).toBe(true);
  });

  test('a redirect on its origin is followed, unresolved; off it, after the name resolves', async () => {
    const hop = jest
      .fn()
      .mockResolvedValueOnce(answer(301, '', { location: '/api/v2/other?x=1' }))
      .mockResolvedValueOnce(answer(302, '', { location: 'https://gnosisscan.io/api' }))
      .mockResolvedValueOnce(answer(200, '{}'));
    const { call, lookup } = setUp({ hop });
    expect(await call('shell.blockscout', page())).toMatchObject({ status: 200 });
    expect(hop.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [URL_OF_PAGE, 'GET'],
      ['https://gnosis.blockscout.com/api/v2/other?x=1', 'GET'],
      ['https://gnosisscan.io/api', 'GET'],
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('gnosisscan.io', { all: true, verbatim: true });
  });

  test.each([
    ['off https', { location: 'http://gnosis.blockscout.com/api' }],
    ['without a location', {}],
    ['to a malformed location', { location: 'https://[' }],
    ['to a local host', { location: 'https://192.168.1.1/api' }],
    ['to localhost', { location: 'https://localhost/api' }],
    ['to an onion name', { location: 'https://wallet.onion/api' }],
  ])('a redirect %s is refused before it is dialled', async (_name, headers) => {
    const hop = jest.fn(async () => answer(302, '', headers));
    const { call, lookup } = setUp({ hop });
    expect(await failure(call('shell.blockscout', page()))).toBe('refused');
    expect(hop).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  test.each([
    ['resolves to a local address', async () => [{ address: '127.0.0.1', family: 4 }]],
    [
      'does not resolve',
      async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    ],
  ])('a redirect to a name that %s is refused', async (_name, resolve) => {
    const hop = jest.fn(async () => answer(302, '', { location: 'https://evil.example/api' }));
    const { call } = setUp({ hop, lookup: jest.fn(resolve) });
    expect(await failure(call('shell.blockscout', page()))).toBe('refused');
    expect(hop).toHaveBeenCalledTimes(1);
  });

  test('at most three redirects', async () => {
    const hop = jest.fn(async () => answer(302, '', { location: '/api?again=1' }));
    const { call } = setUp({ hop });
    expect(await failure(call('shell.blockscout', page()))).toBe('refused');
    expect(hop).toHaveBeenCalledTimes(4);
  });

  test('a browser-style opaque redirect is refused', async () => {
    const opaque = {
      type: 'opaqueredirect',
      status: 0,
      headers: new Headers(),
      body: null,
    };
    const { call } = setUp({ hop: makeHop({ fetch: jest.fn(async () => opaque) }) });
    expect(await failure(call('shell.blockscout', page()))).toBe('refused');
  });

  // Review of #692 (security, N1).
  test('lookups a cancel left running keep their slots: past the bound, busy', async () => {
    const settle = [];
    const lookup = jest.fn(
      () =>
        new Promise((resolve) => {
          settle.push(resolve);
        })
    );
    const hop = jest.fn(async (url) =>
      url.startsWith('https://gnosis.blockscout.com/')
        ? answer(302, '', { location: 'https://gnosisscan.io/api' })
        : answer(200, '{}')
    );
    const { call } = setUp({ hop, lookup });
    // Waves of pages, each cancelled while its redirect's lookup runs on.
    const wave = async (size) => {
      const cancels = Array.from({ length: size }, () => new AbortController());
      const pending = cancels.map((cancel) =>
        failure(call('shell.blockscout', page(), cancel.signal))
      );
      await tick();
      for (const cancel of cancels) cancel.abort();
      return Promise.all(pending);
    };
    for (let i = 0; i < MAX_LOOKUPS / 16; i++) {
      expect(new Set(await wave(16))).toEqual(new Set(['cancelled']));
    }
    expect(lookup).toHaveBeenCalledTimes(MAX_LOOKUPS);
    // Every slot is still held: the next page that needs one is busy, and
    // no lookup starts.
    expect(await failure(call('shell.blockscout', page()))).toBe('busy');
    expect(lookup).toHaveBeenCalledTimes(MAX_LOOKUPS);
    // Once they settle, the slots come back.
    for (const resolve of settle) resolve([{ address: '104.18.12.34', family: 4 }]);
    lookup.mockImplementation(async () => [{ address: '104.18.12.34', family: 4 }]);
    await tick();
    expect(await call('shell.blockscout', page())).toMatchObject({ status: 200 });
    expect(lookup).toHaveBeenCalledTimes(MAX_LOOKUPS + 1);
  });

  test('a hung lookup ends at the deadline, as timeout', async () => {
    const hop = jest.fn(async () => answer(302, '', { location: 'https://slow.example/api' }));
    const { call } = setUp({ hop, lookup: jest.fn(() => new Promise(() => {})) });
    expect(await failure(call('shell.blockscout', page({ deadline_ms: 5 })))).toBe('timeout');
  });

  test('a page over the cap is too_large; the cap is at most 8 MiB', async () => {
    const { call, hop } = setUp();
    await call('shell.blockscout', page({ max_bytes: 32 * MIB }));
    expect(hop.mock.calls[0][1].max).toBe(8 * MIB);
    const over = setUp({
      hop: makeHop({ fetch: jest.fn(async () => new Response('x'.repeat(2000))) }),
    });
    expect(await failure(over.call('shell.blockscout', page({ max_bytes: 1000 })))).toBe(
      'too_large'
    );
  });

  test('stale, unknown or cancelled first: not_sent; a query off the endpoint: refused', async () => {
    const { call, hop } = setUp();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await call('shell.blockscout', page({ generation: 4 }))).toEqual(NOT_SENT);
    expect(await call('shell.blockscout', page({ endpoint: 'nope' }))).toEqual(NOT_SENT);
    expect(await call('shell.blockscout', page(), cancelled.signal)).toEqual(NOT_SENT);
    for (const query of ['v2/addresses', '?x=1', undefined, 7]) {
      expect(await failure(call('shell.blockscout', page({ query })))).toBe('refused');
    }
    expect(await failure(call('shell.blockscout', page({ max_bytes: undefined })))).toBe('refused');
    expect(hop).not.toHaveBeenCalled();
  });
});
