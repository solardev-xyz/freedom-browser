/** Main-owned independent cryptographic receive check. Returns data about the
 * exact intent, never a selection, reservation or spending capability. The
 * controller retains its existing A phase until this host and borrowed work drain.
 */
const assert = require('assert/strict');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const {
  assertRailgunIdentity,
  withRailgunViewingCredential,
  quarantineRailgunIdentityCredentials,
} = require('./railgun-identity');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const { normalizeRailgunPrivateReceiver } = require('./railgun-private-results');
const { startRailgunProcess } = require('./railgun-process');
const pins = require('./railgun-shield-pins.json');
const busy = new WeakSet();
const fail = () =>
  Object.assign(new Error('Railgun private receiver unavailable'), {
    code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED',
  });
async function verify(options) {
  const { identity, enrollment, transaction, expected, recipient, signal } = options;
  assert.ok(isRailgunAccountEnrollment(enrollment));
  assert.ok(signal === undefined || signal instanceof AbortSignal);
  const handle = enrollment.getContext('engine', 'private-receive');
  const descriptor = assertRailgunIdentity(identity, handle);
  assert.equal(enrollment.descriptor.walletId, descriptor.walletId);
  assert.equal(recipient, descriptor.instanceId);
  const intent = Object.freeze({ ...transaction }),
    wanted = Object.freeze({ ...expected });
  const checked = validateRailgunPrivateSigningIntent(intent, wanted);
  const partial = checked.kind === 'railgun-partial-unshield';
  assert.ok(partial || checked.kind === 'railgun-private-transfer');
  if (partial) {
    assert.ok(!Object.hasOwn(options, 'amount') && !Object.hasOwn(options, 'changeAmount'));
    assert.ok(!Object.hasOwn(options, 'unshieldAmount'));
  } else assert.ok(!Object.hasOwn(options, 'inputAmount'));
  const amount = partial ? options.inputAmount : options.amount;
  assert.match(amount, /^[1-9][0-9]{0,16}$/);
  assert.ok(BigInt(amount) <= BigInt(pins.maxQualificationAmount));
  if (partial)
    assert.ok(
      BigInt(checked.unshieldAmount) > 0n && BigInt(checked.unshieldAmount) < BigInt(amount)
    );
  const amounts = partial ? { inputAmount: amount } : { amount };
  const archive = verifyRailgunEngineRuntime(options.archive);
  assert.ok(!busy.has(identity));
  busy.add(identity);
  const started = performance.now(),
    deadline = started + 60000;
  const lifetime = AbortSignal.any([
    identity.signal,
    enrollment.signal,
    ...(signal ? [signal] : []),
  ]);
  const controller = new AbortController(),
    pending = new Set();
  let task,
    result,
    keyCopy,
    sequence = 0,
    stopped = false,
    failed = false,
    accepting = true,
    keyDelivered = false,
    closeRequested = false,
    exitObserved = false,
    quarantined = false;
  const current = () => {
    const now = performance.now();
    assert.ok(!failed && !lifetime.aborted && now >= started && now < deadline);
    assert.deepEqual(assertRailgunIdentity(identity, handle), descriptor);
    assert.equal(enrollment.descriptor.walletId, descriptor.walletId);
    enrollment.getContext('engine', 'private-receive');
  };
  const active = () => {
    current();
    assert.ok(!stopped);
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
    try {
      const barrier = task.closed;
      assert.ok(barrier && typeof barrier.then === 'function');
      const value = await barrier;
      assert.ok(value && typeof value.code === 'string');
      exitObserved = true;
      return value;
    } catch (error) {
      // Revoke every sibling/loan immediately. A borrowed callback may ignore
      // cancellation forever; cleanup must still wait for it below.
      if (!exitObserved && !quarantined) {
        quarantined = true;
        quarantineRailgunIdentityCredentials(identity);
      }
      throw error;
    }
  };
  const dispatch = async (wire) => {
    try {
      active();
      assert.ok(accepting);
      assert.equal(typeof wire, 'string');
      assert.ok(Buffer.byteLength(wire) <= 16384);
      const message = JSON.parse(wire);
      assert.equal(message.id, ++sequence);
      assert.equal(result, undefined);
      if (message.id === 1) {
        assert.deepEqual(message, { id: 1, method: 'key', purpose: 'private-receive' });
        const output = await withRailgunViewingCredential(identity, ({ viewingKey }) => {
          active();
          assert.ok(!keyCopy && viewingKey instanceof Uint8Array && viewingKey.byteLength === 32);
          keyCopy = Buffer.alloc(32);
          keyCopy.set(viewingKey);
          return keyCopy;
        });
        active();
        assert.ok(output === keyCopy && keyCopy?.length === 32);
        keyDelivered = true;
        return output;
      }
      assert.ok(keyDelivered);
      assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
      assert.equal(message.id, 2);
      assert.equal(message.method, 'result');
      result = normalizeRailgunPrivateReceiver(message.value, {
        transaction: intent,
        expected: wanted,
        recipient,
        ...amounts,
      });
      return JSON.stringify({ id: 2, value: null });
    } catch {
      refuse();
      throw fail();
    }
  };
  lifetime.addEventListener('abort', close, { once: true });
  const timer = setTimeout(close, 60000);
  timer.unref?.();
  try {
    active();
    task = startRailgunProcess({
      handle,
      binaryKey: true,
      filename: require.resolve('./railgun-private-receive-job'),
      startupMs: 30000,
      lifetimeMs: 60000,
      input: JSON.stringify({
        archive,
        descriptor,
        transaction: intent,
        expected: wanted,
        recipient,
        ...amounts,
      }),
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
    assert.ok(result);
    accepting = false;
    closeTask();
    assert.equal((await observeExit()).code, 'RAILGUN_PROCESS_CLOSED');
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
        // A rejected child barrier is not evidence of exit; keep this identity
        // unavailable rather than admitting another child over an unknown one.
        if (!task || exitObserved) busy.delete(identity);
      }
    }
  }
  current();
  return result;
}
async function verifyRailgunPrivateReceiver(options) {
  try {
    return await verify(options);
  } catch {
    throw fail();
  }
}
module.exports = { verifyRailgunPrivateReceiver };
