jest.mock('../core/chain', () => ({ chainDriver: jest.fn(() => null) }));

const chain = require('../core/chain');
const chainData = require('./chain-data');
const router = require('./chain-data-router');
const { UNAVAILABLE } = require('../core/chain-driver');

describe("chain data for main's callers", () => {
  test("its read methods are the router's", () => {
    for (const method of [...chainData.READ_METHODS, ...chainData.SINGLE_NODE_METHODS]) {
      expect(router.isReadMethod(method)).toBe(true);
      expect(chainData.isReadMethod(method)).toBe(true);
    }
    for (const method of ['eth_sendRawTransaction', 'eth_accounts', 'eth_sign', undefined, 5]) {
      expect(chainData.isReadMethod(method)).toBe(router.isReadMethod(method));
    }
    expect(chainData.isReadMethod('eth_sendRawTransaction')).toBe(false);
  });

  test("calls go to the core's drivers, with the router's signatures", async () => {
    const driver = {
      request: jest.fn(async () => ({ result: '0x1', source: 'quorum', verified: true })),
      feeQuote: jest.fn(async () => ({ type: 'legacy' })),
      broadcast: jest.fn(async () => ({ result: '0xhash', source: 'direct' })),
    };
    chain.chainDriver.mockReturnValue(driver);
    const signal = new AbortController().signal;
    await chainData.request(1, 'eth_call', [{}], { includeTrust: true, signal });
    await chainData.request(1, 'eth_blockNumber');
    await chainData.getFeeQuote(100);
    await chainData.broadcastRawTransaction(100, '0xraw', { signal });
    expect(driver.request.mock.calls).toEqual([
      [1, 'eth_call', [{}], { includeTrust: true, signal }],
      [1, 'eth_blockNumber', [], {}],
    ]);
    expect(driver.feeQuote).toHaveBeenCalledWith(100);
    expect(driver.broadcast).toHaveBeenCalledWith(100, '0xraw', { signal });
  });

  test("another method is refused here, with the router's text, before the core is asked", async () => {
    const driver = { request: jest.fn() };
    chain.chainDriver.mockReturnValue(driver);
    await expect(chainData.request(1, 'eth_sendRawTransaction', ['0x'])).rejects.toThrow(
      'Unsupported read method: eth_sendRawTransaction'
    );
    expect(driver.request).not.toHaveBeenCalled();
  });

  test('without the core, calls fail as the drivers do; a broadcast as not sent', async () => {
    chain.chainDriver.mockReturnValue(null);
    await expect(chainData.request(1, 'eth_blockNumber')).rejects.toThrow(UNAVAILABLE);
    await expect(chainData.getFeeQuote(1)).rejects.toThrow(UNAVAILABLE);
    await expect(chainData.broadcastRawTransaction(1, '0xraw')).rejects.toMatchObject({
      message: UNAVAILABLE,
      outcome: 'not_sent',
    });
  });
});

// Review of #698 (parity): a dApp's call object reaches main over IPC with
// native BigInt quantities (structured clone keeps them), and the router
// sent them as hex.
test("a call object's BigInt quantities go to the core as the router's hex", async () => {
  const { ChainDriver } = require('../core/chain-driver');
  const { BroadcastRecords } = require('../core/chain-broadcasts');
  const { JsonParams } = require('../core/core-client');
  const gen = { id: 'process' };
  const sent = [];
  const client = {
    whenReady: async () => ({}),
    serves: (of) => of === gen,
    requestTo: async (_gen, method, params) => {
      expect(params).toBeInstanceOf(JsonParams);
      sent.push(JSON.parse(params.json));
      return {
        result: '0x10',
        source: 'direct',
        verified: false,
        undefined_keys: [],
        generation: 1,
      };
    },
  };
  const config = {
    core: { gen },
    whenServing: async () => gen,
    idle: () => true,
    overtaken: () => false,
    endpointUrl: () => undefined,
  };
  chain.chainDriver.mockReturnValue(
    new ChainDriver({ client, config, broadcasts: new BroadcastRecords() })
  );
  const to = '0x1111111111111111111111111111111111111111';
  expect(
    await chainData.request(1, 'eth_call', [{ to, value: 3n, gas: 21000n }, 'latest'])
  ).toEqual({ result: '0x10', source: 'direct', verified: false });
  expect(sent[0].params).toEqual([{ to, value: '0x3', gas: '0x5208' }, 'latest']);
});
