/** Main-owned wallet -> existing TXID checkpoint -> wallet handoff.
 * Carries immutable public witness data, never the closed TXID runner's grant.
 * This receipt remains non-admitting until operation-window provenance composes.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { assertRailgunIdentity } = require('./railgun-identity');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { getRailgunTxidPolicy } = require('./railgun-txid-policy');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const {
  openRailgunAccountWallet,
  getRailgunAccountWalletPolicy,
  readRailgunAccountOwnedNotes,
  reserveRailgunAccountWalletHandoff,
  assertRailgunAccountPrivateWindow,
} = require('./railgun-account-wallet');
const { openRailgunAccountTxid } = require('./railgun-account-txid');
const { selectRailgunPrivatePreparation } = require('./railgun-private-preparation');
const { normalizeRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const receipts = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun Transact staging unavailable'), {
    code: 'RAILGUN_TRANSACT_STAGING_REFUSED',
  });
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function selectionSnapshot(owned, request) {
  const selection = selectRailgunPrivatePreparation(owned, request);
  const received = owned.read.received.filter((v) => v.id === request.noteId);
  const records = owned.ownedPoi.filter((v) => v.id === request.noteId);
  assert.equal(received.length, 1);
  assert.equal(records.length, 1);
  const record = records[0],
    note = received[0];
  assert.equal(record.type, 'Transact');
  assert.equal(record.hash, note.hash);
  assert.equal(record.txid, note.txid);
  assert.equal(note.id, `${selection.tree}:${selection.position}`);
  assert.equal(note.spentTxid, false);
  return freeze(
    structuredClone({
      selection,
      received: note,
      owned: record,
      checkpointHash: owned.checkpointHash,
    })
  );
}
async function stage(
  {
    account,
    owners: suppliedOwners,
    request: suppliedRequest,
    archive,
    signal,
    timeoutMs = 240000,
  },
  outcome
) {
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 240000);
  const owners = Object.freeze({
    identity: suppliedOwners.identity,
    enrollment: suppliedOwners.enrollment,
    coordinator: suppliedOwners.coordinator,
  });
  const request = Object.freeze({ ...suppliedRequest });
  const { identity, enrollment, coordinator } = owners;
  const baseline = selectionSnapshot(readRailgunAccountOwnedNotes(account, owners), request);
  archive = verifyRailgunEngineRuntime(archive);
  const parent = enrollment.getContext('engine');
  assertRailgunIdentity(identity, parent);
  const publicPolicy = getRailgunPublicPolicy(archive),
    txidPolicy = getRailgunTxidPolicy(archive);
  const walletPolicy = getRailgunAccountWalletPolicy({ archive, enrollment, coordinator });
  const publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy);
  const generationId = account.generationId;
  assert.equal(enrollment.catalog.activeFor(walletPolicy)?.id, generationId);
  const bindings = freeze(
    structuredClone({
      archive,
      publicPolicy,
      txidPolicy,
      walletPolicy,
      publicIdentity,
      generationId,
    })
  );
  const note = Object.freeze({
    type: 'Transact',
    txid: baseline.owned.txid,
    hash: baseline.owned.hash,
    tree: baseline.selection.tree,
    position: baseline.selection.position,
    blockNumber: baseline.owned.blockNumber,
  });
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parent).profileId,
    signal: AbortSignal.any([signal, identity.signal, enrollment.signal, coordinator.signal]),
    isCurrent: () => {
      assertRailgunIdentity(identity, parent);
      return true;
    },
  });
  let handoff,
    txid,
    reopened,
    succeeded = false;
  const started = performance.now(),
    deadline = started + timeoutMs;
  const active = () => {
    assert.ok(
      !scope.signal.aborted && performance.now() >= started && performance.now() < deadline
    );
    assertRailgunIdentity(identity, parent);
    assert.deepEqual(
      getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
      publicIdentity
    );
    assert.equal(enrollment.catalog.activeFor(walletPolicy)?.id, generationId);
    handoff?.assertCurrent();
  };
  const timer = setTimeout(() => scope.close(), timeoutMs);
  timer.unref?.();
  try {
    active();
    // Reserve synchronously before the first await. Intentional closure of the
    // old account must not abort the staging-wide lifetime.
    handoff = reserveRailgunAccountWalletHandoff(account, owners);
    outcome.stage = 'closing-wallet';
    outcome.originalAccountReusable = false;
    await account.close();
    active();
    outcome.stage = 'txid';
    // Retain a late-returned handle before checking cancellation. Never race
    // opening away from cleanup or release exclusion before its workers drain.
    txid = await openRailgunAccountTxid({
      enrollment,
      coordinator,
      archive,
      create: false,
      checkpointOnly: true,
      handoff: handoff.token,
    });
    active();
    assert.equal(txid.policy, txidPolicy);
    assert.deepEqual(txid.publicIdentity, publicIdentity);
    const before = await txid.inspect();
    active();
    assert.ok(before.checkpoint && !before.pending);
    const state = freeze(structuredClone(before.checkpoint.state));
    const found = await txid.witnessNote(note);
    active();
    const noteWitness = normalizeRailgunNoteTxidWitness(found.noteWitness, state, note);
    const after = await txid.inspect();
    active();
    assert.equal(after.pending, null);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    await txid.close();
    txid = undefined;
    active();
    assert.equal(getRailgunPublicPolicy(archive), publicPolicy);
    assert.equal(getRailgunTxidPolicy(archive), txidPolicy);
    assert.equal(getRailgunAccountWalletPolicy({ archive, enrollment, coordinator }), walletPolicy);
    outcome.stage = 'reopening-wallet';
    reopened = await openRailgunAccountWallet({
      ...owners,
      archive,
      policy: walletPolicy,
      mode: 'active',
      handoff: handoff.token,
    });
    active();
    assert.equal(reopened.generationId, generationId);
    assert.deepEqual(
      selectionSnapshot(readRailgunAccountOwnedNotes(reopened, owners), request),
      baseline
    );
    assert.ok(!reopened.signal.aborted);
    const close = () => scope.close();
    reopened.signal.addEventListener('abort', close, { once: true });
    scope.signal.addEventListener(
      'abort',
      () => reopened.signal.removeEventListener('abort', close),
      { once: true }
    );
    const evidence = freeze({
      bindings,
      request,
      baseline,
      state,
      noteWitness,
      spendingEnabled: false,
    });
    const receipt = Object.freeze({});
    const current = (window) => {
      assert.ok(!scope.signal.aborted && !reopened.signal.aborted);
      assertRailgunIdentity(identity, parent);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
        publicIdentity
      );
      assert.equal(enrollment.catalog.activeFor(walletPolicy)?.id, generationId);
      let owned;
      if (window === undefined) owned = readRailgunAccountOwnedNotes(reopened, owners);
      else {
        const operation = assertRailgunAccountPrivateWindow(window, reopened, owners);
        assert.deepEqual(operation.selection, baseline.selection);
        assert.equal(operation.checkpointHash, baseline.checkpointHash);
        owned = operation.owned;
      }
      assert.deepEqual(selectionSnapshot(owned, request), baseline);
      return evidence;
    };
    current();
    receipts.set(receipt, { account: reopened, owners, request, current, signal: scope.signal });
    succeeded = true;
    return Object.freeze({
      status: 'staged',
      account: reopened,
      receipt,
      close,
      signal: scope.signal,
      observation: Object.freeze({
        phaseHandoffComplete: true,
        witnessReverifiedInOperation: false,
        creatorSourceVerifiedInOperation: false,
        rootAcceptedInOperation: false,
        spendingEnabled: false,
      }),
    });
  } finally {
    clearTimeout(timer);
    if (!succeeded) {
      scope.close();
      const closing = [];
      if (!outcome.originalAccountReusable)
        closing.push(Promise.resolve().then(() => account.close()));
      if (txid) closing.push(Promise.resolve().then(() => txid.close()));
      if (reopened) closing.push(Promise.resolve().then(() => reopened.close()));
      const closed = await Promise.allSettled(closing);
      // A failed drain cannot silently unlock this directory. A normal refusal
      // closes all temporary handles; cleanup integrity failure stays excluded.
      assert.ok(closed.every((v) => v.status === 'fulfilled'));
    }
    handoff?.release();
  }
}
exports.stageRailgunTransactInput = async (options) => {
  const outcome = { stage: 'local', originalAccountReusable: true };
  try {
    return await stage(options, outcome);
  } catch {
    return Object.freeze({ status: 'refused', ...outcome });
  }
};
exports.assertRailgunTransactStaging = (receipt, account, owners, request, window) => {
  try {
    const entry = receipts.get(receipt);
    assert.ok(entry && entry.account === account);
    for (const key of ['identity', 'enrollment', 'coordinator'])
      assert.equal(entry.owners[key], owners[key]);
    assert.deepEqual(entry.request, request);
    return entry.current(window);
  } catch {
    throw fail();
  }
};
// Pre-acquisition check only: callers still have to claim inside the genuine A
// window. Expose the authentic lifetime so cancellation can stop earlier gates.
exports.assertRailgunTransactStagingAvailable = (receipt, account, owners, request) => {
  try {
    const evidence = exports.assertRailgunTransactStaging(receipt, account, owners, request);
    const entry = receipts.get(receipt);
    assert.ok(!entry.claimed);
    return Object.freeze({ evidence, signal: entry.signal });
  } catch {
    throw fail();
  }
};
// Consumption precedes all asynchronous provenance work. A failed or cancelled
// attempt cannot move the same staging evidence to another operation window.
exports.claimRailgunTransactStaging = (receipt, account, owners, request, window) => {
  try {
    const evidence = exports.assertRailgunTransactStaging(
      receipt,
      account,
      owners,
      request,
      window
    );
    assert.ok(window);
    const entry = receipts.get(receipt);
    assert.ok(!entry.claimed);
    const windowData = assertRailgunAccountPrivateWindow(window, account, entry.owners);
    entry.claimed = true;
    const assertCurrent = (minimumRemainingMs = 0) => {
      assert.equal(
        assertRailgunAccountPrivateWindow(window, account, entry.owners, minimumRemainingMs),
        windowData
      );
      assert.equal(entry.current(window), evidence);
      return evidence;
    };
    return Object.freeze({
      assertCurrent,
      signal: AbortSignal.any([entry.signal, windowData.signal]),
    });
  } catch {
    throw fail();
  }
};
