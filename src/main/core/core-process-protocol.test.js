/**
 * The app's core client speaks protocol 2 (freedom-core design 0009, step
 * 6), the only one the pinned core (0.16.0) takes, so `shell.dweb_get` is
 * registered and the `dweb.verify` verifier attaches.
 * Every 0009 feature in main waits for that verifier: the captured
 * backends' `verify`, `unsupported` and `strict`, the error page, and
 * `dweb.forget` as a private partition closes. The client here is the real
 * CoreClient; only its process is stubbed.
 */

jest.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.0.0-test' } }), {
  virtual: true,
});
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../profile-paths', () => ({ getIdentityDataDir: () => '/nonexistent/identity' }));
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

const HELLO = {
  protocol: PROTOCOL_VERSION_STREAMS,
  core_version: '0.16.0',
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
  // Radicle's (APB-3).
  const root = path.join(os.tmpdir(), 'freedom-profile');
  expect(client.grantRoot).toBe(root);
  const params = client.service.helloParams(client);
  expect(params.grant_root).toBe(root);
  expect([...params.grant_moved].sort()).toEqual(['dapp', 'radicle', 'swarm']);
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

  await core.stopCore();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(core.getDwebShell()).toBeNull();
  expect(dwebVerifier()).toBeNull();
});
