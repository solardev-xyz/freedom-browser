/** Opt-in fixed-companion native checks. All owners and selected records are
 * genuine; service answers remain the existing disposable public fixture. */
const { assert } = require('./railgun-native-assertions');
const counts = require('./railgun-combined-poi-second-cold-counts');
const signed = require('./railgun-combined-poi-second-recovery-data');
const wallet = '../../src/main/wallet/';
const ENV = 'FREEDOM_RAILGUN_RECOVERY_COMPANION';
function enabled(env, mode, creator) {
  if (!Object.hasOwn(env, ENV)) return false;
  assert.equal(env[ENV], '1');
  assert.equal(creator, 'Shield');
  assert.ok(
    [
      'restart-setup',
      'restart-sign-stop',
      'restart-recover-stop',
      'restart-recovered-submit',
    ].includes(mode)
  );
  return true;
}
async function bounded(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Recovery companion fixture deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function options(h, callbacks = {}) {
  const coordinator = h.publicAccount.coordinator;
  return {
    owners: { identity: h.identity, enrollment: h.enrollment, coordinator },
    destination: require(wallet + 'railgun-account-public').getRailgunAccountPublicDestination(
      coordinator,
      h.enrollment
    ),
    archive: h.archive,
    proverArchive: h.proverArchive,
    artifactDirectory: h.artifactDirectory,
    reviewDisclosures: () => assert.fail('Recovery-only disclosure'),
    reviewTransaction: () => assert.fail('Recovery-only transaction review'),
    gasLimit: 1500000n,
    maxGasFee: 2000000000000000n,
    signal: h.signal,
    ...callbacks,
  };
}
function create(h, callbacks) {
  return require(wallet + 'railgun-kohaku-recovery').createRailgunKohakuRecovery(
    options(h, callbacks)
  );
}
async function history(companion, pair, proved) {
  const page = await companion.history();
  assert.equal(page.totalSigning, 2);
  assert.equal(page.nextAfter, null);
  assert.deepEqual(
    page.records,
    [
      {
        holdId: pair.first.entry.id,
        kind: pair.first.entry.facts.kind,
        localState: 'proof-present',
      },
      {
        holdId: pair.second.entry.id,
        kind: pair.second.entry.facts.kind,
        localState: proved ? 'proof-present' : 'signed-unfinished',
      },
    ].sort((a, b) => (a.holdId < b.holdId ? -1 : 1))
  );
  return page.records.find((v) => v.holdId === pair.second.entry.id).holdId;
}
function unchangedFiles(before, after, writes) {
  const expected = JSON.parse(JSON.stringify(before));
  for (const file of new Set(writes.map((v) => v.file.replace(/^profile\//, '')))) {
    assert.ok(file.startsWith('wallet-railgun-accounts/'));
    const relative = file.slice('wallet-railgun-accounts/'.length);
    assert.ok(Object.hasOwn(expected.accounts, relative));
    assert.notEqual(after.accounts[relative], expected.accounts[relative]);
    expected.accounts[relative] = after.accounts[relative];
  }
  assert.deepEqual(after, expected);
}
function recoveryCounts(h, before, after) {
  const jobs = {
    'railgun-public-job.js': 2,
    'railgun-wallet-job.js': 1,
    'railgun-private-recover-job.js': 1,
    'railgun-private-verify-job.js': 1,
  };
  counts.jobs(
    before,
    after,
    jobs,
    { 'railgun-wallet-job.js': 1, 'railgun-private-recover-job.js': 1 },
    1
  );
  assert.deepEqual(counts.delta(after.audit.modes, before.audit.modes), {});
  const proxy = require(wallet + 'railgun-shield-pins.json').proxy;
  const headers = require('./railgun-combined-poi-restart-counts').expectedHeaders(
    h.wire.checkpoint,
    [...h.source.logs, ...h.wire.receipt.logs.filter((v) => v.address.toLowerCase() === proxy)]
  );
  const methods = {
    'private-account:protocol-rpc:eth_chainId': 1,
    'private-account:protocol-rpc:eth_getBlockByNumber': headers * 2,
    'private-account:protocol-rpc:eth_getLogs': 2,
  };
  assert.deepEqual(counts.delta(after.roleMethods, before.roleMethods), methods);
  for (const field of ['attempted', 'validated'])
    assert.deepEqual(counts.delta(after.chain[field], before.chain[field]), methods);
  assert.equal(before.services.transportCreates, 0);
  assert.deepEqual(after.services, { ...before.services, transportCreates: 1 });
  assert.deepEqual(after.eoa, before.eoa);
  return { jobs, methods, storageWorkers: 1 };
}
async function recover(h, runSuccess) {
  const observer = h.recoveryCompanion;
  const companions = [];
  let pending,
    released = false;
  try {
    h.phase('second-recovery-companion-history');
    const first = create(h);
    companions.push(first);
    const beforeHistory = h.activity();
    const selected = await history(first, h.pair, false);
    assert.deepEqual(h.activity(), beforeHistory);
    const heldStores = await h.enrollment.openPrivateRecoveryStores();
    const filesBefore = h.profileSnapshot();
    const before = h.activity();
    h.phase('second-recovery-companion-cancel');
    pending = first.resumeProof(selected);
    assert.equal(pending, observer.entry(0).promise);
    // This covers actual reconstruction/verification; the much shorter held
    // interval begins only after C's genuine exited result arrives.
    const firstSettlement = await bounded(
      Promise.race([observer.reached.then(() => 'held'), pending.then(() => 'settled')]),
      360000
    );
    assert.equal(firstSettlement, 'held', 'Original recovery settled before held C result');
    assert.equal(h.pendingChildren(), 0);
    assert.equal(h.unwipedLoans(), 0);
    let closed = false;
    first.closed.then(() => {
      closed = true;
    });
    first.close();
    const phaseEvidence = observer.pendingAtClose(
      first.signal,
      heldStores.reservations,
      heldStores.capsules
    );
    await Promise.resolve();
    assert.equal(closed, false);
    for (const invoke of [
      () => first.history(),
      () => first.resumeProof(selected),
      () => first.submitStored(selected),
    ])
      await assert.rejects(invoke(), { code: 'RAILGUN_KOHAKU_RECOVERY_REFUSED' });
    const other = create(h);
    companions.push(other);
    const beforeCompeting = h.activity();
    await assert.rejects(other.history(), { code: 'RAILGUN_PRIVATE_RECOVERY_HISTORY_REFUSED' });
    const competing = other.resumeProof(selected);
    assert.equal(competing, observer.entry(1).promise);
    assert.deepEqual(await competing, {
      status: 'refused',
      stage: 'admission',
      submissionEnabled: false,
    });
    assert.deepEqual(h.activity(), beforeCompeting);
    assert.equal(heldStores.reservations.signal.aborted, false);
    assert.equal(heldStores.capsules.signal.aborted, false);
    observer.pendingAtClose(first.signal, heldStores.reservations, heldStores.capsules);
    assert.equal(closed, false);
    other.close();
    await bounded(other.closed);
    observer.pendingAtClose(first.signal, heldStores.reservations, heldStores.capsules);
    observer.release();
    released = true;
    const cancelled = await bounded(pending);
    assert.equal(cancelled, observer.entry(0).value);
    assert.deepEqual(cancelled, {
      status: 'recovery-required',
      stage: 'verify',
      holdId: selected,
      submissionEnabled: false,
    });
    await bounded(first.closed);
    assert.equal(closed, true);
    assert.equal(heldStores.reservations.signal.aborted, true);
    assert.equal(heldStores.capsules.signal.aborted, true);
    const cancellationCounts = recoveryCounts(h, before, h.activity());
    assert.deepEqual(h.profileSnapshot(), filesBefore);
    assert.deepEqual(h.companionStorageReport(), []);
    for (const owner of [h.identity, h.enrollment, h.publicAccount.coordinator])
      assert.equal(owner.signal.aborted, false);
    h.phase('second-recovery-companion-reopen');
    const reopened = await h.enrollment.openPrivateRecoveryStores();
    assert.notEqual(reopened.reservations, heldStores.reservations);
    assert.notEqual(reopened.capsules, heldStores.capsules);
    h.adoptStores(reopened.reservations, reopened.capsules);
    const writes = h.companionStorageReport();
    assert.deepEqual(writes.map((v) => v.record).sort(), [
      'railgun-private-capsules-floor-v1',
      'railgun-private-capsules-v1',
      'railgun-private-reservations-floor-v1',
      'railgun-private-reservations-v1',
    ]);
    unchangedFiles(filesBefore, h.profileSnapshot(), writes);
    const records = await h.journal().list();
    const pair = await signed.readUnfinishedPair(h.enrollment, h.sealed.records);
    assert.deepEqual(pair, h.pair);
    assert.deepEqual(signed.signedHashes(pair.first, pair.second, records[0]), h.sealed.records);
    h.phase('second-recovery-companion-history');
    const fresh = create(h);
    companions.push(fresh);
    const beforeFresh = h.activity();
    assert.equal(await history(fresh, pair, false), selected);
    assert.deepEqual(h.activity(), beforeFresh);
    const resumeProof = (holdId) => {
      const index = observer.report().originalCalls;
      const result = fresh.resumeProof(holdId);
      assert.equal(result, observer.entry(index).promise);
      return result;
    };
    const result = await runSuccess({
      ...h,
      recoveryCompanion: undefined,
      resumeProof,
      recoveryTransportAlreadyOpen: true,
    });
    assert.equal(observer.entry(2).value.status, 'proof-stored');
    assert.equal(observer.entry(3).value.status, 'proof-present');
    fresh.close();
    await bounded(fresh.closed);
    assert.deepEqual(observer.report(), {
      heldResults: 1,
      originalCalls: 4,
      originalSettlements: 4,
    });
    return {
      ...result,
      report: {
        ...result.report,
        recoveryCompanion: {
          schema: 'railgun-recovery-companion-cancellation-v1',
          ...phaseEvidence,
          historyDiscoveredOriginalSelector: true,
          originalPromiseAndOutcomeIdentity: true,
          competingHistoryPhaseRefused: true,
          competingProofBusyRefused: true,
          refusedCompetitionPreservedHeldStores: true,
          closeWaitedForOriginalSettlement: true,
          cancellationPreservedOriginalSignatureAndEmptyProofSlot: true,
          borrowedOwnersReopenedAndReused: true,
          verifierExitedBeforeHold: true,
          liveChildCancellationQualified: false,
          genericHostQualified: false,
          cancellationCounts,
          reopenWrites: writes,
          observer: observer.report(),
        },
      },
    };
  } finally {
    if (!released) observer.release();
    for (const companion of companions) companion.close();
    try {
      if (pending) await bounded(pending);
    } finally {
      await bounded(Promise.all(companions.map((v) => v.closed)));
    }
  }
}
async function submission(h) {
  const companions = [],
    observed = [],
    checks = [];
  const discovery = create(h);
  try {
    const before = h.activity();
    const selected = await history(discovery, h.pair, true);
    assert.deepEqual(h.activity(), before);
    discovery.close();
    await bounded(discovery.closed);
    return {
      submit(input) {
        assert.equal(input.holdId, selected);
        assert.equal(input.identity, h.identity);
        assert.equal(input.enrollment, h.enrollment);
        assert.equal(input.coordinator, h.publicAccount.coordinator);
        assert.equal(input.signal, h.signal);
        assert.equal(input.gasLimit, 1500000n);
        assert.equal(input.maxGasFee, 2000000000000000n);
        const companion = create(h, {
          reviewDisclosures: input.reviewDisclosures,
          reviewTransaction: input.reviewTransaction,
        });
        companions.push(companion);
        const index = h.recoveryCompanion.report().originalCalls;
        const pending = companion.submitStored(selected);
        const original = h.recoveryCompanion.entry(index);
        assert.equal(pending, original.promise);
        const row = { original, settled: false };
        observed.push(row);
        const check = pending.then(
          (value) => {
            try {
              assert.equal(value, original.value);
              row.value = value;
              row.settled = true;
            } finally {
              companion.close();
            }
          },
          (error) => {
            try {
              assert.equal(error, original.error);
              row.error = error;
              row.settled = true;
            } finally {
              companion.close();
            }
          }
        );
        check.catch(() => {});
        checks.push(check);
        return pending;
      },
      report() {
        assert.equal(observed.length, 3);
        assert.ok(observed.every((v) => v.settled && !v.error));
        assert.ok(observed[0].value.hash);
        for (const item of observed.slice(1))
          assert.deepEqual(item.value, { status: 'recovery-required', stage: 'prior-attempt' });
        assert.deepEqual(h.recoveryCompanion.report(), {
          heldResults: 0,
          originalCalls: 3,
          originalSettlements: 3,
        });
        return {
          schema: 'railgun-recovery-companion-submit-v1',
          historyDiscoveredOriginalSelector: true,
          originalPromiseAndOutcomeIdentity: true,
          acknowledgedOriginalSubmission: true,
          explicitPriorAttemptRefusals: 2,
          genericHostQualified: false,
          observer: h.recoveryCompanion.report(),
        };
      },
      async close() {
        for (const companion of companions) companion.close();
        try {
          await bounded(Promise.all(checks));
        } finally {
          await bounded(Promise.all(companions.map((v) => v.closed)));
        }
      },
    };
  } finally {
    discovery.close();
    await bounded(discovery.closed);
  }
}
module.exports = {
  enabled,
  recover,
  submission,
  history,
  options,
  bounded,
  recoveryCounts,
  unchangedFiles,
};
