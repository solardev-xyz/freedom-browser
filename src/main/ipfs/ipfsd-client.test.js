/**
 * The freedom-ipfsd client's configuration (freedom-core design 0007,
 * "Spawn" and "Methods"): where the binary is, the persistent process's
 * arguments, the handshake and what it accepts, and the shared client's
 * settings for the service. The supervision itself is ServiceClient's,
 * and the node's use of it is freedom-ipfsd-node.test.js's.
 */

const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });

const { app } = require('electron');
const {
  IpfsdClient,
  ephemeralArgs,
  getIpfsdBinaryPath,
  ipfsdService,
  persistentArgs,
  validHello,
  HANG_GRACE_MS,
  SHUTDOWN_GRACE_MS,
  START_DEADLINE_MS,
  STOP_DEADLINE_MS,
  STATS_WATCHDOG_MS,
  confinementLog,
  validConfinement,
} = require('./ipfsd-client');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const originalPath = process.env.FREEDOM_IPFSD_PATH;

afterEach(() => {
  app.isPackaged = false;
  Object.defineProperty(process, 'platform', originalPlatform);
  Object.defineProperty(process, 'arch', originalArch);
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else delete process.resourcesPath;
  if (originalPath === undefined) delete process.env.FREEDOM_IPFSD_PATH;
  else process.env.FREEDOM_IPFSD_PATH = originalPath;
});

const DIRECT = { mode: 'direct' };
const SOCKS5 = { mode: 'socks5', ip: '127.0.0.1', port: 9150 };
// What freedom-core design 0010 has the service report.
const CONFINEMENT = {
  mechanism: 'landlock-4+seccomp',
  files: 'enforced',
  exec: 'enforced',
  ipc: 'partial',
  network: 'none',
  gaps: ['signals'],
  reasons: {},
  resolution: 'system',
};
const HELLO = {
  protocol: 1,
  service_version: '0.1.0',
  freedom_ipfs: { version: '0.4.6', git_commit: '0bb3e995a9f3da7d2df30939115cfee9b21bd212' },
  kind: 'persistent',
  network: DIRECT,
  confinement: CONFINEMENT,
};

test.each([
  ['darwin', 'x64', 'mac', 'freedom-ipfsd'],
  ['darwin', 'arm64', 'mac', 'freedom-ipfsd'],
  ['linux', 'x64', 'linux', 'freedom-ipfsd'],
  ['linux', 'arm64', 'linux', 'freedom-ipfsd'],
  ['win32', 'x64', 'win', 'freedom-ipfsd.exe'],
  ['win32', 'arm64', 'win', 'freedom-ipfsd.exe'],
])('resolves dev and packaged paths for %s-%s', (platform, arch, os, binary) => {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  Object.defineProperty(process, 'resourcesPath', {
    value: path.join('packaged', 'resources'),
    configurable: true,
  });
  delete process.env.FREEDOM_IPFSD_PATH;
  expect(getIpfsdBinaryPath()).toBe(
    path.join(__dirname, '../../..', 'freedom-ipfsd-bin', `${os}-${arch}`, binary)
  );
  // The override is honoured only while the app isn't packaged.
  process.env.FREEDOM_IPFSD_PATH = path.join('custom', binary);
  expect(getIpfsdBinaryPath()).toBe(process.env.FREEDOM_IPFSD_PATH);
  app.isPackaged = true;
  expect(getIpfsdBinaryPath()).toBe(path.join(process.resourcesPath, 'freedom-ipfsd', binary));
});

test("the persistent process: serve, the profile's data directory, the lock directory, the policy and main's PID", () => {
  expect(
    persistentArgs({ dataDir: 'data', lockDir: 'locks', network: DIRECT, parentPid: 42 })
  ).toEqual([
    'serve',
    '--data-dir',
    'data',
    '--lock-dir',
    'locks',
    '--network',
    'direct',
    '--parent-pid',
    '42',
  ]);
  expect(persistentArgs({ dataDir: 'd', lockDir: 'l', network: DIRECT }).at(-1)).toBe(
    String(process.pid)
  );
  // An IPv6 proxy goes in brackets (freedom-core design 0007, "Spawn").
  expect(
    persistentArgs({
      dataDir: 'd',
      lockDir: 'l',
      network: { mode: 'socks5', ip: '::1', port: 9150 },
    }).slice(5, 7)
  ).toEqual(['--network', 'socks5:[::1]:9150']);
  expect(() => persistentArgs({ dataDir: 'd', lockDir: 'l', network: null })).toThrow(
    'no network policy'
  );
});

test("the ephemeral process: serve --ephemeral, the policy and main's PID, with no data or lock directory", () => {
  expect(ephemeralArgs({ network: SOCKS5, parentPid: 42 })).toEqual([
    'serve',
    '--ephemeral',
    '--network',
    'socks5:127.0.0.1:9150',
    '--parent-pid',
    '42',
  ]);
  expect(ephemeralArgs({ network: DIRECT }).at(-1)).toBe(String(process.pid));
});

test('the client spawns under the policy it holds, set only while no process runs', async () => {
  const argsFor = (network) => ephemeralArgs({ network, parentPid: 1 });
  const client = new IpfsdClient({ kind: 'ephemeral', spawn: jest.fn(), command: 'x', argsFor });
  // No policy, no process: start refuses, and nothing is spawned.
  await expect(client.start()).rejects.toMatchObject({ code: 'ipfs_unavailable' });
  client.setNetwork(SOCKS5);
  expect(client.network).toEqual(SOCKS5);
  expect(client.args).toEqual(argsFor(SOCKS5));
  client.current = {};
  expect(() => client.setNetwork(DIRECT)).toThrow('a freedom-ipfsd process is running');
  expect(client.network).toEqual(SOCKS5);
});

test("ipfs.start and ipfs.stop: their params, their hang watchdogs, and a start's fence", () => {
  const client = new IpfsdClient({
    kind: 'ephemeral',
    spawn: jest.fn(),
    command: 'x',
    argsFor: () => [],
    network: DIRECT,
  });
  const requestTo = jest.spyOn(client, 'requestTo').mockResolvedValue({});
  const gen = {};
  const fence = () => true;
  client.startInstance(gen, { instance: 'e-1' }, { fence });
  client.stopInstance(gen, 'e-1');
  expect(requestTo.mock.calls).toEqual([
    [
      gen,
      'ipfs.start',
      { instance: 'e-1' },
      { caller: 'shell' },
      { watchdogMs: START_DEADLINE_MS + HANG_GRACE_MS, fence },
    ],
    [
      gen,
      'ipfs.stop',
      { instance: 'e-1' },
      { caller: 'shell' },
      { watchdogMs: STOP_DEADLINE_MS + HANG_GRACE_MS },
    ],
  ]);
  // The service's own bounds (0007, Methods): 10 s to start, 5 s to stop.
  expect(START_DEADLINE_MS).toBe(10_000);
  expect(STOP_DEADLINE_MS).toBe(5_000);
});

test('the handshake asks for stream frames, and grants them', () => {
  const service = ipfsdService('persistent', { network: DIRECT });
  expect(service.helloMethod).toBe('ipfs.hello');
  expect(service.helloParams({ shellVersion: '0.9.0' })).toEqual({
    protocol: 1,
    shell_version: '0.9.0',
    frames: ['stream'],
  });
  expect(service.streams(HELLO)).toBe(true);
  expect(service.fragments(HELLO)).toBe(false);
  expect(service.shutdownMethod).toBe('ipfs.shutdown');
  // 0007: main kills 5 s after ipfs.shutdown; 512 outstanding requests.
  expect(service.shutdownGraceMs).toBe(5_000);
  expect(SHUTDOWN_GRACE_MS).toBe(5_000);
  expect(service.maxPending).toBe(512);
  // The hang watchdogs: a head's headers_ms + 15 s, a stats call's 20 s.
  expect(HANG_GRACE_MS).toBe(15_000);
  expect(STATS_WATCHDOG_MS).toBe(20_000);
});

test("a valid hello: its public part; the wrong process's or policy's, or a malformed one, is refused", () => {
  expect(validHello(HELLO, 'persistent', DIRECT)).toEqual(HELLO);
  expect(ipfsdService('persistent', { network: DIRECT }).validHello(HELLO)).toEqual(HELLO);
  expect(
    validHello({ ...HELLO, freedom_ipfs: { version: '0.4.6' }, extra: 1 }, 'persistent', DIRECT)
  ).toEqual({ ...HELLO, freedom_ipfs: { version: '0.4.6', git_commit: null } });
  // The policy the service reports back, read as it reads it: an
  // IPv4-mapped address is the IPv4 address it maps (design 0010).
  expect(
    validHello({ ...HELLO, network: SOCKS5 }, 'persistent', {
      mode: 'socks5',
      ip: '::ffff:127.0.0.1',
      port: 9150,
    })
  ).toMatchObject({ network: { mode: 'socks5', ip: '::ffff:127.0.0.1', port: 9150 } });

  for (const refused of [
    null,
    [],
    { ...HELLO, protocol: 2 },
    { ...HELLO, kind: 'ephemeral' },
    { ...HELLO, service_version: '' },
    { ...HELLO, service_version: 'a b' },
    { ...HELLO, freedom_ipfs: null },
    { ...HELLO, freedom_ipfs: { version: 7 } },
    { ...HELLO, freedom_ipfs: { version: '0.4.6', git_commit: 'not hex' } },
    // Another policy than main passed, or none.
    { ...HELLO, network: SOCKS5 },
    { ...HELLO, network: undefined },
    { ...HELLO, network: { mode: 'direct', extra: 1 } },
    // No confinement report, or a malformed one.
    { ...HELLO, confinement: undefined },
    { ...HELLO, confinement: { ...CONFINEMENT, files: 'mostly' } },
    { ...HELLO, confinement: { ...CONFINEMENT, mechanism: 'Landlock 4' } },
    { ...HELLO, confinement: { ...CONFINEMENT, gaps: 'signals' } },
  ]) {
    expect(validHello(refused, 'persistent', DIRECT)).toBeNull();
  }
  expect(
    validHello({ ...HELLO, network: SOCKS5 }, 'persistent', { ...SOCKS5, port: 9050 })
  ).toBeNull();
  expect(validHello({ ...HELLO, kind: 'ephemeral' }, 'ephemeral', DIRECT)).toMatchObject({
    kind: 'ephemeral',
  });
  expect(() => ipfsdService('other', { network: DIRECT })).toThrow('unknown freedom-ipfsd process');
});

test('the confinement report: its public part, and what a log line carries', () => {
  const report = {
    ...CONFINEMENT,
    reasons: { network: 'TCP rules need Landlock ABI 4', other: 'dropped' },
    extra: 1,
  };
  expect(validConfinement(report)).toEqual({
    ...CONFINEMENT,
    reasons: { network: 'TCP rules need Landlock ABI 4' },
  });
  // Off Linux in direct mode, no resolution.
  expect(validConfinement({ ...CONFINEMENT, resolution: undefined })).toMatchObject({
    resolution: null,
  });
  for (const refused of [
    null,
    { ...CONFINEMENT, resolution: 'dns' },
    { ...CONFINEMENT, reasons: { files: 7 } },
    { ...CONFINEMENT, gaps: Array(17).fill('signals') },
  ]) {
    expect(validConfinement(refused)).toBeNull();
  }
  expect(confinementLog({ ...CONFINEMENT, reasons: { files: 'a path' } })).toEqual({
    mechanism: 'landlock-4+seccomp',
    files: 'enforced',
    exec: 'enforced',
    ipc: 'partial',
    network: 'none',
    gaps: ['signals'],
    resolution: 'system',
  });
});

test("outside Electron (a script), `require('electron')` has no app: the dev path, and the override", () => {
  jest.isolateModules(() => {
    // What the electron package exports to plain Node: its binary's path.
    // (Inside isolateModules, a doMock doesn't override this file's
    // jest.mock once electron is loaded: the registry starts empty here.)
    jest.resetModules();
    jest.doMock('electron', () => '/path/to/electron', { virtual: true });
    expect(require('electron')).toBe('/path/to/electron');
    const { getIpfsdBinaryPath: resolve } = require('./ipfsd-client');
    delete process.env.FREEDOM_IPFSD_PATH;
    expect(resolve()).toContain(
      path.join(
        'freedom-ipfsd-bin',
        `${{ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`
      )
    );
    process.env.FREEDOM_IPFSD_PATH = path.join('custom', 'freedom-ipfsd');
    expect(resolve()).toBe(process.env.FREEDOM_IPFSD_PATH);
  });
});
