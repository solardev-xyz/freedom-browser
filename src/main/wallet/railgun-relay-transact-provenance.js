/** Fixed relay-window join of pre-staged creator/TXID evidence and a separately
 * approved fresh selected-root disclosure. No POI membership or signing grant.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { claimRailgunRelayTransactStaging } = require('./railgun-relay-transact-staging');
const { assertRailgunAccountRelayWindow } = require('./railgun-account-wallet');
const { createRailgunTxidRootSource } = require('./railgun-txid-root');
const { shape } = require('./railgun-relay-quote-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const operations = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun relay Transact provenance unavailable'), {
    code: 'RAILGUN_RELAY_TRANSACT_PROVENANCE_REFUSED',
  });
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function open({
  stagingReceipt,
  account,
  owners: inputOwners,
  request,
  window,
  signal,
  timeoutMs = 150000,
}) {
  assertRailgunRelaySignal(signal);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 150000);
  const owners = Object.freeze({
    identity: inputOwners.identity,
    enrollment: inputOwners.enrollment,
    coordinator: inputOwners.coordinator,
  });
  const claim = claimRailgunRelayTransactStaging(stagingReceipt, account, owners, request, window);
  const staged = claim.assertCurrent();
  const data = assertRailgunAccountRelayWindow(window, account, owners);
  assert.equal(data.draftDigest, claim.draftDigest);
  assert.equal(data.summaryDigest, claim.summaryDigest);
  const parent = owners.enrollment.getContext('engine');
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parent).profileId,
    signal: AbortSignal.any([
      signal,
      claim.signal,
      account.signal,
      getPrivacyContext(parent).signal,
    ]),
    isCurrent: () => {
      try {
        active();
        return true;
      } catch {
        return false;
      }
    },
  });
  const started = performance.now(),
    deadline = Math.min(started + timeoutMs, data.deadline);
  let monotonic = started,
    roots,
    rootWork,
    rootDeadline,
    closeWork,
    operation,
    closed = false,
    attempted = false,
    cleanupFailed = false;
  const receipts = new WeakMap();
  const active = (margin = 0) => {
    assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < 60000);
    const now = performance.now();
    assert.ok(
      !closed &&
        !scope.signal.aborted &&
        now >= monotonic &&
        now + margin < Math.min(deadline, rootDeadline ?? deadline)
    );
    monotonic = now;
    assert.equal(claim.assertCurrent(margin), staged);
    assert.equal(assertRailgunAccountRelayWindow(window, account, owners, margin), data);
  };
  const revoke = () => {
    if (closed) return;
    closed = true;
    for (const close of [() => scope.close(), () => roots?.close()]) {
      try {
        close();
      } catch {
        cleanupFailed = true;
      }
    }
  };
  const timer = setTimeout(revoke, Math.max(1, Math.floor(deadline - performance.now())));
  timer.unref?.();
  const close = () => {
    revoke();
    clearTimeout(timer);
    if (!closeWork) {
      closeWork = (async () => {
        if (rootWork) await Promise.allSettled([rootWork]);
        assert.ok(!cleanupFailed, fail());
      })();
      closeWork.catch(() => {});
    }
    return closeWork;
  };
  scope.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      revoke();
    },
    { once: true }
  );
  const point = Object.freeze({ index: staged.state.count - 1, root: staged.state.root });
  const binding = Object.freeze({
    stagingReceipt,
    draftDigest: data.draftDigest,
    summaryDigest: data.summaryDigest,
    checkpointHash: data.checkpointHash,
    creatorEvidenceSha256: digest(staged.creator),
    witnessInputSha256: staged.verified.inputSha256,
    point,
  });
  const observation = Object.freeze({
    draftDigest: data.draftDigest,
    summaryDigest: data.summaryDigest,
    checkpointHash: data.checkpointHash,
    creatorEvidenceSha256: binding.creatorEvidenceSha256,
    witnessInputSha256: binding.witnessInputSha256,
    stagedCheckpointSha256: digest(staged.state),
    creatorBlockHash: staged.creator.creator.blockHash,
    creatorTransactionIndex: staged.creator.creator.transactionIndex,
    pathVerified: true,
    ...(staged.noteWitness.witness.row.unshield ? { unshieldCommitmentVerified: true } : {}),
    creatorSourceAuthenticated: true,
    boundParamsChecked: false,
    globalTxidCompleteness: false,
    spendingEnabled: false,
  });
  function acquireRoot(options) {
    try {
      shape(options, ['permit', ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : [])]);
      const limit = options.timeoutMs ?? 20000;
      active();
      assert.ok(!attempted);
      assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 20000);
      attempted = true;
      // Different one-use domain from membership disclosure. The fixed
      // controller dependency is deliberately absent/fail-closed until wired.
      assert.equal(
        require('./railgun-relay-operation').consumeRailgunRelayRootDisclosurePermit(
          options.permit,
          operation,
          account,
          owners,
          window
        ),
        undefined
      );
      active();
      rootDeadline = Math.min(deadline, performance.now() + limit);
      const rootTimer = setTimeout(
        revoke,
        Math.max(1, Math.floor(rootDeadline - performance.now()))
      );
      rootTimer.unref?.();
      rootWork = Promise.resolve().then(async () => {
        try {
          active();
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
          const receipt = Object.freeze({}),
            value = Object.freeze({ ...observation, root });
          receipts.set(receipt, { rootReceipt, value });
          return Object.freeze({ receipt, observation: value });
        } catch {
          revoke();
          throw fail();
        } finally {
          clearTimeout(rootTimer);
          rootDeadline = undefined;
        }
      });
      rootWork.catch(() => {});
      return rootWork;
    } catch {
      revoke();
      throw fail();
    }
  }
  const assertResult = (receipt, margin = 0) => {
    active(margin);
    const entry = receipts.get(receipt);
    assert.ok(entry);
    assert.equal(roots.assertRoot(entry.rootReceipt, point, margin), entry.value.root);
    return entry.value;
  };
  operation = Object.freeze({ acquireRoot, close, signal: scope.signal });
  try {
    active();
    operations.set(operation, { account, owners, window, binding, active, assertResult });
    return operation;
  } catch {
    revoke();
    clearTimeout(timer);
    throw fail();
  }
}
exports.openRailgunRelayTransactProvenance = (options) => {
  try {
    return open(options);
  } catch {
    throw fail();
  }
};
// Controller-only pre-disclosure binding. This verifies a genuine live owner;
// it grants no query permission and cannot be supplied as the one-use permit.
exports.assertRailgunRelayTransactProvenanceOperation = (operation, account, owners, window) => {
  try {
    const entry = operations.get(operation);
    assert.ok(entry && entry.account === account && entry.window === window);
    for (const key of ['identity', 'enrollment', 'coordinator'])
      assert.equal(entry.owners[key], owners[key]);
    entry.active();
    return entry.binding;
  } catch {
    throw fail();
  }
};
exports.assertRailgunRelayTransactProvenance = (
  operation,
  receipt,
  account,
  owners,
  window,
  minimumRemainingMs = 0
) => {
  try {
    exports.assertRailgunRelayTransactProvenanceOperation(operation, account, owners, window);
    return operations.get(operation).assertResult(receipt, minimumRemainingMs);
  } catch {
    throw fail();
  }
};
