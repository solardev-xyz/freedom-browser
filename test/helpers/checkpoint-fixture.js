/* global jest */
/**
 * A checkpoint check's world for main's tests, on either verifier path
 * (checkpoint-verifier.js's `acquireCheckpoint`): the WASM worker
 * (`verifyCheckpoint` with a scripted runtime) and the one-shot
 * freedom-colibrid process (`acquireColibridCheckpoint` with
 * test/helpers/fake-colibrid.js's scripted check). Both meet the same
 * authorities, the same prover and the same verifier model:
 *
 * - `fetch`: every request main makes, the proof's POST to the chain's prover
 *   (a bounded test proof) and the quorum's GETs (each authority's block
 *   root and finality for the fixture's slot, the Beacon API's flags where
 *   the chain has one). Tests re-script it (`mockImplementation`).
 * - `decoded`: what decoding the proof gives (`runtime.decode_proof`, which
 *   both paths call), a checkpoint at the fixture's slot.
 * - `verifier.run(lookup)`: the verification, after decoding. `lookup(path)`
 *   is one checkpointz lookup (the WASM path's intercepted fetch of
 *   `<source>/<path>`, the service's `checkpointz` fetch), its body parsed;
 *   by default it looks up `verifier.rootPath` (the fixture's slot) once,
 *   then fails with `failVerification`'s error, if any. Tests replace `run`.
 * - `dependencies`: the WASM path's (`runtime`, `fetch`, `now`, and an
 *   `onDiagnostic` a test sets); `colibrid()`: a fresh fake process and the
 *   native path's dependencies, reading the same `fetch`, `now` and
 *   verifier, the proof POSTed through the executor's hop.
 */

const { headerRoot } = require('../../src/main/myotis/checkpoint-evidence');
const { CHECKPOINT_NETWORKS } = require('../../src/main/myotis/checkpoint-verifier');
const { makeHop } = require('../../src/main/core/naming-shell');
const { ColibriFetchPool } = require('../../src/main/ens/colibri-fetch-pool');
const { checkpointCheck, fakeColibrid } = require('./fake-colibrid');

/** The fixture's clock: its slot is the last epoch's first, one epoch back. */
const NOW = Date.UTC(2026, 8, 14, 21);

const quietLog = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

function checkpointFixture(chainId = 1) {
  const config = CHECKPOINT_NETWORKS[chainId];
  const slot =
    Math.floor((NOW / 1000 - config.genesis) / config.secondsPerSlot / config.slotsPerEpoch) *
      config.slotsPerEpoch -
    config.slotsPerEpoch;
  const header = {
    slot: '0x' + slot.toString(16),
    proposerIndex: '0x123',
    parentRoot: '0x' + '11'.repeat(32),
    stateRoot: '0x' + '22'.repeat(32),
    bodyRoot: '0x' + '33'.repeat(32),
  };
  const decoded = {
    sync_data: {
      pubkeys: Array(512).fill('0x' + '44'.repeat(48)),
      checkpoint: {
        header,
        aggregate_pubkey: '0x' + '44'.repeat(48),
        proof: ['0x' + '55'.repeat(32)],
      },
    },
  };
  const finality = {
    data: { finalized: { epoch: String(slot / config.slotsPerEpoch), root: headerRoot(header) } },
  };
  let verify;
  let verifyFailure;
  let requestUrl;
  let storage;
  let clientConfig;
  const verifier = {
    rootPath: `eth/v1/beacon/blocks/${slot}/root`,
    async run(lookup) {
      await lookup(verifier.rootPath);
      if (verifyFailure) throw verifyFailure;
      return { number: '0x1' };
    },
  };
  const runtime = {
    clientVersion: 196608,
    Strategy: { VerifiedOnly: 0 },
    Colibri: class {
      static async register_storage(value) {
        storage = value;
      }
      constructor(value) {
        clientConfig = value;
      }
      async verifyProof(_method, _params, proof) {
        verify = proof;
        return verifier.run((path) => clientConfig.fetch(requestUrl || `${config.source}/${path}`));
      }
      destroy() {}
    },
    decode_proof: jest.fn(async () => decoded),
  };
  const fetch = jest.fn(async (url) => {
    if (url === config.prover) return new Response(Buffer.from('bounded test proof'));
    if (url.endsWith('finality_checkpoints')) return new Response(JSON.stringify(finality));
    return new Response(
      JSON.stringify({
        data: { root: headerRoot(header) },
        ...(config.beaconSources?.some((source) => url.startsWith(source))
          ? { finalized: true, execution_optimistic: false }
          : {}),
      })
    );
  });
  const dependencies = { runtime, fetch, now: () => NOW };
  return {
    chainId,
    config,
    decoded,
    finality,
    header,
    slot,
    runtime,
    fetch,
    verifier,
    dependencies,
    failVerification: (error) => {
      verifyFailure = error;
    },
    // The WASM path's intercepted URL, whole (another origin included).
    trustUrl: (value) => {
      requestUrl = value;
    },
    /** A fresh fake checkpoint process and the native path's dependencies. */
    colibrid(extra = {}) {
      const fake = fakeColibrid({
        checkpoint: (message, child) =>
          checkpointCheck(message, child, {
            decode: (bytes) => runtime.decode_proof(bytes),
            verify: (lookup, bytes) => {
              verify = bytes;
              return verifier.run(lookup);
            },
          }),
      });
      return {
        fake,
        dependencies: {
          spawn: fake.spawn,
          command: 'freedom-colibrid',
          serviceVersion: null,
          shellVersion: 'test',
          parentPid: 4242,
          fetch,
          hop: makeHop({ fetch }),
          fetchPool: new ColibriFetchPool(),
          now: () => dependencies.now(),
          log: quietLog,
          ...extra,
        },
      };
    },
    get verifyBytes() {
      return verify;
    },
    get storage() {
      return storage;
    },
    get clientConfig() {
      return clientConfig;
    },
  };
}

module.exports = { checkpointFixture, NOW, quietLog };
