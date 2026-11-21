// Unit tests for the chainlist.org catalog cache. `node:fs` is mocked
// (mockFiles maps a basename to its JSON string; absent = ENOENT), the cache
// is written through lib/atomic-file.js's mock into mockFiles
// (set-b-files.test.js tests the write on disk), and global `fetch` is
// stubbed per test. `electron` auto-resolves to the shared
// __mocks__/electron.js. Module-level cache state is reset by re-requiring
// the module in beforeEach.

const mockFiles = {};
jest.mock('node:fs', () => ({
  readFileSync: (filePath) => {
    const name = require('node:path').basename(filePath);
    if (!(name in mockFiles)) {
      throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
    }
    return mockFiles[name];
  },
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomicSync: (...args) => {
    mockFiles[require('node:path').basename(args[0])] = args[1];
    return { durable: true };
  },
}));

const CATALOG = [
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    shortName: 'eth',
    tvl: 100,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [
      { url: 'https://eth.llamarpc.com', tracking: 'none' },
      { url: 'https://mainnet.infura.io/v3/${INFURA_API_KEY}' },
      'wss://eth.example.com',
      'https://eth.llamarpc.com', // duplicate
    ],
    explorers: [{ name: 'etherscan', url: 'https://etherscan.io' }],
  },
  {
    chainId: 100,
    name: 'Gnosis',
    shortName: 'gno',
    tvl: 10,
    nativeCurrency: { symbol: 'xDAI', decimals: 18 },
    rpc: ['https://rpc.gnosischain.com'],
  },
  {
    chainId: 11155111,
    name: 'Sepolia',
    shortName: 'sep',
    tvl: 0,
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    rpc: [],
    isTestnet: true,
  },
];

function mockFetchOnce(data, { ok = true, status = 200 } = {}) {
  global.fetch = jest.fn().mockResolvedValue({ ok, status, json: async () => data });
}

let catalog;
beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  jest.resetModules();
  catalog = require('./chain-catalog');
});

describe('searchChains', () => {
  test('empty query returns chains sorted by TVL descending', async () => {
    mockFetchOnce(CATALOG);
    const hits = await catalog.searchChains('');
    expect(hits.map((c) => c.chainId)).toEqual([1, 100, 11155111]);
    expect(hits[0]).toMatchObject({ chainId: 1, name: 'Ethereum Mainnet', currency: 'ETH' });
  });

  test('name query is a case-insensitive substring match', async () => {
    mockFetchOnce(CATALOG);
    const hits = await catalog.searchChains('GNOS');
    expect(hits.map((c) => c.chainId)).toEqual([100]);
  });

  test('numeric query matches an exact chainId', async () => {
    mockFetchOnce(CATALOG);
    const hits = await catalog.searchChains('100');
    expect(hits.map((c) => c.chainId)).toEqual([100]);
  });

  test('rpcCount counts only usable https, non-placeholder URLs, deduped', async () => {
    mockFetchOnce(CATALOG);
    const [eth] = await catalog.searchChains('ethereum');
    expect(eth.rpcCount).toBe(1);
  });

  test('testnet flag is surfaced', async () => {
    mockFetchOnce(CATALOG);
    const [sepolia] = await catalog.searchChains('sepolia');
    expect(sepolia.isTestnet).toBe(true);
  });
});

describe('getCatalogChain', () => {
  test('returns a normalized record with filtered rpc urls', async () => {
    mockFetchOnce(CATALOG);
    expect(await catalog.getCatalogChain(1)).toEqual({
      chainId: 1,
      name: 'Ethereum Mainnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://eth.llamarpc.com'],
      explorerUrl: 'https://etherscan.io',
      isTestnet: false,
    });
  });

  test('unknown chainId returns null', async () => {
    mockFetchOnce(CATALOG);
    expect(await catalog.getCatalogChain(999)).toBeNull();
  });
});

describe('caching', () => {
  test('the catalog is fetched once across multiple calls', async () => {
    mockFetchOnce(CATALOG);
    await catalog.searchChains('eth');
    await catalog.searchChains('gno');
    await catalog.getCatalogChain(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('concurrent calls share a single in-flight fetch', async () => {
    mockFetchOnce(CATALOG);
    await Promise.all([
      catalog.searchChains('a'),
      catalog.searchChains('b'),
      catalog.getCatalogChain(1),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a fresh disk cache avoids a network fetch', async () => {
    mockFiles['chain-catalog.json'] = JSON.stringify({ fetchedAt: Date.now(), chains: CATALOG });
    global.fetch = jest.fn();
    await catalog.searchChains('eth');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a failed fetch falls back to a stale disk cache', async () => {
    mockFiles['chain-catalog.json'] = JSON.stringify({ fetchedAt: 0, chains: CATALOG });
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const hits = await catalog.searchChains('gnosis');
    expect(hits.map((c) => c.chainId)).toEqual([100]);
  });

  test('a non-ok response with no cache rejects', async () => {
    mockFetchOnce(null, { ok: false, status: 503 });
    await expect(catalog.searchChains('eth')).rejects.toThrow('HTTP 503');
  });
});
