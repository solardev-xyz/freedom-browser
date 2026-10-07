const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const source = fs.readFileSync(path.join(__dirname, 'railgun-platform-host.js'), 'utf8');
const REFUSED = expect.objectContaining({ code: 'RAILGUN_PLATFORM_REFUSED' });

// Test-only module resolution: production has no entry or constructor injection.
function load(options = {}) {
  const child = new EventEmitter();
  child.pid = options.pid === undefined ? 1234 : options.pid;
  child.kill = jest.fn(() => 'terminated');
  const worker = { stdout: { resume: jest.fn() }, stderr: { resume: jest.fn() } };
  const WorkerMock = options.Worker || jest.fn(() => worker);
  const samples = [{ pid: 1234, memory: { workingSetSize: 512 } }];
  const electron = {
    app: {
      isReady: jest.fn(() => true),
      getPath: jest.fn(() => '/public-temp'),
      getAppMetrics: jest.fn(() => samples),
    },
    utilityProcess: { fork: jest.fn(() => child) },
    MessageChannelMain: jest.fn(function () {
      this.port1 = {};
      this.port2 = {};
    }),
  };
  const processMock = {
    type: options.type,
    platform: options.platform || 'darwin',
    env: { PATH: '/deliberately/not-forwarded', PUBLIC_TEST: 'not-forwarded' },
    kill: jest.fn(() => true),
  };
  const imports = [];
  const resolver = jest.fn((name) => {
    if (options.missing)
      throw Object.assign(new Error('missing fixed entry'), { code: 'MODULE_NOT_FOUND' });
    if (name === './railgun-owner-utility-entry') return '/fixed/railgun-owner-utility-entry.js';
    if (name === './railgun-owner-storage-entry')
      return options.workerEntry || '/fixed/railgun-owner-storage-entry.js';
    throw new Error('Unexpected resolution');
  });
  const required = (name) => {
    imports.push(name);
    if (name === 'electron') return electron;
    if (name === 'worker_threads')
      return { isMainThread: options.mainThread !== false, Worker: WorkerMock };
    return require(name);
  };
  required.resolve = resolver;
  const module = { exports: {} };
  vm.runInNewContext(
    source,
    {
      require: required,
      module,
      process: processMock,
      Object,
      Array,
      Uint8Array,
      ArrayBuffer,
      SharedArrayBuffer,
      Number,
      Reflect,
      WeakMap,
      Error,
    },
    { filename: 'railgun-platform-host.js' }
  );
  return {
    factory: module.exports.createRailgunPlatformHost,
    child,
    worker,
    WorkerMock,
    electron,
    samples,
    processMock,
    resolver,
    imports,
  };
}
const utility = (heapMb = 256) => ({ entry: 'railgun-utility-v1', heapMb });
function storage(readOnly = false) {
  const key = new Uint8Array(32).fill(10);
  return {
    workerData: {
      profileId: 'public-synthetic-profile',
      subject: {
        kind: 'private-account',
        principal: 'railgun:0',
        chainId: 11155111,
        protocol: 'railgun',
        deployment: 'sepolia',
        role: 'engine',
      },
      requirements: { origin: 'tor', content: 'public', correctness: 'any', maxAgeMs: null },
      ...(readOnly ? { readOnly: true } : {}),
      storage: {
        filename: '/public-synthetic/wallet',
        key,
        binding: 'a'.repeat(64),
        create: !readOnly,
        format: 'paged-v2',
      },
      revoked: new SharedArrayBuffer(8),
    },
    transferList: [key.buffer],
  };
}

describe('fixed Railgun platform host', () => {
  test('exports only the closed inactive host port and imports no owner authority', () => {
    const m = load();
    const port = m.factory();
    expect(Object.keys(port)).toEqual([
      'spawnUtility',
      'createUtilityChannel',
      'memorySamples',
      'terminateUtility',
      'spawnStorageWorker',
    ]);
    expect(Object.isFrozen(port)).toBe(true);
    expect(m.imports).toEqual(['path', 'util', 'events', 'worker_threads', 'electron']);
    expect(m.resolver).not.toHaveBeenCalled();
    expect(m.electron.utilityProcess.fork).not.toHaveBeenCalled();
  });
  test.each([{ type: 'renderer' }, { type: 'utility' }, { mainThread: false }])(
    'refuses the wrong realm before Electron load: %p',
    (options) => {
      const m = load(options);
      expect(() => m.factory()).toThrow(REFUSED);
      expect(m.imports).not.toContain('electron');
    }
  );
  test('does not accept initialization injection', () => {
    expect(() => load().factory({ fork() {} })).toThrow(REFUSED);
  });
  test.each([16, 256, 1024])('preserves exact original utility options at heap %i', (heapMb) => {
    const m = load({ type: 'browser' });
    const port = m.factory();
    expect(port.spawnUtility(utility(heapMb))).toBe(m.child);
    expect(m.resolver).toHaveBeenCalledWith('./railgun-owner-utility-entry');
    expect(m.electron.utilityProcess.fork).toHaveBeenCalledWith(
      '/fixed/railgun-owner-utility-entry.js',
      [],
      {
        env: { PATH: '', PUBLIC_TEST: '' },
        cwd: '/public-temp',
        stdio: 'ignore',
        execArgv: [`--max-old-space-size=${heapMb}`],
        serviceName: 'Freedom Railgun engine',
      }
    );
    expect(m.electron.utilityProcess.fork.mock.contexts[0]).toBe(m.electron.utilityProcess);
    expect(m.electron.app.getPath).toHaveBeenCalledWith('temp');
    expect(m.child.listenerCount('message')).toBe(0);
    expect(m.child.listenerCount('error')).toBe(0);
  });
  test.each([15, 1025, -0, 16.5, NaN, Infinity, '256', null])(
    'rejects heap %p before any entry lookup',
    (heapMb) => {
      const m = load();
      expect(() => m.factory().spawnUtility(utility(heapMb))).toThrow(REFUSED);
      expect(m.resolver).not.toHaveBeenCalled();
    }
  );
  test.each([
    'filename',
    'job',
    'purpose',
    'binaryKey',
    'broker',
    'input',
    'onMessage',
    'env',
    'argv',
    'cwd',
    'execArgv',
  ])('does not admit caller %s', (field) => {
    const m = load();
    expect(() => m.factory().spawnUtility({ ...utility(), [field]: 'forbidden' })).toThrow(REFUSED);
    expect(m.electron.utilityProcess.fork).not.toHaveBeenCalled();
  });
  test('rejects alternative entry, getters, proxies, symbols and positional extras without invocation', () => {
    const m = load(),
      port = m.factory(),
      trap = jest.fn(() => {
        throw new Error('trap');
      });
    for (const input of [
      { ...utility(), entry: 'legacy' },
      { ...utility(), [Symbol('extra')]: 1 },
      Object.defineProperty(utility(), 'heapMb', { get: trap }),
      new Proxy(utility(), { getPrototypeOf: trap, ownKeys: trap }),
    ])
      expect(() => port.spawnUtility(input)).toThrow(REFUSED);
    expect(() => port.spawnUtility(utility(), undefined)).toThrow(REFUSED);
    expect(trap).not.toHaveBeenCalled();
  });
  test('unready utility/channel/metrics refuse before OS work', () => {
    const m = load(),
      port = m.factory();
    m.electron.app.isReady.mockReturnValue(false);
    for (const call of [
      () => port.spawnUtility(utility()),
      () => port.createUtilityChannel(),
      () => port.memorySamples(),
    ])
      expect(call).toThrow(REFUSED);
    expect(m.resolver).not.toHaveBeenCalled();
    expect(m.electron.app.getAppMetrics).not.toHaveBeenCalled();
  });
  test('returns original channel and metric objects; captures Electron originals once', () => {
    const m = load(),
      port = m.factory(),
      other = m.factory();
    const fork = m.electron.utilityProcess.fork,
      metrics = m.electron.app.getAppMetrics,
      Channel = m.electron.MessageChannelMain;
    m.electron.utilityProcess.fork = () => {
      throw new Error('replacement');
    };
    m.electron.app.getAppMetrics = () => {
      throw new Error('replacement');
    };
    m.electron.MessageChannelMain = () => {
      throw new Error('replacement');
    };
    expect(other.spawnUtility(utility())).toBe(m.child);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(port.memorySamples()).toBe(m.samples);
    expect(metrics.mock.contexts[0]).toBe(m.electron.app);
    const channel = port.createUtilityChannel();
    expect(channel).toBe(Channel.mock.instances[0]);
    expect(m.imports.filter((name) => name === 'electron')).toHaveLength(1);
    expect(() => port.createUtilityChannel(1)).toThrow(REFUSED);
    expect(() => port.memorySamples(1)).toThrow(REFUSED);
  });
  test('missing fixed entries fail without legacy fallback or key transfer', () => {
    const m = load({ missing: true }),
      port = m.factory(),
      input = storage();
    expect(() => port.spawnUtility(utility())).toThrow(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' })
    );
    expect(() => port.spawnStorageWorker(input)).toThrow(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' })
    );
    expect(input.workerData.storage.key.byteLength).toBe(32);
    expect(m.electron.utilityProcess.fork).not.toHaveBeenCalled();
    expect(m.WorkerMock).not.toHaveBeenCalled();
    expect(m.resolver.mock.calls.map(([name]) => name)).toEqual([
      './railgun-owner-utility-entry',
      './railgun-owner-storage-entry',
    ]);
  });
  test('preserves original spawn and metric failures', () => {
    const m = load(),
      port = m.factory(),
      error = new Error('original failure');
    m.electron.utilityProcess.fork.mockImplementation(() => {
      throw error;
    });
    m.electron.app.getAppMetrics.mockImplementation(() => {
      throw error;
    });
    m.WorkerMock.mockImplementation(() => {
      throw error;
    });
    for (const call of [
      () => port.spawnUtility(utility()),
      () => port.memorySamples(),
      () => port.spawnStorageWorker(storage()),
    ]) {
      try {
        call();
        throw new Error('unexpected success');
      } catch (caught) {
        expect(caught).toBe(error);
      }
    }
  });
  test("POSIX signals only this port's unchanged live original child using captured kill", () => {
    const m = load(),
      port = m.factory(),
      kill = m.processMock.kill;
    port.spawnUtility(utility());
    m.processMock.kill = () => {
      throw new Error('replacement');
    };
    expect(port.terminateUtility(m.child, 'SIGTERM')).toBe(true);
    expect(port.terminateUtility(m.child, 'SIGKILL')).toBe(true);
    expect(kill.mock.calls).toEqual([
      [1234, 'SIGTERM'],
      [1234, 'SIGKILL'],
    ]);
    expect(kill.mock.contexts[0]).toBe(m.processMock);
    expect(() => port.terminateUtility(new EventEmitter(), 'SIGTERM')).toThrow(REFUSED);
    expect(() => m.factory().terminateUtility(m.child, 'SIGTERM')).toThrow(REFUSED);
    expect(() => port.terminateUtility(m.child, 'SIGINT')).toThrow(REFUSED);
    expect(() => port.terminateUtility(m.child, 'SIGTERM', null)).toThrow(REFUSED);
    m.child.pid = 999;
    expect(() => port.terminateUtility(m.child, 'SIGKILL')).toThrow(REFUSED);
    m.child.emit('spawn');
    expect(() => port.terminateUtility(m.child, 'SIGKILL')).toThrow(REFUSED);
    m.child.pid = 1234;
    m.child.emit('exit', 0);
    expect(() => port.terminateUtility(m.child, 'SIGTERM')).toThrow(REFUSED);
    expect(kill).toHaveBeenCalledTimes(2);
  });
  test('observes late PID from original spawn, never fabricates a PID', () => {
    const m = load({ pid: null }),
      port = m.factory();
    port.spawnUtility(utility());
    expect(() => port.terminateUtility(m.child, 'SIGTERM')).toThrow(REFUSED);
    m.child.pid = 1234;
    m.child.emit('spawn');
    port.terminateUtility(m.child, 'SIGTERM');
    expect(m.processMock.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
  });
  test('Windows uses original child kill for TERM and process kill for escalation', () => {
    const m = load({ platform: 'win32' }),
      port = m.factory(),
      childKill = m.child.kill;
    port.spawnUtility(utility());
    m.child.kill = () => {
      throw new Error('replacement');
    };
    expect(port.terminateUtility(m.child, 'SIGTERM')).toBe('terminated');
    expect(childKill.mock.contexts[0]).toBe(m.child);
    port.terminateUtility(m.child, 'SIGKILL');
    expect(m.processMock.kill).toHaveBeenCalledWith(1234, 'SIGKILL');
  });
  test.each([false, true])(
    'preserves exact storage data and worker options (readOnly=%p)',
    (readOnly) => {
      const m = load(),
        input = storage(readOnly),
        port = m.factory();
      expect(port.spawnStorageWorker(input)).toBe(m.worker);
      const [entry, options] = m.WorkerMock.mock.calls[0];
      expect(entry).toBe('/fixed/railgun-owner-storage-entry.js');
      expect(options).toEqual({
        ...input,
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      expect(options.workerData).not.toBe(input.workerData);
      expect(options.workerData.subject).not.toBe(input.workerData.subject);
      expect(options.workerData.requirements).not.toBe(input.workerData.requirements);
      expect(options.workerData.storage).not.toBe(input.workerData.storage);
      expect(options.workerData.storage.key).toBe(input.workerData.storage.key);
      expect(options.workerData.revoked).toBe(input.workerData.revoked);
      expect(options.transferList[0]).toBe(input.workerData.storage.key.buffer);
      // The package supervisor still owns stream draining and original exit listeners.
      expect(m.worker.stdout.resume).not.toHaveBeenCalled();
    }
  );
  test.each([
    [
      'top callback',
      (i) => {
        i.onClose = () => {};
      },
    ],
    [
      'data extra',
      (i) => {
        i.workerData.handle = {};
      },
    ],
    [
      'subject operation',
      (i) => {
        i.workerData.subject.operation = null;
      },
    ],
    [
      'subject kind',
      (i) => {
        i.workerData.subject.kind = 'public-address';
      },
    ],
    [
      'subject role',
      (i) => {
        i.workerData.subject.role = 'keystore';
      },
    ],
    [
      'subject chain',
      (i) => {
        i.workerData.subject.chainId = 1;
      },
    ],
    [
      'subject protocol',
      (i) => {
        i.workerData.subject.protocol = 'other';
      },
    ],
    [
      'profile',
      (i) => {
        i.workerData.profileId = '';
      },
    ],
    [
      'requirements origin',
      (i) => {
        i.workerData.requirements.origin = 'direct';
      },
    ],
    [
      'requirements content',
      (i) => {
        i.workerData.requirements.content = 'private';
      },
    ],
    [
      'requirements age',
      (i) => {
        i.workerData.requirements.maxAgeMs = -0;
      },
    ],
    [
      'relative filename',
      (i) => {
        i.workerData.storage.filename = 'wallet';
      },
    ],
    [
      'unnormalized filename',
      (i) => {
        i.workerData.storage.filename = '/public/../wallet';
      },
    ],
    [
      'format',
      (i) => {
        i.workerData.storage.format = 'other';
      },
    ],
    [
      'binding',
      (i) => {
        i.workerData.storage.binding = 'A'.repeat(64);
      },
    ],
    [
      'create',
      (i) => {
        i.workerData.storage.create = 1;
      },
    ],
    [
      'storage readOnly',
      (i) => {
        i.workerData.storage.readOnly = true;
      },
    ],
    [
      'readOnly false',
      (i) => {
        i.workerData.readOnly = false;
      },
    ],
    [
      'readOnly create',
      (i) => {
        i.workerData.readOnly = true;
      },
    ],
    [
      'short key',
      (i) => {
        i.workerData.storage.key = new Uint8Array(31);
      },
    ],
    [
      'shared key',
      (i) => {
        i.workerData.storage.key = new Uint8Array(new SharedArrayBuffer(32));
        i.transferList = [i.workerData.storage.key.buffer];
      },
    ],
    [
      'offset key',
      (i) => {
        i.workerData.storage.key = new Uint8Array(new ArrayBuffer(33), 1);
        i.transferList = [i.workerData.storage.key.buffer];
      },
    ],
    [
      'oversized backing',
      (i) => {
        i.workerData.storage.key = new Uint8Array(new ArrayBuffer(64), 0, 32);
        i.transferList = [i.workerData.storage.key.buffer];
      },
    ],
    [
      'Buffer key',
      (i) => {
        i.workerData.storage.key = Buffer.alloc(32);
        i.transferList = [i.workerData.storage.key.buffer];
      },
    ],
    [
      'extra key property',
      (i) => {
        i.workerData.storage.key.extra = true;
      },
    ],
    [
      'nonshared revoked',
      (i) => {
        i.workerData.revoked = new ArrayBuffer(8);
      },
    ],
    [
      'wrong revoked size',
      (i) => {
        i.workerData.revoked = new SharedArrayBuffer(4);
      },
    ],
    [
      'wrong transfer',
      (i) => {
        i.transferList = [new ArrayBuffer(32)];
      },
    ],
    [
      'duplicate transfer',
      (i) => {
        i.transferList.push(i.transferList[0]);
      },
    ],
    [
      'extra transfer property',
      (i) => {
        i.transferList.extra = 1;
      },
    ],
  ])('refuses storage %s before worker construction', (_name, mutate) => {
    const m = load(),
      input = storage();
    mutate(input);
    expect(() => m.factory().spawnStorageWorker(input)).toThrow(REFUSED);
    expect(m.WorkerMock).not.toHaveBeenCalled();
    expect(m.resolver).not.toHaveBeenCalled();
  });
  test('rejects nested getters/proxies and detached buffers without invoking code', () => {
    const trap = jest.fn(() => {
      throw new Error('getter');
    });
    for (const mutate of [
      (i) => {
        i.workerData = new Proxy(i.workerData, { ownKeys: trap });
      },
      (i) => {
        Object.defineProperty(i.workerData.storage, 'key', { get: trap });
      },
      (i) => {
        Object.defineProperty(i.transferList, '0', { get: trap });
      },
      (i) => {
        structuredClone(i.workerData.storage.key, { transfer: i.transferList });
      },
    ]) {
      const m = load(),
        input = storage();
      mutate(input);
      expect(() => m.factory().spawnStorageWorker(input)).toThrow(REFUSED);
      expect(m.WorkerMock).not.toHaveBeenCalled();
    }
    expect(trap).not.toHaveBeenCalled();
  });
  test('real disposable worker transfers one synthetic key and observes original exit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-platform-public-worker-'));
    const workerEntry = path.join(directory, 'fixed-test-storage-entry.cjs');
    fs.writeFileSync(
      workerEntry,
      `const {parentPort, workerData} = require('worker_threads');
const valid = workerData.storage.key instanceof Uint8Array && workerData.storage.key.length === 32 && workerData.storage.key.every(x => x === 10);
workerData.storage.key.fill(0);
Atomics.store(new Int32Array(workerData.revoked), 1, 7);
parentPort.postMessage({valid, wiped: workerData.storage.key.every(x => x === 0), env: Object.keys(process.env), execArgv: process.execArgv});
parentPort.close();\n`,
      { flag: 'wx', mode: 0o600 }
    );
    const m = load({ Worker, workerEntry }),
      input = storage();
    const worker = m.factory().spawnStorageWorker(input);
    expect(worker).toBeInstanceOf(Worker);
    expect(input.workerData.storage.key.byteLength).toBe(0);
    worker.stdout.resume();
    worker.stderr.resume();
    const message = new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const exit = new Promise((resolve, reject) => {
      worker.once('exit', resolve);
      worker.once('error', reject);
    });
    expect(await message).toEqual({ valid: true, wiped: true, env: [], execArgv: [] });
    expect(await exit).toBe(0);
    expect(Atomics.load(new Int32Array(input.workerData.revoked), 1)).toBe(7);
  });
});
