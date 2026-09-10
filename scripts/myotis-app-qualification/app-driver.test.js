// VM-only checks: all app, manager, filesystem, timers and menu actions mocked.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const source = fs.readFileSync(path.join(__dirname, 'app-driver.cjs'), 'utf8');

function setup() {
  const files = new Map();
  const descriptors = new Map();
  const events = [];
  const logger = { hooks: [] };
  const app = new EventEmitter();
  app.getAppPath = () => '/app';
  const menu = { sendActionToFirstResponder: jest.fn(() => events.push('menu')) };
  const manager = {
    startMyotis: jest.fn(async () => true),
    getStatus: jest.fn(() => ({ beaconState: 'CATCHING_UP', currentPeriod: 1840 })),
    publicStatus: jest.fn(() => ({ running: true, state: 'syncing' })),
    getAccount: jest.fn(async () => ({ status: 'unavailable', reason: 'sensitive detail' })),
  };
  const io = {
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    realpathSync: (value) => value,
    existsSync: (file) => files.has(file),
    writeFileSync: jest.fn((file, text) => {
      if (files.has(file)) throw new Error('EEXIST');
      files.set(file, text); events.push(path.basename(file));
    }),
    openSync: (file) => {
      if (files.has(file)) throw new Error('EEXIST');
      files.set(file, '');
      const fd = descriptors.size + 1; descriptors.set(fd, file); return fd;
    },
    ftruncateSync: (fd) => files.set(descriptors.get(fd), ''),
    writeSync: (fd, text) => files.set(descriptors.get(fd), files.get(descriptors.get(fd)) + text),
    closeSync: jest.fn(),
  };
  const requireMock = jest.fn((name) => {
    if (name === 'fs') return io;
    if (name === 'path') return path;
    if (name === 'electron') return { app, Menu: menu };
    if (name === '/app/src/main/logger.js') return logger;
    if (name === '/app/src/main/myotis/myotis-manager.js') return manager;
    throw new Error(`Unexpected import: ${name}`);
  });
  const sandbox = { module: { exports: {} }, require: requireMock, process: { platform: 'darwin' },
    Buffer, Date, setTimeout, clearTimeout };
  vm.runInNewContext(source, sandbox);
  return { driver: sandbox.module.exports, requireMock, manager, files, events, logger, menu, app, io,
    options: { runId: 'mock-run', evidenceDir: '/evidence', deadlineAtMs: Date.now() + 45000 } };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('import has no effects; one read preserves unavailable semantics and orders single native Quit', async () => {
  const h = setup();
  expect(h.requireMock).not.toHaveBeenCalled();
  const pending = h.driver.run(h.options);
  await jest.advanceTimersByTimeAsync(1500);
  const result = await pending;
  expect(h.manager.startMyotis).toHaveBeenCalledTimes(1);
  expect(h.manager.getAccount).toHaveBeenCalledTimes(1);
  expect(h.manager.getAccount).toHaveBeenCalledWith('0x0000000000000000000000000000000000000000', 1);
  expect(result.read).toEqual({ kind: 'unavailable', verifiedFlag: false, hasReason: true });
  expect(result.timingScope).toBe('outer-launch-deadline');
  expect(result.actualOsExitObserved).toBe(false);
  expect(h.events).toEqual(['driver-result.json', 'native-quit-request.json', 'menu', 'native-quit-returned.json']);
  expect(h.menu.sendActionToFirstResponder).toHaveBeenCalledWith('terminate:');
  expect([...h.files.values()].join('')).not.toContain('sensitive detail');
  h.driver.requestNativeQuit({ ...h.options, reason: 'outer-fallback' });
  expect(h.menu.sendActionToFirstResponder).toHaveBeenCalledTimes(1);
  await expect(h.driver.run(h.options)).rejects.toThrow('already invoked');
});

test('remaining launch deadline bounds pending read, with no retry or fabricated completion', async () => {
  const h = setup();
  h.manager.getAccount.mockImplementation(() => new Promise(() => {}));
  const pending = h.driver.run({ ...h.options, deadlineAtMs: Date.now() + 2000 });
  await jest.advanceTimersByTimeAsync(2000);
  const result = await pending;
  expect(result.read.kind).toBe('driver-deadline');
  expect(result.elapsedSinceEntryMs).toBe(2000);
  expect(h.manager.getAccount).toHaveBeenCalledTimes(1);
  expect(h.menu.sendActionToFirstResponder).toHaveBeenCalledTimes(1);
});

test('startup false still records exactly one rejected read; already-expired budget starts no work', async () => {
  const h = setup();
  h.manager.startMyotis.mockResolvedValue(false);
  h.manager.getAccount.mockRejectedValue(new Error('native secret'));
  const pending = h.driver.run(h.options);
  await jest.advanceTimersByTimeAsync(1500);
  expect((await pending).read.kind).toBe('operation-rejected');
  expect(h.manager.getAccount).toHaveBeenCalledTimes(1);
  const expired = setup();
  const result = await expired.driver.run({ ...expired.options, deadlineAtMs: Date.now() - 1 });
  expect(result.failure).toBe('driver-deadline');
  expect(expired.manager.startMyotis).not.toHaveBeenCalled();
  expect(expired.manager.getAccount).not.toHaveBeenCalled();
  expect(expired.menu.sendActionToFirstResponder).toHaveBeenCalledTimes(1);
});

test('responsive fallback shares the claim with a pending driver and prevents later new work', async () => {
  const h = setup();
  let finishStart;
  h.manager.startMyotis.mockImplementation(() => new Promise((resolve) => { finishStart = resolve; }));
  const pending = h.driver.run(h.options);
  await jest.advanceTimersByTimeAsync(1);
  h.driver.requestNativeQuit({ ...h.options, reason: 'outer-fallback' });
  finishStart(true);
  await pending;
  expect(h.manager.getAccount).not.toHaveBeenCalled();
  expect(h.menu.sendActionToFirstResponder).toHaveBeenCalledTimes(1);
});

test('failed marker persistence never invokes action; thrown action never fabricates returned marker', async () => {
  const h = setup();
  h.io.writeFileSync.mockImplementation(() => { throw new Error('storage failure'); });
  expect(() => h.driver.requestNativeQuit(h.options)).toThrow('storage failure');
  expect(h.menu.sendActionToFirstResponder).not.toHaveBeenCalled();
  expect(h.driver.requestNativeQuit(h.options).alreadyClaimed).toBe(true);
  const other = setup();
  other.menu.sendActionToFirstResponder.mockImplementation(() => { throw new Error('action failed'); });
  expect(() => other.driver.requestNativeQuit(other.options)).toThrow('action failed');
  expect(other.files.has('/evidence/native-quit-request.json')).toBe(true);
  expect(other.files.has('/evidence/native-quit-returned.json')).toBe(false);
});

test('lifecycle capture deduplicates transports, filters raw text, and survives through Quit request', async () => {
  const h = setup();
  const pending = h.driver.run(h.options);
  const event = { generation: '00000000-0000-0000-0000-000000000001', event: 'supervisor-exit',
    classification: 'verified', receipt: 'reaped', code: 0, childExitCode: 0, childSignal: 0, forced: false,
    message: 'secret addon line' };
  const message = { data: ['[myotis] mainnet lifecycle ' + JSON.stringify(event)] };
  const hook = h.logger.hooks[0];
  expect(hook(message)).toBe(message);
  hook(message);
  hook({ data: ['unbounded unrelated secret'] });
  await jest.advanceTimersByTimeAsync(1500);
  await pending;
  expect(h.logger.hooks).toHaveLength(1);
  const recorded = h.files.get('/evidence/lifecycle.jsonl').trim().split('\n');
  expect(recorded).toHaveLength(1);
  expect(JSON.parse(recorded[0]).generation).toBe(event.generation);
  expect(recorded[0]).not.toContain('secret');
  h.app.emit('will-quit');
  expect(h.logger.hooks).toHaveLength(0);
});
