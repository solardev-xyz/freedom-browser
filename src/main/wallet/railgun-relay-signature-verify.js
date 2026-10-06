/** Fixed keyless signature verifier. The connected controller must first observe
 * the original signer closure and authenticate its durable signing record. This
 * result verifies a signature, never custody, review or a new signing permission. */
const assert = require('assert/strict');
const { types } = require('util');
const { createHash } = require('crypto');
const { assertRailgunFencedAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const { shape, EXPECTED_GUARDS } = require('./railgun-relay-quote-data');
const busy = new WeakSet();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refusal = (unobserved = false) =>
  Object.assign(new Error('Railgun relay signature verification refused'), {
    code: unobserved
      ? 'RAILGUN_WALLET_EXIT_UNOBSERVED'
      : 'RAILGUN_RELAY_SIGNATURE_VERIFICATION_REFUSED',
  });
function captureSignature(value) {
  shape(value, ['R8', 'S']);
  const points = value.R8;
  assert.ok(!types.isProxy(points) && Array.isArray(points));
  assert.equal(Object.getPrototypeOf(points), Array.prototype);
  assert.deepEqual(Reflect.ownKeys(points), ['0', '1', 'length']);
  const copied = [0, 1].map((index) => {
    const entry = Object.getOwnPropertyDescriptor(points, String(index));
    assert.ok(entry?.enumerable && Object.hasOwn(entry, 'value'));
    return entry.value;
  });
  return normalizeRailgunSignature({ R8: copied, S: value.S });
}
async function verifyRailgunRelaySignature(options) {
  let task, lifetime, timer, stop, readyWork, exitWork, result, owner, current;
  let owned = false,
    launched = false,
    observed = false,
    unobservable = false,
    failed = false,
    closeRequested = false;
  const pending = new Set();
  try {
    shape(options, [
      'enrollment',
      'identity',
      'archive',
      'intent',
      'recordDigest',
      'signature',
      'signal',
      'timeoutMs',
    ]);
    const { enrollment, identity, signal, timeoutMs } = options;
    assertRailgunRelaySignal(signal);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
    const started = performance.now(),
      deadline = started + timeoutMs;
    let last = started;
    assertRailgunFencedAccountEnrollment(enrollment);
    assert.ok(!busy.has(enrollment));
    busy.add(enrollment);
    owner = enrollment;
    owned = true;
    const handle = enrollment.getContext('prover', 'relay-signature-verify');
    const descriptor = assertRailgunIdentity(identity, handle);
    const intent = normalizeRailgunRelayUnsignedIntent(options.intent);
    assert.equal(intent.data.context.walletId, descriptor.walletId);
    assert.equal(intent.data.context.self.address, descriptor.instanceId);
    assert.equal(
      intent.data.context.self.masterPublicKey,
      BigInt('0x' + descriptor.masterPublicKey).toString()
    );
    assert.equal(intent.data.context.self.viewingPublicKey, descriptor.viewingPublicKey);
    assert.match(options.recordDigest, /^[0-9a-f]{64}$/);
    const signature = captureSignature(options.signature);
    const expected = Object.freeze({
      recordDigest: options.recordDigest,
      intentDigest: intent.digest,
      message: intent.data.expectedHash,
      signatureDigest: digest(signature),
      signatureVerified: true,
    });
    const captured = JSON.stringify(descriptor);
    assertRailgunRelaySignal(enrollment.signal);
    assertRailgunRelaySignal(identity.signal);
    lifetime = AbortSignal.any([signal, enrollment.signal, identity.signal]);
    const controller = new AbortController();
    let stopped = false;
    const timeCurrent = () => {
      const now = performance.now();
      assert.ok(!failed && !lifetime.aborted && now >= last && now < deadline);
      last = now;
    };
    current = () => {
      timeCurrent();
      assertRailgunFencedAccountEnrollment(enrollment);
      assert.equal(enrollment.getContext('prover', 'relay-signature-verify'), handle);
      assert.equal(JSON.stringify(assertRailgunIdentity(identity, handle)), captured);
      // Owner assertions may synchronously revoke a scope or consume the budget.
      timeCurrent();
    };
    const active = () => {
      assert.equal(stopped, false);
      current();
      assert.equal(stopped, false);
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
    stop = () => {
      stopped = true;
      controller.abort();
      closeTask();
    };
    lifetime.addEventListener('abort', stop, { once: true });
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0);
    timer = setTimeout(stop, remaining);
    timer.unref?.();
    active();
    const input = JSON.stringify({
      archive: verifyRailgunEngineRuntime(options.archive),
      intent: intent.data,
      recordDigest: expected.recordDigest,
      signature,
      spendingPublicKey: descriptor.spendingPublicKey.map((value) => '0x' + value),
    });
    assert.ok(Buffer.byteLength(input) <= 65536);
    active();
    // Ready is emitted after the job has run, so startup is the execution bound.
    const executionMs = Math.min(timeoutMs, Math.floor(deadline - performance.now()));
    assert.ok(executionMs > 0);
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-relay-signature-verify-job'),
      input,
      binaryKey: false,
      startupMs: executionMs,
      lifetimeMs: executionMs,
      broker: {
        signal: controller.signal,
        dispatch(wire) {
          const work = (async () => {
            try {
              active();
              assert.equal(pending.size, 0);
              assert.equal(result, undefined);
              assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16000);
              const message = JSON.parse(wire);
              shape(message, ['id', 'method', 'value']);
              assert.equal(message.id, 1);
              assert.equal(message.method, 'result');
              const value = message.value;
              shape(value, [...Object.keys(expected), 'guards', 'inventory']);
              for (const [key, item] of Object.entries(expected)) assert.equal(value[key], item);
              assert.equal(
                value.inventory,
                require('./railgun-engine-manifest.json').inventory.sha256
              );
              assert.deepEqual(value.guards, EXPECTED_GUARDS);
              active();
              result = expected;
              return JSON.stringify({ id: 1, value: null });
            } catch {
              failed = true;
              stop();
              throw refusal();
            }
          })();
          pending.add(work);
          work.then(
            () => pending.delete(work),
            () => pending.delete(work)
          );
          return work;
        },
      },
    });
    launched = true;
    // Own the observation envelopes. Intrinsic then still consults the original
    // promise's species; its returned object is never a readiness/drain barrier.
    const observe = (original, project) => {
      const work = new Promise((resolve, reject) => {
        try {
          Promise.prototype.then.call(
            original,
            (value) => {
              try {
                resolve(project(value));
              } catch (error) {
                reject(error);
              }
            },
            reject
          );
        } catch (error) {
          unobservable = true;
          failed = true;
          reject(error);
        }
      });
      work.catch(() => {});
      return work;
    };
    // Register independently so a malformed sibling cannot abandon an original.
    readyWork = observe(task.ready, () => undefined);
    exitWork = observe(task.closed, (value) => {
      assert.ok(value && typeof value.code === 'string' && Number.isInteger(value.exitCode));
      observed = true;
      return value;
    });
    if (failed || stopped) stop();
    assert.ok(readyWork && exitWork);
    await readyWork;
    active();
    assert.ok(result && pending.size === 0);
    closeTask();
    const exit = await exitWork;
    assert.equal(exit.code, 'RAILGUN_PROCESS_CLOSED');
    assert.equal(exit.exitCode, 15);
    assert.equal(exit.escalated, false);
    assert.equal(exit.peerDisconnected, false);
    active();
  } catch {
    failed = true;
  } finally {
    // Close is only a request. Neither thrown close nor malformed one barrier
    // may skip an independently captured native barrier or original dispatches.
    stop?.();
    try {
      if (readyWork) await readyWork;
    } catch {
      failed = true;
    }
    try {
      if (exitWork) await exitWork;
    } catch {
      failed = true;
    }
    while (pending.size) await Promise.allSettled([...pending]);
    if (!failed) {
      try {
        current();
      } catch {
        failed = true;
      }
    }
    clearTimeout(timer);
    lifetime?.removeEventListener('abort', stop);
    if (owned && (!launched || (observed && !unobservable))) busy.delete(owner);
  }
  if (launched && (!observed || unobservable)) throw refusal(true);
  if (failed) throw refusal();
  return result;
}
module.exports = { verifyRailgunRelaySignature };
