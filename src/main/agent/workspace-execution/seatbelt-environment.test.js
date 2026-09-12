'use strict';

// Exercise environment handoff without a filesystem fixture or native process.
jest.mock('fs', () => ({
  existsSync: () => false,
  realpathSync: value => value,
  promises: {
    mkdtemp: jest.fn(async prefix => prefix + 'test'),
    chmod: jest.fn(async () => {}), mkdir: jest.fn(async () => {}),
    realpath: jest.fn(async value => value), writeFile: jest.fn(async () => {}),
  },
}));
jest.mock('child_process', () => ({
  spawn: jest.fn(() => { throw new Error('Unexpected native launch'); }),
  execFile: jest.fn(() => { throw new Error('Unexpected native probe'); }),
  execFileSync: jest.fn(() => { throw new Error('Unexpected native probe'); }),
}));
jest.mock('./execution-policy', () => ({
  ...jest.requireActual('./execution-policy'),
  isValidatedWorkspaceExecutionPolicy: policy => policy.testIssued === true,
}));
jest.mock('./macos-supervisor-process', () => ({ runMacosSupervisor: jest.fn() }));
jest.mock('./macos-supervisor-runtime', () => ({
  resolveMacosSupervisor: jest.fn(), assertSupervisorOutsideWritableRoots: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runMacosSupervisor } = require('./macos-supervisor-process');
const { SeatbeltExecutor } = require('./seatbelt-backend');

beforeEach(() => {
  jest.clearAllMocks();
  runMacosSupervisor.mockResolvedValue({
    spawned: true, requested: null, stdout: '', stderr: '', diagnostics: {},
    stdoutTruncated: false, stderrTruncated: false,
    final: { reason: 'completed', exitCode: 0, signal: null, spawned: true,
      releaseIssued: true, rootExitObserved: true, rootReaped: true,
      groupVerified: true, cleanupUncertain: false, signalErrors: [] },
  });
});

test.each([
  { set: {}, polling: 'true', interval: '250' },
  { set: { CHOKIDAR_USEPOLLING: 'false', CHOKIDAR_INTERVAL: '1000' }, polling: 'false', interval: '1000' },
])('passes watcher defaults and explicit overrides to the supervised command: $polling/$interval', async ({ set, polling, interval }) => {
  const values = Object.freeze({ ...set, PUBLIC_FLAG: 'fixture', HOME: '/host-home', PATH: '/host-path' });
  const policy = {
    testIssued: true, network: 'none', seccomp: { requireCustomFilter: false },
    filesystem: { writableRoots: [{ id: 'workspace', sourcePath: '/managed/workspace' }],
      runtimeRoots: [], protectedPaths: [], exposeSystemToolchain: false },
    environment: { values }, workingDirectory: '/workspace',
    limits: { timeoutMs: 1000, stdoutBytes: 8192, stderrBytes: 8192, aggregate: { required: false } },
  };
  const executor = new SeatbeltExecutor({
    resolveSupervisor: async () => ({ executablePath: '/trusted/helper' }),
    removePrivateDirectory: jest.fn(async () => {}),
  });
  executor.capabilities = { available: true };
  await expect(executor.execute(policy, { command: '/bin/sh', args: ['-c', 'printf fixture'] }))
    .resolves.toMatchObject({ state: 'completed', exitCode: 0 });
  expect(runMacosSupervisor).toHaveBeenCalledTimes(1);
  const launch = runMacosSupervisor.mock.calls[0][0];
  expect(launch.env).toMatchObject({
    CHOKIDAR_USEPOLLING: polling, CHOKIDAR_INTERVAL: interval, PUBLIC_FLAG: 'fixture',
    HOME: path.join(os.tmpdir(), 'freedom-seatbelt-test', 'home'),
    TMPDIR: path.join(os.tmpdir(), 'freedom-seatbelt-test', 'tmp'),
  });
  expect(launch.env.PATH).not.toContain('/host-path');
  expect(launch.request).toMatchObject({ command: '/bin/sh', args: ['-c', 'printf fixture'] });
  const profile = fs.promises.writeFile.mock.calls.find(([name]) => name.endsWith('profile.sb'))[1];
  expect(profile).toContain('(deny default)');
  expect(profile).toContain('(deny network*)');
  expect(profile).not.toContain('fsevents');
  expect(policy.environment.values).toBe(values);
  expect(require('child_process').spawn).not.toHaveBeenCalled();
  expect(require('child_process').execFile).not.toHaveBeenCalled();
  expect(require('child_process').execFileSync).not.toHaveBeenCalled();
});
