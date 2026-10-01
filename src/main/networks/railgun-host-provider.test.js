const { JsonRpcProvider, Network } = require('ethers');
const { createRailgunHostProvider, lockRailgunHttp } = require('./railgun-host-provider');
// Exercise the actual installed ethers dispatch/batching. Qualification against
// Railgun's pinned PollingJsonRpcProvider still requires its isolated dependency.
class TestPollingProvider extends JsonRpcProvider {
  constructor(url, chainId, _interval, count) {
    super(url, chainId, { staticNetwork: Network.from(chainId), batchMaxCount: count });
  }
}
let controller, request, bridge;
const rpc = (method, params = [], id = 1) => ({ jsonrpc: '2.0', method, params, id });
beforeEach(() => {
  controller = new AbortController();
  request = jest.fn(async ({ method }) => (method === 'eth_chainId' ? '0xaa36a7' : '0x2a'));
  bridge = createRailgunHostProvider({
    PollingJsonRpcProvider: TestPollingProvider,
    provider: { request, signal: controller.signal },
    chainId: 11155111,
    signal: controller.signal,
  });
});
afterEach(() => bridge.destroy());
test('ethers reads pass through host capabilities without a URL connection', async () => {
  expect(await bridge.getBlockNumber()).toBe(42);
  expect(request).toHaveBeenCalledWith(
    { method: 'eth_blockNumber', params: [] },
    { signal: controller.signal }
  );
  expect(() => bridge._getConnection()).toThrow();
  const results = await bridge._send([rpc('eth_chainId'), rpc('eth_blockNumber', [], 2)]);
  expect(results.map((r) => r.result)).toEqual(['0xaa36a7', '0x2a']);
});
test.each([
  rpc('eth_sendRawTransaction', ['0x1234']),
  [rpc('eth_blockNumber'), rpc('eth_sendRawTransaction', ['0x1234'], 2)],
  [rpc('eth_blockNumber'), rpc('eth_chainId')],
  [],
  rpc('wallet_switchEthereumChain'),
  rpc('eth_subscribe'),
  { ...rpc('eth_call'), params: {} },
  { ...rpc('eth_call'), extra: 'not allowed' },
  rpc('eth_call', ['x'.repeat(65536)]),
  Array.from({ length: 33 }, (_, i) => rpc('eth_blockNumber', [], i)),
])('refuses a malformed or overbroad batch before any handoff: %#', async (payload) => {
  await expect(bridge._send(payload)).rejects.toMatchObject({ code: 'RAILGUN_RPC_REFUSED' });
  expect(request).not.toHaveBeenCalled();
});
test('snapshots inputs and returned host objects across asynchronous requests', async () => {
  let finish;
  request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const payload = [rpc('eth_blockNumber'), rpc('eth_call', [{ to: 'original' }], 2)];
  const pending = bridge._send(payload);
  payload[1].params[0].to = 'changed';
  const result = { number: '0x1' };
  finish(result);
  const results = await pending;
  result.number = 'changed';
  expect(results[0].result).toEqual({ number: '0x1' });
  expect(request.mock.calls[1][0].params).toEqual([{ to: 'original' }]);
});
test('revocation rejects late responses and prevents later requests in the batch', async () => {
  let finish;
  request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const pending = bridge._send([rpc('eth_blockNumber'), rpc('eth_chainId', [], 2)]);
  controller.abort();
  finish('0x2a');
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RPC_REVOKED' });
  expect(request).toHaveBeenCalledTimes(1);
  await expect(bridge._send(rpc('eth_blockNumber'))).rejects.toMatchObject({
    code: 'RAILGUN_RPC_REVOKED',
  });
});
test('rejects a different chain and sanitizes host errors', async () => {
  request.mockResolvedValueOnce('0x1');
  await expect(bridge._send(rpc('eth_chainId'))).rejects.toMatchObject({
    code: 'RAILGUN_RPC_REFUSED',
  });
  request.mockRejectedValueOnce(new Error('sensitive endpoint and address'));
  await expect(bridge._send(rpc('eth_blockNumber'))).rejects.toThrow(
    'Railgun host RPC unavailable'
  );
});

test('denies alternate ethers URL helpers and keeps CCIP read disabled', async () => {
  expect(bridge.disableCcipRead).toBe(true);
  for (const method of ['getFeeData', 'resolveName', 'lookupAddress', 'getResolver', 'getAvatar'])
    await expect(bridge[method]('example.eth')).rejects.toMatchObject({
      code: 'RAILGUN_RPC_REFUSED',
    });
  expect(request).not.toHaveBeenCalled();
});
test('manual closure refuses direct and late requests too', async () => {
  let finish;
  request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const pending = bridge._send(rpc('eth_blockNumber'));
  bridge.destroy();
  finish('0x2a');
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RPC_REVOKED' });
  await expect(bridge._send(rpc('eth_blockNumber'))).rejects.toMatchObject({
    code: 'RAILGUN_RPC_REVOKED',
  });
});
test('requires matching lifetime and the qualified chain', () => {
  for (const config of [
    { chainId: 1, provider: { request, signal: controller.signal } },
    { chainId: 11155111, provider: { request, signal: new AbortController().signal } },
  ])
    expect(() =>
      createRailgunHostProvider({
        PollingJsonRpcProvider: TestPollingProvider,
        signal: controller.signal,
        ...config,
      })
    ).toThrow();
});
test('installs and locks direct HTTP denial on the supplied runtime instance', async () => {
  const FetchRequest = { registerGetUrl: jest.fn(), lockConfig: jest.fn() };
  lockRailgunHttp(FetchRequest);
  lockRailgunHttp(FetchRequest);
  expect(FetchRequest.registerGetUrl).toHaveBeenCalledTimes(1);
  expect(FetchRequest.lockConfig).toHaveBeenCalledTimes(1);
  await expect(FetchRequest.registerGetUrl.mock.calls[0][0]()).rejects.toMatchObject({
    code: 'RAILGUN_RPC_REFUSED',
  });
});

test('real ethers HTTP configuration is irreversibly denied in a separate runtime', () => {
  const { execFileSync } = require('child_process');
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('assert');
    const { lockRailgunHttp } = require(process.argv[1]);
    const { FetchRequest } = require(process.argv[2]);
    lockRailgunHttp(FetchRequest);
    assert.throws(() => FetchRequest.registerGetUrl(async () => ({})));
    new FetchRequest('https://railgun-host.invalid').send().then(
      () => { process.exitCode = 1; },
      () => { process.stdout.write('denied'); }
    );
  `,
      require.resolve('./railgun-host-provider'),
      require.resolve('ethers'),
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  expect(output).toBe('denied');
});
