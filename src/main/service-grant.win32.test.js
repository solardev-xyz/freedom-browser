/**
 * The grant check's Win32 name rules on Windows itself (freedom-core design
 * 0010, step 7). service-grant.test.js tests them on every OS, through the
 * `win32` option and path.win32; this file runs them against NTFS
 * junctions, which any user can make, on CI's Windows runner
 * (native-addons, win-x64). Elsewhere it is skipped.
 */

const { execFileSync, spawnSync } = require('child_process');
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
const DRIVE_RELATIVE =
  "a path is relative to a drive's current directory (`C:name`), which a service may resolve from another";

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

onWindows('a drive-relative override, with a current directory on each of two drives', () => {
  let tempRoot;
  let savedEnv;
  let savedCwd;
  let drive = null;

  /** A free drive letter, `subst`ed to `dir` for the test. */
  function substDrive(dir) {
    for (const letter of 'QRSTUVWXYZ') {
      const candidate = `${letter}:`;
      if (fs.existsSync(`${candidate}\\`)) continue;
      try {
        execFileSync('subst', [candidate, dir], { windowsHide: true });
        return candidate;
      } catch {
        // Taken meanwhile, or refused: try the next.
      }
    }
    throw new Error('no free drive letter to subst');
  }

  /** `mkdir -p target` in a child of this process, spawned as main spawns
   * freedom-ipfsd: the real scrubbed environment, this current directory. */
  function mkdirInChild(target) {
    const { scrubbedEnv } = jest.requireActual('./core/service-client');
    const result = spawnSync(
      process.execPath,
      ['-e', 'require("fs").mkdirSync(process.argv[1], { recursive: true })', target],
      { env: scrubbedEnv(), windowsHide: true, encoding: 'utf8' }
    );
    if (result.status !== 0) {
      throw new Error(`the child failed: ${result.stderr || result.error?.message}`);
    }
  }

  beforeEach(() => {
    tempRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-service-grant-'))
    );
    savedEnv = { ...process.env };
    savedCwd = process.cwd();
    for (const name of ['FREEDOM_IPFS_DATA', 'FREEDOM_RADICLE_DATA', 'FREEDOM_IDENTITY_DATA']) {
      delete process.env[name];
    }
    fs.mkdirSync(path.join(tempRoot, 'drive', 'checked'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'work'));
    drive = substDrive(path.join(tempRoot, 'drive'));
    // This process's current directories: `checked` on the substituted
    // drive (libuv records it as the hidden `=<drive>` variable), then one
    // on the temporary directory's drive, where the process stays.
    process.chdir(`${drive}\\checked`);
    process.chdir(path.join(tempRoot, 'work'));
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (drive) execFileSync('subst', [drive, '/D'], { windowsHide: true });
    drive = null;
    process.env = savedEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /** service-grant and profile-paths as main loads them, for a
   * `--profile-dir` profile. */
  function load() {
    const userDataDir = path.join(tempRoot, 'Elsewhere');
    fs.mkdirSync(userDataDir, { recursive: true });
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
    // The same registry's profile-paths, the one service-grant uses.
    return { check: mod, paths: require('./profile-paths') };
  }

  test('FREEDOM_IPFS_DATA=<drive>ipfs-data is refused, and the service is handed the path main resolved', () => {
    expect(path.parse(process.cwd()).root.toLowerCase()).not.toBe(`${drive}\\`.toLowerCase());
    // The protected identity directory, where the text as written names
    // from the drive's root.
    const identity = `${drive}\\ipfs-data\\freedom-ipfs`;
    process.env.FREEDOM_IPFS_DATA = `${drive}ipfs-data`;
    process.env.FREEDOM_IDENTITY_DATA = identity;
    const { check, paths } = load();

    // Main resolves the override once, from its directory on that drive,
    // and the grant is that path's (as ipfs-manager's getIpfsDataPath).
    const approved = `${drive}\\checked\\ipfs-data\\freedom-ipfs`;
    const grant = path.resolve(paths.getIpfsDataDir(), 'freedom-ipfs');
    expect(grant).toBe(approved);

    // Refused as written.
    expect(check.ipfsGrantRefusal(grant)).toBe(DRIVE_RELATIVE);

    // Without that refusal the check approves the resolved path, and a
    // child given it uses exactly that directory.
    expect(check.ipfsGrantRefusal(grant, { win32: false })).toBeNull();
    mkdirInChild(grant);
    expect(fs.existsSync(approved)).toBe(true);
    expect(fs.existsSync(identity)).toBe(false);

    // Handed the text as written, the same child would have used the
    // identity directory: round 2's divergence, live on this machine.
    mkdirInChild(`${drive}ipfs-data\\freedom-ipfs`);
    expect(fs.existsSync(identity)).toBe(true);
  });

  test('a drive-relative root (FREEDOM_IDENTITY_DATA) is refused, and freedom-cored would get it resolved', () => {
    process.env.FREEDOM_IPFS_DATA = `${drive}\\ipfs-data`;
    process.env.FREEDOM_IDENTITY_DATA = `${drive}ipfs-data\\freedom-ipfs`;
    const { check, paths } = load();
    const grant = path.resolve(paths.getIpfsDataDir(), 'freedom-ipfs');
    expect(grant).toBe(`${drive}\\ipfs-data\\freedom-ipfs`);
    expect(check.ipfsGrantRefusal(grant)).toBe(DRIVE_RELATIVE);
    // `serve --data-dir` gets main's resolution, not the text.
    expect(paths.getIdentityDataDir()).toBe(`${drive}\\checked\\ipfs-data\\freedom-ipfs`);
  });
});
