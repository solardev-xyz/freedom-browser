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
  getIpfsdBinaryPath,
  ipfsdService,
  persistentArgs,
  validHello,
  HANG_GRACE_MS,
  SHUTDOWN_GRACE_MS,
  STATS_WATCHDOG_MS,
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

const HELLO = {
  protocol: 1,
  service_version: '0.1.0',
  freedom_ipfs: { version: '0.4.6', git_commit: '0bb3e995a9f3da7d2df30939115cfee9b21bd212' },
  kind: 'persistent',
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

test("the persistent process: serve, the profile's data directory, the lock directory and main's PID", () => {
  expect(persistentArgs({ dataDir: 'data', lockDir: 'locks', parentPid: 42 })).toEqual([
    'serve',
    '--data-dir',
    'data',
    '--lock-dir',
    'locks',
    '--parent-pid',
    '42',
  ]);
  expect(persistentArgs({ dataDir: 'd', lockDir: 'l' }).at(-1)).toBe(String(process.pid));
});

test('the handshake asks for stream frames, and grants them', () => {
  const service = ipfsdService('persistent');
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

test("a valid hello: its public part; the wrong process's or a malformed one is refused", () => {
  expect(validHello(HELLO, 'persistent')).toEqual(HELLO);
  expect(ipfsdService('persistent').validHello(HELLO)).toEqual(HELLO);
  expect(
    validHello({ ...HELLO, freedom_ipfs: { version: '0.4.6' }, extra: 1 }, 'persistent')
  ).toEqual({ ...HELLO, freedom_ipfs: { version: '0.4.6', git_commit: null } });

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
  ]) {
    expect(validHello(refused, 'persistent')).toBeNull();
  }
  expect(validHello({ ...HELLO, kind: 'ephemeral' }, 'ephemeral')).toMatchObject({
    kind: 'ephemeral',
  });
  expect(() => ipfsdService('other')).toThrow('unknown freedom-ipfsd process');
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
