import { startBalanceRefresh } from './balance-display.js';
import { walletState } from './wallet-state.js';

beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); delete global.document; delete global.window; });

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
