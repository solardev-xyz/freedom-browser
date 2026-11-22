// Main's side of `freedom-cored profile open`, `profile migrate
// --finish-only` (freedom-core design 0013, 5.1 and the reader release,
// PRF-4) and the starting move (PRF-9 B3), with the binary's answers given.
// profile-open.integration.test.js and profile-move.integration.test.js run
// the real binary.

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
  START_MOVE_TIMEOUT_MS,
  buildProfileOpenArgs,
  finishProfileMove,
  getActiveProfile,
  getProfileLaunchReport,
  isProfileIdle,
  openActiveProfile,
  openProfile,
  profileCatalogBackend,
  profileOpenBackend,
  runProfileMove,
  startProfileMove,
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

// A spawnSync that gives `answers` in turn, one per run: `{ stdout, status,
// stderr, signal, error }`.
function answeringInTurn(answers) {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error(`unexpected run ${calls.length}: ${args.join(' ')}`);
    return {
      status: 'status' in answer ? answer.status : 0,
      signal: answer.signal ?? null,
      stdout: answer.stdout === undefined ? '' : `${answer.stdout}\n`,
      stderr: answer.stderr ?? '',
      error: answer.error,
    };
  };
  return { calls, spawnSync };
}

const TIMED_OUT = {
  status: null,
  signal: 'SIGKILL',
  error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
};

describe('runProfileMove: the starting move (PRF-9 B3)', () => {
  const profile = { userDataDir: '/p/work', isDev: false };
  const run = (answers, options = {}) => {
    const spawn = answeringInTurn(answers);
    const outcome = runProfileMove(profile, {
      command: '/c',
      lockDir: '/l',
      spawnSync: spawn.spawnSync,
      ...options,
    });
    return { outcome, calls: spawn.calls };
  };

  test('runs migrate without --finish-only, under the ten-minute bound', () => {
    const { outcome, calls } = run([{ stdout: 'migrated' }]);
    expect(outcome).toEqual({ outcome: 'migrated' });
    expect(calls[0].args).toEqual(['profile', 'migrate', '--profile-dir', '/p/work', '--lock-dir', '/l']);
    expect(calls[0].options.timeout).toBe(START_MOVE_TIMEOUT_MS);
    expect(START_MOVE_TIMEOUT_MS).toBe(600_000);
    // A dev profile's lock timings.
    const dev = answeringInTurn([{ stdout: 'nothing' }]);
    runProfileMove({ userDataDir: '/p/dev', isDev: true }, { command: '/c', lockDir: '/l', spawnSync: dev.spawnSync });
    expect(dev.calls[0].args).toEqual(['profile', 'migrate', '--profile-dir', '/p/dev', '--lock-dir', '/l', '--dev']);
  });

  test('migrated, nothing and rolled_back go on', () => {
    for (const word of ['migrated', 'nothing', 'rolled_back']) {
      expect(run([{ stdout: word }]).outcome).toEqual({ outcome: word });
    }
  });

  test("deferred goes on, with the reason from the core's log line", () => {
    const stderr = [
      '{"level":"info","msg":"profile subcommand confined"}',
      '{"why":"copy_too_large","detail":"ant-data","level":"warn","msg":"the move is deferred to the next start; nothing was changed"}',
      '',
    ].join('\n');
    expect(run([{ stdout: 'deferred', stderr }]).outcome).toEqual({
      outcome: 'deferred',
      reason: 'copy_too_large: ant-data',
    });
    // No detail; and no line of the core's at all.
    expect(
      run([{ stdout: 'deferred', stderr: '{"why":"node_identity_journal","detail":"","msg":"x"}\n' }]).outcome
    ).toEqual({ outcome: 'deferred', reason: 'node_identity_journal' });
    expect(run([{ stdout: 'deferred', stderr: 'not json\n' }]).outcome).toEqual({
      outcome: 'deferred',
      reason: null,
    });
    // A `why` that isn't one of the core's words isn't logged as one.
    expect(
      run([{ stdout: 'deferred', stderr: '{"why":"Some Text\\nwith a newline"}\n' }]).outcome.reason
    ).toBeNull();
  });

  test('busy hands over, as a fresh lock does', () => {
    expect(run([{ stdout: 'busy', status: 75 }]).outcome).toEqual({ outcome: 'busy' });
  });

  test("lock_lost and corrupt keep the profile closed, with a starting move's wording", () => {
    expect(() => run([{ stdout: 'lock_lost', status: 74 }])).toThrow(
      expect.objectContaining({
        code: 'lock_lost',
        message: expect.stringContaining('moved into its freedom folder'),
      })
    );
    expect(() => run([{ stdout: 'corrupt', status: 74 }])).toThrow(
      expect.objectContaining({ code: 'corrupt', message: expect.stringContaining('half moved') })
    );
  });

  test('a timeout, a kill or an unknown answer in the root or moved layout goes on as it is', () => {
    for (const [answer, reason] of [
      [TIMED_OUT, 'timeout'],
      [{ status: null, signal: 'SIGKILL' }, 'failed'],
      [{ stdout: 'moved_sideways' }, 'unknown'],
      [{ stdout: '{"error":"overlap"}', status: 74 }, 'overlap'],
    ]) {
      for (const layout of ['root', 'freedom']) {
        const { outcome, calls } = run([answer], { profileLayout: () => layout });
        expect(outcome).toEqual({ outcome: 'failed', reason, layout });
        // Nothing else run: no --finish-only without a journal.
        expect(calls).toHaveLength(1);
      }
    }
  });

  test('a journal left by a failed run is settled with --finish-only before anything reads the profile', () => {
    const { outcome, calls } = run([{ stdout: 'moved_sideways' }, { stdout: 'rolled_back' }], {
      profileLayout: () => 'pending',
    });
    expect(outcome).toEqual({ outcome: 'rolled_back', reason: 'unknown', layout: 'pending' });
    expect(calls[1].args).toEqual([
      'profile',
      'migrate',
      '--profile-dir',
      '/p/work',
      '--lock-dir',
      '/l',
      '--finish-only',
    ]);
    expect(calls[1].options.timeout).toBe(120_000);
    // Its busy hands over; its lock_lost keeps the profile closed.
    expect(
      run([{ stdout: '{"error":"io"}', status: 74 }, { stdout: 'busy', status: 75 }], {
        profileLayout: () => 'pending',
      }).outcome
    ).toEqual({ outcome: 'busy', reason: 'io', layout: 'pending' });
    expect(() =>
      run([{ stdout: 'moved_sideways' }, { stdout: 'lock_lost', status: 74 }], {
        profileLayout: () => 'pending',
      })
    ).toThrow(expect.objectContaining({ code: 'lock_lost' }));
  });

  test("after main kills a run, --finish-only waits for the killed run's lock to lapse", () => {
    let clock = 0;
    const locked = [true, true, false];
    const isLocked = jest.fn(() => locked.shift());
    const sleep = jest.fn((ms) => {
      clock += ms;
    });
    const { outcome, calls } = run(
      [TIMED_OUT, { stdout: 'busy', status: 75 }, { stdout: 'migrated' }],
      { profileLayout: () => 'pending', isLocked, sleep, now: () => clock }
    );
    expect(outcome).toEqual({ outcome: 'migrated', reason: 'timeout', layout: 'pending' });
    expect(calls).toHaveLength(3);
    expect(isLocked).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    // Never past the lock's stale time and one refresh: then it hands over.
    clock = 0;
    const always = run(
      [TIMED_OUT, { stdout: 'busy', status: 75 }, { stdout: 'busy', status: 75 }],
      { profileLayout: () => 'pending', isLocked: () => true, sleep, now: () => clock }
    );
    expect(always.outcome.outcome).toBe('busy');
    expect(clock).toBeGreaterThanOrEqual(40_000);
    expect(clock).toBeLessThan(41_000);

    // A run that exited on its own let its lock go: a busy then is another's.
    const exited = run([{ stdout: 'moved_sideways' }, { stdout: 'busy', status: 75 }], {
      profileLayout: () => 'pending',
      isLocked: () => {
        throw new Error('not asked');
      },
    });
    expect(exited.outcome.outcome).toBe('busy');
    expect(exited.calls).toHaveLength(2);
  });
});

describe('isProfileIdle (0013, MD1)', () => {
  const profile = { userDataDir: '/p/work' };

  test("profile open's report: no fresh lock and no held gate", () => {
    const never = () => {
      throw new Error('not asked: profile open answered');
    };
    expect(isProfileIdle({ lockFresh: false, gateHeld: false }, profile, { isLocked: never })).toBe(true);
    expect(isProfileIdle({ lockFresh: true, gateHeld: false }, profile, { isLocked: never })).toBe(false);
    expect(isProfileIdle({ lockFresh: false, gateHeld: true }, profile, { isLocked: never })).toBe(false);
  });

  test('the JS path (Windows, --profile-dir, test launches): the lock not fresh', () => {
    const report = { lockFresh: null, gateHeld: null };
    expect(isProfileIdle(report, profile, { isLocked: () => false })).toBe(true);
    expect(isProfileIdle(report, profile, { isLocked: () => true })).toBe(false);
    expect(
      isProfileIdle(report, profile, {
        isLocked: () => {
          throw new Error('EACCES');
        },
      })
    ).toBe(false);
  });
});

describe('startProfileMove: whether this start moves the profile (index.js)', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTempDir('freedom-start-move-');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const packaged = { isPackaged: true };
  const idle = { backend: 'core', layout: 'root', lockFresh: false, gateHeld: false };
  const noAntd = () => null;
  const start = (profile, report, options = {}) => {
    const spawn = answeringInTurn(options.answers || [{ stdout: 'migrated' }]);
    const outcome = startProfileMove(options.app || packaged, profile, report, {
      command: '/c',
      lockDir: '/l',
      spawnSync: spawn.spawnSync,
      findLiveAntProcess: noAntd,
      ...options,
    });
    return { outcome, calls: spawn.calls };
  };

  test('a root-layout profile that is idle is moved', () => {
    const profile = { userDataDir: path.join(tmp, 'work') };
    fs.mkdirSync(profile.userDataDir);
    const { outcome, calls } = start(profile, idle);
    expect(outcome).toEqual({ outcome: 'migrated' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(['profile', 'migrate']);
    expect(calls[0].args).not.toContain('--finish-only');
  });

  test("a --profile-dir or test launch's missing directory is made first, for the empty move", () => {
    const profile = { userDataDir: path.join(tmp, 'nested', 'fresh') };
    const report = { backend: 'js', layout: 'root', lockFresh: null, gateHeld: null };
    const { outcome } = start(profile, report, { isLocked: () => false });
    expect(outcome.outcome).toBe('migrated');
    expect(fs.statSync(profile.userDataDir).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(profile.userDataDir).mode & 0o777).toBe(0o700);
    }
  });

  test('skipped, with nothing run, for each reason the move waits', () => {
    const profile = { userDataDir: path.join(tmp, 'work') };
    const cases = [
      [{ ...idle, layout: 'freedom' }, {}, 'layout'],
      [{ ...idle, layout: 'pending' }, {}, 'layout'],
      [idle, { profile: { ...profile, switchOnly: true } }, 'switch'],
      // A development build without freedom-cored (MD1).
      [idle, { app: { isPackaged: false }, coredPresent: false }, 'no_core'],
      // Open elsewhere: the lock hands over below (MD2).
      [{ ...idle, lockFresh: true }, {}, 'open'],
      [{ ...idle, gateHeld: true }, {}, 'open'],
      [{ backend: 'js', layout: 'root', lockFresh: null, gateHeld: null }, { isLocked: () => true }, 'open'],
      // An antd that outlived a crashed main (MD7).
      [idle, { findLiveAntProcess: () => ({ pid: 4242 }) }, 'node_running: antd pid 4242'],
    ];
    for (const [report, options, reason] of cases) {
      const { outcome, calls } = start(options.profile || profile, report, { ...options, answers: [] });
      expect(outcome).toEqual({ outcome: 'skipped', reason });
      expect(calls).toHaveLength(0);
    }
  });

  test('a development build with freedom-cored moves, and asks ant-process.json about the profile', () => {
    const profile = { userDataDir: path.join(tmp, 'dev'), isDev: true };
    fs.mkdirSync(profile.userDataDir);
    const findLiveAntProcess = jest.fn(() => null);
    const { outcome, calls } = start(profile, idle, {
      app: { isPackaged: false },
      coredPresent: true,
      findLiveAntProcess,
    });
    expect(outcome.outcome).toBe('migrated');
    expect(findLiveAntProcess).toHaveBeenCalledWith(profile.userDataDir);
    expect(calls[0].args).toContain('--dev');
  });
});
