/** Fixed main-only historical Transact preflight and received-input selector.
 * The public diagnostic contains no selector or transferable authority. No list
 * query, POI proof, intent mutation or sender is reachable from this module. */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
const { captureRailgunOwnTransactPoiMembershipInput } = require('./railgun-own-witness');
const {
  captureRailgunOwnOperation,
  withRailgunOwnOperationRecovery,
} = require('./railgun-own-operation');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const { prepareRailgunPoiTransactSelectorInput } = require('./railgun-poi-transact-selector-data');
const { startRailgunProcess } = require('./railgun-process');
const { normalizePoiNotes } = require('./railgun-poi-records');
const { POI_LAUNCH_BLOCK } = require('./railgun-owned-poi-records');
const owners = new Map();
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
const fail = () =>
  Object.assign(new Error('Railgun Transact POI selector unavailable'), {
    code: 'RAILGUN_POI_TRANSACT_SELECTOR_REFUSED',
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// Module-private: a future fixed membership consumer must use this composition,
// never adopt the exported diagnostic or caller-supplied preflight observations.
async function derive(options) {
  let stage = 'context',
    scope,
    timer,
    directory;
  const owner = {};
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    shape(options, [
      'identity',
      'enrollment',
      'coordinator',
      'archive',
      'selector',
      'signal',
      ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : []),
    ]);
    const { identity, enrollment, coordinator, signal, timeoutMs = TOTAL_MS } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TOTAL_MS);
    const selectorText = JSON.stringify(options.selector);
    assert.ok(typeof selectorText === 'string' && Buffer.byteLength(selectorText) <= 1024);
    const selector = freeze(JSON.parse(selectorText));
    const archive = verifyRailgunEngineRuntime(options.archive);
    const parent = enrollment.getContext('engine', 'poi-transact-selector');
    const context = getPrivacyContext(parent);
    assert.equal(context.subject.kind, 'private-account');
    assert.equal(context.subject.protocol, 'railgun');
    assert.equal(context.subject.deployment, 'sepolia');
    assert.equal(context.subject.chainId, 11155111);
    assert.equal(context.subject.role, 'engine');
    assert.equal(context.subject.operation, 'poi-transact-selector');
    const descriptor = freeze(JSON.parse(JSON.stringify(assertRailgunIdentity(identity, parent))));
    assert.deepEqual(descriptor, enrollment.descriptor);
    assert.equal(context.subject.principal, `railgun:${descriptor.accountIndex}`);
    const policy = getRailgunPublicPolicy(archive);
    const publicIdentity = freeze(
      JSON.parse(JSON.stringify(getRailgunAccountPublicIdentity(coordinator, enrollment, policy)))
    );
    const started = performance.now(),
      deadline = started + timeoutMs;
    stage = 'busy';
    directory = enrollment.directory;
    assert.ok(!owners.has(directory));
    owners.set(directory, owner);
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([signal, identity.signal, enrollment.signal, coordinator.signal]),
      isCurrent: () => {
        try {
          getPrivacyContext(parent);
          assert.deepEqual(assertRailgunIdentity(identity, parent), descriptor);
          assert.deepEqual(
            getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
            publicIdentity
          );
          return true;
        } catch {
          return false;
        }
      },
    });
    const close = () => {
      try {
        scope.close();
      } catch {
        /* Never throw from a timer. */
      }
    };
    timer = setTimeout(close, timeoutMs);
    timer.unref?.();
    const current = (margin = 0) => {
      const now = performance.now();
      assert.ok(!scope.signal.aborted && owners.get(directory) === owner);
      assert.ok(now >= started && now + margin < deadline);
      getPrivacyContext(parent);
      assert.deepEqual(assertRailgunIdentity(identity, parent), descriptor);
      assert.deepEqual(enrollment.descriptor, descriptor);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
        publicIdentity
      );
    };
    const remaining = (cap, reserve = 0) => {
      current(reserve);
      const left = Math.min(cap, Math.floor(deadline - performance.now()) - reserve);
      assert.ok(left > 0);
      return left;
    };
    stage = 'preflight';
    const historical = await captureRailgunOwnTransactPoiMembershipInput({
      enrollment,
      coordinator,
      archive,
      selector,
      signal: scope.signal,
      timeoutMs: remaining(TOTAL_MS, TAIL_MS),
    });
    if (historical.status !== 'captured')
      return Object.freeze({
        status: 'refused',
        stage: 'preflight:' + historical.stage,
        ...(historical.sourceOutcome ? { sourceOutcome: historical.sourceOutcome } : {}),
      });
    current();
    assert.deepEqual(historical.publicIdentity, publicIdentity);
    assert.equal(historical.publicPolicy, policy);
    assert.equal(historical.creatorClassification.type, 'Transact');
    assert.equal(historical.creatorClassification.legacy, false);
    assert.ok(historical.creatorClassification.blockNumber >= POI_LAUNCH_BLOCK);
    assert.equal(historical.observations.archiveAnchorChecked, true);
    assert.equal(historical.creatorProvenance.note.type, 'Transact');
    const creator = historical.poiPreparation.creator;
    for (const key of ['type', 'tree', 'position', 'hash'])
      assert.equal(creator[key], historical.creatorProvenance.note[key]);
    assert.deepEqual(historical.poiPreparation.ownEvidence.capsule, historical.capture.capsule);
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
          assertRailgunOwnPoiCapture(await window.reattest(), historical.capture);
          windowCurrent();
        };
        assertRailgunOwnPoiCapture(window.capture, historical.capture);
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
        const close = () => {
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
          close();
        };
        jobSignal.addEventListener('abort', close, { once: true });
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
              const bytes = await withRailgunViewingCredential(identity, async ({ viewingKey }) => {
                // Authenticated recovery reads are required here; no unrelated
                // intent-store access or nested phase acquisition is permitted.
                await attest();
                jobCurrent(RESERVE_MS);
                assert.ok(viewingKey instanceof Uint8Array && viewingKey.byteLength === 32);
                keyCopy = Buffer.alloc(32);
                keyCopy.set(viewingKey);
                return keyCopy;
              });
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
            throw fail();
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
          if (stopped) close();
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
          jobSignal.removeEventListener('abort', close);
          close();
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
      throw fail();
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
    assertRailgunOwnPoiCapture(latest.capture, historical.capture);
    return Object.freeze({
      status: 'derived',
      selector: derived,
      historical,
      receiverMatched: true,
      utilityExitObserved: true,
    });
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    clearTimeout(timer);
    try {
      scope?.close();
    } finally {
      if (owners.get(directory) === owner) owners.delete(directory);
    }
  }
}
exports.deriveRailgunOwnTransactPoiSelector = async (options) => {
  try {
    const result = await derive(options);
    if (result.status !== 'derived')
      return Object.freeze({ status: 'refused', stage: result.stage });
    return Object.freeze({
      status: 'derived',
      selectorDerived: true,
      receiverMatched: true,
      utilityExitObserved: true,
      ...AUTHORITY,
    });
  } catch {
    return Object.freeze({ status: 'refused', stage: 'cleanup' });
  }
};
