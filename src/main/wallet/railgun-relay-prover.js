/** Utility-only, single attempt over an original signed local record. Private
 * witnesses never leave this function. Wallet/scan/checkpoint are the fixed
 * restored utility's internal objects, not caller-provided note authority. */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const { Interface } = require('ethers');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const {
  decodeRailgunRelayLocalRecord,
  digestRailgunRelayLocalIntent,
} = require('./railgun-relay-recovery-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { bindRailgunRelayPrePoiPayload } = require('./railgun-relay-pre-poi-data');
const { matchRailgunRelayProvedTransaction } = require('./railgun-relay-transaction');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (v) => '0x' + v.toString(16).padStart(64, '0');
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let attempted = false;
async function proveRailgunRelayLocal(options) {
  let scope;
  const loaded = [];
  try {
    assert.equal(attempted, false);
    attempted = true;
    shape(options, [
      'archive',
      'proverArchive',
      'artifactDirectory',
      'wallet',
      'descriptor',
      'checkpoint',
      'scan',
      'recordText',
      'signal',
    ]);
    const { archive, proverArchive, artifactDirectory, wallet, recordText, signal } = options;
    const active = () => assertRailgunRelaySignal(signal);
    active();
    const record = decodeRailgunRelayLocalRecord(recordText);
    assert.equal(record.state, 'signed');
    const draft = normalizeRailgunRelayDraftCapsule(record.draft);
    const history = normalizeRailgunRelayPoiHistory(record.history);
    // These objects originate in the fixed restored utility. Snapshot public
    // restore metadata before any await; never clone the wallet/key instance.
    const descriptor = structuredClone(options.descriptor);
    const checkpoint = structuredClone(options.checkpoint);
    const scan = structuredClone(options.scan);
    assert.equal(record.walletId, descriptor.walletId);
    assert.ok(
      Array.isArray(descriptor.spendingPublicKey) && descriptor.spendingPublicKey.length === 2
    );
    for (const v of descriptor.spendingPublicKey) assert.match(v, /^[0-9a-f]{64}$/);
    const publicKey = Array.from(descriptor.spendingPublicKey, (v) => BigInt('0x' + v));
    const verified = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
    assert.equal(draft.data.engineSha256, require('./railgun-engine-manifest.json').sha256);
    const imp = (name) =>
      require(path.join(verified, 'node_modules/@railgun-community/engine/dist', name));
    const poseidonModule = imp('utils/poseidon');
    await poseidonModule.initPoseidonPromise;
    active();
    const debug = imp('debugger/debugger').default;
    assert.equal(debug.engineDebugger, undefined);
    const serial = require('./railgun-prover-runtime').loadRailgunProverRuntime(proverArchive);
    assert.equal(globalThis.curve_bn128, null);
    scope = require('../networks/privacy-context').createPrivacyScope({
      profileId: 'railgun-local-relay-prover',
      signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'proof',
      protocol: 'railgun',
      deployment: 'offline',
      chainId: 11155111,
      role: 'artifacts',
    });
    for (const variant of ['01x02', 'POI_3x3']) {
      loaded.push(
        await require('./railgun-artifacts').loadRailgunArtifacts({
          handle,
          directory: artifactDirectory,
          variant,
        })
      );
      active();
    }
    assert.equal(loaded[0].vkey.nPublic, 5);
    assert.equal(loaded[1].vkey.nPublic, 8);
    const prepared =
      await require('./railgun-relay-pre-poi-witness').restoreRailgunRelayPrePoiWitness({
        archive: verified,
        wallet,
        descriptor,
        checkpoint,
        scan,
        draftText: JSON.stringify(draft.data),
        history: history.data,
        signal,
      });
    active();
    assert.deepEqual(prepared.binding, record.prePoiBinding);
    assert.equal(prepared.historyDigest, history.digest);
    const { witness } = prepared,
      pub = witness.publicInputs,
      expected = draft.data.intent.expected;
    assert.equal(witness.txidVersion, 'V2_PoseidonMerkle');
    assert.deepEqual(witness.privateInputs.publicKey, publicKey);
    const signals = [pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut];
    assert.deepEqual(signals.map(hex), [
      expected.merkleRoot,
      expected.boundParamsHash,
      expected.nullifier,
      expected.feeCommitment,
      expected.selfCommitment,
    ]);
    const message = poseidonModule.poseidon(signals);
    assert.equal(hex(message), draft.data.intent.expectedHash);
    const signature = { R8: record.signature.R8.map(BigInt), S: BigInt(record.signature.S) };
    assert.equal(imp('utils/keys-utils').verifyEDDSA(message, signature, publicKey), true);
    const { Prover } = imp('prover/prover');
    const prover = new Prover({
      getArtifacts: async (value) => {
        active();
        assert.deepEqual(value, pub);
        return loaded[0];
      },
      getArtifactsPOI: async (inputs, outputs) => {
        active();
        assert.equal(inputs, 3);
        assert.equal(outputs, 3);
        return loaded[1];
      },
    });
    prover.setSnarkJSGroth16(serial);
    const spend = await prover.proveRailgun(
      'V2_PoseidonMerkle',
      { ...witness, signature: [...signature.R8, signature.S] },
      () => {}
    );
    active();
    assert.equal(debug.engineDebugger, undefined);
    assert.deepEqual(spend.publicInputs, pub);
    assert.equal(await serial.verify(loaded[0].vkey, signals, spend.proof), true);
    active();
    const abi = new Interface([TRANSACT_ABI]);
    const [[original]] = abi.decodeFunctionData('transact', draft.data.intent.transaction.data);
    const transaction = matchRailgunRelayProvedTransaction(draft.data.intent, {
      ...draft.data.intent.transaction,
      data: abi.encodeFunctionData('transact', [
        [
          [
            Prover.formatProof(spend.proof),
            original.merkleRoot,
            original.nullifiers,
            original.commitments,
            original.boundParams,
            original.unshieldPreimage,
          ],
        ],
      ]),
    }).transaction;
    const poi = await prover.provePOI(
      prepared.inputs,
      REQUIRED_LIST,
      [record.history.note.blindedCommitment],
      prepared.binding.blindedCommitmentsOut,
      () => {}
    );
    active();
    assert.equal(debug.engineDebugger, undefined);
    const poiSignals = [
      ...poi.publicInputs.blindedCommitmentsOut,
      poi.publicInputs.anyRailgunTxidMerklerootAfterTransaction,
      poi.publicInputs.railgunTxidIfHasUnshield,
      ...poi.publicInputs.poiMerkleroots,
    ];
    assert.deepEqual(poiSignals, prepared.publicSignals);
    const proof = poi.proof;
    const payload = bindRailgunRelayPrePoiPayload(
      {
        snarkProof: {
          pi_a: proof.pi_a.slice(0, 2).map(String),
          pi_b: proof.pi_b.slice(0, 2).map((v) => v.slice(0, 2).map(String)),
          pi_c: proof.pi_c.slice(0, 2).map(String),
        },
        txidMerkleroot: prepared.binding.txidMerkleroot,
        poiMerkleroots: [prepared.binding.listWitness.root],
        blindedCommitmentsOut: prepared.binding.blindedCommitmentsOut,
        railgunTxidIfHasUnshield: '0x00',
      },
      prepared.binding
    ).payload;
    assert.equal(await serial.verify(loaded[1].vkey, poiSignals, proof), true);
    active();
    assert.equal(globalThis.curve_bn128, null);
    return freeze({
      recordDigest: digestRailgunRelayLocalIntent(recordText),
      draftDigest: draft.digest,
      historyDigest: history.digest,
      expectedHash: draft.data.intent.expectedHash,
      transaction,
      payload,
      transactionDigest: digest(transaction),
      payloadDigest: digest(payload),
      locallyVerified: true,
      independentlyVerified: false,
    });
  } catch {
    throw Object.assign(new Error('Railgun local relay proof refused'), {
      code: 'RAILGUN_RELAY_PROOF_REFUSED',
    });
  } finally {
    for (const artifact of loaded) {
      artifact.wasm.fill(0);
      artifact.zkey.fill(0);
    }
    scope?.close();
  }
}
module.exports = { proveRailgunRelayLocal };
