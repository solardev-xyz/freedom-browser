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

  test('uses an app-owned short Radicle home for catalog profiles', () => {
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
    const radicleDir = paths.getRadicleDataDir();

    expect(radicleDir).toBe(path.join(tempRoot, 'Freedom Dev', 'R', '12345678', '2'));
    expect(path.join(radicleDir, 'node', 'control.sock').length).toBeLessThan(100);
    expect(fs.readFileSync(path.join(radicleDir, 'keys', 'radicle.pub'), 'utf-8')).toBe(
      'public-key'
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
