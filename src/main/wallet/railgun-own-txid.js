/** Data-only comparison for post-transaction POI preparation. The caller must
 * authenticate every input and independently acquire current chain/root evidence.
 * A matching result is not an account receipt, proof or disclosure permission.
 * Capsule/nullifier associations must remain inside private account storage.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const {
  normalizeRailgunPrivateCapsule,
  digestRailgunPrivateCapsule,
} = require('./railgun-private-capsule');
const { extractRailgunTransactIntent } = require('./railgun-transact-intent');
const { inspectRailgunTransactReceipt } = require('./railgun-transact-receipt');
const { validRailgunTransactResolution } = require('./railgun-transact-resolution');
const { validateRailgunTxidRow } = require('./railgun-txid-projection');
const { validArchive } = require('./privacy-journal-retention');
const pins = require('./railgun-shield-pins.json');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function resolvedRecord(value) {
  if (Object.hasOwn(value, 'archivedAt')) {
    assert.ok(validArchive([value], 'public'));
    assert.ok(value.finalized.blockNumber >= value.railgun.finalizedBlockNumber);
    for (const anchor of [
      { number: value.blockNumber, hash: value.blockHash },
      { number: value.railgun.finalizedBlockNumber, hash: value.railgun.finalizedBlockHash },
    ]) {
      if (anchor.number === value.finalized.blockNumber)
        assert.equal(anchor.hash, value.finalized.blockHash);
    }
    return {
      record: {
        hash: value.hash,
        nonce: value.nonce,
        intent: value.intent,
        observation: {
          status: value.status,
          blockNumber: value.blockNumber,
          blockHash: value.blockHash,
        },
      },
      resolution: value.railgun,
      recordKind: 'archived',
    };
  }
  assert.ok(
    Object.keys(value).every((key) =>
      [
        'hash',
        'nonce',
        'state',
        'attemptedAt',
        'revision',
        'intent',
        'observation',
        'resolution',
      ].includes(key)
    ) &&
      integer(value.nonce) &&
      integer(value.attemptedAt) &&
      (value.revision === undefined || integer(value.revision)) &&
      value.observation?.trust === 'unverified' &&
      integer(value.observation.observedAt) &&
      ['attempted', 'submitted'].includes(value.state)
  );
  const r = value.resolution;
  assert.ok(
    r &&
      Number.isSafeInteger(r.reviewedAt) &&
      r.reviewedAt >= 0 &&
      r.minimumConfirmations >= 3 &&
      Number.isSafeInteger(r.minimumConfirmations) &&
      Number.isSafeInteger(value.observation?.confirmations) &&
      value.observation.confirmations >= r.minimumConfirmations &&
      r.blockHash === value.observation.blockHash
  );
  return { record: value, resolution: r.railgun, recordKind: 'active' };
}
function matchRailgunOwnTxid(input) {
  try {
    // Bound and detach plain data before comparing it. No asynchronous work or
    // caller callbacks are accepted by this primitive.
    const text = JSON.stringify(input);
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 128 * 1024);
    const {
      capsule: supplied,
      record: suppliedRecord,
      transaction,
      receipt,
      row,
    } = JSON.parse(text);
    const capsule = normalizeRailgunPrivateCapsule(supplied);
    const { record, resolution, recordKind } = resolvedRecord(suppliedRecord);
    assert.ok(
      validRailgunTransactResolution(resolution, record) && resolution.outcome === 'matched'
    );
    const outcome = inspectRailgunTransactReceipt(record, transaction, receipt);
    assert.equal(outcome.status, 'matched');
    assert.deepEqual(outcome, resolution.transact);
    const decoded = extractRailgunTransactIntent({
      chainId: transaction.chainId,
      to: transaction.to,
      value: transaction.value,
      data: transaction.input,
    });
    assert.deepEqual(decoded.intent, capsule.preparation.transaction);
    assert.deepEqual(decoded.expected, capsule.preparation.expected);
    assert.equal(decoded.intentDigest, record.intent.intentDigest);
    validateRailgunTxidRow(row);
    assert.equal(row.txid, record.hash.slice(2));
    assert.equal(BigInt(row.blockNumber), BigInt(receipt.blockNumber));
    const transactionIndex = BigInt(receipt.transactionIndex);
    assert.ok(transactionIndex <= BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(BigInt('0x' + row.graphID.slice(66, 130)), transactionIndex);
    // Narrow zero-slot policy, not a claim about the producer's ordinal scheme.
    // The pinned formatter copies this ID; it does not define its third limb.
    assert.equal(BigInt('0x' + row.graphID.slice(130)), 0n);
    assert.deepEqual(row.nullifiers, [decoded.expected.nullifier]);
    assert.deepEqual(row.commitments, [decoded.expected.commitment]);
    assert.equal(row.boundParamsHash, decoded.expected.boundParamsHash);
    assert.equal(row.utxoTreeIn, decoded.expected.tree);
    if (outcome.output.kind === 'shielded') {
      assert.equal(Object.hasOwn(row, 'unshield'), false);
      assert.equal(row.utxoTreeOut, outcome.output.tree);
      assert.equal(row.utxoBatchStartPositionOut, outcome.output.position);
    } else {
      assert.equal(row.utxoTreeOut, 99999);
      assert.equal(row.utxoBatchStartPositionOut, 99999);
      assert.deepEqual(row.unshield, {
        tokenData: {
          tokenType: 0,
          tokenAddress: pins.wrappedNative,
          tokenSubID: '0x' + '0'.repeat(64),
        },
        toAddress: decoded.expected.recipient,
        value: decoded.expected.amount,
      });
    }
    return freeze({
      status: 'matched',
      recordKind,
      capsuleDigest: digestRailgunPrivateCapsule(capsule),
      intentDigest: decoded.intentDigest,
      transactionHash: record.hash,
      blockHash: receipt.blockHash,
      blockNumber: row.blockNumber,
      transactionIndex: Number(transactionIndex),
      row,
      rowSha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      output: outcome.output,
      boundParamsCompared: true,
      unshieldPreimageCompared: outcome.output.kind === 'unshield',
      sourceAuthenticated: false,
      currentCanonicalityVerified: false,
      finalityVerified: false,
      txidPathVerified: false,
      txidRootAccepted: false,
      rowMetadataAuthenticated: false,
      unshieldCommitmentHashVerified: false,
      poiVerified: false,
      spendingEnabled: false,
    });
  } catch {
    throw Object.assign(new Error('Railgun own transaction binding unavailable'), {
      code: 'RAILGUN_OWN_TXID_REFUSED',
    });
  }
}
// Stable comparison data across observation refresh and archival. The original
// active/archive record is still required by the matcher; this projection is
// neither an authenticated account snapshot nor a current-finality grant.
function projectRailgunOwnRecord(value) {
  try {
    const text = JSON.stringify(value);
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 32768);
    const { record, resolution } = resolvedRecord(JSON.parse(text));
    assert.ok(
      validRailgunTransactResolution(resolution, record) && resolution.outcome === 'matched'
    );
    return freeze({
      hash: record.hash,
      nonce: record.nonce,
      intent: record.intent,
      status: record.observation.status,
      blockNumber: record.observation.blockNumber,
      blockHash: record.observation.blockHash,
      railgun: resolution,
    });
  } catch {
    throw Object.assign(new Error('Railgun own record comparison unavailable'), {
      code: 'RAILGUN_OWN_RECORD_REFUSED',
    });
  }
}
module.exports = { matchRailgunOwnTxid, projectRailgunOwnRecord };
