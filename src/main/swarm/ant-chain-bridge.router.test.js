// The real chain-data router behind the real Ant bridge, over loopback
// sockets with real timers. Only the registry, Myotis, Colibri and fetch are
// stubbed. Ant's log scans are answered by the RPC quorum alone (#484): the
// provider's range-limit wording still reaches Ant (R2-F1 on PR #419), and no
// single RPC's answer settles a scan.
const http = require('node:http');

const mockRegistry = {
  getNetwork: jest.fn(),
  getEndpoints: jest.fn(),
  getEndpointSources: jest.fn(() => []),
  getEndpointSourceList: jest.fn(() => []),
};
jest.mock('../networks/network-registry', () => mockRegistry);
jest.mock('../myotis/myotis-manager', () => ({
  NETWORKS: new Map([[100, {}]]),
  isReady: jest.fn(() => false),
  markUnhealthy: jest.fn(),
  getStatus: jest.fn(() => ({})),
}));
jest.mock('../ens/colibri-resolver', () => ({
  requestViaColibri: jest.fn(async () => {
    throw new Error('Colibri unavailable');
  }),
}));
jest.mock('../logger', () => ({ verbose: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const router = require('../networks/chain-data-router');
const { startAntChainBridge } = require('./ant-chain-bridge');

const RPCS = ['https://a.example', 'https://b.example', 'https://c.example'];
const originalFetch = global.fetch;
let bridge;

function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const getLogs = { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{}] };

beforeEach(async () => {
  router.clearAdaptiveRoutingForTest();
  mockRegistry.getNetwork.mockReturnValue({
    access: { readOrder: ['myotis', 'colibri', 'quorum', 'direct'] },
    quorum: { k: 3, m: 2, timeoutMs: 500 },
  });
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'prover' ? ['https://prover.example'] : RPCS
  );
  bridge = await startAntChainBridge({ router, log: { info: jest.fn(), warn: jest.fn() } });
});
afterEach(async () => {
  await bridge.close();
  global.fetch = originalFetch;
});

test('forwards the range-limit error when quorum tried every RPC', async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      error: { code: -32005, message: 'query exceeds max block range 50000' },
    }),
  }));
  const { error } = await post(bridge.url, getLogs);
  expect(error.code).toBe(-32005);
  expect(error.message).toContain('max block range');
});

test('quorum members slower than the configured timeout still agree on a log scan', async () => {
  // Slower than the network's 500 ms quorum timeout, well inside the scan's
  // widened quorum budget.
  global.fetch = jest.fn(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: true, json: async () => ({ result: [] }) }), 700)
      )
  );
  const response = await post(bridge.url, getLogs);
  expect(response.result).toEqual([]);
  expect(global.fetch.mock.calls.map(([url]) => url)).toEqual(RPCS);
});

test('a single answering RPC does not settle a log scan', async () => {
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'prover' ? ['https://prover.example'] : [...RPCS, 'https://d.example']
  );
  global.fetch = jest.fn(async (url) => {
    if (url === 'https://a.example') return { ok: true, json: async () => ({ result: ['ok'] }) };
    throw new TypeError('fetch failed');
  });
  const response = await post(bridge.url, getLogs);
  expect(response.result).toBeUndefined();
  expect(response.error.message).not.toMatch(/range|limit|exceed|timeout/i);
});

test('with two quorum members down, a fourth RPC joins the scan', async () => {
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'prover' ? ['https://prover.example'] : [...RPCS, 'https://d.example']
  );
  global.fetch = jest.fn(async (url) => {
    if (url === 'https://a.example' || url === 'https://b.example') {
      throw new TypeError('fetch failed');
    }
    return { ok: true, json: async () => ({ result: ['ok'] }) };
  });
  const range = [{ fromBlock: '0x1', toBlock: '0x2710' }];
  const response = await post(bridge.url, { ...getLogs, params: range });
  expect(response.result).toEqual(['ok']);
  expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
    ...RPCS,
    'https://c.example',
    'https://d.example',
  ]);
});

test('an endpoint-specific error does not stop two agreeing answers', async () => {
  global.fetch = jest.fn(async (url) => {
    if (url === 'https://c.example') {
      return {
        ok: true,
        json: async () => ({
          error: { code: -32601, message: 'the method eth_getLogs does not exist' },
        }),
      };
    }
    return { ok: true, json: async () => ({ result: [] }) };
  });
  const response = await post(bridge.url, getLogs);
  expect(response).toMatchObject({ result: [] });
});
