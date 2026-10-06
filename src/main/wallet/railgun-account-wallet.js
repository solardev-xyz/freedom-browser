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
const { types } = require('util');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const {
  assertRailgunIdentity,
  quarantineRailgunIdentityCredentials,
} = require('./railgun-identity');
const {
  openRailgunAccountStore,
  openRailgunCompletedAccountStore,
} = require('./railgun-account-store');
const { createRailgunAccountRunner } = require('./railgun-wallet-runner');
const {
  createRailgunWalletCoverageStore,
  createRailgunCompletedWalletCoverageStore,
} = require('./railgun-wallet-coverage-store');
const {
  createRailgunWalletJournal,
  openRailgunWalletJournalReadOnly,
} = require('./railgun-wallet-journal');
const { getPrivacyStoragePath } = require('./privacy-storage');
const { createRailgunKohakuRead } = require('./railgun-kohaku-read');
const {
  assertRailgunScanCoordinator,
  getRailgunCompletedSnapshotOutcome,
} = require('./railgun-scan-coordinator');
const { getRailgunWalletPolicy } = require('./railgun-wallet-policy');
const {
  getRailgunAccountPublicIdentity,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
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
// The fixed data accessor must not execute caller getters or toJSON hooks.
// Normalization below detaches the validated capsule synchronously.
function completedInputCapsule(input) {
  let nodes = 0,
    bytes = 0;
  const inspect = (value, depth = 0) => {
    check(++nodes <= 4096 && depth <= 16);
    if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
      if (typeof value === 'string') check((bytes += Buffer.byteLength(value)) <= 32768);
      return;
    }
    check(value && typeof value === 'object' && !types.isProxy(value));
    const array = Array.isArray(value);
    check(
      array
        ? Object.getPrototypeOf(value) === Array.prototype
        : [Object.prototype, null].includes(Object.getPrototypeOf(value))
    );
    const keys = Reflect.ownKeys(value);
    if (array) {
      check(value.length <= 1024);
      require('assert/strict').deepEqual(
        keys,
        [...Array(value.length).keys()].map(String).concat('length')
      );
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      check(typeof key === 'string');
      check((bytes += Buffer.byteLength(key)) <= 32768);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      check(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      inspect(descriptor.value, depth + 1);
    }
  };
  inspect(input);
  check(Buffer.byteLength(JSON.stringify(input)) <= 32768);
  return require('./railgun-private-capsule').normalizeRailgunPrivateCapsule(input);
}
function bindRecoveryInput(capsule, owned, descriptor) {
  check(
    capsule.walletId === descriptor.walletId && owned.read.instanceId === descriptor.instanceId
  );
  const { selection, preparation, noteHash } = capsule;
  const id = `${selection.tree}:${selection.position}`;
  const notes = owned.read.received.filter((note) => note.id === id);
  const records = owned.ownedPoi.filter((record) => record.id === id);
  const trees = owned.trees.filter((tree) => tree.tree === selection.tree);
  check(notes.length === 1 && records.length === 1 && trees.length === 1);
  const note = notes[0],
    record = records[0],
    tree = trees[0];
  const pins = require('./railgun-shield-pins.json');
  check(
    note.tree === selection.tree &&
      note.position === selection.position &&
      note.position < tree.length
  );
  check(note.hash === noteHash && record.hash === noteHash && note.txid === record.txid);
  check(['Shield', 'Transact'].includes(record.type));
  check(
    note.spentTxid === false &&
      typeof note.amount === 'bigint' &&
      note.amount > 0n &&
      note.amount <= BigInt(pins.maxQualificationAmount)
  );
  check(note.asset.__type === 'erc20' && note.asset.contract === pins.wrappedNative);
  check(record.nullifier === preparation.expected.nullifier);
  const amount =
    selection.kind === 'railgun-partial-unshield' ? preparation.inputAmount : preparation.amount;
  check(note.amount.toString() === amount);
  if (selection.kind === 'railgun-private-transfer')
    check(
      selection.recipient === descriptor.instanceId &&
        owned.read.instanceId === descriptor.instanceId
    );
  // Deliberately no equality against tree.root: the stored signature binds the
  // capsule's original root/path. Current restoration authenticates ownership,
  // not current spendability or creator/TXID/POI admission.
  return Object.freeze({
    checkpointHash: owned.checkpointHash,
    id,
    type: record.type,
    txid: note.txid,
    noteHash,
    nullifier: record.nullifier,
    amount,
  });
}
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
function openRailgunAccountWallet(options) {
  return openAccount(options, false);
}
/** Fixed existing-generation restore. Public completed reads may query the
 * retained source; this route never repairs, scans forward or creates stores. */
async function openRailgunCompletedAccountWallet(options) {
  check(options && typeof options === 'object' && !Array.isArray(options));
  check(
    Object.keys(options).every((key) =>
      [
        'identity',
        'enrollment',
        'archive',
        'coordinator',
        'destination',
        'signal',
        'timeoutMs',
        'policy',
      ].includes(key)
    )
  );
  check(
    options.destination && (options.signal === undefined || options.signal instanceof AbortSignal)
  );
  const timeoutMs = options.timeoutMs === undefined ? 180000 : options.timeoutMs;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000);
  const account = await openAccount({ ...options, timeoutMs }, true);
  try {
    readRailgunAccountOwnedNotes(account, options);
    return account;
  } catch {
    await account.close();
    throw fail();
  }
}
async function openAccount(
  {
    identity,
    enrollment,
    archive,
    coordinator,
    policy: expectedPolicy,
    mode = 'active',
    handoff,
    destination,
    signal,
    timeoutMs,
  },
  completedOnly
) {
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
  if (completedOnly) {
    check(!signal?.aborted && typeof enrollment.profileGuard.assertRegistered === 'function');
    assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
  }
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
  let sourceOutcome;
  const refused = () => Object.assign(fail(), sourceOutcome ? { sourceOutcome } : {});
  const controller = new AbortController();
  const parentSignal = AbortSignal.any([
    controller.signal,
    enrollment.signal,
    coordinator.signal,
    ...(identity.signal ? [identity.signal] : []),
    ...(completedOnly && signal ? [signal] : []),
  ]);
  const deadline = completedOnly ? performance.now() + timeoutMs : Infinity;
  let closing = false,
    closeWork,
    finishSetup,
    cleanupFailed = false;
  const setup = new Promise((resolve) => {
    finishSetup = resolve;
  });
  const stop = () => {
    for (const resource of [journal, coverageStore, walletSession]) {
      try {
        resource?.close();
      } catch {
        cleanupFailed = true;
      }
    }
  };
  const close = () => {
    if (closeWork) return closeWork;
    closing = true;
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onAbort);
    if (lifetime) lifetime.removeEventListener('abort', onAbort);
    // Install the promise before abort listeners can reenter close().
    let resolve, reject;
    closeWork = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    controller.abort();
    stop();
    (async () => {
      await setup;
      stop();
      const outcomes = await Promise.allSettled([scan, restoration].filter(Boolean));
      stop();
      const refuseUnobserved = () => {
        quarantineRailgunIdentityCredentials(identity);
        throw Object.assign(fail(), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
      };
      if (walletSession) {
        let closed;
        try {
          closed = await walletSession.closed;
        } catch {
          refuseUnobserved();
        }
        if (!Number.isInteger(closed?.exitCode) || closed.exitCode < 0) refuseUnobserved();
        if (closed.exitCode !== 0) cleanupFailed = true;
      }
      const unobserved = (error) => {
        const seen = new Set();
        while (error && typeof error === 'object' && !seen.has(error)) {
          seen.add(error);
          if (error.code === 'RAILGUN_WALLET_EXIT_UNOBSERVED') return true;
          error = error.cause;
        }
        return false;
      };
      if (outcomes.some((result) => result.status === 'rejected' && unobserved(result.reason))) {
        // Filename ownership outlives identities/enrollments. Unknown utility
        // exit keeps this account unavailable until the application restarts.
        refuseUnobserved();
      }
      phase.release();
      if (cleanupFailed) throw fail();
    })().then(resolve, reject);
    return closeWork;
  };
  onAbort = () => {
    void close().catch(() => {});
  };
  const timer = completedOnly ? setTimeout(onAbort, timeoutMs) : undefined;
  timer?.unref?.();
  parentSignal.addEventListener('abort', onAbort, { once: true });
  const openingCurrent = () => {
    check(!closing && !parentSignal.aborted && performance.now() < deadline);
    phase.assertCurrent();
    if (completedOnly) {
      assertRailgunIdentity(identity, handle);
      check(getRailgunAccountWalletPolicy({ archive, coordinator, enrollment }) === policy);
      assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
      if (generation)
        require('assert/strict').deepEqual(enrollment.catalog.activeFor(policy), generation);
    }
  };
  const completedRestore = async (state, privateRecovery) => {
    openingCurrent();
    check(state.checkpoint && !state.pending);
    // A cold restore has no in-process scan receipt. Authenticate the persisted
    // coverage and exact wallet state against the completed journal before
    // asking the public source or lending a viewing credential to the engine.
    const storedCoverage = await coverageStore.read();
    openingCurrent();
    check(storedCoverage);
    check(checkpointHash(storedCoverage.checkpoint) === state.checkpoint.target.hash);
    require('assert/strict').deepEqual(storedCoverage.checkpoint, state.checkpoint.target.plan);
    require('assert/strict').deepEqual(storedCoverage.summary, state.checkpoint.coverage);
    const storedWallet = await walletSession.inspectWalletState();
    check(walletSession.assertFresh(storedWallet) === undefined);
    openingCurrent();
    require('assert/strict').deepEqual(storedWallet, state.checkpoint.wallet);
    sourceOutcome = undefined;
    const checked = await coordinator
      .withCompletedPublicSnapshot(
        {
          destination,
          signal: parentSignal,
          timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        },
        (snapshot) => {
          // Expected local mismatch/cancellation is data: it must not poison the
          // caller-owned coordinator's authenticated completed source.
          try {
            openingCurrent();
          } catch {
            return null;
          }
          if (
            parentSignal.aborted ||
            closing ||
            performance.now() >= deadline ||
            checkpointHash(snapshot.checkpoint) !== state.checkpoint.target.hash
          )
            return null;
          scan = (privateRecovery ? runner.recoverReadOnly : runner.restoreReadOnly)({
            handle,
            snapshot,
            walletSession,
            coverageStore,
            walletId,
            ...(privateRecovery ? { privateRecovery } : {}),
          });
          // Wallet restoration failure is local to this owned wallet. Genuine
          // source/broker integrity remains latched by the coordinator itself.
          return scan.catch(() => null);
        }
      )
      .catch((error) => {
        // Only the exact coordinator rejection can supply provenance; never
        // infer benign/fatal status from an error code or concurrent abort.
        try {
          sourceOutcome = getRailgunCompletedSnapshotOutcome(coordinator, error);
        } catch {
          /* Unknown callback/owner errors carry no source claim. */
        }
        throw refused();
      });
    openingCurrent();
    check(checked.value);
    return checked;
  };
  try {
    openingCurrent();
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
    if (completedOnly) generation = Object.freeze({ ...generation });
    const filename = path.join(generation.directory, 'wallet.sqlite');
    (completedOnly
      ? enrollment.profileGuard.assertRegistered
      : enrollment.profileGuard.assert
    ).call(enrollment.profileGuard, filename);
    if (completedOnly) check(exists(filename));
    const journalHandle = enrollment.getContext('storage', 'railgun-wallet-v1:' + walletId),
      journalFile = getPrivacyStoragePath(journalHandle, generation.directory);
    (completedOnly
      ? enrollment.profileGuard.assertRegistered
      : enrollment.profileGuard.assert
    ).call(enrollment.profileGuard, journalFile);
    if (completedOnly) check(exists(journalFile));
    const createStore = !!candidate && !exists(filename);
    const opened = completedOnly
      ? await openRailgunCompletedAccountStore({
          enrollment,
          generationId: generation.id,
          expectedStoreId: generation.storeId,
          signal: parentSignal,
        })
      : await openRailgunAccountStore({
          enrollment,
          kind: 'wallet',
          generationId: generation.id,
          create: createStore,
          expectedStoreId: candidate ? undefined : generation.storeId,
        });
    walletSession = opened.session;
    openingCurrent();
    coverageStore = (
      completedOnly ? createRailgunCompletedWalletCoverageStore : createRailgunWalletCoverageStore
    )({
      session: walletSession,
      walletId,
      policy,
      assertScan: runner.assertScan,
    });
    const createJournal = !!candidate && !exists(journalFile);
    journal = await enrollment.withGenerationKeys(generation.id, (keys) =>
      (completedOnly ? openRailgunWalletJournalReadOnly : createRailgunWalletJournal)({
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
        ...(completedOnly ? {} : { create: createJournal }),
        profileGuard: enrollment.profileGuard,
      })
    );
    openingCurrent();
    const state = await journal.readState();
    openingCurrent();
    if (mode === 'active') check(state.checkpoint && !state.pending);
    const restore =
      mode === 'active' || (mode === 'pending' && !!state.checkpoint && !state.pending);
    let pending;
    let checked = completedOnly
      ? await completedRestore(state)
      : await coordinator.withPublicSnapshot((snapshot) => {
          scan = (async () => {
            if (!restore) pending = await journal.prepare(snapshot.checkpoint);
            return runner.run({
              handle,
              snapshot,
              walletSession,
              coverageStore,
              walletId,
              restore,
            });
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
    openingCurrent();
    let view = createRailgunKohakuRead({ runner, journal, receipt: checked.value.receipt });
    lifetime = AbortSignal.any([
      parentSignal,
      walletSession.signal,
      coverageStore.signal,
      coordinator.signal,
      enrollment.signal,
      journal.signal,
    ]);
    lifetime.addEventListener('abort', onAbort, { once: true });
    if (lifetime.aborted) throw fail();
    const current = () => {
      phase.assertCurrent();
      check(!busy && !lifetime.aborted);
      openingCurrent();
      assertRailgunIdentity(identity, handle);
      getRailgunAccountPublicIdentity(coordinator, enrollment);
      return runner.readOwned(checked.value.receipt, journal);
    };
    async function restoreCurrent(request, operation, recovery) {
      const before = current();
      if (completedOnly) {
        check(request === undefined && operation === undefined);
        const privateRecovery =
          recovery === undefined
            ? undefined
            : require('./railgun-private-recovery-data').normalizeRailgunPrivateRecoveryInput(
                recovery,
                { walletId }
              );
        const originalInput = privateRecovery
          ? bindRecoveryInput(privateRecovery.capsule, before, descriptor)
          : undefined;
        busy = true;
        restoration = (async () => {
          const state = await journal.readState();
          const renewed = await completedRestore(state, privateRecovery);
          const coverage = await coverageStore.read(renewed.value.receipt);
          const freshState = await walletSession.inspectWalletState();
          await journal.revalidate({
            snapshot: renewed.evidence,
            coverage,
            state: freshState,
            receipt: renewed.value.receipt,
          });
          const nextView = createRailgunKohakuRead({
            runner,
            journal,
            receipt: renewed.value.receipt,
          });
          let candidate;
          if (privateRecovery) {
            const fresh = runner.readOwned(renewed.value.receipt, journal);
            require('assert/strict').deepEqual(
              bindRecoveryInput(privateRecovery.capsule, fresh, descriptor),
              originalInput
            );
            check(renewed.value.recovery?.status === 'proved');
            candidate =
              require('./railgun-private-recovery-data').normalizeRailgunPrivateRecoveryResult(
                renewed.value.recovery,
                {
                  capsule: privateRecovery.capsule,
                  walletId,
                  read: fresh.read,
                  ownedPoi: fresh.ownedPoi,
                  trees: fresh.trees,
                }
              );
          }
          openingCurrent();
          checked = renewed;
          view = nextView;
          return privateRecovery ? candidate : view;
        })();
        try {
          const restored = await restoration;
          openingCurrent();
          return restored;
        } catch {
          await close();
          throw refused();
        } finally {
          restoration = null;
          busy = false;
        }
      }
      const privateIntent =
        request === undefined
          ? undefined
          : require('./railgun-private-preparation').selectRailgunPrivatePreparation(
              before,
              request
            );
      if (privateIntent)
        check(
          [
            'railgun-private-transfer',
            'railgun-token-unshield',
            'railgun-partial-unshield',
          ].includes(privateIntent.kind)
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
    async function prepareRelayIntent(request) {
      const assert = require('assert/strict');
      const {
        shape,
        freeze,
        decimal,
        normalizeRailgunRelayQuote,
        assertQuoteCurrent,
      } = require('./railgun-relay-quote-data');
      check(!completedOnly);
      shape(request, ['noteId', 'quote', 'gas', 'maxFee', 'signal']);
      const relayData = require('./railgun-relay-wallet-data');
      relayData.assertRailgunRelaySignal(request.signal);
      check(
        typeof request.noteId === 'string' &&
          request.noteId.length > 0 &&
          request.noteId.length <= 160
      );
      const noteId = request.noteId;
      const binding = normalizeRailgunRelayQuote(request.quote, request.gas);
      const cap = decimal(
        request.maxFee,
        BigInt(require('./railgun-shield-pins.json').maxQualificationAmount)
      );
      check(cap > 0n && BigInt(binding.feeAmount) <= cap);
      const before = current();
      const selected = require('./railgun-private-preparation').selectRailgunPrivatePreparation(
        before,
        {
          kind: 'railgun-private-transfer',
          noteId,
          recipient: descriptor.instanceId,
        }
      );
      const notes = before.read.received.filter((n) => n.id === noteId);
      const records = before.ownedPoi.filter((n) => n.id === noteId);
      check(notes.length === 1 && records.length === 1);
      check(['Shield', 'Transact'].includes(records[0].type));
      check(notes[0].hash === records[0].hash && notes[0].txid === records[0].txid);
      check(BigInt(binding.feeAmount) < notes[0].amount);
      const selection = Object.freeze({ tree: selected.tree, position: selected.position });
      const captured = freeze(
        structuredClone({
          read: { instanceId: before.read.instanceId, received: before.read.received },
          ownedPoi: before.ownedPoi,
          trees: before.trees,
          checkpointHash: before.checkpointHash,
        })
      );
      const publicIdentity = freeze(
        structuredClone(getRailgunAccountPublicIdentity(coordinator, enrollment))
      );
      const generationBefore = freeze(structuredClone(generation));
      const activeGeneration = freeze(structuredClone(enrollment.catalog.activeFor(policy)));
      check(
        activeGeneration.id === generation.id &&
          activeGeneration.policy === policy &&
          activeGeneration.directory === generation.directory
      );
      const identityBefore = freeze(structuredClone(descriptor));
      const initialView = view;
      const checkpoint = checkpointHash(coordinator.assertSnapshot(checked.evidence));
      check(checkpoint === captured.checkpointHash);
      const start = performance.now(),
        end = start + 90000;
      let wall = Date.now(),
        monotonic = start;
      assertQuoteCurrent(binding, wall, wall);
      check(
        binding.fields.feeExpiration - wall >= 90000 &&
          binding.fields.feeExpiration - wall <= 300000
      );
      const relayController = new AbortController();
      const relaySignal = AbortSignal.any([lifetime, request.signal, relayController.signal]);
      const handoff = phase.reserveHandoff();
      let entered = false,
        unknown = false,
        snapshotWindow = null,
        snapshotEvidence = checked.evidence;
      busy = true;
      const timer = setTimeout(() => {
        relayController.abort();
        if (entered) void close().catch(() => {});
      }, 90000);
      timer.unref?.();
      const attest = (remaining = 0) => {
        const now = performance.now(),
          date = Date.now();
        check(!relaySignal.aborted && now >= monotonic && now < end);
        assertQuoteCurrent(binding, date, wall);
        wall = date;
        check(binding.fields.feeExpiration - date >= remaining);
        phase.assertCurrent();
        handoff.assertCurrent();
        openingCurrent();
        assert.deepEqual(assertRailgunIdentity(identity, handle), identityBefore);
        assert.deepEqual(generation, generationBefore);
        assert.deepEqual(enrollment.catalog.activeFor(policy), activeGeneration);
        assert.deepEqual(getRailgunAccountPublicIdentity(coordinator, enrollment), publicIdentity);
        check(view === initialView);
        // Coordinator evidence is deliberately unusable while its snapshot is
        // busy. The callback owns the live window; afterward only its new token
        // is valid (the window signal has then been aborted by the coordinator).
        if (snapshotWindow) {
          check(!snapshotWindow.signal.aborted);
          check(checkpointHash(snapshotWindow.checkpoint) === checkpoint);
        } else check(checkpointHash(coordinator.assertSnapshot(snapshotEvidence)) === checkpoint);
        const after = performance.now(),
          afterWall = Date.now();
        check(!relaySignal.aborted && after >= now && after < end);
        assertQuoteCurrent(binding, afterWall, wall);
        wall = afterWall;
        monotonic = after;
        check(binding.fields.feeExpiration - wall >= remaining);
        sameOwned(before);
      };
      const sameOwned = (value) => {
        shape(value, ['read', 'ownedPoi', 'trees', 'checkpointHash']);
        assert.deepEqual(
          {
            read: { instanceId: value.read.instanceId, received: value.read.received },
            ownedPoi: value.ownedPoi,
            trees: value.trees,
            checkpointHash: value.checkpointHash,
          },
          captured
        );
      };
      const unobserved = (error) => {
        const seen = new Set();
        while (error && typeof error === 'object' && !seen.has(error)) {
          seen.add(error);
          if (
            ['RAILGUN_RELAY_QUOTE_DRAIN_FAILED', 'RAILGUN_WALLET_EXIT_UNOBSERVED'].includes(
              error.code
            )
          )
            return true;
          error = error.cause;
        }
        return false;
      };
      // close() drains this entire promise, including quote verification and both
      // original utility/storage barriers; its own catch/close lives outside it.
      restoration = (async () => {
        try {
          attest(75000);
          const quoteStarted = performance.now();
          const verified = await require('./railgun-relay-quote-verify').verifyRailgunRelayQuote({
            enrollment,
            archive,
            quote: binding.quote,
            gas: binding.gas,
            signal: relaySignal,
          });
          attest(60000);
          check(performance.now() >= quoteStarted && performance.now() - quoteStarted < 15000);
          check(
            verified.signatureVerified === true && verified.quoteSha256 === binding.quoteSha256
          );
          const capturedNote = captured.read.received.find((n) => n.id === noteId);
          const context = require('./railgun-relay-intent').normalizeRailgunRelayUnsignedContext({
            walletId,
            self: {
              address: descriptor.instanceId,
              masterPublicKey: BigInt('0x' + descriptor.masterPublicKey).toString(),
              viewingPublicKey: descriptor.viewingPublicKey,
            },
            peer: {
              address: binding.fields.railgunAddress,
              masterPublicKey: verified.masterPublicKey,
              viewingPublicKey: verified.viewingPublicKey,
            },
            quote: binding.quote,
            gas: binding.gas,
            inputAmount: capturedNote.amount.toString(),
            feeAmount: binding.feeAmount,
            selfAmount: (capturedNote.amount - BigInt(binding.feeAmount)).toString(),
            feeCap: cap.toString(),
          });
          let firstCoverage, baselineState, draft;
          const renewed = await coordinator.withPublicSnapshot(async (snapshot) => {
            // Entering the snapshot is the conservative close boundary: a
            // checkpoint/store freshness refusal can invalidate the old receipt
            // even before the first job. Do not promise borrowed-view reuse.
            entered = true;
            snapshotWindow = snapshot;
            attest(60000);
            check(checkpointHash(snapshot.checkpoint) === checkpoint && !snapshot.signal.aborted);
            const signal = AbortSignal.any([relaySignal, snapshot.signal]);
            baselineState = await walletSession.inspectWalletState();
            attest(60000);
            walletSession.assertFresh(baselineState);
            check(baselineState.storeId === activeGeneration.storeId);
            const common = {
              handle,
              snapshot,
              walletSession,
              coverageStore,
              walletId,
              relaySignal: signal,
            };
            const firstStarted = performance.now();
            scan = runner.prepareRelayReadOnly({ ...common, relayRequest: { selection, context } });
            const first = await scan;
            attest(30000);
            check(performance.now() >= firstStarted && performance.now() - firstStarted < 30000);
            sameOwned(first.relayOwned);
            assert.deepEqual(first.readOnly, { readOnly: true, writeAttempts: 0 });
            draft = relayData.bindRailgunRelayDraft(
              first.relayDraft.data,
              { selection, context },
              { walletId, ...captured }
            );
            assert.deepEqual(first.relayDraft, draft);
            // Consume the first opaque receipt before beginRestore can be called
            // again. It is not journal-qualified and must not reach readOwned.
            firstCoverage = await coverageStore.read(first.receipt);
            attest(30000);
            assert.deepEqual(firstCoverage.checkpoint, snapshot.checkpoint);
            assert.deepEqual(firstCoverage.coverage, first.coverage);
            const afterFirst = await walletSession.inspectWalletState();
            attest(30000);
            walletSession.assertFresh(afterFirst);
            assert.deepEqual(afterFirst, baselineState);
            const relayDraftText = JSON.stringify(draft.data);
            check(Buffer.byteLength(relayDraftText) <= 65536);
            const secondStarted = performance.now();
            scan = runner.reconstructRelayReadOnly({ ...common, relayDraftText });
            const second = await scan;
            attest();
            check(performance.now() >= secondStarted && performance.now() - secondStarted < 30000);
            sameOwned(second.relayOwned);
            assert.deepEqual(second.readOnly, { readOnly: true, writeAttempts: 0 });
            assert.deepEqual(
              second.relayReconstruction,
              relayData.normalizeRailgunRelayReconstruction(second.relayReconstruction, draft)
            );
            return second;
          });
          snapshotWindow = null;
          snapshotEvidence = renewed.evidence;
          attest();
          const finalCoverage = await coverageStore.read(renewed.value.receipt);
          attest();
          assert.deepEqual(finalCoverage, firstCoverage);
          assert.deepEqual(finalCoverage.coverage, renewed.value.coverage);
          const finalState = await walletSession.inspectWalletState();
          attest();
          walletSession.assertFresh(finalState);
          assert.deepEqual(finalState, baselineState);
          await journal.revalidate({
            snapshot: renewed.evidence,
            coverage: finalCoverage,
            state: finalState,
            receipt: renewed.value.receipt,
          });
          attest();
          const after = runner.readOwned(renewed.value.receipt, journal);
          sameOwned(after);
          const nextView = createRailgunKohakuRead({
            runner,
            journal,
            receipt: renewed.value.receipt,
          });
          attest();
          // Publish only after the independently parsed second process and final
          // journal validation, with no suspension between view/receipt swaps.
          checked = renewed;
          view = nextView;
          return Object.freeze({
            view,
            preparation: draft,
            reconstruction: Object.freeze({ ...renewed.value.relayReconstruction }),
            reviewedPreparation: false,
            reservationsChecked: false,
            capsulePersisted: false,
            signingEnabled: false,
            proofAuthority: false,
            poiQueriesPermitted: false,
            relaySendPermitted: false,
          });
        } catch (error) {
          if (unobserved(error)) {
            unknown = true;
            throw Object.assign(fail(), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED', cause: error });
          }
          throw error;
        } finally {
          clearTimeout(timer);
          relayController.abort();
          if (!unknown) handoff.release();
        }
      })();
      try {
        return await restoration;
      } catch {
        if (entered || unknown || lifetime.aborted) await close();
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
      prepareRelayIntent,
      readCompletedPrivateInput(input) {
        check(completedOnly);
        const capsule = completedInputCapsule(input);
        const observed = current();
        const binding = bindRecoveryInput(capsule, observed, descriptor);
        const selected = observed.ownedPoi.find((record) => record.id === binding.id);
        const note = observed.read.received.find((record) => record.id === binding.id);
        const through = observed.read.readiness.to;
        check(Number.isSafeInteger(through.number) && through.number >= 0);
        check(typeof through.hash === 'string' && /^0x[0-9a-f]{64}$/.test(through.hash));
        const publicThrough = Object.freeze({ number: through.number, hash: through.hash });
        const [ownedRecord] =
          require('./railgun-owned-poi-records').normalizeRailgunOwnedPoiRecords(
            [selected],
            { received: [note] },
            { to: publicThrough }
          );
        check(/^[0-9a-f]{64}$/.test(binding.checkpointHash));
        check(/^[0-9a-f]{64}$/.test(generation.id));
        current();
        return Object.freeze({ binding, ownedRecord, publicThrough, generationId: generation.id });
      },
      recoverPrivateProof(recovery) {
        check(completedOnly && recovery !== undefined);
        return restoreCurrent(undefined, undefined, recovery);
      },
      reserveHandoff() {
        check(!completedOnly);
        current();
        return phase.reserveHandoff();
      },
    });
    return account;
  } catch (error) {
    finishSetup();
    await close();
    throw error;
  } finally {
    finishSetup();
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
/** Detached selected-input data from a genuine completed wallet. No receipt,
 * private window, signing, POI freshness or submission authority is issued. */
function readRailgunCompletedAccountPrivateInput(account, owners, capsule) {
  try {
    return owned(account, owners).readCompletedPrivateInput(capsule);
  } catch {
    throw fail();
  }
}
function restoreRailgunAccountWallet(account, owners) {
  return owned(account, owners).restoreCurrent();
}
/** Fixed proof-data regeneration only. No operation window, signing permit or
 * completion receipt is issued; independent C and durable reattestation remain
 * the recovery controller's responsibility after this account fully closes. */
function recoverRailgunAccountPrivateProof(account, owners, recovery) {
  return owned(account, owners).recoverPrivateProof(recovery);
}
function reserveRailgunAccountWalletHandoff(account, owners) {
  return owned(account, owners).reserveHandoff();
}
function prepareRailgunAccountRelayIntent(account, owners, request) {
  require('./railgun-relay-quote-data').shape(owners, ['identity', 'enrollment', 'coordinator']);
  return owned(account, owners).prepareRelayIntent(request);
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
  openRailgunCompletedAccountWallet,
  getRailgunAccountWalletPolicy,
  readRailgunAccountOwnedNotes,
  readRailgunCompletedAccountPrivateInput,
  restoreRailgunAccountWallet,
  recoverRailgunAccountPrivateProof,
  reserveRailgunAccountWalletHandoff,
  prepareRailgunAccountPrivateIntent,
  prepareRailgunAccountRelayIntent,
  operateRailgunAccountPrivateIntent,
  assertRailgunAccountPrivateWindow,
  readRailgunAccountPrivateCreator,
  assertRailgunAccountPrivateCreator,
};
