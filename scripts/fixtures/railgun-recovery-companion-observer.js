/** Test-only observation of original promises and one actual exited verifier
 * result. No receipt, owner or controller result is replaced. */
const { assert } = require('./railgun-native-assertions');
const wallet = '../../src/main/wallet/';
function install({ hold = false } = {}) {
  const controllerPath = require.resolve(wallet + 'railgun-private-proof-recovery');
  const submissionPath = require.resolve(wallet + 'railgun-private-submission');
  assert.equal(require.cache[controllerPath], undefined);
  assert.equal(require.cache[submissionPath], undefined);
  assert.equal(require.cache[require.resolve(wallet + 'railgun-kohaku-recovery')], undefined);
  const proof = require(wallet + 'railgun-private-proof');
  const originalVerify = proof.verifyRailgunPrivateProof;
  const entries = [];
  let held = false,
    released = false,
    stopped = false,
    captured,
    wake,
    release;
  const reached = new Promise((resolve) => {
    wake = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  if (hold)
    proof.verifyRailgunPrivateProof = async function (...args) {
      const result = await Reflect.apply(originalVerify, this, args);
      if (hold && !held) {
        held = true;
        assert.equal(result.observation.utilityExitObserved, true);
        assert.equal(result.process.code, 'RAILGUN_PROCESS_CLOSED');
        assert.equal(args[0].signal.aborted, false);
        captured = { verifierSignal: args[0].signal, entered: performance.now() };
        wake();
        await gate;
      }
      return result;
    };
  let controller, submission;
  try {
    controller = require(controllerPath);
    submission = require(submissionPath);
  } catch (error) {
    proof.verifyRailgunPrivateProof = originalVerify;
    release();
    throw error;
  }
  const originals = [
    [controller, 'resumeRailgunAccountPrivateProof', 'proof'],
    [submission, 'submitRailgunRecoveredPrivateTransaction', 'submit'],
  ];
  for (const entry of originals) {
    const [module, name, kind] = entry;
    const original = module[name];
    entry.push(original);
    module[name] = function (...args) {
      const observed = {
        kind,
        admitted: performance.now(),
        settled: false,
        value: undefined,
        error: undefined,
      };
      entries.push(observed);
      const pending = Reflect.apply(original, this, args);
      observed.promise = pending;
      Promise.prototype.then.call(
        pending,
        (value) => {
          observed.value = value;
          observed.settled = true;
        },
        (error) => {
          observed.error = error;
          observed.settled = true;
        }
      );
      return pending;
    };
  }
  return Object.freeze({
    reached,
    entry: (index) => entries[index],
    pendingAtClose(signal, reservations, capsules) {
      assert.ok(captured);
      assert.equal(signal.aborted, true);
      assert.equal(captured.verifierSignal.aborted, true);
      assert.equal(reservations.signal.aborted, false);
      assert.equal(capsules.signal.aborted, false);
      assert.ok(performance.now() - captured.entered < 5000);
      // The final phase starts after admission and is limited to at most 175 s;
      // with total admission elapsed below 120 s its 175 s timer cannot have fired,
      // and the 360 s controller still has over 240 s. Pending callback excludes
      // finally-triggered phase abort. This is causal evidence, not direct
      // observation of the private phase context.
      assert.ok(performance.now() - entries[0].admitted < 120000);
      assert.equal(entries[0].settled, false);
      return {
        reservationScopeLiveAfterCompanionAbort: true,
        sourceDerivedCancellationCause: true,
        directPhaseSignalObserved: false,
        admissionToReleaseBelow120Seconds: true,
        holdBelow5Seconds: true,
        verifierSignalAborted: true,
      };
    },
    release() {
      if (!released) {
        released = true;
        release();
      }
    },
    report() {
      return {
        heldResults: held ? 1 : 0,
        originalCalls: entries.length,
        originalSettlements: entries.filter((v) => v.settled).length,
      };
    },
    close() {
      if (stopped) return;
      stopped = true;
      released = true;
      release();
      proof.verifyRailgunPrivateProof = originalVerify;
      for (const [module, name, , original] of originals) module[name] = original;
    },
  });
}
module.exports = { install };
