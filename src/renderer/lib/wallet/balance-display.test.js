import {
  startBalanceRefresh,
  loadCachedBalances,
  refreshBalances,
  initBalanceDisplay,
} from './balance-display.js';
import { walletState } from './wallet-state.js';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete global.document;
  delete global.window;
});

test('hidden ancestors and hidden documents suppress automatic balance IPC', async () => {
  const walletTab = { checkVisibility: jest.fn(() => false) };
  global.document = { hidden: false, getElementById: () => walletTab };
  global.window = { wallet: { getBalances: jest.fn(async () => null) } };
  walletState.fullAddresses = { wallet: '0xabc', swarm: null };
  startBalanceRefresh();
  jest.advanceTimersByTime(walletState.BALANCE_REFRESH_MS);
  expect(window.wallet.getBalances).not.toHaveBeenCalled();
  walletTab.checkVisibility.mockReturnValue(true);
  document.hidden = true;
  jest.advanceTimersByTime(walletState.BALANCE_REFRESH_MS);
  expect(window.wallet.getBalances).not.toHaveBeenCalled();
  document.hidden = false;
  jest.advanceTimersByTime(walletState.BALANCE_REFRESH_MS);
  await Promise.resolve();
  expect(window.wallet.getBalances).toHaveBeenCalledWith('0xabc');
});

test.each([
  [true, false, null, 1],
  [true, false, {}, 0],
  [false, false, null, 0],
  [true, true, null, 0],
])(
  'startup visibility=%s hidden=%s cached=%s refreshes only a visible miss',
  async (visible, hidden, balances, calls) => {
    global.document = { hidden, getElementById: () => ({ checkVisibility: () => visible }) };
    global.window = {
      wallet: {
        getBalancesCached: jest.fn(async () => ({ success: true, balances })),
        getBalances: jest.fn(async () => null),
      },
    };
    walletState.fullAddresses = { wallet: '0xabc', swarm: null };
    await loadCachedBalances();
    expect(window.wallet.getBalances).toHaveBeenCalledTimes(calls);
  }
);

test('late refresh after an account switch cannot overwrite the current wallet', async () => {
  let finish;
  global.document = { getElementById: () => null };
  global.window = {
    wallet: {
      getBalances: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  };
  walletState.fullAddresses = { wallet: '0xaaa', swarm: null };
  walletState.currentBalances = { current: true };
  const work = refreshBalances();
  walletState.fullAddresses.wallet = '0xbbb';
  finish({ success: true, balances: { wrongAccount: true } });
  await work;
  expect(walletState.currentBalances).toEqual({ current: true });
});

test('experimental stale status stays visible and a later unavailable refresh clears displayed values', async () => {
  const status = { classList: { add: jest.fn(), remove: jest.fn() }, textContent: '' };
  global.document = { getElementById: (id) => (id === 'balance-error' ? status : null) };
  global.window = { addEventListener: jest.fn(), wallet: { getBalances: jest.fn() } };
  initBalanceDisplay();
  walletState.fullAddresses = { wallet: '0xaaa', swarm: null };
  window.wallet.getBalances.mockResolvedValue({
    success: true,
    balances: {
      privacyMode: 'tor-experimental',
      status: 'stale',
      '11155111:native': { raw: '1' },
    },
  });
  await refreshBalances();
  expect(status.textContent).toContain('stale');
  expect(status.classList.remove).toHaveBeenCalledWith('hidden');
  window.wallet.getBalances.mockResolvedValue({
    success: true,
    balances: { privacyMode: 'tor-experimental', status: 'unavailable' },
  });
  await refreshBalances();
  expect(walletState.currentBalances['11155111:native']).toBeUndefined();
});

test('main merge keeps user balance guards while Swarm publishing owns its own balances', async () => {
  global.document = { getElementById: () => null };
  global.window = {
    addEventListener: jest.fn(),
    wallet: {
      clearBalanceCache: jest.fn(async () => {}),
      getBalances: jest.fn(async () => ({ success: true, balances: { user: true } })),
      getBalancesCached: jest.fn(async () => ({ success: true, balances: { cached: true } })),
    },
  };
  initBalanceDisplay();
  walletState.fullAddresses = { wallet: '0xaaa', swarm: '0xbbb' };
  await refreshBalances(true);
  expect(window.wallet.clearBalanceCache.mock.calls).toEqual([['0xaaa']]);
  expect(window.wallet.getBalances.mock.calls).toEqual([['0xaaa']]);
  expect(walletState.currentBalances).toEqual({ user: true });
  await loadCachedBalances();
  expect(window.wallet.getBalancesCached.mock.calls).toEqual([['0xaaa']]);
  expect(walletState.currentBalances).toEqual({ cached: true });
});
