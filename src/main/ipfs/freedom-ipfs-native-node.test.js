const createConstants = () => ({
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

function createBindingMock({
  readResults = [],
  response = null,
  buildInfoJson = null,
  nodeHandle = '1',
  requestHandle = '2',
} = {}) {
  const constants = createConstants();
  const defaultResponse = { state: 'ready', status: 200, headers: [] };
  const binding = {
    constants,
    version: jest.fn(() => 'freedom-ipfs-test'),
    nodeNewWithDataDir: jest.fn(() => nodeHandle),
    nodeStartNativeGatewayOnline: jest.fn(() => true),
    nodeStopGateway: jest.fn(() => true),
    nodeFree: jest.fn(),
    nodeProgressSnapshotJson: jest.fn(() => '{"active":[],"events":[]}'),
    nodeNativeGatewayStatsJson: jest.fn(() => '{}'),
    gatewayRequestStart: jest.fn(() => requestHandle),
    gatewayRequestResponseJson: jest.fn(() => JSON.stringify(response || defaultResponse)),
    gatewayRequestRead: jest.fn((_nodeHandle, _requestHandle, buffer) => {
      const result = readResults.length
        ? readResults.shift()
        : { status: constants.READ_PENDING, bytesRead: 0 };
      if (result.status === constants.READ_BYTES && result.bytesRead > 0) {
        buffer.fill(0x61, 0, result.bytesRead);
      }
      return result;
    }),
    gatewayRequestCancel: jest.fn(() => true),
    gatewayRequestFree: jest.fn(() => true),
  };
  if (buildInfoJson !== null) {
    binding.buildInfoJson = jest.fn(() => buildInfoJson);
  }
  return binding;
}

function loadModule(binding) {
  jest.resetModules();
  const { EventEmitter } = require('events');
  class MockWorker extends EventEmitter {
    constructor() {
      super();
      this.postMessage = jest.fn();
      this.terminate = jest.fn(() => Promise.resolve());
    }
  }
  jest.doMock('worker_threads', () => ({
    Worker: jest.fn(() => new MockWorker()),
  }));
  jest.doMock('../logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }));
  jest.doMock('./freedom-ipfs-native-binding', () => ({
    loadNativeBinding: jest.fn(() => binding),
    isNativeBindingAvailable: jest.fn(() => true),
  }));
  return require('./freedom-ipfs-native-node');
}

function createStartedNode(FreedomIpfsNativeNode, onFailure) {
  const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', onFailure });
  node.nodeHandle = '1';
  node.dispatcher = {};
  return node;
}

// Same as createStartedNode, but with a real (mocked) Worker installed through
// startDispatcher() so the shutdown handshake can be driven end to end.
function createDispatcherNode(FreedomIpfsNativeNode, onFailure) {
  const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', onFailure });
  node.nodeHandle = '1';
  node.startDispatcher();
  return node;
}

describe('FreedomIpfsNativeNode', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('clears the request timeout once response headers are delivered', async () => {
    jest.useFakeTimers();
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, ATTEMPT_TIMEOUT_MS } = loadModule(binding);
    const node = createStartedNode(FreedomIpfsNativeNode);

    const responsePromise = node.request({ path: '/ipfs/bafy', headers: new Headers() });
    node.onDispatcherMessage({
      type: 'event',
      event: {
        status: binding.constants.EVENT_STATUS_OK,
        events: binding.constants.EVENT_RESPONSE_READY,
        requestHandle: '2',
      },
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(ATTEMPT_TIMEOUT_MS + 1);
    expect(binding.gatewayRequestCancel).not.toHaveBeenCalled();
    expect(binding.gatewayRequestFree).not.toHaveBeenCalled();
  });

  test('exposes native build info when the addon provides it', () => {
    const buildInfoJson = JSON.stringify({
      name: 'freedom-ipfs',
      version: '0.4.1',
      release_tag: 'v0.4.1',
      target: 'darwin-arm64',
    });
    const binding = createBindingMock({ buildInfoJson });
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

    expect(node.version).toBe('freedom-ipfs-test');
    expect(node.buildInfoJson()).toBe(buildInfoJson);
    expect(node.buildInfo).toMatchObject({
      name: 'freedom-ipfs',
      version: '0.4.1',
      release_tag: 'v0.4.1',
      target: 'darwin-arm64',
    });
  });

  test('falls back to version-only build info for older addons', () => {
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

    expect(JSON.parse(node.buildInfoJson())).toEqual({
      name: 'freedom-ipfs',
      version: 'freedom-ipfs-test',
    });
    expect(node.buildInfo).toEqual({
      name: 'freedom-ipfs',
      version: 'freedom-ipfs-test',
    });
  });

  test('rejects invalid native node handles during startup', () => {
    const binding = createBindingMock({ nodeHandle: 'not-a-handle' });
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

    expect(node.start()).toBe(false);
    expect(binding.nodeStartNativeGatewayOnline).not.toHaveBeenCalled();
    expect(node.nodeHandle).toBe('0');
  });

  test('starts native gateway with a request queue timeout', () => {
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, REQUEST_QUEUE_TIMEOUT_MS } = loadModule(binding);
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

    expect(node.start()).toBe(true);

    expect(binding.nodeStartNativeGatewayOnline).toHaveBeenCalledWith(
      '1',
      '',
      binding.constants.ROUTING_MODE_AUTO,
      0,
      3,
      0,
      REQUEST_QUEUE_TIMEOUT_MS
    );
  });

  test('rejects invalid native request handles without registering a controller', async () => {
    const binding = createBindingMock({ requestHandle: 'not-a-handle' });
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = createStartedNode(FreedomIpfsNativeNode);

    await expect(node.request({ path: '/ipfs/bafy', headers: new Headers() })).rejects.toThrow(
      'freedom-ipfs native request could not be started'
    );
    expect(node.requests.size).toBe(0);
  });

  test('cancels a timed-out request before freeing the native handle', async () => {
    jest.useFakeTimers();
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, ATTEMPT_TIMEOUT_MS } = loadModule(binding);
    const node = createStartedNode(FreedomIpfsNativeNode);

    const responsePromise = node.request({ path: '/ipfs/bafy', headers: new Headers() });
    jest.advanceTimersByTime(ATTEMPT_TIMEOUT_MS);

    await expect(responsePromise).rejects.toThrow('freedom-ipfs native request timeout');
    expect(binding.gatewayRequestCancel).toHaveBeenCalledWith('1', '2');
    expect(binding.gatewayRequestFree).toHaveBeenCalledWith('1', '2');
    expect(binding.gatewayRequestCancel.mock.invocationCallOrder[0]).toBeLessThan(
      binding.gatewayRequestFree.mock.invocationCallOrder[0]
    );
  });

  test('drains response body only while the stream has demand', async () => {
    const binding = createBindingMock({
      readResults: [
        { status: createConstants().READ_BYTES, bytesRead: 4 },
        { status: createConstants().READ_BYTES, bytesRead: 4 },
      ],
    });
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = createStartedNode(FreedomIpfsNativeNode);

    const responsePromise = node.request({ path: '/ipfs/bafy', headers: new Headers() });
    node.onDispatcherMessage({
      type: 'event',
      event: {
        status: binding.constants.EVENT_STATUS_OK,
        events: binding.constants.EVENT_RESPONSE_READY,
        requestHandle: '2',
      },
    });

    const response = await responsePromise;
    expect(binding.gatewayRequestRead).toHaveBeenCalledTimes(1);

    const reader = response.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    expect(binding.gatewayRequestRead).toHaveBeenCalledTimes(2);
  });

  test('does not drain into a cancelled response stream', async () => {
    const binding = createBindingMock({
      readResults: [
        { status: createConstants().READ_PENDING, bytesRead: 0 },
        { status: createConstants().READ_BYTES, bytesRead: 4 },
      ],
    });
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = createStartedNode(FreedomIpfsNativeNode);

    const responsePromise = node.request({ path: '/ipfs/bafy', headers: new Headers() });
    node.onDispatcherMessage({
      type: 'event',
      event: {
        status: binding.constants.EVENT_STATUS_OK,
        events: binding.constants.EVENT_RESPONSE_READY,
        requestHandle: '2',
      },
    });

    const response = await responsePromise;
    const readsBeforeCancel = binding.gatewayRequestRead.mock.calls.length;

    await response.body.getReader().cancel();

    expect(() => {
      node.onDispatcherMessage({
        type: 'event',
        event: {
          status: binding.constants.EVENT_STATUS_OK,
          events: binding.constants.EVENT_BODY_READY,
          requestHandle: '2',
        },
      });
    }).not.toThrow();
    expect(binding.gatewayRequestRead).toHaveBeenCalledTimes(readsBeforeCancel);
  });

  test('does not double-free when native reports the handle was already freed', async () => {
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = createStartedNode(FreedomIpfsNativeNode);

    const responsePromise = node.request({ path: '/ipfs/bafy', headers: new Headers() });
    node.onDispatcherMessage({
      type: 'event',
      event: {
        status: binding.constants.EVENT_STATUS_OK,
        events: binding.constants.EVENT_RESPONSE_READY,
        requestHandle: '2',
      },
    });
    await responsePromise;

    node.onDispatcherMessage({
      type: 'event',
      event: {
        status: binding.constants.EVENT_STATUS_OK,
        events: binding.constants.EVENT_HANDLE_FREED,
        requestHandle: '2',
      },
    });

    expect(binding.gatewayRequestFree).not.toHaveBeenCalled();
    expect(node.requests.has('2')).toBe(false);
  });

  test('marks the node failed and rejects in-flight requests when the gateway stops', async () => {
    const binding = createBindingMock();
    const onFailure = jest.fn();
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = createStartedNode(FreedomIpfsNativeNode, onFailure);

    const responsePromise = node.request({ path: '/ipfs/bafy', headers: new Headers() });
    node.onDispatcherMessage({
      type: 'event',
      event: {
        status: binding.constants.EVENT_STATUS_GATEWAY_STOPPED,
        events: 0,
        requestHandle: '2',
      },
    });

    await expect(responsePromise).rejects.toThrow('Native gateway stopped unexpectedly');
    expect(onFailure).toHaveBeenCalledWith('Native gateway stopped unexpectedly', node);
    expect(node.isHealthy()).toBe(false);
    await expect(node.request({ path: '/ipfs/next', headers: new Headers() })).rejects.toThrow(
      'Native gateway stopped unexpectedly'
    );
  });

  // --- dispatcher shutdown (issue #345) -----------------------------------
  //
  // The worker exits on its own after acknowledging a stop; terminate() is
  // the backstop for a wedged worker. These pin the ordering that keeps a
  // gatewayWaitNextEvent call from ever being in flight while the node handle
  // is torn down — the race that aborted the process with
  // `Error::ThrowAsJavaScriptException napi_throw`.

  test('stop() waits for the dispatcher acknowledgement before touching the native gateway', async () => {
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = createDispatcherNode(FreedomIpfsNativeNode);
    const worker = node.dispatcher;

    const stopped = node.stop();
    await Promise.resolve();

    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'stop' });
    expect(binding.nodeStopGateway).not.toHaveBeenCalled();
    expect(binding.nodeFree).not.toHaveBeenCalled();

    worker.emit('message', { type: 'stopped' });
    worker.emit('exit', 0);
    await stopped;

    expect(worker.terminate).not.toHaveBeenCalled();
    expect(binding.nodeStopGateway).toHaveBeenCalledWith('1');
    expect(binding.nodeFree).toHaveBeenCalledWith('1');
    expect(node.nodeHandle).toBe('0');
  });

  test('stop() resolves on the acknowledgement without waiting out the terminate budget', async () => {
    jest.useFakeTimers();
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, DISPATCHER_EXIT_GRACE_MS } = loadModule(binding);
    const node = createDispatcherNode(FreedomIpfsNativeNode);
    const worker = node.dispatcher;

    const stopped = node.stop();
    await Promise.resolve();
    worker.emit('message', { type: 'stopped' });

    // Exit lands inside the grace: nothing to terminate, and the stop settles
    // far short of DISPATCHER_STOP_TIMEOUT_MS.
    jest.advanceTimersByTime(DISPATCHER_EXIT_GRACE_MS - 1);
    worker.emit('exit', 0);
    await stopped;

    expect(worker.terminate).not.toHaveBeenCalled();
    expect(binding.nodeFree).toHaveBeenCalledWith('1');
  });

  test('stop() terminates an acknowledged dispatcher that never exits', async () => {
    jest.useFakeTimers();
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, DISPATCHER_EXIT_GRACE_MS } = loadModule(binding);
    const log = require('../logger');
    const node = createDispatcherNode(FreedomIpfsNativeNode);
    const worker = node.dispatcher;

    const stopped = node.stop();
    await Promise.resolve();
    worker.emit('message', { type: 'stopped' });

    // The thread acknowledged but is still ref'ing its loop. Resolving on the
    // grace alone would drop the `exit` listener and leak it silently.
    jest.advanceTimersByTime(DISPATCHER_EXIT_GRACE_MS);
    await stopped;

    expect(worker.terminate).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      '[IPFS] native dispatcher acknowledged stop but did not exit; terminating'
    );
    expect(binding.nodeFree).toHaveBeenCalledWith('1');
  });

  test('stop() falls back to terminate() when the dispatcher never acknowledges', async () => {
    jest.useFakeTimers();
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, DISPATCHER_STOP_TIMEOUT_MS } = loadModule(binding);
    const node = createDispatcherNode(FreedomIpfsNativeNode);
    const worker = node.dispatcher;

    const stopped = node.stop();
    await Promise.resolve();
    expect(binding.nodeStopGateway).not.toHaveBeenCalled();

    jest.advanceTimersByTime(DISPATCHER_STOP_TIMEOUT_MS);
    await stopped;

    expect(worker.terminate).toHaveBeenCalled();
    expect(binding.nodeFree).toHaveBeenCalledWith('1');
  });

  test('a late exit from a stopped dispatcher does not fail the one that replaced it', async () => {
    jest.useFakeTimers();
    const binding = createBindingMock();
    const onFailure = jest.fn();
    const { FreedomIpfsNativeNode, DISPATCHER_EXIT_GRACE_MS } = loadModule(binding);
    const node = createDispatcherNode(FreedomIpfsNativeNode, onFailure);
    const first = node.dispatcher;

    const stopped = node.stop();
    await Promise.resolve();
    first.emit('message', { type: 'stopped' });
    jest.advanceTimersByTime(DISPATCHER_EXIT_GRACE_MS);
    await stopped;

    node.nodeHandle = '1';
    node.startDispatcher();
    const second = node.dispatcher;
    expect(second).not.toBe(first);

    first.emit('exit', 0);

    expect(node.dispatcher).toBe(second);
    expect(node.isHealthy()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('an exit from the live dispatcher still marks the node failed', async () => {
    const binding = createBindingMock();
    const onFailure = jest.fn();
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = createDispatcherNode(FreedomIpfsNativeNode, onFailure);

    node.dispatcher.emit('exit', 1);

    expect(node.dispatcher).toBeNull();
    expect(onFailure).toHaveBeenCalledWith('Native event dispatcher exited with code 1', node);
    expect(node.isHealthy()).toBe(false);
  });
});
