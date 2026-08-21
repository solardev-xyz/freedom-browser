// Migration test matrix — migrateLegacyConfig is pure, so these are plain
// input/output assertions, no mocks. The 11 cases mirror the matrix in
// research/wallet-colibri-integration.md "Step 1 — implementation plan".

const { migrateLegacyConfig } = require('./migration');

// Stand-in for endpoint-sources.json: 3 mainnet keyless rpc sources act as
// "the default public-RPC list" for diff tests, plus a keyed + prover source.
const BUILTIN_SOURCES = {
  'eth-publicnode': { role: 'rpc', keyed: false, coverage: { '1': 'https://ethereum.publicnode.com' } },
  'eth-drpc-public': { role: 'rpc', keyed: false, coverage: { '1': 'https://eth.drpc.org' } },
  'eth-cloudflare': { role: 'rpc', keyed: false, coverage: { '1': 'https://cloudflare-eth.com' } },
  alchemy: { role: 'rpc', keyed: true, coverage: { '1': 'https://eth.alchemy.example/{API_KEY}' } },
  'colibri-corpus': { role: 'prover', keyed: false, coverage: { '1': 'https://prover.example' } },
};
const DEFAULT_LIST = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://cloudflare-eth.com',
];

const run = (settings = {}, customChains = {}) =>
  migrateLegacyConfig({ settings, customChains, builtinSources: BUILTIN_SOURCES });

const EMPTY = { networks: {}, endpointSources: {}, removedSources: [] };

describe('migrateLegacyConfig — the 11-case matrix', () => {
  test('1. fresh install (no settings) → empty result', () => {
    expect(run()).toEqual(EMPTY);
  });

  test('2. quorum-era user, no customization → empty result (colibri default)', () => {
    const result = run({
      enableEnsCustomRpc: false,
      enableEnsQuorum: true,
      ensQuorumK: 3,
      ensQuorumM: 2,
      ensQuorumTimeoutMs: 5000,
      ensBlockAnchor: 'latest',
      ensBlockAnchorTtlMs: 30000,
      ensPublicRpcProviders: DEFAULT_LIST,
      blockUnverifiedEns: true,
    });
    expect(result).toEqual(EMPTY);
  });

  test('3. quorum-era + edited public-RPC list → diff (removed builtins + added user source)', () => {
    const result = run({
      ensPublicRpcProviders: ['https://ethereum.publicnode.com', 'https://my-own-rpc.example'],
    });
    expect(result.removedSources.sort()).toEqual(['eth-cloudflare', 'eth-drpc-public']);
    const added = Object.values(result.endpointSources);
    expect(added).toEqual([
      { role: 'rpc', keyed: false, coverage: { '1': 'https://my-own-rpc.example' } },
    ]);
  });

  test('4. quorum-era + custom RPC → direct strategy + a migrated endpoint source', () => {
    const result = run({ enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' });
    expect(result.networks['1']).toEqual({
      verification: {
        primary: 'direct',
        order: ['myotis', 'direct', 'quorum'],
        preferVerified: false,
      },
    });
    expect(result.endpointSources['migrated-eth-custom']).toEqual({
      role: 'rpc',
      keyed: false,
      coverage: { '1': 'http://localhost:8545' },
    });
  });

  test('5. quorum-era + enableEnsQuorum=false → ignored, upgraded to colibri (empty)', () => {
    expect(run({ enableEnsQuorum: false })).toEqual(EMPTY);
  });

  test('6. quorum-era + tuned quorum params → networks[1].quorum carries the full block', () => {
    const result = run({ ensQuorumK: 5, ensQuorumM: 3 });
    expect(result.networks['1'].quorum).toEqual({
      k: 5,
      m: 3,
      timeoutMs: 5000,
      anchor: 'latest',
      anchorTtlMs: 30000,
    });
  });

  test('7. migration never emits keyed sources (API keys stay the registry’s concern)', () => {
    const result = run({ enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' });
    expect(Object.values(result.endpointSources).every((s) => s.keyed === false)).toBe(true);
  });

  test('8. custom-chain rpcUrls are not migrated (load() surfaces them as catalog sources)', () => {
    const result = run({}, {
      '8453': { chainId: 8453, name: 'Base', rpcUrls: ['https://base.example', 'https://base2.example'] },
    });
    // The chain's rpcUrls stay on its custom-chains.json definition;
    // copying them here would double them against load()'s catalog: sources.
    expect(result.endpointSources).toEqual({});
  });

  test('9. kolibri-era dev settings are tolerated and mapped', () => {
    expect(run({ ensResolutionMethod: 'quorum' }).networks['1']).toEqual({
      verification: {
        primary: 'quorum',
        order: ['myotis', 'quorum'],
        preferVerified: false,
      },
    });
    expect(run({ ensResolutionMethod: 'custom-rpc' }).networks['1']).toEqual({
      verification: {
        primary: 'direct',
        order: ['myotis', 'direct', 'quorum'],
        preferVerified: false,
      },
    });
    // 'colibri' equals the builtin default → no override emitted
    expect(run({ ensResolutionMethod: 'colibri' })).toEqual(EMPTY);
    // ZK explicitly off is the only zkProof case worth recording
    expect(run({ ensColibriZkProof: false }).networks['1']).toEqual({ zkProof: false });
  });

  test('10. blockUnverifiedEns is not network config — never appears in the output', () => {
    const result = run({ blockUnverifiedEns: false, enableEnsCustomRpc: true, ensRpcUrl: 'http://x' });
    expect(JSON.stringify(result)).not.toContain('blockUnverified');
  });

  test('11. deterministic — same input migrates to a deep-equal result', () => {
    // True once-only idempotency is enforced a layer up (network-registry
    // skips migration when network-config.json already exists); here we
    // just pin that the pure function has no hidden nondeterminism.
    const settings = {
      enableEnsCustomRpc: true,
      ensRpcUrl: 'http://localhost:8545',
      ensQuorumK: 5,
      ensPublicRpcProviders: ['https://ethereum.publicnode.com', 'https://extra.example'],
    };
    expect(run(settings)).toEqual(run(settings));
  });

  test('an empty public-RPC list is no customization (legacy fell back to defaults)', () => {
    expect(run({ ensPublicRpcProviders: [] })).toEqual(EMPTY);
  });
});
