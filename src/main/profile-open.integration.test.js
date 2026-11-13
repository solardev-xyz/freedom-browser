/**
 * Opening a profile through the real freedom-cored (freedom-core design
 * 0013, step PRF-4): `profile open`, `profile migrate --finish-only` and
 * `hold-profile`, through main's own modules. Skipped unless
 * FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/profile-open.integration
 * or FREEDOM_CORED_PROFILE_TEST=1 asks for the binary `npm run
 * core:download` fetched, which must then be there (CI's e2e-desktop job,
 * on each OS).
 *
 * - **Downgrade:** the reference resolver (resolveProfile) opens a catalog
 *   the subcommands wrote, packaged and dev.
 * - **The moved layout** opens, its Freedom root resolved; so does a
 *   profile with a move's journal pending before its marker (rolled back)
 *   and after it (finished).
 * - **A launch held before `serve`:** a main that took the lock and the
 *   gate, then stopped for 45 s; past the lock's 30 s a second launch finds
 *   the profile open (the gate held, the lock stale) and hands over.
 * - **The holder killed while main runs:** main takes the gate again.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });

const { getCoredBinaryPath } = require('./core/cored-binary');
const {
  MOVED_ENTRIES,
  profileLayout,
  resolveFreedomRoot,
} = require('./freedom-root');
const { loadCatalog } = require('./profile-catalog');
const { hasStaleProfileLock, isProfileLocked } = require('./profile-lock');
const {
  isProfileGateHeldSync,
  isProfileHeldElsewhere,
  startProfileGate,
} = require('./profile-gate');
const { finishProfileMove, openProfile, resolveProfile } = require('./profile-resolver');
const subcommands = require('./profile-subcommands');

const required = process.env.FREEDOM_CORED_PROFILE_TEST === '1';
const binary = process.env.FREEDOM_CORED_PATH || (required ? getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_PROFILE_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const HELD_LAUNCH = path.join(__dirname, '..', '..', 'test', 'helpers', 'profile-held-launch.js');

function packagedApp(appRoot) {
  return { isPackaged: true, getPath: () => appRoot, setPath() {} };
}

function devApp(appData) {
  return {
    isPackaged: false,
    getPath: (name) => {
      if (name === 'appData') return appData;
      throw new Error(`unexpected getPath(${name})`);
    },
    setPath() {},
  };
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try {
        value = predicate();
      } catch {
        value = false;
      }
      if (value) {
        resolve(value);
      } else if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${label}`));
      } else {
        setTimeout(poll, 50);
      }
    };
    poll();
  });
}

describeIfBinary('opening a profile through the real freedom-cored (0013, PRF-4)', () => {
  let root;
  let lockDir;
  const children = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-open-')));
    lockDir = path.join(root, 'locks');
    fs.mkdirSync(lockDir);
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function open(app, options = {}) {
    return openProfile(app, {
      backend: 'core',
      argv: ['freedom'],
      env: {},
      command: binary,
      lockDir,
      ...options,
    });
  }

  test('downgrade: the reference resolver opens a catalog the subcommands wrote (packaged)', () => {
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    open(app, { argv: ['freedom', '--profile', 'work'] });
    // A second opening fills what the first left out (`fillMissingNodeConfig`),
    // as the reference's does.
    const work = open(app, { argv: ['freedom', '--profile', 'work'] });
    expect(work.report).toEqual(
      expect.objectContaining({ backend: 'core', lockFresh: false, gateHeld: false, layout: 'root' })
    );

    const catalog = loadCatalog(appRoot);
    expect(catalog.profiles.map((p) => p.id).sort()).toEqual(['default', 'work']);

    const reference = resolveProfile(app, {
      argv: ['freedom', '--profile', 'work'],
      env: {},
      now: '2026-11-13T00:00:00.000Z',
    });
    expect(reference.userDataDir).toBe(work.profile.userDataDir);
    expect(reference.metadata.slot).toBe(work.profile.metadata.slot);
    expect(reference.metadata.nodes).toEqual(work.profile.metadata.nodes);
    expect(reference.displayName).toBe(work.profile.displayName);
    const fallback = resolveProfile(app, { argv: ['freedom', '--profile', 'default'], env: {} });
    expect(fallback.userDataDir).toBe(appRoot);
  });

  test('downgrade: the reference resolver opens a catalog the subcommands wrote (dev)', () => {
    const devHome = path.join(root, 'dev-home');
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{}');
    const app = devApp(path.join(root, 'appData'));
    const env = { FREEDOM_DEV_HOME: devHome };
    open(app, { argv: ['electron', '.', '--profile=lab'], env, repoRoot });
    const opened = open(app, { argv: ['electron', '.', '--profile=lab'], env, repoRoot });
    expect(opened.profile.isDev).toBe(true);
    expect(opened.profile.userDataDir).toBe(path.join(devHome, 'Profiles', 'lab'));

    const reference = resolveProfile(app, { argv: ['electron', '.', '--profile=lab'], env, repoRoot });
    expect(reference.userDataDir).toBe(opened.profile.userDataDir);
    expect(reference.metadata.nodes).toEqual(opened.profile.metadata.nodes);
  });

  test('a profile in the moved layout opens, its Freedom root resolved', () => {
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    const dir = open(app, { argv: ['freedom', '--profile', 'moved'] }).profile.userDataDir;
    // The layout PRF-9's move leaves: every listed entry in freedom/, the
    // placeholder file at identity, the marker.
    const freedom = path.join(dir, 'freedom');
    fs.mkdirSync(path.join(freedom, 'identity'), { recursive: true });
    fs.writeFileSync(path.join(freedom, 'identity', 'vault-meta.json'), '{}');
    fs.mkdirSync(path.join(freedom, 'ipfs-data', 'freedom-ipfs'), { recursive: true });
    fs.writeFileSync(path.join(freedom, 'settings.json'), '{}');
    fs.writeFileSync(path.join(dir, 'identity'), 'moved to freedom/identity\n');
    fs.writeFileSync(
      path.join(freedom, 'layout.json'),
      JSON.stringify({ version: 1, moved_at: '2026-11-13T00:00:00.000Z', by: 'test' })
    );

    const again = open(app, { argv: ['freedom', '--profile', 'moved'] });
    expect(again.report.layout).toBe('freedom');
    expect(again.profile.userDataDir).toBe(dir);
    expect(resolveFreedomRoot(dir)).toBe(freedom);
    // Nothing to settle: no journal.
    expect(finishProfileMove(again.profile, { command: binary, lockDir })).toBe('nothing');
    expect(fs.readFileSync(path.join(freedom, 'settings.json'), 'utf8')).toBe('{}');
  });

  test("a move's journal pending before its marker is rolled back", () => {
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    const dir = open(app, { argv: ['freedom', '--profile', 'half'] }).profile.userDataDir;
    fs.mkdirSync(path.join(dir, 'identity'));
    fs.writeFileSync(path.join(dir, 'identity', 'vault-meta.json'), '{"v":1}');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"s":1}');
    // The journal written, then the first entry renamed, then a crash.
    fs.mkdirSync(path.join(dir, 'freedom'));
    fs.writeFileSync(
      path.join(dir, 'freedom', '.move.json'),
      JSON.stringify({ version: 1, entries: ['settings.json', 'identity'] })
    );
    fs.renameSync(path.join(dir, 'settings.json'), path.join(dir, 'freedom', 'settings.json'));

    const opened = open(app, { argv: ['freedom', '--profile', 'half'] });
    expect(opened.report.layout).toBe('pending');
    expect(finishProfileMove(opened.profile, { command: binary, lockDir })).toBe('rolled_back');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{"s":1}');
    expect(fs.readFileSync(path.join(dir, 'identity', 'vault-meta.json'), 'utf8')).toBe('{"v":1}');
    expect(profileLayout(dir)).toBe('root');
    expect(resolveFreedomRoot(dir)).toBe(dir);
    // The move held the lock in today's format, and let it go.
    expect(isProfileLocked({ userDataDir: dir })).toBe(false);
  });

  test("a move's journal pending after its marker is finished", () => {
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    const dir = open(app, { argv: ['freedom', '--profile', 'late'] }).profile.userDataDir;
    const freedom = path.join(dir, 'freedom');
    fs.mkdirSync(path.join(freedom, 'identity'), { recursive: true });
    fs.writeFileSync(path.join(freedom, 'identity', 'vault-meta.json'), '{"v":2}');
    fs.writeFileSync(path.join(freedom, 'settings.json'), '{"s":2}');
    fs.writeFileSync(path.join(dir, 'identity'), 'moved to freedom/identity\n');
    fs.writeFileSync(
      path.join(freedom, '.move.json'),
      JSON.stringify({ version: 1, entries: ['settings.json', 'identity'] })
    );
    fs.writeFileSync(
      path.join(freedom, 'layout.json'),
      JSON.stringify({ version: 1, moved_at: '2026-11-13T00:00:00.000Z', by: 'test' })
    );

    const opened = open(app, { argv: ['freedom', '--profile', 'late'] });
    expect(opened.report.layout).toBe('pending');
    expect(finishProfileMove(opened.profile, { command: binary, lockDir })).toBe('migrated');
    expect(fs.existsSync(path.join(freedom, '.move.json'))).toBe(false);
    expect(profileLayout(dir)).toBe('freedom');
    expect(resolveFreedomRoot(dir)).toBe(freedom);
    expect(fs.readFileSync(path.join(freedom, 'settings.json'), 'utf8')).toBe('{"s":2}');
  });

  test('every moved entry is a name the core recovers', () => {
    // The journal takes fc-profile's list; ours must name nothing it refuses.
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    const dir = open(app, { argv: ['freedom', '--profile', 'names'] }).profile.userDataDir;
    const freedom = path.join(dir, 'freedom');
    fs.mkdirSync(freedom);
    for (const name of MOVED_ENTRIES) {
      // The directories (identity/, the nodes' data, run/) as directories.
      if (name.includes('.')) fs.writeFileSync(path.join(freedom, name), '');
      else fs.mkdirSync(path.join(freedom, name));
    }
    fs.writeFileSync(path.join(freedom, '.move.json'), JSON.stringify({ version: 1, entries: MOVED_ENTRIES }));
    fs.writeFileSync(path.join(freedom, 'layout.json'), JSON.stringify({ version: 1 }));
    expect(finishProfileMove({ userDataDir: dir }, { command: binary, lockDir })).toBe('migrated');
  });

  test(
    'a launch held before serve for 45 s: past 30 s a second launch finds the profile open',
    async () => {
      const appRoot = path.join(root, 'Freedom');
      const app = packagedApp(appRoot);
      const { profile } = open(app, { argv: ['freedom', '--profile', 'held'] });

      const child = spawn(
        process.execPath,
        [HELD_LAUNCH, binary, lockDir, profile.userDataDir, appRoot, 'held', '45000'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      children.push(child);
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      await waitFor(() => out.includes('held\n'), 15_000, 'the held launch');

      // Past the lock's 30 s, with the first main still stopped.
      await waitFor(() => hasStaleProfileLock(profile), 40_000, 'the lock to read stale');

      // The second launch: `profile open` reports the gate held.
      const second = open(app, { argv: ['freedom', '--profile', 'held'] });
      expect(second.report.lockFresh).toBe(false);
      expect(second.report.gateHeld).toBe(true);
      expect(
        isProfileHeldElsewhere(second.report, second.profile, {
          hasStaleLock: hasStaleProfileLock,
          askGate: () => {
            throw new Error('not asked: profile open answered');
          },
        })
      ).toBe(true);
      // Where `profile open` doesn't run (Windows, --profile-dir), the stale
      // lock's gate is asked: held.
      expect(
        isProfileHeldElsewhere({ gateHeld: null }, second.profile, {
          hasStaleLock: hasStaleProfileLock,
          askGate: (p) => isProfileGateHeldSync(p, { command: binary, lockDir, log: quietLog }),
        })
      ).toBe(true);
      // And its own holder can't take the gate.
      const gate = startProfileGate(second.profile, {
        packaged: true,
        log: quietLog,
        command: binary,
        lockDir,
      });
      await expect(gate.whenLocked()).rejects.toEqual(expect.objectContaining({ code: 'lock_held' }));

      // The first main resumes, and lets both go.
      await waitFor(() => out.includes('released\n'), 30_000, 'the held launch to release');
      const status = await subcommands.run(binary, [
        'profile',
        'status',
        '--lock-dir',
        lockDir,
        '--user-data-dir',
        profile.userDataDir,
      ]);
      expect(status.result[0]).toEqual(expect.objectContaining({ open: false, gate_held: false }));
    },
    120_000
  );

  test('the holder killed while main runs: main takes the gate again', async () => {
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    const { profile } = open(app, { argv: ['freedom', '--profile', 'kill'] });
    const holders = [];
    const onFatal = jest.fn();
    const gate = startProfileGate(profile, {
      packaged: true,
      log: quietLog,
      command: binary,
      lockDir,
      onFatal,
      spawn: (...args) => {
        const child = spawn(...args);
        holders.push(child);
        return child;
      },
    });
    try {
      await gate.whenLocked();
      expect(isProfileGateHeldSync(profile, { command: binary, lockDir, log: quietLog })).toBe(true);
      holders[0].kill('SIGKILL');
      await waitFor(() => holders.length === 2 && gate.held(), 15_000, 'the gate taken again');
      expect(onFatal).not.toHaveBeenCalled();
      expect(isProfileGateHeldSync(profile, { command: binary, lockDir, log: quietLog })).toBe(true);
    } finally {
      await gate.release();
    }
    expect(isProfileGateHeldSync(profile, { command: binary, lockDir, log: quietLog })).toBe(false);
  }, 60_000);

  // A machine no new build has run on: nothing has created the lock directory
  // yet, and `hold-profile` alone fails with 74 (storage) without it. Every
  // CI runner's first launch is one.
  test('the first launch on a machine without the lock directory takes the gate', async () => {
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    const freshLockDir = path.join(root, 'fresh', 'locks');
    const { profile } = open(app, { argv: ['freedom', '--profile', 'first'], lockDir: freshLockDir });
    const gate = startProfileGate(profile, {
      packaged: true,
      log: quietLog,
      command: binary,
      lockDir: freshLockDir,
    });
    try {
      await gate.whenLocked();
      expect(gate.held()).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(freshLockDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      await gate.release();
    }
  });

  test('hold-profile refuses a catalog profile no longer listed at its directory', async () => {
    const appRoot = path.join(root, 'Freedom');
    const app = packagedApp(appRoot);
    const { profile } = open(app, { argv: ['freedom', '--profile', 'gone'] });
    const gate = startProfileGate(
      { ...profile, id: 'another' },
      { packaged: true, log: quietLog, command: binary, lockDir }
    );
    await expect(gate.whenLocked()).rejects.toEqual(expect.objectContaining({ code: 'refused' }));
  });
});
