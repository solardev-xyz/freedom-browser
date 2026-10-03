/** Account-owned POI observations for explicitly selected recovered notes.
 * Receipts attest ownership at the captured public snapshot and list membership,
 * never TXID provenance, current chain consensus, reservations or spendability.
 */
const { createHash, randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  readRailgunAccountOwnedNotes,
  assertRailgunAccountPrivateWindow,
} = require('./railgun-account-wallet');
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
function createOwnedPoi({
  wallet,
  identity,
  enrollment,
  coordinator,
  archive,
  noteIds,
  baseline,
  current,
  window = null,
  windowData,
}) {
  check(Array.isArray(noteIds) && noteIds.length >= 1 && noteIds.length <= 3);
  check(
    noteIds.every((id) => typeof id === 'string' && /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(id))
  );
  check(new Set(noteIds).size === noteIds.length);
  const owners = { identity, enrollment, coordinator };
  const selected = noteIds.map((id) => {
    const record = baseline.ownedPoi.find((v) => v.id === id);
    const note = baseline.read.received.find((v) => v.id === id);
    check(record && note && note.spentTxid === false && note.amount > 0n);
    check(record.blockNumber >= POI_LAUNCH_BLOCK);
    return Object.freeze({ record, note });
  });
  current();
  const operationId = createHash('sha256')
    .update(
      JSON.stringify([
        window ? 'freedom:railgun:window-poi-v1:' + randomUUID() : 'freedom:railgun:account-poi-v1',
        enrollment.binding,
        baseline.checkpointHash,
        selected.map(({ record }) => record),
      ])
    )
    .digest('hex');
  const parent = getPrivacyContext(enrollment.getContext('engine'));
  const scope = createPrivacyScope({
    profileId: parent.profileId,
    signal: AbortSignal.any([
      wallet.signal,
      identity.signal,
      enrollment.signal,
      ...(window ? [windowData.signal] : []),
    ]),
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
  const active = (minimumRemainingMs = 0) => {
    check(!closed && !scope.signal.aborted);
    current(minimumRemainingMs);
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
  async function acquire({ timeoutMs = 45000 } = {}) {
    active();
    check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 45000);
    check(!busy);
    busy = true;
    const serial = ++sequence;
    const started = performance.now();
    const budget = window
      ? Math.min(timeoutMs, Math.floor(windowData.deadline - started))
      : timeoutMs;
    let timer;
    try {
      if (window) {
        check(budget > 0);
        timer = setTimeout(close, budget);
        timer.unref?.();
      }
      const remaining = () => {
        const now = performance.now();
        check(now >= started);
        const left = Math.floor(budget - (now - started));
        check(left > 0);
        return left;
      };
      const acquired = await source.acquire({ timeoutMs: budget });
      active();
      let membership = null;
      if (
        acquired.observation.rootsAccepted === true &&
        acquired.observation.statuses.every((v) => v.status === 'Valid')
      ) {
        membership = await verifyRailgunPoiMembership({
          handle,
          source,
          receipt: acquired.receipt,
          archive,
          ...(window ? { timeoutMs: remaining() } : {}),
        });
        active();
      }
      if (window) remaining();
      const observation = Object.freeze({
        ...(membership?.observation ?? acquired.observation),
        ownershipAtSnapshot: true,
        ...(window
          ? {
              input: Object.freeze({
                id: selected[0].record.id,
                tree: selected[0].note.tree,
                position: selected[0].note.position,
                noteHash: selected[0].record.hash,
                nullifier: selected[0].record.nullifier,
                blindedCommitment: selected[0].record.blindedCommitment,
                type: selected[0].record.type,
                checkpointHash: baseline.checkpointHash,
              }),
            }
          : {}),
        publicCheckpointHash: baseline.checkpointHash,
        publicThrough: Object.freeze({ ...baseline.read.readiness.to }),
        txidProvenanceVerified: false,
        reservationsChecked: false,
        spendingEnabled: false,
      });
      if (window && !membership) return Object.freeze({ status: 'refused', observation });
      const receipt = Object.freeze({});
      receipts.set(receipt, {
        serial,
        sourceReceipt: acquired.receipt,
        membershipReceipt: membership?.receipt,
        observation,
      });
      return Object.freeze({ ...(window ? { status: 'verified' } : {}), receipt, observation });
    } catch (error) {
      close();
      throw error;
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  }
  function assertResult(receipt, minimumRemainingMs = 0) {
    check(
      Number.isSafeInteger(minimumRemainingMs) &&
        minimumRemainingMs >= 0 &&
        minimumRemainingMs < 60000
    );
    active(minimumRemainingMs);
    const entry = receipts.get(receipt);
    check(entry && !busy && entry.serial === sequence);
    if (window)
      check(
        entry.membershipReceipt &&
          entry.observation.membershipVerified === true &&
          entry.observation.rootsAccepted === true &&
          entry.observation.statuses.every((v) => v.status === 'Valid')
      );
    source.assertResult(entry.sourceReceipt, minimumRemainingMs);
    if (entry.membershipReceipt)
      assertRailgunPoiMembership(entry.membershipReceipt, handle, minimumRemainingMs);
    return entry.observation;
  }
  const operation = Object.freeze({ acquire, assertResult, close, signal: scope.signal });
  operations.set(operation, { wallet, owners, window });
  return operation;
}
function openRailgunAccountPoi(args) {
  const { wallet, identity, enrollment, coordinator } = args;
  check(Array.isArray(args.noteIds));
  const noteIds = Object.freeze([...args.noteIds]);
  const owners = { identity, enrollment, coordinator };
  const baseline = readRailgunAccountOwnedNotes(wallet, owners);
  const current = () => {
    const value = readRailgunAccountOwnedNotes(wallet, owners);
    check(value.checkpointHash === baseline.checkpointHash);
    for (const id of noteIds) {
      const record = baseline.ownedPoi.find((v) => v.id === id);
      const note = baseline.read.received.find((v) => v.id === id);
      check(value.ownedPoi.includes(record) && value.read.received.includes(note));
      check(note.spentTxid === false && note.amount > 0n);
    }
  };
  return createOwnedPoi({
    ...args,
    noteIds,
    baseline,
    current,
    window: null,
    windowData: undefined,
  });
}
// Exactly one input, derived from the genuine live window; no caller-supplied
// note list, read snapshot or diagnostic POI receipt can enter this path.
function openRailgunPrivateWindowPoi({
  wallet,
  identity,
  enrollment,
  coordinator,
  archive,
  window,
}) {
  const owners = { identity, enrollment, coordinator };
  const windowData = assertRailgunAccountPrivateWindow(window, wallet, owners);
  const baseline = windowData.owned;
  const { tree, position } = windowData.selection;
  const note = baseline.read.received.find((v) => v.tree === tree && v.position === position);
  check(note);
  const current = (margin = 0) => {
    check(assertRailgunAccountPrivateWindow(window, wallet, owners, margin) === windowData);
    check(!windowData.signal.aborted);
  };
  return createOwnedPoi({
    wallet,
    identity,
    enrollment,
    coordinator,
    archive,
    window,
    windowData,
    baseline,
    current,
    noteIds: [note.id],
  });
}
function assertRailgunPrivateWindowPoi(
  operation,
  receipt,
  wallet,
  owners,
  window,
  minimumRemainingMs = 0
) {
  const entry = operations.get(operation);
  check(
    entry &&
      entry.window === window &&
      window &&
      entry.wallet === wallet &&
      entry.owners.identity === owners.identity &&
      entry.owners.enrollment === owners.enrollment &&
      entry.owners.coordinator === owners.coordinator
  );
  return operation.assertResult(receipt, minimumRemainingMs);
}
function assertRailgunAccountPoi(operation, receipt, wallet, owners) {
  const entry = operations.get(operation);
  check(
    entry &&
      entry.window === null &&
      entry.wallet === wallet &&
      entry.owners.identity === owners.identity &&
      entry.owners.enrollment === owners.enrollment &&
      entry.owners.coordinator === owners.coordinator
  );
  return operation.assertResult(receipt);
}
module.exports = {
  openRailgunAccountPoi,
  assertRailgunAccountPoi,
  openRailgunPrivateWindowPoi,
  assertRailgunPrivateWindowPoi,
};
