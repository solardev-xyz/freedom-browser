const { EventEmitter } = require('events');
const mockFork = jest.fn();
const mockApp = new EventEmitter();
mockApp.isReady = () => true;
mockApp.getPath = () => '/tmp';
mockApp.getAppMetrics = () => [];
jest.mock('electron', () => ({ app: mockApp, utilityProcess: { fork: mockFork } }));
const { createPrivacyScope } = require('../networks/privacy-context');
const { runPrivacyProcess } = require('./privacy-process');
let scope, handle, child, args;
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'process-fixture', signal: new AbortController().signal });
  handle = scope.getContext({ kind: 'private-account', principal: 'fixture', protocol: 'ppv2-fixture', deployment: 'fixture', chainId: 11155111, role: 'prover' });
  child = new EventEmitter(); child.pid = 123456789; child.kill = jest.fn(() => true); child.postMessage = jest.fn();
  mockFork.mockReset().mockReturnValue(child);
  args = { handle, filename: '/tmp/reviewed-fixture.cjs', input: { value: 1 }, validateResult: (value) => value?.valid === true };
});
afterEach(() => { scope.close(); jest.restoreAllMocks(); });

test('a result is held until exit, with no inherited environment or command-line input', async () => {
  let settled = false;
  const task = runPrivacyProcess(args).then((result) => { settled = true; return result; });
  child.emit('spawn');
  expect(mockFork.mock.calls[0][1]).toEqual([]);
  expect(mockFork.mock.calls[0][2]).toMatchObject({ stdio: 'ignore', execArgv: ['--max-old-space-size=256'] });
  expect(Object.keys(mockFork.mock.calls[0][2].env).sort()).toEqual(Object.keys(process.env).sort());
  expect(Object.values(mockFork.mock.calls[0][2].env).every((value) => value === '')).toBe(true);
  expect(child.postMessage).toHaveBeenCalledWith({ filename: args.filename, input: args.input });
  child.emit('message', { type: 'result', value: { valid: true } });
  await Promise.resolve(); expect(settled).toBe(false);
  expect(child.kill).toHaveBeenCalled();
  child.emit('exit', 0);
  expect(await task).toEqual({ result: { valid: true }, peakRssBytes: 0 });
});

test('lock after a result but before exit discards it and retains capacity until termination', async () => {
  const task = runPrivacyProcess(args);
  const checked = expect(task).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  child.emit('message', { type: 'result', value: { valid: true } });
  scope.close(); child.emit('exit', 0); await checked;
});

test.each(['failure', 'invalid', 'crash'])('%s produces a fixed failure, never a child diagnostic', async (mode) => {
  const task = runPrivacyProcess(args);
  const checked = expect(task).rejects.toMatchObject({ code: 'PRIVATE_PROCESS_FAILED', message: 'Private computation could not complete' });
  if (mode === 'failure') child.emit('message', { type: 'failure', error: 'sensitive detail' });
  if (mode === 'invalid') child.emit('message', { type: 'result', value: { sensitive: 'detail' } });
  child.emit('exit', 1); await checked;
});

test('cancellation before spawn sends no input, and graceful shutdown escalates to SIGKILL', async () => {
  jest.useFakeTimers();
  const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
  const controller = new AbortController(); child.pid = undefined;
  const task = runPrivacyProcess({ ...args, signal: controller.signal });
  const checked = expect(task).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  controller.abort(); child.pid = 123456789; child.emit('spawn');
  expect(child.postMessage).not.toHaveBeenCalled();
  jest.advanceTimersByTime(250);
  expect(kill).toHaveBeenCalledWith(child.pid, 'SIGKILL');
  child.emit('exit', 1); await checked; jest.useRealTimers();
});

test('observed RSS excess stops the process and cannot be overridden by a late result', async () => {
  jest.useFakeTimers();
  jest.spyOn(mockApp, 'getAppMetrics').mockReturnValue([{ pid: child.pid, memory: { workingSetSize: 800 * 1024 } }]);
  const task = runPrivacyProcess(args);
  const checked = expect(task).rejects.toMatchObject({ code: 'PRIVATE_PROCESS_MEMORY_LIMIT' });
  jest.advanceTimersByTime(100);
  child.emit('message', { type: 'result', value: { valid: true } });
  child.emit('exit', 1); await checked; jest.useRealTimers();
});

test('the capacity limit counts stopping children until their exit events', async () => {
  const second = new EventEmitter(); second.pid = 123456788; second.kill = jest.fn(); second.postMessage = jest.fn();
  mockFork.mockReturnValueOnce(child).mockReturnValueOnce(second);
  const controller = new AbortController();
  const firstTask = runPrivacyProcess({ ...args, signal: controller.signal });
  const secondTask = runPrivacyProcess(args);
  const settled = Promise.allSettled([firstTask, secondTask]);
  controller.abort();
  expect(() => runPrivacyProcess(args)).toThrow(expect.objectContaining({ code: 'PRIVATE_PROCESS_BUSY' }));
  child.emit('exit', 1);
  second.emit('message', { type: 'result', value: { valid: true } }); second.emit('exit', 0);
  expect((await settled).map((entry) => entry.status)).toEqual(['rejected', 'fulfilled']);
});

test('invalid configurations and a pre-cancelled caller cannot start a child', async () => {
  for (const changes of [{ filename: 12 }, { filename: 'relative.cjs' }, { heapMb: 0 }, { rssMb: 0 }, { timeoutMs: 0 }, { validateResult: null }]) {
    expect(() => runPrivacyProcess({ ...args, ...changes })).toThrow(expect.objectContaining({ code: 'PRIVATE_PROCESS_INVALID' }));
  }
  const controller = new AbortController(); controller.abort();
  await expect(runPrivacyProcess({ ...args, signal: controller.signal })).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect(mockFork).not.toHaveBeenCalled();
});

test('application quit and overlarge messages fail closed', async () => {
  const first = runPrivacyProcess(args);
  const checked = expect(first).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  mockApp.emit('before-quit'); child.emit('exit', 1); await checked;
  const second = runPrivacyProcess(args);
  const oversized = expect(second).rejects.toMatchObject({ code: 'PRIVATE_PROCESS_FAILED' });
  child.emit('message', { type: 'result', value: { valid: true, bytes: Buffer.alloc(1024 * 1024) } });
  child.emit('exit', 1); await oversized;
});
