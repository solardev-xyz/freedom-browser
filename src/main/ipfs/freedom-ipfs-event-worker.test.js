// The dispatcher worker's shutdown contract, driven through a *real*
// worker_threads Worker rather than the mock the native-node suite uses.
//
// What this pins: after a `stop`, the worker acknowledges and then exits *by
// itself*. A mock worker cannot show that — whether `parentPort.close()`
// actually lets the event loop drain is a worker_threads property, and if it
// does not, the parent falls back to `terminate()`, which is the call issue
// #345 named as landing inside `gatewayWaitNextEvent` and aborting the process
// with `Error::ThrowAsJavaScriptException napi_throw`. (The abort's actual
// trigger turned out to be the quit sequence tearing the process down
// underneath the worker — see the before-quit handler in src/main/index.js —
// but the terminate window is real, and it also cost every quit a 2s stall.)
//
// The native binding is stubbed by patching `Module._load` inside the worker
// before the real worker file is required, so the addon does not have to be
// built for this to run. The stub blocks on `Atomics.wait` for the same
// timeout the real `gatewayWaitNextEvent` would, so a `stop` arriving while a
// "native call" is in flight is a real race here, not a simulated one.

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'freedom-ipfs-event-worker.js');

// Runs in the worker thread. `calls` counts native invocations, `lock` is what
// the fake native call parks on, and `mode` picks the stub's behaviour.
const BOOTSTRAP = `
const Module = require('module');
const { workerData } = require('worker_threads');
const calls = new Int32Array(workerData.calls);
const lock = new Int32Array(workerData.lock);
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === './freedom-ipfs-native-binding') {
    return {
      loadNativeBinding: () => ({
        gatewayWaitNextEvent: (_handle, timeoutMs) => {
          Atomics.add(calls, 0, 1);
          if (workerData.mode === 'throw') throw new Error('gateway handle is gone');
          // Block the thread for the poll slice, exactly as the native call does.
          Atomics.wait(lock, 0, 0, timeoutMs);
          return { status: workerData.eventStatus, events: 0, requestHandle: 7n };
        },
      }),
    };
  }
  return load.call(this, request, ...rest);
};
require(workerData.workerPath);
`;

const started = [];

afterEach(async () => {
  // Nothing should need this — the point of the fix is that these workers end
  // themselves — but a failing assertion must not leave a thread behind.
  await Promise.all(started.splice(0).map((worker) => worker.terminate().catch(() => {})));
});

function startWorker({ mode = 'timeout', timeoutMs = 60 } = {}) {
  const calls = new SharedArrayBuffer(4);
  const lock = new SharedArrayBuffer(4);
  const worker = new Worker(BOOTSTRAP, {
    eval: true,
    workerData: {
      workerPath: WORKER_PATH,
      nodeHandle: '1',
      timeoutMs,
      calls,
      lock,
      mode,
      eventStatus: 11,
    },
  });
  started.push(worker);
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  const errored = new Promise((_resolve, reject) => worker.once('error', reject));
  return {
    worker,
    exited,
    errored,
    nativeCalls: () => Atomics.load(new Int32Array(calls), 0),
  };
}

function nextMessage(worker, type) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      worker.off('message', onMessage);
      resolve(message);
    };
    worker.on('message', onMessage);
  });
}

describe('freedom-ipfs event dispatcher worker', () => {
  test('acknowledges stop, makes no further native call, and exits without terminate()', async () => {
    const { worker, exited, errored, nativeCalls } = startWorker();
    const terminate = jest.spyOn(worker, 'terminate');

    // Wait for real polling to start, so the stop below races an in-flight
    // native call rather than the worker's startup — the window #345 aborts in.
    await Promise.race([nextMessage(worker, 'event'), errored]);
    expect(nativeCalls()).toBeGreaterThan(0);

    const acknowledged = nextMessage(worker, 'stopped');
    const startedAt = Date.now();
    worker.postMessage({ type: 'stop' });
    await Promise.race([acknowledged, errored]);

    const callsAtAck = nativeCalls();
    const exitCode = await Promise.race([exited, errored]);
    const elapsed = Date.now() - startedAt;

    expect(exitCode).toBe(0);
    expect(terminate).not.toHaveBeenCalled();
    // Nothing may enter native after the acknowledgement: that is what makes
    // it safe for the parent to call nodeStopGateway/nodeFree next.
    expect(nativeCalls()).toBe(callsAtAck);
    // Comfortably inside the parent's 2s terminate backstop.
    expect(elapsed).toBeLessThan(1000);
  }, 15000);

  test('exits on its own after reporting a native error instead of idling on an open port', async () => {
    const { worker, exited, errored } = startWorker({ mode: 'throw' });
    const terminate = jest.spyOn(worker, 'terminate');

    const failure = await Promise.race([nextMessage(worker, 'error'), errored]);
    expect(failure.error).toBe('gateway handle is gone');

    const exitCode = await Promise.race([exited, errored]);
    expect(exitCode).toBe(0);
    expect(terminate).not.toHaveBeenCalled();
  }, 15000);
});
