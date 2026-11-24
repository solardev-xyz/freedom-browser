/**
 * The servers main sends a Colibri data request to (freedom-core design
 * 0014, "Main's fetches" → "The fetch contract", the servers). They come from
 * main's table by type, never from the Colibri service:
 * - `prover`: the opening client's prover (the registry's first prover for
 *   the chain), passed in;
 * - `beacon_api`: Colibri 3.0.3's built-in `beacon_apis` for the chain, then
 *   the prover;
 * - `checkpointz`: its built-in `checkpointz`, then its `beacon_apis`, then
 *   the prover;
 * - `eth_rpc`: none. No variant of the fetch contract uses it, so the table
 *   has no RPC hosts.
 *
 * That is `handle_request`'s order in Colibri 3.0.3's JS client
 * (`cjs/http.js:151–168`) with its defaults for the chain and
 * `prover: [proverUrl]`, as the WASM worker configured the client until
 * COL-6 removed it. A chain outside the built-in lists has the prover alone,
 * as the client gave it.
 *
 * A checkpoint process (`checkpoint --chain N`) has the servers the WASM
 * checkpoint worker gave Colibri: its `checkpointz` is the chain's
 * intercepted origin alone, which main answers from its quorum; its
 * `checkpoint_proof` is the chain's prover, which main fetches itself; it has
 * no `beacon_api` and no `prover`.
 */

const { CHECKPOINT_NETWORKS } = require('../myotis/checkpoint-verifier');

function frozenLists(beacon_apis, checkpointz) {
  return Object.freeze({
    beacon_apis: Object.freeze(beacon_apis),
    checkpointz: Object.freeze(checkpointz),
  });
}

/**
 * Colibri 3.0.3's built-in beacon and checkpoint hosts, by chain, embedded
 * unchanged: the `beacon_apis` and `checkpointz` of `default_config` in the
 * `@corpus-core/colibri-stateless` 3.0.3 npm package's
 * `cjs/chains.generated.js` (sha256 2a91eee0…c921), which the app depended
 * on until COL-6. Design 0014 (Q1, decided 2026-11-22) keeps exactly these
 * hosts, reached through the session, so a change here is a design change.
 * `colibri-servers.test.js` pins this table to that file's lists, recorded
 * in test/fixtures/colibri/package-chains-3.0.3.json, and to the servers
 * freedom-core's vectors recorded (F-2).
 */
const COLIBRI_PACKAGE_SERVERS = Object.freeze({
  1: frozenLists(
    [
      'https://mainnet.colibri-proof.tech/consensus',
      'https://gateway.tenderly.co/public/mainnet',
      'https://ethereum-beacon-api.publicnode.com',
    ],
    [
      'https://sync-mainnet.beaconcha.in',
      'https://mainnet.checkpoint.sigp.io',
      'https://mainnet-checkpoint-sync.attestant.io',
      'https://beaconstate-mainnet.chainsafe.io',
      'https://mainnet-checkpoint-sync.stakely.io',
      'https://checkpointz.pietjepuk.net',
      'https://beaconstate.ethstaker.cc',
    ]
  ),
  11155111: frozenLists(
    [
      'https://sepolia.colibri-proof.tech/consensus',
      'https://ethereum-sepolia-beacon-api.publicnode.com',
    ],
    ['https://checkpoint-sync.sepolia.ethpandaops.io', 'https://beaconstate-sepolia.chainsafe.io']
  ),
  100: frozenLists(
    [
      'https://gnosis.colibri-proof.tech/consensus',
      'https://rpc-gbc.gnosischain.com',
      'https://gnosis-beacon-api.publicnode.com',
    ],
    ['https://checkpoint.gnosischain.com']
  ),
  10200: frozenLists(['https://rpc-gbc.chiadochain.net'], ['https://checkpoint.chiadochain.net']),
  7091047534: frozenLists(
    [
      'https://plataberget.colibri-proof.tech/consensus',
      'https://beacon.glamsterdam-devnet-8.ethpandaops.io/',
    ],
    ['https://checkpoint-sync.glamsterdam-devnet-8.ethpandaops.io']
  ),
});

const NO_LISTS = frozenLists([], []);

/**
 * The servers for one data request, in the order main tries them:
 * `{ kind, chain, type, prover }`, `kind` being the process's (`request`,
 * the default, or `checkpoint`) and `prover` the opening client's prover URL
 * (unused for a checkpoint process). An empty list means the type has no
 * server.
 */
function colibriServers({ kind = 'request', chain, type, prover }) {
  if (kind === 'checkpoint') {
    const network = Object.hasOwn(CHECKPOINT_NETWORKS, chain) ? CHECKPOINT_NETWORKS[chain] : null;
    if (!network) return [];
    if (type === 'checkpoint_proof') return [network.prover];
    if (type === 'checkpointz') return [network.source];
    return [];
  }
  const lists = Object.hasOwn(COLIBRI_PACKAGE_SERVERS, chain)
    ? COLIBRI_PACKAGE_SERVERS[chain]
    : NO_LISTS;
  const provers = typeof prover === 'string' && prover ? [prover] : [];
  switch (type) {
    case 'prover':
      return provers;
    case 'beacon_api':
      return [...lists.beacon_apis, ...provers];
    case 'checkpointz':
      return [...lists.checkpointz, ...lists.beacon_apis, ...provers];
    default:
      return [];
  }
}

module.exports = { COLIBRI_PACKAGE_SERVERS, colibriServers };
