/** Read-only live verifier qualification with public synthetic witnesses.
 * Run with source Electron, followed by the pinned runtime ASAR and output dir.
 * Never imports a wallet or exposes this test entrypoint through application IPC.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { app } = require('electron');
const { Interface } = require('ethers');
const { loadPPv2Runtime } = require('../src/main/wallet/ppv2-runtime');
const { runPrivacyProcess } = require('../src/main/wallet/privacy-process');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { NATIVE, ARTIFACTS, formatProof, validProof } = require('../src/main/wallet/ppv2-deposit-policy');
const { inspectSepoliaDeployment } = require('../src/main/wallet/ppv2-sepolia-preflight');
const { openLiveTransport } = require('./qualify-ppv2-live');

async function main() {
  const [archive, output] = process.argv.slice(2);
  assert.ok(archive && output && path.isAbsolute(output));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  await app.whenReady();
  const runtime = loadPPv2Runtime(archive);
  const scope = createPrivacyScope({ profileId: 'synthetic-verifier-qualification', signal: new AbortController().signal });
  const handle = scope.getContext({ kind: 'private-account', principal: 'public-synthetic-witness',
    protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role: 'prover' });
  const proofs = {}, metrics = {};
  let client;
  try {
    // Finish local proving before selecting the recent finalized RPC anchor.
    for (const circuit of ['deposit', 'ragequit', 'transact_1x1']) {
      console.log(`Proving synthetic ${circuit}`);
      const manifest = circuit === 'deposit' ? ARTIFACTS : JSON.parse(fs.readFileSync(path.join(runtime.archive, 'exit-manifest.json'), 'utf8')).filter((e) => e.circuit === circuit);
      const artifacts = {};
      for (const entry of manifest) {
        const bytes = fs.readFileSync(path.join(runtime.archive, 'artifacts', entry.name));
        artifacts[entry.kind] = Buffer.alloc(bytes.length); bytes.copy(artifacts[entry.kind]);
      }
      const started = Date.now(), count = { deposit: 4, ragequit: 7, transact_1x1: 8 }[circuit];
      const result = await runPrivacyProcess({ handle,
        filename: circuit === 'deposit' ? require.resolve('../src/main/wallet/ppv2-deposit-job') : path.join(runtime.archive, 'exit-job.cjs'),
        input: { sdkEntry: runtime.sdkEntry, artifacts, ...(circuit === 'deposit'
          ? { witness: { tokenId: NATIVE, value: '0x64', context: '0x3', noteAddressHash: '0x1', depositSecret: '0x2' } }
          : { circuit, singleThread: true, relayContext: '0x1234' }) },
        validateResult: (value) => value?.verified === true && validProof(circuit === 'deposit' ? value.proof : value.publicFixture?.proof, count) });
      proofs[circuit] = formatProof(circuit === 'deposit' ? result.result.proof : result.result.publicFixture.proof);
      metrics[circuit] = { elapsedMs: Date.now() - started, peakRssBytes: result.peakRssBytes, locallyVerified: true,
        archiveVerifiedInMain: true, archiveRecheckedInChild: circuit === 'deposit', syntheticFixtureJob: circuit !== 'deposit' };
    }
    client = await openLiveTransport(output, console.log);
    const deployment = await inspectSepoliaDeployment({ ...client, onStep: console.log });
    assert.ok(deployment.anchor && Object.keys(deployment.verifiers).length === 3);
    const checks = [];
    for (const circuit of Object.keys(proofs)) {
      const proof = proofs[circuit], target = deployment.verifiers[circuit].address;
      const abi = new Interface([`function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[${proof.pubSignals.length}]) view returns (bool)`]);
      const other = proofs[circuit === 'deposit' ? 'ragequit' : 'deposit'];
      for (const [name, value, expected] of [
        ['valid', proof, true],
        ['changed-public-signal', { ...proof, pubSignals: proof.pubSignals.map((v, i) => i === 0 ? v + 1n : v) }, false],
        ['cross-circuit', { ...other, pubSignals: proof.pubSignals }, false],
      ]) {
        console.log(`Calling ${circuit} verifier: ${name}`);
        const data = abi.encodeFunctionData('verifyProof', [value.pA, value.pB, value.pC, value.pubSignals]);
        // Reverts, malformed results and transport failures are NOT negative-control passes.
        const raw = await client.rpc('eth_call', [{ to: target, data }, deployment.anchor.number]);
        const decoded = abi.decodeFunctionResult('verifyProof', raw);
        assert.equal(raw.toLowerCase(), abi.encodeFunctionResult('verifyProof', decoded));
        checks.push({ circuit, name, result: decoded[0], passed: decoded[0] === expected });
      }
    }
    const after = await client.rpc('eth_getBlockByNumber', [deployment.anchor.number, false]);
    assert.equal(after.hash, deployment.anchor.hash);
    const passed = checks.every((c) => c.passed);
    fs.writeFileSync(path.join(output, 'circuits.json'), JSON.stringify({ passed, syntheticWitnessesOnly: true,
      signingEnabled: false, broadcastEnabled: false, chainStateVerified: false,
      runtimeSha256: require('../src/main/wallet/ppv2-runtime-manifest').sha256,
      metrics, checks, deployment, transport: client.metadata, requests: client.trace }, null, 2) + '\n');
    console.log(JSON.stringify({ passed, checks, metrics }));
    return passed ? 0 : 1;
  } finally { scope.close(); await client?.close(); }
}
main().then((code) => app.exit(code), (error) => { console.error('Synthetic qualification failed', error.code || error.name); app.exit(1); });
