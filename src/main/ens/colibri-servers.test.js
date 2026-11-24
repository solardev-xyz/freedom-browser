/**
 * Main's Colibri server table (`colibri-servers.js`) against the installed
 * package's lists (`chains.generated.js`) and the servers freedom-core's
 * COL-1 recording used (`vectors/colibri.json`, `servers`; skipped without
 * the vectors, see `test/helpers/colibri-vectors.js`).
 */

const path = require('path');
const { COLIBRI_PACKAGE_SERVERS, colibriServers } = require('./colibri-servers');
const { CHECKPOINT_NETWORKS } = require('../myotis/checkpoint-verifier');
const { colibriVectors } = require('../../../test/helpers/colibri-vectors');

// The package exports only its entry points; its generated chain table is
// read from its file.
const packageDir = path.dirname(require.resolve('@corpus-core/colibri-stateless/package.json'));
const { default_config: packageChains } = require(
  path.join(packageDir, 'cjs', 'chains.generated.js')
);

const PROVER = 'https://prover.example';

describe("the package's lists", () => {
  test('main holds exactly the installed package lists, chain by chain', () => {
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

  test('a chain outside the package lists has the prover alone', () => {
    for (const type of ['prover', 'beacon_api', 'checkpointz']) {
      expect(colibriServers({ chain: 8453, type, prover: PROVER })).toEqual([PROVER]);
    }
    expect(colibriServers({ chain: 8453, type: 'eth_rpc', prover: PROVER })).toEqual([]);
  });

  test("a checkpoint process has today's checkpoint worker's servers", () => {
    for (const [chain, network] of Object.entries(CHECKPOINT_NETWORKS)) {
      const servers = (type) =>
        colibriServers({ kind: 'checkpoint', chain: Number(chain), type, prover: PROVER });
      expect(servers('checkpoint_proof')).toEqual([network.prover]);
      expect(servers('checkpointz')).toEqual([network.source]);
      // As today: no beacon API, and the client's prover isn't one of them.
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
      // The recording had the package's RPC hosts; main has none.
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
