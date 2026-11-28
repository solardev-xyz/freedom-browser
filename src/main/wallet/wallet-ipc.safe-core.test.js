/**
 * wallet-ipc's Safe-send handlers by the Safe backend (freedom-core design
 * 0016, SAFE-3's PR 4a; safe/safe-backend-kind.js): on the core, the
 * chrome's confirmation of its own Safe send is the core's (prepared,
 * approved, minted: `confirmSafeSend`) and its send a proposal
 * (`proposeSafeSend`); no owner is confirmed again. On js, every handler
 * takes today's path and never the core's. What the core's path does is
 * safe/core-sends.test.js's.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  webContents: { fromId: jest.fn(() => null) },
  BrowserWindow: { fromWebContents: jest.fn(() => null) },
}));
jest.mock('qrcode', () => ({}));
jest.mock('./balance-service', () => ({}));
jest.mock('./chains', () => ({}));
jest.mock('./provider-manager', () => ({}));
jest.mock('./transaction-service', () => ({ namesOwnFees: () => true }));
jest.mock('./tx-recorder', () => ({ signAndRecord: jest.fn(), KINDS: { WALLET_SEND: 'wallet-send' } }));
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: jest.fn(() => 0),
  getWalletRecord: (index) => (index === 7 ? { index, type: 'safe', address: '0x' + '77'.repeat(20) } : null),
}));
jest.mock('./rpc-manager', () => ({ retiredApiKeys: () => [] }));
jest.mock('../networks/network-registry', () => ({ withoutApiKeys: (text) => String(text) }));
jest.mock('./signers', () => ({ getSigner: jest.fn() }));
jest.mock('./dapp-permissions', () => ({ getPermission: jest.fn(() => null), getSigningAutoApprove: jest.fn(() => false) }));
jest.mock('../ens-resolver', () => ({ resolveEnsContent: jest.fn() }));
jest.mock('./safe/safe-service', () => ({ activateSafe: jest.fn(), DEPLOY_CHAIN_ID: 100 }));
jest.mock('./auto-approve-pause', () => ({
  transactionAutoApprovePaused: jest.fn(async () => false),
  takeSiteTurn: jest.fn(async () => () => {}),
  sitePaymentWaiting: jest.fn(async () => false),
}));
const mockBackend = { kind: 'core' };
jest.mock('./safe/safe-backend-kind', () => ({ safeBackendKind: () => mockBackend.kind }));
jest.mock('./safe/safe-transactions', () => ({
  confirmSafeSend: jest.fn(),
  proposeSafeSend: jest.fn(),
  startSafeSend: jest.fn(async () => ({ safeTxHash: '0xsafetx' })),
  reserveSafeSend: jest.fn(() => ({ release: () => {} })),
  signSafePending: jest.fn(async () => ({ collected: 2 })),
  executeSafePending: jest.fn(async () => ({ status: 'awaiting' })),
  cancelSafeSend: jest.fn(async () => {}),
  getSafeSendState: jest.fn(() => null),
  getAllSafeSendStates: jest.fn(() => []),
  pendingCall: jest.fn(() => null),
}));
let mockWalletApprovals = null;
jest.mock('../approvals/wallet-approvals', () => ({
  ...jest.requireActual('../approvals/wallet-approvals'),
  getWalletApprovals: () => mockWalletApprovals,
}));
const mockApprovals = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({ vaultBackend: { approval: mockApprovals.approval } }));

const { ipcMain } = require('electron');
const { registerWalletIpc } = require('./wallet-ipc');
const transactions = require('./safe/safe-transactions');
const confirmations = require('./signing-confirmation');

const TO = '0x2222222222222222222222222222222222222222';
const SAFE_TX = { to: TO, value: '5', data: '0x' };
const PAYLOAD = { tx: SAFE_TX, chainId: 100 };
const CHROME = { id: 41 };
const SHOWN = '0x' + 'cd'.repeat(32);
const BOARD = { safeIndex: 7, safeTxHash: SHOWN, collected: 1, threshold: 2 };
let handlers;

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  confirmations._reset();
  mockApprovals.reset();
  mockWalletApprovals = null;
  for (const fn of Object.values(transactions)) fn.mockClear();
  ipcMain.handle.mockClear();
  registerWalletIpc();
  handlers = Object.fromEntries(ipcMain.handle.mock.calls.map(([channel, fn]) => [channel, fn]));
});

afterEach(() => {
  jest.restoreAllMocks();
  mockBackend.kind = 'core';
});

describe('on the core', () => {
  test("the chrome's confirmation of its Safe send is the core's: prepared, approved in the window's panel, minted", async () => {
    mockWalletApprovals = { confirm: jest.fn() };
    transactions.confirmSafeSend.mockResolvedValue({ approved: true, token: 'tok', expiresAt: 9 });
    const result = await handlers['wallet:confirm-signing']({ sender: CHROME }, 'safe-send', 7, PAYLOAD);
    expect(result).toEqual({ success: true, token: 'tok', expiresAt: 9 });
    expect(transactions.confirmSafeSend).toHaveBeenCalledWith({
      sender: CHROME,
      safeIndex: 7,
      request: PAYLOAD,
      approvals: mockWalletApprovals,
    });
    // Main minted nothing of its own: the legacy form never.
    expect(mockApprovals.calls.filter((call) => call.method === 'approval.issue')).toEqual([]);
  });

  test("with the approvals document off, the prepared SafeTx goes back to the chrome to confirm: nothing minted", async () => {
    const prepared = { id: 'a'.repeat(32), nonce: 7 };
    transactions.confirmSafeSend.mockResolvedValueOnce({ approved: false, code: 'SAFE_TX_PREPARED', error: 'Confirm Safe transaction #7', prepared });
    expect(await handlers['wallet:confirm-signing']({}, 'safe-send', 7, PAYLOAD)).toEqual({
      success: false,
      error: 'Confirm Safe transaction #7',
      code: 'SAFE_TX_PREPARED',
      prepared,
    });
    // Confirmed with its id, which main reads (`request.prepared`).
    transactions.confirmSafeSend.mockResolvedValueOnce({ approved: true, token: 'tok', expiresAt: 9 });
    const again = await handlers['wallet:confirm-signing']({}, 'safe-send', 7, { ...PAYLOAD, prepared: prepared.id });
    expect(again).toEqual({ success: true, token: 'tok', expiresAt: 9 });
    expect(transactions.confirmSafeSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: { ...PAYLOAD, prepared: prepared.id }, approvals: null })
    );
  });

  test('a refusal keeps its code: the panel\'s, the core\'s, and a locked vault as VAULT_LOCKED', async () => {
    transactions.confirmSafeSend.mockResolvedValueOnce({ approved: false, error: 'User rejected the request', code: 'USER_REJECTED' });
    expect(await handlers['wallet:confirm-signing']({}, 'safe-send', 7, PAYLOAD)).toEqual({
      success: false,
      error: 'User rejected the request',
      code: 'USER_REJECTED',
    });
    transactions.confirmSafeSend.mockRejectedValueOnce(Object.assign(new Error("Freedom couldn't verify this Safe"), { code: 'SAFE_UNVERIFIED' }));
    expect(await handlers['wallet:confirm-signing']({}, 'safe-send', 7, PAYLOAD)).toEqual({
      success: false,
      error: "Freedom couldn't verify this Safe",
      code: 'SAFE_UNVERIFIED',
    });
    // As the vault backend gives the core's `vault_locked` (key-store-messages.js).
    transactions.confirmSafeSend.mockRejectedValueOnce(Object.assign(new Error('Vault is locked'), { code: 'vault_locked' }));
    expect(await handlers['wallet:confirm-signing']({}, 'safe-send', 7, PAYLOAD)).toMatchObject({ success: false, code: 'VAULT_LOCKED' });
  });

  test("a site's Safe send is refused first, as on js: nothing prepared", async () => {
    const result = await handlers['wallet:confirm-signing']({}, 'safe-send', 7, { ...PAYLOAD, origin: 'https://app.example' });
    expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    const sent = await handlers['wallet:safe-send']({}, 7, SAFE_TX, { site: 'https://app.example' }, 100, { confirmation: 'tok' });
    expect(sent).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(transactions.confirmSafeSend).not.toHaveBeenCalled();
    expect(transactions.proposeSafeSend).not.toHaveBeenCalled();
  });

  test('the send is a proposal of the token\'s SafeTx: no reservation or spend of main\'s own', async () => {
    transactions.proposeSafeSend.mockResolvedValue(BOARD);
    const display = { toAddress: TO, amount: '5' };
    const authorization = { confirmation: 'tok' };
    const result = await handlers['wallet:safe-send']({}, 7, SAFE_TX, display, 100, authorization);
    expect(result).toEqual({ success: true, state: BOARD });
    expect(transactions.proposeSafeSend).toHaveBeenCalledWith({ safeIndex: 7, tx: SAFE_TX, chainId: 100, display, authorization });
    expect(transactions.reserveSafeSend).not.toHaveBeenCalled();
    expect(transactions.startSafeSend).not.toHaveBeenCalled();
    expect(mockApprovals.calls).toEqual([]);
    transactions.proposeSafeSend.mockRejectedValueOnce(Object.assign(new Error('already waiting'), { code: 'SAFE_PENDING_EXISTS' }));
    expect(await handlers['wallet:safe-send']({}, 7, SAFE_TX, display, 100, authorization)).toMatchObject({
      success: false,
      code: 'SAFE_PENDING_EXISTS',
    });
  });

  test('no owner is confirmed again: a confirmation is burnt and refused, nothing signed', async () => {
    const result = await handlers['wallet:safe-sign']({}, 7, 1, { confirmation: 'tok' });
    expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(transactions.signSafePending).not.toHaveBeenCalled();
    expect(mockApprovals.calls.map((call) => [call.method, call.params])).toEqual([['approval.discard', { token: 'tok' }]]);
    // Without one, the owner signs (the core's `safe.sign_owner`), naming the SafeTx shown.
    expect(await handlers['wallet:safe-sign']({}, 7, 1, null, SHOWN)).toEqual({ success: true, state: { collected: 2 } });
    expect(transactions.signSafePending).toHaveBeenCalledWith(7, 1, { safeTxHash: SHOWN });
  });

  test("each step of the chrome's board names the SafeTx it shows: passed on, and one naming none refused unsent", async () => {
    // The sweep, an owner, the execution and the discard, with the SafeTx shown.
    await handlers['wallet:safe-sign']({}, 7, undefined, null, SHOWN);
    await handlers['wallet:safe-sign']({}, 7, 1, null, SHOWN);
    await handlers['wallet:safe-execute']({}, 7, { safeTxHash: SHOWN });
    await handlers['wallet:safe-cancel-pending']({}, 7, SHOWN);
    expect(transactions.signSafePending.mock.calls).toEqual([
      [7, undefined, { safeTxHash: SHOWN }],
      [7, 1, { safeTxHash: SHOWN }],
    ]);
    expect(transactions.executeSafePending).toHaveBeenCalledWith(7, { feeConfirmation: undefined, safeTxHash: SHOWN });
    expect(transactions.cancelSafeSend).toHaveBeenCalledWith(7, { safeTxHash: SHOWN });
    for (const fn of Object.values(transactions)) fn.mockClear();
    // Naming none, or not a SafeTx hash: refused, nothing asked of the core.
    for (const result of [
      await handlers['wallet:safe-sign']({}, 7, undefined),
      await handlers['wallet:safe-sign']({}, 7, 1, null, 'nope'),
      await handlers['wallet:safe-execute']({}, 7),
      await handlers['wallet:safe-execute']({}, 7, { feeConfirmation: { confirmation: 'x' } }),
      await handlers['wallet:safe-cancel-pending']({}, 7),
    ]) {
      expect(result).toMatchObject({ success: false, code: 'SAFE_DISCARDED' });
    }
    expect(transactions.signSafePending).not.toHaveBeenCalled();
    expect(transactions.executeSafePending).not.toHaveBeenCalled();
    expect(transactions.cancelSafeSend).not.toHaveBeenCalled();
  });

  test("the pending list and a Safe's state are the core's board, read", async () => {
    transactions.getAllSafeSendStates.mockResolvedValueOnce([BOARD]);
    expect(await handlers['wallet:safe-pending-list']({})).toEqual({ success: true, states: [BOARD] });
    transactions.getSafeSendState.mockResolvedValueOnce(BOARD);
    expect(await handlers['wallet:safe-state']({}, 7)).toEqual({ success: true, state: BOARD });
  });
});

describe('on js', () => {
  beforeEach(() => {
    mockBackend.kind = 'js';
  });

  test("today's path: the legacy safe-send minted, spent and started; nothing of the core's", async () => {
    const minted = await handlers['wallet:confirm-signing']({}, 'safe-send', 7, PAYLOAD);
    expect(minted).toMatchObject({ success: true, token: expect.any(String) });
    const issued = mockApprovals.calls.find((call) => call.method === 'approval.issue');
    expect(issued.params.payload).toEqual({ safe: '0x' + '77'.repeat(20), chain_id: '100', tx: SAFE_TX });
    const sent = await handlers['wallet:safe-send']({}, 7, SAFE_TX, {}, 100, { confirmation: minted.token });
    expect(sent).toMatchObject({ success: true });
    expect(transactions.reserveSafeSend).toHaveBeenCalledWith(7);
    expect(transactions.startSafeSend).toHaveBeenCalledTimes(1);
    expect(transactions.confirmSafeSend).not.toHaveBeenCalled();
    expect(transactions.proposeSafeSend).not.toHaveBeenCalled();
  });

  test("the board's steps as before: the SafeTx shown isn't passed on", async () => {
    await handlers['wallet:safe-sign']({}, 7, 1, null, SHOWN);
    await handlers['wallet:safe-execute']({}, 7, { safeTxHash: SHOWN });
    await handlers['wallet:safe-cancel-pending']({}, 7, SHOWN);
    expect(transactions.signSafePending).toHaveBeenCalledWith(7, 1);
    expect(transactions.executeSafePending).toHaveBeenCalledWith(7, { feeConfirmation: undefined });
    expect(transactions.cancelSafeSend).toHaveBeenCalledWith(7);
  });

  test('the built form is no binding of js: a payload naming a SafeTx binds its call alone, as today', () => {
    const facts = confirmations.bindingFor('safe-send', 7, { ...PAYLOAD, safeTx: { nonce: 1 }, safeTxHash: '0x' + '11'.repeat(32) });
    expect(facts).toEqual({ safeIndex: 7, chainId: 100, to: TO, value: '5', data: '0x', origin: null });
  });
});
