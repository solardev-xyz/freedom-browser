/** Fixed result-only quote job owner. The returned promise retains original
 * readiness, broker work and child closure; no cryptographic callback injection. */
const assert = require('assert/strict');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const {
  shape,
  digest,
  normalizeRailgunRelayQuote,
  assertQuoteCurrent,
  normalizeQuoteVerification,
} = require('./railgun-relay-quote-data');
const busy = new WeakSet();
const fail = (drain = false) =>
  Object.assign(new Error('Railgun relay quote unavailable'), {
    code: drain ? 'RAILGUN_RELAY_QUOTE_DRAIN_FAILED' : 'RAILGUN_RELAY_QUOTE_REFUSED',
  });
async function verifyRailgunRelayQuote({ enrollment, archive, quote, gas, signal }) {
  let task, timer, lifetime, close, exited, result;
  let observed = false,
    closeRequested = false,
    failed = false,
    owned = false;
  const pending = new Set();
  try {
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    const binding = normalizeRailgunRelayQuote(quote, gas);
    const input = JSON.stringify({
      archive: verifyRailgunEngineRuntime(archive),
      quote: binding.quote,
      gas: binding.gas,
    });
    assert.ok(Buffer.byteLength(input) <= 24000);
    const handle = enrollment.getContext('engine', 'relay-quote-review');
    assert.ok(!busy.has(enrollment));
    busy.add(enrollment);
    owned = true;
    const controller = new AbortController();
    lifetime = AbortSignal.any([signal, enrollment.signal]);
    const start = performance.now(),
      deadline = start + 15000;
    let wall = Date.now(),
      stopped = false;
    const active = () => {
      const now = performance.now(),
        date = Date.now();
      assert.ok(!failed && !stopped && !lifetime.aborted && now >= start && now < deadline);
      assertQuoteCurrent(binding, date, wall);
      wall = date;
      enrollment.getContext('engine', 'relay-quote-review');
      const after = performance.now(),
        afterWall = Date.now();
      assert.ok(!failed && !stopped && !lifetime.aborted && after >= start && after < deadline);
      assertQuoteCurrent(binding, afterWall, wall);
      wall = afterWall;
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
    close = () => {
      stopped = true;
      controller.abort();
      closeTask();
    };
    lifetime.addEventListener('abort', close, { once: true });
    timer = setTimeout(close, 15000);
    timer.unref?.();
    active();
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-relay-quote-job'),
      input,
      binaryKey: false,
      startupMs: 15000,
      lifetimeMs: 15000,
      broker: {
        signal: controller.signal,
        dispatch(wire) {
          const work = (async () => {
            try {
              active();
              assert.equal(result, undefined);
              assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16000);
              const message = JSON.parse(wire);
              shape(message, ['id', 'method', 'value']);
              assert.equal(message.id, 1);
              assert.equal(message.method, 'result');
              result = normalizeQuoteVerification(message.value, binding, digest(input));
              return JSON.stringify({ id: 1, value: null });
            } catch {
              failed = true;
              close();
              throw fail();
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
    // Observe the actual original barrier immediately, including early failure.
    exited = Promise.prototype.then.call(task.closed, (value) => {
      assert.ok(value && typeof value.code === 'string' && Number.isInteger(value.exitCode));
      observed = true;
      return value;
    });
    exited.catch(() => {});
    await task.ready;
    active();
    assert.ok(result);
    closeTask();
    const exit = await exited;
    assert.equal(exit.code, 'RAILGUN_PROCESS_CLOSED');
    assert.equal(exit.exitCode, 15);
    assert.equal(exit.escalated, false);
    assert.equal(exit.peerDisconnected, false);
    active();
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
    lifetime?.removeEventListener('abort', close);
    close?.();
    if (task) {
      try {
        await exited;
      } catch {
        failed = true;
      }
    }
    while (pending.size) await Promise.allSettled([...pending]);
    // Never admit another job over an unobserved process owner.
    if (owned && (!task || observed)) busy.delete(enrollment);
  }
  if (task && !observed) throw fail(true);
  if (failed) throw fail();
  return result;
}
module.exports = { verifyRailgunRelayQuote };
