/**
 * Main's Colibri server table (`colibri-servers.js`) against Colibri 3.0.3's
 * built-in lists, as the npm package the app depended on until COL-6 ships
 * them (`cjs/chains.generated.js`, recorded in
 * test/fixtures/colibri/package-chains-3.0.3.json with the file's SHA-256),
 * and the servers freedom-core's COL-1 recording used (`vectors/colibri.json`,
 * `servers`; skipped without the vectors, see `test/helpers/colibri-vectors.js`).
 * Design 0014 (Q1) keeps exactly those hosts: any change here fails.
 */

const { COLIBRI_PACKAGE_SERVERS, colibriServers } = require('./colibri-servers');
const { CHECKPOINT_NETWORKS } = require('../myotis/checkpoint-verifier');
const { colibriVectors, colibriVectorsRequired } = require('../../../test/helpers/colibri-vectors');
const PACKAGE = require('../../../test/fixtures/colibri/package-chains-3.0.3.json');

const packageChains = PACKAGE.chains;

const PROVER = 'https://prover.example';

describe("Colibri 3.0.3's built-in lists", () => {
  test('the recording is of the 3.0.3 file', () => {
    expect(PACKAGE.source).toEqual({
      release: 'Colibri 3.0.3, the npm build of https://github.com/corpus-core/c4',
      file: 'cjs/chains.generated.js (default_config)',
      sha256: '2a91eee079cce5de728934e6c1b19094300c1a23a3c15e08af3f77d85380c921',
    });
  });

  test('main holds exactly the recorded lists, chain by chain', () => {
    expect(Object.keys(COLIBRI_PACKAGE_SERVERS).sort()).toEqual(Object.keys(packageChains).sort());
    for (const [chain, config] of Object.entries(packageChains)) {
      expect([chain, COLIBRI_PACKAGE_SERVERS[chain].beacon_apis]).toEqual([
        chain,
        config.beacon_apis,
      ]);
      expect([chain, COLIBRI_PACKAGE_SERVERS[chain].checkpointz]).toEqual([
        chain,
        config.checkpointz,
      ]);
    }
  });

  // The hosts themselves, written out: a change to the table or to the
  // recording shows here as a diff of hosts.
  test('the hosts, as embedded', () => {
    expect(COLIBRI_PACKAGE_SERVERS).toEqual({
      1: {
        beacon_apis: [
          'https://mainnet.colibri-proof.tech/consensus',
          'https://gateway.tenderly.co/public/mainnet',
          'https://ethereum-beacon-api.publicnode.com',
        ],
        checkpointz: [
          'https://sync-mainnet.beaconcha.in',
          'https://mainnet.checkpoint.sigp.io',
          'https://mainnet-checkpoint-sync.attestant.io',
          'https://beaconstate-mainnet.chainsafe.io',
          'https://mainnet-checkpoint-sync.stakely.io',
          'https://checkpointz.pietjepuk.net',
          'https://beaconstate.ethstaker.cc',
        ],
      },
      11155111: {
        beacon_apis: [
          'https://sepolia.colibri-proof.tech/consensus',
          'https://ethereum-sepolia-beacon-api.publicnode.com',
        ],
        checkpointz: [
          'https://checkpoint-sync.sepolia.ethpandaops.io',
          'https://beaconstate-sepolia.chainsafe.io',
        ],
      },
      100: {
        beacon_apis: [
          'https://gnosis.colibri-proof.tech/consensus',
          'https://rpc-gbc.gnosischain.com',
          'https://gnosis-beacon-api.publicnode.com',
        ],
        checkpointz: ['https://checkpoint.gnosischain.com'],
      },
      10200: {
        beacon_apis: ['https://rpc-gbc.chiadochain.net'],
        checkpointz: ['https://checkpoint.chiadochain.net'],
      },
      7091047534: {
        beacon_apis: [
          'https://plataberget.colibri-proof.tech/consensus',
          'https://beacon.glamsterdam-devnet-8.ethpandaops.io/',
        ],
        checkpointz: ['https://checkpoint-sync.glamsterdam-devnet-8.ethpandaops.io'],
      },
    });
  });

  test('the table is frozen', () => {
    expect(Object.isFrozen(COLIBRI_PACKAGE_SERVERS)).toBe(true);
    expect(Object.isFrozen(COLIBRI_PACKAGE_SERVERS[1].beacon_apis)).toBe(true);
    expect(Object.isFrozen(COLIBRI_PACKAGE_SERVERS[1].checkpointz)).toBe(true);
  });
});

describe('the servers by type', () => {
  test.each(Object.keys(packageChains).map(Number))("chain %i: handle_request's order", (chain) => {
    const config = packageChains[chain];
    const servers = (type) => colibriServers({ chain, type, prover: PROVER });
    // The client's prover, never the package's provers.
    expect(servers('prover')).toEqual([PROVER]);
    expect(servers('beacon_api')).toEqual([...config.beacon_apis, PROVER]);
    expect(servers('checkpointz')).toEqual([...config.checkpointz, ...config.beacon_apis, PROVER]);
    // No variant uses eth_rpc, so the table has no RPC host.
    expect(servers('eth_rpc')).toEqual([]);
    expect(servers('checkpoint_proof')).toEqual([]);
  });

  test('a chain outside the built-in lists has the prover alone', () => {
    for (const type of ['prover', 'beacon_api', 'checkpointz']) {
      expect(colibriServers({ chain: 8453, type, prover: PROVER })).toEqual([PROVER]);
    }
    expect(colibriServers({ chain: 8453, type: 'eth_rpc', prover: PROVER })).toEqual([]);
  });

  test("a checkpoint process has the WASM checkpoint worker's servers", () => {
    for (const [chain, network] of Object.entries(CHECKPOINT_NETWORKS)) {
      const servers = (type) =>
        colibriServers({ kind: 'checkpoint', chain: Number(chain), type, prover: PROVER });
      expect(servers('checkpoint_proof')).toEqual([network.prover]);
      expect(servers('checkpointz')).toEqual([network.source]);
      // As the worker had it: no beacon API, and the client's prover isn't
      // one of them.
      expect(servers('beacon_api')).toEqual([]);
      expect(servers('prover')).toEqual([]);
      expect(servers('eth_rpc')).toEqual([]);
    }
    expect(colibriServers({ kind: 'checkpoint', chain: 11155111, type: 'checkpointz' })).toEqual(
      []
    );
  });

  test('each answer is a fresh list', () => {
    const list = colibriServers({ chain: 1, type: 'beacon_api', prover: PROVER });
    list.push('https://elsewhere.example');
    expect(colibriServers({ chain: 1, type: 'beacon_api', prover: PROVER })).not.toContain(
      'https://elsewhere.example'
    );
  });
});

// Named outright (CI does): they must be there, so these suites can't skip.
(colibriVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_COLIBRI_VECTORS names are there',
  () => {
    expect(colibriVectors).not.toBeNull();
  }
);

(colibriVectors ? describe : describe.skip)("the COL-1 recording's servers", () => {
  test('main gives each type the servers the recording used, eth_rpc none', () => {
    for (const chain of [1, 100]) {
      const recorded = colibriVectors.servers[chain];
      const prover = recorded.prover[0];
      expect(recorded.prover).toEqual([prover]);
      for (const type of ['prover', 'beacon_api', 'checkpointz']) {
        expect([chain, type, colibriServers({ chain, type, prover })]).toEqual([
          chain,
          type,
          recorded[type],
        ]);
      }
      // The recording had Colibri's built-in RPC hosts; main has none.
      expect(recorded.eth_rpc).toEqual(packageChains[chain].rpcs);
      expect(colibriServers({ chain, type: 'eth_rpc', prover })).toEqual([]);
    }
  });

  test("the recording's checkpoint proofs came from each chain's checkpoint prover", () => {
    for (const entry of colibriVectors.cases.filter((item) => item.kind === 'checkpoint')) {
      const proof = entry.trace.find(
        (step) => step.op === 'main_fetch' && step.variant === 'checkpoint_proof'
      );
      expect([
        entry.id,
        colibriServers({ kind: 'checkpoint', chain: entry.chain, type: 'checkpoint_proof' }),
      ]).toEqual([entry.id, [proof.url]]);
    }
  });
});
