/**
 * The freedom-radicled client (freedom-core design 0008, "Process model",
 * "Errors" and Bounds), against an in-process fake service on the design's
 * frames (`test/helpers/fake-radicled.js`) and a manual clock: the binary
 * and the serve process's arguments, the environment it gets, the
 * handshake and what it accepts, each hang watchdog, each exit code's
 * restart rule, and main's grant check before each spawn (service-grant's
 * `radicleGrantRefusal`, stubbed here: service-grant.test.js checks it on
 * real directories). The supervision itself is ServiceClient's
 * (service-client.test.js, core-client.test.js); a real binary answers the
 * handshake in radicled-client.integration.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-grant', () => ({ radicleGrantRefusal: jest.fn(() => null) }));

const {
  RadicledClient,
  expectedServiceVersion,
  networkWatchdogMs,
  radicledEnv,
  radicledService,
  serveArgs,
  validHello,
  validRecipient,
  HANG_GRACE_MS,
  MAX_TIMER_MS,
  SHUTDOWN_GRACE_MS,
  STATS_WATCHDOG_MS,
} = require('./radicled-client');
const { getRadicledBinaryPath } = require('./radicled-binary');
const { PINNED_RADICLED_VERSION } = require('./radicled-pin');
const { ServiceClient, scrubbedEnv } = require('../core/service-client');
const { radicleGrantRefusal } = require('../service-grant');
const {
  fakeRadicled,
  envRefusal,
  helloFor,
  statsResult,
  CONFINEMENT,
  HELLO,
} = require('../../../test/helpers/fake-radicled');

const HOME = path.join('app-data', 'Freedom', 'R', '1');
const LOCK_DIR = path.join('app-data', 'Freedom', 'locks');
const DIRECT = { mode: 'direct' };
const SOCKS5 = { mode: 'socks5', ip: '127.0.0.1', port: 9150 };
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

/** Timers that run only when the test advances the clock. */
function manualClock() {
  let now = 1_000_000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    /** Runs every timer due within `ms`, in order, letting I/O settle between. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** Lets the pipes and promises run. */
async function settle(turns = 20) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

let root;
let ownHome;
let clock;
let service;
let client;
let log;
// The variables these tests set in main's environment, restored after each
// (process.env itself is kept: on Windows its names are case-insensitive).
const SET = [
  'HOME',
  'USERPROFILE',
  'RAD_PASSPHRASE',
  'RAD_KEYGEN_SEED',
  'RAD_SOCKET',
  'RAD_HOME',
  'GIT_COMMITTER_DATE',
  'GIT_CONFIG_GLOBAL',
  'GIT_DIR',
  'SSH_AUTH_SOCK',
  'LISTEN_FDS',
  'XDG_CONFIG_HOME',
  'FREEDOM_RADICLED_PATH',
  'FREEDOM_RADICLED_RELEASE_TAG',
];
const savedEnv = Object.fromEntries(SET.map((name) => [name, process.env[name]]));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicled-client-'));
  ownHome = path.join(root, 'radicled-home');
  clock = manualClock();
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  radicleGrantRefusal.mockReset();
  radicleGrantRefusal.mockReturnValue(null);
});

afterEach(async () => {
  if (client) {
    client.removeAllListeners();
    const stopped = client.stop();
    await clock.advance(SHUTDOWN_GRACE_MS);
    await stopped;
    client = null;
  }
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function newClient(script = {}, extra = {}) {
  service = fakeRadicled(script);
  client = new RadicledClient({
    home: HOME,
    lockDir: LOCK_DIR,
    ownHome,
    spawn: service.spawn,
    log,
    shellVersion: '0.9.0-test',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  });
  return client;
}

/** A client whose process has answered the handshake: its generation. */
async function ready(script, extra) {
  newClient(script, extra);
  await client.start();
  return client.current;
}

const child = (n = -1) => service.children.at(n);
const hang = () => {};

describe('the serve process', () => {
  test("serve, the Radicle home, the lock directory, the policy and main's PID", () => {
    expect(serveArgs({ home: 'h', lockDir: 'l', network: DIRECT, parentPid: 42 })).toEqual([
      'serve',
      '--home',
      'h',
      '--lock-dir',
      'l',
      '--network',
      'direct',
      '--parent-pid',
      '42',
    ]);
    // `direct` by default, and this process's PID.
    expect(serveArgs({ home: 'h', lockDir: 'l' })).toEqual([
      'serve',
      '--home',
      'h',
      '--lock-dir',
      'l',
      '--network',
      'direct',
      '--parent-pid',
      String(process.pid),
    ]);
    // 0007's forms: an IPv6 proxy in brackets.
    expect(
      serveArgs({ home: 'h', lockDir: 'l', network: { mode: 'socks5', ip: '::1', port: 9150 } })
    ).toContain('socks5:[::1]:9150');
  });

  test('the client spawns the binary radicled-binary.js names, with those arguments', async () => {
    await ready();
    expect(service.spawned).toHaveLength(1);
    const [{ command, args, options }] = service.spawned;
    expect(command).toBe(getRadicledBinaryPath());
    expect(args).toEqual(
      serveArgs({ home: HOME, lockDir: LOCK_DIR, network: DIRECT, parentPid: process.pid })
    );
    expect(options).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // A policy given is the one spawned under, and the one hello must name.
    await client.stop();
    await ready({}, { network: SOCKS5, command: 'freedom-radicled' });
    expect(service.spawned[0].command).toBe('freedom-radicled');
    expect(service.spawned[0].args.slice(5, 7)).toEqual(['--network', 'socks5:127.0.0.1:9150']);
    expect(client.hello.network).toEqual(SOCKS5);
  });
});

describe("the service's environment", () => {
  test("the scrubbed one, with HOME the service's own: the user's home never reaches it", () => {
    const env = radicledEnv('/own', {
      PATH: '/bin',
      HOME: '/home/user',
      USERPROFILE: 'C:\\Users\\user',
      LANG: 'C.UTF-8',
      RUST_LOG: 'info',
      SystemRoot: 'C:\\Windows',
      NODE_OPTIONS: '--inspect',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/own',
      LANG: 'C.UTF-8',
      RUST_LOG: 'info',
      SystemRoot: 'C:\\Windows',
    });
    // The shared allowlist, and so ipfsd's and the core's, is unchanged.
    expect(scrubbedEnv({ HOME: '/home/user', USERPROFILE: 'u' })).toEqual({
      HOME: '/home/user',
      USERPROFILE: 'u',
    });
  });

  test("neither the user's HOME nor RAD_*, GIT_* or SSH_AUTH_SOCK in main reaches the child", async () => {
    const userHome = path.join(root, 'user-home');
    fs.mkdirSync(userHome);
    Object.assign(process.env, {
      HOME: userHome,
      USERPROFILE: userHome,
      RAD_PASSPHRASE: 'secret',
      RAD_KEYGEN_SEED: '00',
      RAD_SOCKET: '/tmp/rad.sock',
      GIT_COMMITTER_DATE: '0',
      GIT_DIR: '/elsewhere',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      LISTEN_FDS: '3',
      XDG_CONFIG_HOME: '/elsewhere',
    });
    // The fake refuses what the real service refuses (exit 64): it starts.
    await ready();
    const { env } = service.spawned[0].options;
    expect(env.HOME).toBe(ownHome);
    expect(env.USERPROFILE).toBeUndefined();
    expect(Object.values(env)).not.toContain(userHome);
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(RAD_|GIT_|SSH_AUTH_SOCK$|LISTEN_|XDG_CONFIG_HOME$)/i);
    }
    expect(envRefusal(env)).toBeNull();
    expect(child().refused).toBeNull();
    // The service's HOME is made, owner-only and empty, before the spawn.
    expect(fs.readdirSync(ownHome)).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(ownHome).mode & 0o777).toBe(0o700);
  });

  test('a directory removed between spawns is made again for the restart', async () => {
    await ready();
    fs.rmSync(ownHome, { recursive: true });
    child(0).exit(70);
    await settle();
    await clock.advance(500);
    expect(service.children).toHaveLength(2);
    expect(client.state).toBe('ready');
    expect(fs.statSync(ownHome).isDirectory()).toBe(true);
  });

  test("the fake refuses what the service refuses, as the service's own check does", () => {
    const home = root;
    expect(envRefusal({ HOME: home })).toBeNull();
    expect(envRefusal({ HOME: home, RAD_HOME: '/x' })).toBe('rad');
    expect(envRefusal({ HOME: home, git_dir: '/x' })).toBe('git');
    expect(envRefusal({ HOME: home, SSH_AUTH_SOCK: '/x' })).toBe('ssh_agent');
    expect(envRefusal({ HOME: home, LISTEN_PID: '1' })).toBe('socket_activation');
    expect(envRefusal({ HOME: home, XDG_CONFIG_HOME: '/x' })).toBe('xdg_config');
    expect(envRefusal({})).toBe('home');
    expect(envRefusal({ HOME: 'relative' })).toBe('home');
    expect(envRefusal({ HOME: path.join(root, 'missing') })).toBe('home');
  });
});

describe("main's grant check before every spawn (design 0010, step 7)", () => {
  const REFUSED = "the grant lies inside this profile's identity directory";

  test('the Radicle home and the service HOME, exactly as the service is given them', async () => {
    await ready();
    expect(radicleGrantRefusal).toHaveBeenCalledTimes(1);
    expect(radicleGrantRefusal).toHaveBeenCalledWith(HOME, ownHome);
    const { args, options } = service.spawned[0];
    expect(args[args.indexOf('--home') + 1]).toBe(HOME);
    expect(options.env.HOME).toBe(ownHome);
    expect(client.grantRefusal).toBeNull();
  });

  test('a refusal spawns nothing and fails the client, saying why without a path', async () => {
    radicleGrantRefusal.mockReturnValue(REFUSED);
    newClient();
    const failed = new Promise((resolve) => client.once('failed', resolve));
    await expect(client.start()).rejects.toBeTruthy();
    await expect(failed).resolves.toBe('spawn refused');
    expect(service.spawned).toHaveLength(0);
    expect(client.state).toBe('failed');
    expect(client.grantRefusal).toBe(REFUSED);
    expect(log.error).toHaveBeenCalledWith('[radicled] Radicle home refused', {
      reason: REFUSED,
    });
    // The service's HOME isn't made for a process that isn't spawned.
    expect(fs.existsSync(ownHome)).toBe(false);
  });

  test('a check that throws refuses too, naming only the error code', async () => {
    radicleGrantRefusal.mockImplementation(() => {
      throw Object.assign(new Error(`EACCES: ${root}`), { code: 'EACCES' });
    });
    newClient();
    const failed = new Promise((resolve) => client.once('failed', resolve));
    await expect(client.start()).rejects.toBeTruthy();
    await expect(failed).resolves.toBe('spawn refused');
    expect(service.spawned).toHaveLength(0);
    expect(client.grantRefusal).toBe('the check failed: EACCES');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(root);
  });

  test("a crash's restart is checked again, and a refusal there spawns nothing", async () => {
    await ready();
    radicleGrantRefusal.mockReturnValue(
      'the grant holds a hard link to a file with a name outside it'
    );
    const failed = new Promise((resolve) => client.once('failed', resolve));
    child(0).exit(70);
    await settle();
    await clock.advance(500);
    await expect(failed).resolves.toBe('spawn refused');
    expect(radicleGrantRefusal).toHaveBeenCalledTimes(2);
    expect(service.children).toHaveLength(1);
    expect(client.state).toBe('failed');
    await clock.advance(60_000);
    expect(service.children).toHaveLength(1);
  });

  test('each restart, and a later start, runs it once', async () => {
    await ready();
    for (let n = 2; n <= 3; n++) {
      child(-1).exit(70);
      await settle();
      await clock.advance(10_000);
      expect(service.children).toHaveLength(n);
      expect(radicleGrantRefusal).toHaveBeenCalledTimes(n);
    }
    await client.stop();
    await client.start();
    expect(radicleGrantRefusal).toHaveBeenCalledTimes(4);
    expect(service.children).toHaveLength(4);
  });

  test("a process under another policy is a new client's, checked before its spawn", async () => {
    await ready();
    const first = client;
    first.removeAllListeners();
    await first.stop();
    newClient({}, { network: SOCKS5 });
    await client.start();
    expect(radicleGrantRefusal).toHaveBeenCalledTimes(2);
    expect(service.spawned[0].args).toContain('socks5:127.0.0.1:9150');
  });

  test("a caller's beforeSpawn is asked only once the grant passes", async () => {
    const beforeSpawn = jest.fn(() => null);
    radicleGrantRefusal.mockReturnValue(REFUSED);
    newClient({}, { beforeSpawn });
    await expect(client.start()).rejects.toBeTruthy();
    expect(beforeSpawn).not.toHaveBeenCalled();
    radicleGrantRefusal.mockReturnValue(null);
    beforeSpawn.mockReturnValue('not yet');
    newClient({}, { beforeSpawn });
    await expect(client.start()).rejects.toBeTruthy();
    expect(beforeSpawn).toHaveBeenCalledTimes(1);
    expect(client.grantRefusal).toBeNull();
    expect(service.spawned).toHaveLength(0);
  });
});

describe('the handshake', () => {
  test('rad.hello asks for stream frames, and a valid answer grants them', async () => {
    const gen = await ready();
    expect(child().sent('rad.hello')).toEqual([
      expect.objectContaining({
        params: { protocol: 1, shell_version: '0.9.0-test', frames: ['stream'] },
        context: { caller: 'shell' },
      }),
    ]);
    expect(client.hello).toEqual(HELLO);
    expect(gen.streams).not.toBeNull();
    const svc = radicledService({ network: DIRECT });
    expect(svc.helloMethod).toBe('rad.hello');
    expect(svc.streams(HELLO)).toBe(true);
    expect(svc.fragments(HELLO)).toBe(false);
    expect(svc.shutdownMethod).toBe('rad.shutdown');
    expect(svc.maxPending).toBe(512);
    expect(svc.unavailableCode).toBe('radicle_unavailable');
  });

  test('a valid hello: its public part, the policy main passed and the pinned release', () => {
    expect(validHello(HELLO, DIRECT, PINNED_RADICLED_VERSION)).toEqual(HELLO);
    expect(validHello({ ...HELLO, extra: 1 }, DIRECT)).toEqual(HELLO);
    expect(validHello(helloFor(['--network', 'socks5:127.0.0.1:9150']), SOCKS5)).toMatchObject({
      network: SOCKS5,
    });
    // With no release to expect, any well-formed one.
    expect(validHello({ ...HELLO, service_version: '9.9.9' }, DIRECT, null)).toMatchObject({
      service_version: '9.9.9',
    });
  });

  // Each member refused in turn: a hello that isn't the process main
  // spawned, under the policy main passed, from the release it expects.
  test.each([
    ['not an object', null],
    ['an array', []],
    ['another protocol', { ...HELLO, protocol: 2 }],
    ['no protocol', { ...HELLO, protocol: undefined }],
    ['no service_version', { ...HELLO, service_version: undefined }],
    ['an empty service_version', { ...HELLO, service_version: '' }],
    ['a malformed service_version', { ...HELLO, service_version: 'a b' }],
    ['another release than the pin', { ...HELLO, service_version: '0.0.9' }],
    ['no libradicle', { ...HELLO, libradicle: undefined }],
    ['a libradicle that is no object', { ...HELLO, libradicle: '0.8.0' }],
    ['no libradicle version', { ...HELLO, libradicle: { git_commit: 'abcdef1' } }],
    [
      'a libradicle version of another type',
      { ...HELLO, libradicle: { version: 8, git_commit: 'abcdef1' } },
    ],
    ['no libradicle commit', { ...HELLO, libradicle: { version: '0.8.0' } }],
    [
      'a libradicle commit that is no hex',
      { ...HELLO, libradicle: { version: '0.8.0', git_commit: 'main' } },
    ],
    ['no recipient', { ...HELLO, recipient: undefined }],
    ['a recipient of 31 bytes', { ...HELLO, recipient: Buffer.alloc(31, 7).toString('base64') }],
    ['a recipient of 33 bytes', { ...HELLO, recipient: Buffer.alloc(33, 7).toString('base64') }],
    ['an unpadded recipient', { ...HELLO, recipient: HELLO.recipient.slice(0, -1) }],
    [
      'a URL-safe recipient',
      { ...HELLO, recipient: Buffer.alloc(32, 0xfb).toString('base64url') + '=' },
    ],
    ['a recipient that is no string', { ...HELLO, recipient: 32 }],
    ['another policy', { ...HELLO, network: SOCKS5 }],
    ['no policy', { ...HELLO, network: undefined }],
    ['a policy with more in it', { ...HELLO, network: { mode: 'direct', extra: 1 } }],
    ['no confinement', { ...HELLO, confinement: undefined }],
    [
      'a confinement status it has no word for',
      { ...HELLO, confinement: { ...CONFINEMENT, files: 'mostly' } },
    ],
    [
      'a malformed mechanism',
      { ...HELLO, confinement: { ...CONFINEMENT, mechanism: 'Landlock 4' } },
    ],
    ['malformed gaps', { ...HELLO, confinement: { ...CONFINEMENT, gaps: 'signals' } }],
  ])('refuses %s', (_why, hello) => {
    expect(validHello(hello, DIRECT, PINNED_RADICLED_VERSION)).toBeNull();
  });

  test('a recipient is 32 bytes in canonical standard base64', () => {
    expect(validRecipient(HELLO.recipient)).toBe(true);
    expect(validRecipient(Buffer.alloc(32, 0xfb).toString('base64'))).toBe(true);
    // The last character's low bits are zero in the canonical form.
    const canonical = Buffer.alloc(32, 0).toString('base64');
    expect(canonical).toMatch(/A=$/);
    expect(validRecipient(canonical.replace(/A=$/, 'B='))).toBe(false);
    expect(validRecipient(` ${HELLO.recipient}`)).toBe(false);
  });

  test('an invalid hello is a fault: the process is killed, and never serves', async () => {
    newClient({ hello: (m, c) => c.result(m.id, { ...HELLO, recipient: 'short' }) });
    const started = client.start().catch((e) => e);
    await settle();
    expect(child(0).killedWith).toBe('SIGKILL');
    expect(client.state).toBe('starting');
    expect(log.error).toHaveBeenCalledWith('[radicled] invalid rad.hello result');
    client.removeAllListeners();
    await client.stop();
    expect(await started).toMatchObject({ code: 'radicle_unavailable' });
  });

  test("another release's hello is refused: the pin, in a packaged build", async () => {
    newClient(
      { hello: (m, c) => c.result(m.id, { ...HELLO, service_version: '9.9.9' }) },
      { serviceVersion: PINNED_RADICLED_VERSION }
    );
    client.start().catch(() => {});
    await settle();
    expect(child(0).killedWith).toBe('SIGKILL');
    expect(client.serviceVersion).toBe(PINNED_RADICLED_VERSION);
  });

  test('another protocol is a mismatch: failed, with no restart', async () => {
    newClient({ hello: (m, c) => c.result(m.id, { ...HELLO, protocol: 2 }) });
    const failed = new Promise((resolve) => client.once('failed', resolve));
    await expect(client.start()).rejects.toMatchObject({ code: 'radicle_unavailable' });
    await expect(failed).resolves.toBe('protocol mismatch');
    await clock.advance(10_000);
    expect(service.children).toHaveLength(1);
  });

  test('the release hello must report: the pin, or what a development build fetched', () => {
    expect(expectedServiceVersion({ packaged: true, env: {} })).toBe(PINNED_RADICLED_VERSION);
    // A packaged build honours no override.
    expect(expectedServiceVersion({ packaged: true, env: { FREEDOM_RADICLED_PATH: '/x' } })).toBe(
      PINNED_RADICLED_VERSION
    );
    expect(expectedServiceVersion({ packaged: false, env: {} })).toBe(PINNED_RADICLED_VERSION);
    expect(
      expectedServiceVersion({
        packaged: false,
        env: { FREEDOM_RADICLED_RELEASE_TAG: 'radicled-v9.8.7' },
      })
    ).toBe('9.8.7');
    expect(
      expectedServiceVersion({ packaged: false, env: { FREEDOM_RADICLED_RELEASE_TAG: 'latest' } })
    ).toBeNull();
    expect(expectedServiceVersion({ packaged: false, env: { FREEDOM_RADICLED_PATH: '/x' } })).toBe(
      null
    );
    // The client checks what it was given, or the expected one.
    delete process.env.FREEDOM_RADICLED_PATH;
    delete process.env.FREEDOM_RADICLED_RELEASE_TAG;
    expect(newClient().serviceVersion).toBe(PINNED_RADICLED_VERSION);
    client = null;
    expect(newClient({}, { serviceVersion: null }).serviceVersion).toBeNull();
    client = null;
  });
});

describe('hang watchdogs: the deadline + 15 s', () => {
  // Each call, hung: the process is killed at its watchdog, what it held
  // fails, and the restart rules apply.
  test.each([
    ['rad.identity', 30_000 + 15_000, (gen) => client.identity(gen, { ephemeral: true })],
    ['rad.reconcile', 300_000 + 15_000, (gen) => client.reconcile(gen)],
    ['rad.start', 30_000 + 15_000, (gen) => client.startNode(gen, 'alice')],
    ['rad.stats', 20_000, (gen) => client.nodeStats(gen)],
    ['rad.read', 60_000 + 15_000, (gen) => client.read(gen, 'repo_info', { rid: RID })],
    [
      'rad.blob',
      60_000 + 15_000,
      (gen) => client.blob(gen, { rid: RID, revision: 'a'.repeat(40), path: 'README.md' }),
    ],
    ['rad.quarantine_list', 60_000 + 15_000, (gen) => client.quarantineList(gen, null)],
    ['rad.connect_seeds', 15_000 + 30_000 + 15_000, (gen) => client.connectSeeds(gen, 15_000)],
    [
      'rad.clone',
      120_000 + 30_000 + 15_000,
      (gen) => client.clone(gen, { rid: RID, timeout_ms: 120_000, progress: true }),
    ],
    [
      'rad.write',
      60_000 + 15_000,
      (gen) =>
        client.write(gen, 'create_issue', { rid: RID, title: 't', description: '', labels: [] }),
    ],
    ['rad.unseed', 60_000 + 15_000, (gen) => client.unseed(gen, RID)],
    ['rad.remove_repo', 60_000 + 15_000, (gen) => client.removeRepo(gen, RID, 'q1')],
  ])('%s: killed at %d ms with no reply, then restarted', async (method, ms, call) => {
    const gen = await ready({ [method.slice('rad.'.length)]: hang });
    const pending = call(gen).catch((e) => e);
    await settle();
    expect(child(0).sent(method)).toHaveLength(1);
    await clock.advance(ms - 1);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
    expect(await pending).toMatchObject({ code: 'radicle_unavailable' });
    expect(log.error).toHaveBeenCalledWith(
      '[radicled] request hung; restarting the Radicle service',
      { method }
    );
    await clock.advance(500);
    expect(service.children).toHaveLength(2);
    expect(client.state).toBe('ready');
  });

  test('the handshake: killed with no rad.hello reply within 10 s', async () => {
    newClient({ hello: hang });
    client.start().catch(() => {});
    await settle();
    await clock.advance(10_000 - 1);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
  });

  test("rad.identity's runs from the handshake: the service's 30 s start at its hello reply", async () => {
    const gen = await ready({ identity: hang });
    expect(gen.readyAt).toBe(clock.now());
    // The core's seal took 10 s: 35 s are left of the 45.
    await clock.advance(10_000);
    client.identity(gen, { sealed: { enc: 'e', ciphertext: 'c' } }).catch(() => {});
    await settle();
    await clock.advance(35_000 - 1);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
  });

  test("a read's watchdog runs to its head: a slow body is the reader's to judge", async () => {
    const reads = [];
    const gen = await ready({ read: (m) => reads.push(m) });
    const head = client.read(gen, 'repo_info', { rid: RID });
    await settle();
    await clock.advance(60_000);
    child(0).head(reads[0].id, { body: true });
    const { result, body } = await head;
    expect(result.body).toBe(true);
    await clock.advance(10 * 60_000);
    expect(child(0).killedWith).toBeUndefined();
    child(0).body(reads[0].id, Buffer.from('{"ok":true}'));
    const text = await new Response(body).text();
    expect(JSON.parse(text)).toEqual({ ok: true });
  });

  test("rad.read's head opens its body though it doesn't say body: true, as freedom-radicled writes it", async () => {
    const reads = [];
    const gen = await ready({ read: (m) => reads.push(m) });
    const text = '{"rid":"rad:z1","name":"reads"}';
    const head = client.read(gen, 'repo_info', { rid: RID });
    await settle();
    expect(reads[0].params).toEqual({ op: 'repo_info', args: { rid: RID } });
    child(0).readReply(reads[0].id, text);
    const { result, body } = await head;
    expect(result).toEqual({ content_type: 'application/json', bytes: text.length });
    expect(await new Response(body).text()).toBe(text);
    // An error reply opens nothing.
    const failed = client.read(gen, 'repo_info', { rid: RID });
    await settle();
    child(0).error(reads[1].id, 'not_found', 'repository not found');
    await expect(failed).rejects.toMatchObject({ code: 'not_found' });
    // A head that crossed main's cancel: its frames are dropped, and the
    // process is fine.
    const controller = new AbortController();
    const cancelled = client.read(gen, 'repo_info', { rid: RID }, { signal: controller.signal });
    await settle();
    controller.abort();
    child(0).readReply(reads[2].id, Buffer.alloc(300_000, 0x20));
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    await settle();
    expect(client.serves(gen)).toBe(true);
    expect(client.streamStats(gen)).toMatchObject({ bodies: 0, ringBytes: 0 });
  });

  test("a network call's watchdog: its timeout_ms + 45 s, within what a timer holds", async () => {
    expect(networkWatchdogMs(0)).toBe(45_000);
    expect(networkWatchdogMs(15_000)).toBe(60_000);
    // A u32's worth would overflow Node's timer, which then fires at once.
    expect(networkWatchdogMs(0xffff_ffff)).toBe(MAX_TIMER_MS);
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);

    // timeout_ms outside the add-on's u32 is refused before it is sent.
    const gen = await ready({ connect_seeds: hang, clone: hang });
    for (const bad of [-1, 1.5, '1000', null, 2 ** 32]) {
      await expect(client.connectSeeds(gen, bad)).rejects.toMatchObject({
        code: 'invalid_argument',
      });
      await expect(client.clone(gen, { rid: RID, timeout_ms: bad })).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    }
    expect(child(0).sent('rad.connect_seeds')).toEqual([]);
    expect(child(0).sent('rad.clone')).toEqual([]);
    // The longest is watched for the longest a timer holds, not killed at once.
    client.connectSeeds(gen, 0xffff_ffff).catch(() => {});
    await settle();
    await clock.advance(MAX_TIMER_MS - 1);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
  });

  test('the service owns the deadlines: 15 s of grace, and 20 s for rad.stats', () => {
    expect(HANG_GRACE_MS).toBe(15_000);
    expect(STATS_WATCHDOG_MS).toBe(20_000);
  });

  test('answered calls clear their watchdogs: a running node over an hour', async () => {
    const gen = await ready();
    await expect(client.identity(gen, { ephemeral: true })).resolves.toMatchObject({
      ephemeral: true,
    });
    await expect(client.reconcile(gen)).resolves.toMatchObject({ was_dirty: false });
    await expect(client.startNode(gen, 'alice')).resolves.toMatchObject({ alias: 'alice' });
    await expect(client.nodeStats(gen)).resolves.toEqual(statsResult());
    await clock.advance(60 * 60_000);
    expect(child(0).killedWith).toBeUndefined();
    expect(service.children).toHaveLength(1);
    expect(child(0).sent('rad.start')[0].params).toEqual({ alias: 'alice' });
    expect(child(0).sent('rad.identity')[0].context).toEqual({ caller: 'shell' });
  });
});

describe('exit codes and restarts', () => {
  test.each([
    [64, 'usage, the environment included'],
    [74, 'storage, or a filesystem it refuses'],
    [75, 'the gate held by another owner'],
    [77, 'confinement refused'],
  ])('exit %d (%s): failed, and no restart', async (code) => {
    await ready();
    const failed = new Promise((resolve) => client.once('failed', resolve));
    child(0).exit(code);
    await expect(failed).resolves.toBe(`exit code ${code}`);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(1);
    expect(client.state).toBe('failed');
    await expect(client.nodeStats(client.current)).rejects.toMatchObject({
      code: 'radicle_unavailable',
    });
  });

  test('exit 64 from an environment the service refuses: no restart', async () => {
    process.env.RAD_PASSPHRASE = 'x';
    // What a client passing main's environment through would meet.
    service = fakeRadicled();
    client = new ServiceClient({
      service: radicledService(),
      spawn: service.spawn,
      command: 'freedom-radicled',
      args: serveArgs({ home: HOME, lockDir: LOCK_DIR }),
      env: () => ({ ...process.env, HOME: ownHome }),
      log,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const failed = new Promise((resolve) => client.once('failed', resolve));
    client.start().catch(() => {});
    await expect(failed).resolves.toBe('exit code 64');
    // RAD_PASSPHRASE, or whatever else of the kind main's environment holds.
    expect(child(0).refused).not.toBeNull();
    expect(child(0).requests).toHaveLength(1);
    expect(service.children).toHaveLength(1);
  });

  test('exit 70 (node_down, a panic, a unit overrun) is a crash: restarted', async () => {
    await ready();
    child(0).exit(70);
    await settle();
    expect(client.state).toBe('starting');
    await clock.advance(500);
    expect(service.children).toHaveLength(2);
    expect(client.state).toBe('ready');
  });

  test.each([
    [
      'rad.identity',
      'bad_sealed_key',
      (gen) => client.identity(gen, { sealed: { enc: 'e', ciphertext: 'c' } }),
    ],
    ['rad.identity', 'key_file_present', (gen) => client.identity(gen, { ephemeral: true })],
    ['rad.reconcile', 'recovery_failed', (gen) => client.reconcile(gen)],
    ['rad.reconcile', 'deadline', (gen) => client.reconcile(gen)],
    ['rad.start', 'start_failed', (gen) => client.startNode(gen, 'alice')],
  ])('%s answered %s, then exit 0: failed, and no restart', async (method, code, call) => {
    const gen = await ready({
      [method.slice('rad.'.length)]: (m, c) => c.error(m.id, code, 'the step failed'),
    });
    const failed = new Promise((resolve) => client.once('failed', resolve));
    const exits = [];
    client.on('exit', (exit) => exits.push(exit));
    await expect(call(gen)).rejects.toMatchObject({ code, message: 'the step failed' });
    await expect(failed).resolves.toBe('start step failed');
    expect(exits).toEqual([{ code: 0, signal: null, cause: 'start_failed' }]);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(1);
    // The menu's start spawns a fresh process (and the switch's restart).
    await expect(client.start()).resolves.toEqual(HELLO);
    expect(service.children).toHaveLength(2);
  });

  test('exit 0 with no start step refused is a crash: restarted', async () => {
    const gen = await ready();
    // A start step that succeeded doesn't make a later exit 0 an end.
    await client.identity(gen, { ephemeral: true });
    child(0).exit(0);
    await settle();
    await clock.advance(500);
    expect(service.children).toHaveLength(2);
  });

  test("a start step's error, then exit 70: a crash, restarted", async () => {
    const gen = await ready({
      lingerAfterFailedStep: true,
      reconcile: (m, c) => {
        c.error(m.id, 'recovery_failed', 'failed');
        setImmediate(() => c.exit(70));
      },
    });
    await expect(client.reconcile(gen)).rejects.toMatchObject({ code: 'recovery_failed' });
    await settle();
    await clock.advance(500);
    expect(service.children).toHaveLength(2);
  });

  test("after a start step's error main sends nothing more, and kills a process that lingers at 10 s", async () => {
    const gen = await ready({
      lingerAfterFailedStep: true,
      start: (m, c) => c.error(m.id, 'start_failed', 'failed'),
    });
    await expect(client.startNode(gen, 'alice')).rejects.toMatchObject({ code: 'start_failed' });
    await settle();
    expect(child(0).stdinClosed).toBe(true);
    await expect(client.nodeStats(gen)).rejects.toMatchObject({ code: 'radicle_unavailable' });
    await clock.advance(SHUTDOWN_GRACE_MS - 1);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
  });

  test('stop: rad.shutdown and stdin closed, then a kill at 10 s', async () => {
    await ready({ shutdown: hang });
    const stopped = client.stop();
    await settle();
    expect(child(0).sent('rad.shutdown')).toHaveLength(1);
    expect(child(0).stdinClosed).toBe(true);
    await clock.advance(SHUTDOWN_GRACE_MS - 1);
    expect(child(0).killedWith).toBeUndefined();
    await clock.advance(1);
    expect(child(0).killedWith).toBe('SIGKILL');
    await stopped;
    expect(client.state).toBe('stopped');
    expect(SHUTDOWN_GRACE_MS).toBe(10_000);
  });

  test('stop: a service that exits 0 on rad.shutdown is stopped, with no restart', async () => {
    await ready();
    await client.stop();
    await clock.advance(60_000);
    expect(client.state).toBe('stopped');
    expect(service.children).toHaveLength(1);
    expect(child(0).killedWith).toBeUndefined();
  });
});
