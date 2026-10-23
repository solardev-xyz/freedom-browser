/* global jest */

/**
 * A stand-in for the freedom-ipfs native add-on, for driving the real
 * `FreedomIpfsNativeNode` (and through it ipfs-manager and the `ipfs:`
 * handler) without the binary.
 *
 * It models the add-on's gateway request API the way freedom-ipfs v0.4.5 (the
 * pinned release) implements it in crates/freedom-ipfs-mobile/src/lib.rs: a
 * request is started from JSON and gets a handle; its response metadata is
 * polled as JSON (`pending` until the test responds, `cancelled` once
 * cancelled, :3026); body bytes are pulled with `gatewayRequestRead` into the
 * caller's buffer, READ_CANCELLED once cancelled; cancel raises
 * EVENT_CANCELLED and nothing else (:188-207); only `gatewayRequestFree`
 * removes the request and raises EVENT_HANDLE_FREED (:2597-2622).
 *
 * Readiness events reach the main thread through the dispatcher worker, i.e.
 * a macrotask later and never re-entrantly from inside a native call — so
 * they are emitted with a real `setImmediate` on the dispatcher that
 * `attachDispatcher` registered.
 *
 * Every request records what the node pulled from it (`reads`, `bytesRead`),
 * which is what the backpressure and cancel tests measure. A request with a
 * `source` function produces a fresh chunk on every read (an endless body).
 */

const timers = require('timers');

const CONSTANTS = Object.freeze({
  READ_PENDING: 0,
  READ_BYTES: 1,
  READ_END: 2,
  READ_CANCELLED: 3,
  READ_FAILED: 4,
  READ_INVALID_HANDLE: 5,
  EVENT_STATUS_OK: 10,
  EVENT_STATUS_TIMEOUT: 11,
  EVENT_STATUS_INVALID_NODE: 12,
  EVENT_STATUS_GATEWAY_STOPPED: 13,
  EVENT_RESPONSE_READY: 1 << 0,
  EVENT_BODY_READY: 1 << 1,
  EVENT_END: 1 << 2,
  EVENT_FAILED: 1 << 3,
  EVENT_CANCELLED: 1 << 4,
  EVENT_HANDLE_FREED: 1 << 5,
  ROUTING_MODE_AUTO: 20,
});

function createFakeFreedomIpfsAddon() {
  const c = CONSTANTS;
  const requests = [];
  const byHandle = new Map();
  let nextHandle = 100;
  let dispatcher = null;
  let onRequest = () => {};

  function emit(request, events) {
    timers.setImmediate(() => {
      dispatcher?.emit('message', {
        type: 'event',
        event: { status: c.EVENT_STATUS_OK, events, requestHandle: request.handle },
      });
    });
  }

  const addon = {
    constants: c,
    version: () => '0.4.5-fake',
    buildInfoJson: () => JSON.stringify({ name: 'freedom-ipfs', version: '0.4.5-fake' }),
    nodeNewWithDataDirAsync: jest.fn(async () => '1'),
    nodeStartNativeGatewayOnlineAsync: jest.fn(async () => true),
    nodeStopGatewayAsync: jest.fn(async () => true),
    nodeFreeAsync: jest.fn(async () => {}),
    nodeProgressSnapshotJson: () => '{"active":[],"events":[]}',
    nodeNativeGatewayStatsJson: () =>
      JSON.stringify({ active_native_handles: requests.filter((r) => !r.freed).length }),

    gatewayRequestStart: jest.fn((_nodeHandle, requestJson) => {
      const parsed = JSON.parse(requestJson);
      const request = {
        handle: String(nextHandle++),
        json: parsed,
        method: parsed.method,
        path: parsed.path,
        headers: Object.fromEntries(parsed.headers.map((h) => [h.name.toLowerCase(), h.value])),
        metadata: null,
        chunks: [],
        source: null,
        ended: false,
        bodyFailed: false,
        cancelled: false,
        freed: false,
        reads: 0,
        bytesRead: 0,
      };
      requests.push(request);
      byHandle.set(request.handle, request);
      onRequest(request);
      return request.handle;
    }),

    gatewayRequestResponseJson: (_nodeHandle, handle) =>
      JSON.stringify(byHandle.get(handle)?.metadata || { state: 'pending' }),

    gatewayRequestRead: (_nodeHandle, handle, buffer) => {
      const request = byHandle.get(handle);
      if (!request || request.freed) return { status: c.READ_INVALID_HANDLE, bytesRead: 0 };
      request.reads += 1;
      if (request.cancelled) return { status: c.READ_CANCELLED, bytesRead: 0 };
      if (request.bodyFailed) return { status: c.READ_FAILED, bytesRead: 0 };
      if (!request.chunks.length && request.source) request.chunks.push(request.source());
      if (!request.chunks.length) {
        return { status: request.ended ? c.READ_END : c.READ_PENDING, bytesRead: 0 };
      }
      const chunk = request.chunks[0];
      const n = Math.min(chunk.length, buffer.length);
      chunk.copy(buffer, 0, 0, n);
      if (n === chunk.length) request.chunks.shift();
      else request.chunks[0] = chunk.subarray(n);
      request.bytesRead += n;
      return { status: c.READ_BYTES, bytesRead: n };
    },

    gatewayRequestCancel: jest.fn((_nodeHandle, handle) => {
      const request = byHandle.get(handle);
      if (!request || request.freed) return false;
      request.cancelled = true;
      // The add-on's metadata reports `cancelled` from now on, with no error
      // object of its own.
      request.metadata = { ...(request.metadata || {}), state: 'cancelled', error: null };
      emit(request, c.EVENT_CANCELLED);
      return true;
    }),

    gatewayRequestFree: jest.fn((_nodeHandle, handle) => {
      const request = byHandle.get(handle);
      if (!request || request.freed) return false;
      request.freed = true;
      emit(request, c.EVENT_HANDLE_FREED);
      return true;
    }),
  };

  // Test-side controls.
  const control = {
    addon,
    requests,
    get dispatcher() {
      return dispatcher;
    },
    attachDispatcher(worker) {
      dispatcher = worker;
    },
    onRequest(fn) {
      onRequest = fn;
    },
    activeHandles: () => requests.filter((r) => !r.freed).length,
    respond(request, { status = 200, headers = {} } = {}) {
      request.metadata = {
        state: 'streaming',
        status,
        headers: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })),
        error: null,
      };
      emit(request, c.EVENT_RESPONSE_READY);
    },
    push(request, data) {
      request.chunks.push(Buffer.from(data));
      emit(request, c.EVENT_BODY_READY);
    },
    end(request) {
      request.ended = true;
      emit(request, c.EVENT_END);
    },
    // Respond and deliver the whole body, in `chunks` pieces.
    serve(request, { status = 200, headers = {}, body = '', chunks = 1 } = {}) {
      control.respond(request, { status, headers });
      const bytes = Buffer.from(body);
      const size = Math.ceil(bytes.length / chunks) || 1;
      for (let at = 0; at < bytes.length; at += size)
        control.push(request, bytes.subarray(at, at + size));
      control.end(request);
    },
    failRequest(request, message, code = 'not_found') {
      request.metadata = { state: 'failed', error: { code, message } };
      emit(request, c.EVENT_FAILED);
    },
    failBody(request) {
      request.bodyFailed = true;
      emit(request, c.EVENT_FAILED);
    },
    emit,
  };
  return control;
}

module.exports = { CONSTANTS, createFakeFreedomIpfsAddon };
