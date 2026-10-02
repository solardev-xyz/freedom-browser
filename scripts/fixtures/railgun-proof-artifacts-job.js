/** Public POI vector and synthetic transaction inputs only; no user key or network capability. */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const vectorSha256 = 'a52eaba565f55ecc5aa657eb1d98dc9de24bf7351cc77d3c704bce8dc02fea84';
exports.run = async function run(inputText, { request, signal, guardReport }) {
  const input = JSON.parse(inputText);
  assert.ok(['01x01', '01x02', '01x03', '02x02', '02x03', 'POI_3x3'].includes(input.variant));
  const engineDirectory = path.join(__dirname, 'railgun-engine/node_modules');
  const inventory = require('../railgun-fixture-integrity').assertRailgunFixture(engineDirectory);
  const engine = path.join(engineDirectory, '@railgun-community/engine/dist');
  const archive = require('../../src/main/wallet/ppv2-runtime').verifyPPv2Runtime(input.archive);
  const serial = require(path.join(archive, 'serial-prover.cjs'));
  const bytes = fs.readFileSync(input.vectorFilename);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), vectorSha256);
  const vector = JSON.parse(bytes);
  const { createPrivacyScope } = require('../../src/main/networks/privacy-context');
  const scope = createPrivacyScope({ profileId: 'railgun-public-proof-fixture', signal });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-vector',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'artifacts',
  });
  const { loadRailgunArtifacts } = require('../../src/main/wallet/railgun-artifacts');
  const artifacts = await loadRailgunArtifacts({
    handle,
    directory: input.artifactDirectory,
    variant: input.variant,
  });
  try {
    await require(path.join(engine, 'utils/poseidon')).initPoseidonPromise;
    const { Prover } = require(path.join(engine, 'prover/prover'));
    const shape = input.variant.startsWith('POI') ? null : input.variant.split('x').map(Number);
    const prover = new Prover({
      getArtifacts: async (publicInputs) => {
        assert.equal(publicInputs.nullifiers.length, shape[0]);
        assert.equal(publicInputs.commitmentsOut.length, shape[1]);
        return artifacts;
      },
      getArtifactsPOI: async (i, o) => {
        assert.equal(i, 3);
        assert.equal(o, 3);
        return artifacts;
      },
    });
    prover.setSnarkJSGroth16(serial);
    assert.equal(globalThis.curve_bn128, null);
    const start = performance.now();
    let changedBoundParamsRejected = null;
    if (shape) {
      const witness = require('./railgun-proof-inputs').createPublicRailgunProofInputs(
        engine,
        ...shape
      );
      const result = await prover.proveRailgun('V2_PoseidonMerkle', witness, () => {});
      assert.equal(
        await prover.verifyRailgunProof(result.publicInputs, result.proof, artifacts),
        true
      );
      assert.equal(
        await prover.verifyRailgunProof(
          { ...result.publicInputs, merkleRoot: result.publicInputs.merkleRoot + 1n },
          result.proof,
          artifacts
        ),
        false
      );
      assert.equal(
        await prover.verifyRailgunProof(
          { ...result.publicInputs, boundParamsHash: result.publicInputs.boundParamsHash + 1n },
          result.proof,
          artifacts
        ),
        false
      );
      changedBoundParamsRejected = true;
    } else {
      const result = await prover.provePOI(
        vector,
        vector.listKey,
        [],
        vector.blindedCommitmentsOut,
        () => {}
      );
      assert.equal(await prover.verifyPOIProof(result.publicInputs, result.proof, 3, 3), true);
      const changed = {
        ...result.publicInputs,
        poiMerkleroots: [...result.publicInputs.poiMerkleroots],
      };
      changed.poiMerkleroots[0] = BigInt(changed.poiMerkleroots[0]) + 1n;
      assert.equal(await prover.verifyPOIProof(changed, result.proof, 3, 3), false);
    }
    assert.equal(globalThis.curve_bn128, null);
    assert.equal(guardReport().attempts, 0);
    const value = {
      publicVector: true,
      vectorSha256: shape ? null : vectorSha256,
      syntheticTransaction: !!shape,
      changedBoundParamsRejected,
      variant: input.variant,
      inventory: inventory.sha256,
      proverArchiveSha256: require('../../src/main/wallet/ppv2-runtime-manifest').sha256,
      verified: true,
      changedRootRejected: true,
      elapsedMs: Math.round(performance.now() - start),
      guards: guardReport(),
      submissions: 0,
      poiServiceCalls: 0,
      spendableGranted: false,
      electron: process.versions.electron,
    };
    assert.deepEqual(
      JSON.parse(await request(JSON.stringify({ id: 1, method: 'result', value }))),
      { id: 1, value: null }
    );
  } finally {
    artifacts.wasm.fill(0);
    artifacts.zkey.fill(0);
    scope.close();
  }
};
