/** Main-owned recoverability check bound to a genuine preparation and enrolled
 * identity. The process supervisor must explicitly permit this viewing-key job.
 */
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
const { assertRailgunShieldPreparation } = require('./railgun-shield-prepare');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { getPrivacyContext } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const receipts = new WeakMap();
const busy = new WeakSet();
const fail = () =>
  Object.assign(new Error('Railgun shield receiver unavailable'), {
    code: 'RAILGUN_SHIELD_RECEIVER_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
async function verify({ identity, enrollment, preparation, archive, signal, timeoutMs = 180000 }) {
  check(signal === undefined || (signal instanceof AbortSignal && !signal.aborted));
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 180000);
  const started = performance.now(),
    deadline = started + timeoutMs;
  const prepared = assertRailgunShieldPreparation(preparation, identity, enrollment);
  const handle = enrollment.getContext('engine', 'shield-receive');
  getPrivacyContext(handle);
  const descriptor = assertRailgunIdentity(identity, handle);
  archive = verifyRailgunEngineRuntime(archive);
  check(!busy.has(preparation));
  const phase = claimRailgunAccountPhase(enrollment, 'recovery');
  busy.add(preparation);
  const lifetime = AbortSignal.any([
    identity.signal,
    enrollment.signal,
    ...(signal ? [signal] : []),
  ]);
  const controller = new AbortController();
  let task,
    result,
    sequence = 0,
    stopped = false,
    failed = false,
    accepting = true,
    closeRequested = false,
    exitObserved = false,
    keyDelivered = false,
    keyCopy;
  const pending = new Set();
  const active = () => {
    const now = performance.now();
    check(!stopped && !failed && !lifetime.aborted && now >= started && now < deadline);
    check(assertRailgunShieldPreparation(preparation, identity, enrollment) === prepared);
    getPrivacyContext(handle);
    assertRailgunIdentity(identity, handle);
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
    keyCopy?.fill(0);
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
  const dispatch = async (wire) => {
    try {
      active();
      check(accepting);
      check(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
      const message = JSON.parse(wire);
      check(message.id === ++sequence && !result);
      if (message.id === 1) {
        check(
          Object.keys(message).length === 3 &&
            message.method === 'key' &&
            message.purpose === 'shield-receive'
        );
        const output = await withRailgunViewingCredential(identity, ({ viewingKey }) => {
          active();
          check(!keyCopy && viewingKey instanceof Uint8Array && viewingKey.byteLength === 32);
          keyCopy = Buffer.alloc(32);
          keyCopy.set(viewingKey);
          return keyCopy;
        });
        active();
        check(output === keyCopy && keyCopy?.length === 32);
        keyDelivered = true;
        return output;
      }
      check(
        keyDelivered &&
          message.id === 2 &&
          message.method === 'result' &&
          Object.keys(message).length === 3
      );
      const value = message.value;
      check(
        value &&
          Object.keys(value).length === 7 &&
          value.verified === true &&
          value.inventory === inventory &&
          value.guards?.attempts === 0 &&
          ['commitment', 'noteValue', 'npk', 'recipient'].every((k) => value[k] === prepared[k])
      );
      result = true;
      return JSON.stringify({ id: message.id, value: null });
    } catch {
      refuse();
      throw fail();
    }
  };
  lifetime.addEventListener('abort', close, { once: true });
  const timer = setTimeout(close, timeoutMs);
  timer.unref?.();
  try {
    active();
    task = startRailgunProcess({
      handle,
      binaryKey: true,
      filename: require.resolve('./railgun-shield-receive-job'),
      input: JSON.stringify({ archive, descriptor, prepared }),
      startupMs: Math.min(120000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: controller.signal,
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
    if (stopped) closeTask();
    await task.ready;
    active();
    check(result);
    accepting = false;
    closeTask();
    check((await observeExit()).code === 'RAILGUN_PROCESS_CLOSED');
    active();
  } finally {
    clearTimeout(timer);
    lifetime.removeEventListener('abort', close);
    close();
    try {
      if (task) await observeExit();
    } finally {
      try {
        while (pending.size) await Promise.allSettled([...pending]);
      } finally {
        keyCopy?.fill(0);
        if (!task || exitObserved) {
          phase.release();
          busy.delete(preparation);
        }
      }
    }
  }
  const now = performance.now();
  check(!failed && !lifetime.aborted && now >= started && now < deadline);
  check(assertRailgunShieldPreparation(preparation, identity, enrollment) === prepared);
  assertRailgunIdentity(identity, handle);
  getPrivacyContext(handle);
  const receipt = Object.freeze({});
  receipts.set(receipt, { identity, enrollment, preparation, prepared, lifetime });
  return receipt;
}
async function verifyRailgunShieldReceiver(options) {
  try {
    return await verify(options);
  } catch {
    throw fail();
  }
}

function assertRailgunShieldReceiver(receipt, identity, enrollment, preparation) {
  const entry = receipts.get(receipt);
  check(
    entry &&
      entry.identity === identity &&
      entry.enrollment === enrollment &&
      entry.preparation === preparation &&
      !entry.lifetime.aborted
  );
  check(assertRailgunShieldPreparation(preparation, identity, enrollment) === entry.prepared);
  return entry.prepared;
}
module.exports = { verifyRailgunShieldReceiver, assertRailgunShieldReceiver };
