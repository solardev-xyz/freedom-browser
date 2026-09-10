jest.mock('../networks/chain-data-router', () => ({ request: jest.fn() }));
jest.mock('../token-registry', () => ({ getTokens: () => ({ '1:native': { chainId: 1, address: null, symbol: 'ETH', decimals: 18 } }) }));
jest.mock('../networks/network-registry', () => ({ isChainAvailable: () => true }));
jest.mock('./balance-cache', () => ({ getBalancesFromCache: jest.fn(), setCachedBalances: jest.fn(), clearCache: jest.fn() }));
const chainData = require('../networks/chain-data-router');
const balances = require('./balance-service');
const cache = require('./balance-cache');

beforeEach(() => { jest.clearAllMocks(); balances.clearBalanceCache(); });

test('coalesces overlapping foreground, forced, and background refreshes for the same address', async () => {
  let finish;
  chainData.request.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  cache.getBalancesFromCache.mockReturnValue({ lastUpdated: 'previous' });
  const first = balances.getAllBalances('0xabc');
  balances.clearBalanceCache('0xabc');
  const second = balances.getAllBalances('0xABC');
  await balances.getBalancesWithCache('0xabc');
  expect(first).toBe(second);
  expect(chainData.request).toHaveBeenCalledTimes(1);
  finish({ result: '0x1' });
  await expect(first).resolves.toMatchObject({ '1:native': { raw: '1' } });
  expect(cache.setCachedBalances).toHaveBeenCalledTimes(1);
});

test('different addresses remain independent and subsequent refresh can run', async () => {
  chainData.request.mockResolvedValue({ result: '0x2' });
  await Promise.all([balances.getAllBalances('0xabc'), balances.getAllBalances('0xdef')]);
  expect(chainData.request).toHaveBeenCalledTimes(2);
  balances.clearBalanceCache('0xabc');
  await balances.getAllBalances('0xabc');
  expect(chainData.request).toHaveBeenCalledTimes(3);
});
