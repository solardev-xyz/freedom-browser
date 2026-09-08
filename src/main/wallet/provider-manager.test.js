const http = require('http');

const mockGetEndpoints = jest.fn();
jest.mock('../networks/network-registry', () => ({
  getEndpoints: (...args) => mockGetEndpoints(...args),
  getNetwork: () => null,
  getAllNetworks: () => ({}),
  invalidate: jest.fn(),
}));

const { getEip1193Provider, clearProviderCache } = require('./provider-manager');

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
