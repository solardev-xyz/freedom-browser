/** One-operation composition of staged TXID data, authenticated creator events
 * and fresh service-root acceptance. This grants no POI or signing authority.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { claimRailgunTransactStaging } = require('./railgun-transact-staging');
const {
  assertRailgunAccountPrivateWindow,
  readRailgunAccountPrivateCreator,
  assertRailgunAccountPrivateCreator,
} = require('./railgun-account-wallet');
const { verifyRailgunNoteProvenance } = require('./railgun-note-provenance');
const { createRailgunTxidRootSource } = require('./railgun-txid-root');
const operations = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun Transact provenance unavailable'), {
    code: 'RAILGUN_TRANSACT_PROVENANCE_REFUSED',
  });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function open({
  stagingReceipt,
  account,
  owners: inputOwners,
  request,
  window,
  signal,
  timeoutMs = 150000,
}) {
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 150000);
  const owners = Object.freeze({
    identity: inputOwners.identity,
    enrollment: inputOwners.enrollment,
    coordinator: inputOwners.coordinator,
  });
  const claim = claimRailgunTransactStaging(stagingReceipt, account, owners, request, window);
  const staged = claim.assertCurrent();
  const data = assertRailgunAccountPrivateWindow(window, account, owners);
  const parent = owners.enrollment.getContext('engine', 'note-provenance');
  const context = getPrivacyContext(parent);
  const started = performance.now(),
    deadline = Math.min(started + timeoutMs, data.deadline);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([signal, claim.signal, account.signal, context.signal]),
    isCurrent: () => {
      try {
        active();
        return true;
      } catch {
        return false;
      }
    },
  });
  let roots,
    creatorReceipt,
    creator,
    verified,
    rootWork,
    closed = false,
    attempted = false;
  const receipts = new WeakMap();
  const revoke = () => {
    closed = true;
    scope.close();
    roots?.close();
  };
  const active = (margin = 0) => {
    assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < 60000);
    const now = performance.now();
    assert.ok(!closed && !scope.signal.aborted && now >= started && now + margin < deadline);
    assert.equal(claim.assertCurrent(margin), staged);
    assert.equal(assertRailgunAccountPrivateWindow(window, account, owners, margin), data);
    if (creatorReceipt)
      assert.equal(
        assertRailgunAccountPrivateCreator(creatorReceipt, window, account, owners, margin),
        creator
      );
  };
  const timer = setTimeout(revoke, Math.max(1, Math.floor(deadline - performance.now())));
  timer.unref?.();
  scope.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      roots?.close();
    },
    { once: true }
  );
  const close = () => {
    revoke();
    return rootWork
      ? rootWork.then(
          () => undefined,
          () => undefined
        )
      : Promise.resolve();
  };
  try {
    active();
    const captured = await readRailgunAccountPrivateCreator(window, account, owners);
    active();
    creator = assertRailgunAccountPrivateCreator(captured.receipt, window, account, owners);
    creatorReceipt = captured.receipt;
    assert.equal(creator.eventSourceAuthenticated, true);
    assert.equal(creator.checkpointHash, staged.baseline.checkpointHash);
    const row = staged.noteWitness.witness.row;
    assert.match(row.graphID, /^0x[0-9a-f]{192}$/);
    const transactionIndex = BigInt('0x' + row.graphID.slice(66, 130));
    assert.ok(transactionIndex <= BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(Number(transactionIndex), creator.creator.transactionIndex);
    assert.equal(row.blockNumber, creator.creator.blockNumber);
    assert.equal('0x' + row.txid, creator.creator.transactionHash);
    assert.deepEqual(creator.note, {
      type: 'Transact',
      txid: staged.baseline.owned.txid,
      hash: staged.baseline.owned.hash,
      tree: staged.baseline.selection.tree,
      position: staged.baseline.selection.position,
      blockNumber: staged.baseline.owned.blockNumber,
    });
    assert.match(creator.transactionDigest, /^0x[0-9a-f]{64}$/);
    verified = await verifyRailgunNoteProvenance({
      handle: parent,
      archive: staged.bindings.archive,
      state: staged.state,
      note: creator.note,
      noteWitness: staged.noteWitness,
      events: creator.events,
      signal: scope.signal,
      timeoutMs: Math.min(30000, Math.floor(deadline - performance.now())),
    });
    active();
    assert.ok(
      verified.pathVerified && verified.suppliedCreatorEventsMatched && verified.utilityExitObserved
    );
    assert.equal(verified.coverage.boundParamsChecked, false);
    assert.equal(verified.coverage.globalTxidCompleteness, false);
    const point = Object.freeze({ index: staged.state.count - 1, root: staged.state.root });
    const observation = Object.freeze({
      transactionDigest: creator.transactionDigest,
      checkpointHash: creator.checkpointHash,
      creatorEvidenceSha256: digest(creator),
      witnessInputSha256: verified.inputSha256,
      stagedCheckpointSha256: digest(staged.state),
      creatorBlockHash: creator.creator.blockHash,
      creatorTransactionIndex: creator.creator.transactionIndex,
      pathVerified: true,
      creatorSourceAuthenticated: true,
      boundParamsChecked: false,
      globalTxidCompleteness: false,
      spendingEnabled: false,
    });
    function acquireRoot() {
      active();
      assert.ok(!attempted);
      attempted = true;
      rootWork = (async () => {
        try {
          roots = createRailgunTxidRootSource(
            scope.getContext({
              kind: 'service',
              principal: 'railgun-public-sync',
              protocol: 'railgun',
              deployment: 'sepolia',
              chainId: 11155111,
              role: 'public-services',
            })
          );
          const rootReceipt = await roots.acquire(point);
          active();
          const root = roots.assertRoot(rootReceipt, point);
          const receipt = Object.freeze({});
          const value = Object.freeze({ ...observation, root });
          receipts.set(receipt, { rootReceipt, value });
          return Object.freeze({ receipt, observation: value });
        } catch {
          revoke();
          throw fail();
        }
      })();
      // Return the observed promise itself, not an unobserved async wrapper.
      rootWork.catch(() => {});
      return rootWork;
    }
    function assertResult(receipt, margin = 0) {
      active(margin);
      const entry = receipts.get(receipt);
      assert.ok(entry);
      assert.equal(roots.assertRoot(entry.rootReceipt, point, margin), entry.value.root);
      return entry.value;
    }
    const operation = Object.freeze({ acquireRoot, close, signal: scope.signal });
    operations.set(operation, { account, owners, window, assertResult });
    return operation;
  } catch {
    await close();
    throw fail();
  }
}
exports.openRailgunTransactProvenance = open;
exports.assertRailgunTransactProvenance = (
  operation,
  receipt,
  account,
  owners,
  window,
  minimumRemainingMs = 0
) => {
  try {
    const entry = operations.get(operation);
    assert.ok(entry && entry.account === account && entry.window === window);
    for (const key of ['identity', 'enrollment', 'coordinator'])
      assert.equal(entry.owners[key], owners[key]);
    return entry.assertResult(receipt, minimumRemainingMs);
  } catch {
    throw fail();
  }
};
