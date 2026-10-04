/** Rebind retained POI output data after enrollment restart. Diagnostic only:
 * transfer releases one viewing credential per call, unshield releases none.
 * No proof registry restoration, old-root acceptance or consent. The fixed
 * attempted route rebinds output after reopen without resolving or retrying POST.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const {
  getRailgunAccountPublicIdentity,
  getRailgunAccountPublicDestination,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const {
  preflightRailgunOwnPoi,
  preflightRailgunOwnPoiCompleted,
  preflightRailgunOwnPoiForSubmission,
} = require('./railgun-own-witness');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { normalizeRailgunPoiSubmission } = require('./railgun-poi-submit-data');
const { normalizeRailgunPoiShieldInput } = require('./railgun-poi-shield-selector-data');
const { matchRailgunOwnTxid } = require('./railgun-own-txid');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const {
  normalizeRailgunPoiOutputRecoveryInput,
  normalizeRailgunRecoveredPoiOutput,
} = require('./railgun-poi-output-recovery-data');
const { startRailgunProcess } = require('./railgun-process');
const owners = new Map();
const TOTAL_MS = 240000,
  PREFLIGHT_MS = 180000,
  POST_MS = 60000;
const RECOVERY_MS = 45000,
  JOB_MS = 30000,
  CLEANUP_MS = 5000,
  KEY_ADMISSION_MS = 5000,
  MIN_JOB_MS = 1000;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const fail = () =>
  Object.assign(new Error('Railgun POI output recovery unavailable'), {
    code: 'RAILGUN_POI_OUTPUT_RECOVERY_REFUSED',
  });
function guards(value) {
  shape(value, ['attempts', 'canaries', 'hooks']);
  assert.equal(value.attempts, 0);
  assert.ok(Array.isArray(value.hooks) && value.hooks.length > 0 && value.hooks.length <= 256);
  assert.ok(value.hooks.every((v) => typeof v === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(v)));
  assert.equal(new Set(value.hooks).size, value.hooks.length);
  assert.equal(value.canaries, value.hooks.length);
}
async function recover(options = {}, completed = false, submission, attempted = false) {
  let stage = 'context',
    timer,
    directory,
    sourceOutcome,
    sharedClaim,
    store;
  const owner = {},
    controller = new AbortController();
  const stop = () => controller.abort();
  try {
    shape(options, [
      'identity',
      'enrollment',
      'coordinator',
      'archive',
      'capsuleDigest',
      'signal',
      ...(completed && !attempted ? ['sourceDestination'] : []),
      ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : []),
    ]);
    const {
      identity,
      enrollment,
      coordinator,
      capsuleDigest,
      signal,
      sourceDestination: suppliedDestination,
      timeoutMs = TOTAL_MS,
    } = options;
    if (submission) {
      shape(submission, ['entry', 'capture', 'observation']);
      const text = JSON.stringify(submission);
      assert.ok(Buffer.byteLength(text) <= 384 * 1024);
      submission = JSON.parse(text);
    }
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TOTAL_MS);
    assert.match(capsuleDigest, /^[0-9a-f]{64}$/);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const handle = enrollment.getContext('engine', 'poi-output-recover');
    const descriptor = assertRailgunIdentity(identity, handle);
    assert.deepEqual(descriptor, enrollment.descriptor);
    const policy = getRailgunPublicPolicy(archive);
    const publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, policy);
    const started = performance.now(),
      deadline = started + timeoutMs;
    let activeDeadline = deadline;
    const lifetime = AbortSignal.any([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    directory = enrollment.directory;
    if (attempted) {
      stage = 'busy';
      // Lazy import: ordinary/submission output must not claim again beneath
      // the sender, or eagerly load the sender's dependency closure.
      sharedClaim = require('./railgun-poi-disclosure-plan').claimRailgunAttemptedPoiOutput({
        identity,
        enrollment,
        coordinator,
        signal: lifetime,
      });
      stage = 'context';
    }
    assert.ok(!owners.has(directory));
    owners.set(directory, owner);
    const sourceDestination = attempted
      ? getRailgunAccountPublicDestination(coordinator, enrollment, policy)
      : suppliedDestination;
    const current = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < POST_MS);
      const now = performance.now();
      assert.ok(
        !lifetime.aborted &&
          !store?.signal.aborted &&
          now >= started &&
          now + margin < activeDeadline
      );
      assert.equal(owners.get(directory), owner);
      sharedClaim?.assertCurrent();
      assert.deepEqual(assertRailgunIdentity(identity, handle), descriptor);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
        publicIdentity
      );
      if (completed)
        assertRailgunAccountPublicDestination(coordinator, enrollment, sourceDestination, policy);
    };
    const remaining = (max) => {
      current();
      const value = Math.min(max, Math.floor(activeDeadline - performance.now()));
      assert.ok(value > 0);
      return value;
    };
    timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    if (completed) current();
    stage = 'stored';
    store = await enrollment.openPoiIntents({ existingOnly: true });
    current();
    store.signal.addEventListener('abort', stop, { once: true });
    const loaded = await store.get(capsuleDigest);
    current();
    // Attempt data is detached before later awaits. The encrypted record does
    // not persist the sender's validation result: fresh on-chain output binding
    // remains mandatory even if this same request was previously transmitted.
    const entry = attempted ? freeze(JSON.parse(JSON.stringify(loaded))) : loaded;
    if (submission) assert.deepEqual(entry, submission.entry);
    assert.ok(entry && entry.state === (attempted ? 'attempted' : 'prepared'));
    assert.equal(entry.capsuleDigest, capsuleDigest);
    const payload = normalizeRailgunPoiPayload(entry.payload);
    assert.equal(sha(JSON.stringify(payload)), entry.payloadSha256);
    let attemptBodySha256;
    if (attempted) {
      shape(entry.attempt, ['attemptedAt', 'submission']);
      const attempt = normalizeRailgunPoiSubmission(entry.attempt.submission);
      assert.equal(attempt.requestId, entry.attempt.attemptedAt);
      assert.deepEqual(attempt.payload, payload);
      assert.equal(attempt.payloadSha256, entry.payloadSha256);
      assert.ok(Number.isSafeInteger(entry.revision) && entry.revision >= 1);
      attemptBodySha256 = attempt.bodySha256;
    }
    const storedText = JSON.stringify(entry);
    const readCurrent = async () => {
      current();
      const latest = await store.get(capsuleDigest);
      current();
      assert.equal(JSON.stringify(latest), storedText);
    };
    stage = 'preflight';
    const preflight = submission
      ? preflightRailgunOwnPoiForSubmission
      : completed
        ? preflightRailgunOwnPoiCompleted
        : preflightRailgunOwnPoi;
    const fresh = await preflight(
      {
        enrollment,
        coordinator,
        archive,
        selector: entry.selector,
        signal: lifetime,
        timeoutMs: remaining(PREFLIGHT_MS),
        ...(completed ? { sourceDestination } : {}),
      },
      ...(submission ? [submission] : [])
    );
    if (completed && fresh.status !== 'captured') {
      stage = 'preflight:' + fresh.stage;
      sourceOutcome = fresh.sourceOutcome;
      throw fail();
    }
    current(MIN_JOB_MS);
    if (fresh.status !== 'captured') {
      stage = 'preflight:' + fresh.stage;
      throw fail();
    }
    const preflightDurationMs = Math.ceil(performance.now() - started);
    activeDeadline = Math.min(deadline, performance.now() + POST_MS);
    clearTimeout(timer);
    timer = setTimeout(stop, Math.max(0, activeDeadline - performance.now()));
    timer.unref?.();
    stage = 'binding';
    assert.deepEqual(fresh.publicIdentity, publicIdentity);
    assert.equal(fresh.observations.archiveAnchorChecked, true);
    assert.equal(fresh.creatorClassification.type, 'Shield');
    assert.equal(fresh.creatorClassification.legacy, false);
    assert.equal(fresh.capture.capsuleDigest, capsuleDigest);
    assert.equal(fresh.capture.bindingDigest, entry.bindingDigest);
    if (submission) assertRailgunOwnPoiCapture(fresh.capture, submission.capture);
    assert.deepEqual(fresh.capture.selector, entry.selector);
    const { creator, ownEvidence, state, witness } = fresh.poiPreparation;
    assert.deepEqual(ownEvidence.capsule, fresh.capture.capsule);
    normalizeRailgunPoiShieldInput(ownEvidence.capsule, creator);
    const matched = matchRailgunOwnTxid(ownEvidence);
    const normalizedWitness = normalizeRailgunTxidWitness(witness, state);
    assert.deepEqual(normalizedWitness, fresh.witness);
    assert.deepEqual(normalizedWitness.row, matched.row);
    assert.equal(Math.floor(normalizedWitness.index / 65536), 0);
    // The saved checkpoint index is not a SNARK public input. Keep it exact and
    // bound it against the own leaf and the fresh mirror before any key request.
    assert.ok(
      normalizedWitness.index <= payload.txidMerklerootIndex &&
        payload.txidMerklerootIndex <= normalizedWitness.checkpointIndex
    );
    const transfer = ownEvidence.capsule.selection.kind === 'railgun-private-transfer';
    assert.equal(matched.output.kind, transfer ? 'shielded' : 'unshield');
    assert.equal(payload.blindedCommitmentsOut.length, transfer ? 1 : 0);
    const marker = transfer ? '0x00' : '0x' + normalizedWitness.railgunTxid;
    assert.equal(payload.railgunTxidIfHasUnshield, marker);
    const input = transfer
      ? normalizeRailgunPoiOutputRecoveryInput({
          archive,
          descriptor,
          binding: {
            capsuleDigest,
            bindingDigest: entry.bindingDigest,
            payloadSha256: entry.payloadSha256,
            revision: entry.revision,
          },
          preparation: fresh.poiPreparation,
        })
      : null;
    const inputText = input ? JSON.stringify(input) : null;
    const recoveryInputSha256 = inputText ? sha(inputText) : null;
    await readCurrent();
    stage = 'recovery';
    const budget = Math.min(RECOVERY_MS, remaining(POST_MS) - MIN_JOB_MS);
    assert.ok(budget > CLEANUP_MS + MIN_JOB_MS);
    const recoveryDeadline = performance.now() + budget;
    const recovered = await withRailgunOwnOperationRecovery(
      { enrollment, selector: entry.selector, signal: lifetime, timeoutMs: budget },
      async (window) => {
        const windowCurrent = (margin = 0) => {
          current(margin);
          window.assertCurrent(margin);
        };
        const attest = async () => {
          windowCurrent();
          assertRailgunOwnPoiCapture(await window.reattest(), fresh.capture);
          windowCurrent();
        };
        windowCurrent(CLEANUP_MS + MIN_JOB_MS);
        assertRailgunOwnPoiCapture(window.capture, fresh.capture);
        await attest();
        await readCurrent();
        windowCurrent(CLEANUP_MS + MIN_JOB_MS);
        let output = { blindedCommitmentsOut: [], railgunTxidIfHasUnshield: marker };
        if (transfer) {
          const jobController = new AbortController();
          const jobSignal = AbortSignal.any([lifetime, window.signal, jobController.signal]);
          const jobDeadline = Math.min(performance.now() + JOB_MS, recoveryDeadline - CLEANUP_MS);
          let task,
            result,
            keyCopy,
            sequence = 0,
            keyReleased = false,
            stopped = false;
          const pending = new Set();
          const jobCurrent = (margin = 0) => {
            windowCurrent(CLEANUP_MS + margin);
            assert.ok(!stopped && !jobSignal.aborted && performance.now() + margin < jobDeadline);
          };
          const jobMs = Math.floor(jobDeadline - performance.now());
          assert.ok(jobMs > MIN_JOB_MS);
          const earlyTimer = setTimeout(() => jobController.abort(), jobMs);
          earlyTimer.unref?.();
          const dispatch = async (wire) => {
            try {
              jobCurrent();
              assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
              const message = JSON.parse(wire);
              assert.equal(message.id, sequence + 1);
              assert.equal(result, undefined);
              if (message.id === 1) {
                assert.deepEqual(message, {
                  id: 1,
                  method: 'key',
                  purpose: 'poi-output-recover',
                  inputSha256: recoveryInputSha256,
                });
                jobCurrent(KEY_ADMISSION_MS);
                // Reserve before any await. No second derivation is allowed in this
                // call; a later diagnostic call has its own fresh child and key loan.
                sequence = 1;
                await attest();
                jobCurrent(KEY_ADMISSION_MS);
                try {
                  const bytes = await withRailgunViewingCredential(
                    identity,
                    async ({ viewingKey }) => {
                      await attest();
                      // No store read here: preparation needs this same recovery phase.
                      // No await between these lifetime/identity checks and the copy.
                      jobCurrent(KEY_ADMISSION_MS);
                      assert.ok(viewingKey instanceof Uint8Array && viewingKey.byteLength === 32);
                      keyCopy = Buffer.alloc(32);
                      keyCopy.set(viewingKey);
                      return keyCopy;
                    }
                  );
                  jobCurrent();
                  keyReleased = true;
                  return bytes;
                } catch (error) {
                  keyCopy?.fill(0);
                  throw error;
                }
              }
              assert.equal(message.id, 2);
              shape(message, ['id', 'method', 'value']);
              assert.equal(message.method, 'result');
              assert.equal(keyReleased, true);
              sequence = 2;
              const value = message.value;
              shape(value, [
                'recoveryInputSha256',
                'payloadSha256',
                'output',
                'engineSha256',
                'sourceAuthenticated',
                'proofVerified',
                'membershipAuthenticated',
                'rootAccepted',
                'disclosureEnabled',
                'spendingEnabled',
                'guards',
              ]);
              assert.equal(value.recoveryInputSha256, recoveryInputSha256);
              assert.equal(value.payloadSha256, entry.payloadSha256);
              assert.equal(value.engineSha256, require('./railgun-engine-manifest.json').sha256);
              for (const key of [
                'sourceAuthenticated',
                'proofVerified',
                'membershipAuthenticated',
                'rootAccepted',
                'disclosureEnabled',
                'spendingEnabled',
              ])
                assert.equal(value[key], false);
              guards(value.guards);
              const recoveredOutput = normalizeRailgunRecoveredPoiOutput(value.output);
              assert.deepEqual(
                recoveredOutput.blindedCommitmentsOut,
                payload.blindedCommitmentsOut
              );
              assert.equal(recoveredOutput.railgunTxidIfHasUnshield, marker);
              result = recoveredOutput;
              return JSON.stringify({ id: 2, value: null });
            } catch (error) {
              // Refusal is final even before the supervisor observes rejection.
              jobController.abort();
              throw error;
            }
          };
          try {
            jobCurrent();
            task = startRailgunProcess({
              handle,
              filename: require.resolve('./railgun-poi-output-recover-job'),
              input: inputText,
              binaryKey: true,
              startupMs: jobMs,
              lifetimeMs: jobMs,
              heapMb: 256,
              rssMb: 512,
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
            await task.ready;
            jobCurrent();
            assert.ok(result);
            task.close();
            assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
            jobCurrent();
            output = result;
          } finally {
            try {
              stopped = true;
              clearTimeout(earlyTimer);
              jobController.abort();
              task?.close();
            } finally {
              try {
                if (task) await task.closed;
              } finally {
                try {
                  while (pending.size) await Promise.allSettled([...pending]);
                } finally {
                  keyCopy?.fill(0);
                }
              }
            }
          }
        }
        await readCurrent();
        await attest();
        return {
          output,
          viewingKeyReleases: Number(transfer),
          viewingUtilityExitObserved: transfer,
        };
      }
    );
    current();
    if (recovered.status !== 'used') {
      stage = 'recovery:' + recovered.stage;
      throw fail();
    }
    await readCurrent();
    current();
    return Object.freeze({
      status: 'matched',
      ...(attempted
        ? {
            recordState: 'attempted',
            attemptBodySha256,
            eligibilityEstablished: false,
            attemptOutcomeKnown: false,
            submissionAccepted: false,
            retryEnabled: false,
          }
        : {}),
      capsuleDigest,
      revision: entry.revision,
      payloadSha256: entry.payloadSha256,
      recoveryInputSha256,
      preflightDurationMs,
      viewingKeyReleases: recovered.value.viewingKeyReleases,
      viewingUtilityExitObserved: recovered.value.viewingUtilityExitObserved,
      outputMatched: true,
      proofVerified: false,
      originalInputReconstructed: false,
      originalRootsAccepted: false,
      membershipAuthenticated: false,
      sourceAuthenticated: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
  } catch {
    return Object.freeze({ status: 'refused', stage, ...(sourceOutcome ? { sourceOutcome } : {}) });
  } finally {
    try {
      clearTimeout(timer);
      controller.abort();
      store?.signal.removeEventListener('abort', stop);
    } finally {
      try {
        if (owners.get(directory) === owner) owners.delete(directory);
      } finally {
        // Cancellation does not unlock the sender while borrowed work drains.
        sharedClaim?.release();
      }
    }
  }
}
module.exports = {
  recoverRailgunPoiOutput: (options) => recover(options),
  recoverRailgunPoiOutputCompleted: (options) => recover(options, true),
  // Fixed diagnostic only; no caller destination, observation or state override.
  recoverRailgunAttemptedPoiOutput: (options) => recover(options, true, undefined, true),
  // Sole production caller: the retained submission validator. Receipt data
  // is an invocation-local second argument, never a public options override.
  recoverRailgunPoiOutputForSubmission: (options, input) => recover(options, true, input || {}),
};
