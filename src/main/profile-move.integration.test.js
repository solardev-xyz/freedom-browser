/**
 * The starting move through the real freedom-cored (freedom-core design
 * 0013, "The move"; PRF-9 B3): `profile migrate` without `--finish-only`,
 * run by main's startProfileMove at a start of an idle profile in the root
 * layout, before hold-profile and main's own lock. Skipped unless
 * FREEDOM_CORED_PATH points at a build, or FREEDOM_CORED_PROFILE_TEST=1 asks
 * for the binary `npm run core:download` fetched (CI's e2e-desktop job).
 *
 * - **A seeded root-layout profile** moves, and opens with the same stores:
 *   every Freedom-owned file under `freedom/`, byte for byte, the shell's
 *   entries and the receipts left at the root, the placeholder at
 *   `identity`, and main's getters (settings, identity, the component
 *   directories) resolving into `freedom/` once the root is reset.
 * - **A new profile** takes the empty move: `freedom/`, the marker and the
 *   placeholder.
 * - **Two launches at once,** each through index.js's steps
 *   (test/helpers/profile-move-launch.js): one moves, the other hands over,
 *   and exactly one holds the profile.
 * - **The receipts** at the hello's `user_data_dir` are copied into
 *   `freedom/` and imported from the copy after the move (design 0017 C5),
 *   by a core main's getters point into `freedom/` (PRF-8b-lite).
 * - **A move held 45 s,** with real timings (FREEDOM_CORED_TESTHOOKS=1, a
 *   build with the `testhooks` feature, whose pause hook holds the move
 *   mid-way): past the lock's 30 s a second launch hands over and a
 *   proper-lockfile client finds the profile open, since the move refreshes
 *   its lock; once released, the launch takes main's own lock.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const lockfile = require('proper-lockfile');

// Main's getters read userData from here (mockUserData: the profile a test
// moved), and payment-history.js its core (mockCore).
let mockUserData = null;
let mockCore = null;
jest.mock(
  'electron',
  () => ({
    app: { isPackaged: false, getPath: () => mockUserData, getVersion: () => 'jest' },
    ipcMain: { handle() {}, on() {} },
    webContents: { getAllWebContents: () => [] },
  }),
  { virtual: true }
);
jest.mock('./logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
jest.mock('./core/core-process', () => ({ getCoreClient: () => mockCore }));

const { getCoredBinaryPath } = require('./core/cored-binary');
const { MOVED_ENTRIES, PLACEHOLDER, profileLayout, resolveFreedomRoot } = require('./freedom-root');
const { acquireProfileLock, isProfileLocked, releaseProfileLock } = require('./profile-lock');
const { openProfile, startProfileMove } = require('./profile-resolver');

const required = process.env.FREEDOM_CORED_PROFILE_TEST === '1';
const binary = process.env.FREEDOM_CORED_PATH || (required ? getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_PROFILE_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const testIfHooks = process.env.FREEDOM_CORED_TESTHOOKS === '1' ? test : test.skip;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const LAUNCH = path.join(__dirname, '..', '..', 'test', 'helpers', 'profile-move-launch.js');

jest.setTimeout(120_000);

const RECEIPTS = JSON.stringify([
  {
    id: 'r-1',
    url: 'https://x.example/a',
    origin: 'https://x.example',
    chainId: 8453,
    amount: '500',
    status: 'settled',
    settledAt: 1700000000,
  },
  {
    url: 'https://y.example/b',
    origin: 'https://y.example',
    chainId: 8453,
    amount: '7',
    status: 'no-receipt',
    settledAt: 1700000100,
  },
]);

// A profile as a build before the move left it: Freedom's entries among the
// shell's, at the root.
const SEEDED = {
  'identity/vault-meta.json': '{"version":1}',
  'identity/identity-vault.json': '{"vault":"sealed"}',
  'settings.json': JSON.stringify({ theme: 'dark', enableAi: false }),
  'wallet-intents.jsonl': '{"kind":"intent"}\n',
  'payment-history.sqlite': Buffer.from('SQLite format 3\u0000 rows'),
  'payment-history.sqlite-wal': Buffer.from('committed rows only in the wal'),
  'custom-tokens.json': '[]',
  'ant-data/keys/swarm.key': '{"address":"00"}',
  'ant-data/localstore/sharky/free_000': Buffer.alloc(64 * 1024, 7),
  'ipfs-data/freedom-ipfs/blocks/AB/CD.data': 'block',
  // arti's state lock and Myotis's lease, as files nobody holds.
  'tor-data/state/state/state.lock': '',
  'myotis/.freedom-myotis-lifetime': '',
  'run/ant-password-handoff': 'gone',
  // The shell's entries, and what else stays at the root.
  'Local State': '{}',
  Cookies: 'cookies',
  'Local Storage/leveldb/000003.log': 'local storage',
  'x402-receipts.json': RECEIPTS,
  'radicle-data/keys/radicle': 'radicle',
  'crash-reports/README': 'crash',
};

function seed(dir) {
  fs.mkdirSync(path.join(dir, 'identity'), { recursive: true, mode: 0o700 });
  for (const [rel, data] of Object.entries(SEEDED)) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
}

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Where each seeded file is after the move: under freedom/ for a moved
 * entry, at the root otherwise. */
function expectMovedAsSeeded(dir) {
  const freedom = path.join(dir, 'freedom');
  for (const [rel, data] of Object.entries(SEEDED)) {
    const parts = rel.split('/');
    const moved = MOVED_ENTRIES.includes(parts[0]);
    const at = path.join(moved ? freedom : dir, ...parts);
    expect([rel, digest(at)]).toEqual([
      rel,
      crypto.createHash('sha256').update(data).digest('hex'),
    ]);
    if (moved) expect([rel, fs.existsSync(path.join(dir, ...parts))]).toEqual([rel, false]);
  }
}

/** No moved name at the root but the placeholder file. */
function movedNamesAtRoot(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => MOVED_ENTRIES.includes(name))
    .filter((name) => !(name === PLACEHOLDER && fs.lstatSync(path.join(dir, name)).isFile()));
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
      if (value) resolve(value);
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

describeIfBinary('the starting move through the real freedom-cored (0013, PRF-9 B3)', () => {
  let root;
  let appRoot;
  let app;
  let lockDir;
  const children = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-move-')));
    appRoot = path.join(root, 'Freedom');
    lockDir = path.join(root, 'locks');
    fs.mkdirSync(lockDir);
    app = { isPackaged: true, getPath: () => appRoot, setPath() {} };
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function open(id) {
    return openProfile(app, {
      backend: 'core',
      argv: ['freedom', '--profile', id],
      env: {},
      command: binary,
      lockDir,
    });
  }

  /** A launch through index.js's steps, in a process of its own. */
  function launch(id, release, pause) {
    const child = spawn(
      process.execPath,
      [LAUNCH, binary, lockDir, appRoot, id, release, ...(pause ? [pause] : [])],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    children.push(child);
    const out = { text: '', err: '' };
    child.stdout.on('data', (chunk) => {
      out.text += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out.err += chunk;
    });
    out.lines = () => out.text.split('\n').filter(Boolean);
    return out;
  }

  test('a seeded root-layout profile moves, and opens with the same stores', () => {
    const { profile, report } = open('seeded');
    expect(report.layout).toBe('root');
    seed(profile.userDataDir);

    const moved = startProfileMove(app, profile, report, { command: binary, lockDir });
    expect(moved).toEqual({ outcome: 'migrated' });

    const dir = profile.userDataDir;
    const freedom = path.join(dir, 'freedom');
    expectMovedAsSeeded(dir);
    expect(fs.lstatSync(path.join(dir, PLACEHOLDER)).isFile()).toBe(true);
    expect(movedNamesAtRoot(dir)).toEqual([]);
    expect(fs.existsSync(path.join(freedom, 'layout.json'))).toBe(true);
    expect(fs.existsSync(path.join(freedom, '.move.json'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(freedom, 'identity')).mode & 0o777).toBe(0o700);
    }
    // The move let its lock go: main takes its own.
    expect(isProfileLocked(profile)).toBe(false);

    // The next start: the moved layout, and nothing to move.
    const again = open('seeded');
    expect(again.report.layout).toBe('freedom');
    expect(
      startProfileMove(app, again.profile, again.report, { command: binary, lockDir })
    ).toEqual({
      outcome: 'skipped',
      reason: 'layout',
    });

    // Main's getters, once the root is reset after the move (index.js).
    mockUserData = dir;
    jest.isolateModules(() => {
      const freedomRoot = require('./freedom-root');
      freedomRoot.holdFreedomRoot();
      freedomRoot.resetFreedomRoot();
      expect(freedomRoot.getFreedomDataDir()).toBe(freedom);
      expect(resolveFreedomRoot(dir)).toBe(freedom);
      const paths = require('./profile-paths');
      expect(paths.getIdentityDataDir()).toBe(path.join(freedom, 'identity'));
      expect(paths.getComponentDataDirs().ant).toBe(path.join(freedom, 'ant-data'));
      expect(paths.getComponentDataDirs().radicle).toBe(path.join(dir, 'radicle-data'));
      const settings = require('./settings-store').peekSettings();
      expect(settings.theme).toBe('dark');
      expect(settings.enableAi).toBe(false);
    });
  });

  test('a new profile takes the empty move: freedom/, the marker and the placeholder', () => {
    const { profile, report } = open('fresh');
    expect(report.layout).toBe('root');
    expect(startProfileMove(app, profile, report, { command: binary, lockDir })).toEqual({
      outcome: 'migrated',
    });
    expect(profileLayout(profile.userDataDir)).toBe('freedom');
    expect(fs.readdirSync(path.join(profile.userDataDir, 'freedom'))).toEqual(['layout.json']);
    expect(fs.lstatSync(path.join(profile.userDataDir, PLACEHOLDER)).isFile()).toBe(true);
  });

  test('a node identity journal defers the move, with its reason, and nothing changed', () => {
    const { profile, report } = open('journal');
    seed(profile.userDataDir);
    fs.writeFileSync(
      path.join(profile.userDataDir, 'identity', 'node-identity-journal.json'),
      '{}'
    );
    expect(startProfileMove(app, profile, report, { command: binary, lockDir })).toEqual({
      outcome: 'deferred',
      reason: 'node_identity_journal',
    });
    expect(profileLayout(profile.userDataDir)).toBe('root');
    expect(fs.existsSync(path.join(profile.userDataDir, 'freedom'))).toBe(false);
    expect(digest(path.join(profile.userDataDir, 'settings.json'))).toBe(
      crypto.createHash('sha256').update(SEEDED['settings.json']).digest('hex')
    );
  });

  test('two launches at once: one moves, the other hands over', async () => {
    const { profile } = open('race');
    seed(profile.userDataDir);
    const release = path.join(root, 'release');
    const launches = [launch('race', release), launch('race', release)];
    await waitFor(() => launches.every((l) => l.lines().length > 0), 60_000, 'both launches');
    const first = launches.map((l) => l.lines()[0].split(' '));
    // Exactly one holds the profile, and it reads the moved layout.
    const opened = first.filter((words) => words[0] === 'opened');
    expect(opened).toHaveLength(1);
    expect(opened[0][2]).toBe('freedom');
    expect(first.filter((words) => words[0] === 'handed-over')).toHaveLength(1);
    // Exactly one moved: the other found it busy, open, or already moved.
    const outcomes = first.map((words) => (words[0] === 'opened' ? words[1] : words[2]));
    expect(outcomes.filter((outcome) => outcome === 'migrated')).toHaveLength(1);
    fs.writeFileSync(release, '');
    await waitFor(
      () => launches.some((l) => l.lines().includes('released')),
      30_000,
      'the opened launch to let go'
    );
    expectMovedAsSeeded(profile.userDataDir);
    expect(movedNamesAtRoot(profile.userDataDir)).toEqual([]);
  });

  test("the receipts at the profile's root are imported after the move, from their copy in freedom/, by a core main's getters point into freedom/", async () => {
    const { profile, report } = open('receipts');
    seed(profile.userDataDir);
    // A database the core makes, not the seeded stand-in.
    fs.rmSync(path.join(profile.userDataDir, 'payment-history.sqlite'));
    fs.rmSync(path.join(profile.userDataDir, 'payment-history.sqlite-wal'));
    expect(startProfileMove(app, profile, report, { command: binary, lockDir })).toEqual({
      outcome: 'migrated',
    });
    const dir = profile.userDataDir;
    const freedom = path.join(dir, 'freedom');
    const legacy = path.join(dir, 'x402-receipts.json');
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(path.join(freedom, 'x402-receipts.json'))).toBe(false);

    mockUserData = dir;
    try {
      let history;
      jest.isolateModules(() => {
        const freedomRoot = require('./freedom-root');
        freedomRoot.resetFreedomRoot();
        const { getIdentityDataDir } = require('./profile-paths');
        const { CoreClient } = require('./core/core-client');
        // core-process.js's arguments, from main's getters; the client adds
        // the grant's (freedom-core design 0017, C1).
        mockCore = new CoreClient({
          spawn,
          command: binary,
          args: ['serve', '--data-dir', getIdentityDataDir(), '--lock-dir', lockDir],
          log: quietLog,
          shellVersion: 'jest',
          grantRoot: freedomRoot.getFreedomDataDir(),
          userDataDir: dir,
        });
        history = require('./payment-history');
      });
      await mockCore.start();
      expect(mockCore.service.helloParams(mockCore).grant_root).toBe(freedom);
      expect(mockCore.service.helloParams(mockCore).user_data_dir).toBe(dir);
      expect(await history.getCount({ kind: 'x402' })).toBe(2);
      // The core (design 0017 C5) imported a copy in freedom/ and renamed the
      // copy; the original stays at the root until a later start.
      expect(fs.existsSync(path.join(freedom, 'x402-receipts.json.migrated'))).toBe(true);
      expect(fs.existsSync(path.join(freedom, 'x402-receipts.json'))).toBe(false);
      expect(fs.existsSync(legacy)).toBe(true);
      expect(fs.existsSync(`${legacy}.migrated`)).toBe(false);
      expect(fs.existsSync(path.join(freedom, 'payment-history.sqlite'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'payment-history.sqlite'))).toBe(false);
      // The next start drops the original, and imports nothing twice.
      await mockCore.stop();
      await mockCore.start();
      expect(await history.getCount({ kind: 'x402' })).toBe(2);
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(`${legacy}.migrated`)).toBe(false);
    } finally {
      if (mockCore) await mockCore.stop();
      mockCore = null;
    }
  });

  testIfHooks(
    'a move held 45 s: a second launch hands over, a proper-lockfile client finds it open, then main takes its lock',
    async () => {
      const { profile } = open('held');
      seed(profile.userDataDir);
      const marker = path.join(root, 'paused');
      const resume = path.join(root, 'resume');
      const release = path.join(root, 'release');
      // Held with every entry renamed into freedom/ and the journal there.
      const first = launch('held', release, `after-renames=${marker}=${resume}`);
      await waitFor(() => fs.existsSync(marker), 30_000, 'the move to pause');
      const pausedAt = Date.now();
      expect(profileLayout(profile.userDataDir)).toBe('pending');

      await new Promise((resolve) => setTimeout(resolve, 45_000 - (Date.now() - pausedAt)));
      // Past the lock's 30 s, the move's refresher keeps it fresh.
      const target = path.join(profile.userDataDir, 'profile-open');
      const lockPath = path.join(profile.userDataDir, 'profile-open.lock');
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(15_000);
      expect(
        lockfile.checkSync(target, { lockfilePath: lockPath, realpath: false, stale: 30_000 })
      ).toBe(true);
      expect(() =>
        lockfile.lockSync(target, { lockfilePath: lockPath, realpath: false, stale: 30_000 })
      ).toThrow(expect.objectContaining({ code: 'ELOCKED' }));
      expect(isProfileLocked(profile)).toBe(true);

      // A second launch: the profile reads open, its journal held.
      const second = open('held');
      expect(second.report).toEqual(
        expect.objectContaining({ layout: 'pending', lockFresh: true, gateHeld: true })
      );
      const other = launch('held', release);
      await waitFor(() => other.lines().length > 0, 30_000, 'the second launch');
      expect(other.lines()[0]).toMatch(/^handed-over /);

      // Released: the move finishes, and the launch takes main's own lock.
      fs.writeFileSync(resume, '');
      await waitFor(() => first.lines().length > 0, 30_000, 'the move to finish');
      expect(first.lines()[0]).toBe('opened migrated freedom');
      expectMovedAsSeeded(profile.userDataDir);
      fs.writeFileSync(release, '');
      await waitFor(() => first.lines().includes('released'), 30_000, 'the launch to let go');
      const lock = acquireProfileLock(profile, { logger: quietLog });
      releaseProfileLock(lock, { logger: quietLog });
    },
    120_000
  );
});
