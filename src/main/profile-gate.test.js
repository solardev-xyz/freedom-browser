const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  ProfileGateError,
  isProfileGateHeldSync,
  isProfileHeldElsewhere,
  profileGateArgs,
  startProfileGate,
} = require('./profile-gate');

const quietLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

// A holder whose answers the test writes: `locked`, an exit.
function fakeHolder() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => child.emit('exit', null, 'SIGKILL'));
  child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0, null)));
  child.lock = () => child.stdout.write('locked\n');
  return child;
}

function spawner() {
  const children = [];
  const spawn = jest.fn(() => {
    const child = fakeHolder();
    children.push(child);
    return child;
  });
  return { children, spawn };
}

const catalogProfile = {
  id: 'work',
  source: 'catalog',
  appRoot: '/data/Freedom',
  userDataDir: '/data/Freedom/Profiles/work',
};

function start(options = {}) {
  return startProfileGate(catalogProfile, {
    packaged: true,
    log: quietLog,
    command: '/bin/freedom-cored',
    lockDir: '/data/Freedom/locks',
    exists: () => true,
    ...options,
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('profileGateArgs', () => {
  test("a catalog profile's holder checks it is still listed", () => {
    expect(profileGateArgs(catalogProfile, '/locks')).toEqual([
      'hold-profile',
      '--user-data-dir',
      '/data/Freedom/Profiles/work',
      '--lock-dir',
      '/locks',
      '--app-root',
      '/data/Freedom',
      '--id',
      'work',
    ]);
  });

  test('a --profile-dir or test profile names its directory alone', () => {
    expect(
      profileGateArgs({ id: 'scratch', source: 'profile-dir', userDataDir: '/tmp/scratch' }, '/locks')
    ).toEqual(['hold-profile', '--user-data-dir', '/tmp/scratch', '--lock-dir', '/locks']);
  });
});

describe('startProfileGate', () => {
  test('spawns hold-profile at once, and is held once it says locked', async () => {
    const { children, spawn } = spawner();
    const gate = start({ spawn });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual(profileGateArgs(catalogProfile, '/data/Freedom/locks'));
    expect(gate.held()).toBe(false);
    children[0].lock();
    await gate.whenLocked();
    expect(gate.gated).toBe(true);
    expect(gate.held()).toBe(true);
    await gate.release();
    expect(children[0].stdin.writableEnded).toBe(true);
    expect(gate.held()).toBe(false);
  });

  test('another new build holding the gate is lock_held; a delete that raced it is refused', async () => {
    for (const [exit, code] of [
      [75, 'lock_held'],
      [65, 'refused'],
      [74, 'storage'],
      [64, 'usage'],
    ]) {
      const { children, spawn } = spawner();
      const gate = start({ spawn });
      children[0].emit('exit', exit, null);
      await expect(gate.whenLocked()).rejects.toEqual(expect.objectContaining({ code }));
    }
  });

  test('main waits 10 s for locked at most', async () => {
    jest.useFakeTimers();
    try {
      const { children, spawn } = spawner();
      const gate = start({ spawn });
      const settled = gate.whenLocked().catch((error) => error);
      jest.advanceTimersByTime(9_999);
      expect(children[0].kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
      jest.useRealTimers();
      expect((await settled).code).toBe('failed');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a holder that dies while main runs is replaced at once', async () => {
    const { children, spawn } = spawner();
    const onFatal = jest.fn();
    const gate = start({ spawn, onFatal });
    children[0].lock();
    await gate.whenLocked();
    children[0].emit('exit', null, 'SIGKILL');
    expect(gate.held()).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].lock();
    await tick();
    expect(gate.held()).toBe(true);
    expect(onFatal).not.toHaveBeenCalled();
    await gate.release();
  });

  test("main stops when the gate can't be taken again", async () => {
    const { children, spawn } = spawner();
    const onFatal = jest.fn();
    const gate = start({ spawn, onFatal });
    children[0].lock();
    await gate.whenLocked();
    children[0].emit('exit', null, 'SIGKILL');
    children[1].emit('exit', 75, null);
    await tick();
    expect(onFatal).toHaveBeenCalledWith(expect.any(ProfileGateError));
    expect(onFatal.mock.calls[0][0].code).toBe('lock_held');
    expect(gate.held()).toBe(false);
  });

  test('a release before locked gives up the wait; a holder ending after the release is no loss', async () => {
    const { children, spawn } = spawner();
    const onFatal = jest.fn();
    const gate = start({ spawn, onFatal });
    const settled = gate.whenLocked().catch((error) => error);
    await gate.release();
    expect(children[0].kill).toHaveBeenCalled();
    expect((await settled).code).toBe('cancelled');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  test('without the binary: a development build goes on ungated, a packaged one fails', async () => {
    const warn = jest.fn();
    const dev = start({ packaged: false, exists: () => false, log: { ...quietLog, warn } });
    expect(dev.gated).toBe(false);
    await expect(dev.whenLocked()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    const packaged = start({ packaged: true, exists: () => false });
    await expect(packaged.whenLocked()).rejects.toEqual(expect.objectContaining({ code: 'missing' }));
  });
});

describe('asking the gate for a stale lock', () => {
  test("profile open's answer is used as it is", () => {
    const deps = { hasStaleLock: jest.fn(() => true), askGate: jest.fn(() => true) };
    expect(isProfileHeldElsewhere({ gateHeld: false }, catalogProfile, deps)).toBe(false);
    expect(isProfileHeldElsewhere({ gateHeld: true }, catalogProfile, deps)).toBe(true);
    expect(deps.askGate).not.toHaveBeenCalled();
  });

  test('where profile open did not run, the gate is asked for a stale lock only', () => {
    const askGate = jest.fn(() => true);
    expect(
      isProfileHeldElsewhere({ gateHeld: null }, catalogProfile, { hasStaleLock: () => false, askGate })
    ).toBe(false);
    expect(askGate).not.toHaveBeenCalled();
    expect(
      isProfileHeldElsewhere({ gateHeld: null }, catalogProfile, { hasStaleLock: () => true, askGate })
    ).toBe(true);
  });

  test('profile status, its answer, and a failed run reading as free', () => {
    const calls = [];
    const spawnSync = (command, args) => {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify([
          { user_data_dir: '/p', open: true, lock_fresh: false, gate_held: true },
        ]),
        stderr: '',
      };
    };
    expect(
      isProfileGateHeldSync(
        { userDataDir: '/p', isDev: true },
        { command: '/c', lockDir: '/l', spawnSync, log: quietLog }
      )
    ).toBe(true);
    expect(calls[0]).toEqual(['profile', 'status', '--lock-dir', '/l', '--dev', '--user-data-dir', '/p']);

    const failing = () => ({ status: 74, stdout: '{"error":"io"}', stderr: '' });
    expect(
      isProfileGateHeldSync(
        { userDataDir: '/p' },
        { command: '/c', lockDir: '/l', spawnSync: failing, log: quietLog }
      )
    ).toBe(false);
  });
});
