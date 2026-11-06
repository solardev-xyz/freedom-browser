/**
 * The app's core client speaks protocol 2 (freedom-core design 0009, step
 * 6), the only one the pinned core (0.11.0) takes, so `shell.dweb_get` is
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
jest.mock('./naming', () => ({
  attachNaming: jest.fn(() => ({ running: () => false })),
  detachNaming: jest.fn(),
}));
jest.mock('./chain', () => ({ attachChain: jest.fn(), detachChain: jest.fn() }));

const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('./core-client');
const { DwebShell } = require('./dweb-shell');
const { DwebVerifier, dwebVerifier } = require('./dweb-verify');
const core = require('./core-process');

const HELLO = {
  protocol: PROTOCOL_VERSION_STREAMS,
  core_version: '0.11.0',
  capabilities: ['streams', 'fragments'],
  node_recovery: null,
};

afterEach(() => jest.restoreAllMocks());

test('the app speaks protocol 2 to the core, and the dweb shell and verifier attach', async () => {
  const start = jest.spyOn(CoreClient.prototype, 'start').mockResolvedValue(HELLO);
  const stop = jest.spyOn(CoreClient.prototype, 'stop').mockResolvedValue();
  const handle = jest.spyOn(CoreClient.prototype, 'handle');

  const client = await core.startCore();
  expect(client).toBeInstanceOf(CoreClient);
  expect(client.protocol).toBe(PROTOCOL_VERSION_STREAMS);
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

  await core.stopCore();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(core.getDwebShell()).toBeNull();
  expect(dwebVerifier()).toBeNull();
});
