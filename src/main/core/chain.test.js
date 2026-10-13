const { CoreClient, ShellError } = require('./core-client');
const { registerNamingShell } = require('./naming-shell');
const { registerNamingVerified } = require('./naming-verified');
const { attachChain } = require('./chain');
const { NOT_SENT } = require('./chain-shell');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({
  netGatewayFetch: jest.fn(),
  isOnionHostname: () => false,
}));
jest.mock('../myotis/myotis-manager', () => {
  throw new Error('an unconfigured main runs no operation');
});

/** A client with naming's executors, then chain data's, attached. */
function attached() {
  const client = new CoreClient({ spawn: jest.fn(), command: 'freedom-cored', args: [] });
  const config = {
    endpointUrl: () => 'https://a.rpc.example',
    generations: { ens: 1, tezos: 1, lifecycle: 1 },
  };
  registerNamingShell(client, config);
  const { running } = registerNamingVerified(client, config, { adapters: {} });
  attachChain(client, { running });
  const call = (method, params) =>
    Promise.resolve().then(() =>
      client.handlerFor(method, params)(params, {
        signal: new AbortController().signal,
        charge: () => true,
      })
    );
  return { client, call };
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
