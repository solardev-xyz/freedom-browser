const { EventEmitter } = require('events');
let mockPort;
class MockChannel {
  constructor() {
    this.port1 = new EventEmitter();
    this.port2 = new EventEmitter();
    for (const port of [this.port1, this.port2]) {
      port.postMessage = jest.fn();
      port.start = jest.fn();
      let closed = false;
      port.close = jest.fn(() => {
        if (closed) return;
        closed = true;
        port.emit('close');
      });
    }
    mockPort = this.port1;
  }
}
const mockFork = jest.fn(),
  mockCreateWorker = jest.fn(),
  mockCreate = jest.fn(),
  mockApp = new EventEmitter();
mockApp.isReady = () => true;
mockApp.getPath = () => '/tmp';
mockApp.getAppMetrics = jest.fn();
jest.mock('electron', () => ({
  app: mockApp,
  utilityProcess: { fork: mockFork },
  MessageChannelMain: MockChannel,
}));
jest.mock('./railgun-session', () => ({ createRailgunSession: (options) => mockCreate(options) }));
jest.mock('./railgun-session-worker', () => ({
  startRailgunSessionWorker: (options) => mockCreateWorker(options),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { startRailgunProcess } = require('./railgun-process');
let scope, args, child, broker, task;
const children = [];
const context = (principal) =>
  scope.getContext({
    kind: 'private-account',
    principal,
    protocol: 'railgun',
    deployment: 'fixture',
    chainId: 11155111,
    role: 'engine',
  });
beforeEach(() => {
  mockCreateWorker.mockReset();
  jest.useFakeTimers();
  jest.spyOn(process, 'kill').mockReturnValue(true);
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  args = {
    handle: context('a'),
    filename: '/tmp/reviewed-engine.js',
    input: '{}',
    storage: {},
    createProvider() {},
  };
  mockFork.mockReset().mockImplementation(() => {
    child = new EventEmitter();
    child.pid = 123456789;
    child.kill = jest.fn();
    child.postMessage = jest.fn();
    children.push(child);
    return child;
  });
  mockCreate.mockReset().mockImplementation(({ onClose }) => {
    const controller = new AbortController();
    broker = {
      signal: controller.signal,
      dispatch: jest.fn(async (wire) => JSON.stringify({ id: JSON.parse(wire).id, value: null })),
      close: jest.fn(() => {
        if (controller.signal.aborted) return;
        controller.abort();
        onClose();
      }),
    };
    return broker;
  });
  mockApp.getAppMetrics
    .mockReset()
    .mockImplementation(() => [{ pid: child?.pid, memory: { workingSetSize: 1000 } }]);
});
afterEach(() => {
  scope.close();
  for (const c of children.splice(0)) c.emit('exit', 1);
  task?.close();
  task = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
});
const message = (value) => mockPort.emit('message', { data: JSON.stringify(value) });
const command = (id, method = 'get') => ({
  type: 'command',
  wire: JSON.stringify({ id, method, args: { key: 'YQ==' } }),
});
test('worker readiness and observed exit both gate the engine lifecycle', async () => {
  let ready, exited;
  mockCreateWorker.mockImplementation((options) => {
    const value = mockCreate(options);
    value.ready = new Promise((resolve) => {
      ready = resolve;
    });
    value.closed = new Promise((resolve) => {
      exited = resolve;
    });
    return value;
  });
  task = startRailgunProcess({ ...args, storageWorker: true });
  child.emit('spawn');
  message({ type: 'ready' });
  let delivered = false,
    released = false;
  task.ready.then(() => {
    delivered = true;
  });
  task.closed.then(() => {
    released = true;
  });
  await Promise.resolve();
  expect(delivered).toBe(false);
  ready();
  await task.ready;
  expect(delivered).toBe(true);
  task.close();
  child.emit('exit', 0);
  await Promise.resolve();
  expect(released).toBe(false);
  expect(() => startRailgunProcess(args)).toThrow('Railgun process unavailable');
  exited();
  await task.closed;
  expect(released).toBe(true);
});
test('worker startup failure terminates the engine and keeps the slot until the worker exits', async () => {
  let reject, exited;
  mockCreateWorker.mockImplementation((options) => {
    const value = mockCreate(options);
    value.ready = new Promise((_, fail) => {
      reject = fail;
    });
    value.closed = new Promise((resolve) => {
      exited = resolve;
    });
    return value;
  });
  task = startRailgunProcess({ ...args, storageWorker: true });
  child.emit('spawn');
  reject(new Error('private worker detail'));
  await expect(task.ready).rejects.toMatchObject({ code: 'RAILGUN_SESSION_REVOKED' });
  expect(process.kill).toHaveBeenCalledWith(child.pid, 'SIGTERM');
  child.emit('exit', 1);
  expect(() => startRailgunProcess(args)).toThrow();
  exited();
  expect((await task.closed).code).toBe('RAILGUN_SESSION_REVOKED');
});
test('uses a private bootstrap, filtered environment and string-only startup after spawn', async () => {
  task = startRailgunProcess(args);
  expect(child.postMessage).not.toHaveBeenCalled();
  child.emit('spawn');
  const [filename, argv, options] = mockFork.mock.calls[0];
  expect(filename).toMatch(/railgun-process-entry\.js$/);
  expect(argv).toEqual([]);
  expect(options.stdio).toBe('ignore');
  expect(options.execArgv).toEqual(['--max-old-space-size=256']);
  expect(Object.keys(options.env).sort()).toEqual(Object.keys(process.env).sort());
  expect(Object.values(options.env).every((value) => value === '')).toBe(true);
  expect(JSON.parse(child.postMessage.mock.calls[0][0])).toEqual({
    type: 'init',
    filename: args.filename,
    input: '{}',
  });
  message({ type: 'ready' });
  await task.ready;
  expect(task.signal.aborted).toBe(false);
  task.close();
  expect(task.signal.aborted).toBe(true);
  expect(broker.signal.aborted).toBe(true);
  child.emit('exit', 0);
  expect(await task.closed).toMatchObject({
    code: 'RAILGUN_PROCESS_CLOSED',
    peakRssBytes: 1024000,
  });
});
test('readiness is held until an actual memory sample is available', async () => {
  mockApp.getAppMetrics.mockReturnValue([]);
  task = startRailgunProcess(args);
  child.emit('spawn');
  message({ type: 'ready' });
  let settled = false;
  task.ready.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  mockApp.getAppMetrics.mockReturnValue([{ pid: child.pid, memory: { workingSetSize: 1000 } }]);
  jest.advanceTimersByTime(250);
  await task.ready;
});
test('dispatch reserves requests synchronously in arrival order before any reply', async () => {
  task = startRailgunProcess(args);
  child.emit('spawn');
  const first = command(1),
    second = command(2);
  message(first);
  message(second);
  expect(broker.dispatch.mock.calls).toEqual([[first.wire], [second.wire]]);
  expect(mockPort.postMessage).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(mockPort.postMessage).toHaveBeenCalledTimes(2);
});
test('vault lock before spawn sends no input and holds ownership until observed exit', async () => {
  task = startRailgunProcess(args);
  child.pid = undefined;
  scope.close();
  const rejected = expect(task.ready).rejects.toThrow();
  let exited = false;
  task.closed.then(() => {
    exited = true;
  });
  await Promise.resolve();
  expect(exited).toBe(false);
  child.pid = 123456789;
  child.emit('spawn');
  expect(child.postMessage).not.toHaveBeenCalled();
  if (process.platform === 'win32') expect(child.kill).toHaveBeenCalled();
  else expect(process.kill).toHaveBeenCalledWith(child.pid, 'SIGTERM');
  jest.advanceTimersByTime(250);
  expect(process.kill).toHaveBeenCalledWith(child.pid, 'SIGKILL');
  child.emit('exit', 1);
  await rejected;
  await task.closed;
});
test('a late successful host dispatch cannot send after lock', async () => {
  task = startRailgunProcess(args);
  child.emit('spawn');
  let reply;
  broker.dispatch.mockImplementation(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      })
  );
  message(command(1));
  scope.close();
  reply(JSON.stringify({ id: 1, value: 'late' }));
  await Promise.resolve();
  expect(child.postMessage).toHaveBeenCalledTimes(1);
  expect(mockPort.postMessage).not.toHaveBeenCalled();
  expect(broker.signal.aborted).toBe(true);
});
test.each(['duplicate-ready', 'malformed', 'oversized', 'failure', 'extra-key'])(
  '%s closes without exposing diagnostics',
  async (mode) => {
    task = startRailgunProcess(args);
    child.emit('spawn');
    if (mode === 'duplicate-ready') {
      message({ type: 'ready' });
      message({ type: 'ready' });
    }
    if (mode === 'malformed') mockPort.emit('message', { data: '{' });
    if (mode === 'oversized') mockPort.emit('message', { data: ' '.repeat(4 * 1024 * 1024 + 129) });
    if (mode === 'failure') message({ type: 'failure', secret: 'private URL' });
    if (mode === 'extra-key') message({ ...command(1), extra: 'ungranted' });
    expect(task.signal.aborted).toBe(true);
    child.emit('exit', 1);
    expect((await task.closed).code).toBe('RAILGUN_PROCESS_FAILED');
  }
);
test.each(['startup', 'lifetime', 'memory', 'missing-metrics'])(
  '%s limit revokes but releases only at exit',
  async (mode) => {
    task = startRailgunProcess({ ...args, startupMs: 10000, lifetimeMs: 20000 });
    child.emit('spawn');
    if (mode === 'startup') jest.advanceTimersByTime(10000);
    if (mode === 'lifetime') {
      message({ type: 'ready' });
      jest.advanceTimersByTime(20000);
    }
    if (mode === 'memory') {
      mockApp.getAppMetrics.mockReturnValue([
        { pid: child.pid, memory: { workingSetSize: 900000 } },
      ]);
      jest.advanceTimersByTime(250);
    }
    if (mode === 'missing-metrics') {
      mockApp.getAppMetrics.mockReturnValue([]);
      jest.advanceTimersByTime(5000);
    }
    expect(task.signal.aborted).toBe(true);
    expect(() => startRailgunProcess(args)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_PROCESS_BUSY' })
    );
    child.emit('exit', 1);
    await task.closed;
    const retry = startRailgunProcess(args);
    retry.close();
    child.emit('exit', 1);
    await retry.closed;
  }
);
test('two processes are the global limit and each account has one owner', async () => {
  task = startRailgunProcess(args);
  expect(() => startRailgunProcess(args)).toThrow();
  const other = startRailgunProcess({ ...args, handle: context('b') });
  expect(() => startRailgunProcess({ ...args, handle: context('c') })).toThrow();
  other.close();
  child.emit('exit', 1);
  await other.closed;
});
test('fork failure releases capacity and revokes the session without an exit event', async () => {
  mockFork.mockImplementationOnce(() => {
    throw new Error('sensitive internal detail');
  });
  task = startRailgunProcess(args);
  await expect(task.ready).rejects.toMatchObject({ message: 'Railgun process unavailable' });
  expect((await task.closed).code).toBe('RAILGUN_PROCESS_FAILED');
  expect(broker.signal.aborted).toBe(true);
  const retry = startRailgunProcess(args);
  retry.close();
  child.emit('exit', 1);
  await retry.closed;
});
test('child error, unexpected exit and app quit revoke host state', async () => {
  for (const mode of ['error', 'exit', 'quit']) {
    task = startRailgunProcess(args);
    child.emit('spawn');
    if (mode === 'error') child.emit('error', new Error('private detail'));
    if (mode === 'quit') mockApp.emit('before-quit');
    child.emit('exit', 9);
    await task.closed;
    expect(broker.signal.aborted).toBe(true);
  }
});
test('rejects unsafe input types and resource values before forking', () => {
  for (const change of [
    { input: Buffer.alloc(1) },
    { input: 'x'.repeat(65537) },
    { filename: 'relative' },
    { heapMb: 1 },
    { rssMb: 1 },
    { startupMs: 0 },
    { lifetimeMs: 1 },
  ])
    expect(() => startRailgunProcess({ ...args, ...change })).toThrow();
  expect(mockFork).not.toHaveBeenCalled();
});

test('a private-channel disconnect and an unexpected parentPort message both revoke authority', async () => {
  for (const mode of ['disconnect', 'raw-message']) {
    task = startRailgunProcess(args);
    child.emit('spawn');
    if (mode === 'disconnect') mockPort.emit('close');
    else child.emit('message', JSON.stringify(command(1)));
    expect(task.signal.aborted).toBe(true);
    expect(broker.dispatch).not.toHaveBeenCalled();
    child.emit('exit', 1);
    await task.closed;
  }
});
test('an unobserved spawn reports timeout promptly but holds its owner until exit', async () => {
  task = startRailgunProcess({ ...args, startupMs: 1000 });
  child.pid = undefined;
  const rejected = expect(task.ready).rejects.toMatchObject({
    code: 'RAILGUN_PROCESS_SPAWN_TIMEOUT',
  });
  jest.advanceTimersByTime(1000);
  await rejected;
  expect(task.getStatus()).toMatchObject({
    phase: 'stopping',
    code: 'RAILGUN_PROCESS_SPAWN_TIMEOUT',
  });
  expect(() => startRailgunProcess(args)).toThrow(
    expect.objectContaining({ code: 'RAILGUN_PROCESS_BUSY' })
  );
  let settled = false;
  task.closed.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('exit', 1);
  await task.closed;
});
test.each(['egress', 'job', 'protocol'])(
  'ordered %s failure preserves its fixed code when channel closes',
  async (reason) => {
    task = startRailgunProcess(args);
    child.emit('spawn');
    message({ type: 'failure', reason });
    mockPort.emit('close');
    child.emit('exit', 1);
    expect((await task.closed).code).toBe(
      reason === 'egress' ? 'RAILGUN_PROCESS_EGRESS_REFUSED' : 'RAILGUN_PROCESS_FAILED'
    );
  }
);
