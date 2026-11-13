/**
 * The Radicle home's gate held from main (freedom-core design 0008, "Spawn
 * and lock" and "Rollback"), against a fake `hold-lock` child: `locked`
 * resolves the hold, each exit code its refusal, a release closes stdin and
 * waits for the exit (a kill bounds it), a holder that ends unasked is
 * reported, and a missing binary follows the build's rule; and the add-on's
 * refusal on a home the service has switched. The real binary's gate is
 * radicled-gate.integration.test.js's.
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
    existsSync: (p) => (/freedom-radicled/.test(p) ? mockBinaryPresent : actual.existsSync(p)),
  };
});

const {
  RadicleGateError,
  holdRadicleGate,
  takeRadicleGate,
  withRadicleGate,
  addonHomeRefusal,
  removeStaleControlSocket,
  ADDON_HOME_MESSAGE,
  LOCK_TIMEOUT_MS,
  RELEASE_KILL_MS,
} = require('./radicled-gate');

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
  const promise = holdRadicleGate({
    home: path.join('app-data', 'Freedom', 'R', '1'),
    lockDir: path.join('app-data', 'Freedom', 'locks'),
    command: 'freedom-radicled',
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

describe('holdRadicleGate', () => {
  test('runs hold-lock on the home and the lock directory, in the scrubbed environment', async () => {
    const { child, promise } = hold();
    child.locked();
    await promise;
    expect(spawned.command).toBe('freedom-radicled');
    // freedom-radicled names the directory `--home` (args.rs).
    expect(spawned.args).toEqual([
      'hold-lock',
      '--home',
      path.join('app-data', 'Freedom', 'R', '1'),
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
    [75, 'lock_held', 'The Radicle data is in use by another process. Close it and try again.'],
    [74, 'storage', "The Radicle home's lock can't be taken on this storage"],
    [64, 'usage', 'freedom-radicled refused the hold-lock command'],
    [70, 'failed', "freedom-radicled couldn't hold the Radicle home's lock"],
  ])('exit %i before `locked` is %s', async (code, kind, message) => {
    const { child, promise } = hold();
    child.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'cannot take the gate', error: 'why' })}\n`
    );
    await tick();
    child.exit(code);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(RadicleGateError);
    expect(err.code).toBe(kind);
    expect(err.message).toBe(message);
    expect(log.warn).toHaveBeenCalledWith('[Radicle] freedom-radicled hold-lock failed', {
      code: kind,
      exit: code,
      signal: null,
      cause: 'why',
    });
  });

  test("a holder that can't be spawned fails", async () => {
    const { child, promise } = hold();
    child.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toMatchObject({ name: 'RadicleGateError', code: 'failed' });
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
    await expect(promise).rejects.toMatchObject({ name: 'RadicleGateError', code: 'cancelled' });
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
      '[Radicle] freedom-radicled hold-lock ended while holding the gate',
      { exit: null, signal: 'SIGKILL' }
    );

    const quiet = jest.fn();
    const second = hold({ onLost: quiet });
    second.child.locked();
    await (await second.promise).release();
    expect(quiet).not.toHaveBeenCalled();
  });
});

// Every build gates its Radicle writers (freedom-core design 0008, "Spawn
// and lock" and Rollback): the add-on takes its gate through
// takeRadicleGate, and the alias rewrite and profile delete through
// withRadicleGate.
describe('where the gate is taken', () => {
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

  test.each([
    ['a packaged build', true],
    ['a development build', false],
  ])('%s: the add-on, the alias rewrite and profile delete hold it', async (_label, isPackaged) => {
    app.isPackaged = isPackaged;
    Object.defineProperty(process, 'resourcesPath', { value: 'resources', configurable: true });
    const { spawn, options } = spawnHolder();

    // The add-on's.
    const hold = await takeRadicleGate('home', options);
    expect(hold).not.toBeNull();
    await hold.release();
    // The alias rewrite's and profile delete's.
    const fn = jest.fn(async () => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });
    await withRadicleGate('home', fn, options);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls.map(([, args]) => args[0])).toEqual(['hold-lock', 'hold-lock']);
    if (isPackaged) {
      // The binary the build ships, wherever the suite runs.
      const name = process.platform === 'win32' ? 'freedom-radicled.exe' : 'freedom-radicled';
      expect(spawn.mock.calls[0][0]).toBe(path.join('resources', 'freedom-radicled', name));
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("a packaged build's profile delete holds it while it removes the profile's Radicle home", async () => {
    app.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', { value: 'resources', configurable: true });
    const os = require('os');
    const fs = require('fs');
    const { deleteProfile, ensureProfile, loadCatalog } = require('../profile-catalog');
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-gate-delete-'));
    try {
      const profiles = { defaultProfileDir: path.join(appRoot, 'Profiles', 'default') };
      ensureProfile(appRoot, 'default', profiles);
      const { record } = ensureProfile(appRoot, 'work', profiles);
      const radicleHome = path.join(appRoot, 'R', String(record.slot));
      fs.mkdirSync(path.join(radicleHome, 'storage'), { recursive: true });
      const { spawn, options } = spawnHolder();

      await deleteProfile(appRoot, 'work', 'Work', {
        ...profiles,
        withRadicleGate: (dir, fn) => withRadicleGate(dir, fn, options),
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][1]).toEqual([
        'hold-lock',
        '--home',
        path.resolve(radicleHome),
        '--lock-dir',
        'locks',
      ]);
      expect(fs.existsSync(radicleHome)).toBe(false);
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });
});

describe("the build's rule for a missing binary", () => {
  test('a development build goes on without the gate, and says so', async () => {
    mockBinaryPresent = false;
    await expect(takeRadicleGate('home', { log })).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "[Radicle] freedom-radicled isn't downloaded (npm run radicled:download): going on without the Radicle home's gate"
    );
    const fn = jest.fn(async () => 'removed');
    await expect(withRadicleGate('home', fn, { log })).resolves.toBe('removed');
    expect(fn).toHaveBeenCalledWith({ gated: false, held: expect.any(Function) });
  });

  // The add-on, the rollback, runs only under the gate (0008, Rollback;
  // plan B16): `required` refuses a development build without the binary.
  test("a development build without it doesn't start the add-on (`required`)", async () => {
    mockBinaryPresent = false;
    await expect(takeRadicleGate('home', { log, required: true })).rejects.toMatchObject({
      name: 'RadicleGateError',
      code: 'missing',
      message:
        "The Radicle add-on runs only under freedom-radicled's hold-lock: run npm run radicled:download",
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('a packaged build requires it: nothing runs without the gate', async () => {
    mockBinaryPresent = false;
    app.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', { value: 'resources', configurable: true });
    const fn = jest.fn();
    await expect(withRadicleGate('home', fn, { log })).rejects.toMatchObject({
      name: 'RadicleGateError',
      code: 'missing',
      message: 'freedom-radicled is missing from this installation. Reinstall Freedom.',
    });
    expect(fn).not.toHaveBeenCalled();
    await expect(takeRadicleGate('home', { log })).rejects.toMatchObject({ code: 'missing' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('withRadicleGate runs `fn` holding the gate, and releases it however `fn` ends', async () => {
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
    await withRadicleGate('home', async () => order.push('fn'), options);
    expect(order).toEqual(['locked', 'fn', 'released']);

    order.length = 0;
    await expect(
      withRadicleGate(
        'home',
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

// freedom-core design 0008, "The switch" and Rollback (plan B16): the
// service's first start on a home removes keys/radicle, and the add-on's
// start on a home without one generates a key, a new identity. So the
// add-on, the rollback, starts only on a home that still has keys/radicle.
describe('addonHomeRefusal', () => {
  const os = require('os');
  const fs = require('fs');
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-radicle-switched-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const put = (rel) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), '');
  };

  test.each([
    ['a home the add-on has run, its key generated', ['keys/radicle', 'node/node.db']],
    ['a home the core wrote a key to', ['keys/radicle', 'keys/radicle.pub']],
    ['a home with keys/radicle where the service ran', ['keys/radicle', 'node/reconcile.db']],
  ])('%s: the add-on may start', (_what, files) => {
    for (const rel of files) put(rel);
    expect(addonHomeRefusal(home)).toBeNull();
  });

  test.each([
    ['an empty home (a new profile)', []],
    [
      'a home where the service never ran (no vault, nothing generated yet)',
      ['storage/repo', 'node/node.db'],
    ],
    ['only keys/radicle.pub', ['keys/radicle.pub']],
    ['its reconciliation record', ['node/reconcile.db']],
    ["the switch's dirty marker", ['node/dirty']],
    ['both, and its storage', ['node/reconcile.db', 'node/dirty', 'storage/repo']],
  ])('no keys/radicle, %s: refused', (_what, files) => {
    for (const rel of files) put(rel);
    expect(addonHomeRefusal(home)).toBe(ADDON_HOME_MESSAGE);
  });

  test('a keys path that is a file holds no key file: refused', () => {
    fs.writeFileSync(path.join(home, 'keys'), '');
    expect(addonHomeRefusal(home)).toBe(ADDON_HOME_MESSAGE);
  });

  const posixTest = process.platform === 'win32' ? test.skip : test;

  posixTest(
    'a dangling link at keys/radicle counts as a key file, as the service counts it',
    () => {
      put('node/reconcile.db');
      fs.mkdirSync(path.join(home, 'keys'));
      fs.symlinkSync(path.join(home, 'nothing'), path.join(home, 'keys', 'radicle'));
      // The start's own check then refuses the link (radicle-manager.js).
      expect(addonHomeRefusal(home)).toBeNull();
    }
  );
});

// Plan B6 (from B5, #1183): heartwood in the add-on binds
// <home>/node/control.sock and leaves it when it is killed; the service binds
// none, and main's grant check refuses a home holding a special file. Before
// the service's first spawn, that socket is removed under the gate, and
// nothing else, and nothing without the gate.
const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('removeStaleControlSocket', () => {
  const os = require('os');
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  let root;
  let home;
  let quiet;

  beforeEach(() => {
    // Short: a socket's path has a length bound (macOS's is 104 bytes).
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsock-'));
    home = path.join(root, 'h');
    fs.mkdirSync(path.join(home, 'node'), { recursive: true });
    quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A socket left at `target` as a killed process leaves one: bound, and
   * never unbound. */
  function strandSocket(target) {
    const script =
      "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))";
    spawnSync(process.execPath, ['-e', script, target], { stdio: 'ignore' });
    expect(fs.lstatSync(target).isSocket()).toBe(true);
  }

  /** A gate runner: held, as `withRadicleGate` gives it, unless told. */
  function gate({ gated = true, held = true, refuse = null } = {}) {
    return jest.fn(async (_home, fn) => {
      if (refuse) throw new RadicleGateError(refuse);
      return fn({ gated, held: () => held });
    });
  }

  const socket = () => path.join(home, 'node', 'control.sock');
  const there = (target) => {
    try {
      fs.lstatSync(target);
      return true;
    } catch {
      return false;
    }
  };

  test("the add-on's socket, under the gate: removed", async () => {
    strandSocket(socket());
    const withGate = gate();
    await expect(removeStaleControlSocket(home, { withGate, log: quiet })).resolves.toBe(true);
    expect(withGate).toHaveBeenCalledWith(home, expect.any(Function), expect.any(Object));
    expect(there(socket())).toBe(false);
    // The rest of the home stays.
    expect(fs.lstatSync(path.join(home, 'node')).isDirectory()).toBe(true);
  });

  test('no socket there: the gate is never taken', async () => {
    const withGate = gate();
    await expect(removeStaleControlSocket(home, { withGate, log: quiet })).resolves.toBe(false);
    expect(withGate).not.toHaveBeenCalled();
  });

  test.each([
    ['a regular file', (target) => fs.writeFileSync(target, 'x')],
    ['a directory', (target) => fs.mkdirSync(target)],
    [
      'a link to a socket',
      (target) => {
        const elsewhere = path.join(root, 's');
        strandSocket(elsewhere);
        fs.symlinkSync(elsewhere, target);
      },
    ],
  ])('%s at the path is no socket: left', async (_what, make) => {
    make(socket());
    const withGate = gate();
    await expect(removeStaleControlSocket(home, { withGate, log: quiet })).resolves.toBe(false);
    expect(withGate).not.toHaveBeenCalled();
    expect(there(socket())).toBe(true);
  });

  test('a socket anywhere else in the home: left', async () => {
    const others = [path.join(home, 'control.sock'), path.join(home, 'node', 'other.sock')];
    for (const other of others) strandSocket(other);
    await expect(removeStaleControlSocket(home, { withGate: gate(), log: quiet })).resolves.toBe(
      false
    );
    for (const other of others) expect(there(other)).toBe(true);
  });

  test('a home whose node/ is a link: the socket it leads to is left', async () => {
    const elsewhere = path.join(root, 'n');
    fs.mkdirSync(elsewhere);
    strandSocket(path.join(elsewhere, 'control.sock'));
    fs.rmSync(path.join(home, 'node'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home, 'node'));
    const withGate = gate();
    await expect(removeStaleControlSocket(home, { withGate, log: quiet })).resolves.toBe(false);
    expect(withGate).not.toHaveBeenCalled();
    expect(there(path.join(elsewhere, 'control.sock'))).toBe(true);
  });

  test.each([
    ['ungated (a development build without the binary)', { gated: false }],
    ['the gate lost before the removal', { held: false }],
    ['another writer holds the gate', { refuse: 'lock_held' }],
    ['the wait for the gate given up', { refuse: 'cancelled' }],
  ])('%s: nothing removed, and the start goes on', async (_what, options) => {
    strandSocket(socket());
    await expect(
      removeStaleControlSocket(home, { withGate: gate(options), log: quiet })
    ).resolves.toBe(false);
    expect(there(socket())).toBe(true);
  });

  test("the stop's signal reaches the gate's wait", async () => {
    strandSocket(socket());
    const controller = new AbortController();
    const withGate = gate();
    await removeStaleControlSocket(home, { signal: controller.signal, withGate, log: quiet });
    expect(withGate.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
  });
});
