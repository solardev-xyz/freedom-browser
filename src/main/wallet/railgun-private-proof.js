/** Main-owned proof evidence from an independently exited keyless utility.
 * The receipt proves the exact public transaction only. It is never ownership,
 * POI, reservation, signing or submission authority on its own.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { matchRailgunPrivateProvedTransaction } = require('./railgun-private-intent');
const { normalizeRailgunPrivateVerification } = require('./railgun-private-results');
const { verifyRailgunProverRuntime } = require('./railgun-prover-runtime');
const { startRailgunProcess } = require('./railgun-process');
const receipts = new WeakMap(),
  busy = new WeakSet();
const fail = () =>
  Object.assign(new Error('Railgun private proof unavailable'), {
    code: 'RAILGUN_PRIVATE_PROOF_REFUSED',
  });
async function verify({
  enrollment,
  proverArchive,
  artifactDirectory,
  intent,
  transaction,
  expected,
  signal,
  timeoutMs = 60000,
}) {
  assert.ok(isRailgunAccountEnrollment(enrollment) && !enrollment.signal.aborted);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000);
  assert.ok(require('path').isAbsolute(artifactDirectory));
  const before = Object.freeze({ ...intent }),
    after = Object.freeze({ ...transaction }),
    wanted = Object.freeze({ ...expected });
  const checked = matchRailgunPrivateProvedTransaction(before, after, wanted);
  proverArchive = verifyRailgunProverRuntime(proverArchive);
  const parent = enrollment.getContext('prover', 'private-verify'),
    context = getPrivacyContext(parent);
  assert.ok(!busy.has(enrollment));
  const started = performance.now();
  let deadline = started + timeoutMs;
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([enrollment.signal, signal]),
    isCurrent: () => {
      getPrivacyContext(parent);
      return true;
    },
  });
  busy.add(enrollment);
  let task,
    result,
    closed = false,
    timer;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    scope.close();
    task?.close();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  const active = () => {
    if (
      closed ||
      scope.signal.aborted ||
      performance.now() < started ||
      performance.now() >= deadline
    )
      throw fail();
    getPrivacyContext(parent);
  };
  timer = setTimeout(close, timeoutMs);
  timer.unref?.();
  try {
    active();
    task = startRailgunProcess({
      handle: scope.getContext(context.subject),
      filename: require.resolve('./railgun-private-verify-job'),
      input: JSON.stringify({
        archive: proverArchive,
        artifactDirectory,
        intent: before,
        transaction: after,
        expected: wanted,
      }),
      startupMs: Math.min(30000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: scope.signal,
        async dispatch(wire) {
          active();
          assert.equal(result, undefined);
          assert.equal(typeof wire, 'string');
          assert.ok(Buffer.byteLength(wire) <= 16384);
          const message = JSON.parse(wire);
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          result = normalizeRailgunPrivateVerification(message.value, {
            intent: before,
            transaction: after,
            expected: wanted,
          });
          return JSON.stringify({ id: 1, value: null });
        },
      },
    });
    await task.ready;
    active();
    assert.ok(result);
    task.close();
    const exited = await task.closed;
    assert.equal(exited.code, 'RAILGUN_PROCESS_CLOSED');
    active();
    // The proof is static evidence, not a chain/POI freshness claim. Give its
    // consumer a separate bounded lifetime after the verifier has exited.
    clearTimeout(timer);
    deadline = performance.now() + 60000;
    timer = setTimeout(close, 60000);
    timer.unref?.();
    const receipt = Object.freeze({});
    const observation = Object.freeze({
      transactionDigest: checked.digest,
      verified: true,
      utilityExitObserved: true,
    });
    receipts.set(receipt, {
      enrollment,
      active,
      observation,
      intent: before,
      transaction: after,
      expected: wanted,
    });
    return Object.freeze({ receipt, observation, close, signal: scope.signal, process: exited });
  } catch {
    close();
    throw fail();
  } finally {
    task?.close();
    if (task) await task.closed;
    busy.delete(enrollment);
  }
}
async function verifyRailgunPrivateProof(options) {
  try {
    return await verify(options);
  } catch {
    throw fail();
  }
}
function assertRailgunPrivateProof(receipt, enrollment, { intent, transaction, expected }) {
  const value = receipts.get(receipt);
  if (!value || value.enrollment !== enrollment || !isRailgunAccountEnrollment(enrollment))
    throw fail();
  value.active();
  assert.deepEqual(intent, value.intent);
  assert.deepEqual(transaction, value.transaction);
  assert.deepEqual(expected, value.expected);
  return value.observation;
}
module.exports = { verifyRailgunPrivateProof, assertRailgunPrivateProof };
