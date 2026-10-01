jest.mock('../settings-store', () => ({
  loadSettings: jest.fn(() => ({ walletTorBalanceReads: true })),
  isWalletTorExperimentAvailable: jest.fn(() => true),
}));
jest.mock('./privacy-session', () => ({ openPrivacySession: jest.fn() }));
jest.mock('./balance-cache', () => ({
  getPrivateBalances: jest.fn(),
  setPrivateBalances: jest.fn(),
  getBalancesFromCache: jest.fn(),
  setCachedBalances: jest.fn(),
}));
jest.mock('../token-registry', () => ({ getTokens: jest.fn() }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: jest.fn() }));
jest.mock('../networks/network-registry', () => ({ isChainAvailable: () => true }));
jest.mock('../networks/chain-data-router', () => ({ request: jest.fn() }));
const { Interface } = require('ethers');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { openPrivacySession } = require('./privacy-session');
const { getWalletSocksEndpoint } = require('../tor-manager');
const { getTokens } = require('../token-registry');
const settings = require('../settings-store');
const cache = require('./balance-cache');
const chainData = require('../networks/chain-data-router');
const service = require('./balance-service');
const { getPrivateBalances } = require('./private-balance-service');
const a = `0x${'a'.repeat(40)}`,
  b = `0x${'b'.repeat(40)}`;
const abi = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
let scope, tor;

beforeEach(() => {
  jest.clearAllMocks();
  scope = createPrivacyScope({ profileId: 'profile-a', signal: new AbortController().signal });
  openPrivacySession.mockReturnValue(scope);
  settings.isWalletTorExperimentAvailable.mockReturnValue(true);
  tor = new AbortController();
  getWalletSocksEndpoint.mockReturnValue({ signal: tor.signal });
  getTokens.mockReturnValue({
    '11155111:native': { chainId: 11155111, address: null, symbol: 'ETH', decimals: 18 },
    '1:native': { chainId: 1, address: null, symbol: 'ETH', decimals: 18 },
    [`11155111:${b}`]: { chainId: 11155111, address: b, symbol: 'TEST', decimals: 18 },
  });
  cache.getPrivateBalances.mockReturnValue(null);
  chainData.request.mockImplementation(async (_chain, method, params) => ({
    result:
      method === 'eth_getBalance'
        ? '0x1'
        : params[0].data === '0x313ce567'
          ? abi.encodeFunctionResult('decimals', [18])
          : abi.encodeFunctionResult('balanceOf', [2]),
    observedAt: new Date().toISOString(),
    trust: { level: 'unverified' },
    privacy: { mode: 'tor-experimental' },
  }));
});
afterEach(() => {
  scope.close();
  tor.abort();
});

test('native, token and metadata reads share A context, deduplicate normalized A, isolate B and omit other chains', async () => {
  const first = service.getAllBalances(a);
  expect(service.getAllBalances(a.toUpperCase().replace('0X', '0x'))).toBe(first);
  const result = await first;
  expect(result.status).toBe('fresh');
  expect(result['1:native']).toBeUndefined();
  expect(chainData.request).toHaveBeenCalledTimes(3);
  const handles = chainData.request.mock.calls.map((call) => call[3].privacyContext);
  expect(new Set(handles).size).toBe(1);
  expect(getPrivacyContext(handles[0]).subject.principal).toBe(a);
  await service.getAllBalances(b);
  expect(chainData.request.mock.calls[3][3].privacyContext).not.toBe(handles[0]);
  expect(cache.setCachedBalances).not.toHaveBeenCalled();
  expect(cache.getBalancesFromCache).not.toHaveBeenCalled();
});

test('failed refresh preserves observation time and marks cached values stale', async () => {
  const initial = await service.getAllBalances(a);
  service.clearBalanceCache(a);
  chainData.request.mockRejectedValue(new Error('sensitive endpoint diagnostic'));
  const stale = await service.getAllBalances(a);
  expect(stale).toMatchObject({
    status: 'stale',
    lastUpdated: initial.lastUpdated,
    '11155111:native': { raw: '1', observedAt: initial['11155111:native'].observedAt, stale: true },
  });
  expect(JSON.stringify(stale)).not.toContain('sensitive');
});

test('outage invalidates fresh cache and restart requires new observations', async () => {
  await service.getAllBalances(a);
  tor.abort();
  getWalletSocksEndpoint.mockReturnValue(null);
  expect(await service.getAllBalances(a)).toMatchObject({
    status: 'stale',
    refreshError: 'TOR_NOT_READY',
  });
  expect(chainData.request).toHaveBeenCalledTimes(3);
  tor = new AbortController();
  getWalletSocksEndpoint.mockReturnValue({ signal: tor.signal });
  await service.getAllBalances(a);
  expect(chainData.request).toHaveBeenCalledTimes(6);
});

test('lock cancels uncooperative work; late completion cannot write cache or return old values', async () => {
  let finish;
  chainData.request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const work = service.getAllBalances(a);
  await Promise.resolve();
  scope.close();
  expect(await work).toMatchObject({ status: 'unavailable', lastUpdated: null });
  finish({ result: '0x1', observedAt: new Date().toISOString() });
  await new Promise(setImmediate);
  expect(cache.setPrivateBalances).not.toHaveBeenCalled();
});

test('cache-only reads do no network, and profile changes never share records or in-flight work', async () => {
  const cached = {
    privacyMode: 'tor-experimental',
    lastUpdated: 'previous',
    '11155111:native': { raw: '4', observedAt: 'previous' },
  };
  cache.getPrivateBalances.mockReturnValue(cached);
  expect(await service.getBalancesWithCache(a, false)).toMatchObject({
    fromCache: true,
    balances: { status: 'stale', lastUpdated: 'previous' },
  });
  expect(chainData.request).not.toHaveBeenCalled();
  expect(cache.getPrivateBalances).toHaveBeenLastCalledWith('profile-a', a);
  scope.close();
  scope = createPrivacyScope({ profileId: 'profile-b', signal: new AbortController().signal });
  openPrivacySession.mockReturnValue(scope);
  await service.getBalancesWithCache(a, false);
  expect(cache.getPrivateBalances).toHaveBeenLastCalledWith('profile-b', a);
});

test('qualification gate never falls back or reads ordinary cache', async () => {
  settings.isWalletTorExperimentAvailable.mockReturnValue(false);
  expect(await getPrivateBalances(a)).toMatchObject({
    status: 'unavailable',
    refreshError: 'PRIVACY_EXPERIMENT_UNQUALIFIED',
  });
  expect(chainData.request).not.toHaveBeenCalled();
  expect(cache.getBalancesFromCache).not.toHaveBeenCalled();
});
