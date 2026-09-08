// Pure validation tests only. No fixture, Electron or supervisor is launched.
const { parseArguments, validateTerminal, requireRuntime, controllerOptions } = require('./qualify-myotis-supervisor');

function terminal() {
  return { exited: true, generation: 'current', supervisorExit: { code: 0, signal: null },
    terminalReceipt: { generation: 'current', exitCode: 0, signal: 0, forced: false } };
}

test('requires explicit disposable opt-in, fixed argument shape and absolute evidence root', () => {
  expect(() => parseArguments(['--evidence-dir', '/tmp/case'])).toThrow();
  expect(() => parseArguments(['--disposable', '--evidence-dir', 'relative'])).toThrow();
  expect(() => parseArguments(['--disposable', '--evidence-dir', '/tmp/case', '--extra'])).toThrow();
  expect(parseArguments(['--disposable', '--evidence-dir', '/tmp/case'])).toBe('/tmp/case');
});

test('rejects host Node, wrong Electron, Windows and missing runtime opt-in', () => {
  const runtime = { env: { ELECTRON_RUN_AS_NODE: '1', FREEDOM_MYOTIS_DISPOSABLE: '1' },
    versions: { electron: '43.0.0' }, platform: 'linux' };
  expect(() => requireRuntime(runtime)).not.toThrow();
  expect(() => requireRuntime({ ...runtime, versions: {} })).toThrow('Electron 43');
  expect(() => requireRuntime({ ...runtime, versions: { electron: '42.0.0' } })).toThrow('Electron 43');
  expect(() => requireRuntime({ ...runtime, platform: 'win32' })).toThrow('POSIX');
  expect(() => requireRuntime({ ...runtime, env: { ELECTRON_RUN_AS_NODE: '1' } })).toThrow('opt-in');
});

test('cannot turn disconnect, unknown supervisor exit, stale receipt, or fixture expiry into a pass', () => {
  expect(() => validateTerminal(terminal(), false)).not.toThrow();
  for (const modify of [
    (value) => { value.exited = false; },
    (value) => { value.supervisorExit.signal = 'SIGKILL'; },
    (value) => { value.terminalReceipt.generation = 'old'; },
    (value) => { value.terminalReceipt.exitCode = 78; },
    (value) => { value.terminalReceipt.forced = true; },
  ]) {
    const value = terminal(); modify(value);
    expect(() => validateTerminal(value, false)).toThrow();
  }
});

test('forced termination needs its own evidence and actual signal outcome', () => {
  const value = terminal();
  value.terminalReceipt = { generation: 'current', exitCode: -1, signal: 9, forced: true };
  expect(() => validateTerminal(value, true)).not.toThrow();
  value.terminalReceipt.signal = 0;
  expect(() => validateTerminal(value, true)).toThrow();
});


test('group-signal controller requires a new POSIX session while retaining IPC observation', () => {
  const options = controllerOptions(true);
  expect(options.detached).toBe(true);
  expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
  expect(options.execPath).toBe(process.execPath);
  expect(options.execArgv).toEqual([]);
  expect(options.env).not.toHaveProperty('NODE_OPTIONS');
  expect(controllerOptions(false).detached).toBe(false);
});
