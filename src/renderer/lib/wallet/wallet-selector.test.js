/**
 * Tests for the wallet selector's reload on main's "records changed"
 * broadcast (#1065): a Ledger sign that turns an old unchecked Safe owner
 * `matched` must drop the Safe owner warning without a manual reload.
 */

const { createDocument } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

test('a wallet:records-changed broadcast reloads the stored wallet list (#1065)', async () => {
  jest.resetModules();
  const listeners = {};
  const SAFE = { index: 2000001, type: 'safe', name: 'Safe 1', address: '0x111' };
  const walletState = { derivedWallets: [], activeWalletIndex: SAFE.index, fullAddresses: {} };
  const refreshSafeStatusCard = jest.fn();
  global.document = createDocument();
  global.window = {
    addEventListener: jest.fn((event, handler) => {
      listeners[event] = handler;
    }),
    wallet: {
      getDerivedWallets: jest.fn(async () => ({
        success: true,
        wallets: [SAFE, { index: 1000001, type: 'ledger', addressCheck: 'matched' }],
      })),
      getActiveIndex: jest.fn(async () => ({ success: true, index: SAFE.index })),
    },
  };
  jest.doMock('./wallet-state.js', () => ({ walletState }));
  jest.doMock('./wallet-utils.js', () => ({ escapeHtml: (text) => String(text) }));
  jest.doMock('./balance-display.js', () => ({ refreshBalances: jest.fn() }));
  jest.doMock('./safe-status.js', () => ({ refreshSafeStatusCard }));

  const mod = await import('./wallet-selector.js');
  mod.initWalletSelector(jest.fn(), jest.fn(), jest.fn(), jest.fn());
  expect(window.wallet.getDerivedWallets).not.toHaveBeenCalled();

  listeners['wallet:records-changed']();
  await flushMicrotasks();

  expect(window.wallet.getDerivedWallets).toHaveBeenCalledTimes(1);
  expect(walletState.derivedWallets[1].addressCheck).toBe('matched');
  // The Safe card re-reads its owners from the reloaded list.
  expect(refreshSafeStatusCard).toHaveBeenCalled();
});
