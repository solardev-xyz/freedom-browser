/** Separate-process raw proof verification. No producer helper or private inputs. */
const assert = require('assert/strict');
const path = require('path');
const { validatePublicCase } = require('./railgun-relay-public-data');
let attempted = false;
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.equal(attempted, false);
  attempted = true;
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'artifactDirectory',
    'minGasPrice',
    'proverArchive',
    'publicCase',
  ]);
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const engine = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const poseidonModule = require(path.join(engine, 'utils/poseidon'));
  await poseidonModule.initPoseidonPromise;
  const checked = validatePublicCase(input.publicCase, input.minGasPrice, poseidonModule.poseidon);
  const serial = require('../../src/main/wallet/railgun-prover-runtime').loadRailgunProverRuntime(
    input.proverArchive
  );
  const scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'public-relay-verify-fixture',
    signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-vector',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'artifacts',
  });
  const loaded = [];
  let changedSignalsRefused = 0;
  try {
    for (const [variant, signals, proof] of [
      ['01x02', checked.transactionSignals, checked.transactionProof],
      ['POI_3x3', checked.poiSignals, checked.poiProof],
    ]) {
      const artifact =
        await require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts({
          handle,
          directory: input.artifactDirectory,
          variant,
        });
      loaded.push(artifact);
      active();
      assert.equal(artifact.vkey.nPublic, signals.length);
      assert.equal(await serial.verify(artifact.vkey, signals, proof), true);
      for (let i = 0; i < signals.length; i++) {
        const changed = [...signals];
        changed[i] =
          (changed[i] + 1n) %
          21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        assert.equal(await serial.verify(artifact.vkey, changed, proof), false);
        changedSignalsRefused++;
        active();
      }
    }
    assert.equal(changedSignalsRefused, 13);
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    assert.equal(globalThis.curve_bn128, null);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 1,
            method: 'result',
            value: {
              minGasPrice: input.minGasPrice,
              transactionVerified: true,
              prePoiVerified: true,
              feeAndSelfCommitmentsMatched: true,
              sameTransactionPrePoiRootMatched: true,
              syntheticListRootMatched: true,
              productionPolicyRefused: true,
              productionPayloadRefused: true,
              changedSignalsRefused,
              authorityGranted: false,
              serviceAcceptanceQualified: false,
              guards,
            },
          })
        )
      ),
      { id: 1, value: null }
    );
  } finally {
    for (const a of loaded) {
      a.wasm.fill(0);
      a.zkey.fill(0);
    }
    scope.close();
  }
};
