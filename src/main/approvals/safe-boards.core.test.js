// The wallet's Safe board in the approvals document on the core's Safe
// backend (freedom-core design 0016, SAFE-3's PRs 4a and 4b; safe-boards.js
// `coreSends`): each turn reads the core's board again (`refresh`) before it
// reads the state, the SafeTx it shows is the core's state's call, each step
// is the core's naming the board's SafeTx, and no owner is confirmed again.
// At its threshold it executes; the executor's fee the core offers is
// confirmed in the panel by acknowledging it (`confirmOfferedFee`), nothing
// minted.

jest.mock('electron', () => ({
  BrowserWindow: {
    fromId: () => ({ isDestroyed: () => false, once: () => {}, removeListener: () => {} }),
    fromWebContents: () => null,
  },
}));
jest.mock('./approvals-document', () => ({ isApprovalsDocumentEnabled: () => true }));
jest.mock('../networks/network-registry', () => ({
  getAllNetworks: () => ({ 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } }),
}));
jest.mock('../identity-manager', () => ({
  getDerivedWallets: async () => [
    { index: 0, name: 'Main Wallet', address: '0x' + '0a'.repeat(20), type: 'mnemonic' },
    { index: 1, name: 'Second', address: '0x' + '0b'.repeat(20), type: 'mnemonic' },
    { index: 5, name: 'Joint', address: '0x' + '55'.repeat(20), type: 'safe' },
  ],
}));
jest.mock('../wallet/safe/safe-backend-kind', () => ({ safeBackendKind: () => 'core' }));
const mockBoard = { state: null };
jest.mock('../wallet/safe/core-sends', () => ({
  cachedState: () => mockBoard.state,
  confirmOfferedFee: jest.fn(),
}));
jest.mock('../wallet/safe/safe-transactions', () => ({
  getSafeSendState: jest.fn(),
  signSafePending: jest.fn(),
  executeSafePending: jest.fn(),
  cancelSafeSend: jest.fn(),
  pendingCall: jest.fn(() => {
    throw new Error("main's own SafeTx read on the core");
  }),
}));
const mockPrompts = { shown: [], decisions: [] };
jest.mock('../page/page-requests', () => ({
  getPageRequests: () => ({
    walletPrompt: async (windowId, spec) => {
      mockPrompts.shown.push({ windowId, ...spec });
      return mockPrompts.decisions.shift() ?? { approve: false, choices: {} };
    },
    walletUnlock: async () => ({ approve: false }),
  }),
}));

const transactions = require('../wallet/safe/safe-transactions');
const coreSends = require('../wallet/safe/core-sends');
const { getSafeBoards, createSafeBoards } = require('./safe-boards');

const HASH = '0x' + 'cd'.repeat(32);
const TO = '0x2222222222222222222222222222222222222222';
const owner = (index, signed) => ({ index, address: '0x' + (index === 0 ? '0a' : '0b').repeat(20), type: 'mnemonic', signed });
const state = (collected) => ({
  safeIndex: 5,
  chainId: 100,
  safeTxHash: HASH,
  threshold: 2,
  collected,
  owners: [owner(0, collected >= 1), owner(1, collected >= 2)],
  executorIndex: 0,
  display: { toAddress: TO, amount: '5' },
  call: { to: TO, value: '5', data: '0x' },
  createdAt: 1,
  status: 'awaiting',
});

beforeEach(() => {
  mockPrompts.shown = [];
  mockPrompts.decisions = [];
  mockBoard.state = null;
  for (const fn of Object.values(transactions)) fn.mockReset?.();
  coreSends.confirmOfferedFee.mockReset();
});

test("each turn reads the core's board again before it reads the state", async () => {
  let current = null;
  const order = [];
  const sends = {
    refresh: jest.fn(async () => {
      order.push('refresh');
      current = state(1);
    }),
    state: jest.fn(() => {
      order.push('state');
      return current;
    }),
    tx: (_i, hash) => (current?.safeTxHash === hash ? current.call : null),
    sign: jest.fn(async () => current),
    execute: jest.fn(),
    cancel: jest.fn(),
    call: () => null,
  };
  const shown = [];
  const boards = createSafeBoards({
    getDerivedWallets: async () => [],
    sends,
    messages: {},
    walletPrompt: async (_windowId, spec) => {
      shown.push(spec.view);
      return { approve: false, choices: {} };
    },
    walletUnlock: async () => ({ approve: false }),
    confirmExecutorFee: async () => null,
    watchWindow: () => () => {},
  });
  expect(await boards.openWalletBoard(3, 5)).toEqual({ outcome: 'parked' });
  expect(order.slice(0, 2)).toEqual(['refresh', 'state']);
  expect(sends.refresh).toHaveBeenCalledWith(5);
  expect(shown[0].tx).toEqual({ to: TO, value: '5', data: '0x' });
});

describe("getSafeBoards' send steps on the core", () => {
  // The core's board, as each read and step leaves it.
  function coreBoard() {
    transactions.getSafeSendState.mockImplementation(async () => mockBoard.state);
    transactions.signSafePending.mockImplementation(async (_i, ownerIndex) => {
      mockBoard.state = state(ownerIndex === undefined ? 1 : 2);
      return mockBoard.state;
    });
  }
  const EXECUTED = { hash: '0x' + 'ee'.repeat(32), explorerUrl: 'https://explorer.test/tx/ee' };

  test("the core's board: swept, an owner signed, executed at its threshold", async () => {
    coreBoard();
    transactions.executeSafePending.mockImplementation(async () => ({ ...state(2), status: 'executed', executed: EXECUTED }));
    mockBoard.state = state(0);
    mockPrompts.decisions.push({ approve: true, choices: { action: 'sign', owner: 1 } });
    const outcome = await getSafeBoards().openWalletBoard(3, 5);
    expect(outcome).toEqual({ outcome: 'executed', safeTxHash: HASH, display: state(2).display, executed: EXECUTED });

    // The sweep, then the owner picked, each naming the board's SafeTx.
    expect(transactions.signSafePending.mock.calls).toEqual([
      [5, undefined, { safeTxHash: HASH }],
      [5, 1, { safeTxHash: HASH }],
    ]);
    expect(transactions.getSafeSendState).toHaveBeenCalledWith(5);
    // The SafeTx shown is the core's state's call.
    expect(mockPrompts.shown[0].kind).toBe('wallet.safe_board');
    expect(mockPrompts.shown[0].view.tx).toEqual({ to: TO, value: '5', data: '0x' });
    // At its threshold, the execution, naming the board's SafeTx.
    expect(transactions.executeSafePending.mock.calls).toEqual([[5, { safeTxHash: HASH }]]);
    expect(transactions.pendingCall).not.toHaveBeenCalled();
  });

  test("the executor's fee the core offers: confirmed in the panel by acknowledging it, then executed with fee_ack", async () => {
    coreBoard();
    const offer = { feeAck: true, safeIndex: 5, executorIndex: 0, chainId: 100, to: '0x' + '55'.repeat(20), value: '0' };
    transactions.executeSafePending
      .mockRejectedValueOnce(
        Object.assign(new Error("This payment's network fee needs your confirmation."), {
          code: 'FEE_CHECK_NEEDS_CONFIRMATION',
          feeCheck: { above: true },
          offer,
        })
      )
      .mockImplementation(async () => ({ ...state(2), status: 'executed', executed: EXECUTED }));
    coreSends.confirmOfferedFee.mockResolvedValue({ approved: true, feeConfirmation: { feeAck: true } });
    mockBoard.state = state(2);
    expect(await getSafeBoards().openWalletBoard(3, 5)).toMatchObject({ outcome: 'executed' });
    // Asked in the board's window for the Safe's offer main holds; no token.
    expect(coreSends.confirmOfferedFee).toHaveBeenCalledWith({ approvals: expect.any(Object), windowId: 3, safeIndex: 5 });
    expect(transactions.executeSafePending.mock.calls).toEqual([
      [5, { safeTxHash: HASH }],
      [5, { feeConfirmation: { feeAck: true }, safeTxHash: HASH }],
    ]);
  });

  test("the fee declined: no execution; the board says why, and parks", async () => {
    coreBoard();
    transactions.executeSafePending.mockRejectedValue(
      Object.assign(new Error('fee'), {
        code: 'FEE_CHECK_NEEDS_CONFIRMATION',
        feeCheck: { above: true },
        offer: { feeAck: true, safeIndex: 5, executorIndex: 0, chainId: 100, to: TO, value: '0' },
      })
    );
    coreSends.confirmOfferedFee.mockResolvedValue({ approved: false, error: 'User rejected the request', code: 'USER_REJECTED' });
    mockBoard.state = state(2);
    expect(await getSafeBoards().openWalletBoard(3, 5)).toEqual({ outcome: 'parked' });
    expect(transactions.executeSafePending).toHaveBeenCalledTimes(1);
    expect(mockPrompts.shown[0].view).toMatchObject({ step: 'retry', error: { code: 'fee' } });
  });

  test('an owner refused for a new confirmation asks for none on the core', async () => {
    transactions.getSafeSendState.mockImplementation(async () => mockBoard.state);
    transactions.signSafePending.mockImplementation(async (_i, ownerIndex) => {
      if (ownerIndex === undefined) return mockBoard.state;
      throw Object.assign(new Error('confirm again'), { code: 'SAFE_APPROVAL_NEEDED' });
    });
    mockBoard.state = state(1);
    mockPrompts.decisions.push({ approve: true, choices: { action: 'sign', owner: 1 } });
    expect(await getSafeBoards().openWalletBoard(3, 5)).toEqual({ outcome: 'parked' });
    // No wallet.safe_send asked: the owner's row says it failed.
    expect(mockPrompts.shown.map((prompt) => prompt.kind)).toEqual(['wallet.safe_board', 'wallet.safe_board']);
    expect(mockPrompts.shown[1].view.notes).toEqual([{ owner: 1, note: 'failed', message: 'confirm again' }]);
  });
});
