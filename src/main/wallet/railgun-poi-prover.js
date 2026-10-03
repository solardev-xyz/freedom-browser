/** Utility-only local POI proving over internally assembled viewing data.
 * Fresh-process caller required; this same-process verification is not the
 * independent verifier or a live source/membership/disclosure capability.
 * Caller owns the original viewing key and must wipe it after this settles.
 */
const assert = require('assert/strict');
const path = require('path');
const { prepareRailgunPoiWitness } = require('./railgun-poi-witness');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { createPrivacyScope } = require('../networks/privacy-context');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
let attempted = false;
async function proveRailgunPoi(options) {
  let artifacts, scope;
  try {
    assert.equal(attempted, false);
    attempted = true;
    const { proverArchive, artifactDirectory, ...assembly } = options;
    const { signal } = assembly;
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    assert.ok(path.isAbsolute(artifactDirectory));
    // This call snapshots all assembly data/key before its first await.
    const prepared = await prepareRailgunPoiWitness(assembly);
    active();
    const expected = structuredClone(prepared.expectedPublicInputs);
    const signals = [
      ...expected.blindedCommitmentsOut,
      expected.anyRailgunTxidMerklerootAfterTransaction,
      expected.railgunTxidIfHasUnshield,
      ...expected.poiMerkleroots,
    ];
    assert.equal(signals.length, 8);
    const publicFields = {
      listKey: prepared.listKey,
      poiMerkleroots: [hex(expected.poiMerkleroots[0]).slice(2)],
      txidMerkleroot: hex(expected.anyRailgunTxidMerklerootAfterTransaction).slice(2),
      txidMerklerootIndex: prepared.txidRootIndex,
      blindedCommitmentsOut: prepared.blindedOut.map((v) => hex(v)),
      railgunTxidIfHasUnshield:
        expected.railgunTxidIfHasUnshield === 0n ? '0x00' : hex(expected.railgunTxidIfHasUnshield),
    };
    const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(
      assembly.archive
    );
    const debug = require(
      path.join(archive, 'node_modules/@railgun-community/engine/dist/debugger/debugger')
    ).default;
    assert.equal(debug.engineDebugger, undefined);
    const serial = require('./railgun-prover-runtime').loadRailgunProverRuntime(proverArchive);
    assert.equal(typeof serial.fullProve, 'function');
    assert.equal(typeof serial.verify, 'function');
    assert.equal(globalThis.curve_bn128, null);
    scope = createPrivacyScope({ profileId: 'railgun-local-poi-proof', signal });
    artifacts = await require('./railgun-artifacts').loadRailgunArtifacts({
      handle: scope.getContext({
        kind: 'private-account',
        principal: 'proof',
        protocol: 'railgun',
        deployment: 'offline',
        chainId: 11155111,
        role: 'artifacts',
      }),
      directory: artifactDirectory,
      variant: 'POI_3x3',
    });
    active();
    const { Prover } = require(
      path.join(archive, 'node_modules/@railgun-community/engine/dist/prover/prover')
    );
    const prover = new Prover({
      getArtifactsPOI: async (i, o) => {
        active();
        assert.equal(i, 3);
        assert.equal(o, 3);
        return artifacts;
      },
    });
    prover.setSnarkJSGroth16(serial);
    assert.equal(debug.engineDebugger, undefined);
    const proved = await prover.provePOI(
      prepared.inputs,
      prepared.listKey,
      prepared.blindedIn,
      prepared.blindedOut,
      () => {}
    );
    active();
    assert.deepEqual(proved.publicInputs, expected);
    assert.equal(debug.engineDebugger, undefined);
    const payload = normalizeRailgunPoiPayload({ ...publicFields, proof: proved.proof });
    assert.equal(await serial.verify(artifacts.vkey, signals, payload.proof), true);
    const changed = [...signals];
    changed[3] = (changed[3] + 1n) % FIELD;
    assert.equal(await serial.verify(artifacts.vkey, changed, payload.proof), false);
    active();
    assert.equal(globalThis.curve_bn128, null);
    return Object.freeze({
      payload,
      locallyVerified: true,
      independentlyVerified: false,
      sourceAuthenticated: false,
      membershipAuthenticated: false,
      rootAccepted: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
  } catch {
    throw Object.assign(new Error('Railgun POI proof unavailable'), {
      code: 'RAILGUN_POI_PROOF_REFUSED',
    });
  } finally {
    artifacts?.wasm.fill(0);
    artifacts?.zkey.fill(0);
    scope?.close();
  }
}
module.exports = { proveRailgunPoi };
