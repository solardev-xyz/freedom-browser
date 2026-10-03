/** Bounded source-log backpressure shared by guarded public and TXID jobs. */
const assert = require('assert/strict');
function createFeed(visit, signal) {
  let slot,
    waiting,
    producerDone = false,
    failure,
    closed = false;
  const reject = (error) => {
    failure ||= error;
    slot?.reject(error);
    waiting?.reject(error);
    slot = waiting = null;
  };
  const abort = () => reject(new Error('Source feed cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const publish = (logs) =>
    new Promise((resolve, fail) => {
      if (failure || closed || signal.aborted)
        return fail(failure || new Error('Source feed closed'));
      assert.ok(!slot);
      slot = { logs, resolve, reject: fail };
      if (waiting) {
        const reader = waiting;
        waiting = null;
        reader.resolve(take());
      }
    });
  function take() {
    const current = slot;
    slot = null;
    current.resolve();
    return current.logs;
  }
  const done = (async () => {
    let batch = [],
      size = 0;
    await visit(async (log) => {
      assert.ok(!closed && !signal.aborted && !failure);
      const bytes = Buffer.byteLength(JSON.stringify(log));
      assert.ok(bytes <= 1024 * 1024);
      if (batch.length && (batch.length >= 128 || size + bytes > 1024 * 1024)) {
        await publish(batch);
        batch = [];
        size = 0;
      }
      batch.push(log);
      size += bytes;
    });
    if (batch.length) await publish(batch);
    producerDone = true;
    waiting?.resolve(null);
    waiting = null;
  })().catch((error) => {
    reject(error);
    throw error;
  });
  done.catch(() => {});
  return {
    done,
    next() {
      if (failure || closed || signal.aborted)
        return Promise.reject(failure || new Error('Source feed closed'));
      assert.ok(!waiting);
      if (slot) return Promise.resolve(take());
      if (producerDone) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    close() {
      closed = true;
      signal.removeEventListener('abort', abort);
      reject(new Error('Source feed closed'));
    },
  };
}
module.exports = { createFeed };
