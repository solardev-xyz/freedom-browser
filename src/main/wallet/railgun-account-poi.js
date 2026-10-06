/** Account-owned POI observations for explicitly selected recovered notes.
 * Receipts attest ownership at the captured public snapshot and list membership,
 * never TXID provenance, current chain consensus, reservations or spendability.
 */
const { createHash, randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  readRailgunAccountOwnedNotes,
  assertRailgunAccountPrivateWindow,
  assertRailgunAccountRelayWindow,
  retainRailgunRelayWindowPoi,
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
  windowKind = 'private',
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
  let handle,
    source,
    closed = false,
    busy = false,
    sourceDrained = false,
    resolveClosed,
    rejectClosed,
    sourceUnknown = false,
    sourceBarrierObserved = false,
    factoryInvoked = false,
    sequence = 0;
  const drained = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  drained.catch(() => {});
  const finish = () => {
    if (closed && !busy && sourceUnknown && windowKind === 'relay') rejectClosed(fail());
    if (closed && !busy && sourceDrained) resolveClosed();
  };
  const receipts = new WeakMap();
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      source?.close();
    } catch {
      // Only the source barrier can establish drainage.
    }
    try {
      scope.close();
    } catch {
      // Abort listeners and timer callbacks must not throw.
    }
    finish();
  };
  const active = (minimumRemainingMs = 0) => {
    check(!closed && !scope.signal.aborted);
    current(minimumRemainingMs);
    getPrivacyContext(handle);
  };
  const operation = Object.freeze({
    acquire,
    assertResult,
    close,
    closed: drained,
    signal: scope.signal,
  });
  operations.set(operation, {
    wallet,
    owners,
    window,
    windowKind: window ? windowKind : null,
    lifetime: Object.freeze({ closed: drained, close }),
  });
  try {
    if (windowKind === 'relay') retainRailgunRelayWindowPoi(window, wallet, owners, operation);
    handle = scope.getContext({
      ...parent.subject,
      role: 'poi',
      operation: 'poi:' + operationId,
    });
    factoryInvoked = true;
    source = createRailgunPoiSource({
      handle,
      notes: selected.map(({ record }) => ({
        blindedCommitment: record.blindedCommitment,
        type: record.type,
      })),
    });
    const sourceClosed = source.closed;
    check(sourceClosed && typeof sourceClosed.then === 'function');
    sourceClosed.then(
      () => {
        sourceDrained = true;
        finish();
      },
      () => {
        // A rejected barrier cannot stand in for physical closure.
        sourceUnknown = true;
        close();
        finish();
      }
    );
    sourceBarrierObserved = true;
    scope.signal.addEventListener('abort', close, { once: true });
    source.signal.addEventListener('abort', close, { once: true });
    if (scope.signal.aborted || source.signal.aborted) close();
    active();
  } catch (error) {
    if (!factoryInvoked) sourceDrained = true;
    else if (!sourceBarrierObserved) sourceUnknown = true;
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
    let timer, failure;
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
      failure = error;
      close();
    } finally {
      clearTimeout(timer);
      busy = false;
      finish();
    }
    // Success (including a refused diagnostic value) returns above. Failure
    // waits only after inner acquisition AND membership verification settled.
    await drained;
    throw failure;
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
// The connected controller must obtain explicit selected-input disclosure
// approval before invoking this source. A reviewed relay window alone does not
// authorize a query. Historical data returned below never extends freshness.
function openRailgunRelayWindowPoi({
  wallet,
  identity,
  enrollment,
  coordinator,
  archive,
  window,
  disclosure,
}) {
  const owners = { identity, enrollment, coordinator };
  require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
  const windowData = assertRailgunAccountRelayWindow(window, wallet, owners);
  const baseline = windowData.owned;
  const { tree, position } = windowData.selection;
  const notes = baseline.read.received.filter((v) => v.tree === tree && v.position === position);
  check(notes.length === 1);
  // The fixed controller alone can issue this one-use permission, after its
  // separately reviewed selected-input disclosure decision.
  check(
    require('./railgun-relay-operation').consumeRailgunRelayDisclosurePermit(
      disclosure,
      wallet,
      owners,
      window
    ) === undefined
  );
  const current = (margin = 0) => {
    require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
    check(assertRailgunAccountRelayWindow(window, wallet, owners, margin) === windowData);
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
    noteIds: [notes[0].id],
    windowKind: 'relay',
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
      entry.windowKind === 'private' &&
      entry.window === window &&
      window &&
      entry.wallet === wallet &&
      entry.owners.identity === owners.identity &&
      entry.owners.enrollment === owners.enrollment &&
      entry.owners.coordinator === owners.coordinator
  );
  return operation.assertResult(receipt, minimumRemainingMs);
}
function assertRailgunRelayWindowPoi(
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
      entry.windowKind === 'relay' &&
      entry.window === window &&
      window &&
      entry.wallet === wallet &&
      entry.owners.identity === owners.identity &&
      entry.owners.enrollment === owners.enrollment &&
      entry.owners.coordinator === owners.coordinator
  );
  return operation.assertResult(receipt, minimumRemainingMs);
}
function getRailgunRelayPoiLifetime(operation, wallet, owners, window) {
  const entry = operations.get(operation);
  check(
    entry &&
      entry.windowKind === 'relay' &&
      entry.window === window &&
      window &&
      entry.wallet === wallet &&
      entry.owners.identity === owners.identity &&
      entry.owners.enrollment === owners.enrollment &&
      entry.owners.coordinator === owners.coordinator
  );
  return entry.lifetime;
}
function readRailgunRelayWindowPoiHistory(operation, receipt, wallet, owners, window) {
  const value = assertRailgunRelayWindowPoi(operation, receipt, wallet, owners, window);
  const data = assertRailgunAccountRelayWindow(window, wallet, owners);
  check(value.proofs?.length === 1 && value.events?.length === 1);
  const history = require('./railgun-relay-poi-history').normalizeRailgunRelayPoiHistory({
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest: data.draftDigest,
    listKey: value.listKey,
    note: { blindedCommitment: value.input.blindedCommitment, type: value.input.type },
    proof: value.proofs[0],
    event: value.events[0],
  });
  check(assertRailgunRelayWindowPoi(operation, receipt, wallet, owners, window) === value);
  return history;
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
  openRailgunRelayWindowPoi,
  assertRailgunRelayWindowPoi,
  readRailgunRelayWindowPoiHistory,
  getRailgunRelayPoiLifetime,
};
