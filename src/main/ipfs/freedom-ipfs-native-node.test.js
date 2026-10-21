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
    // The lifecycle runs through the Promise-returning exports only (#503).
    // The sync ones stay on the addon for other callers; here they throw, the
    // way the real addon does while an async call is pending on the handle,
    // so any use of them fails the test.
    nodeNewWithDataDirAsync: jest.fn(() => Promise.resolve(nodeHandle)),
    nodeStartNativeGatewayOnlineAsync: jest.fn(() => Promise.resolve(true)),
    nodeStopGatewayAsync: jest.fn(() => Promise.resolve(true)),
    nodeFreeAsync: jest.fn(() => Promise.resolve()),
    nodeNewWithDataDir: jest.fn(() => {
      throw new Error('sync nodeNewWithDataDir must not be used');
    }),
    nodeStartNativeGatewayOnline: jest.fn(() => {
      throw new Error('sync nodeStartNativeGatewayOnline must not be used');
    }),
    nodeStopGateway: jest.fn(() => {
      throw new Error('sync nodeStopGateway must not be used');
    }),
    nodeFree: jest.fn(() => {
      throw new Error('sync nodeFree must not be used');
    }),
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The most recent dispatcher the node spawned. A stop queued behind a start
// detaches it from `node.dispatcher` as soon as that start settles, so read
// it off the mocked constructor rather than the node.
function lastWorker() {
  const { Worker } = require('worker_threads');
  return Worker.mock.results[Worker.mock.results.length - 1].value;
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

  test('rejects invalid native node handles during startup', async () => {
    const binding = createBindingMock({ nodeHandle: 'not-a-handle' });
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

    await expect(node.start()).resolves.toBe(false);
    expect(binding.nodeStartNativeGatewayOnlineAsync).not.toHaveBeenCalled();
    expect(node.nodeHandle).toBe('0');
  });

  test('starts native gateway with both delegated routers and a request queue timeout', async () => {
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, REQUEST_QUEUE_TIMEOUT_MS, DELEGATED_ROUTERS } =
      loadModule(binding);
    const log = require('../logger');
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

    await expect(node.start()).resolves.toBe(true);

    expect(binding.nodeNewWithDataDirAsync).toHaveBeenCalledWith(
      '/tmp/freedom-ipfs-test',
      256 * 1024 * 1024
    );
    expect(binding.nodeStartNativeGatewayOnlineAsync).toHaveBeenCalledWith(
      '1',
      DELEGATED_ROUTERS,
      binding.constants.ROUTING_MODE_AUTO,
      0,
      3,
      0,
      REQUEST_QUEUE_TIMEOUT_MS
    );
    expect(log.info).toHaveBeenCalledWith(
      `[IPFS] native gateway online, delegated routers: ${DELEGATED_ROUTERS}`
    );
    // #700: an empty list leaves the addon on its single built-in router;
    // pin both entries so a revert to '' (or a dropped router) fails here.
    expect(DELEGATED_ROUTERS.split(',')).toEqual([
      'https://delegated-ipfs.dev/routing/v1',
      'https://cid.contact/routing/v1',
    ]);
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
    expect(binding.nodeStopGatewayAsync).not.toHaveBeenCalled();
    expect(binding.nodeFreeAsync).not.toHaveBeenCalled();

    worker.emit('message', { type: 'stopped' });
    worker.emit('exit', 0);
    await stopped;

    expect(worker.terminate).not.toHaveBeenCalled();
    expect(binding.nodeStopGatewayAsync).toHaveBeenCalledWith('1');
    expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
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
    expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
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
    expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
  });

  test('stop() falls back to terminate() when the dispatcher never acknowledges', async () => {
    jest.useFakeTimers();
    const binding = createBindingMock();
    const { FreedomIpfsNativeNode, DISPATCHER_STOP_TIMEOUT_MS } = loadModule(binding);
    const node = createDispatcherNode(FreedomIpfsNativeNode);
    const worker = node.dispatcher;

    const stopped = node.stop();
    await Promise.resolve();
    expect(binding.nodeStopGatewayAsync).not.toHaveBeenCalled();

    jest.advanceTimersByTime(DISPATCHER_STOP_TIMEOUT_MS);
    await stopped;

    expect(worker.terminate).toHaveBeenCalled();
    expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
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

  // The addon's async lifecycle contract (freedom-ipfs docs/release.md, v0.4.5):
  // calls on one handle run in call order, the sync start/stop/free throw while
  // one is pending, and a handle is never used after nodeFreeAsync.
  describe('async native lifecycle', () => {
    test('start() returns before the native work finishes and publishes the handle only once started', async () => {
      const binding = createBindingMock();
      const created = deferred();
      const started = deferred();
      binding.nodeNewWithDataDirAsync.mockReturnValueOnce(created.promise);
      binding.nodeStartNativeGatewayOnlineAsync.mockReturnValueOnce(started.promise);
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

      const starting = node.start();
      await flush();
      expect(binding.nodeNewWithDataDirAsync).toHaveBeenCalledTimes(1);
      created.resolve('7');
      await flush();
      expect(binding.nodeStartNativeGatewayOnlineAsync).toHaveBeenCalledWith(
        '7',
        'https://delegated-ipfs.dev/routing/v1,https://cid.contact/routing/v1',
        binding.constants.ROUTING_MODE_AUTO,
        0,
        3,
        0,
        expect.any(Number)
      );
      // Half-started: nothing may reach the handle yet.
      expect(node.nodeHandle).toBe('0');
      expect(node.dispatcher).toBeNull();
      await expect(
        node.request({ path: '/ipfs/bafkqaaa', headers: new Headers() })
      ).rejects.toThrow('not running');
      expect(binding.gatewayRequestStart).not.toHaveBeenCalled();

      started.resolve(true);
      await expect(starting).resolves.toBe(true);
      expect(node.nodeHandle).toBe('7');
      expect(node.dispatcher).not.toBeNull();
      expect(binding.nodeNewWithDataDir).not.toHaveBeenCalled();
      expect(binding.nodeStartNativeGatewayOnline).not.toHaveBeenCalled();
    });

    test('a start the gateway refuses frees its handle and never publishes it', async () => {
      const binding = createBindingMock();
      binding.nodeStartNativeGatewayOnlineAsync.mockResolvedValueOnce(false);
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

      await expect(node.start()).resolves.toBe(false);
      expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
      expect(binding.nodeFree).not.toHaveBeenCalled();
      expect(node.nodeHandle).toBe('0');
      expect(node.dispatcher).toBeNull();
    });

    test('a start that throws frees its handle before rethrowing', async () => {
      const binding = createBindingMock();
      const order = [];
      binding.nodeStartNativeGatewayOnlineAsync.mockImplementationOnce(() => {
        order.push('start');
        return Promise.reject(new Error('bind failed'));
      });
      binding.nodeFreeAsync.mockImplementationOnce((handle) => {
        order.push(`free:${handle}`);
        return Promise.resolve();
      });
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

      await expect(node.start()).rejects.toThrow('bind failed');
      expect(order).toEqual(['start', 'free:1']);
      expect(node.nodeHandle).toBe('0');
    });

    test('stop() waits for a start still in flight, then stops and frees that handle', async () => {
      const binding = createBindingMock();
      const order = [];
      const started = deferred();
      binding.nodeNewWithDataDirAsync.mockImplementation(() => {
        order.push('new');
        return Promise.resolve('1');
      });
      binding.nodeStartNativeGatewayOnlineAsync.mockImplementation(() => {
        order.push('start');
        return started.promise;
      });
      binding.nodeStopGatewayAsync.mockImplementation((handle) => {
        order.push(`stop:${handle}`);
        return Promise.resolve(true);
      });
      binding.nodeFreeAsync.mockImplementation((handle) => {
        order.push(`free:${handle}`);
        return Promise.resolve();
      });
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

      const starting = node.start();
      const stopping = node.stop();
      await flush();
      expect(order).toEqual(['new', 'start']);

      started.resolve(true);
      await expect(starting).resolves.toBe(true);
      const worker = lastWorker();
      await flush();
      worker.emit('message', { type: 'stopped' });
      worker.emit('exit', 0);
      await stopping;

      expect(order).toEqual(['new', 'start', 'stop:1', 'free:1']);
      expect(node.nodeHandle).toBe('0');
    });

    test('the handle is cleared before nodeFreeAsync and never used while it is freed', async () => {
      const binding = createBindingMock();
      const freed = deferred();
      binding.nodeFreeAsync.mockReturnValueOnce(freed.promise);
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = createStartedNode(FreedomIpfsNativeNode);
      node.dispatcher = null;

      const stopping = node.stop();
      await flush();
      expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
      expect(node.nodeHandle).toBe('0');

      // Diagnostics and requests during the free must not reach the handle.
      expect(node.progressSnapshotJson()).toBe('{"active":[],"events":[]}');
      expect(node.nativeGatewayStatsJson()).toBe('{}');
      await expect(
        node.request({ path: '/ipfs/bafkqaaa', headers: new Headers() })
      ).rejects.toThrow('not running');
      expect(binding.nodeProgressSnapshotJson).not.toHaveBeenCalled();
      expect(binding.nodeNativeGatewayStatsJson).not.toHaveBeenCalled();
      expect(binding.gatewayRequestStart).not.toHaveBeenCalled();

      freed.resolve();
      await stopping;
    });

    test('concurrent stop() calls share one stop and free the handle once', async () => {
      const binding = createBindingMock();
      const freed = deferred();
      binding.nodeFreeAsync.mockReturnValueOnce(freed.promise);
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = createStartedNode(FreedomIpfsNativeNode);
      node.dispatcher = null;

      const first = node.stop();
      const second = node.stop();
      expect(second).toBe(first);
      await flush();
      freed.resolve();
      await Promise.all([first, second]);

      expect(binding.nodeStopGatewayAsync).toHaveBeenCalledTimes(1);
      expect(binding.nodeFreeAsync).toHaveBeenCalledTimes(1);
    });

    test('a restart waits for the previous free before reopening the data dir', async () => {
      const binding = createBindingMock();
      const freed = deferred();
      binding.nodeFreeAsync.mockReturnValueOnce(freed.promise);
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = createStartedNode(FreedomIpfsNativeNode);
      node.dispatcher = null;

      const stopping = node.stop();
      const restarting = node.start();
      await flush();
      expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
      expect(binding.nodeNewWithDataDirAsync).not.toHaveBeenCalled();

      freed.resolve();
      await stopping;
      await expect(restarting).resolves.toBe(true);
      expect(binding.nodeNewWithDataDirAsync).toHaveBeenCalledTimes(1);
      expect(node.nodeHandle).toBe('1');
    });

    test('a stop queued after a later start still stops that start', async () => {
      const binding = createBindingMock();
      const freed = deferred();
      binding.nodeFreeAsync.mockReturnValueOnce(freed.promise);
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = createStartedNode(FreedomIpfsNativeNode);
      node.dispatcher = null;

      const firstStop = node.stop();
      const restart = node.start();
      const secondStop = node.stop();
      expect(secondStop).not.toBe(firstStop);

      freed.resolve();
      await firstStop;
      await expect(restart).resolves.toBe(true);
      const worker = lastWorker();
      await flush();
      worker.emit('message', { type: 'stopped' });
      worker.emit('exit', 0);
      await secondStop;

      expect(binding.nodeFreeAsync).toHaveBeenCalledTimes(2);
      expect(node.nodeHandle).toBe('0');
    });

    test('a start queued after a stop is a new start, not the one before the stop', async () => {
      const binding = createBindingMock();
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

      const first = node.start();
      const stopping = node.stop();
      const second = node.start();
      expect(second).not.toBe(first);

      await expect(first).resolves.toBe(true);
      const worker = lastWorker();
      await flush();
      worker.emit('message', { type: 'stopped' });
      worker.emit('exit', 0);
      await stopping;
      await expect(second).resolves.toBe(true);

      // Up again after the stop: the user's last request wins.
      expect(binding.nodeNewWithDataDirAsync).toHaveBeenCalledTimes(2);
      expect(binding.nodeFreeAsync).toHaveBeenCalledTimes(1);
      expect(node.nodeHandle).toBe('1');
      expect(node.isHealthy()).toBe(true);
    });

    test('an addon without the async exports fails the start instead of blocking', async () => {
      const binding = createBindingMock();
      delete binding.nodeNewWithDataDirAsync;
      const { FreedomIpfsNativeNode } = loadModule(binding);
      const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test' });

      await expect(node.start()).rejects.toMatchObject({
        code: 'FREEDOM_IPFS_NATIVE_ADDON_TOO_OLD',
      });
      expect(binding.nodeNewWithDataDir).not.toHaveBeenCalled();
      expect(node.nodeHandle).toBe('0');
    });
  });
});

// freedom-core design 0007, Rollback: the add-on runs under freedom-ipfsd's
// hold-lock, from before its store opens until after it is closed.
describe("FreedomIpfsNativeNode under its data directory's gate", () => {
  /** A gate whose takes and releases are recorded in `order`. */
  function gate(order, { fails = null } = {}) {
    const holds = [];
    const takeGate = jest.fn(async ({ onLost }) => {
      order.push('gate taken');
      if (fails) throw fails;
      const hold = {
        onLost,
        release: jest.fn(async () => {
          order.push('gate released');
        }),
      };
      holds.push(hold);
      return hold;
    });
    return { takeGate, holds };
  }

  function recordedBinding(order) {
    const binding = createBindingMock();
    binding.nodeNewWithDataDirAsync.mockImplementation(async () => {
      order.push('store opened');
      return '1';
    });
    binding.nodeFreeAsync.mockImplementation(async () => {
      order.push('store closed');
    });
    return binding;
  }

  async function stopNode(node) {
    const stopping = node.stop();
    await flush();
    const worker = lastWorker();
    worker.emit('message', { type: 'stopped' });
    worker.emit('exit', 0);
    await stopping;
  }

  test('takes the gate before its store opens, and releases it after the store is closed', async () => {
    const order = [];
    const binding = recordedBinding(order);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const { takeGate, holds } = gate(order);
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', takeGate });

    await expect(node.start()).resolves.toBe(true);
    expect(order).toEqual(['gate taken', 'store opened']);
    await stopNode(node);

    expect(order).toEqual(['gate taken', 'store opened', 'store closed', 'gate released']);
    expect(holds[0].release).toHaveBeenCalledTimes(1);
  });

  test("a gate it can't have fails the start, and the store is never opened", async () => {
    const order = [];
    const binding = recordedBinding(order);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const held = Object.assign(new Error('The IPFS data is in use by another process.'), {
      name: 'IpfsGateError',
      code: 'lock_held',
    });
    const { takeGate } = gate(order, { fails: held });
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', takeGate });

    await expect(node.start()).rejects.toBe(held);
    expect(binding.nodeNewWithDataDirAsync).not.toHaveBeenCalled();
    expect(node.nodeHandle).toBe('0');
  });

  test.each([
    [
      'the store opening throws',
      (b) => b.nodeNewWithDataDirAsync.mockRejectedValue(new Error('x')),
    ],
    ['the store opening gives no handle', (b) => b.nodeNewWithDataDirAsync.mockResolvedValue('0')],
    [
      'the gateway refusing to start',
      (b) => b.nodeStartNativeGatewayOnlineAsync.mockResolvedValue(false),
    ],
    [
      'the gateway start throwing',
      (b) => b.nodeStartNativeGatewayOnlineAsync.mockRejectedValue(new Error('x')),
    ],
  ])('a failed start releases the gate: %s', async (_label, breakIt) => {
    const order = [];
    const binding = recordedBinding(order);
    breakIt(binding);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const { takeGate, holds } = gate(order);
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', takeGate });

    await node.start().catch(() => {});
    expect(holds[0].release).toHaveBeenCalledTimes(1);
    expect(node.gate).toBeNull();
  });

  test("a holder lost while it runs fails the node: today's failure, then a stop that frees the store", async () => {
    const order = [];
    const binding = recordedBinding(order);
    const { FreedomIpfsNativeNode, GATE_LOST } = loadModule(binding);
    const { takeGate, holds } = gate(order);
    const onFailure = jest.fn();
    const node = new FreedomIpfsNativeNode({
      dataDir: '/tmp/freedom-ipfs-test',
      takeGate,
      onFailure,
    });
    await node.start();

    holds[0].onLost({ code: null, signal: 'SIGKILL' });

    expect(onFailure).toHaveBeenCalledWith(GATE_LOST, node);
    expect(node.isHealthy()).toBe(false);
    await stopNode(node);
    expect(order.slice(-2)).toEqual(['store closed', 'gate released']);
  });

  test("a holder lost while it starts: the start gives up, and the store isn't served", async () => {
    const order = [];
    const binding = recordedBinding(order);
    const started = deferred();
    binding.nodeStartNativeGatewayOnlineAsync.mockImplementation(() => started.promise);
    const { FreedomIpfsNativeNode, GATE_LOST } = loadModule(binding);
    const { takeGate, holds } = gate(order);
    const onFailure = jest.fn();
    const node = new FreedomIpfsNativeNode({
      dataDir: '/tmp/freedom-ipfs-test',
      takeGate,
      onFailure,
    });
    const starting = node.start();
    await flush();

    holds[0].onLost({ code: 1, signal: null });
    started.resolve(true);

    await expect(starting).rejects.toThrow(GATE_LOST);
    expect(binding.nodeFreeAsync).toHaveBeenCalledWith('1');
    expect(order.slice(-2)).toEqual(['store closed', 'gate released']);
    expect(node.nodeHandle).toBe('0');
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('a stop while the start waits for its gate cancels the wait, and the store is never opened', async () => {
    const order = [];
    const binding = recordedBinding(order);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    let signal = null;
    const takeGate = jest.fn(
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
          );
        })
    );
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', takeGate });
    const starting = node.start();
    await flush();
    expect(signal.aborted).toBe(false);

    const stopping = node.stop();
    expect(signal.aborted).toBe(true);
    await expect(starting).rejects.toMatchObject({ code: 'cancelled' });
    await stopping;
    expect(binding.nodeNewWithDataDirAsync).not.toHaveBeenCalled();
    expect(node.gate).toBeNull();
  });

  // A gate wait honours its signal as holdIpfsGate does: one already aborted
  // rejects at once, without a holder.
  const cancellableGate = () =>
    jest.fn(
      (options) =>
        new Promise((resolve, reject) => {
          const cancelled = () =>
            reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
          if (options.signal.aborted) cancelled();
          else options.signal.addEventListener('abort', cancelled);
        })
    );

  test('a stop in the same turn as the start cancels the gate wait before it begins', async () => {
    const binding = recordedBinding([]);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const takeGate = cancellableGate();
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', takeGate });

    const starting = node.start();
    const stopping = node.stop();
    await expect(starting).rejects.toMatchObject({ code: 'cancelled' });
    await stopping;
    expect(takeGate.mock.calls[0][0].signal.aborted).toBe(true);
    expect(binding.nodeNewWithDataDirAsync).not.toHaveBeenCalled();
    expect(node.gate).toBeNull();
  });

  test('a start requested after that stop waits on a gate of its own, uncancelled', async () => {
    const binding = recordedBinding([]);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const release = jest.fn(async () => {});
    let call = 0;
    const cancelled = cancellableGate();
    const takeGate = jest.fn((options) => {
      call += 1;
      return call === 1 ? cancelled(options) : Promise.resolve({ release });
    });
    const node = new FreedomIpfsNativeNode({ dataDir: '/tmp/freedom-ipfs-test', takeGate });

    const first = node.start();
    const stopping = node.stop();
    const second = node.start();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    await stopping;
    await expect(second).resolves.toBe(true);
    expect(takeGate).toHaveBeenCalledTimes(2);
    expect(takeGate.mock.calls[1][0].signal.aborted).toBe(false);
    expect(binding.nodeNewWithDataDirAsync).toHaveBeenCalledTimes(1);
    await node.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  // Until the service is the default, only development builds gate their
  // IPFS writers (ipfsd-gate.js, ipfsGateRequired).
  test.each([
    ['a packaged build starts it with no gate', true, 0],
    ['a development build starts it under hold-lock', false, 1],
  ])('through the real gate: %s', async (_label, isPackaged, holders) => {
    const binding = recordedBinding([]);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const { app } = require('electron');
    const { takeIpfsGate } = require('./ipfsd-gate');
    const wasPackaged = app.isPackaged;
    const binaryBefore = process.env.FREEDOM_IPFSD_PATH;
    app.isPackaged = isPackaged;
    // A binary that is there, wherever the suite runs.
    process.env.FREEDOM_IPFSD_PATH = __filename;
    const spawn = jest.fn(() => {
      const { EventEmitter } = require('events');
      const { PassThrough } = require('stream');
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(),
      });
      child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0, null)));
      setImmediate(() => child.stdout.write('locked\n'));
      return child;
    });
    try {
      const node = new FreedomIpfsNativeNode({
        dataDir: '/tmp/freedom-ipfs-test',
        takeGate: (options) =>
          takeIpfsGate('/tmp/freedom-ipfs-test', {
            ...options,
            lockDir: '/tmp/freedom-locks',
            spawn,
          }),
      });
      await expect(node.start()).resolves.toBe(true);
      expect(spawn).toHaveBeenCalledTimes(holders);
      await stopNode(node);
    } finally {
      app.isPackaged = wasPackaged;
      if (binaryBefore === undefined) delete process.env.FREEDOM_IPFSD_PATH;
      else process.env.FREEDOM_IPFSD_PATH = binaryBefore;
    }
  });

  test('a hold released by its own stop is never lost', async () => {
    const order = [];
    const binding = recordedBinding(order);
    const { FreedomIpfsNativeNode } = loadModule(binding);
    const { takeGate, holds } = gate(order);
    const onFailure = jest.fn();
    const node = new FreedomIpfsNativeNode({
      dataDir: '/tmp/freedom-ipfs-test',
      takeGate,
      onFailure,
    });
    await node.start();
    await stopNode(node);

    holds[0].onLost({ code: 0, signal: null });
    expect(onFailure).not.toHaveBeenCalled();
  });
});
