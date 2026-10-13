const { CoreClient, ShellError } = require('./core-client');
const { registerNamingShell } = require('./naming-shell');
const { registerNamingVerified } = require('./naming-verified');
const { attachChain, detachChain, chainDriver, chainSettingsChanged } = require('./chain');
const { NOT_SENT } = require('./chain-shell');
const { ChainConfig } = require('./chain-config');
const { ChainDriver } = require('./chain-driver');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({
  netGatewayFetch: jest.fn(),
  isOnionHostname: () => false,
}));
// Readiness and its transitions only: an unconfigured main runs no
// operation.
jest.mock('../myotis/myotis-manager', () => ({
  NETWORKS: new Map([[1, { chainId: 1, displayName: 'Ethereum' }]]),
  isReady: jest.fn(() => false),
  onAvailabilityTransition: jest.fn(),
}));
const myotis = require('../myotis/myotis-manager');

afterEach(() => detachChain());

/** A client with naming's executors, then chain data's, attached. */
function attached() {
  const client = new CoreClient({ spawn: jest.fn(), command: 'freedom-cored', args: [] });
  const config = {
    endpointUrl: () => 'https://a.rpc.example',
    generations: { ens: 1, tezos: 1, lifecycle: 1 },
  };
  registerNamingShell(client, config);
  const { running } = registerNamingVerified(client, config, { adapters: {} });
  const attachment = attachChain(client, { running });
  const call = (method, params) =>
    Promise.resolve().then(() =>
      client.handlerFor(method, params)(params, {
        signal: new AbortController().signal,
        charge: () => true,
      })
    );
  return { client, call, attachment };
}

test("chain data's executors take the chain thread's requests, and leave naming's", async () => {
  const { call } = attached();
  // Naming's, by their `generations`: refused as stale by naming's own.
  const naming = call('shell.rpc', { endpoint: 'e1', body: '{}', generations: { ens: 0 } });
  await expect(naming).rejects.toBeInstanceOf(ShellError);
  await expect(naming).rejects.toMatchObject({ code: 'stale_generation' });
  await expect(
    call('shell.verified', { myotis: 'call', generations: { lifecycle: 0 } })
  ).rejects.toMatchObject({ code: 'stale_generation' });
  // The chain thread's, by their `generation`.
  expect(
    await call('shell.rpc', {
      endpoint: 'e1',
      body: '{}',
      policy: 'plain',
      max_bytes: 1024,
      generation: 1,
      deadline_ms: 1000,
    })
  ).toEqual(NOT_SENT);
});

test('until a chain is configured, main performs nothing for the chain thread: not_sent', async () => {
  const { call } = attached();
  const generation = Number.MAX_SAFE_INTEGER;
  expect(
    await call('shell.blockscout', {
      endpoint: 'b1',
      query: '/v2/x',
      max_bytes: 1024,
      generation,
      deadline_ms: 1000,
    })
  ).toEqual(NOT_SENT);
  for (const op of [
    { myotis: 'broadcast', raw: '0x00' },
    { myotis: 'fee' },
    { colibri: 'request', method: 'eth_call', params: [], deadline_ms: 1000 },
  ]) {
    expect(await call('shell.verified', { ...op, chain_id: 1, generation })).toEqual(NOT_SENT);
  }
});

test('attached, the drivers serve calls; detached, there are none', () => {
  const { config, driver } = attached().attachment;
  expect(config).toBeInstanceOf(ChainConfig);
  expect(driver).toBeInstanceOf(ChainDriver);
  expect(chainDriver()).toBe(driver);
  detachChain();
  expect(chainDriver()).toBeNull();
  // Nothing to configure any more.
  expect(() => chainSettingsChanged()).not.toThrow();
});

test('a registry change and a Myotis transition reach the configuration', () => {
  const { config } = attached().attachment;
  const configure = jest.spyOn(config, 'configure').mockResolvedValue();
  const availability = jest.spyOn(config, 'availability').mockResolvedValue();
  chainSettingsChanged();
  expect(configure).toHaveBeenCalledTimes(1);
  const [onTransition] = myotis.onAvailabilityTransition.mock.calls.at(-1);
  onTransition({ chainId: 100, ready: true });
  expect(availability).toHaveBeenCalledTimes(1);
});
