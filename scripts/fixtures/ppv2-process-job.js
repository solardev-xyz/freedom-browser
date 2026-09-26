/** Synthetic qualification job copied into the isolated SDK ASAR, never shipped. */
const assert = require('assert/strict');
const { createHash } = require('crypto');

exports.run = async function run(input, { progress }) {
  if (input.mode === 'crash') process.exit(12);
  if (input.mode === 'hang') {
    process.on('SIGTERM', () => {});
    progress();
    await new Promise(() => {});
  }
  if (input.mode === 'memory') {
    globalThis.fixtureAllocation = Buffer.alloc(180 * 1024 * 1024, 0x42);
    progress();
    await new Promise(() => {});
  }
  if (input.mode === 'egress') {
    const refused = [];
    for (const [name, operation] of [
      ['fetch', () => fetch('http://127.0.0.1:1')],
      ['http', () => require('http').get('http://127.0.0.1:1')],
      ['socket', () => require('net').connect(1, '127.0.0.1')],
      ['dns', () => require('dns').lookup('example.com', () => {})],
      ['udp', () => require('dgram').createSocket('udp4')],
      ['http2', () => require('http2').connect('https://127.0.0.1:1')],
      ['child', () => require('child_process').spawn(process.execPath)],
      ['electron', () => require('electron').net.fetch('http://127.0.0.1:1')],
    ]) {
      assert.throws(operation, /capability refused/); refused.push(name);
    }
    // Test a nested worker too: the host bootstrap must precede its code.
    const { Worker } = require('worker_threads');
    const nested = await new Promise((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort } = require('worker_threads');
        let refused = false;
        try { require('net').connect(1, '127.0.0.1'); } catch (error) { refused = error.message.includes('capability refused'); }
        parentPort.postMessage(refused);
      `, { eval: true });
      worker.once('error', reject);
      worker.once('message', async (value) => { await worker.terminate(); resolve(value); });
    });
    assert.equal(nested, true);
    return { refused, nested, inheritedSecret: process.env.FREEDOM_PROCESS_TEST_SECRET || null };
  }
  const sdk = require(input.sdkEntry);
  for (const [kind, bytes] of Object.entries(input.artifacts)) {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sdk.DEFAULT_CIRCUIT_MANIFEST.deposit[`${kind}Sha256`]);
  }
  const hashService = await sdk.PoseidonHashService.create();
  const noteComputationService = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.CryptoService() });
  const witness = await new sdk.WitnessPreparationService({
    hashService, noteComputationService, merkleService: new sdk.MerkleService({ hashService }),
  }).buildDepositWitness({
    noteAddressHash: noteComputationService.computeNoteAddressHash(`0x${'11'.repeat(20)}`, `0x${'12'.repeat(32)}`),
    tokenId: '0x1', value: '0x64', context: '0xaaaa', depositSecret: `0x${'05'.repeat(32)}`,
  });
  const artifact = async (name, kind) => { assert.equal(name, 'deposit'); return input.artifacts[kind]; };
  const groth16 = new sdk.Groth16Prover();
  const service = new sdk.ProofService({ circuitArtifacts: {
    getWasm: (name) => artifact(name, 'wasm'), getProvingKey: (name) => artifact(name, 'provingKey'),
    getVerificationKey: (name) => artifact(name, 'verificationKey'),
  }, groth16Prover: {
    fullProve(...args) { const task = groth16.fullProve(...args); progress(); return task; },
    verify: (...args) => groth16.verify(...args),
  } });
  const start = performance.now();
  const proof = await service.proveDeposit(witness);
  const provingMs = Math.round(performance.now() - start);
  assert.equal(await service.verifyDeposit(proof), true);
  assert.equal(await service.verifyDeposit({ ...proof, publicSignals: proof.publicSignals.map(() => '0xdeadbeef') }), false);
  return { verified: true, tamperedRejected: true, provingMs, rssBytes: process.memoryUsage().rss,
    fromAsar: __filename.includes('.asar/'), sdkFromAsar: input.sdkEntry.includes('.asar/'),
    node: process.versions.node, electron: process.versions.electron };
};
