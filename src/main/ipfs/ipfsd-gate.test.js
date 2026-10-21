/**
 * freedom-ipfsd's gate held from main (freedom-core design 0007, "Lifetime
 * lock" and "Rollback"), against a fake `hold-lock` child: `locked` resolves
 * the hold, each exit code its refusal, a release closes stdin and waits for
 * the exit (a kill bounds it), a holder that ends unasked is reported, and
 * a missing binary follows the build's rule. The real binary's gate is
 * ipfsd-gate.integration.test.js's.
 */

const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });

const { app } = require('electron');

let mockBinaryPresent = true;
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (p) => (/freedom-ipfsd/.test(p) ? mockBinaryPresent : actual.existsSync(p)),
  };
});

const {
  IpfsGateError,
  holdIpfsGate,
  ipfsGateRequired,
  takeIpfsGate,
  withIpfsGate,
  LOCK_TIMEOUT_MS,
  RELEASE_KILL_MS,
} = require('./ipfsd-gate');

/** A hold-lock child the test drives: what main wrote, and its exit. */
class FakeHolder extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdinEnded = false;
    this.killedWith = null;
    this.stdin.on('finish', () => {
      this.stdinEnded = true;
      if (this.exitOnEof) setImmediate(() => this.exit(0));
    });
    this.exitOnEof = true;
  }

  locked() {
    this.stdout.write('locked\n');
  }

  exit(code, signal = null) {
    this.emit('exit', code, signal);
  }

  kill(signal) {
    this.killedWith = signal;
    setImmediate(() => this.exit(null, signal));
    return true;
  }
}

/** Timers run by hand. */
function manualTimers() {
  const timers = new Set();
  return {
    setTimer(fn, ms) {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    fire(ms) {
      for (const timer of [...timers]) {
        if (timer.ms === ms) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
    pending: () => [...timers].map((t) => t.ms),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
let log;
let timers;
let spawned;

function hold(options = {}) {
  const child = new FakeHolder();
  const spawn = jest.fn((command, args, spawnOptions) => {
    spawned = { command, args, options: spawnOptions };
    return child;
  });
  const promise = holdIpfsGate({
    dataDir: path.join('profile', 'ipfs-data', 'freedom-ipfs'),
    lockDir: path.join('app-data', 'Freedom', 'locks'),
    command: 'freedom-ipfsd',
    spawn,
    log,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...options,
  });
  return { child, promise, spawn };
}

afterEach(() => {
  delete process.resourcesPath;
});

beforeEach(() => {
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  timers = manualTimers();
  spawned = null;
  mockBinaryPresent = true;
  app.isPackaged = false;
});

describe('holdIpfsGate', () => {
  test('runs hold-lock on the data and lock directories, in the scrubbed environment', async () => {
    const { child, promise } = hold();
    child.locked();
    await promise;
    expect(spawned.command).toBe('freedom-ipfsd');
    expect(spawned.args).toEqual([
      'hold-lock',
      '--data-dir',
      path.join('profile', 'ipfs-data', 'freedom-ipfs'),
      '--lock-dir',
      path.join('app-data', 'Freedom', 'locks'),
    ]);
    expect(spawned.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(Object.keys(spawned.options.env).every((key) => !/proxy|^FREEDOM_/i.test(key))).toBe(
      true
    );
  });

  test('resolves only once `locked` is read, and holds until released', async () => {
    const { child, promise } = hold();
    let held = null;
    promise.then((h) => (held = h));
    child.stdout.write('lock');
    await tick();
    expect(held).toBeNull();
    child.stdout.write('ed\n');
    await tick();
    expect(held).not.toBeNull();
    expect(child.stdinEnded).toBe(false);

    const released = held.release();
    await tick();
    expect(child.stdinEnded).toBe(true);
    await released;
    // A second release is the first's.
    await held.release();
  });

  test.each([
    [75, 'lock_held', 'The IPFS data is in use by another process. Close it and try again.'],
    [74, 'storage', "The IPFS data directory's lock can't be taken on this storage"],
    [64, 'usage', 'freedom-ipfsd refused the hold-lock command'],
    [70, 'failed', "freedom-ipfsd couldn't hold the IPFS data directory's lock"],
  ])('exit %i before `locked` is %s', async (code, kind, message) => {
    const { child, promise } = hold();
    child.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'cannot take the gate', error: 'why' })}\n`
    );
    await tick();
    child.exit(code);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(IpfsGateError);
    expect(err.code).toBe(kind);
    expect(err.message).toBe(message);
    expect(log.warn).toHaveBeenCalledWith('[IPFS] freedom-ipfsd hold-lock failed', {
      code: kind,
      exit: code,
      signal: null,
      cause: 'why',
    });
  });

  test("a holder that can't be spawned fails", async () => {
    const { child, promise } = hold();
    child.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toMatchObject({ name: 'IpfsGateError', code: 'failed' });
  });

  test('no `locked` within its bound: killed, and failed', async () => {
    const { child, promise } = hold();
    timers.fire(LOCK_TIMEOUT_MS);
    await expect(promise).rejects.toMatchObject({ code: 'failed' });
    expect(child.killedWith).toBe('SIGKILL');
  });

  test('a cancelled wait kills the holder and gives up, quietly; a held gate ignores it', async () => {
    const abort = new AbortController();
    const { child, promise } = hold({ signal: abort.signal });
    abort.abort();
    await expect(promise).rejects.toMatchObject({ name: 'IpfsGateError', code: 'cancelled' });
    expect(child.killedWith).toBe('SIGKILL');
    expect(log.warn).not.toHaveBeenCalled();

    const late = new AbortController();
    const held = hold({ signal: late.signal });
    held.child.locked();
    const gate = await held.promise;
    late.abort();
    expect(held.child.killedWith).toBeNull();
    await gate.release();
  });

  test('an already cancelled wait spawns nothing', async () => {
    const abort = new AbortController();
    abort.abort();
    const { promise, spawn } = hold({ signal: abort.signal });
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  test("a holder that doesn't exit at its stdin's EOF is killed", async () => {
    const { child, promise } = hold();
    child.exitOnEof = false;
    child.locked();
    const held = await promise;
    let released = false;
    held.release().then(() => (released = true));
    await tick();
    expect(released).toBe(false);
    expect(timers.pending()).toContain(RELEASE_KILL_MS);
    timers.fire(RELEASE_KILL_MS);
    await tick();
    expect(child.killedWith).toBe('SIGKILL');
    await tick();
    expect(released).toBe(true);
  });

  test('a holder that ends unasked is lost; a released one never is', async () => {
    const onLost = jest.fn();
    const first = hold({ onLost });
    first.child.locked();
    await first.promise;
    first.child.exit(null, 'SIGKILL');
    expect(onLost).toHaveBeenCalledWith({ code: null, signal: 'SIGKILL' });
    expect(log.error).toHaveBeenCalledWith(
      '[IPFS] freedom-ipfsd hold-lock ended while holding the gate',
      { exit: null, signal: 'SIGKILL' }
    );

    const quiet = jest.fn();
    const second = hold({ onLost: quiet });
    second.child.locked();
    await (await second.promise).release();
    expect(quiet).not.toHaveBeenCalled();
  });
});

// Until the service is the default, only a build that can run it gates its
// IPFS writers (freedom-core design 0007, "Lifetime lock" and Rollback): the
// add-on takes its gate through takeIpfsGate, and profile delete through
// withIpfsGate.
describe('where the gate is taken (ipfsGateRequired)', () => {
  const spawnHolder = () => {
    const spawn = jest.fn(() => {
      const child = new FakeHolder();
      setImmediate(() => child.locked());
      return child;
    });
    return {
      spawn,
      options: {
        log,
        lockDir: 'locks',
        spawn,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    };
  };

  test('a packaged build: the add-on and profile delete take no gate, even with the binary', async () => {
    app.isPackaged = true;
    expect(ipfsGateRequired()).toBe(false);
    const { spawn, options } = spawnHolder();

    // The add-on's.
    await expect(takeIpfsGate('data', options)).resolves.toBeNull();
    // Profile delete's.
    const fn = jest.fn(async () => 'removed');
    await expect(withIpfsGate('data', fn, options)).resolves.toBe('removed');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("a packaged build's profile delete removes the profile's IPFS data with no gate", async () => {
    app.isPackaged = true;
    const os = require('os');
    const fs = require('fs');
    const { deleteProfile, ensureProfile, loadCatalog } = require('../profile-catalog');
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-gate-delete-'));
    try {
      const profiles = { defaultProfileDir: path.join(appRoot, 'Profiles', 'default') };
      ensureProfile(appRoot, 'default', profiles);
      const { record } = ensureProfile(appRoot, 'work', profiles);
      fs.mkdirSync(path.join(record.dir, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
      const { spawn, options } = spawnHolder();

      await deleteProfile(appRoot, 'work', 'Work', {
        ...profiles,
        withIpfsGate: (dir, fn) => withIpfsGate(dir, fn, options),
      });

      expect(spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });

  test('a development build: both hold it', async () => {
    expect(ipfsGateRequired()).toBe(true);
    const { spawn, options } = spawnHolder();

    const hold = await takeIpfsGate('data', options);
    expect(hold).not.toBeNull();
    await hold.release();
    const fn = jest.fn(async () => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });
    await withIpfsGate('data', fn, options);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls.map(([, args]) => args[0])).toEqual(['hold-lock', 'hold-lock']);
  });
});

describe("the build's rule for a missing binary", () => {
  test('a development build goes on without the gate, and says so', async () => {
    mockBinaryPresent = false;
    await expect(takeIpfsGate('data', { log })).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('npm run ipfsd:download'));
    const fn = jest.fn(async () => 'removed');
    await expect(withIpfsGate('data', fn, { log })).resolves.toBe('removed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a missing binary in a packaged build is no matter yet: it takes no gate', async () => {
    mockBinaryPresent = false;
    app.isPackaged = true;
    const fn = jest.fn(async () => 'removed');
    await expect(withIpfsGate('data', fn, { log })).resolves.toBe('removed');
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('withIpfsGate runs `fn` holding the gate, and releases it however `fn` ends', async () => {
    const order = [];
    const make = () => {
      const child = new FakeHolder();
      child.stdin.on('finish', () => order.push('released'));
      setImmediate(() => {
        order.push('locked');
        child.locked();
      });
      return child;
    };
    const options = {
      log,
      lockDir: 'locks',
      spawn: make,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    };
    await withIpfsGate('data', async () => order.push('fn'), options);
    expect(order).toEqual(['locked', 'fn', 'released']);

    order.length = 0;
    await expect(
      withIpfsGate(
        'data',
        async () => {
          order.push('fn');
          throw new Error('boom');
        },
        options
      )
    ).rejects.toThrow('boom');
    expect(order).toEqual(['locked', 'fn', 'released']);
  });
});
