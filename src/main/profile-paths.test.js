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
        // The Radicle home's gate (radicle/radicled-gate.js), held at once
        // unless a test says otherwise.
        [require.resolve('./radicle/radicled-gate')]: () => ({
          withRadicleGate:
            options.withRadicleGate ?? (async (_home, fn) => fn({ gated: true, held: () => true })),
        }),
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

  // freedom-core design 0010: an override is resolved once, from main's
  // directory, and every consumer (a service handed it as an argument too)
  // gets that absolute path; the grant check also sees it as written.
  test('resolves a relative override to one absolute path, for every consumer', () => {
    for (const name of [
      'FREEDOM_IDENTITY_DATA',
      'FREEDOM_BEE_DATA',
      'FREEDOM_ANT_DATA',
      'FREEDOM_IPFS_DATA',
      'MYOTIS_DATA_DIR',
      'FREEDOM_TOR_DATA',
      'FREEDOM_RADICLE_DATA',
    ]) {
      delete process.env[name];
    }
    const userDataDir = track(createTempUserDataDir());
    const overrides = track(createTempUserDataDir());
    // Relative where the working directory and the temporary one share a
    // root (on Windows they may not: then path.relative keeps it absolute).
    const relative = path.relative(process.cwd(), overrides);
    process.env.FREEDOM_IPFS_DATA = path.join(relative, 'ipfs');
    process.env.FREEDOM_IDENTITY_DATA = path.join(relative, 'identity');
    process.env.FREEDOM_RADICLE_DATA = path.join(relative, 'radicle');
    process.env.MYOTIS_DATA_DIR = path.join(relative, 'myotis');

    // Each, as main resolves it: in the temporary directory.
    const resolved = (name) => path.resolve(relative, name);
    expect(path.isAbsolute(resolved('ipfs'))).toBe(true);
    expect(path.relative(overrides, resolved('ipfs'))).toBe('ipfs');

    const paths = loadPaths(userDataDir);

    expect(paths.getIpfsDataDir()).toBe(resolved('ipfs'));
    expect(paths.getIdentityDataDir()).toBe(resolved('identity'));
    expect(paths.getRadicleDataDir()).toBe(resolved('radicle'));
    expect(paths.getMyotisDataDir('gnosis')).toBe(path.join(resolved('myotis'), 'gnosis'));
    expect(paths.getComponentDataDirs()).toMatchObject({
      identity: resolved('identity'),
      ipfs: resolved('ipfs'),
      myotis: resolved('myotis'),
      radicle: resolved('radicle'),
    });
    expect(paths.getDataDirOverrides()).toEqual({
      identity: path.join(relative, 'identity'),
      ipfs: path.join(relative, 'ipfs'),
      myotis: path.join(relative, 'myotis'),
      radicle: path.join(relative, 'radicle'),
    });
  });

  test("lists each component's data directory without creating any, this profile's overrides included", () => {
    const userDataDir = track(createTempUserDataDir());
    const ipfsDir = path.join(track(createTempUserDataDir()), 'elsewhere');
    process.env.FREEDOM_IPFS_DATA = ipfsDir;
    const paths = loadPaths(userDataDir);

    expect(paths.getComponentDataDirs()).toEqual({
      identity: path.join(userDataDir, 'identity'),
      bee: path.join(userDataDir, 'bee-data'),
      ant: path.join(userDataDir, 'ant-data'),
      ipfs: ipfsDir,
      myotis: path.join(userDataDir, 'myotis'),
      tor: path.join(userDataDir, 'tor-data'),
      radicle: path.join(userDataDir, 'radicle-data'),
      radicleHome: null,
    });
    expect(fs.existsSync(ipfsDir)).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'identity'))).toBe(false);

    // Another profile's: its default names, the override this process's alone.
    const other = path.join(userDataDir, 'other');
    expect(paths.getComponentDataDirs(other)).toMatchObject({
      ipfs: path.join(other, 'ipfs-data'),
      radicleHome: null,
    });
  });

  test("a catalog profile's short Radicle home, and another's by its slot", () => {
    const appRoot = path.join(track(createTempUserDataDir()), 'Freedom');
    const userDataDir = path.join(appRoot, 'Profiles', 'work');
    const activeProfile = { source: 'catalog', appRoot, metadata: { slot: 2 } };
    const paths = loadPaths(userDataDir, { activeProfile });
    expect(paths.getComponentDataDirs().radicleHome).toBe(path.join(appRoot, 'R', '2'));
    const other = path.join(appRoot, 'Profiles', 'home');
    expect(paths.getComponentDataDirs(other, { slot: 3 }).radicleHome).toBe(
      path.join(appRoot, 'R', '3')
    );
    // Without its slot, none.
    expect(paths.getComponentDataDirs(other).radicleHome).toBeNull();
  });

  test("a development build's short Radicle homes sit beside the app root, by checkout", () => {
    const devRoot = path.join(track(createTempUserDataDir()), 'Freedom Dev');
    const appRoot = path.join(devRoot, 'freedom-browser-abcd1234');
    const activeProfile = {
      source: 'catalog',
      appRoot,
      isDev: true,
      checkoutHash: 'abcd1234',
      metadata: { slot: 1 },
    };
    const paths = loadPaths(path.join(appRoot, 'Profiles', 'work'), { activeProfile });
    expect(paths.getComponentDataDirs(path.join(appRoot, 'Profiles', 'home'), { slot: 4 })).toMatchObject({
      radicleHome: path.join(devRoot, 'R', 'abcd1234', '4'),
    });
  });

  (process.platform === 'win32' ? test.skip : test)(
    'node and identity data dirs are owner-only, older 0755 ones narrowed (K-3)',
    async () => {
      const userDataDir = track(createTempUserDataDir());
      const radicleDir = track(createTempUserDataDir());
      fs.chmodSync(radicleDir, 0o755);
      process.env.FREEDOM_RADICLE_DATA = radicleDir;
      fs.mkdirSync(path.join(userDataDir, 'ant-data'), { mode: 0o755 });
      fs.chmodSync(path.join(userDataDir, 'ant-data'), 0o755);
      const modeOf = (dir) => fs.statSync(dir).mode & 0o777;

      const paths = loadPaths(userDataDir);

      expect(modeOf(paths.getIdentityDataDir())).toBe(0o700);
      expect(modeOf(paths.getAntDataDir())).toBe(0o700);
      expect(modeOf(paths.getBeeDataDir())).toBe(0o700);
      expect(modeOf(paths.getRadicleDataDir())).toBe(0o700);
      expect(modeOf(await paths.prepareRadicleDataDir())).toBe(0o700);
    }
  );

  (process.platform === 'win32' ? test.skip : test)(
    'a node data dir that is a link is refused, its target untouched (K-3)',
    () => {
      const userDataDir = track(createTempUserDataDir());
      const elsewhere = track(createTempUserDataDir());
      fs.chmodSync(elsewhere, 0o755);
      fs.symlinkSync(elsewhere, path.join(userDataDir, 'ant-data'));

      const paths = loadPaths(userDataDir);
      expect(() => paths.getAntDataDir()).toThrow('symbolic link');
      expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o755);
    }
  );

  // K-3 on integration: the core anchors its node writes below a data
  // directory but leaves the directory itself alone, so main's getters are
  // what make it owner-only, at the path overrideDir() resolved.
  (process.platform === 'win32' ? test.skip : test)(
    'a relative override is made owner-only at the absolute path main resolved (K-3)',
    async () => {
      const userDataDir = track(createTempUserDataDir());
      const overrides = track(createTempUserDataDir());
      const relative = path.relative(process.cwd(), overrides);
      const names = {
        FREEDOM_IDENTITY_DATA: 'identity',
        FREEDOM_ANT_DATA: 'ant',
        FREEDOM_BEE_DATA: 'bee',
        FREEDOM_RADICLE_DATA: 'radicle',
      };
      for (const [envName, name] of Object.entries(names)) {
        // As an older build left them.
        fs.mkdirSync(path.join(overrides, name), { mode: 0o755 });
        fs.chmodSync(path.join(overrides, name), 0o755);
        process.env[envName] = path.join(relative, name);
      }
      const modeOf = (dir) => fs.statSync(dir).mode & 0o777;

      const paths = loadPaths(userDataDir);

      const resolved = (name) => path.join(overrides, name);
      expect(paths.getIdentityDataDir()).toBe(resolved('identity'));
      expect(paths.getAntDataDir()).toBe(resolved('ant'));
      expect(paths.getBeeDataDir()).toBe(resolved('bee'));
      expect(paths.getRadicleDataDir()).toBe(resolved('radicle'));
      expect(await paths.prepareRadicleDataDir()).toBe(resolved('radicle'));
      for (const name of Object.values(names)) {
        expect(modeOf(resolved(name))).toBe(0o700);
      }
      // The grant check's roots are the same directories.
      expect(paths.getComponentDataDirs()).toMatchObject({
        identity: resolved('identity'),
        ant: resolved('ant'),
        bee: resolved('bee'),
        radicle: resolved('radicle'),
      });
    }
  );

  (process.platform === 'win32' ? test.skip : test)(
    "a catalog profile's short Radicle home is owner-only, an older 0755 one migrated in narrowed (K-3)",
    async () => {
      const appRoot = track(createTempUserDataDir());
      const userDataDir = path.join(appRoot, 'Profiles', 'work');
      const legacyRadicleDir = path.join(userDataDir, 'radicle-data');
      fs.mkdirSync(path.join(legacyRadicleDir, 'keys'), { recursive: true });
      fs.writeFileSync(path.join(legacyRadicleDir, 'keys', 'radicle.pub'), 'pk');
      fs.chmodSync(legacyRadicleDir, 0o755);
      const activeProfile = { source: 'catalog', appRoot, isDev: false, metadata: { slot: 1 } };
      const radicleDir = path.join(appRoot, 'R', '1');

      const paths = loadPaths(userDataDir, { activeProfile });

      await expect(paths.prepareRadicleDataDir()).resolves.toBe(radicleDir);
      expect(fs.readFileSync(path.join(radicleDir, 'keys', 'radicle.pub'), 'utf-8')).toBe('pk');
      expect(fs.statSync(radicleDir).mode & 0o777).toBe(0o700);
      expect(paths.getRadicleDataDir()).toBe(radicleDir);
      expect(paths.getComponentDataDirs().radicleHome).toBe(radicleDir);
    }
  );

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

    // freedom-core design 0008, "Spawn and lock": the carry-over writes the
    // home, so it runs under the home's gate, from its check that the home is
    // empty to its rename into place.
    test('runs under the home\'s gate, taken on the short home before anything is copied', async () => {
      const { root, userDataDir, activeProfile } = seed();
      const radicleDir = path.join(root, 'R', '1');
      const events = [];
      const realOffload = jest.requireActual('./fs-offload');
      const fsOffload = {
        ...realOffload,
        copyPath: async (...args) => {
          events.push('copy');
          return realOffload.copyPath(...args);
        },
      };
      const withRadicleGate = async (home, fn) => {
        events.push(`take ${home}`);
        try {
          return await fn({ gated: true, held: () => true });
        } finally {
          events.push(`release (home ${fs.existsSync(path.join(home, 'keys')) ? 'filled' : 'empty'})`);
        }
      };
      const paths = loadPaths(userDataDir, { activeProfile, fsOffload, withRadicleGate });

      await paths.prepareRadicleDataDir();

      expect(events).toEqual([`take ${radicleDir}`, 'copy', 'release (home filled)']);
    });

    test('a gate another writer holds on a new, empty short home fails the carry-over, and replaces nothing', async () => {
      const { root, userDataDir, activeProfile } = seed();
      const radicleDir = path.join(root, 'R', '1');
      // A service's new home: made, empty, and held.
      fs.mkdirSync(radicleDir, { recursive: true });
      const { ino } = fs.statSync(radicleDir);
      const held = Object.assign(
        new Error('The Radicle data is in use by another process. Close it and try again.'),
        { name: 'RadicleGateError', code: 'lock_held' }
      );
      let refuse = true;
      const withRadicleGate = async (_home, fn) => {
        if (refuse) throw held;
        return fn({ gated: true, held: () => true });
      };
      const paths = loadPaths(userDataDir, { activeProfile, withRadicleGate });

      await expect(paths.prepareRadicleDataDir()).rejects.toBe(held);
      expect(fs.statSync(radicleDir).ino).toBe(ino);
      expect(fs.readdirSync(radicleDir)).toEqual([]);
      expect(fs.readdirSync(path.join(root, 'R'))).toEqual(['1']);

      // Once the home is free, the next preparation carries it over.
      refuse = false;
      await expect(paths.prepareRadicleDataDir()).resolves.toBe(radicleDir);
      expect(fs.readFileSync(path.join(radicleDir, 'keys', 'radicle.pub'), 'utf-8')).toBe(
        'public-key'
      );
    });

    test('a gate lost during the copy replaces nothing', async () => {
      const { root, userDataDir, activeProfile } = seed();
      const radicleDir = path.join(root, 'R', '1');
      let lost = false;
      const realOffload = jest.requireActual('./fs-offload');
      const fsOffload = {
        ...realOffload,
        copyPath: async (...args) => {
          await realOffload.copyPath(...args);
          lost = true;
        },
      };
      const withRadicleGate = async (home, fn) => {
        fs.mkdirSync(home, { recursive: true });
        return fn({ gated: true, held: () => !lost });
      };
      const paths = loadPaths(userDataDir, { activeProfile, fsOffload, withRadicleGate });

      await expect(paths.prepareRadicleDataDir()).rejects.toThrow(
        "The Radicle home's lock was lost; its data was not carried over"
      );
      expect(fs.readdirSync(radicleDir)).toEqual([]);
      expect(fs.readdirSync(path.join(root, 'R'))).toEqual(['1']);
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
