const { parentPort, workerData } = require('worker_threads');
const { loadNativeBinding } = require('./freedom-ipfs-native-binding');

const native = loadNativeBinding();
const nodeHandle = workerData.nodeHandle;
const timeoutMs = Number(workerData.timeoutMs || 250);

let stopped = false;
let shuttingDown = false;

parentPort.on('message', (message) => {
  if (message?.type === 'stop') {
    stopped = true;
  }
});

function postEvent(event) {
  parentPort.postMessage({
    type: 'event',
    event: {
      status: event.status,
      events: event.events,
      requestHandle: event.requestHandle.toString(),
    },
  });
}

// Last thing this worker does: hand the parent a final message, then let the
// thread die on its own. Returning from the loop is not enough — the
// `message` listener above holds a ref on `parentPort`, so the event loop
// never drains and the parent's `terminate()` becomes the only way out. That
// cost every quit the parent's full 2s stop budget, and it left a terminate
// standing to land while `gatewayWaitNextEvent` was inside native code, which
// destroys the env under the addon: its throw then hits node-addon-api's
// fatal `Error::ThrowAsJavaScriptException` / `napi_throw` path and takes the
// process with it (issue #345). Closing the port drops that ref, so the
// worker exits by itself and `terminate()` is left as the wedged-worker
// backstop it was meant to be.
function shutdown(message) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    parentPort.postMessage(message);
  } catch {
    // Port already gone; the parent's terminate() backstop covers it.
  }
  parentPort.close();
}

function loop() {
  // `stopped` is a latch: once the parent has asked for a stop, this worker
  // must not enter native code again. A stop posted while
  // gatewayWaitNextEvent is blocked cannot be seen until that call has
  // returned and the loop has yielded — a worker does not process queued port
  // messages from inside a synchronous native call (probed on Node 22/Electron
  // 44, 2026-09) — so this is the one place the latch can be read, and it is
  // read with no native call in flight. That is exactly what the `stopped`
  // acknowledgement promises the parent before it frees the gateway handle.
  if (stopped) {
    shutdown({ type: 'stopped' });
    return;
  }

  try {
    const event = native.gatewayWaitNextEvent(nodeHandle, timeoutMs);
    postEvent(event);
  } catch (err) {
    shutdown({ type: 'error', error: err?.message || String(err) });
    return;
  }

  setTimeout(loop, 0);
}

loop();
