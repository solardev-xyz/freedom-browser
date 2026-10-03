/** One enrolled wallet scan/restore window. Main composes the authenticated
 * generation store, coverage, journal and opaque engine receipt before exposing
 * Kohaku reads. The returned view stays valid only while all evidence is current.
 */
const accounts = new WeakMap();
const fs = require('fs'),
  path = require('path');
const { createHash } = require('crypto');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { openRailgunAccountStore } = require('./railgun-account-store');
const { createRailgunAccountRunner } = require('./railgun-wallet-runner');
const { createRailgunWalletCoverageStore } = require('./railgun-wallet-coverage-store');
const { createRailgunWalletJournal } = require('./railgun-wallet-journal');
const { getPrivacyStoragePath } = require('./privacy-storage');
const { createRailgunKohakuRead } = require('./railgun-kohaku-read');
const { assertRailgunScanCoordinator } = require('./railgun-scan-coordinator');
const { getRailgunWalletPolicy } = require('./railgun-wallet-policy');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { checkpointHash } = require('./railgun-wallet-coverage');
const fail = () =>
  Object.assign(new Error('Railgun wallet requires recovery'), {
    code: 'RAILGUN_ACCOUNT_WALLET_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
function exists(filename) {
  try {
    const stat = fs.lstatSync(filename);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function getRailgunAccountWalletPolicy({ archive, coordinator, enrollment }) {
  const identity = getRailgunAccountPublicIdentity(
    coordinator,
    enrollment,
    getRailgunPublicPolicy(archive)
  );
  return createHash('sha256')
    .update(
      JSON.stringify([
        'freedom:railgun:account-wallet-policy-v1',
        getRailgunWalletPolicy(archive),
        identity.generationId,
        identity.sourceId,
        identity.publicId,
      ])
    )
    .digest('hex');
}
async function openRailgunAccountWallet({
  identity,
  enrollment,
  archive,
  coordinator,
  policy: expectedPolicy,
  mode = 'active',
}) {
  check(isRailgunAccountEnrollment(enrollment));
  const policy = getRailgunAccountWalletPolicy({ archive, coordinator, enrollment });
  check(expectedPolicy === undefined || expectedPolicy === policy);
  check(['active', 'advance', 'new', 'pending'].includes(mode));
  const handle = enrollment.getContext('engine'),
    descriptor = assertRailgunIdentity(identity, handle),
    walletId = descriptor.walletId;
  check(walletId === enrollment.descriptor.walletId);
  assertRailgunScanCoordinator(coordinator, handle);
  const runner = createRailgunAccountRunner({ identity, archive, policy });
  const phase = claimRailgunAccountPhase(enrollment, 'wallet');
  let generation,
    candidate,
    walletSession,
    coverageStore,
    journal,
    scan,
    lifetime,
    onAbort,
    restoration,
    busy = false;
  const close = async () => {
    if (lifetime && onAbort) lifetime.removeEventListener('abort', onAbort);
    journal?.close();
    coverageStore?.close();
    walletSession?.close();
    // A revoked snapshot may return before the runner has observed utility
    // exit. Drain that runner too, not only the separate storage worker.
    if (scan) await scan.catch(() => {});
    if (restoration) await restoration.catch(() => {});
    if (walletSession) await walletSession.closed;
    phase.release();
  };
  try {
    if (mode === 'new') {
      const pending = (await enrollment.catalog.inspect()).pending;
      // This runtime cannot complete an obsolete-policy candidate. Preserve
      // its directory via catalog.begin, while allowing a reviewed rebuild.
      check(!pending || pending.policy !== policy);
      if ((await enrollment.catalog.inspectRetention()).listed === 8)
        await enrollment.catalog.retireInactive();
      candidate = generation = await enrollment.catalog.begin(policy);
    } else if (mode === 'pending') candidate = generation = await enrollment.catalog.resume();
    else generation = enrollment.catalog.activeFor(policy);
    check(generation && generation.policy === policy);
    const filename = path.join(generation.directory, 'wallet.sqlite');
    enrollment.profileGuard.assert(filename);
    const createStore = !!candidate && !exists(filename);
    const opened = await openRailgunAccountStore({
      enrollment,
      kind: 'wallet',
      generationId: generation.id,
      create: createStore,
      expectedStoreId: candidate ? undefined : generation.storeId,
    });
    walletSession = opened.session;
    coverageStore = createRailgunWalletCoverageStore({
      session: walletSession,
      walletId,
      policy,
      assertScan: runner.assertScan,
    });
    const journalHandle = enrollment.getContext('storage', 'railgun-wallet-v1:' + walletId),
      journalFile = getPrivacyStoragePath(journalHandle, generation.directory);
    enrollment.profileGuard.assert(journalFile);
    const createJournal = !!candidate && !exists(journalFile);
    journal = await enrollment.withGenerationKeys(generation.id, (keys) =>
      createRailgunWalletJournal({
        handle: journalHandle,
        directory: generation.directory,
        key: keys['wallet-journal'],
        binding: enrollment.binding,
        walletId,
        policy,
        storeSession: walletSession,
        coverageStore,
        coordinator,
        assertScan: runner.assertScan,
        create: createJournal,
        profileGuard: enrollment.profileGuard,
      })
    );
    const state = await journal.readState();
    if (mode === 'active') check(state.checkpoint && !state.pending);
    const restore =
      mode === 'active' || (mode === 'pending' && !!state.checkpoint && !state.pending);
    let pending;
    let checked = await coordinator.withPublicSnapshot((snapshot) => {
      scan = (async () => {
        if (!restore) pending = await journal.prepare(snapshot.checkpoint);
        return runner.run({ handle, snapshot, walletSession, coverageStore, walletId, restore });
      })();
      return scan;
    });
    const coverage = restore
      ? await coverageStore.read(checked.value.receipt)
      : await coverageStore.write(
          coordinator.assertSnapshot(checked.evidence),
          checked.value.coverage,
          checked.value.receipt
        );
    const evidence = {
      snapshot: checked.evidence,
      coverage,
      state: await walletSession.inspectWalletState(),
      receipt: checked.value.receipt,
    };
    if (restore) await journal.revalidate(evidence);
    else await journal.complete(pending, evidence);
    if (candidate) await enrollment.catalog.publish(candidate, journal);
    let view = createRailgunKohakuRead({ runner, journal, receipt: checked.value.receipt });
    lifetime = AbortSignal.any([
      walletSession.signal,
      coverageStore.signal,
      coordinator.signal,
      enrollment.signal,
      journal.signal,
    ]);
    onAbort = () => {
      close().catch(() => {});
    };
    lifetime.addEventListener('abort', onAbort, { once: true });
    if (lifetime.aborted) throw fail();
    const current = () => {
      phase.assertCurrent();
      check(!busy && !lifetime.aborted);
      assertRailgunIdentity(identity, handle);
      getRailgunAccountPublicIdentity(coordinator, enrollment);
      return runner.readOwned(checked.value.receipt, journal);
    };
    async function restoreCurrent() {
      current();
      const captured = checkpointHash(coordinator.assertSnapshot(checked.evidence));
      busy = true;
      let entered = false;
      // Keep the whole re-attestation promise separate from this method's
      // catch/close path, so external closure can drain it without self-waiting.
      restoration = (async () => {
        const renewed = await coordinator.withPublicSnapshot((snapshot) => {
          entered = true;
          phase.assertCurrent();
          check(!lifetime.aborted && checkpointHash(snapshot.checkpoint) === captured);
          assertRailgunIdentity(identity, handle);
          scan = runner.restoreReadOnly({
            handle,
            snapshot,
            walletSession,
            coverageStore,
            walletId,
          });
          return scan;
        });
        const freshCoverage = await coverageStore.read(renewed.value.receipt);
        const freshState = await walletSession.inspectWalletState();
        await journal.revalidate({
          snapshot: renewed.evidence,
          coverage: freshCoverage,
          state: freshState,
          receipt: renewed.value.receipt,
        });
        const nextView = createRailgunKohakuRead({
          runner,
          journal,
          receipt: renewed.value.receipt,
        });
        phase.assertCurrent();
        check(!lifetime.aborted);
        assertRailgunIdentity(identity, handle);
        // No await between the two assignments: account-owned reads and the
        // exported view switch together, only after successful revalidation.
        checked = renewed;
        view = nextView;
        return view;
      })();
      try {
        return await restoration;
      } catch {
        if (entered || lifetime.aborted) await close();
        throw fail();
      } finally {
        restoration = null;
        busy = false;
      }
    }
    const account = Object.freeze({
      get view() {
        return view;
      },
      close,
      signal: lifetime,
      generationId: generation.id,
    });
    accounts.set(account, {
      identity,
      enrollment,
      coordinator,
      current,
      restoreCurrent,
    });
    return account;
  } catch (error) {
    await close();
    throw error;
  }
}
function owned(account, { identity, enrollment, coordinator }) {
  const entry = accounts.get(account);
  check(
    entry &&
      entry.identity === identity &&
      entry.enrollment === enrollment &&
      entry.coordinator === coordinator
  );
  return entry;
}
function readRailgunAccountOwnedNotes(account, owners) {
  return owned(account, owners).current();
}
function restoreRailgunAccountWallet(account, owners) {
  return owned(account, owners).restoreCurrent();
}
module.exports = {
  openRailgunAccountWallet,
  getRailgunAccountWalletPolicy,
  readRailgunAccountOwnedNotes,
  restoreRailgunAccountWallet,
};
