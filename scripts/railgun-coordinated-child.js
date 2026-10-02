/** Bounded Node qualification transport. Production Electron integration is separate. */
const { fork } = require('child_process');
const path = require('path');
const assert = require('assert/strict');
function startChild(mode, input, { dispatch, signal } = {}) {
  const child = fork(path.join(__dirname, 'fixtures/railgun-coordinated-job.js'), [], {
    env: {},
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--max-old-space-size=256'],
  });
  let result,
    failure,
    phase,
    stopped = false,
    timer,
    killTimer,
    resolveReady,
    rejectReady,
    resolveDone,
    rejectDone,
    ack,
    sequence = 0,
    diagnostic = '';
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});
  function stop() {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
  }
  function abort() {
    failure = 'Cancelled';
    stop();
  }
  child.on('error', (error) => {
    failure = error.message;
    stop();
  });
  child.stderr.on('data', (bytes) => {
    diagnostic = (diagnostic + bytes).slice(-2000);
  });
  child.on('message', (message) => {
    if (stopped) return;
    try {
      assert.ok(message && Buffer.byteLength(JSON.stringify(message)) <= 2 * 1024 * 1024);
      if (message.type === 'ready') {
        assert.equal(mode, 'plan');
        resolveReady();
        return;
      }
      if (message.type === 'ack') {
        assert.ok(ack && message.sequence === sequence);
        const current = ack;
        ack = null;
        current.resolve();
        return;
      }
      if (message.type === 'progress') {
        phase = message.phase;
        return;
      }
      if (message.type === 'failure') {
        failure = message.message;
        stop();
        return;
      }
      if (message.type === 'result') {
        assert.equal(result, undefined);
        result = message.value;
        stop();
        return;
      }
      assert.ok(message.type === 'command' && mode === 'apply' && typeof dispatch === 'function');
      dispatch(message.wire).then(
        (wire) => {
          if (child.connected && !stopped) child.send({ type: 'reply', wire });
        },
        () => {
          failure = 'Dispatch refused';
          stop();
        }
      );
    } catch (error) {
      failure = error.message;
      stop();
    }
  });
  child.once('close', (code, exitSignal) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    const error = Object.assign(
      new Error(failure || diagnostic || 'Child stopped without result'),
      { code, exitSignal, phase }
    );
    if (result && !failure) {
      assert.equal(result.guards.attempts, 0);
      resolveDone(result);
    } else {
      rejectReady(error);
      ack?.reject(error);
      rejectDone(error);
    }
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else child.send({ type: 'init', mode, input });
  timer = setTimeout(() => {
    failure = 'Child deadline';
    stop();
  }, 170000);
  return {
    ready,
    done,
    stop,
    async logs(logs) {
      await ready;
      assert.ok(!ack && !stopped);
      const waiting = new Promise((resolve, reject) => {
        ack = { resolve, reject };
      });
      child.send({ type: 'logs', sequence: ++sequence, logs });
      return waiting;
    },
    finish(storeId) {
      assert.ok(!ack && !stopped);
      child.send({ type: 'finish', storeId });
      return done;
    },
  };
}
async function project({ range }, { visit, signal }) {
  const child = startChild('plan', {}, { signal });
  try {
    await child.ready;
    let batch = [],
      size = 0;
    const flush = async () => {
      if (batch.length) {
        await child.logs(batch);
        batch = [];
        size = 0;
      }
    };
    await visit(async (log) => {
      const bytes = Buffer.byteLength(JSON.stringify(log));
      if (batch.length && (batch.length >= 128 || size + bytes > 1024 * 1024)) await flush();
      batch.push(log);
      size += bytes;
    });
    await flush();
    const result = await child.finish(range.storeId);
    return result.state;
  } finally {
    child.stop();
    await child.done.catch(() => {});
  }
}
async function apply(input, { dispatch, signal }) {
  if (!input.plan.state.trees.length) return { skipped: 'no-utxo-yet' };
  const child = startChild('apply', input, { dispatch, signal });
  try {
    return await child.done;
  } finally {
    child.stop();
    await child.done.catch(() => {});
  }
}
module.exports = { project, apply };
