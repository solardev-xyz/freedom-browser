/**
 * The Radicle home's node root (freedom-core design 0017, C1): each spawn of
 * the core waits for `prepareRadicleDataDir()` at most
 * `RADICLE_PREPARE_WAIT_MS`, and passes `--node-root radicle=` only when the
 * home was prepared by then. A carry-over still running, or one that failed,
 * never holds up the core (and the vault with it), and the core never runs
 * with the home's grant while a carry-over may still rename a directory into
 * its place. The client is the real CoreClient; its spawn fails, as if the
 * binary were missing, so the shared client's restart is the next spawn.
 *
 * Most tests stub the whole preparation; `mockRealPaths` runs the real
 * profile-paths.js instead, with private-files.js's directory probes
 * stubbed, so a probe that never returns (a stalled mount) can be shown not
 * to hold the spawn.
 */

let mockRealPaths = false;

jest.mock(
  'electron',
  () => ({
    app: {
      isPackaged: false,
      getVersion: () => '0.0.0-test',
      getPath: (name) => {
        if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`);
        return require('path').join(require('os').tmpdir(), 'freedom-user-data');
      },
    },
  }),
  { virtual: true }
);
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(() => {
    throw new Error('no freedom-cored in this test');
  }),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../profile-paths', () =>
  mockRealPaths
    ? jest.requireActual('../profile-paths')
    : {
        getIdentityDataDir: () => '/nonexistent/identity',
        getAntDataPath: () => '/nonexistent/freedom/ant-data',
        prepareRadicleDataDir: jest.fn(),
      }
);
// The directory probes, with mockRealPaths: the synchronous one makes
// nothing, and the asynchronous one, the Radicle home's, never returns.
jest.mock('../private-files', () =>
  mockRealPaths
    ? {
        ...jest.requireActual('../private-files'),
        ensurePrivateDir: jest.fn((dir) => dir),
        ensurePrivateDirAsync: jest.fn(() => new Promise(() => {})),
      }
    : jest.requireActual('../private-files')
);
jest.mock('../profile-resolver', () =>
  mockRealPaths ? { getActiveProfile: () => null } : jest.requireActual('../profile-resolver')
);
jest.mock('../service-locks', () => ({ getLockDir: () => '/nonexistent/locks' }));
jest.mock('../freedom-root', () => {
  const path = require('path');
  const root = path.join(require('os').tmpdir(), 'freedom-profile');
  return {
    getFreedomDataDir: () => root,
    getFreedomDataPath: (name) => path.join(root, name),
    resolveFreedomRoot: () => root,
  };
});
jest.mock('./naming', () => ({
  attachNaming: jest.fn(() => ({ running: () => false })),
  detachNaming: jest.fn(),
}));
jest.mock('./chain', () => ({ attachChain: jest.fn(), detachChain: jest.fn() }));

const HOME = '/nonexistent/R/1';
const RESTART_MS = 500;
const WITHOUT = '[Core] starting without the Radicle home until it is prepared';

let core;
let spawn;
let log;
let prepare;
let started;

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  ({ spawn } = require('child_process'));
  log = require('../logger');
  prepare = require('../profile-paths').prepareRadicleDataDir;
  core = require('./core-process');
});

afterEach(async () => {
  await core.stopCore();
  await started;
  jest.useRealTimers();
  mockRealPaths = false;
  delete process.env.FREEDOM_RADICLE_DATA;
});

/** Starts the core; its readiness never comes (every spawn fails). */
function start() {
  started = core.startCore().catch(() => null);
}

/** Each spawn's Radicle node root, or null without one. */
function radicleRoots() {
  return spawn.mock.calls.map(([, args]) => {
    const at = args.findIndex((arg) => arg.startsWith('radicle='));
    return at === -1 ? null : args[at].slice('radicle='.length);
  });
}

test('a preparation that never settles: the core spawns within the bound, without the home', async () => {
  prepare.mockImplementation(() => new Promise(() => {}));
  start();
  await jest.advanceTimersByTimeAsync(core.RADICLE_PREPARE_WAIT_MS - 1);
  expect(spawn).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(spawn).toHaveBeenCalledTimes(1);
  const [, args] = spawn.mock.calls[0];
  expect(args).toContain('bee=/nonexistent/freedom/ant-data');
  expect(radicleRoots()).toEqual([null]);
  expect(log.info).toHaveBeenCalledWith(WITHOUT);
  // The restart waits again, on the same preparation, and still spawns
  // without it: no core runs with the home's grant over the carry-over. The
  // line is said once.
  await jest.advanceTimersByTimeAsync(RESTART_MS + core.RADICLE_PREPARE_WAIT_MS);
  expect(radicleRoots()).toEqual([null, null]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(log.info.mock.calls.filter(([line]) => line === WITHOUT)).toHaveLength(1);
});

// Review round 2 of #1307: the preparation's directory probes are
// asynchronous, so one that never returns (an override on a stalled mount)
// holds a thread-pool thread, not main's event loop, and the bound fires.
test.each([
  ['an override', '/nonexistent/stalled-mount/radicle'],
  ["a profile's own radicle-data", null],
])(
  'a directory probe that never returns (%s): the spawn goes at the bound, without the home',
  async (_name, override) => {
    if (override) process.env.FREEDOM_RADICLE_DATA = override;
    mockRealPaths = true;
    jest.resetModules();
    ({ spawn } = require('child_process'));
    log = require('../logger');
    const files = require('../private-files');
    core = require('./core-process');
    const home =
      override ?? require('path').join(require('os').tmpdir(), 'freedom-user-data', 'radicle-data');
    start();
    await jest.advanceTimersByTimeAsync(core.RADICLE_PREPARE_WAIT_MS - 1);
    expect(spawn).not.toHaveBeenCalled();
    expect(files.ensurePrivateDirAsync).toHaveBeenCalledWith(home);
    await jest.advanceTimersByTimeAsync(1);
    expect(radicleRoots()).toEqual([null]);
    expect(log.info).toHaveBeenCalledWith(WITHOUT);
    // The probe is still pending, and nothing probed the home synchronously.
    expect(files.ensurePrivateDirAsync).toHaveBeenCalledTimes(1);
    expect(files.ensurePrivateDir).not.toHaveBeenCalledWith(home);
  }
);

test('a preparation that settles after the first spawn: the next spawn passes the home', async () => {
  let settle;
  const carryOver = new Promise((resolve) => {
    settle = resolve;
  });
  prepare.mockImplementation(() => carryOver);
  start();
  await jest.advanceTimersByTimeAsync(core.RADICLE_PREPARE_WAIT_MS);
  expect(radicleRoots()).toEqual([null]);
  settle(HOME);
  await jest.advanceTimersByTimeAsync(RESTART_MS);
  expect(radicleRoots()).toEqual([null, HOME]);
});

test('a home prepared at once: the first spawn passes it, without waiting for the bound', async () => {
  prepare.mockResolvedValue(HOME);
  start();
  await jest.advanceTimersByTimeAsync(0);
  expect(radicleRoots()).toEqual([HOME]);
  expect(log.info).not.toHaveBeenCalledWith(WITHOUT);
});

test('a preparation that fails: the core spawns at once without the home, and says why', async () => {
  prepare.mockRejectedValue(Object.assign(new Error('a path'), { code: 'EACCES' }));
  start();
  await jest.advanceTimersByTimeAsync(0);
  expect(radicleRoots()).toEqual([null]);
  expect(log.warn).toHaveBeenCalledWith("[Core] the Radicle home isn't prepared", {
    code: 'EACCES',
  });
  expect(log.info).toHaveBeenCalledWith(WITHOUT);
  // A restart tries again, and passes the home once it is prepared.
  prepare.mockResolvedValue(HOME);
  await jest.advanceTimersByTimeAsync(RESTART_MS);
  expect(radicleRoots()).toEqual([null, HOME]);
});
