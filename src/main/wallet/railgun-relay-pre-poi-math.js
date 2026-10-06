/** Keyless public equations, not a proof verifier. Hidden output NPKs cannot be
 * derived from commitments: the two supplied blinds remain unverified until a
 * separate actual POI proof checks them against these independently derived
 * signals. No wallet, key, private reconstruction or assembler is imported.
 */
const assert = require('assert/strict');
const path = require('path');
const { keccak256, toUtf8Bytes } = require('ethers');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const { verifyPoiEvent, verifyPoiMembership } = require('./railgun-poi-records');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => v.toString(16).padStart(64, '0');
async function verifyRailgunRelayPrePoiPublicMath(options) {
  try {
    shape(options, ['archive', 'draftText', 'history', 'binding', 'signal']);
    const { signal, archive, draftText } = options;
    const active = () => assertRailgunRelaySignal(signal);
    active();
    assert.ok(typeof draftText === 'string' && Buffer.byteLength(draftText) <= 65536);
    const draft = normalizeRailgunRelayDraftCapsule(JSON.parse(draftText));
    assert.equal(JSON.stringify(draft.data), draftText);
    const history = normalizeRailgunRelayPoiHistory(options.history);
    const binding = normalizeRailgunRelayPrePoiBinding(options.binding);
    assert.equal(history.data.draftDigest, draft.digest);
    assert.equal(binding.draftDigest, draft.digest);
    assert.deepEqual(binding.listWitness, history.data.proof);
    verifyPoiEvent([history.data.event], history.data.note, history.data.proof);
    const verified = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
    const { poseidon, initPoseidonPromise } = require(
      path.join(verified, 'node_modules/@railgun-community/engine/dist/utils/poseidon')
    );
    await initPoseidonPromise;
    active();
    verifyPoiMembership([history.data.proof], [history.data.note], (a, b) =>
      hex(poseidon([BigInt('0x' + a), BigInt('0x' + b)]))
    );
    // Repeat the public equations; do not call producer TXID/path helpers.
    const zero = BigInt(keccak256(toUtf8Bytes('Railgun'))) % FIELD;
    assert.equal(hex(zero), require('./railgun-public-records').ZERO_NODES[0]);
    const { expected } = draft.data.intent;
    const nullifiers = [BigInt(expected.nullifier), ...Array(12).fill(zero)];
    const commitments = [
      BigInt(expected.feeCommitment),
      BigInt(expected.selfCommitment),
      ...Array(11).fill(zero),
    ];
    const txid = poseidon([
      poseidon(nullifiers),
      poseidon(commitments),
      BigInt(expected.boundParamsHash),
    ]);
    const position = 199999n * 65536n + 199999n;
    const leaf = poseidon([txid, BigInt(draft.data.selection.tree), position]);
    let root = leaf;
    for (let i = 0; i < 16; i++) root = poseidon([root, 0n]);
    assert.equal(binding.txidLeafHash, hex(leaf));
    assert.equal(binding.txidMerkleroot, hex(root));
    const publicSignals = [
      ...binding.blindedCommitmentsOut.map(BigInt),
      0n,
      root,
      0n,
      BigInt('0x' + history.data.proof.root),
      zero,
      zero,
    ];
    active();
    return freeze({
      draftDigest: draft.digest,
      historyDigest: history.digest,
      txidLeafHash: hex(leaf),
      txidMerkleroot: hex(root),
      publicSignals,
      historicalEventSignatureVerified: true,
      historicalMembershipPathVerified: true,
      outputBlindingVerified: false,
      inputOwnershipVerified: false,
      proofVerified: false,
      currentMembershipVerified: false,
      authorityGranted: false,
    });
  } catch {
    throw Object.assign(new Error('Railgun relay pre-transaction public math refused'), {
      code: 'RAILGUN_RELAY_PRE_POI_MATH_REFUSED',
    });
  }
}
module.exports = { verifyRailgunRelayPrePoiPublicMath };
