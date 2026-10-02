/** Qualification-only Electron transport. Source visits and storage grants stay
 * in main. A utility job receives bounded public chunks over its private port.
 */
const assert = require('assert/strict');
const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
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
function createJobs(handle, qualifiedThrough) {
  async function run(mode, input, visit, { dispatch, signal }) {
    const feed = createFeed(visit, signal);
    let task,
      result,
      phase,
      sequence = 0,
      storageSequence = 0,
      reading = false,
      eof = false;
    const broker = {
      signal,
      async dispatch(wire) {
        const message = JSON.parse(wire);
        assert.ok(message && message.id === ++sequence);
        if (message.method === 'sourceNext') {
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method']);
          assert.ok(!reading && !eof && !result);
          reading = true;
          try {
            const logs = await feed.next();
            eof = logs === null;
            return JSON.stringify({ id: message.id, value: logs });
          } finally {
            reading = false;
          }
        }
        if (message.method === 'jobPhase') {
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.ok(
            mode === 'apply' &&
              ['commitments', 'nullifiers', 'unshields', 'engine-cursor'].includes(message.value)
          );
          phase = message.value;
          return JSON.stringify({ id: message.id, value: null });
        }
        if (message.method === 'jobResult') {
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.ok(eof && !result && message.value?.guards?.attempts === 0);
          result = message.value;
          return JSON.stringify({ id: message.id, value: null });
        }
        assert.ok(mode === 'apply' && eof && !result && typeof dispatch === 'function');
        const storageId = ++storageSequence;
        const reply = JSON.parse(await dispatch(JSON.stringify({ ...message, id: storageId })));
        assert.equal(reply.id, storageId);
        return JSON.stringify({ ...reply, id: message.id });
      },
    };
    try {
      task = startRailgunProcess({
        handle,
        broker,
        filename: require.resolve('./fixtures/railgun-coordinated-electron-job'),
        input: JSON.stringify({ mode, ...input, qualifiedThrough }),
        startupMs: 120000,
        lifetimeMs: 170000,
      });
      await task.ready;
      assert.ok(result);
      task.close();
      const closed = await task.closed;
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      await feed.done;
      return { ...result, closed };
    } catch (error) {
      task?.close();
      const closed = await task?.closed;
      throw Object.assign(error, {
        phase,
        closed,
        exitSignal: closed?.exitCode === 9 ? 'SIGKILL' : null,
      });
    } finally {
      task?.close();
      await task?.closed;
      feed.close();
      await feed.done.catch(() => {});
    }
  }
  return {
    async project({ range }, { visit, signal }) {
      return (await run('plan', { storeId: range.storeId }, visit, { signal })).state;
    },
    async apply(input, capability) {
      if (!input.plan.state.trees.length) return { skipped: 'no-utxo-yet' };
      const { logs, ...rest } = input;
      return run(
        'apply',
        rest,
        async (consume) => {
          for (const log of logs) await consume(log);
        },
        capability
      );
    },
  };
}
module.exports = { createJobs, createFeed };
