/** Main-only post-spend typed membership and Transact selector composition. The invoking controller
 * owns authorization for this query: it discloses the derived blinded input.
 * No production/renderer caller is installed here. Returned receipts authorize
 * neither viewing-key release nor subsequent POI payload disclosure or spending.
 */
const assert = require('assert/strict');
const { createHash, randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const {
  preflightRailgunOwnPoi,
  captureRailgunOwnTransactPoiMembershipInput,
} = require('./railgun-own-witness');
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
const { prepareRailgunPoiTransactSelectorInput } = require('./railgun-poi-transact-selector-data');
const { startRailgunProcess } = require('./railgun-process');
const { createRailgunTxidRootSource } = require('./railgun-txid-root');
const {
  captureRailgunOwnOperation,
  withRailgunOwnOperationRecovery,
} = require('./railgun-own-operation');
const { deriveRailgunPoiShieldSelector } = require('./railgun-poi-shield-selector');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { createRailgunPoiSource, MAX_AGE_MS } = require('./railgun-poi-source');
const {
  verifyRailgunPoiMembership,
  assertRailgunPoiMembership,
} = require('./railgun-poi-membership');
const { REQUIRED_LIST, normalizePoiProofs, normalizePoiNotes } = require('./railgun-poi-records');
const { POI_LAUNCH_BLOCK } = require('./railgun-owned-poi-records');
const { assertRailgunOwnPoiCapture: compareCapture } = require('./railgun-own-poi-binding');
const TOTAL_MS = 300000,
  TAIL_MS = 100000,
  RECOVERY_MS = 20000,
  JOB_MS = 15000,
  RESERVE_MS = 5000;
const AUTHORITY = Object.freeze({
  sourceAuthenticated: false,
  currentFinalityVerified: false,
  txidRootAccepted: false,
  membershipAuthenticated: false,
  disclosureEnabled: false,
  spendingEnabled: false,
});
const selectorFail = () =>
  Object.assign(new Error('Railgun Transact POI selector unavailable'), {
    code: 'RAILGUN_POI_TRANSACT_SELECTOR_REFUSED',
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const owners = new Map(),
  receipts = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun own POI membership unavailable'), {
    code: 'RAILGUN_OWN_POI_MEMBERSHIP_REFUSED',
  });
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
// Fixed wrappers alone select these branches. No caller mode, observation,
// continuation or owner token is accepted, and all branches share one owner.
async function open(options = {}, mode = 'shield') {
  const transact = mode !== 'shield',
    diagnostic = mode === 'transact-selector';
  let stage = 'context',
    scope,
    source,
    listScope,
    roots,
    rootScope,
    rootTimer,
    rootReceipt,
    rootObservation,
    rootPoint,
    rootDeadline,
    rootAdmissionDeadline = Infinity,
    rootGated = false,
    rootCleanupFailed = false,
    cleanupFailed = false,
    phase,
    timer,
    ownerDirectory,
    parent,
    closed = false,
    drained = false,
    sourceDrained = false,
    resolveClosed,
    success = false;
  const owner = {},
    controller = new AbortController(),
    drain = new Promise((resolve) => (resolveClosed = resolve));
  const finishClose = () => {
    if (!closed || !drained || (source && !sourceDrained)) return;
    if (owners.get(ownerDirectory) === owner) owners.delete(ownerDirectory);
    resolveClosed();
  };
  const closeRoots = () => {
    clearTimeout(rootTimer);
    try {
      roots?.close();
    } catch {
      rootCleanupFailed = true;
    }
    try {
      rootScope?.close();
    } catch {
      rootCleanupFailed = true;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort();
    closeRoots();
    try {
      listScope?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      source?.close();
    } catch {
      cleanupFailed = true;
      // A close request is not drain evidence; retain the owner until closed.
    }
    try {
      scope?.close();
    } catch {
      cleanupFailed = true;
      // Cleanup is also called by abort listeners and must not throw.
    }
    // Abort revokes admission; phase/work and source drain retain the owner.
    finishClose();
  };
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.deepEqual(
      Object.keys(options)
        .filter((k) => k !== 'timeoutMs')
        .sort(),
      [
        'archive',
        'coordinator',
        'enrollment',
        ...(transact ? ['identity'] : []),
        'selector',
        'signal',
      ]
    );
    const {
      identity,
      enrollment,
      coordinator,
      signal,
      timeoutMs = transact ? TOTAL_MS : 480000,
    } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(
      Number.isSafeInteger(timeoutMs) &&
        timeoutMs >= 1 &&
        timeoutMs <= (transact ? TOTAL_MS : 480000)
    );
    const selectorText = JSON.stringify(options.selector);
    assert.ok(typeof selectorText === 'string' && Buffer.byteLength(selectorText) <= 1024);
    const selector = transact ? freeze(JSON.parse(selectorText)) : JSON.parse(selectorText);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const policy = getRailgunPublicPolicy(archive);
    const capturedIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, policy);
    const publicIdentity = transact
      ? freeze(JSON.parse(JSON.stringify(capturedIdentity)))
      : capturedIdentity;
    parent = enrollment.getContext('engine', ...(transact ? ['poi-transact-selector'] : []));
    const descriptor = transact
      ? freeze(JSON.parse(JSON.stringify(assertRailgunIdentity(identity, parent))))
      : undefined;
    if (transact) {
      assert.deepEqual(descriptor, enrollment.descriptor);
      const subject = getPrivacyContext(parent).subject;
      assert.equal(subject.kind, 'private-account');
      assert.equal(subject.principal, `railgun:${descriptor.accountIndex}`);
      assert.equal(subject.protocol, 'railgun');
      assert.equal(subject.deployment, 'sepolia');
      assert.equal(subject.chainId, 11155111);
      assert.equal(subject.role, 'engine');
      assert.equal(subject.operation, 'poi-transact-selector');
    }
    const context = getPrivacyContext(parent),
      started = performance.now(),
      deadline = started + timeoutMs;
    if (transact) stage = 'busy';
    ownerDirectory = enrollment.directory;
    assert.ok(!owners.has(ownerDirectory));
    owners.set(ownerDirectory, owner);
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([
        signal,
        enrollment.signal,
        coordinator.signal,
        controller.signal,
        ...(transact ? [identity.signal] : []),
      ]),
      isCurrent: () => {
        try {
          getPrivacyContext(parent);
          if (transact) {
            assert.deepEqual(assertRailgunIdentity(identity, parent), descriptor);
            assert.deepEqual(
              getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
              publicIdentity
            );
          }
          return true;
        } catch {
          return false;
        }
      },
    });
    scope.signal.addEventListener('abort', close, { once: true });
    const current = (margin = 0) => {
      assert.ok(!closed && !scope.signal.aborted && owners.get(ownerDirectory) === owner);
      assert.ok(!source?.signal.aborted);
      assert.ok(performance.now() >= started && performance.now() + margin < deadline);
      getPrivacyContext(parent);
      if (transact) {
        assert.deepEqual(assertRailgunIdentity(identity, parent), descriptor);
        assert.deepEqual(enrollment.descriptor, descriptor);
      }
      phase?.assertCurrent();
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
        publicIdentity
      );
    };
    const remaining = (max, reserve = 0) => {
      current(reserve);
      const left = Math.min(max, Math.floor(deadline - performance.now()) - reserve);
      assert.ok(left > 0);
      return left;
    };
    timer = setTimeout(close, timeoutMs);
    timer.unref?.();
    async function deriveTransactSelector(historical, creator) {
      const input = prepareRailgunPoiTransactSelectorInput({
        archive,
        descriptor,
        capsule: historical.capture.capsule,
        creator,
      });
      const inputText = JSON.stringify(input);
      const inputSha256 = createHash('sha256').update(inputText).digest('hex');
      let derived;
      stage = 'recovery';
      const recoveryStarted = performance.now();
      const recoveryMs = remaining(RECOVERY_MS, RESERVE_MS);
      const recoveryDeadline = recoveryStarted + recoveryMs;
      const recovered = await withRailgunOwnOperationRecovery(
        {
          enrollment,
          selector,
          signal: scope.signal,
          timeoutMs: recoveryMs,
        },
        async (window) => {
          const windowCurrent = (margin = 0) => {
            current(margin);
            window.assertCurrent(margin);
            assert.ok(!window.signal.aborted && performance.now() + margin < recoveryDeadline);
          };
          const attest = async () => {
            windowCurrent();
            compareCapture(await window.reattest(), historical.capture);
            windowCurrent();
          };
          compareCapture(window.capture, historical.capture);
          await attest();
          windowCurrent(RESERVE_MS * 2);
          stage = 'selector';
          const jobDeadline = Math.min(performance.now() + JOB_MS, recoveryDeadline - RESERVE_MS);
          const jobMs = Math.floor(jobDeadline - performance.now());
          assert.ok(jobMs > RESERVE_MS);
          let task,
            jobScope,
            keyCopy,
            result,
            keyReleased = false,
            sequence = 0,
            stopped = false,
            failed = false,
            accepting = true;
          const pending = new Set();
          const controller = new AbortController();
          const jobSignal = AbortSignal.any([scope.signal, window.signal, controller.signal]);
          const jobCurrent = (margin = 0) => {
            windowCurrent(RESERVE_MS + margin);
            assert.ok(
              !stopped && !failed && !jobSignal.aborted && performance.now() + margin < jobDeadline
            );
          };
          const closeJob = () => {
            stopped = true;
            accepting = false;
            controller.abort();
            try {
              jobScope?.close();
            } catch {
              failed = true;
            }
            try {
              task?.close();
            } catch {
              failed = true;
            }
          };
          const refuse = () => {
            failed = true;
            closeJob();
          };
          jobSignal.addEventListener('abort', closeJob, { once: true });
          const jobTimer = setTimeout(refuse, jobMs);
          jobTimer.unref?.();
          const dispatch = async (wire) => {
            try {
              jobCurrent();
              assert.ok(accepting && result === undefined);
              assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
              const message = JSON.parse(wire);
              assert.equal(message.id, sequence + 1);
              if (message.id === 1) {
                assert.deepEqual(message, {
                  id: 1,
                  method: 'key',
                  purpose: 'poi-transact-selector',
                  inputSha256,
                });
                jobCurrent(RESERVE_MS);
                sequence = 1;
                await attest();
                jobCurrent(RESERVE_MS);
                const bytes = await withRailgunViewingCredential(
                  identity,
                  async ({ viewingKey }) => {
                    // Authenticated recovery reads are required here; no unrelated
                    // intent-store access or nested phase acquisition is permitted.
                    await attest();
                    jobCurrent(RESERVE_MS);
                    assert.ok(viewingKey instanceof Uint8Array && viewingKey.byteLength === 32);
                    keyCopy = Buffer.alloc(32);
                    keyCopy.set(viewingKey);
                    return keyCopy;
                  }
                );
                jobCurrent();
                keyReleased = true;
                return bytes;
              }
              assert.equal(message.id, 2);
              assert.equal(keyReleased, true);
              shape(message, ['id', 'method', 'value']);
              assert.equal(message.method, 'result');
              const value = message.value;
              shape(value, [
                'inputSha256',
                'bindingDigest',
                'blindedCommitment',
                'type',
                'selectorDerived',
                'receiverMatched',
                'inventory',
                'guards',
                ...Object.keys(AUTHORITY),
              ]);
              assert.equal(value.inputSha256, inputSha256);
              assert.equal(value.bindingDigest, input.bindingDigest);
              assert.equal(value.type, 'Transact');
              assert.match(value.blindedCommitment, /^0x[0-9a-f]{64}$/);
              assert.equal(value.selectorDerived, true);
              assert.equal(value.receiverMatched, true);
              for (const key of Object.keys(AUTHORITY)) assert.equal(value[key], false);
              assert.equal(
                value.inventory,
                require('./railgun-engine-manifest.json').inventory.sha256
              );
              const [note] = normalizePoiNotes([
                { type: value.type, blindedCommitment: value.blindedCommitment },
              ]);
              shape(value.guards, ['attempts', 'canaries', 'hooks']);
              const { attempts, canaries, hooks } = value.guards;
              assert.equal(attempts, 0);
              assert.ok(Array.isArray(hooks) && hooks.length > 0 && hooks.length <= 256);
              assert.ok(
                hooks.every((v) => typeof v === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(v))
              );
              assert.equal(new Set(hooks).size, hooks.length);
              assert.equal(canaries, hooks.length);
              jobCurrent();
              sequence = 2;
              result = Object.freeze({
                type: 'Transact',
                blindedCommitment: note.blindedCommitment,
                bindingDigest: input.bindingDigest,
                inputSha256,
              });
              return JSON.stringify({ id: 2, value: null });
            } catch {
              keyCopy?.fill(0);
              refuse();
              throw selectorFail();
            }
          };
          try {
            jobScope = createPrivacyScope({
              profileId: context.profileId,
              signal: jobSignal,
              isCurrent: () => {
                try {
                  jobCurrent();
                  return true;
                } catch {
                  return false;
                }
              },
            });
            jobCurrent();
            task = startRailgunProcess({
              handle: jobScope.getContext(context.subject),
              filename: require.resolve('./railgun-poi-transact-selector-job'),
              input: inputText,
              binaryKey: true,
              startupMs: jobMs,
              lifetimeMs: jobMs,
              heapMb: 256,
              rssMb: 768,
              broker: {
                signal: jobSignal,
                dispatch(wire) {
                  const work = dispatch(wire);
                  pending.add(work);
                  work.then(
                    () => pending.delete(work),
                    () => pending.delete(work)
                  );
                  return work;
                },
              },
            });
            if (stopped) closeJob();
            await task.ready;
            jobCurrent();
            assert.ok(result && keyReleased);
            accepting = false;
            task.close();
            assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
            jobCurrent();
            derived = result;
          } finally {
            clearTimeout(jobTimer);
            jobSignal.removeEventListener('abort', closeJob);
            closeJob();
            try {
              if (task) await task.closed;
            } finally {
              while (pending.size) await Promise.allSettled([...pending]);
              keyCopy?.fill(0);
            }
          }
          assert.ok(!failed);
          windowCurrent();
          await attest();
          return Object.freeze({ selectorDerived: true });
        }
      );
      current();
      if (recovered.status !== 'used') {
        stage = 'recovery:' + recovered.stage;
        throw selectorFail();
      }
      assert.ok(derived);
      stage = 'recapture';
      const latest = await captureRailgunOwnOperation({
        enrollment,
        selector,
        signal: scope.signal,
        timeoutMs: remaining(10000),
      });
      current();
      assert.equal(latest.status, 'captured');
      compareCapture(latest.capture, historical.capture);
      return derived;
    }
    stage = 'preflight';
    const preflight = await (
      transact ? captureRailgunOwnTransactPoiMembershipInput : preflightRailgunOwnPoi
    )({
      enrollment,
      coordinator,
      archive,
      selector,
      signal: scope.signal,
      timeoutMs: remaining(300000, transact ? TAIL_MS : 0),
    });
    if (transact && preflight.status !== 'captured')
      return Object.freeze({
        status: 'refused',
        stage: 'preflight:' + preflight.stage,
        ...(preflight.sourceOutcome ? { sourceOutcome: preflight.sourceOutcome } : {}),
      });
    current();
    if (preflight.status !== 'captured') {
      stage = 'preflight:' + preflight.stage;
      throw fail();
    }
    assert.deepEqual(preflight.publicIdentity, publicIdentity);
    if (!transact) stage = 'archive-anchor';
    assert.equal(preflight.observations.archiveAnchorChecked, true);
    if (!transact) stage = 'creator';
    const inputType = transact ? 'Transact' : 'Shield';
    assert.equal(preflight.creatorClassification.type, inputType);
    assert.equal(preflight.creatorClassification.legacy, false);
    assert.ok(preflight.creatorClassification.blockNumber >= POI_LAUNCH_BLOCK);
    assert.equal(preflight.poiPreparation.creator.type, inputType);
    assert.deepEqual(preflight.poiPreparation.ownEvidence.capsule, preflight.capture.capsule);
    if (!transact) stage = 'selector';
    let derived;
    if (transact) {
      assert.equal(preflight.publicPolicy, policy);
      assert.equal(preflight.creatorProvenance.note.type, 'Transact');
      const creator = preflight.poiPreparation.creator;
      for (const key of ['type', 'tree', 'position', 'hash'])
        assert.equal(creator[key], preflight.creatorProvenance.note[key]);
      derived = await deriveTransactSelector(preflight, creator);
    } else
      try {
        phase = claimRailgunAccountPhase(enrollment, 'recovery');
        derived = await deriveRailgunPoiShieldSelector({
          handle: enrollment.getContext('engine', 'poi-shield-selector'),
          archive,
          capsule: preflight.poiPreparation.ownEvidence.capsule,
          creator: preflight.poiPreparation.creator,
          signal: scope.signal,
          timeoutMs: remaining(30000),
        });
        current();
        assert.equal(derived.utilityExitObserved, true);
        assert.equal(derived.selectorDerived, true);
      } finally {
        phase?.release();
        phase = undefined;
      }
    const recapture = async (name, budget = remaining(transact ? 10000 : 45000)) => {
      stage = name;
      const fresh = await captureRailgunOwnOperation({
        enrollment,
        selector,
        signal: scope.signal,
        timeoutMs: budget,
      });
      current();
      assert.equal(fresh.status, 'captured');
      compareCapture(fresh.capture, preflight.capture);
    };
    // Genuine recovery is rechecked immediately before the owned disclosure.
    // This is not a journal writer lock or renewed source/finality receipt.
    // Transact's selector core has just performed this strict final recapture.
    if (!transact) await recapture('before-query');
    if (diagnostic) {
      stage = 'cleanup';
      close();
      assert.ok(!cleanupFailed && !rootCleanupFailed);
      return Object.freeze({
        status: 'derived',
        selectorDerived: true,
        receiverMatched: true,
        utilityExitObserved: true,
        ...AUTHORITY,
      });
    }
    if (transact) {
      stage = 'root';
      rootPoint = Object.freeze({ index: preflight.state.count - 1, root: preflight.state.root });
      const rootBudget = remaining(15000, 55000);
      const rootStarted = performance.now();
      rootDeadline = rootStarted + 60000;
      rootAdmissionDeadline = rootStarted + rootBudget;
      rootScope = createPrivacyScope({
        profileId: context.profileId,
        signal: scope.signal,
        isCurrent: () => {
          try {
            current();
            assert.ok(
              performance.now() >= rootStarted && performance.now() < rootAdmissionDeadline
            );
            return true;
          } catch {
            return false;
          }
        },
      });
      rootTimer = setTimeout(close, rootBudget);
      rootTimer.unref?.();
      roots = createRailgunTxidRootSource(
        rootScope.getContext({
          kind: 'service',
          principal: 'railgun-public-sync',
          protocol: 'railgun',
          deployment: 'sepolia',
          chainId: 11155111,
          role: 'public-services',
        })
      );
      // Await the admitted root work even if cancellation ignores transport abort.
      rootReceipt = await roots.acquire(rootPoint);
      current();
      assert.ok(performance.now() < rootAdmissionDeadline);
      rootObservation = roots.assertRoot(rootReceipt, rootPoint);
      clearTimeout(rootTimer);
      rootAdmissionDeadline = Infinity;
      rootGated = true;
      rootTimer = setTimeout(close, Math.max(1, Math.floor(rootDeadline - performance.now())));
      rootTimer.unref?.();
      listScope = createPrivacyScope({
        profileId: context.profileId,
        signal: scope.signal,
        isCurrent: () => {
          try {
            current();
            if (rootGated) {
              assert.ok(performance.now() < rootDeadline);
              roots.assertRoot(rootReceipt, rootPoint);
            }
            return true;
          } catch {
            return false;
          }
        },
      });
    }
    stage = 'source';
    const operation = createHash('sha256')
      .update(
        JSON.stringify([
          'freedom:railgun:own-poi-membership-v1',
          randomUUID(),
          enrollment.binding,
          preflight.capture.bindingDigest,
          derived.bindingDigest,
          derived.inputSha256,
        ])
      )
      .digest('hex');
    const handle = (listScope || scope).getContext({
      ...context.subject,
      role: 'poi',
      operation: 'poi:' + operation,
    });
    const notes = Object.freeze([
      Object.freeze({ blindedCommitment: derived.blindedCommitment, type: inputType }),
    ]);
    current();
    source = createRailgunPoiSource({ handle, notes });
    const sourceClosed = source.closed;
    assert.ok(sourceClosed && typeof sourceClosed.then === 'function');
    sourceClosed.then(
      () => {
        sourceDrained = true;
        finishClose();
      },
      () => close()
    );
    source.signal.addEventListener('abort', close, { once: true });
    current();
    const acquisitionStarted = performance.now();
    const acquisitionRemaining = (max) => {
      current();
      const now = performance.now();
      assert.ok(now >= acquisitionStarted);
      const left = Math.min(remaining(max), Math.floor(MAX_AGE_MS - (now - acquisitionStarted)));
      assert.ok(left > 0);
      return left;
    };
    stage = 'acquire';
    let acquisitionBudget = acquisitionRemaining(transact ? 30000 : 45000);
    if (transact) {
      acquisitionBudget = Math.min(
        acquisitionBudget,
        Math.floor(rootDeadline - performance.now()) - RESERVE_MS,
        remaining(30000, 25000)
      );
      assert.ok(acquisitionBudget > 0);
      roots.assertRoot(rootReceipt, rootPoint, acquisitionBudget + RESERVE_MS);
    }
    const acquired = await source.acquire({ timeoutMs: acquisitionBudget });
    current();
    stage = 'membership-status';
    const observed = source.assertResult(acquired.receipt);
    assert.equal(observed, acquired.observation);
    if (transact) {
      // Last root check belongs to acquisition completion, not publication.
      current();
      assert.ok(performance.now() < rootDeadline);
      assert.equal(roots.assertRoot(rootReceipt, rootPoint), rootObservation);
      rootObservation = freeze(JSON.parse(JSON.stringify(rootObservation)));
      rootGated = false;
      clearTimeout(rootTimer);
      closeRoots();
      assert.ok(!rootCleanupFailed);
      current();
      assert.equal(source.assertResult(acquired.receipt), observed);
    }
    assert.equal(observed.listKey, REQUIRED_LIST);
    assert.deepEqual(observed.statuses, [{ ...notes[0], status: 'Valid' }]);
    assert.equal(observed.rootsAccepted, true);
    assert.deepEqual(normalizePoiProofs(observed.proofs, notes), observed.proofs);
    assert.equal(observed.proofs.length, 1);
    assert.ok(Array.isArray(observed.events) && observed.events.length === 1);
    const event = observed.events[0].signedPOIEvent;
    assert.equal(event.index, Number(BigInt('0x' + observed.proofs[0].indices)));
    assert.equal(event.type, inputType);
    assert.equal('0x' + event.blindedCommitment.replace(/^0x/, ''), derived.blindedCommitment);
    stage = 'membership-verify';
    let membership;
    try {
      const budget = transact
        ? Math.min(acquisitionRemaining(10000), remaining(10000, 15000))
        : acquisitionRemaining(30000);
      if (transact) source.assertResult(acquired.receipt, budget + 15000);
      phase = claimRailgunAccountPhase(enrollment, 'recovery');
      membership = await verifyRailgunPoiMembership({
        handle,
        source,
        receipt: acquired.receipt,
        archive,
        timeoutMs: budget,
      });
      current();
      assert.equal(membership.observation.membershipVerified, true);
      assert.deepEqual(membership.observation.proofs, observed.proofs);
    } finally {
      phase?.release();
      phase = undefined;
    }
    if (transact) {
      const budget = Math.min(acquisitionRemaining(10000), remaining(10000, RESERVE_MS));
      source.assertResult(acquired.receipt, budget + RESERVE_MS);
      await recapture('after-query', budget);
    } else await recapture('after-query');
    stage = 'receipts';
    assert.equal(source.assertResult(acquired.receipt), observed);
    assert.equal(assertRailgunPoiMembership(membership.receipt, handle), membership.observation);
    const observation = freeze({
      capture: preflight.capture,
      poiPreparation: preflight.poiPreparation,
      selector: {
        blindedCommitment: derived.blindedCommitment,
        bindingDigest: derived.bindingDigest,
        inputSha256: derived.inputSha256,
      },
      membership: membership.observation,
      ...(transact
        ? {
            inputType: 'Transact',
            creatorProvenance: preflight.creatorProvenance,
            recordedRoot: rootObservation,
          }
        : {}),
      accountAuthenticated: false,
      sourceAuthenticated: false,
      currentFinalityVerified: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    const receipt = Object.freeze({});
    const assertCurrent = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < MAX_AGE_MS);
      current();
      assert.ok(performance.now() + margin < deadline);
      assert.equal(source.assertResult(acquired.receipt, margin), observed);
      assert.equal(
        assertRailgunPoiMembership(membership.receipt, handle, margin),
        membership.observation
      );
      return observation;
    };
    assertCurrent();
    receipts.set(receipt, { enrollment, coordinator, assertCurrent });
    clearTimeout(timer);
    timer = setTimeout(close, acquisitionRemaining(MAX_AGE_MS));
    timer.unref?.();
    success = true;
    return Object.freeze({
      status: 'verified',
      receipt,
      observation,
      close,
      closed: drain,
      signal: scope.signal,
    });
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    try {
      phase?.release();
    } finally {
      phase = undefined;
      drained = true;
      if (!success) close();
      finishClose();
      // The public open wrapper is not part of the work flag. A refusal waits
      // here only after all admitted work and phase cleanup have completed.
      if (closed) await drain;
    }
  }
}
function assertRailgunOwnPoiMembership(receipt, enrollment, coordinator, minimumRemainingMs = 0) {
  try {
    const entry = receipts.get(receipt);
    assert.ok(entry && entry.enrollment === enrollment && entry.coordinator === coordinator);
    return entry.assertCurrent(minimumRemainingMs);
  } catch {
    throw fail();
  }
}
module.exports = {
  openRailgunOwnPoiMembership: (options) => open(options, 'shield'),
  openRailgunOwnTransactPoiMembership: (options) => open(options, 'transact-membership'),
  assertRailgunOwnPoiMembership,
  // Sole production caller is the compatibility selector wrapper. No private
  // selector/history data or callback can enter or leave this diagnostic API.
  deriveRailgunOwnTransactPoiSelectorDiagnostic: async (options) => {
    try {
      const result = await open(options, 'transact-selector');
      if (result.status !== 'derived')
        return Object.freeze({ status: 'refused', stage: result.stage });
      return result;
    } catch {
      return Object.freeze({ status: 'refused', stage: 'cleanup' });
    }
  },
};
