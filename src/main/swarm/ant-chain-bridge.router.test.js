// The real chain-data router behind the real Ant bridge. Only the registry,
// Myotis, Colibri and fetch are stubbed. Pins that Ant's log scan still sees
// the provider's range-limit wording when quorum already used every RPC
// endpoint (no URL left for Direct) — R2-F1 on PR #419.
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

test('gives RPCs quorum cut off at its timeout the longer log-scan budget', async () => {
  global.fetch = jest.fn((_url, { signal }) => {
    if (global.fetch.mock.calls.length <= 3) {
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      );
    }
    // Slower than quorum's 500 ms budget, well inside the 60 s scan budget.
    return new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, json: async () => ({ result: [] }) }), 700)
    );
  });
  const response = await post(bridge.url, getLogs);
  expect(response.result).toEqual([]);
  expect(global.fetch.mock.calls[3][0]).toBe(RPCS[0]);
});

// R3-F1 at 10x-scaled timings (quorum 500 ms, bridge deadline 1.2 s, Direct
// 60 s budget): with the first three endpoints hanging, the healthy fourth is
// reached right after quorum instead of after two long retries.
test('reaches a healthy fourth RPC before the bridge deadline', async () => {
  await bridge.close();
  bridge = await startAntChainBridge({
    router,
    log: { info: jest.fn(), warn: jest.fn() },
    timeoutMs: 1200,
  });
  const FOUR = [...RPCS, 'https://d.example'];
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'prover' ? ['https://prover.example'] : FOUR
  );
  global.fetch = jest.fn((url, { signal }) => {
    if (url === 'https://d.example') {
      return Promise.resolve({ ok: true, json: async () => ({ result: ['ok'] }) });
    }
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      )
    );
  });
  const response = await post(bridge.url, getLogs);
  expect(response.result).toEqual(['ok']);
  expect(global.fetch.mock.calls[3][0]).toBe('https://d.example');
});
