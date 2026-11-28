/**
 * The app's core client speaks protocol 2 (freedom-core design 0009, step
 * 6), the only one the pinned core (0.32.0) takes, so `shell.dweb_get` is
 * registered and the `dweb.verify` verifier attaches.
 * Every 0009 feature in main waits for that verifier: the captured
 * backends' `verify`, `unsupported` and `strict`, the error page, and
 * `dweb.forget` as a private partition closes. The client here is the real
 * CoreClient; only its process is stubbed.
 */

// The profile's directory (`userData`), apart from its Freedom root below
// as after 0013's move, so the hello's two paths can be told apart.
jest.mock(
  'electron',
  () => ({
    app: {
      isPackaged: false,
      getVersion: () => '0.0.0-test',
      getPath: (name) => {
        if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`);
        return require('path').join(require('os').tmpdir(), 'freedom-user-data');
      },
    },
  }),
  { virtual: true }
);
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The node roots `nodes.write_identity` names (freedom-core design 0017, C1):
// Ant's data directory, unmade, and the Radicle home, once prepared
// (core-process-radicle.test.js has the preparation's bounds).
jest.mock('../profile-paths', () => ({
  getIdentityDataDir: () => '/nonexistent/identity',
  getAntDataPath: () => require('path').join(require('os').tmpdir(), 'freedom-profile', 'ant-data'),
  prepareRadicleDataDir: jest.fn(async () =>
    require('path').join(require('os').tmpdir(), 'R', '1')
  ),
}));
jest.mock('../service-locks', () => ({ getLockDir: () => '/nonexistent/locks' }));
// The profile's Freedom root, where the permission files are (freedom-root.js).
jest.mock('../freedom-root', () => ({
  getFreedomDataDir: () => require('path').join(require('os').tmpdir(), 'freedom-profile'),
}));
jest.mock('./naming', () => ({
  attachNaming: jest.fn(() => ({ running: () => false })),
  detachNaming: jest.fn(),
}));
jest.mock('./chain', () => ({ attachChain: jest.fn(), detachChain: jest.fn() }));

const os = require('os');
const path = require('path');
const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('./core-client');
const { DwebShell } = require('./dweb-shell');
const { DwebVerifier, dwebVerifier } = require('./dweb-verify');
const core = require('./core-process');
const log = require('../logger');
const { prepareRadicleDataDir } = require('../profile-paths');

const HELLO = {
  protocol: PROTOCOL_VERSION_STREAMS,
  core_version: '0.32.0',
  capabilities: ['streams', 'fragments'],
  node_recovery: null,
};

afterEach(() => jest.restoreAllMocks());

test('the app speaks protocol 2 to the core, and the dweb shell and verifier attach', async () => {
  // startCore() runs once per process: once stopCore() has run, nothing
  // starts the core again, so one test covers the app's client.
  const start = jest.spyOn(CoreClient.prototype, 'start').mockResolvedValue(HELLO);
  const stop = jest.spyOn(CoreClient.prototype, 'stop').mockResolvedValue();
  const handle = jest.spyOn(CoreClient.prototype, 'handle');

  const client = await core.startCore();
  expect(client).toBeInstanceOf(CoreClient);
  expect(client.protocol).toBe(PROTOCOL_VERSION_STREAMS);
  // freedom-core design 0012, "The APR-3 pin": the hello carries grant_root,
  // the directory of the four permission files; grant_moved names the files
  // the core writes from then on: the dApp file (APB-2), Swarm's and
  // Radicle's (APB-3). Design 0013's store_moved names vault-meta.json's
  // store (PRF-6(a)), the intent journal (PRF-6(b2)), the payment history
  // (PRF-6(c)), safe-pending.json's (PRF-6(d)) and the RPC API keys
  // (PRF-6(e)), and the app's client takes an echo of no other.
  const root = path.join(os.tmpdir(), 'freedom-profile');
  expect(client.grantRoot).toBe(root);
  const params = client.service.helloParams(client);
  expect(params.grant_root).toBe(root);
  // Design 0013, PRF-8b-lite: the profile's directory, where the legacy x402
  // receipts are; after the move the core imports a copy of them in the
  // Freedom root (design 0017 C5).
  const userData = path.join(os.tmpdir(), 'freedom-user-data');
  expect(client.userDataDir).toBe(userData);
  expect(params.user_data_dir).toBe(userData);
  expect([...params.grant_moved].sort()).toEqual(['dapp', 'radicle', 'swarm', 'x402']);
  // Design 0017, C1: the grant's arguments, the hello's own paths, and the
  // node roots, the directories nodes.write_identity names: the Radicle
  // home's once the spawn's wait found it prepared.
  const args = (radicle) => [
    'serve',
    '--data-dir',
    '/nonexistent/identity',
    '--lock-dir',
    '/nonexistent/locks',
    '--parent-pid',
    String(process.pid),
    '--node-root',
    `bee=${path.join(root, 'ant-data')}`,
    ...(radicle ? ['--node-root', `radicle=${path.join(os.tmpdir(), 'R', '1')}`] : []),
    '--grant-root',
    params.grant_root,
    '--user-data-dir',
    params.user_data_dir,
  ];
  expect(client.args).toEqual(args(false));
  expect(params.store_moved).toEqual([
    'vault_meta',
    'intents',
    'payments',
    'safe_pending',
    'rpc_api_keys',
  ]);
  expect(client.service.validHello({ ...HELLO, store_moved: ['history'] })).toBeNull();
  expect(
    client.service.validHello({ ...HELLO, store_moved: ['rpc_api_keys', 'rpc_api_keys'] })
  ).toBeNull();
  expect(
    client.service.validHello({ ...HELLO, store_moved: ['rpc_api_keys'] }).store_moved
  ).toEqual(['rpc_api_keys']);
  expect(
    client.service.validHello({
      ...HELLO,
      store_moved: ['vault_meta', 'intents', 'payments', 'safe_pending', 'rpc_api_keys'],
    }).store_moved
  ).toEqual(['vault_meta', 'intents', 'payments', 'safe_pending', 'rpc_api_keys']);
  expect(start).toHaveBeenCalledTimes(1);
  expect(handle).toHaveBeenCalledWith('shell.dweb_get', expect.any(Function), {
    streams: true,
  });
  const shell = core.getDwebShell();
  expect(shell).toBeInstanceOf(DwebShell);
  const verifier = dwebVerifier();
  expect(verifier).toBeInstanceOf(DwebVerifier);
  expect(verifier.client).toBe(client);
  expect(verifier.shell).toBe(shell);
  // The key store's `shell.keystore` (freedom-core design 0013, cored
  // 0.16.0) has no executor in main until PRF-2: the app's client registers
  // none, so the core's request is answered `unknown_method`
  // (core-client.test.js), which the core reads as no key store.
  expect(handle.mock.calls.map(([method]) => method)).not.toContain('shell.keystore');
  expect(client.handlerFor('shell.keystore', {})).toBeUndefined();

  // Design 0017: each start's confinement is logged from its hello, with a
  // warning naming what isn't enforced.
  const report = {
    mechanism: 'seatbelt',
    files: 'partial',
    exec: 'enforced',
    ipc: 'partial',
    network: 'enforced',
    gaps: ['modes', 'process_args'],
    reasons: { files: 'not logged' },
    resolution: null,
  };
  log.info.mockClear();
  log.warn.mockClear();
  client.emit('ready', { ...HELLO, store_moved: [], confinement: report });
  expect(log.info).toHaveBeenCalledWith('[Core] confinement', {
    core_version: '0.32.0',
    mechanism: 'seatbelt',
    files: 'partial',
    exec: 'enforced',
    ipc: 'partial',
    network: 'enforced',
    gaps: ['modes', 'process_args'],
    resolution: null,
  });
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn).toHaveBeenCalledWith('[Core] confinement not enforced', {
    mechanism: 'seatbelt',
    files: 'partial',
    ipc: 'partial',
    gaps: ['modes', 'process_args'],
  });
  log.warn.mockClear();
  const enforced = { ...report, files: 'enforced', ipc: 'enforced', gaps: [], reasons: {} };
  client.emit('ready', { ...HELLO, store_moved: [], confinement: enforced });
  expect(log.warn).not.toHaveBeenCalled();
  // A core before 0.28.0 (0.27.0, say) reports none.
  client.emit('ready', { ...HELLO, core_version: '0.27.0', store_moved: [], confinement: null });
  expect(log.warn).toHaveBeenCalledWith('[Core] the core reported no confinement', {
    core_version: '0.27.0',
  });

  // Each spawn waits for the Radicle home's preparation, then spawns with
  // its node root.
  expect(prepareRadicleDataDir).not.toHaveBeenCalled();
  const wait = client.deferSpawn();
  expect(prepareRadicleDataDir).toHaveBeenCalledTimes(1);
  await wait;
  expect(client.deferSpawn()).toBeNull();
  expect(client.args).toEqual(args(true));

  await core.stopCore();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(core.getDwebShell()).toBeNull();
  expect(dwebVerifier()).toBeNull();
});
