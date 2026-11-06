/**
 * A profile's core gate held from main (freedom-core design 0001, "Lifetime
 * lock"), against a fake `freedom-cored hold-lock` child: `locked` resolves
 * the hold, each exit code its refusal, a release closes stdin, a holder
 * that ends unasked is reported, and a missing binary follows the build's
 * rule. The holder's own mechanics are hold-lock.js's, which
 * ipfsd-gate.test.js covers in full; the real binary's gate is
 * core-gate.integration.test.js's.
 */

const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-locks', () => ({
  getLockDir: () => require('path').join('app-data', 'Freedom', 'locks'),
}));

const { app } = require('electron');

let mockBinaryPresent = true;
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (p) => (/freedom-cored/.test(p) ? mockBinaryPresent : actual.existsSync(p)),
  };
});

const { CoreGateError, holdCoreGate, takeCoreGate, withCoreGate } = require('./core-gate');

/** A hold-lock child the test drives. */
class FakeHolder extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdinEnded = false;
    this.stdin.on('finish', () => {
      this.stdinEnded = true;
      setImmediate(() => this.exit(0));
    });
  }

  locked() {
    this.stdout.write('locked\n');
  }

  exit(code, signal = null) {
    this.emit('exit', code, signal);
  }

  kill(signal) {
    setImmediate(() => this.exit(null, signal));
    return true;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const noTimer = () => ({});
let log;

beforeEach(() => {
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  mockBinaryPresent = true;
  app.isPackaged = false;
});

afterEach(() => {
  delete process.resourcesPath;
});

/** Options whose spawn records each holder; `locks` says whether it locks. */
function holders({ locks = true } = {}) {
  const spawned = [];
  const spawn = jest.fn((command, args, options) => {
    const child = new FakeHolder();
    spawned.push({ command, args, options, child });
    if (locks) setImmediate(() => child.locked());
    return child;
  });
  return { spawned, options: { log, spawn, setTimer: noTimer, clearTimer: () => {} } };
}

describe('holdCoreGate', () => {
  test("runs freedom-cored's hold-lock on the identity and lock directories, in the scrubbed environment", async () => {
    const { spawned, options } = holders();
    const hold = await holdCoreGate({
      identityDir: path.join('profile', 'identity'),
      command: 'freedom-cored',
      ...options,
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe('freedom-cored');
    expect(spawned[0].args).toEqual([
      'hold-lock',
      '--data-dir',
      path.join('profile', 'identity'),
      '--lock-dir',
      path.join('app-data', 'Freedom', 'locks'),
    ]);
    expect(Object.keys(spawned[0].options.env).every((key) => !/proxy|^FREEDOM_/i.test(key))).toBe(
      true
    );
    await hold.release();
    expect(spawned[0].child.stdinEnded).toBe(true);
  });

  test.each([
    [
      75,
      'lock_held',
      "The profile's identity data is in use by another process. Close the profile and try again.",
    ],
    [74, 'storage', "The profile's core lock can't be taken on this storage"],
    [64, 'usage', 'freedom-cored refused the hold-lock command'],
    [70, 'failed', "freedom-cored couldn't hold the profile's core lock"],
  ])('exit %i before `locked` is %s', async (code, kind, message) => {
    const { spawned, options } = holders({ locks: false });
    const promise = holdCoreGate({ identityDir: 'identity', command: 'freedom-cored', ...options });
    spawned[0].child.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'cannot take the gate', error: 'why' })}\n`
    );
    await tick();
    spawned[0].child.exit(code);
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(CoreGateError);
    expect(err).toMatchObject({ name: 'CoreGateError', code: kind, message });
    expect(log.warn).toHaveBeenCalledWith('[Core] freedom-cored hold-lock failed', {
      code: kind,
      exit: code,
      signal: null,
      cause: 'why',
    });
  });

  test('a holder that ends unasked is lost, and reported', async () => {
    const { spawned, options } = holders();
    const onLost = jest.fn();
    await holdCoreGate({ identityDir: 'identity', command: 'freedom-cored', onLost, ...options });
    spawned[0].child.exit(null, 'SIGKILL');
    expect(onLost).toHaveBeenCalledWith({ code: null, signal: 'SIGKILL' });
    expect(log.error).toHaveBeenCalledWith(
      '[Core] freedom-cored hold-lock ended while holding the gate',
      { exit: null, signal: 'SIGKILL' }
    );
  });
});

describe("the build's rule for a missing binary", () => {
  test('a development build goes on without the gate, and says so', async () => {
    mockBinaryPresent = false;
    await expect(takeCoreGate('identity', { log })).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('npm run core:download'));
    const fn = jest.fn(async (gate) => gate);
    await expect(withCoreGate('identity', fn, { log })).resolves.toEqual({
      gated: false,
      held: expect.any(Function),
    });
  });

  test('a packaged build requires it: nothing runs without the gate', async () => {
    mockBinaryPresent = false;
    app.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', { value: 'resources', configurable: true });
    const fn = jest.fn();
    await expect(withCoreGate('identity', fn, { log })).rejects.toMatchObject({
      name: 'CoreGateError',
      code: 'missing',
      message: 'freedom-cored is missing from this installation. Reinstall Freedom.',
    });
    expect(fn).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('withCoreGate', () => {
  test('runs `fn` holding the gate, and releases it however `fn` ends', async () => {
    const { spawned, options } = holders();
    const seen = [];
    await withCoreGate(
      'identity',
      async (gate) => {
        seen.push({
          gated: gate.gated,
          held: gate.held(),
          stdinEnded: spawned[0].child.stdinEnded,
        });
      },
      options
    );
    expect(seen).toEqual([{ gated: true, held: true, stdinEnded: false }]);
    expect(spawned[0].child.stdinEnded).toBe(true);

    await expect(
      withCoreGate(
        'identity',
        async () => {
          throw new Error('boom');
        },
        options
      )
    ).rejects.toThrow('boom');
    expect(spawned[1].child.stdinEnded).toBe(true);
  });

  test('a holder that ends mid-`fn` reads as no longer held', async () => {
    const { spawned, options } = holders();
    const onLost = jest.fn();
    await withCoreGate(
      'identity',
      async (gate) => {
        expect(gate.held()).toBe(true);
        spawned[0].child.exit(null, 'SIGKILL');
        expect(gate.held()).toBe(false);
      },
      { ...options, onLost }
    );
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  test("a packaged build's profile delete holds it on <profile>/identity, then takes the IPFS gate", async () => {
    app.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', { value: 'resources', configurable: true });
    const os = require('os');
    const fs = require('fs');
    const { deleteProfile, ensureProfile, loadCatalog } = require('../profile-catalog');
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-core-gate-delete-'));
    try {
      const profiles = { defaultProfileDir: path.join(appRoot, 'Profiles', 'default') };
      ensureProfile(appRoot, 'default', profiles);
      const { record } = ensureProfile(appRoot, 'work', profiles);
      const { spawned, options } = holders();
      const ipfsUnder = [];

      await deleteProfile(appRoot, 'work', 'Work', {
        ...profiles,
        withCoreGate: (dir, fn) => withCoreGate(dir, fn, options),
        withIpfsGate: async (_dir, fn) => {
          ipfsUnder.push(spawned.map((s) => s.child.stdinEnded));
          return fn();
        },
      });

      const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
      expect(spawned.map((s) => [s.command, ...s.args.slice(0, 3)])).toEqual([
        [
          path.join('resources', 'freedom-cored', name),
          'hold-lock',
          '--data-dir',
          path.join(path.resolve(record.dir), 'identity'),
        ],
      ]);
      // The IPFS gate was taken while the core gate's holder still held it.
      expect(ipfsUnder).toEqual([[false]]);
      expect(spawned[0].child.stdinEnded).toBe(true);
      expect(fs.existsSync(record.dir)).toBe(false);
      expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['default']);
    } finally {
      fs.rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
