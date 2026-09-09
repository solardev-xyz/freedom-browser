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

test('rejects host Node, wrong Electron and missing runtime opt-in', () => {
  const runtime = { env: { ELECTRON_RUN_AS_NODE: '1', FREEDOM_MYOTIS_DISPOSABLE: '1' },
    versions: { electron: '43.0.0' }, platform: 'linux' };
  expect(() => requireRuntime(runtime)).not.toThrow();
  expect(() => requireRuntime({ ...runtime, versions: {} })).toThrow('Electron 43');
  expect(() => requireRuntime({ ...runtime, versions: { electron: '42.0.0' } })).toThrow('Electron 43');
  expect(() => requireRuntime({ ...runtime, platform: 'win32' })).toThrow('Windows x64');
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
  expect(() => validateTerminal(value, true, 'linux')).not.toThrow();
  value.terminalReceipt.signal = 0;
  expect(() => validateTerminal(value, true, 'linux')).toThrow();
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


test('Windows Node qualification is explicit, x64-only and never labeled Electron', () => {
  const runtime = { env: { ELECTRON_RUN_AS_NODE: '1', FREEDOM_MYOTIS_DISPOSABLE: '1',
    FREEDOM_MYOTIS_NODE_QUALIFICATION: '1' }, versions: { node: '24.17.0' }, platform: 'win32', arch: 'x64' };
  expect(() => requireRuntime(runtime)).not.toThrow();
  expect(() => requireRuntime({ ...runtime, versions: { node: '22.20.0' } })).not.toThrow();
  expect(() => requireRuntime({ ...runtime, arch: 'arm64' })).toThrow('Windows x64');
  expect(() => requireRuntime({ ...runtime, versions: { node: '20.20.0' } })).toThrow('preinstalled');
  expect(() => requireRuntime({ ...runtime, versions: { node: '24.17.0', electron: '43.0.0' } })).toThrow('not Electron');
  expect(() => requireRuntime({ ...runtime, env: { ...runtime.env, FREEDOM_MYOTIS_NODE_QUALIFICATION: '' } })).toThrow('Node-only');
});

test('Windows forced receipt requires both explicit force evidence and its native exit code', () => {
  const value = terminal();
  value.terminalReceipt = { generation: 'current', exitCode: 1, signal: 0, forced: true };
  expect(() => validateTerminal(value, true, 'win32')).not.toThrow();
  value.terminalReceipt.forced = false;
  expect(() => validateTerminal(value, true, 'win32')).toThrow();
  value.terminalReceipt.forced = true;
  value.terminalReceipt.signal = 9;
  expect(() => validateTerminal(value, true, 'win32')).toThrow();
  value.terminalReceipt.signal = 0;
  value.terminalReceipt.exitCode = 78;
  expect(() => validateTerminal(value, true, 'win32')).toThrow();
  expect(() => validateTerminal(terminal(), false, 'win32')).not.toThrow();
});
