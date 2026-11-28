// The wallet's Safe board in the approvals document on the core's Safe
// backend (freedom-core design 0016, SAFE-3's PRs 4a and 4b; safe-boards.js
// `coreSends`): each turn reads the core's board again (`refresh`) before it
// reads the state, the SafeTx it shows is the core's state's call, each step
// is the core's naming the board's SafeTx, and no owner is confirmed again.
// At its threshold it executes; the executor's fee the core offers is
// confirmed in the panel by the ask main holds for it (`confirmOfferedFee`),
// nothing minted.

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

  test("the executor's fee the core offers: its ask confirmed in the panel, then executed with that ask's ID", async () => {
    coreBoard();
    const offer = { feeAskId: 'ask-1', feeAskAgain: false, safeIndex: 5, executorIndex: 0, chainId: 100, to: '0x' + '55'.repeat(20), value: '0' };
    transactions.executeSafePending
      .mockRejectedValueOnce(
        Object.assign(new Error("This payment's network fee needs your confirmation."), {
          code: 'FEE_CHECK_NEEDS_CONFIRMATION',
          feeCheck: { above: true },
          offer,
        })
      )
      .mockImplementation(async () => ({ ...state(2), status: 'executed', executed: EXECUTED }));
    coreSends.confirmOfferedFee.mockResolvedValue({ approved: true, feeConfirmation: { feeAskId: 'ask-1' } });
    mockBoard.state = state(2);
    expect(await getSafeBoards().openWalletBoard(3, 5)).toMatchObject({ outcome: 'executed' });
    // Asked in the board's window for the Safe's offer main holds; no token.
    expect(coreSends.confirmOfferedFee).toHaveBeenCalledWith({ approvals: expect.any(Object), windowId: 3, safeIndex: 5, askId: 'ask-1' });
    expect(transactions.executeSafePending.mock.calls).toEqual([
      [5, { safeTxHash: HASH }],
      [5, { feeConfirmation: { feeAskId: 'ask-1' }, safeTxHash: HASH }],
    ]);
  });

  test("the fee declined: no execution; the board says why, and parks", async () => {
    coreBoard();
    transactions.executeSafePending.mockRejectedValue(
      Object.assign(new Error('fee'), {
        code: 'FEE_CHECK_NEEDS_CONFIRMATION',
        feeCheck: { above: true },
        offer: { feeAskId: 'ask-1', feeAskAgain: false, safeIndex: 5, executorIndex: 0, chainId: 100, to: TO, value: '0' },
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

// SAFE-3's PR 9 (the plan's point 14, option (a)): an entry from an older
// version, which no owner signs, and a Safe changed outside Freedom, in the
// approvals document. Each view fits the panel's template.
describe('an older entry, and a changed Safe, in the approvals document (PR 9)', () => {
  const kinds = require('../../renderer/approvals/approvals-kinds.js');
  const { PLAIN_TEXTS } = jest.requireActual('../wallet/safe/errors');
  const fits = (prompt) =>
    kinds.checkMessage({
      handle: 'c'.repeat(64),
      revision: 1,
      guest: null,
      kind: prompt.kind,
      site: { key: 'freedom:wallet', label: 'Your wallet' },
      view: prompt.view,
    }).valid;
  const EXECUTED = { hash: '0x' + 'ee'.repeat(32), explorerUrl: 'https://explorer.test/tx/ee' };
  const DISCARD = { approve: true, choices: { action: 'discard' } };

  beforeEach(() => {
    transactions.getSafeSendState.mockImplementation(async () => mockBoard.state);
    transactions.cancelSafeSend.mockResolvedValue(undefined);
  });

  test('below its threshold: no sweep; the board says it was started in an older version and offers only its discard', async () => {
    mockBoard.state = { ...state(1), older: true };
    mockPrompts.decisions.push(DISCARD, DISCARD);
    expect(await getSafeBoards().openWalletBoard(3, 5)).toEqual({ outcome: 'discarded', safeTxHash: HASH });
    expect(transactions.signSafePending).not.toHaveBeenCalled();
    expect(transactions.executeSafePending).not.toHaveBeenCalled();
    const [older, asked] = mockPrompts.shown;
    expect(older.view.step).toBe('older');
    expect(fits(older)).toBe(true);
    expect(older.choices({ action: 'send' })).toBeNull();
    expect(older.choices({ action: 'sign', owner: 1 })).toBeNull();
    expect(older.choices({ action: 'retry' })).toBeNull();
    expect(older.choices({ action: 'discard' })).toEqual({ action: 'discard' });
    // The discard asked again, then done, naming the board's SafeTx.
    expect(asked.view.step).toBe('discard');
    expect(transactions.cancelSafeSend.mock.calls).toEqual([[5, { safeTxHash: HASH }]]);
  });

  test("at its threshold: not executed by itself; its Send executes it through the core's execution", async () => {
    mockBoard.state = { ...state(2), older: true };
    const shownWhenExecuted = [];
    transactions.executeSafePending.mockImplementation(async () => {
      shownWhenExecuted.push(mockPrompts.shown.length);
      return { ...state(2), status: 'executed', executed: EXECUTED };
    });
    mockPrompts.decisions.push({ approve: true, choices: { action: 'send' } });
    expect(await getSafeBoards().openWalletBoard(3, 5)).toEqual({
      outcome: 'executed',
      safeTxHash: HASH,
      display: state(2).display,
      executed: EXECUTED,
    });
    const [older] = mockPrompts.shown;
    expect(older.view.step).toBe('older');
    expect(fits(older)).toBe(true);
    expect(older.choices({ action: 'send' })).toEqual({ action: 'send' });
    expect(older.choices({ action: 'discard' })).toEqual({ action: 'discard' });
    // Executed only after the board showed it and the user chose Send.
    expect(shownWhenExecuted).toEqual([1]);
    expect(transactions.executeSafePending.mock.calls).toEqual([[5, { safeTxHash: HASH }]]);
    expect(transactions.signSafePending).not.toHaveBeenCalled();
  });

  test('its execution failing: "Try again" executes again, its discard still offered', async () => {
    mockBoard.state = { ...state(2), older: true };
    transactions.executeSafePending
      .mockRejectedValueOnce(Object.assign(new Error(PLAIN_TEXTS.SAFE_NONCE_BEHIND), { code: 'SAFE_NONCE_BEHIND' }))
      .mockImplementation(async () => ({ ...state(2), status: 'executed', executed: EXECUTED }));
    mockPrompts.decisions.push({ approve: true, choices: { action: 'send' } }, { approve: true, choices: { action: 'retry' } });
    expect(await getSafeBoards().openWalletBoard(3, 5)).toMatchObject({ outcome: 'executed' });
    const retry = mockPrompts.shown[1];
    expect(retry.view).toMatchObject({ step: 'retry', error: { code: 'failed', message: PLAIN_TEXTS.SAFE_NONCE_BEHIND } });
    expect(fits(retry)).toBe(true);
    expect(retry.choices({ action: 'discard' })).toEqual({ action: 'discard' });
    expect(transactions.executeSafePending).toHaveBeenCalledTimes(2);
  });

  test('a changed Safe: only its discard, nothing signed or executed, what changed named', async () => {
    // At its threshold, and from an older version too: the change decides.
    mockBoard.state = { ...state(2), older: true, setupChanged: ['owners', 'threshold'] };
    mockPrompts.decisions.push(DISCARD, DISCARD);
    expect(await getSafeBoards().openWalletBoard(3, 5)).toEqual({ outcome: 'discarded', safeTxHash: HASH });
    expect(transactions.signSafePending).not.toHaveBeenCalled();
    expect(transactions.executeSafePending).not.toHaveBeenCalled();
    const [changed] = mockPrompts.shown;
    expect(changed.view).toMatchObject({ step: 'changed', changed: ['owners', 'threshold'] });
    expect(fits(changed)).toBe(true);
    for (const choice of [{ action: 'send' }, { action: 'retry' }, { action: 'sign', owner: 1 }]) {
      expect(changed.choices(choice)).toBeNull();
    }
    expect(changed.choices({ action: 'discard' })).toEqual({ action: 'discard' });
  });

  test("an owner the core refuses changed: the row says so in the wallet's words, then the board offers only the discard", async () => {
    mockBoard.state = state(0);
    transactions.signSafePending.mockImplementation(async (_i, ownerIndex) => {
      if (ownerIndex === undefined) return mockBoard.state;
      mockBoard.state = { ...state(0), setupChanged: [] };
      throw Object.assign(new Error(PLAIN_TEXTS.SAFE_CHANGED), { code: 'SAFE_CHANGED' });
    });
    mockPrompts.decisions.push({ approve: true, choices: { action: 'sign', owner: 1 } });
    expect(await getSafeBoards().openWalletBoard(3, 5)).toEqual({ outcome: 'parked' });
    const after = mockPrompts.shown[1];
    expect(after.view).toMatchObject({ step: 'changed', changed: [] });
    expect(after.view.notes).toEqual([{ owner: 1, note: 'failed', message: PLAIN_TEXTS.SAFE_CHANGED }]);
    expect(fits(after)).toBe(true);
  });

  test.each(['SAFE_UNVERIFIED', 'SAFE_NONCE_BEHIND', 'SAFE_STORE_FULL'])(
    "an owner the core refuses (%s): the row's note in the wallet's words",
    async (code) => {
      mockBoard.state = state(0);
      transactions.signSafePending.mockImplementation(async (_i, ownerIndex) => {
        if (ownerIndex === undefined) return mockBoard.state;
        throw Object.assign(new Error(PLAIN_TEXTS[code]), { code });
      });
      mockPrompts.decisions.push({ approve: true, choices: { action: 'sign', owner: 1 } });
      expect(await getSafeBoards().openWalletBoard(3, 5)).toEqual({ outcome: 'parked' });
      const after = mockPrompts.shown[1];
      expect(after.view).toMatchObject({ step: 'collect', notes: [{ owner: 1, note: 'failed', message: PLAIN_TEXTS[code] }] });
      expect(fits(after)).toBe(true);
    }
  );
});
