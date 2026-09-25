/** Offline, synthetic deposit proof fixture. Never used by the application. */
const assert = require('node:assert/strict');
const { parentPort, workerData: threadData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
// Process mode is a diagnostic alternative, not an application worker backend.
const workerData = threadData || {
  sdkEntry: process.argv[2],
  artifacts: Object.fromEntries([
    ['wasm', 'deposit.wasm'], ['provingKey', 'deposit.zkey'], ['verificationKey', 'deposit.vkey.json'],
  ].map(([kind, name]) => [kind, fs.readFileSync(path.join(process.argv[3], name))])),
  shared: new SharedArrayBuffer(8),
};

// Diagnostic tripwires, not an OS sandbox. Nested SDK workers do not inherit
// these overrides; the report must not claim complete egress confinement.
let networkAttempts = 0;
const refuseNetwork = () => { networkAttempts += 1; throw new Error('Offline proof fixture'); };
globalThis.fetch = refuseNetwork;
globalThis.WebSocket = class { constructor() { refuseNetwork(); } };
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = refuseNetwork;
  module.get = refuseNetwork;
}
require('node:net').Socket.prototype.connect = refuseNetwork;
require('node:tls').connect = refuseNetwork;

async function main() {
  const sdk = require(workerData.sdkEntry);
  for (const [kind, bytes] of Object.entries(workerData.artifacts)) {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sdk.DEFAULT_CIRCUIT_MANIFEST.deposit[`${kind}Sha256`]);
  }
  const hashService = await sdk.PoseidonHashService.create();
  const noteComputationService = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.CryptoService() });
  const witnessService = new sdk.WitnessPreparationService({
    noteComputationService, hashService, merkleService: new sdk.MerkleService({ hashService }),
  });
  // Deliberately public test values, unrelated to a vault or funded account.
  const witness = await witnessService.buildDepositWitness({
    noteAddressHash: noteComputationService.computeNoteAddressHash(`0x${'11'.repeat(20)}`, `0x${'12'.repeat(32)}`),
    tokenId: '0x1', value: '0x64', context: '0xaaaa', depositSecret: `0x${'05'.repeat(32)}`,
  });
  const artifact = (name, kind) => {
    assert.equal(name, 'deposit');
    return Promise.resolve(workerData.artifacts[kind]);
  };
  const groth16 = new sdk.Groth16Prover();
  const state = new Int32Array(workerData.shared);
  const service = new sdk.ProofService({
    circuitArtifacts: {
      getWasm: (name) => artifact(name, 'wasm'),
      getProvingKey: (name) => artifact(name, 'provingKey'),
      getVerificationKey: (name) => artifact(name, 'verificationKey'),
    },
    groth16Prover: {
      fullProve(...args) {
        const pending = groth16.fullProve(...args);
        Atomics.store(state, 0, 1);
        return pending;
      },
      verify: (...args) => groth16.verify(...args),
    },
  });
  const start = performance.now();
  const proof = await service.proveDeposit(witness);
  const provingMs = performance.now() - start;
  assert.equal(await service.verifyDeposit(proof), true);
  const tampered = { ...proof, publicSignals: proof.publicSignals.map(() => '0xdeadbeef') };
  assert.equal(await service.verifyDeposit(tampered), false);
  assert.equal(networkAttempts, 0);
  Atomics.store(state, 1, 1);
  const result = {
    verified: true, tamperedRejected: true, provingMs: Math.round(provingMs),
    publicSignalCount: proof.publicSignals.length, networkAttempts,
    rssBytes: process.memoryUsage().rss,
  };
  if (parentPort) parentPort.postMessage(result);
  else process.send(result);
}

main().catch((cause) => { throw new Error('PPv2 synthetic proof fixture failed', { cause }); });
