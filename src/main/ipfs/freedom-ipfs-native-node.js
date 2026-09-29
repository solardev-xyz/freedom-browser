const path = require('path');
const { Worker } = require('worker_threads');
const log = require('../logger');
const { loadNativeBinding, isNativeBindingAvailable } = require('./freedom-ipfs-native-binding');

const BUFFER_SIZE = 64 * 1024;
const ATTEMPT_TIMEOUT_MS = 30_000;
const REQUEST_QUEUE_TIMEOUT_MS = 15_000;
// How long stopDispatcher() waits for the worker to acknowledge a stop before
// resorting to terminate(), and how long it then waits for the thread to end
// once it has acknowledged. The acknowledgement is what proves no
// gatewayWaitNextEvent is in flight, so the exit after it is a formality.
const DISPATCHER_STOP_TIMEOUT_MS = 2000;
const DISPATCHER_EXIT_GRACE_MS = 500;

let native = null;

function binding() {
  if (!native) native = loadNativeBinding();
  return native;
}

function parseJson(json, fallback = null) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function normalizeNativeHandle(handle) {
  if (typeof handle === 'string') {
    return /^[1-9]\d*$/.test(handle) ? handle : null;
  }
  if (typeof handle === 'number') {
    return Number.isSafeInteger(handle) && handle > 0 ? String(handle) : null;
  }
  if (typeof handle === 'bigint') {
    return handle > 0n ? handle.toString() : null;
  }
  return null;
}

function headersToNativeArray(headers) {
  const out = [];
  for (const [name, value] of headers.entries()) {
    out.push({ name, value });
  }
  return out;
}

function responseHeaders(metadata) {
  const headers = new Headers();
  for (const header of metadata?.headers || []) {
    if (!header?.name) continue;
    headers.append(header.name, header.value || '');
  }
  return headers;
}

function errorFromMetadata(metadata, fallbackMessage = 'freedom-ipfs native request failed') {
  const error = new Error(metadata?.error?.message || fallbackMessage);
  error.code = metadata?.error?.code || metadata?.state || 'native_gateway_error';
  error.metadata = metadata || null;
  return error;
}

class NativeGatewayController {
  constructor(owner, handle, method, signal) {
    this.owner = owner;
    this.handle = handle;
    this.handleKey = handle;
    this.method = method;
    this.signal = signal;
    this.responseSettled = false;
    this.terminated = false;
    this.draining = false;
    this.streamController = null;
    this.timeout = null;

    this.responsePromise = new Promise((resolve, reject) => {
      this.resolveResponse = resolve;
      this.rejectResponse = reject;
    });

    this.abortListener = () => this.cancel();
    if (signal) {
      if (signal.aborted) this.cancel();
      else signal.addEventListener('abort', this.abortListener, { once: true });
    }

    this.timeout = setTimeout(() => {
      this.cancel();
      this.fail(new Error('freedom-ipfs native request timeout'));
    }, ATTEMPT_TIMEOUT_MS);
  }

  handleEvent(events) {
    const c = binding().constants;
    if (this.terminated) return;
    if (events & (c.EVENT_RESPONSE_READY | c.EVENT_BODY_READY | c.EVENT_END | c.EVENT_FAILED)) {
      this.deliverResponseIfNeeded();
    }
    if (events & (c.EVENT_BODY_READY | c.EVENT_END | c.EVENT_FAILED | c.EVENT_CANCELLED)) {
      this.drain();
    }
    if (events & c.EVENT_HANDLE_FREED) {
      this.finish({ freeNative: false });
    }
  }

  deliverResponseIfNeeded() {
    if (this.responseSettled || this.terminated) return;
    const metadata = parseJson(
      binding().gatewayRequestResponseJson(this.owner.nodeHandle, this.handle),
      { state: 'failed', error: { message: 'failed to decode response metadata' } }
    );

    if (metadata.state === 'pending') return;
    if (metadata.state === 'failed' || metadata.state === 'cancelled') {
      this.fail(errorFromMetadata(metadata));
      return;
    }

    const status = metadata.status || 502;
    const bodyAllowed = this.method !== 'HEAD' && ![204, 205, 304].includes(status);
    const body = bodyAllowed
      ? new ReadableStream({
          start: (controller) => {
            this.streamController = controller;
            this.drain();
          },
          pull: () => {
            this.drain();
          },
          cancel: () => {
            this.cancel();
          },
        })
      : null;

    this.responseSettled = true;
    this.clearResponseTimeout();
    this.resolveResponse(
      new Response(body, {
        status,
        headers: responseHeaders(metadata),
      })
    );

    if (!bodyAllowed) {
      this.finish();
    }
  }

  drain() {
    if (this.draining || this.terminated || !this.streamController) return;
    this.draining = true;
    const c = binding().constants;

    try {
      while (!this.terminated && this.hasStreamDemand()) {
        const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
        const result = binding().gatewayRequestRead(this.owner.nodeHandle, this.handle, buffer);
        switch (result.status) {
          case c.READ_BYTES:
            if (result.bytesRead > 0) {
              this.streamController.enqueue(buffer.subarray(0, result.bytesRead));
            }
            break;
          case c.READ_PENDING:
            return;
          case c.READ_END:
            this.streamController.close();
            this.finish();
            return;
          case c.READ_CANCELLED:
            this.streamController.error(new Error('freedom-ipfs native request cancelled'));
            this.finish();
            return;
          case c.READ_FAILED:
          case c.READ_INVALID_HANDLE:
          default:
            this.streamController.error(new Error('freedom-ipfs native read failed'));
            this.finish();
            return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  hasStreamDemand() {
    const desiredSize = this.streamController?.desiredSize;
    return desiredSize === undefined || desiredSize > 0;
  }

  cancel() {
    if (this.terminated) return;
    try {
      binding().gatewayRequestCancel(this.owner.nodeHandle, this.handle);
    } catch (err) {
      log.warn('[IPFS] native request cancel failed:', err.message);
    }
  }

  fail(err) {
    if (!this.responseSettled) {
      this.responseSettled = true;
      this.rejectResponse(err);
    } else if (this.streamController) {
      this.streamController.error(err);
    }
    this.finish();
  }

  finish({ freeNative = true } = {}) {
    if (this.terminated) return;
    this.terminated = true;
    this.clearResponseTimeout();
    if (this.signal) this.signal.removeEventListener('abort', this.abortListener);
    if (freeNative) {
      try {
        binding().gatewayRequestFree(this.owner.nodeHandle, this.handle);
      } catch (err) {
        log.warn('[IPFS] native request free failed:', err.message);
      }
    }
    this.owner.unregister(this.handleKey);
  }

  clearResponseTimeout() {
    if (!this.timeout) return;
    clearTimeout(this.timeout);
    this.timeout = null;
  }
}

class FreedomIpfsNativeNode {
  constructor({
    dataDir,
    maxCacheBytes = 256 * 1024 * 1024,
    requestQueueTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
    onFailure = null,
  } = {}) {
    this.dataDir = dataDir;
    this.maxCacheBytes = maxCacheBytes;
    this.requestQueueTimeoutMs = requestQueueTimeoutMs;
    this.onFailure = onFailure;
    this.nodeHandle = '0';
    this.dispatcher = null;
    this.requests = new Map();
    this.nextRequestId = 1;
    this.stoppingDispatcher = false;
    this.failed = false;
    this.failureError = null;
  }

  static isAvailable() {
    return isNativeBindingAvailable();
  }

  get version() {
    return binding().version();
  }

  buildInfoJson() {
    const nativeBinding = binding();
    if (typeof nativeBinding.buildInfoJson === 'function') {
      return nativeBinding.buildInfoJson();
    }
    return JSON.stringify({
      name: 'freedom-ipfs',
      version: this.version,
    });
  }

  get buildInfo() {
    return parseJson(this.buildInfoJson(), null);
  }

  start() {
    if (normalizeNativeHandle(this.nodeHandle)) return true;
    this.failed = false;
    this.failureError = null;
    const handle = normalizeNativeHandle(
      binding().nodeNewWithDataDir(this.dataDir, this.maxCacheBytes)
    );
    if (!handle) return false;
    this.nodeHandle = handle;

    const ok = binding().nodeStartNativeGatewayOnline(
      this.nodeHandle,
      '',
      binding().constants.ROUTING_MODE_AUTO,
      0,
      3,
      0,
      this.requestQueueTimeoutMs
    );
    if (!ok) {
      binding().nodeFree(this.nodeHandle);
      this.nodeHandle = '0';
      return false;
    }
    this.startDispatcher();
    return true;
  }

  async stop() {
    await this.stopDispatcher();
    for (const request of this.requests.values()) {
      request.cancel();
      request.finish();
    }
    this.requests.clear();
    if (this.nodeHandle !== '0') {
      try {
        binding().nodeStopGateway(this.nodeHandle);
      } catch (err) {
        log.warn('[IPFS] native gateway stop failed:', err.message);
      }
      binding().nodeFree(this.nodeHandle);
      this.nodeHandle = '0';
    }
    this.failed = false;
    this.failureError = null;
  }

  startDispatcher() {
    if (this.dispatcher || this.nodeHandle === '0') return;
    const dispatcher = new Worker(path.join(__dirname, 'freedom-ipfs-event-worker.js'), {
      workerData: {
        nodeHandle: this.nodeHandle,
        timeoutMs: 100,
      },
    });
    this.dispatcher = dispatcher;
    dispatcher.on('message', (message) => this.onDispatcherMessage(message));
    dispatcher.on('error', (err) => {
      // A worker stopDispatcher() already detached is on its way out; its
      // errors say nothing about this node's health, but still deserve a line.
      if (this.dispatcher !== dispatcher) {
        log.warn('[IPFS] detached native dispatcher errored:', err.message);
        return;
      }
      log.error('[IPFS] native dispatcher error:', err.message);
      this.markFailed(`Native event dispatcher failed: ${err.message}`);
    });
    dispatcher.on('exit', (code) => {
      // stopDispatcher() detaches the worker before asking it to stop, and can
      // resolve on the `stopped` acknowledgement before this `exit` lands — by
      // which point a restart may already have installed a newer worker here.
      // Only an exit from the worker this node is still using is a failure.
      if (this.dispatcher !== dispatcher) return;
      this.dispatcher = null;
      log.warn('[IPFS] native dispatcher exited with code', code);
      this.markFailed(`Native event dispatcher exited with code ${code}`);
    });
  }

  // Wind the dispatcher down before stop() touches the native gateway. The
  // worker acknowledges with `stopped` from the top of its loop — i.e. with no
  // gatewayWaitNextEvent in flight — and then closes its port and exits on its
  // own, so waiting for that acknowledgement is what makes the
  // nodeStopGateway/nodeFree below safe. terminate() stays as a backstop only,
  // for a worker that never answers: quit-time callers should not have to fall
  // all the way through to the shutdown watchdog in src/main/index.js.
  stopDispatcher() {
    const dispatcher = this.dispatcher;
    this.dispatcher = null;
    if (!dispatcher) return Promise.resolve();
    this.stoppingDispatcher = true;
    return new Promise((resolve) => {
      let settled = false;
      let terminateTimer = null;
      let exitTimer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(terminateTimer);
        clearTimeout(exitTimer);
        dispatcher.off('message', onAcknowledged);
        dispatcher.off('exit', finish);
        this.stoppingDispatcher = false;
        resolve();
      };

      const onAcknowledged = (message) => {
        if (message?.type !== 'stopped') return;
        // Acknowledged: no native call can be in flight any more. The thread
        // exit that follows is a formality, so give it a short grace instead
        // of holding the quit open for the full terminate budget. If it does
        // not exit within the grace, terminate it: the acknowledgement is
        // exactly the point where that is safe (no gatewayWaitNextEvent in
        // flight), and resolving without it would drop the one `exit` listener
        // that could have reported the thread, leaking it silently per stop.
        clearTimeout(terminateTimer);
        exitTimer = setTimeout(() => {
          log.warn('[IPFS] native dispatcher acknowledged stop but did not exit; terminating');
          dispatcher.terminate().finally(finish);
        }, DISPATCHER_EXIT_GRACE_MS);
        exitTimer.unref?.();
      };

      terminateTimer = setTimeout(() => {
        log.warn('[IPFS] native dispatcher did not acknowledge stop; terminating');
        dispatcher.terminate().finally(finish);
      }, DISPATCHER_STOP_TIMEOUT_MS);
      terminateTimer.unref?.();

      dispatcher.on('exit', finish);
      dispatcher.on('message', onAcknowledged);
      dispatcher.postMessage({ type: 'stop' });
    });
  }

  onDispatcherMessage(message) {
    if (message?.type === 'error') {
      log.error('[IPFS] native dispatcher failed:', message.error);
      if (!this.stoppingDispatcher) {
        this.markFailed(`Native event dispatcher failed: ${message.error}`);
      }
      return;
    }
    if (message?.type !== 'event') return;
    const event = message.event;
    const constants = binding().constants;
    if (event.status === constants.EVENT_STATUS_TIMEOUT) return;
    if (event.status === constants.EVENT_STATUS_GATEWAY_STOPPED) {
      this.markFailed('Native gateway stopped unexpectedly');
      return;
    }
    if (event.status !== constants.EVENT_STATUS_OK) return;
    const requestHandle = normalizeNativeHandle(event.requestHandle);
    if (!requestHandle) return;
    const request = this.requests.get(requestHandle);
    if (!request) return;
    request.handleEvent(event.events);
  }

  markFailed(reason) {
    if (this.failed || this.stoppingDispatcher) return;
    this.failed = true;
    this.failureError = reason || 'Native node failed';
    const err = new Error(this.failureError);
    for (const request of [...this.requests.values()]) {
      request.fail(err);
    }
    this.requests.clear();
    if (typeof this.onFailure === 'function') {
      try {
        this.onFailure(this.failureError, this);
      } catch (callbackErr) {
        log.warn('[IPFS] native failure callback failed:', callbackErr.message);
      }
    }
  }

  isHealthy() {
    return (
      Boolean(normalizeNativeHandle(this.nodeHandle)) && !this.failed && Boolean(this.dispatcher)
    );
  }

  unregister(handleKey) {
    const requestHandle = normalizeNativeHandle(handleKey);
    if (requestHandle) this.requests.delete(requestHandle);
  }

  request({ method = 'GET', path: gatewayPath, headers, signal }) {
    const nodeHandle = normalizeNativeHandle(this.nodeHandle);
    if (!nodeHandle) {
      return Promise.reject(new Error('freedom-ipfs native node is not running'));
    }
    if (!this.isHealthy()) {
      return Promise.reject(
        new Error(this.failureError || 'freedom-ipfs native node is unavailable')
      );
    }
    const requestId = this.nextRequestId++;
    const requestJson = JSON.stringify({
      method,
      path: gatewayPath,
      headers: headersToNativeArray(headers || new Headers()),
      request_id: requestId,
      top_level_path: gatewayPath,
    });
    const handle = normalizeNativeHandle(binding().gatewayRequestStart(nodeHandle, requestJson));
    if (!handle) {
      return Promise.reject(new Error('freedom-ipfs native request could not be started'));
    }
    const controller = new NativeGatewayController(this, handle, method, signal);
    this.requests.set(controller.handleKey, controller);
    return controller.responsePromise;
  }

  progressSnapshotJson() {
    return this.nodeHandle === '0'
      ? '{"active":[],"events":[]}'
      : binding().nodeProgressSnapshotJson(this.nodeHandle);
  }

  nativeGatewayStatsJson() {
    return this.nodeHandle === '0' ? '{}' : binding().nodeNativeGatewayStatsJson(this.nodeHandle);
  }
}

module.exports = {
  FreedomIpfsNativeNode,
  NativeGatewayController,
  ATTEMPT_TIMEOUT_MS,
  REQUEST_QUEUE_TIMEOUT_MS,
  DISPATCHER_STOP_TIMEOUT_MS,
  DISPATCHER_EXIT_GRACE_MS,
};
