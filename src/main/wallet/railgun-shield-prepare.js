/** Enrolled, own-recipient native shield construction. This produces an opaque
 * short-lived preparation, not signing/submission authority. Deployment checks,
 * sender intent and durable transaction journaling must precede any broadcast.
 */
const { getPrivacyContext } = require('../networks/privacy-context');
const { assertRailgunIdentity } = require('./railgun-identity');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { shieldAmount, validateRailgunNativeShield } = require('./railgun-shield-policy');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const receipts = new WeakMap(),
  generations = new WeakMap(),
  busy = new WeakSet();
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_AGE_MS = 120000;
const fail = () =>
  Object.assign(new Error('Railgun shield preparation unavailable'), {
    code: 'RAILGUN_SHIELD_PREPARATION_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
function active(identity, enrollment) {
  check(isRailgunAccountEnrollment(enrollment) && !enrollment.signal.aborted);
  const handle = enrollment.getContext('engine', 'shield-prepare');
  getPrivacyContext(handle);
  const descriptor = assertRailgunIdentity(identity, handle);
  check(descriptor.walletId === enrollment.descriptor.walletId);
  return { handle, descriptor };
}
async function prepare({ identity, enrollment, archive, amount, signal, timeoutMs = 180000 }) {
  check(signal === undefined || (signal instanceof AbortSignal && !signal.aborted));
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 180000);
  const started = performance.now(),
    deadline = started + timeoutMs;
  const { handle, descriptor } = active(identity, enrollment);
  shieldAmount(amount);
  archive = verifyRailgunEngineRuntime(archive);
  check(!busy.has(enrollment));
  const phase = claimRailgunAccountPhase(enrollment, 'recovery');
  busy.add(enrollment);
  const generation = (generations.get(enrollment) ?? 0) + 1;
  generations.set(enrollment, generation);
  const lifetime = AbortSignal.any([
    identity.signal,
    enrollment.signal,
    ...(signal ? [signal] : []),
  ]);
  const controller = new AbortController();
  let task,
    sequence = 0,
    supplied = false,
    result,
    stopped = false,
    failed = false,
    accepting = true,
    closeRequested = false,
    exitObserved = false;
  const current = () => {
    const now = performance.now();
    check(!stopped && !failed && !lifetime.aborted && now >= started && now < deadline);
    active(identity, enrollment);
    phase.assertCurrent();
  };
  const closeTask = () => {
    if (!task || closeRequested) return;
    closeRequested = true;
    try {
      task.close();
    } catch {
      failed = true;
    }
  };
  const close = () => {
    stopped = true;
    accepting = false;
    controller.abort();
    closeTask();
  };
  const refuse = () => {
    failed = true;
    close();
  };
  const observeExit = async () => {
    const barrier = task.closed;
    check(barrier && typeof barrier.then === 'function');
    const exited = await barrier;
    exitObserved = true;
    return exited;
  };
  lifetime.addEventListener('abort', close, { once: true });
  const timer = setTimeout(close, timeoutMs);
  timer.unref?.();
  try {
    current();
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-shield-job'),
      input: JSON.stringify({ archive }),
      startupMs: Math.min(120000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: controller.signal,
        async dispatch(wire) {
          try {
            current();
            check(accepting);
            check(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
            const message = JSON.parse(wire);
            check(message.id === ++sequence && !result);
            if (message.method === 'input') {
              check(!supplied && Object.keys(message).length === 2);
              supplied = true;
              return JSON.stringify({
                id: message.id,
                value: { recipient: descriptor.instanceId, amount },
              });
            }
            check(supplied && message.method === 'result' && Object.keys(message).length === 3);
            const value = message.value;
            check(
              value &&
                Object.keys(value).length === 6 &&
                value.inventory === inventory &&
                value.guards?.attempts === 0 &&
                typeof value.commitment === 'string' &&
                /^0x[0-9a-f]{64}$/.test(value.commitment) &&
                BigInt(value.commitment) > 0n &&
                BigInt(value.commitment) < FIELD
            );
            const validated = validateRailgunNativeShield(value.transaction, {
              amount,
              npk: value.npk,
            });
            check(validated.noteValue === value.noteValue);
            result = Object.freeze({
              ...validated,
              commitment: value.commitment,
              recipient: descriptor.instanceId,
              deploymentVerified: false,
              signingEnabled: false,
            });
            return JSON.stringify({ id: message.id, value: null });
          } catch {
            refuse();
            throw fail();
          }
        },
      },
    });
    if (stopped) closeTask();
    await task.ready;
    current();
    check(result);
    accepting = false;
    closeTask();
    check((await observeExit()).code === 'RAILGUN_PROCESS_CLOSED');
    current();
  } finally {
    clearTimeout(timer);
    lifetime.removeEventListener('abort', close);
    close();
    try {
      if (task) await observeExit();
    } finally {
      // A rejected barrier cannot establish physical exit. Retain the owner.
      if (!task || exitObserved) {
        phase.release();
        busy.delete(enrollment);
      }
    }
  }
  const now = performance.now();
  check(!failed && !lifetime.aborted && now >= started && now < deadline);
  active(identity, enrollment);
  const receipt = Object.freeze({});
  receipts.set(receipt, { identity, enrollment, generation, created: now, result, lifetime });
  return Object.freeze({ receipt, prepared: result });
}
async function prepareRailgunNativeShield(options) {
  try {
    return await prepare(options);
  } catch {
    throw fail();
  }
}

function assertRailgunShieldPreparation(receipt, identity, enrollment) {
  active(identity, enrollment);
  const entry = receipts.get(receipt),
    now = performance.now();
  check(
    entry &&
      entry.identity === identity &&
      entry.enrollment === enrollment &&
      entry.generation === generations.get(enrollment) &&
      !entry.lifetime.aborted &&
      !busy.has(enrollment) &&
      now >= entry.created &&
      now - entry.created < MAX_AGE_MS
  );
  return entry.result;
}
module.exports = { prepareRailgunNativeShield, assertRailgunShieldPreparation, MAX_AGE_MS };
