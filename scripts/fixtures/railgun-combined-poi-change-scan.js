/** Offline qualification composition: advance the genuine enrolled wallet over
 * the already advanced first partial transaction, then snapshot its owned change
 * for the disposable list. This does not advance public/TXID history, admit the
 * change to a list, or issue a second-spend capability. The required signal is
 * the outer identity/profile lifetime, which must outlive deliberate enrollment
 * and coordinator reopen. Never substitute the wallet/enrollment signal. */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function scanCombinedPoiChange(options) {
  assert.deepEqual(Object.keys(options).sort(), [
    'archive',
    'artifactDirectory',
    'coordinator',
    'enrollment',
    'identity',
    'originalNoteId',
    'proof',
    'proverArchive',
    'signal',
    'signature',
    'store',
  ]);
  const {
    identity,
    enrollment,
    coordinator,
    archive,
    proverArchive,
    artifactDirectory,
    proof,
    store,
    signature,
    originalNoteId,
    signal,
  } = options;
  assert.ok(signal instanceof AbortSignal);
  const owners = Object.freeze({ identity, enrollment, coordinator });
  const { assertRailgunOwnPoiProof } = require(wallet + 'railgun-own-poi-proof');
  const { openRailgunAccountWallet, readRailgunAccountOwnedNotes } = require(
    wallet + 'railgun-account-wallet'
  );
  const current = () => {
    assert.ok(!signal.aborted);
    return assertRailgunOwnPoiProof(proof, enrollment, coordinator);
  };
  const history = current();
  assert.equal(archive, history.archive);
  const capsule = require(wallet + 'railgun-private-capsule').normalizeRailgunPrivateCapsule(
    history.capture.capsule
  );
  assert.equal(capsule.version, 2);
  assert.equal(capsule.selection.kind, 'railgun-partial-unshield');
  assert.equal(capsule.walletId, enrollment.descriptor.walletId);
  assert.equal(originalNoteId, `${capsule.selection.tree}:${capsule.selection.position}`);
  const matched = require(wallet + 'railgun-own-txid').matchRailgunOwnTxid(
    history.preparation.ownEvidence
  );
  assert.equal(matched.output.kind, 'partial-unshield');
  assert.equal(matched.capsuleDigest, history.capture.capsuleDigest);
  assert.deepEqual(history.preparation.ownEvidence.capsule, capsule);
  const firstTxid = '0x' + matched.row.txid;
  const changeId = `${matched.output.change.tree}:${matched.output.change.position}`;
  assert.notEqual(changeId, originalNoteId);
  const inputAmount = BigInt(capsule.preparation.inputAmount),
    unshieldAmount = BigInt(capsule.preparation.unshieldAmount),
    changeAmount = BigInt(capsule.preparation.changeAmount);
  assert.ok(unshieldAmount > 0n && unshieldAmount < inputAmount);
  assert.equal(changeAmount, inputAmount - unshieldAmount);
  // Require the actual enrolled cached store, rather than accepting a get()
  // callback as evidence. existingOnly cannot create missing prepared history.
  assert.equal(await enrollment.openPoiIntents({ existingOnly: true }), store);
  current();
  const entry = await store.get(history.capture.capsuleDigest);
  current();
  assert.ok(entry);
  assert.equal(entry.state, 'prepared');
  assert.equal(entry.capsuleDigest, history.capture.capsuleDigest);
  assert.equal(entry.bindingDigest, history.capture.bindingDigest);
  assert.deepEqual(entry.selector, history.capture.selector);
  assert.deepEqual(entry.payload, history.payload);
  assert.equal(entry.payloadSha256, history.payloadSha256);
  assert.equal(entry.payloadSha256, sha(entry.payload));
  assert.equal(entry.inputSha256, history.inputSha256);
  let account, acceptance, result, failure;
  try {
    // Ordinary advance performs the real viewing scan and durable wallet update.
    // Its opener currently ignores an optional signal: never race it away from
    // cleanup. Cancellation during opening is checked after the handle returns.
    account = await openRailgunAccountWallet({ ...owners, archive, mode: 'advance' });
    current();
    const owned = readRailgunAccountOwnedNotes(account, owners);
    const originals = owned.read.received.filter((note) => note.id === originalNoteId);
    assert.equal(originals.length, 1);
    assert.equal(originals[0].hash, capsule.noteHash);
    assert.equal(originals[0].amount, inputAmount);
    assert.equal(originals[0].spentTxid, firstTxid);
    const originalRecords = owned.ownedPoi.filter((note) => note.id === originalNoteId);
    assert.equal(originalRecords.length, 1);
    assert.equal(originalRecords[0].nullifier, capsule.preparation.expected.nullifier);
    const changes = owned.read.received.filter((note) => note.txid === firstTxid);
    const records = owned.ownedPoi.filter((note) => note.txid === firstTxid);
    assert.equal(changes.length, 1);
    assert.equal(records.length, 1);
    const change = changes[0],
      record = records[0];
    assert.equal(change.id, changeId);
    assert.equal(record.id, changeId);
    assert.equal(change.tree, matched.output.change.tree);
    assert.equal(change.position, matched.output.change.position);
    assert.equal(change.hash, capsule.preparation.expected.changeCommitment);
    assert.equal(record.hash, change.hash);
    assert.equal(record.type, 'Transact');
    assert.equal(record.blockNumber, matched.row.blockNumber);
    assert.equal(change.amount, changeAmount);
    assert.equal(change.spentTxid, false);
    assert.deepEqual(change.asset, {
      __type: 'erc20',
      contract: require(wallet + 'railgun-shield-pins.json').wrappedNative,
    });
    assert.deepEqual(history.payload.blindedCommitmentsOut, [record.blindedCommitment]);
    assert.deepEqual(await store.get(history.capture.capsuleDigest), entry);
    current();
    acceptance = require('./railgun-combined-poi-list-acceptance').createCombinedPoiListAcceptance({
      account,
      owners,
      changeId,
      proof,
      archive,
      proverArchive,
      artifactDirectory,
      signature,
      signal,
    });
    assert.equal(acceptance.report().accepted, false);
    assert.equal(acceptance.report().postCalls, 0);
    result = Object.freeze({
      acceptance,
      diagnostics: Object.freeze({
        ordinaryWalletAdvance: true,
        originalInputSpentByFirstTransaction: true,
        uniqueOwnedChangeMatchesFirstProof: true,
        changeConservationVerified: true,
        preparedEntryUnchanged: true,
        scannedChangeSnapshotSha256: sha({
          checkpointHash: owned.checkpointHash,
          id: changeId,
          hash: record.hash,
          txid: record.txid,
          amount: changeAmount.toString(),
          blindedCommitment: record.blindedCommitment,
        }),
        walletClosedBeforeReturn: true,
        listAccepted: false,
        secondSpendQualified: false,
      }),
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (account) await account.close();
    } catch (error) {
      failure ??= error;
    }
    // A failed wallet drain must never return a usable acceptance helper.
    if (failure && acceptance) {
      try {
        acceptance.close();
      } finally {
        await acceptance.closed;
      }
    }
  }
  if (failure) throw failure;
  try {
    current();
    assert.deepEqual(await store.get(history.capture.capsuleDigest), entry);
    current();
    return result;
  } catch (error) {
    try {
      acceptance.close();
    } finally {
      await acceptance.closed;
    }
    throw error;
  }
}
module.exports = { scanCombinedPoiChange };
