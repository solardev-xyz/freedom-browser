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

function borrowedOptions(controller = new AbortController()) {
  const borrowed = {
    signal: controller.signal,
    dispatch: jest.fn(async (wire) => JSON.stringify({ id: JSON.parse(wire).id, value: null })),
    close: jest.fn(),
    closed: new Promise(() => {}),
  };
  return {
    controller,
    borrowed,
    options: { ...args, storage: undefined, createProvider: undefined, broker: borrowed },
  };
}
test('borrowed coordinator dispatch is the sole authority and survives normal child shutdown', async () => {
  const { borrowed, options } = borrowedOptions();
  task = startRailgunProcess(options);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockCreateWorker).not.toHaveBeenCalled();
  child.emit('spawn');
  message(command(1));
  expect(borrowed.dispatch).toHaveBeenCalledWith(command(1).wire);
  message({ type: 'ready' });
  await task.ready;
  task.close();
  child.emit('exit', 0);
  await task.closed;
  expect(borrowed.close).not.toHaveBeenCalled();
  expect(borrowed.signal.aborted).toBe(false);
});
test('borrowed broker revocation stops the process and drops late replies', async () => {
  const { controller, borrowed, options } = borrowedOptions();
  let reply;
  borrowed.dispatch.mockImplementation(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      })
  );
  task = startRailgunProcess(options);
  child.emit('spawn');
  message(command(1));
  controller.abort();
  reply('{}');
  await Promise.resolve();
  expect(mockPort.postMessage).not.toHaveBeenCalled();
  child.emit('exit', 1);
  expect((await task.closed).code).toBe('RAILGUN_SESSION_REVOKED');
  expect(borrowed.close).not.toHaveBeenCalled();
});
test('an already revoked borrowed broker never forks a child', async () => {
  const { controller, options } = borrowedOptions();
  controller.abort();
  task = startRailgunProcess(options);
  await expect(task.ready).rejects.toThrow();
  await task.closed;
  expect(mockFork).not.toHaveBeenCalled();
});
test.each(['storage', 'provider', 'worker', 'no-signal', 'no-dispatch'])(
  'rejects ambiguous borrowed authority: %s',
  (mode) => {
    const { options } = borrowedOptions();
    if (mode === 'storage') options.storage = {};
    if (mode === 'provider') options.createProvider = () => {};
    if (mode === 'worker') options.storageWorker = true;
    if (mode === 'no-signal') options.broker.signal = {};
    if (mode === 'no-dispatch') options.broker.dispatch = null;
    expect(() => startRailgunProcess(options)).toThrow();
    expect(mockFork).not.toHaveBeenCalled();
  }
);

test.each([
  ['keystore', 'spending-public', './railgun-identity-job'],
  ['keystore', 'spending-sign', './railgun-spend-sign-job'],
  ['engine', 'wallet-viewing', './railgun-wallet-job'],
  ['engine', 'private-prepare', './railgun-private-prepare-job'],
  ['engine', 'poi-prove', './railgun-own-poi-prove-job'],
  ['engine', 'poi-output-recover', './railgun-poi-output-recover-job'],
  ['engine', 'poi-transact-selector', './railgun-poi-transact-selector-job'],
  ['engine', 'private-operate', './railgun-private-operate-job'],
  ['engine', 'private-receive', './railgun-private-receive-job'],
  ['engine', 'shield-receive', './railgun-shield-receive-job'],
])(
  'only dedicated %s/%s job can receive one binary key, and the supervisor wipes it',
  async (role, purpose, job) => {
    const bytes = Buffer.alloc(32, 7),
      replyCopies = [];
    const controller = new AbortController();
    const identityArgs = {
      handle: scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation: purpose,
      }),
      filename: require.resolve(job),
      input: '{}',
      binaryKey: true,
      broker: { signal: controller.signal, dispatch: async () => bytes },
    };
    expect(() => startRailgunProcess({ ...identityArgs, filename: '/tmp/arbitrary.js' })).toThrow();
    expect(() => startRailgunProcess({ ...identityArgs, handle: args.handle })).toThrow();
    task = startRailgunProcess(identityArgs);
    mockPort.postMessage.mockImplementation((value) => replyCopies.push(structuredClone(value)));
    child.emit('spawn');
    message({
      type: 'command',
      wire: JSON.stringify({ id: 1, method: 'key', purpose }),
    });
    await Promise.resolve();
    expect(replyCopies).toHaveLength(1);
    expect(replyCopies[0].type).toBe('key-reply');
    expect([...replyCopies[0].bytes]).toEqual(Array(32).fill(7));
    expect(bytes.equals(Buffer.alloc(32))).toBe(true);
    message({
      type: 'command',
      wire: JSON.stringify({ id: 1, method: 'key', purpose }),
    });
    await Promise.resolve();
    expect(replyCopies).toHaveLength(1);
    child.emit('exit', 1);
    expect((await task.closed).code).toBe('RAILGUN_PROCESS_FAILED');
  }
);
test('late binary replies are wiped without crossing a stopped channel', async () => {
  let respond;
  const bytes = Buffer.alloc(32, 8);
  task = startRailgunProcess({
    handle: args.handle,
    filename: args.filename,
    input: '{}',
    broker: {
      signal: scope.signal,
      dispatch: () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    },
  });
  child.emit('spawn');
  message(command(1));
  task.close();
  respond(bytes);
  await Promise.resolve();
  expect(bytes.equals(Buffer.alloc(32))).toBe(true);
  expect(mockPort.postMessage).not.toHaveBeenCalled();
});

test.each([
  ['spending-sign', './railgun-identity-job'],
  ['spending-public', './railgun-spend-sign-job'],
  ['spending-sign', './railgun-wallet-job'],
  ['spending-public', './railgun-wallet-job'],
  ['spending-sign', './railgun-private-prepare-job'],
  ['private-prepare', './railgun-spend-sign-job'],
  ['spending-sign', './railgun-private-receive-job'],
  ['private-receive', './railgun-spend-sign-job'],
  ['private-receive', './railgun-wallet-job', 'engine'],
  ['private-receive', './railgun-private-prepare-job', 'engine'],
  ['private-prepare', './railgun-private-receive-job', 'engine'],
  ['private-operate', './railgun-private-prepare-job', 'engine'],
  ['private-prepare', './railgun-private-operate-job', 'engine'],
  ['poi-prove', './railgun-private-prepare-job', 'engine'],
  ['private-prepare', './railgun-own-poi-prove-job', 'engine'],
  ['spending-sign', './railgun-own-poi-prove-job', 'engine'],
  ['poi-prove', './railgun-own-poi-prove-job', 'prover'],
  ['poi-output-recover', './railgun-poi-output-recover-job', 'prover'],
  ['poi-output-recover', './railgun-poi-output-recover-job', 'keystore'],
  ['poi-output-recover', './railgun-own-poi-prove-job', 'engine'],
  ['poi-prove', './railgun-poi-output-recover-job', 'engine'],
  ['poi-output-recover', './railgun-private-prepare-job', 'engine'],
  ['private-prepare', './railgun-poi-output-recover-job', 'engine'],
  ['spending-sign', './railgun-poi-output-recover-job'],
  ['private-operate', './railgun-spend-sign-job', 'engine'],
  ['spending-sign', './railgun-private-operate-job'],
])('refuses binary-key job cross-pairing %s/%s', (operation, filename, role = 'keystore') => {
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role,
    operation,
  });
  expect(() =>
    startRailgunProcess({
      handle,
      filename: require.resolve(filename),
      input: '{}',
      binaryKey: true,
      broker: { signal: scope.signal, dispatch: async () => new Uint8Array(32) },
    })
  ).toThrow();
  expect(mockFork).not.toHaveBeenCalled();
});

test('a 32-byte view over a larger backing buffer is never copied to a child', async () => {
  const backing = new Uint8Array(8192).fill(9),
    bytes = backing.subarray(64, 96);
  task = startRailgunProcess({
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'railgun:0',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'keystore',
      operation: 'spending-public',
    }),
    filename: require.resolve('./railgun-identity-job'),
    input: '{}',
    binaryKey: true,
    broker: { signal: scope.signal, dispatch: async () => bytes },
  });
  child.emit('spawn');
  message({
    type: 'command',
    wire: JSON.stringify({ id: 1, method: 'key', purpose: 'spending-public' }),
  });
  await Promise.resolve();
  expect(mockPort.postMessage).not.toHaveBeenCalled();
  expect([...bytes]).toEqual(Array(32).fill(0));
  expect(backing[0]).toBe(9);
  child.emit('exit', 1);
  expect((await task.closed).code).toBe('RAILGUN_PROCESS_FAILED');
});

test.each([
  ['kind', 'service'],
  ['role', 'prover'],
  ['role', 'keystore'],
  ['operation', 'poi-output-recover'],
  ['protocol', 'ppv2'],
  ['deployment', 'mainnet'],
  ['chainId', 1],
  ['filename', './railgun-own-selector-job'],
  ['filename', './railgun-poi-output-recover-job'],
])('Transact selector binary admission binds exact %s=%s', (field, value) => {
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
    operation: 'poi-transact-selector',
  };
  if (field !== 'filename') subject[field] = value;
  expect(() =>
    startRailgunProcess({
      handle: scope.getContext(subject),
      filename: require.resolve(
        field === 'filename' ? value : './railgun-poi-transact-selector-job'
      ),
      input: '{}',
      binaryKey: true,
      broker: { signal: scope.signal, dispatch: async () => new Uint8Array(32) },
    })
  ).toThrow();
  expect(mockFork).not.toHaveBeenCalled();
});
