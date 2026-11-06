const http = require('http');
const util = require('util');

const mockGetEndpoints = jest.fn();
jest.mock('../networks/network-registry', () => ({
  getEndpoints: (...args) => mockGetEndpoints(...args),
  getNetwork: (chainId) =>
    Number(chainId) === 100 ? { chainId: 100, name: 'Gnosis', nativeSymbol: 'xDAI' } : null,
  getAllNetworks: () => ({}),
  invalidate: jest.fn(),
}));

const log = require('../logger');
const { getEip1193Provider, clearProviderCache, testProvider } = require('./provider-manager');

/** Minimal JSON-RPC server; `handler` returns a result or throws. */
function startRpcServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { id, method, params } = JSON.parse(body);
        try {
          const result = handler(method, params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } catch (err) {
          res.writeHead(500);
          res.end(err.message);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('getEip1193Provider', () => {
  const servers = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    mockGetEndpoints.mockReset();
    clearProviderCache();
  });

  test('serves requests from the first healthy endpoint', async () => {
    const healthy = await startRpcServer((method) => {
      if (method === 'eth_chainId') return '0x64';
      throw new Error('unexpected method');
    });
    servers.push(healthy.server);
    mockGetEndpoints.mockReturnValue([healthy.url]);

    const provider = getEip1193Provider(100);
    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe('0x64');
    expect(mockGetEndpoints).toHaveBeenCalledWith(100, 'rpc');
  });

  test('fails over to the next endpoint when one errors', async () => {
    const broken = await startRpcServer(() => {
      throw new Error('boom');
    });
    const healthy = await startRpcServer(() => '0x64');
    servers.push(broken.server, healthy.server);
    mockGetEndpoints.mockReturnValue([broken.url, healthy.url]);

    const provider = getEip1193Provider(100);
    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe('0x64');
  });

  test('surfaces the last error when every endpoint fails', async () => {
    const broken = await startRpcServer(() => {
      throw new Error('boom');
    });
    servers.push(broken.server);
    mockGetEndpoints.mockReturnValue([broken.url]);

    const provider = getEip1193Provider(100);
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow();
  });

  test('is cached per chain and invalidated with the provider cache', async () => {
    const healthy = await startRpcServer(() => '0x64');
    servers.push(healthy.server);
    mockGetEndpoints.mockReturnValue([healthy.url]);

    expect(getEip1193Provider(100)).toBe(getEip1193Provider(100));
    expect(mockGetEndpoints).toHaveBeenCalledTimes(1);

    clearProviderCache(100);
    getEip1193Provider(100);
    expect(mockGetEndpoints).toHaveBeenCalledTimes(2);
  });

  test('throws when the chain has no configured endpoints', () => {
    mockGetEndpoints.mockReturnValue([]);
    expect(() => getEip1193Provider(999)).toThrow(/No RPC endpoints/);
  });
});

// A keyed provider's URL carries the user's API key in its path (#1040).
// Built at runtime, so no key-shaped literal sits in the source.
const KEY = ['rpc', 'key', 'sentinel', process.pid.toString(36)].join('-');

/**
 * An endpoint that answers HTTP `status` and quotes the URL it was asked
 * at in its body, after `healthy` good answers.
 */
function startFailingServer({ status = 403, healthy = 0 } = {}) {
  let answered = 0;
  const hits = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { id, method } = JSON.parse(body);
        hits.push(method);
        if (answered < healthy) {
          answered += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x10' }));
          return;
        }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `refused http://${req.headers.host}${req.url}` }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, origin, hits });
    });
  });
}

/** Everything an error carries, own properties and causes included. */
function everything(err) {
  return [
    util.inspect(err, { depth: 10, showHidden: true }),
    JSON.stringify(err, (_key, value) => (typeof value === 'bigint' ? String(value) : value)),
    String(err?.message),
    String(err?.shortMessage),
    util.inspect(err?.info, { depth: 10 }),
    util.inspect(err?.cause, { depth: 10 }),
  ].join('\n');
}

describe("main's providers throw no RPC URL (#1040)", () => {
  const servers = [];
  let warn;

  beforeEach(() => {
    warn = jest.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await Promise.all(
      servers.splice(0).map((s) => {
        s.closeAllConnections();
        return new Promise((r) => s.close(r));
      })
    );
    mockGetEndpoints.mockReset();
    clearProviderCache();
  });

  async function keyedPool(...shape) {
    const urls = [];
    for (const entry of shape) {
      const { server, origin, hits } = await startFailingServer(entry);
      servers.push(server);
      urls.push({ url: entry.keyed ? `${origin}/v2/${KEY}` : `${origin}/public`, hits });
    }
    mockGetEndpoints.mockReturnValue(urls.map(({ url }) => url));
    return urls;
  }

  function expectNoUrl(text, urls) {
    expect(text).not.toContain(KEY);
    for (const { url } of urls) {
      expect(text).not.toContain(url);
      expect(text).not.toContain(new URL(url).pathname);
    }
  }

  test.each([
    ['a single keyed endpoint', [{ keyed: true }]],
    ['a keyed endpoint that fails last', [{ keyed: false, status: 500 }, { keyed: true }]],
    ['a keyed endpoint that fails first', [{ keyed: true }, { keyed: false, status: 502 }]],
  ])('the EIP-1193 view: %s', async (_name, shape) => {
    const urls = await keyedPool(...shape);
    const error = await getEip1193Provider(100)
      .request({ method: 'eth_getCode', params: ['0x' + '11'.repeat(20), 'latest'] })
      .then(
        () => null,
        (err) => err
      );

    expect(error).toBeInstanceOf(Error);
    for (const { hits } of urls) expect(hits).toEqual(['eth_getCode']);
    expect(error.code).toBe('RPC_UNAVAILABLE');
    const lastStatus = shape[shape.length - 1].status ?? 403;
    expect(error.message).toBe(`No RPC endpoint for Gnosis answered (last: HTTP ${lastStatus})`);
    expect(Object.keys(error)).toEqual(['code']);
    expect(error.cause).toBeUndefined();
    expectNoUrl(everything(error), urls);
  });

  test("the node's JSON-RPC error keeps its code, text and data, and nothing else", async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { id } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: 3, message: 'execution reverted', data: '0x08c379a0' },
          })
        );
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const url = `http://127.0.0.1:${server.address().port}/v2/${KEY}`;
    mockGetEndpoints.mockReturnValue([url]);

    const error = await getEip1193Provider(100)
      .request({
        method: 'eth_call',
        params: [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest'],
      })
      .catch((err) => err);
    expect(error).toMatchObject({ message: 'execution reverted', code: 3, data: '0x08c379a0' });
    expect(Object.keys(error).sort()).toEqual(['code', 'data']);
    expectNoUrl(everything(error), [{ url }]);
  });

  test("wallet:test-provider's FallbackProvider fails without the URL", async () => {
    // A first good answer syncs the FallbackProvider; ethers then quotes the
    // next failure (`invalid numeric value`, value = the provider's error).
    const urls = await keyedPool({ keyed: true, healthy: 1 });
    await expect(testProvider(100)).resolves.toEqual({ success: true, blockNumber: 16 });
    // Past ethers' 250 ms cache of a block number.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const failed = await testProvider(100);
    expect(urls[0].hits.length).toBeGreaterThan(1);
    expect(failed).toEqual({
      success: false,
      error: 'No RPC endpoint for Gnosis answered',
      code: 'RPC_UNAVAILABLE',
    });
    expectNoUrl(JSON.stringify(failed), urls);
  });

  test('wallet:test-provider, with no endpoint answering from the start', async () => {
    const urls = await keyedPool({ keyed: true });
    const failed = await testProvider(100);
    expect(failed).toMatchObject({ success: false, code: 'RPC_UNAVAILABLE' });
    expectNoUrl(JSON.stringify(failed), urls);
  });

  test("main's log keeps the failure, its URLs cut to their origin", async () => {
    const urls = await keyedPool({ keyed: true });
    await getEip1193Provider(100)
      .request({ method: 'eth_chainId' })
      .catch(() => {});

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('RPC request failed (chain 100, eth_chainId)');
    expect(logged).toContain('403');
    expect(logged).toContain(`${new URL(urls[0].url).origin}/[path redacted]`);
    expectNoUrl(logged, urls);
  });
});
