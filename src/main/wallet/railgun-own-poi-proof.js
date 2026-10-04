/** Main-only local post-spend POI proving. Genuine membership is consumed as
 * preparation history, not continuing source/finality or disclosure authority.
 * The viewing job runs inside fresh recovery; keyless verification follows its
 * observed exit. No query, submission, renderer or production caller is added.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { verifyRailgunProverRuntime } = require('./railgun-prover-runtime');
const { assertRailgunOwnPoiMembership } = require('./railgun-own-poi-membership');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { startRailgunProcess } = require('./railgun-process');
const { verifyRailgunPoiPayload } = require('./railgun-poi-verifier');
const {
  normalizeRailgunOwnPoiProofInput,
  expectedRailgunOwnPoiFields,
  bindRailgunOwnPoiPayload,
} = require('./railgun-own-poi-proof-data');
const consumed = new WeakSet(),
  owners = new Map(),
  proofs = new WeakMap();
const CLEANUP_MS = 10000,
  MIN_PROVE_MS = 10000,
  VERIFY_RESERVE_MS = 35000;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const fail = () =>
  Object.assign(new Error('Railgun own POI proof unavailable'), {
    code: 'RAILGUN_OWN_POI_PROOF_REFUSED',
  });
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
function assertGuards(value) {
  shape(value, ['attempts', 'canaries', 'hooks']);
  assert.equal(value.attempts, 0);
  assert.ok(Array.isArray(value.hooks) && value.hooks.length >= 1 && value.hooks.length <= 256);
  assert.ok(value.hooks.every((v) => typeof v === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(v)));
  assert.equal(new Set(value.hooks).size, value.hooks.length);
  assert.equal(value.canaries, value.hooks.length);
}
async function proveRailgunOwnPoi(options = {}) {
  let stage = 'context',
    timer,
    phase,
    ownerDirectory;
  const owner = {},
    controller = new AbortController();
  try {
    shape(options, [
      'identity',
      'enrollment',
      'coordinator',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'membershipReceipt',
      'signal',
      ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : []),
    ]);
    const {
      identity,
      enrollment,
      coordinator,
      membershipReceipt,
      signal,
      timeoutMs = 175000,
    } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 175000);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const proverArchive = verifyRailgunProverRuntime(options.proverArchive);
    const handle = enrollment.getContext('engine', 'poi-prove');
    const descriptor = assertRailgunIdentity(identity, handle);
    assert.deepEqual(descriptor, enrollment.descriptor);
    const policy = getRailgunPublicPolicy(archive);
    const publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, policy);
    const observed = assertRailgunOwnPoiMembership(
      membershipReceipt,
      enrollment,
      coordinator,
      1000
    );
    assert.ok(!consumed.has(membershipReceipt));
    assert.equal(observed.membership.membershipVerified, true);
    assert.equal('0x' + observed.membership.proofs[0].leaf, observed.selector.blindedCommitment);
    const input = normalizeRailgunOwnPoiProofInput({
      archive,
      proverArchive,
      artifactDirectory: options.artifactDirectory,
      descriptor,
      preparation: observed.poiPreparation,
      listProofs: observed.membership.proofs,
    });
    const expected = expectedRailgunOwnPoiFields(input);
    const inputText = JSON.stringify(input),
      inputSha256 = sha(inputText);
    const started = performance.now(),
      deadline = started + timeoutMs;
    const lifetime = AbortSignal.any([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    ownerDirectory = enrollment.directory;
    assert.ok(!owners.has(ownerDirectory));
    owners.set(ownerDirectory, owner);
    const current = () => {
      const now = performance.now();
      assert.ok(!lifetime.aborted && now >= started && now < deadline);
      assert.equal(owners.get(ownerDirectory), owner);
      assert.deepEqual(assertRailgunIdentity(identity, handle), descriptor);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
        publicIdentity
      );
      phase?.assertCurrent();
    };
    const remaining = () => {
      current();
      const ms = Math.floor(deadline - performance.now());
      assert.ok(ms > 0);
      return ms;
    };
    timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    stage = 'recovery';
    const recoveryBudget = Math.min(120000, remaining() - VERIFY_RESERVE_MS);
    assert.ok(recoveryBudget > CLEANUP_MS + MIN_PROVE_MS);
    const recoveryDeadline = performance.now() + recoveryBudget;
    const recovered = await withRailgunOwnOperationRecovery(
      {
        enrollment,
        selector: observed.capture.selector,
        signal: lifetime,
        timeoutMs: recoveryBudget,
      },
      async (window) => {
        current();
        window.assertCurrent(CLEANUP_MS + MIN_PROVE_MS);
        assertRailgunOwnPoiCapture(window.capture, observed.capture);
        const jobController = new AbortController();
        const jobSignal = AbortSignal.any([lifetime, window.signal, jobController.signal]);
        const jobDeadline = recoveryDeadline - CLEANUP_MS;
        let task,
          result,
          sequence = 0,
          keyReleased = false,
          stopped = false,
          failed = false,
          accepting = true,
          taskCloseRequested = false,
          keyCopy;
        const pending = new Set();
        const jobCurrent = (margin = 0) => {
          current();
          assert.ok(
            !stopped && !failed && !jobSignal.aborted && performance.now() + margin < jobDeadline
          );
          window.assertCurrent(CLEANUP_MS + margin);
        };
        const jobMs = Math.floor(jobDeadline - performance.now());
        assert.ok(jobMs > MIN_PROVE_MS);
        const closeTask = () => {
          if (!task || taskCloseRequested) return;
          taskCloseRequested = true;
          try {
            task.close();
          } catch {
            failed = true;
          }
        };
        const closeJob = () => {
          if (!stopped) {
            stopped = true;
            accepting = false;
            jobController.abort();
          }
          // A synchronous broker refusal may precede start's returned handle.
          // Re-entry after assignment must still close that late task exactly once.
          closeTask();
        };
        const refuse = () => {
          failed = true;
          keyCopy?.fill(0);
          closeJob();
        };
        jobSignal.addEventListener('abort', closeJob, { once: true });
        const earlyTimer = setTimeout(closeJob, jobMs);
        earlyTimer.unref?.();
        const dispatch = async (wire) => {
          try {
            jobCurrent();
            assert.ok(accepting);
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
            const message = JSON.parse(wire);
            assert.equal(message.id, ++sequence);
            assert.equal(result, undefined);
            if (message.id === 1) {
              assert.deepEqual(message, {
                id: 1,
                method: 'key',
                purpose: 'poi-prove',
                inputSha256,
              });
              jobCurrent(MIN_PROVE_MS);
              assert.ok(!consumed.has(membershipReceipt));
              // A valid request consumes this receipt before its first await. A
              // failed derivation/reattest cannot retry a partially executed handoff.
              consumed.add(membershipReceipt);
              assertRailgunOwnPoiCapture(await window.reattest(), observed.capture);
              jobCurrent(MIN_PROVE_MS);
              const output = await withRailgunViewingCredential(
                identity,
                async ({ viewingKey }) => {
                  assertRailgunOwnPoiCapture(await window.reattest(), observed.capture);
                  // Derivation awaited; repeat every lifetime/identity check before
                  // the copy. Journal writers are not excluded by this window.
                  jobCurrent(MIN_PROVE_MS);
                  assert.ok(viewingKey instanceof Uint8Array && viewingKey.byteLength === 32);
                  keyCopy = Buffer.alloc(32);
                  keyCopy.set(viewingKey);
                  return keyCopy;
                }
              );
              jobCurrent();
              keyReleased = true;
              return output;
            }
            assert.equal(message.id, 2);
            assert.equal(message.method, 'result');
            shape(message, ['id', 'method', 'value']);
            assert.equal(keyReleased, true);
            const value = message.value;
            shape(value, [
              'inputSha256',
              'payloadSha256',
              'payload',
              'locallyVerified',
              'independentlyVerified',
              'sourceAuthenticated',
              'membershipAuthenticated',
              'rootAccepted',
              'disclosureEnabled',
              'spendingEnabled',
              'engineSha256',
              'proverSha256',
              'guards',
            ]);
            assert.equal(value.inputSha256, inputSha256);
            assert.equal(value.locallyVerified, true);
            for (const key of [
              'independentlyVerified',
              'sourceAuthenticated',
              'membershipAuthenticated',
              'rootAccepted',
              'disclosureEnabled',
              'spendingEnabled',
            ])
              assert.equal(value[key], false);
            assert.equal(value.engineSha256, require('./railgun-engine-manifest.json').sha256);
            assert.equal(value.proverSha256, require('./railgun-prover-manifest.json').sha256);
            assertGuards(value.guards);
            const payload = bindRailgunOwnPoiPayload(value.payload, expected);
            const payloadSha256 = sha(JSON.stringify(payload));
            assert.equal(value.payloadSha256, payloadSha256);
            result = Object.freeze({ payload, payloadSha256, inputSha256 });
            return JSON.stringify({ id: 2, value: null });
          } catch {
            // Latch synchronously: catching this rejected promise cannot admit
            // another request or rescue a result while borrowed work is pending.
            // Credential and capture assertion details never leave this broker.
            refuse();
            throw fail();
          }
        };
        try {
          jobCurrent();
          task = startRailgunProcess({
            handle,
            binaryKey: true,
            filename: require.resolve('./railgun-own-poi-prove-job'),
            input: inputText,
            startupMs: jobMs,
            lifetimeMs: jobMs,
            heapMb: 256,
            rssMb: 768,
            broker: {
              signal: jobSignal,
              dispatch(wire) {
                // Borrowed brokers own their async work. Utility exit alone does
                // not prove a pending credential/store callback has drained.
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
          assert.ok(result);
          accepting = false;
          closeTask();
          assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
          jobCurrent();
        } finally {
          clearTimeout(earlyTimer);
          jobSignal.removeEventListener('abort', closeJob);
          closeJob();
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
        // Publication follows cleanup: a late borrowed refusal or close error
        // must not disappear behind an earlier result/normal utility exit.
        assert.ok(!failed && performance.now() < jobDeadline);
        current();
        window.assertCurrent(CLEANUP_MS);
        return result;
      }
    );
    current();
    if (recovered.status !== 'used') {
      stage = 'recovery:' + recovered.stage;
      throw Error('refused');
    }
    const payload = bindRailgunOwnPoiPayload(recovered.value.payload, expected);
    const payloadSha256 = sha(JSON.stringify(payload));
    assert.equal(recovered.value.inputSha256, inputSha256);
    assert.equal(recovered.value.payloadSha256, payloadSha256);
    stage = 'verify';
    phase = claimRailgunAccountPhase(enrollment, 'recovery');
    const verified = await verifyRailgunPoiPayload({
      handle: enrollment.getContext('prover', 'poi-verify'),
      proverArchive,
      artifactDirectory: input.artifactDirectory,
      payload,
      signal: lifetime,
      timeoutMs: Math.min(30000, remaining()),
    });
    current();
    assert.equal(verified.utilityExitObserved, true);
    assert.equal(verified.proofVerified, true);
    assert.equal(verified.independentlyVerified, true);
    assert.equal(verified.payloadSha256, payloadSha256);
    const proved = Object.freeze({
      status: 'proved',
      payload,
      payloadSha256,
      inputSha256,
      locallyVerified: true,
      separatelyVerified: true,
      utilityExitObserved: true,
      accountAuthenticated: false,
      sourceAuthenticated: false,
      currentFinalityVerified: false,
      membershipAuthenticated: false,
      rootAccepted: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    // Keep only bounded detached history. Registration authenticates the local
    // proof result's origin, not current account, source or service eligibility.
    const historyText = JSON.stringify({
      archive,
      publicIdentity,
      capture: observed.capture,
      preparation: input.preparation,
      selector: observed.selector,
      expected,
      txidTree: Math.floor(payload.txidMerklerootIndex / 65536),
      payload,
      payloadSha256,
      inputSha256,
    });
    assert.ok(Buffer.byteLength(historyText) <= 131072);
    const history = freeze(JSON.parse(historyText));
    proofs.set(proved, {
      enrollment,
      coordinator,
      assertCurrent() {
        assert.ok(
          !identity.signal.aborted && !enrollment.signal.aborted && !coordinator.signal.aborted
        );
        assert.ok(isRailgunAccountEnrollment(enrollment));
        assert.deepEqual(assertRailgunIdentity(identity, handle), descriptor);
        assert.deepEqual(
          getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
          publicIdentity
        );
        return history;
      },
    });
    return proved;
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    clearTimeout(timer);
    controller.abort();
    phase?.release();
    if (owners.get(ownerDirectory) === owner) owners.delete(ownerDirectory);
  }
}
function assertRailgunOwnPoiProof(result, enrollment, coordinator) {
  try {
    const entry = proofs.get(result);
    assert.ok(entry && entry.enrollment === enrollment && entry.coordinator === coordinator);
    return entry.assertCurrent();
  } catch {
    throw Object.assign(new Error('Railgun own POI proof history unavailable'), {
      code: 'RAILGUN_OWN_POI_PROOF_HISTORY_REFUSED',
    });
  }
}
module.exports = { proveRailgunOwnPoi, assertRailgunOwnPoiProof };
