const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createAppMock,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');
const {
  getCheckoutId,
  getDevPortOffset,
  hashPath,
  PROFILE_CATALOG_LOCK_TARGET,
} = require('./profile-catalog');

function makeTempDir(prefix = 'freedom-profile-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepoRoot() {
  const repoRoot = makeTempDir('freedom-repo-');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"freedom-browser"}');
  fs.mkdirSync(path.join(repoRoot, 'src', 'main'), { recursive: true });
  return repoRoot;
}

describe('profile resolver', () => {
  let tempDirs = [];

  afterEach(() => {
    tempDirs.forEach(removeTempUserDataDir);
    tempDirs = [];
  });

  function track(dir) {
    tempDirs.push(dir);
    return dir;
  }

  test('uses existing packaged userData as the default profile root', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(profile.id).toBe('default');
    expect(profile.userDataDir).toBe(userDataDir);
    expect(profile.appRoot).toBe(userDataDir);
    expect(fs.existsSync(path.join(userDataDir, 'profile-registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, PROFILE_CATALOG_LOCK_TARGET))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'profile.json'))).toBe(true);
    expect(profile.metadata.nodes.bee.apiPort).toBe(11633);
    expect(profile.metadata.nodes.tor.socksPort).toBe(19150);
  });

  test('resolves named packaged profiles under Profiles and creates the default entry', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(profile.id).toBe('work');
    expect(profile.userDataDir).toBe(path.join(userDataDir, 'Profiles', 'work'));
    expect(profile.metadata.nodes.bee.apiPort).toBe(11634);
    expect(profile.metadata.nodes.tor.socksPort).toBe(19151);

    const catalog = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile-registry.json'), 'utf-8')
    );
    expect(catalog.profiles.map((entry) => entry.id)).toEqual(['default', 'work']);
  });

  test('updates lastOpenedAt only for the profile selected for launch', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    resolveProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: {},
      now: '2026-05-26T00:00:00.000Z',
    });

    const catalog = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile-registry.json'), 'utf-8')
    );
    const byId = Object.fromEntries(catalog.profiles.map((profile) => [profile.id, profile]));
    const defaultMetadata = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile.json'), 'utf-8')
    );
    const workMetadata = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'Profiles', 'work', 'profile.json'), 'utf-8')
    );

    expect(byId.default.lastOpenedAt).toBe('2026-05-25T00:00:00.000Z');
    expect(defaultMetadata.lastOpenedAt).toBe('2026-05-25T00:00:00.000Z');
    expect(byId.work.lastOpenedAt).toBe('2026-05-26T00:00:00.000Z');
    expect(workMetadata.lastOpenedAt).toBe('2026-05-26T00:00:00.000Z');
  });

  test('reopens the most recently opened profile when launched without an explicit profile', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    // default opened first, then work — work is the last active profile.
    resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });
    resolveProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: {},
      now: '2026-05-26T00:00:00.000Z',
    });

    const profile = resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-27T00:00:00.000Z',
    });

    expect(profile.id).toBe('work');
  });

  test('explicit --profile still overrides the last opened profile', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    resolveProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: {},
      now: '2026-05-26T00:00:00.000Z',
    });

    const profile = resolveProfile(app, {
      argv: ['electron', '.', '--profile=default'],
      env: {},
      now: '2026-05-27T00:00:00.000Z',
    });

    expect(profile.id).toBe('default');
  });

  test('uses FREEDOM_TEST_USER_DATA as the highest-precedence bypass', () => {
    const userDataDir = track(makeTempDir());
    const testUserData = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { initializeProfile } = require('./profile-resolver');

    const profile = initializeProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: { FREEDOM_TEST_USER_DATA: testUserData },
    });

    expect(profile.source).toBe('test-user-data');
    expect(profile.userDataDir).toBe(testUserData);
    expect(app.setPath).toHaveBeenCalledWith('userData', testUserData);
    expect(app.setPath).toHaveBeenCalledWith(
      'crashDumps',
      path.join(testUserData, 'crash-reports')
    );
    expect(fs.existsSync(path.join(userDataDir, 'profile-registry.json'))).toBe(false);
  });

  test('resolves dev profiles under a checkout-scoped Freedom Dev home', () => {
    const appDataDir = track(makeTempDir());
    const repoRoot = track(makeRepoRoot());
    const app = createAppMock({
      isPackaged: false,
      appPaths: { appData: appDataDir },
    });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      repoRoot,
      now: '2026-05-25T00:00:00.000Z',
    });

    const checkoutHash = hashPath(fs.realpathSync(repoRoot));
    const appRoot = path.join(appDataDir, 'Freedom Dev', getCheckoutId(fs.realpathSync(repoRoot)));
    const offset = getDevPortOffset(checkoutHash);

    expect(profile.id).toBe('default');
    expect(profile.appRoot).toBe(appRoot);
    expect(profile.userDataDir).toBe(path.join(appRoot, 'Profiles', 'default'));
    expect(profile.metadata.nodes.bee.apiPort).toBe(21633 + offset);
    expect(profile.metadata.nodes.tor.socksPort).toBe(29150 + offset);
  });

  test('uses FREEDOM_DEV_HOME as a full dev home override', () => {
    const appDataDir = track(makeTempDir());
    const devHome = track(makeTempDir());
    const repoRoot = track(makeRepoRoot());
    const app = createAppMock({
      isPackaged: false,
      appPaths: { appData: appDataDir },
    });
    const { resolveProfile } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.', '--profile', 'work'],
      env: { FREEDOM_DEV_HOME: devHome },
      repoRoot,
      now: '2026-05-25T00:00:00.000Z',
    });

    expect(profile.appRoot).toBe(devHome);
    expect(profile.userDataDir).toBe(path.join(devHome, 'Profiles', 'work'));
  });

  test('warns once when dev repo-root legacy data dirs exist', () => {
    const appDataDir = track(makeTempDir());
    const repoRoot = track(makeRepoRoot());
    fs.mkdirSync(path.join(repoRoot, 'bee-data'));
    fs.mkdirSync(path.join(repoRoot, 'identity-data'));
    const app = createAppMock({
      isPackaged: false,
      appPaths: { appData: appDataDir },
    });
    const {
      LEGACY_DEV_DATA_WARNING_FILE,
      resolveProfile,
      warnAboutLegacyDevData,
    } = require('./profile-resolver');
    const logger = {
      warn: jest.fn(),
    };

    const profile = resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      repoRoot,
      now: '2026-05-25T00:00:00.000Z',
    });
    const firstWarning = warnAboutLegacyDevData(profile, { logger });
    const realRepoRoot = fs.realpathSync(repoRoot);

    expect(firstWarning.warned).toBe(true);
    expect(firstWarning.paths).toEqual([
      path.join(realRepoRoot, 'identity-data'),
      path.join(realRepoRoot, 'bee-data'),
    ]);
    expect(fs.existsSync(path.join(profile.appRoot, LEGACY_DEV_DATA_WARNING_FILE))).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(2);

    const secondWarning = warnAboutLegacyDevData(profile, { logger });

    expect(secondWarning.warned).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  // Warn-only is the accepted behavior for dev pre-profile data. Legacy
  // repo-root dirs must be left untouched (not moved) and must NOT be copied
  // into the new default profile — the dev boots a fresh default profile.
  test('does not auto-migrate legacy dev repo-root data into the default profile', () => {
    const appDataDir = track(makeTempDir());
    const repoRoot = track(makeRepoRoot());
    const legacyBeeData = path.join(repoRoot, 'bee-data');
    fs.mkdirSync(legacyBeeData);
    fs.writeFileSync(path.join(legacyBeeData, 'swarm.key'), 'legacy-secret');
    const app = createAppMock({
      isPackaged: false,
      appPaths: { appData: appDataDir },
    });
    const {
      LEGACY_DEV_DATA_DIRS,
      resolveProfile,
      warnAboutLegacyDevData,
    } = require('./profile-resolver');

    const profile = resolveProfile(app, {
      argv: ['electron', '.'],
      env: {},
      repoRoot,
      now: '2026-05-25T00:00:00.000Z',
    });
    warnAboutLegacyDevData(profile, { logger: { warn: jest.fn() } });

    // Legacy data stays exactly where it was — nothing moved or deleted.
    expect(fs.existsSync(path.join(legacyBeeData, 'swarm.key'))).toBe(true);
    expect(fs.readFileSync(path.join(legacyBeeData, 'swarm.key'), 'utf-8')).toBe('legacy-secret');

    // The new default profile is fresh — none of the legacy node dirs were
    // copied in.
    expect(profile.userDataDir).not.toBe(fs.realpathSync(repoRoot));
    for (const dirName of LEGACY_DEV_DATA_DIRS) {
      expect(fs.existsSync(path.join(profile.userDataDir, dirName))).toBe(false);
    }
  });

  test('persists active profile node updates to metadata and catalog', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const {
      getActiveProfile,
      initializeProfile,
      updateActiveProfileNodeConfig,
    } = require('./profile-resolver');

    const profile = initializeProfile(app, {
      argv: ['electron', '.', '--profile=work'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    updateActiveProfileNodeConfig('ipfs', {
      mode: 'disabled',
      externalApi: 'http://127.0.0.1:5001',
    });

    const metadata = JSON.parse(
      fs.readFileSync(path.join(profile.userDataDir, 'profile.json'), 'utf-8')
    );
    const catalog = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile-registry.json'), 'utf-8')
    );
    const record = catalog.profiles.find((entry) => entry.id === 'work');

    expect(metadata.nodes.ipfs).toEqual({
      mode: 'disabled',
      backend: 'freedom-ipfs',
    });
    expect(record.nodes.ipfs).toEqual({
      mode: 'disabled',
      backend: 'freedom-ipfs',
    });
    expect(getActiveProfile().metadata.nodes.ipfs).toEqual({
      mode: 'disabled',
      backend: 'freedom-ipfs',
    });
  });

  test('creates, lists, and renames catalog profiles for the active app root', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const {
      createProfileForActiveApp,
      deleteProfileForActiveApp,
      getActiveProfile,
      initializeProfile,
      listProfilesForActiveApp,
      renameProfileForActiveApp,
    } = require('./profile-resolver');

    initializeProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    const created = createProfileForActiveApp({
      displayName: 'Work Profile',
    });
    expect(created.record.id).toBe('work-profile');
    expect(created.metadata.displayName).toBe('Work Profile');
    expect(created.metadata.nodes.bee.apiPort).toBe(11634);
    expect(created.metadata.nodes.tor.socksPort).toBe(19151);

    const profiles = listProfilesForActiveApp();
    expect(profiles.map((profile) => profile.id)).toEqual(['default', 'work-profile']);
    expect(profiles.find((profile) => profile.id === 'default').isActive).toBe(true);
    expect(profiles.find((profile) => profile.id === 'work-profile').isActive).toBe(false);

    const renamedWork = renameProfileForActiveApp('work-profile', 'Work');
    expect(renamedWork.metadata.displayName).toBe('Work');
    const workDir = renamedWork.record.dir;

    renameProfileForActiveApp('default', 'Personal');
    expect(getActiveProfile().displayName).toBe('Personal');

    expect(() => deleteProfileForActiveApp('default', 'Personal')).toThrow(
      'The active profile cannot be deleted'
    );

    deleteProfileForActiveApp('work-profile', 'Work');
    expect(fs.existsSync(workDir)).toBe(false);

    const updatedCatalog = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile-registry.json'), 'utf-8')
    );
    expect(updatedCatalog.profiles.find((entry) => entry.id === 'default').displayName).toBe(
      'Personal'
    );
    expect(updatedCatalog.profiles.some((entry) => entry.id === 'work-profile')).toBe(false);
  });

  test('surfaces and imports unregistered profile directories', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const {
      importProfileForActiveApp,
      initializeProfile,
      listProfilesForActiveApp,
    } = require('./profile-resolver');

    initializeProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });

    const recoveredDir = path.join(userDataDir, 'Profiles', 'recovered');
    fs.mkdirSync(recoveredDir, { recursive: true });
    fs.writeFileSync(
      path.join(recoveredDir, 'profile.json'),
      JSON.stringify({
        version: 1,
        id: 'old-id',
        displayName: 'Recovered',
        createdAt: '2026-05-20T00:00:00.000Z',
        lastOpenedAt: '2026-05-21T00:00:00.000Z',
        slot: 7,
        nodes: {
          bee: {
            mode: 'external',
            externalApi: 'http://127.0.0.1:1633',
          },
        },
      })
    );

    const beforeImport = listProfilesForActiveApp();
    expect(beforeImport.find((profile) => profile.id === 'recovered')).toMatchObject({
      id: 'recovered',
      displayName: 'Recovered',
      slot: 7,
      isUnregistered: true,
    });

    const imported = importProfileForActiveApp('recovered');
    expect(imported.record).toMatchObject({
      id: 'recovered',
      displayName: 'Recovered',
      slot: 7,
    });
    expect(imported.metadata.nodes.bee).toMatchObject({
      mode: 'external',
      apiPort: 11640,
      externalApi: 'http://127.0.0.1:1633',
    });
    expect(imported.metadata.nodes.tor).toMatchObject({
      mode: 'managed',
      socksPort: 19157,
    });

    const afterImport = listProfilesForActiveApp();
    expect(afterImport.find((profile) => profile.id === 'recovered')).toMatchObject({
      id: 'recovered',
      isUnregistered: false,
    });
  });

  test('refuses to delete a profile that is open in another process', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const {
      createProfileForActiveApp,
      deleteProfileForActiveApp,
      initializeProfile,
    } = require('./profile-resolver');
    const { acquireProfileLock, releaseProfileLock } = require('./profile-lock');

    initializeProfile(app, {
      argv: ['electron', '.'],
      env: {},
      now: '2026-05-25T00:00:00.000Z',
    });
    const created = createProfileForActiveApp({ displayName: 'Work' });
    const lock = acquireProfileLock({
      id: created.record.id,
      displayName: created.record.displayName,
      userDataDir: created.record.dir,
    });

    try {
      expect(() => deleteProfileForActiveApp('work', 'Work')).toThrow(
        'Profile is currently open: Work'
      );
    } finally {
      releaseProfileLock(lock);
    }
  });

  test('deletes dev Radicle short home through the active resolver path', () => {
    const appDataDir = track(makeTempDir());
    const repoRoot = track(makeRepoRoot());
    const app = createAppMock({
      isPackaged: false,
      appPaths: { appData: appDataDir },
    });
    const {
      createProfileForActiveApp,
      deleteProfileForActiveApp,
      getActiveProfile,
      initializeProfile,
    } = require('./profile-resolver');

    initializeProfile(app, {
      argv: ['electron', '.'],
      env: {},
      repoRoot,
      now: '2026-05-25T00:00:00.000Z',
    });
    const created = createProfileForActiveApp({ displayName: 'Work' });
    const activeProfile = getActiveProfile();
    const radicleDir = path.join(
      path.dirname(activeProfile.appRoot),
      'R',
      activeProfile.checkoutHash,
      String(created.record.slot)
    );
    fs.mkdirSync(radicleDir, { recursive: true });
    fs.writeFileSync(path.join(radicleDir, 'radicle.pub'), 'old-radicle-identity');

    deleteProfileForActiveApp('work', 'Work');

    expect(fs.existsSync(created.record.dir)).toBe(false);
    expect(fs.existsSync(radicleDir)).toBe(false);
  });

  test('rejects path-like profile ids', () => {
    const userDataDir = track(makeTempDir());
    const app = createAppMock({ isPackaged: true, userDataDir });
    const { resolveProfile } = require('./profile-resolver');

    expect(() => resolveProfile(app, {
      argv: ['electron', '.', '--profile=../bad'],
      env: {},
    })).toThrow('Invalid profile id');
  });
});
