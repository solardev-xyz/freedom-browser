// The chainlist catalog host (#503 item 12): searches run in the real
// chain-catalog-worker.js, which reads a fresh disk cache from a temp
// userData dir (no network), or on the main thread when the worker cannot
// run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-catalog-host-'));
jest.mock('electron', () => ({ app: { getPath: () => mockUserData } }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('../logger');
const catalog = require('./chain-catalog');
const host = require('./chain-catalog-host');

const CHAINS = [
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    shortName: 'eth',
    tvl: 100,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [{ url: 'https://eth.llamarpc.com' }],
    explorers: [{ url: 'https://etherscan.io' }],
  },
  {
    chainId: 100,
    name: 'Gnosis',
    shortName: 'gno',
    tvl: 10,
    nativeCurrency: { symbol: 'xDAI', decimals: 18 },
    rpc: ['https://rpc.gnosischain.com'],
  },
];

beforeAll(() => {
  fs.writeFileSync(
    path.join(mockUserData, catalog.CACHE_FILE),
    JSON.stringify({ fetchedAt: Date.now(), chains: CHAINS })
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  host.catalogWorker.resetForTest();
});

afterAll(() => {
  host.catalogWorker.resetForTest();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

test('searches and lookups run in the worker', async () => {
  const run = jest.spyOn(host.catalogWorker, 'run');
  const searchOnMain = jest.spyOn(catalog, 'searchChains');
  const getOnMain = jest.spyOn(catalog, 'getCatalogChain');

  await expect(host.searchChains('GNO')).resolves.toEqual([
    { chainId: 100, name: 'Gnosis', currency: 'xDAI', isTestnet: false, rpcCount: 1 },
  ]);
  await expect(host.getCatalogChain('1')).resolves.toMatchObject({
    chainId: 1,
    rpcUrls: ['https://eth.llamarpc.com'],
    explorerUrl: 'https://etherscan.io',
  });
  await expect(host.getCatalogChain(999)).resolves.toBeNull();

  expect(run.mock.calls.map(([op]) => op)).toEqual(['search', 'get', 'get']);
  // The main thread's copy of the module never loaded the catalog.
  expect(searchOnMain).not.toHaveBeenCalled();
  expect(getOnMain).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
  run.mockRestore();
  searchOnMain.mockRestore();
  getOnMain.mockRestore();
});

test('falls back to the main thread only when the worker cannot run', async () => {
  host.catalogWorker.resetForTest({ path: path.join(mockUserData, 'missing-worker.js') });
  await expect(host.searchChains('eth')).resolves.toEqual([
    expect.objectContaining({ chainId: 1 }),
  ]);
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[ChainCatalog] worker'));
});

test('a catalog error in the worker reaches the caller', async () => {
  const failing = path.join(mockUserData, 'failing-worker.js');
  fs.writeFileSync(
    failing,
    `require('node:worker_threads').parentPort.on('message', function (m) {
       this.postMessage({ id: m.id, ok: false, error: 'HTTP 503' });
     });`
  );
  host.catalogWorker.resetForTest({ path: failing });
  const searchOnMain = jest.spyOn(catalog, 'searchChains');
  await expect(host.searchChains('eth')).rejects.toThrow('HTTP 503');
  expect(searchOnMain).not.toHaveBeenCalled();
  searchOnMain.mockRestore();
});
