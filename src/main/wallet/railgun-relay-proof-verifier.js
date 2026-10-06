/** Keyless independent verification of both proof domains. Never imports a
 * producer, wallet, private witness assembler or credential broker. A successful
 * result is cryptographic evidence, not authenticated custody or permission. */
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
const { matchRailgunRelayProvedTransaction } = require('./railgun-relay-transaction');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hex = (v) => '0x' + v.toString(16).padStart(64, '0');
let attempted = false;
async function verifyRailgunRelayProofs(options) {
  let scope;
  const loaded = [];
  try {
    assert.equal(attempted, false);
    attempted = true;
    shape(options, [
      'archive',
      'proverArchive',
      'artifactDirectory',
      'identityText',
      'recordText',
      'signal',
    ]);
    const { archive, proverArchive, artifactDirectory, identityText, recordText, signal } = options;
    const active = () => assertRailgunRelaySignal(signal);
    active();
    const record = decodeRailgunRelayLocalRecord(recordText);
    assert.equal(record.state, 'ready-local');
    assert.ok(typeof identityText === 'string' && Buffer.byteLength(identityText) <= 512);
    const identity = JSON.parse(identityText);
    assert.equal(JSON.stringify(identity), identityText);
    shape(identity, ['walletId', 'spendingPublicKey']);
    assert.equal(identity.walletId, record.walletId);
    assert.ok(Array.isArray(identity.spendingPublicKey) && identity.spendingPublicKey.length === 2);
    for (const v of identity.spendingPublicKey) assert.match(v, /^[0-9a-f]{64}$/);
    const publicKey = identity.spendingPublicKey.map((v) => BigInt('0x' + v));
    const verified = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
    assert.equal(record.draft.engineSha256, require('./railgun-engine-manifest.json').sha256);
    const imp = (name) =>
      require(path.join(verified, 'node_modules/@railgun-community/engine/dist', name));
    const { poseidon, initPoseidonPromise } = imp('utils/poseidon');
    await initPoseidonPromise;
    active();
    const checked = matchRailgunRelayProvedTransaction(
      record.draft.intent,
      record.proved.transaction
    );
    const [[tx]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
      'transact',
      checked.transaction.data
    );
    // boundParamsHash is recomputed by the pure original-intent normalizer.
    const signals = [
      tx.merkleRoot,
      BigInt(record.draft.intent.expected.boundParamsHash),
      ...tx.nullifiers,
      ...tx.commitments,
    ];
    for (let i = 0; i < signals.length; i++) signals[i] = BigInt(signals[i]);
    assert.equal(signals.length, 5);
    const expected = record.draft.intent.expected;
    assert.deepEqual(signals.map(hex), [
      expected.merkleRoot,
      expected.boundParamsHash,
      expected.nullifier,
      expected.feeCommitment,
      expected.selfCommitment,
    ]);
    const message = poseidon(signals);
    assert.equal(hex(message), record.draft.intent.expectedHash);
    assert.equal(
      imp('utils/keys-utils').verifyEDDSA(
        message,
        { R8: record.signature.R8.map(BigInt), S: BigInt(record.signature.S) },
        publicKey
      ),
      true
    );
    const math = await require('./railgun-relay-pre-poi-math').verifyRailgunRelayPrePoiPublicMath({
      archive: verified,
      draftText: JSON.stringify(record.draft),
      history: record.history,
      binding: record.prePoiBinding,
      signal,
    });
    active();
    assert.equal(math.historicalEventSignatureVerified, true);
    assert.equal(math.historicalMembershipPathVerified, true);
    const p = tx.proof;
    const spendProof = {
      pi_a: [p.a.x, p.a.y, 1n],
      pi_b: [
        [p.b.x[1], p.b.x[0]],
        [p.b.y[1], p.b.y[0]],
        [1n, 0n],
      ],
      pi_c: [p.c.x, p.c.y, 1n],
      protocol: 'groth16',
      curve: 'bn128',
    };
    const q = record.proved.payload.snarkProof;
    const poiProof = {
      pi_a: [...q.pi_a, '1'],
      pi_b: [...q.pi_b.map((v) => [...v]), ['1', '0']],
      pi_c: [...q.pi_c, '1'],
      protocol: 'groth16',
      curve: 'bn128',
    };
    const serial = require('./railgun-prover-runtime').loadRailgunProverRuntime(proverArchive);
    assert.equal(globalThis.curve_bn128, null);
    scope = require('../networks/privacy-context').createPrivacyScope({
      profileId: 'railgun-relay-independent-proof',
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
    for (const [variant, publicSignals, proof] of [
      ['01x02', signals, spendProof],
      ['POI_3x3', math.publicSignals, poiProof],
    ]) {
      const artifact = await require('./railgun-artifacts').loadRailgunArtifacts({
        handle,
        directory: artifactDirectory,
        variant,
      });
      loaded.push(artifact);
      active();
      assert.equal(artifact.vkey.nPublic, publicSignals.length);
      assert.equal(await serial.verify(artifact.vkey, publicSignals, proof), true);
      active();
    }
    assert.equal(globalThis.curve_bn128, null);
    const artifactVkeys = Object.fromEntries(
      ['01x02', 'POI_3x3'].map((variant) => [
        variant,
        require('./railgun-artifacts').manifest[variant].find((entry) => entry.kind === 'vkey')
          .sha256,
      ])
    );
    return freeze({
      engineSha256: require('./railgun-engine-manifest.json').sha256,
      proverSha256: require('./railgun-prover-manifest.json').sha256,
      artifactVkeys,
      recordDigest: digestRailgunRelayLocalIntent(recordText),
      draftDigest: math.draftDigest,
      historyDigest: math.historyDigest,
      expectedHash: record.draft.intent.expectedHash,
      transactionDigest: digest(record.proved.transaction),
      payloadDigest: digest(record.proved.payload),
      transactionVerified: true,
      prePoiVerified: true,
      historicalEventSignatureVerified: true,
      historicalMembershipPathVerified: true,
      inputOwnershipVerified: false,
      currentMembershipVerified: false,
      authorityGranted: false,
    });
  } catch {
    throw Object.assign(new Error('Railgun independent relay proof refused'), {
      code: 'RAILGUN_RELAY_PROOF_VERIFICATION_REFUSED',
    });
  } finally {
    for (const artifact of loaded) {
      artifact.wasm.fill(0);
      artifact.zkey.fill(0);
    }
    scope?.close();
  }
}
module.exports = { verifyRailgunRelayProofs };
