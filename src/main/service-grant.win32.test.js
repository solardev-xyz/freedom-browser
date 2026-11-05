/**
 * The grant check's Win32 name rules on Windows itself (freedom-core design
 * 0010, step 7). service-grant.test.js tests them on every OS, through the
 * `win32` option and path.win32; this file runs them against NTFS
 * junctions, which any user can make, on CI's Windows runner
 * (native-addons, win-x64). Elsewhere it is skipped.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

const onWindows = process.platform === 'win32' ? describe : describe.skip;

const WIN32_NAME =
  "a path holds a name Windows may read as another (a trailing period or space, a stream, a device's name, or a short name that doesn't exist yet), which can't be compared";
const DANGLING = "a path holds a symlink that can't be followed: a loop, or too many links";
const NAMESPACE =
  "a path lies on a share or in a device namespace that the others don't, which can't be compared";

onWindows('names Win32 may read as others, on Windows itself', () => {
  let tempRoot;
  let savedEnv;

  beforeEach(() => {
    tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-service-grant-'))
    );
    savedEnv = { ...process.env };
    for (const name of ['FREEDOM_IPFS_DATA', 'FREEDOM_RADICLE_DATA', 'FREEDOM_IDENTITY_DATA']) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    process.env = savedEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /** A `--profile-dir` profile before freedom-ipfsd's first start, its IPFS
   * data where FREEDOM_IPFS_DATA puts it: the directory made, the grant in
   * it not yet. service-grant as main loads it. */
  function fresh() {
    const userDataDir = path.join(tempRoot, 'Elsewhere');
    const ipfsData = path.join(tempRoot, 'IpfsOverride');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(ipfsData, { recursive: true });
    process.env.FREEDOM_IPFS_DATA = ipfsData;
    const app = createAppMock({
      userDataDir,
      appPaths: { appData: path.join(tempRoot, 'AppData') },
    });
    const active = { source: 'profile-dir', appRoot: userDataDir, userDataDir };
    const { mod } = loadMainModule(require.resolve('./service-grant'), {
      app,
      extraMocks: {
        [require.resolve('./profile-resolver')]: () => ({ getActiveProfile: () => active }),
      },
    });
    return { userDataDir, ipfsData, grant: path.join(ipfsData, 'freedom-ipfs'), check: mod };
  }

  /** The profile's `identity` as a junction to `target`, which needn't exist. */
  function identityTo(userDataDir, target) {
    fs.symlinkSync(target, path.join(userDataDir, 'identity'), 'junction');
  }

  test('the grant passes, and so does an identity junction to an unrelated name', () => {
    const { userDataDir, grant, check } = fresh();
    expect(check.ipfsGrantRefusal(grant)).toBeNull();
    identityTo(userDataDir, path.join(tempRoot, 'Vaults', 'later'));
    expect(check.ipfsGrantRefusal(grant)).toBeNull();
  });

  test.each([
    'freedom-ipfs.',
    'freedom-ipfs ',
    'FREEDO~1',
    'freedom-ipfs:vault',
    'freedom-ipfs::$INDEX_ALLOCATION',
  ])('an identity junction to %j is refused before the grant exists', (name) => {
    const { userDataDir, ipfsData, grant, check } = fresh();
    identityTo(userDataDir, path.join(ipfsData, name));
    expect(fs.existsSync(grant)).toBe(false);
    expect(check.ipfsGrantRefusal(grant)).toBe(WIN32_NAME);
  });

  test.each(['NUL', 'nul.txt', 'COM1'])(
    'an identity junction to the device %j is refused',
    (name) => {
      // Whether the device's path doesn't resolve, resolves into the device
      // namespace, or exists as no symlink is up to Win32: each is refused.
      const { userDataDir, ipfsData, grant, check } = fresh();
      identityTo(userDataDir, path.join(ipfsData, name));
      expect([WIN32_NAME, NAMESPACE, DANGLING]).toContain(check.ipfsGrantRefusal(grant));
    }
  );

  test('once the grant exists, a junction to its trailing-period alias is still refused', () => {
    const { userDataDir, ipfsData, grant, check } = fresh();
    fs.mkdirSync(grant);
    identityTo(userDataDir, path.join(ipfsData, 'freedom-ipfs.'));
    // Resolved by Win32 as the grant itself, or kept as a literal name.
    expect([WIN32_NAME, "the grant is this profile's identity directory"]).toContain(
      check.ipfsGrantRefusal(grant)
    );
  });
});
