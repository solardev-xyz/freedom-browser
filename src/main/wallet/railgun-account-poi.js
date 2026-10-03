/** Account-owned POI observations for explicitly selected recovered notes.
 * Receipts attest ownership at the captured public snapshot and list membership,
 * never TXID provenance, current chain consensus, reservations or spendability.
 */
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { readRailgunAccountOwnedNotes } = require('./railgun-account-wallet');
const { createRailgunPoiSource } = require('./railgun-poi-source');
const {
  verifyRailgunPoiMembership,
  assertRailgunPoiMembership,
} = require('./railgun-poi-membership');
const { POI_LAUNCH_BLOCK } = require('./railgun-owned-poi-records');
const operations = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun account POI unavailable'), {
    code: 'RAILGUN_ACCOUNT_POI_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
function openRailgunAccountPoi({ wallet, identity, enrollment, coordinator, archive, noteIds }) {
  check(Array.isArray(noteIds) && noteIds.length >= 1 && noteIds.length <= 3);
  check(
    noteIds.every((id) => typeof id === 'string' && /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(id))
  );
  check(new Set(noteIds).size === noteIds.length);
  const owners = { identity, enrollment, coordinator };
  const baseline = readRailgunAccountOwnedNotes(wallet, owners);
  const selected = noteIds.map((id) => {
    const record = baseline.ownedPoi.find((v) => v.id === id);
    const note = baseline.read.received.find((v) => v.id === id);
    check(record && note && note.spentTxid === false && note.amount > 0n);
    check(record.blockNumber >= POI_LAUNCH_BLOCK);
    return Object.freeze({ record, note });
  });
  const current = () => {
    const value = readRailgunAccountOwnedNotes(wallet, owners);
    check(value.checkpointHash === baseline.checkpointHash);
    for (const { record, note } of selected) {
      check(value.ownedPoi.includes(record) && value.read.received.includes(note));
      check(note.spentTxid === false && note.amount > 0n);
    }
  };
  current();
  const operationId = createHash('sha256')
    .update(
      JSON.stringify([
        'freedom:railgun:account-poi-v1',
        enrollment.binding,
        baseline.checkpointHash,
        selected.map(({ record }) => record),
      ])
    )
    .digest('hex');
  const parent = getPrivacyContext(enrollment.getContext('engine'));
  const scope = createPrivacyScope({
    profileId: parent.profileId,
    signal: AbortSignal.any([wallet.signal, identity.signal, enrollment.signal]),
    isCurrent: () => {
      try {
        current();
        return true;
      } catch {
        return false;
      }
    },
  });
  const handle = scope.getContext({
    ...parent.subject,
    role: 'poi',
    operation: 'poi:' + operationId,
  });
  let source,
    closed = false,
    busy = false,
    sequence = 0;
  const receipts = new WeakMap();
  const close = () => {
    if (closed) return;
    closed = true;
    source?.close();
    scope.close();
  };
  const active = () => {
    check(!closed && !scope.signal.aborted);
    current();
    getPrivacyContext(handle);
  };
  try {
    source = createRailgunPoiSource({
      handle,
      notes: selected.map(({ record }) => ({
        blindedCommitment: record.blindedCommitment,
        type: record.type,
      })),
    });
  } catch (error) {
    close();
    throw error;
  }
  async function acquire() {
    active();
    check(!busy);
    busy = true;
    const serial = ++sequence;
    try {
      const acquired = await source.acquire();
      active();
      let membership = null;
      if (acquired.observation.statuses.every((v) => v.status === 'Valid')) {
        membership = await verifyRailgunPoiMembership({
          handle,
          source,
          receipt: acquired.receipt,
          archive,
        });
        active();
      }
      const observation = Object.freeze({
        ...(membership?.observation ?? acquired.observation),
        ownershipAtSnapshot: true,
        publicCheckpointHash: baseline.checkpointHash,
        publicThrough: Object.freeze({ ...baseline.read.readiness.to }),
        txidProvenanceVerified: false,
        reservationsChecked: false,
        spendingEnabled: false,
      });
      const receipt = Object.freeze({});
      receipts.set(receipt, {
        serial,
        sourceReceipt: acquired.receipt,
        membershipReceipt: membership?.receipt,
        observation,
      });
      return Object.freeze({ receipt, observation });
    } catch (error) {
      close();
      throw error;
    } finally {
      busy = false;
    }
  }
  function assertResult(receipt) {
    active();
    const entry = receipts.get(receipt);
    check(entry && !busy && entry.serial === sequence);
    source.assertResult(entry.sourceReceipt);
    if (entry.membershipReceipt) assertRailgunPoiMembership(entry.membershipReceipt, handle);
    return entry.observation;
  }
  const operation = Object.freeze({ acquire, assertResult, close, signal: scope.signal });
  operations.set(operation, { wallet, owners });
  return operation;
}
function assertRailgunAccountPoi(operation, receipt, wallet, owners) {
  const entry = operations.get(operation);
  check(
    entry &&
      entry.wallet === wallet &&
      entry.owners.identity === owners.identity &&
      entry.owners.enrollment === owners.enrollment &&
      entry.owners.coordinator === owners.coordinator
  );
  return operation.assertResult(receipt);
}
module.exports = { openRailgunAccountPoi, assertRailgunAccountPoi };
