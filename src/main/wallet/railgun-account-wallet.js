/** One enrolled wallet scan/restore window. Main composes the authenticated
 * generation store, coverage, journal and opaque engine receipt before exposing
 * Kohaku reads. The returned view stays valid only while all evidence is current.
 */
const accounts = new WeakMap();
const privateWindows = new WeakMap();
const privateCreators = new WeakMap();
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
  handoff,
}) {
  check(isRailgunAccountEnrollment(enrollment));
  const policy = getRailgunAccountWalletPolicy({ archive, coordinator, enrollment });
  check(expectedPolicy === undefined || expectedPolicy === policy);
  check(['active', 'advance', 'new', 'pending'].includes(mode));
  check(handoff === undefined || mode === 'active');
  const handle = enrollment.getContext('engine'),
    descriptor = assertRailgunIdentity(identity, handle),
    walletId = descriptor.walletId;
  check(walletId === enrollment.descriptor.walletId);
  assertRailgunScanCoordinator(coordinator, handle);
  const runner = createRailgunAccountRunner({ identity, archive, policy });
  const phase = claimRailgunAccountPhase(enrollment, 'wallet', handoff);
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
    async function restoreCurrent(request, operation) {
      const before = current();
      const privateIntent =
        request === undefined
          ? undefined
          : require('./railgun-private-preparation').selectRailgunPrivatePreparation(
              before,
              request
            );
      const captured = checkpointHash(coordinator.assertSnapshot(checked.evidence));
      let privateWindow;
      const windowStarted = performance.now();
      let privateOperation;
      if (operation !== undefined) {
        check(privateIntent && operation && typeof operation.onIntent === 'function');
        require('assert/strict').deepEqual(Object.keys(operation).sort(), [
          'artifactDirectory',
          'onIntent',
          'proverArchive',
        ]);
        const onIntent = operation.onIntent;
        privateOperation = {
          proverArchive: operation.proverArchive,
          artifactDirectory: operation.artifactDirectory,
          async onIntent(offer, signal, capsule) {
            const { transactionDigest, ...raw } = offer;
            const normalized =
              require('./railgun-private-preparation').normalizeRailgunPrivatePreparation(raw, {
                selection: privateIntent,
                ...before,
              });
            check(normalized.transactionDigest === transactionDigest);
            const selected = before.ownedPoi.filter(
              (v) => v.id === `${privateIntent.tree}:${privateIntent.position}`
            );
            check(selected.length === 1);
            const normalizedCapsule =
              require('./railgun-private-capsule').normalizeRailgunNewCapsule(capsule, {
                walletId: enrollment.descriptor.walletId,
                selection: privateIntent,
                preparation: normalized,
                noteHash: selected[0].hash,
              });
            const owners = { identity, enrollment, coordinator };
            const entry = privateWindows.get(privateWindow);
            check(entry && entry.operationSignal === undefined);
            check(signal instanceof AbortSignal);
            entry.operationSignal = signal;
            entry.transactionDigest = transactionDigest;
            assertRailgunAccountPrivateWindow(privateWindow, account, owners);
            check(!signal.aborted);
            const response = await onIntent(normalized, signal, privateWindow, normalizedCapsule);
            assertRailgunAccountPrivateWindow(privateWindow, account, owners);
            check(!signal.aborted);
            return response;
          },
        };
      }
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
          let windowEntry;
          if (privateOperation) {
            privateWindow = Object.freeze({});
            const signal = AbortSignal.any([snapshot.signal, lifetime]);
            windowEntry = {
              account,
              identity,
              enrollment,
              coordinator,
              live: true,
              captureCreator() {
                const owners = { identity, enrollment, coordinator };
                const assertCurrent = () =>
                  assertRailgunAccountPrivateWindow(privateWindow, account, owners);
                assertCurrent();
                check(!windowEntry.creatorAttempted);
                windowEntry.creatorAttempted = true;
                const selected = before.ownedPoi.filter(
                  (v) => v.id === `${privateIntent.tree}:${privateIntent.position}`
                );
                check(selected.length === 1 && selected[0].type === 'Transact');
                const received = before.read.received.filter(
                  (v) => v.id === `${privateIntent.tree}:${privateIntent.position}`
                );
                check(
                  received.length === 1 &&
                    received[0].tree === privateIntent.tree &&
                    received[0].position === privateIntent.position &&
                    received[0].hash === selected[0].hash &&
                    received[0].txid === selected[0].txid &&
                    received[0].spentTxid === false
                );
                const note = {
                  type: 'Transact',
                  txid: selected[0].txid,
                  hash: selected[0].hash,
                  tree: privateIntent.tree,
                  position: privateIntent.position,
                  blockNumber: selected[0].blockNumber,
                };
                windowEntry.creatorWork = (async () => {
                  const observation =
                    await require('./railgun-private-creator').collectRailgunPrivateCreator({
                      note,
                      checkpoint: snapshot.checkpoint,
                      visit: snapshot.visitSource,
                      assertCurrent,
                    });
                  assertCurrent();
                  check(observation.checkpointHash === captured);
                  const receipt = Object.freeze({});
                  const evidence = Object.freeze({
                    ...observation,
                    transactionDigest: windowEntry.transactionDigest,
                    eventSourceAuthenticated: true,
                  });
                  privateCreators.set(receipt, { privateWindow, evidence });
                  return Object.freeze({ receipt, observation: evidence });
                })();
                windowEntry.creatorWork.catch(() => {});
                return windowEntry.creatorWork;
              },
              assertCurrent() {
                phase.assertCurrent();
                check(busy && !signal.aborted);
                check(windowEntry.operationSignal && !windowEntry.operationSignal.aborted);
                assertRailgunIdentity(identity, handle);
              },
              data: Object.freeze({
                owned: before,
                selection: privateIntent,
                checkpointHash: captured,
                get signal() {
                  return windowEntry.operationSignal;
                },
                started: windowStarted,
                deadline: windowStarted + 175000,
              }),
            };
            privateWindows.set(privateWindow, windowEntry);
          }
          scan = (
            privateOperation
              ? runner.operateReadOnly
              : privateIntent
                ? runner.prepareReadOnly
                : runner.restoreReadOnly
          )({
            handle,
            snapshot,
            walletSession,
            coverageStore,
            walletId,
            ...(privateIntent ? { privateIntent } : {}),
            ...(privateOperation ? { privateOperation } : {}),
          });
          return scan.finally(async () => {
            if (windowEntry) {
              windowEntry.live = false;
              if (windowEntry.creatorWork) await Promise.allSettled([windowEntry.creatorWork]);
            }
          });
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
        if (privateIntent) {
          const after = runner.readOwned(renewed.value.receipt, journal);
          check(after.checkpointHash === before.checkpointHash);
          require('assert/strict').deepEqual(after.ownedPoi, before.ownedPoi);
          require('assert/strict').deepEqual(after.trees, before.trees);
          require('assert/strict').deepEqual(after.read.received, before.read.received);
          check(renewed.value.preparation && renewed.value.preparation.spendingEnabled === false);
        }
        phase.assertCurrent();
        check(!lifetime.aborted);
        assertRailgunIdentity(identity, handle);
        // No await between the two assignments: account-owned reads and the
        // exported view switch together, only after successful revalidation.
        checked = renewed;
        view = nextView;
        return privateIntent
          ? Object.freeze({
              view,
              preparation: renewed.value.preparation,
              ...(privateOperation ? { operation: renewed.value.operation } : {}),
              readOnly: Object.freeze({ ...renewed.value.readOnly }),
            })
          : view;
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
      reserveHandoff() {
        current();
        return phase.reserveHandoff();
      },
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
function reserveRailgunAccountWalletHandoff(account, owners) {
  return owned(account, owners).reserveHandoff();
}
function prepareRailgunAccountPrivateIntent(account, owners, request) {
  check(request !== undefined);
  return owned(account, owners).restoreCurrent(request);
}
/** Main-only handler contract: onIntent receives owned-normalized data, A's
 * signal and an opaque window token. Retain neither beyond the callback. Every
 * await/child needs an abort-aware deadline inside the window; observe all child
 * exits before returning. Expected refusals return {status: 'refused'}; integrity
 * failures throw. A production signer must reassert window/preflight/POI margins,
 * receiver digest, held receipt and B's validated digest before markSigning, then
 * recheck A/B liveness before one key copy. This plumbing grants no key authority.
 */
function operateRailgunAccountPrivateIntent(account, owners, request, operation) {
  check(request !== undefined && operation !== undefined);
  return owned(account, owners).restoreCurrent(request, operation);
}
function assertRailgunAccountPrivateWindow(token, account, owners, minimumRemainingMs = 0) {
  const entry = privateWindows.get(token);
  check(
    entry &&
      entry.live &&
      entry.account === account &&
      entry.identity === owners.identity &&
      entry.enrollment === owners.enrollment &&
      entry.coordinator === owners.coordinator
  );
  check(
    Number.isSafeInteger(minimumRemainingMs) &&
      minimumRemainingMs >= 0 &&
      minimumRemainingMs < 175000
  );
  entry.assertCurrent();
  const now = performance.now();
  check(now >= entry.data.started && now + minimumRemainingMs < entry.data.deadline);
  return entry.data;
}
function readRailgunAccountPrivateCreator(window, account, owners) {
  assertRailgunAccountPrivateWindow(window, account, owners);
  return privateWindows.get(window).captureCreator();
}
function assertRailgunAccountPrivateCreator(
  receipt,
  window,
  account,
  owners,
  minimumRemainingMs = 0
) {
  assertRailgunAccountPrivateWindow(window, account, owners, minimumRemainingMs);
  const value = privateCreators.get(receipt);
  check(value && value.privateWindow === window);
  return value.evidence;
}
module.exports = {
  openRailgunAccountWallet,
  getRailgunAccountWalletPolicy,
  readRailgunAccountOwnedNotes,
  restoreRailgunAccountWallet,
  reserveRailgunAccountWalletHandoff,
  prepareRailgunAccountPrivateIntent,
  operateRailgunAccountPrivateIntent,
  assertRailgunAccountPrivateWindow,
  readRailgunAccountPrivateCreator,
  assertRailgunAccountPrivateCreator,
};
