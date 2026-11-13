// Main's side of `freedom-cored profile open` and `profile migrate
// --finish-only` (freedom-core design 0013, 5.1 and the reader release,
// PRF-4), with the binary's answers given. profile-open.integration.test.js
// runs the real binary.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createAppMock,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');
const { hashPath } = require('./profile-catalog');
const {
  PROFILE_SWITCH_REJECTED,
  buildProfileOpenArgs,
  finishProfileMove,
  getActiveProfile,
  getProfileLaunchReport,
  openActiveProfile,
  openProfile,
  profileCatalogBackend,
  profileOpenBackend,
} = require('./profile-resolver');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRepoRoot() {
  const repoRoot = makeTempDir('freedom-repo-');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"freedom-browser"}');
  return repoRoot;
}

function opened(userDataDir, extra = {}) {
  return {
    outcome: 'opened',
    id: 'work',
    display_name: 'Work',
    user_data_dir: userDataDir,
    slot: 1,
    nodes: { tor: { mode: 'managed' } },
    lock_fresh: false,
    gate_held: false,
    layout: 'root',
    forget_pending: 0,
    catalog_path: '/app/profile-registry.json',
    metadata: { version: 1, id: 'work', displayName: 'Work', slot: 1 },
    ...extra,
  };
}

function answering(result, { status = 0 } = {}) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status,
      signal: null,
      stdout: `${typeof result === 'string' ? result : JSON.stringify(result)}\n`,
      stderr: '',
    };
  };
  return { calls, spawnSync };
}

describe('which implementation opens the profile', () => {
  test('Windows keeps the JS path until its first-scan qualification', () => {
    const app = { isPackaged: true };
    expect(profileOpenBackend(app, { platform: 'win32' })).toBe('js');
    expect(profileOpenBackend(app, { platform: 'linux' })).toBe('core');
    expect(profileOpenBackend(app, { platform: 'darwin' })).toBe('core');
    // Every other catalog operation goes through the core there too.
    expect(profileCatalogBackend(app)).toBe('core');
  });

  test('a development build without freedom-cored keeps the JS path', () => {
    const app = { isPackaged: false };
    expect(profileOpenBackend(app, { platform: 'linux', coredPresent: false })).toBe('js');
    expect(profileOpenBackend(app, { platform: 'linux', coredPresent: true })).toBe('core');
    expect(profileCatalogBackend(app, { coredPresent: false })).toBe('js');
  });
});

describe('profile open: what main passes', () => {
  const base = { appRoot: '/app', lockDir: '/locks', isDev: false, checkoutHash: null, env: {} };

  test('packaged: the app root as the default profile directory', () => {
    expect(buildProfileOpenArgs({ ...base, argv: ['freedom'], platform: 'linux' })).toEqual([
      'profile',
      'open',
      '--app-root',
      '/app',
      '--lock-dir',
      '/locks',
      '--default-profile-dir',
      '/app',
    ]);
  });

  test("development: the checkout's hash and Profiles/default", () => {
    expect(
      buildProfileOpenArgs({ ...base, isDev: true, checkoutHash: 'abcd0123', argv: ['e', '.'] })
    ).toEqual([
      'profile',
      'open',
      '--app-root',
      '/app',
      '--lock-dir',
      '/locks',
      '--dev',
      '--checkout-hash',
      'abcd0123',
      '--default-profile-dir',
      path.join('/app', 'Profiles', 'default'),
    ]);
  });

  test('--profile wins over a switch; FREEDOM_PROFILE and --runtime are passed on', () => {
    const args = buildProfileOpenArgs({
      ...base,
      argv: ['freedom', '--profile=work', 'x-freedom-profile:home', '--runtime'],
      env: { FREEDOM_PROFILE: 'env' },
      platform: 'linux',
    });
    expect(args.slice(8)).toEqual(['--profile', 'work', '--env-profile', 'env', '--runtime']);
  });

  test('an x-freedom-profile: switch names its id, or none', () => {
    expect(
      buildProfileOpenArgs({ ...base, argv: ['freedom', 'x-freedom-profile:home'], platform: 'linux' })
        .slice(8)
    ).toEqual(['--switch', 'home']);
    expect(
      buildProfileOpenArgs({
        ...base,
        argv: ['freedom', 'x-freedom-profile:a', 'x-freedom-profile:b'],
        platform: 'linux',
      }).slice(8)
    ).toEqual(['--switch', '']);
    // The scheme is Linux's alone.
    expect(
      buildProfileOpenArgs({ ...base, argv: ['freedom', 'x-freedom-profile:home'], platform: 'darwin' })
        .slice(8)
    ).toEqual([]);
  });
});

describe('openProfile through the core', () => {
  let dirs = [];
  afterEach(() => {
    dirs.forEach(removeTempUserDataDir);
    dirs = [];
  });
  const track = (dir) => {
    dirs.push(dir);
    return dir;
  };

  test("maps the core's answer into the resolver's profile, and its report", () => {
    const appRoot = track(makeTempDir('freedom-app-'));
    const app = createAppMock({ isPackaged: true, userDataDir: appRoot });
    const dir = path.join(appRoot, 'Profiles', 'work');
    const { calls, spawnSync } = answering(opened(dir, { gate_held: true, forget_pending: 2 }));
    const { profile, report } = openProfile(app, {
      backend: 'core',
      argv: ['freedom', '--profile', 'work'],
      env: {},
      platform: 'linux',
      command: '/bin/freedom-cored',
      lockDir: '/locks',
      spawnSync,
    });
    expect(calls[0].command).toBe('/bin/freedom-cored');
    expect(calls[0].args).toContain('--profile');
    expect(profile).toEqual({
      id: 'work',
      displayName: 'Work',
      source: 'catalog',
      appRoot,
      userDataDir: dir,
      isDev: false,
      repoRoot: null,
      checkoutHash: null,
      catalogPath: '/app/profile-registry.json',
      metadata: { version: 1, id: 'work', displayName: 'Work', slot: 1 },
    });
    expect(report).toEqual(
      expect.objectContaining({
        backend: 'core',
        lockFresh: false,
        gateHeld: true,
        layout: 'root',
        forgetPending: 2,
      })
    );
    expect(typeof report.ms).toBe('number');
  });

  test('a development launch names its checkout and FREEDOM_DEV_HOME', () => {
    const devHome = track(makeTempDir('freedom-dev-home-'));
    const repoRoot = track(makeRepoRoot());
    const app = createAppMock({ isPackaged: false });
    const dir = path.join(devHome, 'Profiles', 'default');
    const { calls, spawnSync } = answering(opened(dir, { switch_only: true }));
    const { profile } = openProfile(app, {
      backend: 'core',
      argv: ['electron', '.'],
      env: { FREEDOM_DEV_HOME: devHome },
      repoRoot,
      platform: 'linux',
      command: '/c',
      lockDir: '/l',
      spawnSync,
    });
    const realRepo = fs.realpathSync(repoRoot);
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['--dev', '--checkout-hash', hashPath(realRepo)])
    );
    expect(profile.appRoot).toBe(devHome);
    expect(profile.isDev).toBe(true);
    expect(profile.repoRoot).toBe(realRepo);
    expect(profile.switchOnly).toBe(true);
  });

  test('a refused switch is PROFILE_SWITCH_REJECTED, as the resolver throws it', () => {
    const appRoot = track(makeTempDir('freedom-app-'));
    const app = createAppMock({ isPackaged: true, userDataDir: appRoot });
    const { spawnSync } = answering({
      outcome: 'switch_refused',
      message: 'Refused an x-freedom-profile switch to "work", which is not open',
    });
    expect(() =>
      openProfile(app, {
        backend: 'core',
        argv: ['freedom', 'x-freedom-profile:work'],
        env: {},
        platform: 'linux',
        command: '/c',
        lockDir: '/l',
        spawnSync,
      })
    ).toThrow(expect.objectContaining({ code: PROFILE_SWITCH_REJECTED }));
  });

  test('a storage refusal throws, for the "could not open" dialog', () => {
    const appRoot = track(makeTempDir('freedom-app-'));
    const app = createAppMock({ isPackaged: true, userDataDir: appRoot });
    const { spawnSync } = answering({ error: 'network_filesystem' }, { status: 74 });
    expect(() =>
      openProfile(app, {
        backend: 'core',
        argv: ['freedom'],
        env: {},
        platform: 'linux',
        command: '/c',
        lockDir: '/l',
        spawnSync,
      })
    ).toThrow("Freedom's profiles can't live on a network filesystem");
  });

  test('--profile-dir and a test user-data directory stay in main', () => {
    const userDataDir = track(makeTempDir('freedom-test-user-data-'));
    const app = createAppMock({ isPackaged: false, userDataDir });
    const spawnSync = jest.fn();
    const { profile, report } = openProfile(app, {
      argv: ['electron', '.'],
      env: { FREEDOM_TEST_USER_DATA: userDataDir },
      spawnSync,
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(profile.source).toBe('test-user-data');
    expect(report).toEqual(
      expect.objectContaining({ backend: 'js', gateHeld: null, layout: 'root' })
    );
  });

  test('openActiveProfile points userData at the profile and keeps the report', () => {
    const appRoot = track(makeTempDir('freedom-app-'));
    const app = createAppMock({ isPackaged: true, userDataDir: appRoot });
    const dir = path.join(appRoot, 'Profiles', 'work');
    const { spawnSync } = answering(opened(dir, { layout: 'pending' }));
    const profile = openActiveProfile(app, {
      backend: 'core',
      argv: ['freedom'],
      env: {},
      platform: 'linux',
      command: '/c',
      lockDir: '/l',
      spawnSync,
    });
    expect(getActiveProfile()).toBe(profile);
    expect(getProfileLaunchReport().layout).toBe('pending');
    expect(app.setPath).toHaveBeenCalledWith('userData', dir);
    expect(app.setPath).toHaveBeenCalledWith('crashDumps', path.join(dir, 'crash-reports'));
  });
});

describe("finishProfileMove: a move's journal settled before the lock", () => {
  const profile = { userDataDir: '/p/work', isDev: true };

  test('runs migrate --finish-only, with the dev timings for a dev profile', () => {
    const { calls, spawnSync } = answering('rolled_back');
    expect(finishProfileMove(profile, { command: '/c', lockDir: '/l', spawnSync })).toBe(
      'rolled_back'
    );
    expect(calls[0].args).toEqual([
      'profile',
      'migrate',
      '--profile-dir',
      '/p/work',
      '--lock-dir',
      '/l',
      '--dev',
      '--finish-only',
    ]);
    for (const word of ['migrated', 'nothing']) {
      expect(finishProfileMove(profile, { command: '/c', lockDir: '/l', ...answering(word) })).toBe(
        word
      );
    }
  });

  test('busy: the profile is held by another process', () => {
    expect(
      finishProfileMove(profile, { command: '/c', lockDir: '/l', ...answering('busy', { status: 75 }) })
    ).toBe('busy');
  });

  test('lock_lost and corrupt stop the profile from opening, with nothing guessed', () => {
    for (const word of ['lock_lost', 'corrupt']) {
      expect(() =>
        finishProfileMove(profile, {
          command: '/c',
          lockDir: '/l',
          ...answering(word, { status: 74 }),
        })
      ).toThrow(expect.objectContaining({ code: word }));
    }
    expect(() =>
      finishProfileMove(profile, {
        command: '/c',
        lockDir: '/l',
        ...answering('{"error":"overlap"}', { status: 74 }),
      })
    ).toThrow(expect.objectContaining({ code: 'storage', kind: 'overlap' }));
  });
});
