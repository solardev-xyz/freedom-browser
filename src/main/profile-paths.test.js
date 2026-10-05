const fs = require('fs');
const path = require('path');
const {
  createAppMock,
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

describe('profile paths', () => {
  let tempDirs = [];
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    tempDirs.forEach(removeTempUserDataDir);
    tempDirs = [];
  });

  function track(dir) {
    tempDirs.push(dir);
    return dir;
  }

  function loadPaths(userDataDir, options = {}) {
    const app = createAppMock({
      isPackaged: false,
      userDataDir,
    });
    return loadMainModule(require.resolve('./profile-paths'), {
      app,
      extraMocks: {
        [require.resolve('./profile-resolver')]: () => ({
          getActiveProfile: jest.fn(() => options.activeProfile || null),
        }),
        ...(options.fsOffload
          ? { [require.resolve('./fs-offload')]: () => options.fsOffload }
          : {}),
      },
    }).mod;
  }

  test('resolves profile-owned directories under active userData', () => {
    const userDataDir = track(createTempUserDataDir());
    const paths = loadPaths(userDataDir);

    expect(paths.getIdentityDataDir()).toBe(path.join(userDataDir, 'identity'));
    expect(paths.getAntDataDir()).toBe(path.join(userDataDir, 'ant-data'));
    expect(paths.getBeeDataDir()).toBe(path.join(userDataDir, 'bee-data'));
    expect(paths.getIpfsDataDir()).toBe(path.join(userDataDir, 'ipfs-data'));
    expect(paths.getMyotisDataDir()).toBe(path.join(userDataDir, 'myotis'));
    expect(paths.getMyotisDataDir('gnosis')).toBe(path.join(userDataDir, 'myotis', 'gnosis'));
    expect(paths.getTorDataDir()).toBe(path.join(userDataDir, 'tor-data'));
    expect(paths.getRadicleDataDir()).toBe(path.join(userDataDir, 'radicle-data'));
    expect(paths.getProfileTempDir()).toBe(path.join(userDataDir, 'tmp'));
    expect(paths.getQuickUnlockCredentialPath()).toBe(
      path.join(userDataDir, 'identity', 'quick-unlock.dat')
    );

    expect(fs.existsSync(path.join(userDataDir, 'identity'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'ant-data'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'tmp'))).toBe(true);
  });

  test('creates sanitized profile temp directories', () => {
    const userDataDir = track(createTempUserDataDir());
    const paths = loadPaths(userDataDir);

    const tempDir = paths.createProfileTempDir('github bridge!');

    expect(tempDir.startsWith(path.join(userDataDir, 'tmp', 'github-bridge-'))).toBe(true);
    expect(fs.existsSync(tempDir)).toBe(true);
  });

  test('isolates Myotis data between browser profiles', () => {
    const firstProfile = track(createTempUserDataDir());
    const secondProfile = track(createTempUserDataDir());

    const firstPath = loadPaths(firstProfile).getMyotisDataDir();
    const secondPath = loadPaths(secondProfile).getMyotisDataDir();

    expect(firstPath).toBe(path.join(firstProfile, 'myotis'));
    expect(secondPath).toBe(path.join(secondProfile, 'myotis'));
    expect(firstPath).not.toBe(secondPath);
  });

  test('honors explicit data directory overrides', () => {
    const userDataDir = track(createTempUserDataDir());
    const identityDir = track(createTempUserDataDir());
    const antDir = track(createTempUserDataDir());
    const beeDir = track(createTempUserDataDir());
    const ipfsDir = track(createTempUserDataDir());
    const myotisDir = track(createTempUserDataDir());
    const torDir = track(createTempUserDataDir());
    const radicleDir = track(createTempUserDataDir());
    process.env.FREEDOM_IDENTITY_DATA = identityDir;
    process.env.FREEDOM_ANT_DATA = antDir;
    process.env.FREEDOM_BEE_DATA = beeDir;
    process.env.FREEDOM_IPFS_DATA = ipfsDir;
    process.env.MYOTIS_DATA_DIR = myotisDir;
    process.env.FREEDOM_TOR_DATA = torDir;
    process.env.FREEDOM_RADICLE_DATA = radicleDir;

    const paths = loadPaths(userDataDir);

    expect(paths.getIdentityDataDir()).toBe(identityDir);
    expect(paths.getAntDataDir()).toBe(antDir);
    expect(paths.getBeeDataDir()).toBe(beeDir);
    expect(paths.getIpfsDataDir()).toBe(ipfsDir);
    expect(paths.getMyotisDataDir()).toBe(myotisDir);
    expect(paths.getMyotisDataDir('gnosis')).toBe(path.join(myotisDir, 'gnosis'));
    expect(paths.getTorDataDir()).toBe(torDir);
    expect(paths.getRadicleDataDir()).toBe(radicleDir);
  });

  test('uses an app-owned short Radicle home for catalog profiles', async () => {
    const tempRoot = track(path.join('/tmp', `freedom-profile-paths-${Date.now()}`));
    fs.mkdirSync(tempRoot, { recursive: true });
    const appRoot = path.join(tempRoot, 'Freedom Dev', 'freedom-browser-12345678');
    const userDataDir = path.join(appRoot, 'Profiles', 'profile-with-a-long-name');
    const legacyRadicleDir = path.join(userDataDir, 'radicle-data');
    fs.mkdirSync(path.join(legacyRadicleDir, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(legacyRadicleDir, 'keys', 'radicle.pub'), 'public-key');
    const activeProfile = {
      source: 'catalog',
      appRoot,
      isDev: true,
      checkoutHash: '12345678',
      metadata: { slot: 2 },
    };

    const paths = loadPaths(userDataDir, { activeProfile });
    const radicleDir = await paths.prepareRadicleDataDir();

    expect(radicleDir).toBe(path.join(tempRoot, 'Freedom Dev', 'R', '12345678', '2'));
    expect(paths.getRadicleDataDir()).toBe(radicleDir);
    expect(path.join(radicleDir, 'node', 'control.sock').length).toBeLessThan(100);
    expect(fs.readFileSync(path.join(radicleDir, 'keys', 'radicle.pub'), 'utf-8')).toBe(
      'public-key'
    );
  });

  // #513: the carry-over can be GBs of seeded repos, so it must not cpSync on
  // the main thread (it runs through fs-offload); readers never see a
  // half-copied short home.
  describe('async Radicle home migration', () => {
    function seed(appRootName = 'app') {
      const appRoot = track(createTempUserDataDir());
      const root = path.join(appRoot, appRootName);
      const userDataDir = path.join(root, 'Profiles', 'work');
      const legacyRadicleDir = path.join(userDataDir, 'radicle-data');
      fs.mkdirSync(path.join(legacyRadicleDir, 'keys'), { recursive: true });
      fs.writeFileSync(path.join(legacyRadicleDir, 'keys', 'radicle.pub'), 'public-key');
      fs.mkdirSync(path.join(legacyRadicleDir, 'storage', 'repo'), { recursive: true });
      for (let i = 0; i < 50; i += 1) {
        fs.writeFileSync(path.join(legacyRadicleDir, 'storage', 'repo', `obj-${i}`), 'x');
      }
      const activeProfile = { source: 'catalog', appRoot: root, isDev: false, metadata: { slot: 1 } };
      return { root, userDataDir, legacyRadicleDir, activeProfile };
    }

    test('getRadicleDataDir returns without copying; prepare finishes the copy', async () => {
      const { root, userDataDir, activeProfile } = seed();
      const cpSyncSpy = jest.spyOn(fs, 'cpSync');
      try {
        const paths = loadPaths(userDataDir, { activeProfile });
        const radicleDir = paths.getRadicleDataDir();

        expect(radicleDir).toBe(path.join(root, 'R', '1'));
        // Returned before the async copy could land: absent (not even created
        // empty while the migration is in flight), never torn.
        expect(fs.existsSync(radicleDir)).toBe(false);

        await expect(paths.prepareRadicleDataDir()).resolves.toBe(radicleDir);
        expect(fs.readFileSync(path.join(radicleDir, 'keys', 'radicle.pub'), 'utf-8')).toBe(
          'public-key'
        );
        expect(fs.readdirSync(path.join(radicleDir, 'storage', 'repo'))).toHaveLength(50);
        // The staging dir was renamed into place, nothing left beside it.
        expect(fs.readdirSync(path.join(root, 'R'))).toEqual(['1']);
        expect(cpSyncSpy).not.toHaveBeenCalled();
      } finally {
        cpSyncSpy.mockRestore();
      }
    });

    test('keeps a short home that already has data', async () => {
      const { root, userDataDir, activeProfile } = seed();
      const radicleDir = path.join(root, 'R', '1');
      fs.mkdirSync(radicleDir, { recursive: true });
      fs.writeFileSync(path.join(radicleDir, 'existing'), 'keep');

      const paths = loadPaths(userDataDir, { activeProfile });
      await paths.prepareRadicleDataDir();

      expect(fs.readdirSync(radicleDir)).toEqual(['existing']);
    });

    test('does not clobber a short home that gained entries mid-copy', async () => {
      const { root, userDataDir, activeProfile } = seed();
      const radicleDir = path.join(root, 'R', '1');
      const realOffload = jest.requireActual('./fs-offload');
      const fsOffload = {
        ...realOffload,
        copyPath: async (...args) => {
          await realOffload.copyPath(...args);
          fs.mkdirSync(radicleDir, { recursive: true });
          fs.writeFileSync(path.join(radicleDir, 'written-meanwhile'), 'keep');
        },
      };
      const paths = loadPaths(userDataDir, { activeProfile, fsOffload });
      await paths.prepareRadicleDataDir();

      expect(fs.readdirSync(radicleDir)).toEqual(['written-meanwhile']);
      expect(fs.readdirSync(path.join(root, 'R'))).toEqual(['1']);
    });
  });

  // #517 R1-M3: on Windows, rename() onto an existing directory fails, so a
  // sync getRadicleDataDir() landing between the migration's rmdir and rename
  // must not recreate the destination.
  test('a read during the final rename does not recreate the short home', async () => {
    const appRoot = track(createTempUserDataDir());
    const userDataDir = path.join(appRoot, 'Profiles', 'work');
    fs.mkdirSync(path.join(userDataDir, 'radicle-data', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'radicle-data', 'keys', 'radicle.pub'), 'pk');
    const activeProfile = { source: 'catalog', appRoot, isDev: false, metadata: { slot: 1 } };
    const radicleDir = path.join(appRoot, 'R', '1');
    const paths = loadPaths(userDataDir, { activeProfile });

    const realRename = fs.promises.rename;
    const renameSpy = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === radicleDir) {
        expect(paths.getRadicleDataDir()).toBe(radicleDir);
        // Emulate Windows: renaming onto an existing directory fails.
        if (fs.existsSync(to)) {
          throw Object.assign(new Error('EPERM: rename onto existing dir'), { code: 'EPERM' });
        }
      }
      return realRename.call(fs.promises, from, to);
    });
    try {
      await expect(paths.prepareRadicleDataDir()).resolves.toBe(radicleDir);
      expect(fs.readFileSync(path.join(radicleDir, 'keys', 'radicle.pub'), 'utf-8')).toBe('pk');
      // Once settled, the sync path creates the home again as before.
      expect(fs.existsSync(paths.getRadicleDataDir())).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }
  });

  test('prepare creates the short home when there is nothing to migrate', async () => {
    const appRoot = track(createTempUserDataDir());
    const userDataDir = path.join(appRoot, 'Profiles', 'work');
    const activeProfile = { source: 'catalog', appRoot, isDev: false, metadata: { slot: 3 } };
    const paths = loadPaths(userDataDir, { activeProfile });

    const radicleDir = await paths.prepareRadicleDataDir();
    expect(radicleDir).toBe(path.join(appRoot, 'R', '3'));
    expect(fs.statSync(radicleDir).isDirectory()).toBe(true);
  });

  // #517 R1-M2: an interrupted carry-over (quit/crash mid-copy) leaves a
  // `<slot>.migrating-<pid>-<ts>` staging dir behind; the next attempt sweeps
  // those of dead processes but leaves a live process's copy alone.
  test('sweeps staging dirs orphaned by a dead process before migrating', async () => {
    const appRoot = track(createTempUserDataDir());
    const userDataDir = path.join(appRoot, 'Profiles', 'work');
    fs.mkdirSync(path.join(userDataDir, 'radicle-data', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'radicle-data', 'keys', 'radicle.pub'), 'pk');
    const activeProfile = { source: 'catalog', appRoot, isDev: false, metadata: { slot: 1 } };
    const rRoot = path.join(appRoot, 'R');
    // pid 2^22+ is above Linux's pid_max ceiling, so it cannot be alive.
    const dead = path.join(rRoot, `1.migrating-${2 ** 22 + 7}-1700000000000`);
    const live = path.join(rRoot, `1.migrating-${process.ppid}-1700000000000`);
    const otherSlot = path.join(rRoot, `11.migrating-${2 ** 22 + 7}-1700000000000`);
    for (const dir of [dead, live, otherSlot]) {
      fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'storage', 'blob'), 'x');
    }

    const paths = loadPaths(userDataDir, { activeProfile });
    await paths.prepareRadicleDataDir();

    expect(fs.readdirSync(rRoot).sort()).toEqual(
      ['1', path.basename(live), path.basename(otherSlot)].sort()
    );
  });

  test('uses a short Radicle home under the packaged app root', () => {
    const appRoot = track(createTempUserDataDir());
    const userDataDir = path.join(appRoot, 'Profiles', 'work');
    const activeProfile = {
      source: 'catalog',
      appRoot,
      isDev: false,
      metadata: { slot: 1 },
    };

    const paths = loadPaths(userDataDir, { activeProfile });

    expect(paths.getRadicleDataDir()).toBe(path.join(appRoot, 'R', '1'));
  });
});
