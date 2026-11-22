/**
 * The profile manager through the real freedom-cored (freedom-core design
 * 0013, step PRF-4): main's profile-manager.js against the binary's
 * `profile list`, `create`, `rename`, `import`, `update-nodes`,
 * `reserved-ports`, `status` and `delete`. Skipped unless FREEDOM_CORED_PATH
 * points at a build, or FREEDOM_CORED_PROFILE_TEST=1 asks for the binary
 * `npm run core:download` fetched (CI's e2e-desktop job, on each OS).
 *
 * - **Both ways:** the reference's reads (listProfileSummaries,
 *   getReservedManagedPorts) agree with what the subcommands wrote and say.
 * - **Overrides, and the stale-lease probe:** catalog profiles launched with
 *   each of the data-directory overrides, their locks backdated 31 s while
 *   their profile gates are held: another profile's manager reads each open,
 *   and its delete is refused with nothing changed.
 * - **A launch held before `serve`:** a main stopped for 45 s after its lock
 *   and gate; past 30 s, a delete from another profile is refused.
 * - A closed profile is deleted, its directory with it.
 * - **The packaged default profile, moved** (PRF-9 B3): main's starting move
 *   takes its entries into `<appRoot>/freedom/` and leaves the entries every
 *   profile shares at the app root; its delete from another profile removes
 *   `freedom/` and the placeholder with its other entries, and keeps those.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

jest.mock('electron', () => ({ app: { isPackaged: true } }), { virtual: true });
jest.mock('./logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
let mockBinary = null;
let mockLockDir = null;
jest.mock('./core/cored-binary', () => ({ getCoredBinaryPath: () => mockBinary }));
jest.mock('./service-locks', () => ({ getLockDir: () => mockLockDir }));

const {
  getReservedManagedPorts,
  listProfileSummaries,
  loadCatalog,
} = require('./profile-catalog');
const { startProfileGate } = require('./profile-gate');
const manager = require('./profile-manager');
const { openActiveProfile, openProfile, startProfileMove } = require('./profile-resolver');

const sourceBinary = (() => {
  if (process.env.FREEDOM_CORED_PATH) return process.env.FREEDOM_CORED_PATH;
  if (process.env.FREEDOM_CORED_PROFILE_TEST !== '1') return null;
  const os_ = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  const bin = path.join(__dirname, '..', '..', 'freedom-cored-bin', `${os_}-${process.arch}`, name);
  if (!fs.existsSync(bin)) {
    throw new Error('FREEDOM_CORED_PROFILE_TEST=1 needs freedom-cored: run npm run core:download');
  }
  return bin;
})();
const describeIfBinary = sourceBinary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const HELD_LAUNCH = path.join(__dirname, '..', '..', 'test', 'helpers', 'profile-held-launch.js');
const OVERRIDES = [
  'FREEDOM_IDENTITY_DATA',
  'FREEDOM_ANT_DATA',
  'FREEDOM_BEE_DATA',
  'FREEDOM_IPFS_DATA',
  'FREEDOM_TOR_DATA',
  'FREEDOM_RADICLE_DATA',
  'MYOTIS_DATA_DIR',
];

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 50);
    };
    poll();
  });
}

// A lock in today's format whose holder stopped refreshing 31 s ago.
function backdatedLock(userDataDir) {
  const target = path.join(userDataDir, 'profile-open');
  const lockDir = path.join(userDataDir, 'profile-open.lock');
  fs.writeFileSync(target, 'Freedom profile lock target\n');
  fs.mkdirSync(lockDir);
  const then = new Date(Date.now() - 31_000);
  fs.utimesSync(lockDir, then, then);
}

describeIfBinary('the profile manager through the real freedom-cored (0013, PRF-4)', () => {
  let root;
  let appRoot;
  let app;
  const children = [];
  const gates = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-manager-')));
    appRoot = path.join(root, 'Freedom');
    mockBinary = sourceBinary;
    mockLockDir = path.join(root, 'locks');
    fs.mkdirSync(mockLockDir);
    app = { isPackaged: true, getPath: () => appRoot, setPath() {} };
    // The manager's own profile, `home`, opened as main opens it.
    openActiveProfile(app, {
      backend: 'core',
      argv: ['freedom', '--profile', 'home'],
      env: {},
      command: mockBinary,
      lockDir: mockLockDir,
    });
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const gate of gates.splice(0)) await gate.release();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function launch(id) {
    return openProfile(app, {
      backend: 'core',
      argv: ['freedom', '--profile', id],
      env: {},
      command: mockBinary,
      lockDir: mockLockDir,
    }).profile;
  }

  function catalogText() {
    return fs.readFileSync(path.join(appRoot, 'profile-registry.json'), 'utf8');
  }

  test("both ways: the reference reads what the subcommands wrote", async () => {
    const created = await manager.createProfile({ displayName: 'Work' });
    expect(created.record.id).toBe('work');
    await manager.renameProfile('work', 'Job');
    await manager.updateNodeConfig('tor', { mode: 'disabled' });
    fs.mkdirSync(path.join(appRoot, 'Profiles', 'old'), { recursive: true });
    await manager.importProfile('old');

    const listed = await manager.listProfiles();
    expect(listed).toEqual(listProfileSummaries(appRoot, { activeProfileId: 'home' }));
    expect(listed.find((p) => p.id === 'work').displayName).toBe('Job');
    expect(listed.find((p) => p.id === 'home').nodes.tor.mode).toBe('disabled');
    expect(await manager.getReservedPorts()).toEqual(
      getReservedManagedPorts(appRoot, { checkoutHash: null, dev: false, excludeProfileId: 'home' })
    );
    // The reference's refusals, with its messages.
    await expect(manager.createProfile({ displayName: 'Work' })).rejects.toThrow(
      'Profile already exists: work'
    );
  });

  test('the stale-lease probe, with each override: open to the manager, and its delete refused', async () => {
    for (const [index, variable] of OVERRIDES.entries()) {
      const id = `override-${index}`;
      const outside = path.join(root, `outside-${index}`);
      const profile = launch(id);
      // The launch, as main makes it under the override: the gate is the
      // profile directory's, whatever the override moves.
      const previous = process.env[variable];
      process.env[variable] = outside;
      let gate;
      try {
        gate = startProfileGate(profile, {
          packaged: true,
          log: quietLog,
          command: mockBinary,
          lockDir: mockLockDir,
        });
        gates.push(gate);
        await gate.whenLocked();
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
      backdatedLock(profile.userDataDir);

      const target = await manager.getProfileFocusTarget(id);
      expect({ variable, isLocked: target.isLocked }).toEqual({ variable, isLocked: true });

      const before = catalogText();
      await expect(manager.deleteProfile(id, profile.displayName)).rejects.toEqual(
        expect.objectContaining({ code: 'lock_held', gate: 'profile' })
      );
      expect(catalogText()).toBe(before);
      expect(fs.existsSync(path.join(profile.userDataDir, 'profile.json'))).toBe(true);
    }
  }, 120_000);

  test('a stale lock with the gate free is a crashed process: deleted as today', async () => {
    const profile = launch('crashed');
    backdatedLock(profile.userDataDir);
    expect((await manager.getProfileFocusTarget('crashed')).isLocked).toBe(false);
    const result = await manager.deleteProfile('crashed', profile.displayName);
    expect(result.record.id).toBe('crashed');
    expect(Array.isArray(result.forget)).toBe(true);
    expect(loadCatalog(appRoot).profiles.map((p) => p.id)).not.toContain('crashed');
    expect(fs.existsSync(profile.userDataDir)).toBe(false);
  });

  test(
    'a launch held before serve for 45 s: past 30 s its delete from another profile is refused',
    async () => {
      const profile = launch('held');
      const child = spawn(
        process.execPath,
        [HELD_LAUNCH, mockBinary, mockLockDir, profile.userDataDir, appRoot, 'held', '45000'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      children.push(child);
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      await waitFor(() => out.includes('held\n'), 15_000, 'the held launch');
      const lockDir = path.join(profile.userDataDir, 'profile-open.lock');
      await waitFor(
        () => Date.now() - fs.statSync(lockDir).mtimeMs > 31_000,
        40_000,
        'the lock to read stale'
      );

      expect((await manager.getProfileFocusTarget('held')).isLocked).toBe(true);
      const before = catalogText();
      await expect(manager.deleteProfile('held', profile.displayName)).rejects.toEqual(
        expect.objectContaining({ code: 'lock_held', gate: 'profile' })
      );
      expect(catalogText()).toBe(before);
      expect(fs.existsSync(path.join(profile.userDataDir, 'profile.json'))).toBe(true);
    },
    120_000
  );

  test('the packaged default profile moves into <appRoot>/freedom/, and its delete removes it (PRF-9 B3)', async () => {
    const { profile, report } = openProfile(app, {
      backend: 'core',
      argv: ['freedom', '--profile', 'default'],
      env: {},
      command: mockBinary,
      lockDir: mockLockDir,
    });
    expect(profile.userDataDir).toBe(appRoot);
    expect(report.layout).toBe('root');
    // Its data at the app root, beside what every profile shares there.
    fs.mkdirSync(path.join(appRoot, 'identity'), { mode: 0o700 });
    fs.writeFileSync(path.join(appRoot, 'identity', 'vault-meta.json'), '{}');
    fs.writeFileSync(path.join(appRoot, 'settings.json'), '{"theme":"dark"}');
    fs.mkdirSync(path.join(appRoot, 'ant-data', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'Cookies'), 'cookies');
    fs.mkdirSync(path.join(appRoot, 'R', '0'), { recursive: true });

    expect(startProfileMove(app, profile, report, { command: mockBinary, lockDir: mockLockDir })).toEqual({
      outcome: 'migrated',
    });
    const freedom = path.join(appRoot, 'freedom');
    expect(fs.readFileSync(path.join(freedom, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    expect(fs.existsSync(path.join(freedom, 'identity', 'vault-meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(freedom, 'ant-data', 'keys'))).toBe(true);
    expect(fs.lstatSync(path.join(appRoot, 'identity')).isFile()).toBe(true);
    // The shell's entries and the shared ones stay: the catalog, the other
    // profiles, the Radicle homes.
    expect(fs.readFileSync(path.join(appRoot, 'Cookies'), 'utf8')).toBe('cookies');
    expect(fs.existsSync(path.join(appRoot, 'profile-registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, 'Profiles', 'home', 'profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, 'R', '0'))).toBe(true);
    expect(fs.existsSync(path.join(freedom, 'Profiles'))).toBe(false);

    const result = await manager.deleteProfile('default', profile.displayName);
    expect(result.record.id).toBe('default');
    expect(fs.existsSync(freedom)).toBe(false);
    expect(fs.existsSync(path.join(appRoot, 'identity'))).toBe(false);
    expect(fs.existsSync(path.join(appRoot, 'Cookies'))).toBe(false);
    expect(fs.existsSync(path.join(appRoot, 'profile-registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, 'Profiles', 'home', 'profile.json'))).toBe(true);
    expect(loadCatalog(appRoot).profiles.map((p) => p.id)).toEqual(['home']);
  });
});
