// Unit tests for the network registry — layer merging and endpoint
// resolution. `node:fs` is mocked: mockFiles maps a basename to its JSON
// string; an absent entry simulates ENOENT (the file-not-present state).
// `electron` resolves to the shared __mocks__/electron.js (isPackaged
// false, a stub getPath) — the fs mock dispatches by basename, so the
// userData directory value is irrelevant here.

const mockFiles = {};
const mockWriteFileSync = jest.fn();
jest.mock('node:fs', () => ({
  readFileSync: (filePath) => {
    const name = require('node:path').basename(filePath);
    if (!(name in mockFiles)) {
      throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
    }
    return mockFiles[name];
  },
  writeFileSync: (...args) => {
    mockWriteFileSync(...args);
    mockFiles[require('node:path').basename(args[0])] = args[1];
  },
}));

const registry = require('./network-registry');

// --- fixtures ---------------------------------------------------------
const CHAINS = {
  '1': {
    chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH',
    verification: { primary: 'colibri' },
    quorum: { k: 3, m: 2, timeoutMs: 5000, anchor: 'latest' },
    zkProof: true,
  },
  '100': {
    chainId: 100, name: 'Gnosis', nativeSymbol: 'xDAI',
    verification: { primary: 'quorum' },
    quorum: { k: 3, m: 2, timeoutMs: 5000, anchor: 'latest' },
  },
};

const SOURCES = {
  'colibri-corpus': { role: 'prover', keyed: false, coverage: { '1': 'https://prover.example' } },
  'eth-public': { role: 'rpc', keyed: false, coverage: { '1': 'https://eth.public.example' } },
  'gno-public': { role: 'rpc', keyed: false, coverage: { '100': 'https://gno.public.example' } },
  'alchemy': {
    role: 'rpc', keyed: true,
    coverage: {
      '1': 'https://eth.alchemy.example/v2/{API_KEY}',
      '100': 'https://gno.alchemy.example/v2/{API_KEY}',
    },
  },
};

function setFiles({ chains = CHAINS, sources = SOURCES, custom, userConfig, apiKeys, settings } = {}) {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  mockFiles['chains.json'] = JSON.stringify(chains);
  mockFiles['endpoint-sources.json'] = JSON.stringify(sources);
  if (custom !== undefined) mockFiles['custom-chains.json'] = JSON.stringify(custom);
  if (userConfig !== undefined) mockFiles['network-config.json'] = JSON.stringify(userConfig);
  if (apiKeys !== undefined) mockFiles['rpc-api-keys.json'] = JSON.stringify(apiKeys);
  if (settings !== undefined) mockFiles['settings.json'] = JSON.stringify(settings);
  mockWriteFileSync.mockClear();
  registry.invalidate();
}

beforeEach(() => setFiles());

describe('getNetwork / getAllNetworks', () => {
  test('returns a builtin network by id', () => {
    expect(registry.getNetwork(1)).toMatchObject({
      name: 'Ethereum',
      verification: { primary: 'colibri' },
      zkProof: true,
    });
  });

  test('accepts numeric or string chain id', () => {
    expect(registry.getNetwork('1')).toEqual(registry.getNetwork(1));
  });

  test('returns null for an unknown chain', () => {
    expect(registry.getNetwork(999)).toBeNull();
  });

  test('getAllNetworks merges builtin + custom chains', () => {
    setFiles({ custom: { '8453': { chainId: 8453, name: 'Base', verification: { primary: 'quorum' } } } });
    expect(Object.keys(registry.getAllNetworks()).sort()).toEqual(['1', '100', '8453']);
    expect(registry.getNetwork(8453).name).toBe('Base');
  });

  test('a custom chain with no verification block defaults to direct', () => {
    // custom-chains.json is user-writable and bypasses migration — getNetwork
    // must still hand back a usable strategy, not verification: {}.
    setFiles({ custom: { '777': { chainId: 777, name: 'CustomNet' } } });
    expect(registry.getNetwork(777).verification.primary).toBe('direct');
  });

  test('preserves a primary-only mainnet choice from the previous settings model', () => {
    setFiles({
      chains: {
        ...CHAINS,
        '1': {
          ...CHAINS['1'],
          verification: {
            primary: 'colibri',
            order: ['myotis', 'colibri', 'quorum'],
            preferVerified: true,
          },
        },
      },
      userConfig: { networks: { '1': { verification: { primary: 'quorum' } } } },
    });

    expect(registry.getNetwork(1).verification).toMatchObject({
      primary: 'quorum',
      order: ['myotis', 'quorum'],
      preferVerified: false,
    });
  });

  test('preserves an explicit verification preference in a primary-only override', () => {
    setFiles({
      userConfig: {
        networks: {
          '1': { verification: { primary: 'direct', preferVerified: false } },
        },
      },
    });

    expect(registry.getNetwork(1).verification).toMatchObject({
      primary: 'direct',
      order: ['myotis', 'direct', 'quorum'],
      preferVerified: false,
    });
  });
});

describe('getEndpoints — resolution', () => {
  test('keyless rpc source returns its URL as-is', () => {
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.public.example');
  });

  test('role filter — prover vs rpc are separate', () => {
    expect(registry.getEndpoints(1, 'prover')).toEqual(['https://prover.example']);
    expect(registry.getEndpoints(1, 'prover')).not.toContain('https://eth.public.example');
  });

  test('coverage filter — a source not covering the chain is excluded', () => {
    // gno-public covers 100 only; must not appear for chain 1.
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://gno.public.example');
    expect(registry.getEndpoints(100, 'rpc')).toContain('https://gno.public.example');
  });

  test('keyed source: {API_KEY} substituted when a key is configured', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'SECRET', enabled: true } } });
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.alchemy.example/v2/SECRET');
  });

  test('keyed source: dropped when no key is configured', () => {
    // no rpc-api-keys.json → alchemy produces no URL
    expect(registry.getEndpoints(1, 'rpc').some((u) => u.includes('alchemy'))).toBe(false);
  });

  test('keyed source: dropped when the key is explicitly disabled', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'SECRET', enabled: false } } });
    expect(registry.getEndpoints(1, 'rpc').some((u) => u.includes('alchemy'))).toBe(false);
  });

  test('keyed source covers multiple chains off one key', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'K', enabled: true } } });
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.alchemy.example/v2/K');
    expect(registry.getEndpoints(100, 'rpc')).toContain('https://gno.alchemy.example/v2/K');
  });
});

describe('getEndpointSources', () => {
  test('returns source objects with their id, raw {API_KEY} intact', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'SECRET', enabled: true } } });
    const sources = registry.getEndpointSources(1, 'rpc');
    const alchemy = sources.find((s) => s.id === 'alchemy');
    expect(alchemy.coverage['1']).toBe('https://eth.alchemy.example/v2/{API_KEY}');
  });
});

describe('getKeyedSources', () => {
  test('returns only keyed sources of the role, each carrying its id', () => {
    const keyed = registry.getKeyedSources('rpc');
    expect(Object.keys(keyed)).toEqual(['alchemy']);
    expect(keyed.alchemy).toMatchObject({ id: 'alchemy', role: 'rpc', keyed: true });
  });

  test('keyless sources and other roles are excluded', () => {
    const keyed = registry.getKeyedSources('rpc');
    expect(keyed['eth-public']).toBeUndefined();
    expect(keyed['colibri-corpus']).toBeUndefined();
  });
});

describe('getEndpointSourceList', () => {
  test('lists every source tagged with role/keyed/builtin', () => {
    const byId = Object.fromEntries(registry.getEndpointSourceList().map((s) => [s.id, s]));
    expect(byId['eth-public']).toMatchObject({ role: 'rpc', keyed: false, builtin: true, removed: false });
    expect(byId['colibri-corpus']).toMatchObject({ role: 'prover', builtin: true });
    expect(byId['alchemy']).toMatchObject({ keyed: true, builtin: true });
  });

  test('removed builtins and user-added sources are tagged', () => {
    setFiles({
      userConfig: {
        removedSources: ['eth-public'],
        endpointSources: { u1: { role: 'rpc', keyed: false, coverage: { '1': 'http://u1.example' } } },
      },
    });
    const byId = Object.fromEntries(registry.getEndpointSourceList().map((s) => [s.id, s]));
    expect(byId['eth-public'].removed).toBe(true);
    expect(byId['u1']).toMatchObject({ builtin: false, removed: false });
  });
});

describe('user config layer', () => {
  test('per-network verification override is applied', () => {
    setFiles({ userConfig: { networks: { '1': { verification: { primary: 'quorum' } } } } });
    expect(registry.getNetwork(1).verification.primary).toBe('quorum');
  });

  test('partial quorum override merges, keeps the rest of the block', () => {
    setFiles({ userConfig: { networks: { '1': { quorum: { k: 5 } } } } });
    expect(registry.getNetwork(1).quorum).toMatchObject({ k: 5, m: 2, timeoutMs: 5000 });
  });

  test('removedSources excludes a builtin source', () => {
    setFiles({ userConfig: { removedSources: ['eth-public'] } });
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://eth.public.example');
  });

  test('user-added endpoint source is included', () => {
    setFiles({
      userConfig: {
        endpointSources: {
          'user-local': { role: 'rpc', keyed: false, coverage: { '1': 'http://localhost:8545' } },
        },
      },
    });
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://localhost:8545');
  });

  test('a user-added source sorts ahead of builtin sources', () => {
    setFiles({
      userConfig: {
        endpointSources: {
          'user-local': { role: 'rpc', keyed: false, coverage: { '1': 'http://localhost:8545' } },
        },
      },
    });
    // The `direct` strategy resolves to getEndpoints(...)[0] — the user's
    // own endpoint must win over the shipped pool.
    expect(registry.getEndpoints(1, 'rpc')[0]).toBe('http://localhost:8545');
  });

  test('a keyed provider resolves ahead of a public RPC', () => {
    setFiles({ apiKeys: { alchemy: { apiKey: 'K', enabled: true } } });
    const urls = registry.getEndpoints(1, 'rpc');
    expect(urls.indexOf('https://eth.alchemy.example/v2/K'))
      .toBeLessThan(urls.indexOf('https://eth.public.example'));
  });

  test('a user-added endpoint still resolves ahead of a keyed provider', () => {
    setFiles({
      apiKeys: { alchemy: { apiKey: 'K', enabled: true } },
      userConfig: {
        endpointSources: {
          'user-local': { role: 'rpc', keyed: false, coverage: { '1': 'http://localhost:8545' } },
        },
      },
    });
    expect(registry.getEndpoints(1, 'rpc')[0]).toBe('http://localhost:8545');
  });
});

describe('invalidate', () => {
  test('a query after invalidate reflects the new file state', () => {
    expect(registry.getNetwork(1).verification.primary).toBe('colibri');
    setFiles({ userConfig: { networks: { '1': { verification: { primary: 'direct' } } } } });
    expect(registry.getNetwork(1).verification.primary).toBe('direct');
  });
});

describe('mutation layer', () => {
  test('updateNetwork persists a verification override', () => {
    registry.updateNetwork(1, { verification: { primary: 'quorum' } });
    expect(registry.getNetwork(1).verification.primary).toBe('quorum');
    const written = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('network-config.json'));
    expect(written).toBeDefined();
  });

  test('updateNetwork persists ordered name-resolution policy fields', () => {
    registry.updateNetwork(1, {
      verification: {
        primary: 'colibri',
        order: ['myotis', 'colibri', 'quorum'],
        preferVerified: true,
      },
    });

    expect(registry.getNetwork(1).verification).toMatchObject({
      primary: 'colibri',
      order: ['myotis', 'colibri', 'quorum'],
      preferVerified: true,
    });
  });

  test('updateNetwork merges a partial quorum patch, keeping the rest', () => {
    registry.updateNetwork(1, { quorum: { k: 7 } });
    expect(registry.getNetwork(1).quorum).toMatchObject({ k: 7, m: 2, timeoutMs: 5000 });
  });

  test('upsertEndpointSource adds a user source visible to getEndpoints', () => {
    registry.upsertEndpointSource('my-rpc', {
      role: 'rpc', keyed: false, coverage: { '1': 'https://my-rpc.example' },
    });
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://my-rpc.example');
  });

  test('upsertEndpointSource un-hides a previously removed builtin', () => {
    setFiles({ userConfig: { removedSources: ['eth-public'] } });
    registry.upsertEndpointSource('eth-public', {
      role: 'rpc', keyed: false, coverage: { '1': 'https://override.example' },
    });
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://override.example');
  });

  test.each([
    ['http://localhost:8545'],
    ['http://localhost.:8545'],
    ['http://dev.localhost:8545'],
    ['http://dev.localhost.:8545'],
    ['http://127.0.0.1:8545'],
    ['http://127.42.0.1:8545'],
    ['http://2130706433:8545'],
    ['http://[::1]:8545'],
    ['http://[0:0:0:0:0:0:0:1]:8545'],
    ['http://[::ffff:127.0.0.1]:8545'],
    ['https://localhost:8545'],
    ['https://127.0.0.1:8545'],
  ])('upsertEndpointSource accepts loopback RPC URL %s', (url) => {
    const result = registry.upsertEndpointSource('local-rpc', {
      role: 'rpc', keyed: false, coverage: { '1': url },
    });

    expect(result.success).toBe(true);
    expect(registry.getEndpoints(1, 'rpc')).toContain(url);
  });

  test.each([
    ['http://rpc.example'],
    ['file:///tmp/rpc.sock'],
    ['https://intranet.:8545'],
    ['https://192.168.1.10'],
    ['https://[fe90::1]:8545'],
    ['https://[fec0::1]:8545'],
    ['https://[fec0:0:0:ffff::1]:8545'],
    ['https://[feff::1]:8545'],
    ['https://[ff02::1]:8545'],
    ['https://[::ffff:192.168.1.10]:8545'],
    ['https://rpc.local'],
    ['https://rpc.local.'],
    ['http://[::ffff:8.8.8.8]:8545'],
    ['https://[64:ff9b::a00:1]:8545'],
    ['https://[64:ff9b::10.0.0.1]:8545'],
    ['https://[64:ff9b:1::a00:1]:8545'],
    ['https://[64:ff9b:1:ffff::1]:8545'],
    ['https://[::10.0.0.1]:8545'],
    ['https://[2002:a00:1::1]:8545'],
    ['https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]:8545'],
    ['https://rpc.example/${API_KEY}'],
  ])('upsertEndpointSource rejects unsafe RPC URL %s', (url) => {
    const result = registry.upsertEndpointSource('bad-rpc', {
      role: 'rpc', keyed: false, coverage: { '1': url },
    });

    expect(result.success).toBe(false);
    expect(registry.getEndpointSourceList().find((src) => src.id === 'bad-rpc')).toBeUndefined();
  });

  test.each([
    ['http://192.168.1.50'],
    ['ftp://prover.example'],
    ['https://user:pass@prover.example'],
    ['http://prover.example'],
  ])('upsertEndpointSource rejects unsafe prover URL %s', (url) => {
    // Prover URLs are fetched by the main-process Colibri client, so they get
    // the same https-or-loopback SSRF validation as rpc URLs.
    const result = registry.upsertEndpointSource('bad-prover', {
      role: 'prover', keyed: false, coverage: { '1': url },
    });

    expect(result.success).toBe(false);
    expect(registry.getEndpointSourceList().find((src) => src.id === 'bad-prover')).toBeUndefined();
  });

  test('upsertEndpointSource accepts an https prover URL', () => {
    const result = registry.upsertEndpointSource('good-prover', {
      role: 'prover', keyed: false, coverage: { '1': 'https://prover.example/v1' },
    });
    expect(result.success).toBe(true);
    expect(registry.getEndpoints(1, 'prover')).toContain('https://prover.example/v1');
  });

  test('upsertEndpointSource accepts a NAT64 address embedding a public IPv4', () => {
    const url = 'https://[64:ff9b::8.8.8.8]:8545';
    const result = registry.upsertEndpointSource('nat64-rpc', {
      role: 'rpc', keyed: false, coverage: { '1': url },
    });

    expect(result.success).toBe(true);
    expect(registry.getEndpoints(1, 'rpc')).toContain(url);
  });

  test('removeEndpointSource hides a builtin source', () => {
    registry.removeEndpointSource('eth-public');
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://eth.public.example');
  });

  test('removeEndpointSource deletes a user-added source outright', () => {
    setFiles({
      userConfig: {
        endpointSources: { u1: { role: 'rpc', keyed: false, coverage: { '1': 'http://u1.example' } } },
      },
    });
    registry.removeEndpointSource('u1');
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('http://u1.example');
  });

  test('restoreEndpointSource un-hides a removed builtin', () => {
    registry.removeEndpointSource('eth-public');
    expect(registry.getEndpoints(1, 'rpc')).not.toContain('https://eth.public.example');
    registry.restoreEndpointSource('eth-public');
    expect(registry.getEndpoints(1, 'rpc')).toContain('https://eth.public.example');
  });

  test('resets one chain override without deleting another chain override', () => {
    setFiles({
      sources: {
        ...SOURCES,
        'colibri-corpus': {
          role: 'prover',
          keyed: false,
          coverage: {
            '1': 'https://mainnet.prover.example',
            '100': 'https://gnosis.prover.example',
          },
        },
      },
      userConfig: {
        endpointSources: {
          'colibri-corpus': {
            role: 'prover',
            keyed: false,
            coverage: {
              '1': 'https://custom-mainnet.example',
              '100': 'https://custom-gnosis.example',
            },
          },
        },
      },
    });

    registry.resetEndpointSourceCoverage('colibri-corpus', 1);

    expect(registry.getEndpoints(1, 'prover')).toEqual(['https://mainnet.prover.example']);
    expect(registry.getEndpoints(100, 'prover')).toEqual(['https://custom-gnosis.example']);
  });
});

describe('builtin flag', () => {
  test('builtin chains are tagged builtin: true', () => {
    expect(registry.getNetwork(1).builtin).toBe(true);
    expect(registry.getAllNetworks()['100'].builtin).toBe(true);
  });

  test('custom chains are tagged builtin: false', () => {
    setFiles({ custom: { '8453': { chainId: 8453, name: 'Base' } } });
    expect(registry.getNetwork(8453).builtin).toBe(false);
    expect(registry.getNetwork(1).builtin).toBe(true);
  });
});

describe('isChainAvailable / getAvailableChains', () => {
  test('a chain with a keyless rpc source is available', () => {
    expect(registry.isChainAvailable(1)).toBe(true);
    expect(registry.isChainAvailable(100)).toBe(true);
  });

  test('a chain with no usable endpoint is unavailable', () => {
    setFiles({ custom: { '777': { chainId: 777, name: 'CustomNet' } } });
    expect(registry.isChainAvailable(777)).toBe(false);
  });

  test('a chain with only a Colibri prover remains available for verified reads', () => {
    setFiles({
      sources: {
        'colibri-corpus': {
          role: 'prover', keyed: false, coverage: { '1': 'https://prover.example' },
        },
      },
    });
    expect(registry.isChainAvailable(1)).toBe(true);
    expect(registry.isChainAvailable(100)).toBe(false);
  });

  test('getAvailableChains excludes chains with no endpoint', () => {
    setFiles({ custom: { '777': { chainId: 777, name: 'CustomNet' } } });
    expect(Object.keys(registry.getAvailableChains()).sort()).toEqual(['1', '100']);
  });
});

describe('addCustomChain', () => {
  test('persists a new chain and makes it queryable', () => {
    expect(registry.addCustomChain({ chainId: 8453, name: 'Base', nativeSymbol: 'ETH' }))
      .toEqual({ success: true, chainId: '8453' });
    expect(registry.getNetwork(8453)).toMatchObject({ name: 'Base', builtin: false });
    const written = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('custom-chains.json'));
    expect(written).toBeDefined();
  });

  test('coerces a string chainId to a number in the stored definition', () => {
    registry.addCustomChain({ chainId: '8453', name: 'Base' });
    expect(registry.getNetwork(8453).chainId).toBe(8453);
  });

  test('rejects a missing or invalid chainId', () => {
    expect(registry.addCustomChain({ name: 'NoId' }).success).toBe(false);
    expect(registry.addCustomChain({ chainId: 0, name: 'Zero' }).success).toBe(false);
    expect(registry.addCustomChain({ chainId: -1, name: 'Neg' }).success).toBe(false);
  });

  test('rejects a chainId that collides with a builtin chain', () => {
    expect(registry.addCustomChain({ chainId: 1, name: 'FakeEth' }).success).toBe(false);
    expect(registry.getNetwork(1).name).toBe('Ethereum');
  });

  test('re-adding an existing custom chain replaces its definition', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' });
    expect(registry.addCustomChain({ chainId: 8453, name: 'Base Renamed' }).success).toBe(true);
    expect(registry.getNetwork(8453).name).toBe('Base Renamed');
  });

  test('imports rpcUrls as keyless endpoint sources for the chain', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://a.example', 'https://b.example']);
    expect(registry.getEndpoints(8453, 'rpc')).toEqual(['https://a.example', 'https://b.example']);
  });

  test('accepts loopback http RPC URLs for a custom chain', () => {
    const result = registry.addCustomChain(
      { chainId: 31337, name: 'Local Devnet' },
      ['http://localhost:8545']
    );

    expect(result.success).toBe(true);
    expect(registry.getEndpoints(31337, 'rpc')).toEqual(['http://localhost:8545']);
  });

  test.each([
    ['http://base.example'],
    ['file:///tmp/base.sock'],
    ['https://intranet.:8545'],
    ['https://10.0.0.5'],
    ['https://[febf::1]:8545'],
    ['https://[::ffff:10.0.0.5]:8545'],
    ['https://[64:ff9b::a00:5]:8545'],
    ['https://[64:ff9b:1::a00:5]:8545'],
    ['https://base.local'],
    ['https://base.local.'],
    ['https://base.example/${API_KEY}'],
  ])('rejects unsafe imported RPC URL %s', (url) => {
    const result = registry.addCustomChain({ chainId: 8453, name: 'Base' }, [url]);

    expect(result.success).toBe(false);
    expect(registry.getNetwork(8453)).toBeNull();
  });

  test('imported rpcUrls are public (builtin) endpoints, not hand-added', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://a.example']);
    const src = registry.getEndpointSourceList().find((s) => s.coverage['8453'] === 'https://a.example');
    expect(src).toMatchObject({ role: 'rpc', keyed: false, builtin: true });
  });

  test('re-adding replaces the chain previously imported rpc sources', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://a.example']);
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://c.example']);
    expect(registry.getEndpoints(8453, 'rpc')).toEqual(['https://c.example']);
  });

  test('re-adding with no rpcUrls clears previously imported rpc sources', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://a.example']);
    registry.addCustomChain({ chainId: 8453, name: 'Base' });
    expect(registry.getEndpoints(8453, 'rpc')).toEqual([]);
  });
});

describe('removeCustomChain', () => {
  test('removes a custom chain', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' });
    expect(registry.removeCustomChain(8453)).toEqual({ success: true });
    expect(registry.getNetwork(8453)).toBeNull();
  });

  test('rejects removing an unknown or builtin chain', () => {
    expect(registry.removeCustomChain(999).success).toBe(false);
    expect(registry.removeCustomChain(1).success).toBe(false);
  });

  test('the chain catalogue RPCs disappear when the chain is removed', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://a.example']);
    expect(registry.getEndpoints(8453, 'rpc')).toEqual(['https://a.example']);
    registry.removeCustomChain(8453);
    expect(registry.getEndpoints(8453, 'rpc')).toEqual([]);
  });

  test('removing a chain clears the disabled-state of its catalogue RPCs', () => {
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://a.example', 'https://b.example']);
    registry.removeEndpointSource('catalog:8453:1'); // user disables the first catalogue RPC
    expect(registry.getEndpoints(8453, 'rpc')).toEqual(['https://b.example']);
    registry.removeCustomChain(8453);
    registry.addCustomChain({ chainId: 8453, name: 'Base' }, ['https://a.example', 'https://b.example']);
    expect(registry.getEndpoints(8453, 'rpc')).toEqual(['https://a.example', 'https://b.example']);
  });

  test('drops the chain network override and its single-chain endpoint sources', () => {
    setFiles({
      custom: { '8453': { chainId: 8453, name: 'Base' } },
      userConfig: {
        networks: { '8453': { verification: { primary: 'quorum' } } },
        endpointSources: {
          'base-rpc': { role: 'rpc', keyed: false, coverage: { '8453': 'https://base.example' } },
          'multi': {
            role: 'rpc', keyed: false,
            coverage: { '1': 'https://m1.example', '8453': 'https://m2.example' },
          },
        },
      },
    });
    registry.removeCustomChain(8453);
    const ids = registry.getEndpointSourceList().map((s) => s.id);
    expect(ids).not.toContain('base-rpc');
    expect(ids).toContain('multi');
  });
});

describe('legacy-config migration on load', () => {
  test('absent network-config.json + legacy settings.json → migrates and persists', () => {
    // A quorum-era custom-RPC user: no network-config.json yet.
    setFiles({ settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' } });
    expect(registry.getNetwork(1).verification.primary).toBe('direct');
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://localhost:8545');
    // network-config.json was written out.
    const written = mockWriteFileSync.mock.calls.find(([p]) => String(p).endsWith('network-config.json'));
    expect(written).toBeDefined();
  });

  test('no settings.json (fresh install) → no migration, no write', () => {
    setFiles();
    registry.getNetwork(1);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('network-config.json already present → migration is skipped', () => {
    setFiles({
      settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' },
      userConfig: { networks: { '1': { verification: { primary: 'quorum' } } } },
    });
    expect(registry.getNetwork(1).verification.primary).toBe('quorum');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('corrupt network-config.json → defaults, no re-migration, file left intact', () => {
    setFiles({ settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' } });
    mockFiles['network-config.json'] = '{ this is not valid json';
    registry.invalidate();
    // Builtin default — NOT the migrated 'direct', and the corrupt file is
    // not overwritten by a re-migration.
    expect(registry.getNetwork(1).verification.primary).toBe('colibri');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('migration write failure → migrated config still used in-memory', () => {
    setFiles({ settings: { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' } });
    mockWriteFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(registry.getNetwork(1).verification.primary).toBe('direct');
    expect(registry.getEndpoints(1, 'rpc')).toContain('http://localhost:8545');
  });
});
