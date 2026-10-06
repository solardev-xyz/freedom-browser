/** New process, original serialized public draft, actual engine reconstruction.
 * Captured list history authenticates a DIFFERENT, unowned public note. */
const assert = require('assert/strict');
const {
  createVector,
  hex,
  sha,
  copy,
  capturedHistory,
  bindingFor,
  SPENDING_PUBLIC,
} = require('./railgun-relay-core-data');
let attempted = false;
async function refused(action, code) {
  let error;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
}
exports.run = async (text, { request, signal, guardReport }) => {
  assert.equal(attempted, false);
  attempted = true;
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), ['archive', 'draftText']);
  assert.equal(typeof input.draftText, 'string');
  const normalized =
    require('../../src/main/wallet/railgun-relay-capsule').normalizeRailgunRelayDraftCapsule(
      JSON.parse(input.draftText)
    );
  assert.equal(JSON.stringify(normalized.data), input.draftText);
  let vector;
  try {
    vector = await createVector(input.archive, signal);
    const core = require('../../src/main/wallet/railgun-relay-reconstruct');
    const args = { ...vector.args, draftText: input.draftText };
    const fresh = await core.reconstructRailgunRelayWitness(args);
    vector.active();
    const diagnostic = await core.reconstructRailgunRelayDraft(args);
    assert.deepEqual(diagnostic, fresh.publicReconstruction);
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      'draftDigest',
      'expectedHash',
      'recoveredOutputs',
    ]);
    const expected = normalized.data.intent.expected,
      pub = fresh.witness.publicInputs,
      priv = fresh.witness.privateInputs;
    assert.deepEqual(pub, {
      merkleRoot: BigInt(expected.merkleRoot),
      boundParamsHash: BigInt(expected.boundParamsHash),
      nullifiers: [BigInt(expected.nullifier)],
      commitmentsOut: [BigInt(expected.feeCommitment), BigInt(expected.selfCommitment)],
    });
    assert.deepEqual(priv, {
      tokenAddress: BigInt('0x' + vector.note.tokenHash),
      randomIn: [BigInt('0x' + vector.note.random)],
      valueIn: [1000n],
      pathElements: [vector.roots.original.elements.map((v) => BigInt('0x' + v))],
      leavesIndices: [0n],
      valueOut: [100n, 900n],
      publicKey: [...SPENDING_PUBLIC],
      npkOut: [...fresh.prePoi.npksOut],
      nullifyingKey: vector.args.wallet.getNullifyingKey(),
    });
    assert.equal(fresh.prePoi.inputNoteType, 'Shield');
    assert.equal(fresh.prePoi.inputNpk, vector.note.notePublicKey);
    assert.equal(fresh.prePoi.token, vector.note.tokenHash);
    assert.deepEqual(fresh.prePoi.randomsIn, [vector.note.random]);
    assert.deepEqual(fresh.prePoi.valuesIn, [1000n]);
    assert.deepEqual(fresh.prePoi.valuesOut, [100n, 900n]);
    assert.deepEqual(fresh.prePoi.utxoPositionsIn, [0]);
    assert.equal(fresh.prePoi.utxoTreeIn, 0);
    const { poseidon } = vector.imp('utils/poseidon');
    for (let i = 0; i < 2; i++)
      assert.equal(
        poseidon([
          fresh.prePoi.npksOut[i],
          BigInt('0x' + fresh.prePoi.token),
          fresh.prePoi.valuesOut[i],
        ]),
        pub.commitmentsOut[i]
      );
    const grown = {
      ...args,
      checkpoint: {
        state: { trees: [{ tree: 0, length: 2, root: '0x' + vector.roots.grown.root }] },
      },
    };
    const cold = await core.reconstructRailgunRelayLocalWitness(grown);
    assert.deepEqual(cold, fresh);
    await refused(
      () => core.reconstructRailgunRelayWitness(grown),
      'RAILGUN_RELAY_RECONSTRUCTION_REFUSED'
    );
    await refused(
      () => core.reconstructRailgunRelayDraft(grown),
      'RAILGUN_RELAY_RECONSTRUCTION_REFUSED'
    );
    const damaged = copy(normalized.data);
    damaged.pathElements[0] = '0x' + vector.roots.grown.elements[0];
    await refused(
      () =>
        core.reconstructRailgunRelayLocalWitness({ ...grown, draftText: JSON.stringify(damaged) }),
      'RAILGUN_RELAY_RECONSTRUCTION_REFUSED'
    );
    vector.active();
    const history = capturedHistory(input.draftText);
    const binding = bindingFor(input.draftText, history, fresh, vector.imp);
    const math = require('../../src/main/wallet/railgun-relay-pre-poi-math');
    const mathOptions = {
      archive: input.archive,
      draftText: input.draftText,
      history,
      binding,
      signal,
    };
    const checked = await math.verifyRailgunRelayPrePoiPublicMath(mathOptions);
    assert.equal(checked.historicalEventSignatureVerified, true);
    assert.equal(checked.historicalMembershipPathVerified, true);
    for (const key of [
      'outputBlindingVerified',
      'inputOwnershipVerified',
      'proofVerified',
      'currentMembershipVerified',
      'authorityGranted',
    ])
      assert.equal(checked[key], false);
    assert.deepEqual(checked.publicSignals, [
      ...binding.blindedCommitmentsOut.map(BigInt),
      0n,
      BigInt('0x' + binding.txidMerkleroot),
      0n,
      BigInt('0x' + history.proof.root),
      ...Array(2).fill(vector.imp('models/merkletree-types').MERKLE_ZERO_VALUE_BIGINT),
    ]);
    const badSignature = copy(history);
    badSignature.event.signedPOIEvent.signature = '00'.repeat(64);
    await refused(
      () => math.verifyRailgunRelayPrePoiPublicMath({ ...mathOptions, history: badSignature }),
      'RAILGUN_RELAY_PRE_POI_MATH_REFUSED'
    );
    const badHistory = copy(history),
      badBinding = copy(binding);
    badHistory.proof.elements[0] = hex(0);
    badBinding.listWitness = copy(badHistory.proof);
    await refused(
      () =>
        math.verifyRailgunRelayPrePoiPublicMath({
          ...mathOptions,
          history: badHistory,
          binding: badBinding,
        }),
      'RAILGUN_RELAY_PRE_POI_MATH_REFUSED'
    );
    // Independent input-blind formula, not the assembler's helper. It is unequal
    // to the real captured leaf before the full assembler is attempted.
    const inputBlind = '0x' + hex(poseidon([vector.note.hash, vector.note.notePublicKey, 0n]));
    assert.equal(inputBlind, vector.args.scan.ownedPoi[0].blindedCommitment);
    assert.notEqual(inputBlind, history.note.blindedCommitment);
    let completed = 0;
    const original = core.reconstructRailgunRelayWitness;
    const observed = function (...values) {
      const promise = Reflect.apply(original, this, values);
      Promise.prototype.then.call(
        promise,
        () => {
          completed++;
        },
        () => {}
      );
      return promise;
    };
    core.reconstructRailgunRelayWitness = observed;
    try {
      await refused(
        () =>
          require('../../src/main/wallet/railgun-relay-pre-poi-witness').prepareRailgunRelayPrePoiWitness(
            {
              archive: args.archive,
              wallet: args.wallet,
              descriptor: args.descriptor,
              checkpoint: args.checkpoint,
              scan: args.scan,
              draftText: args.draftText,
              signal,
              history,
            }
          ),
        'RAILGUN_RELAY_PRE_POI_WITNESS_REFUSED'
      );
      assert.equal(completed, 1);
    } finally {
      assert.equal(core.reconstructRailgunRelayWitness, observed);
      core.reconstructRailgunRelayWitness = original;
    }
    vector.active();
    const value = {
      draftSha256: sha(input.draftText),
      draftDigest: normalized.digest,
      originalRoot: vector.roots.original.root,
      grownRoot: vector.roots.grown.root,
      diagnosticContainsOnlyPublicFields: true,
      freshPrivateInputsChecked: true,
      independentOutputCommitmentsChecked: true,
      twoLeafGrowthVerified: true,
      localOriginalWitnessPreserved: true,
      freshChangedRootRefused: true,
      diagnosticChangedRootRefused: true,
      changedOriginalPathRefused: true,
      historicalEventSignatureVerified: true,
      historicalMembershipPathVerified: true,
      historicalSignatureMutationRefused: true,
      historicalPathMutationRefused: true,
      assemblerOriginalCoreCompleted: true,
      independentInputBlindUnequal: true,
      assemblerMismatchedOwnedNoteRefused: true,
      exactFailureCauseIndependentlyAttributed: false,
      inputOwnershipVerified: false,
      outputBlindingVerified: false,
      proofVerified: false,
      currentMembershipVerified: false,
      authorityGranted: false,
      publicSignals: checked.publicSignals.map(hex),
      historicalRoot: history.proof.root,
      guards: guardReport(),
    };
    assert.deepEqual(value.guards, require('../qualify-railgun-relay-proof').EXPECTED_GUARDS);
    const wire = JSON.stringify({ id: 1, method: 'result', value });
    assert.ok(Buffer.byteLength(wire) <= 16384);
    assert.deepEqual(JSON.parse(await request(wire)), { id: 1, value: null });
    vector.active();
  } finally {
    vector?.close();
  }
};
