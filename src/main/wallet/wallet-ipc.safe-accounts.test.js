/**
 * wallet-ipc's Safe account handlers by the Safe backend (freedom-core
 * design 0016, SAFE-3's PR 3; safe/safe-backend-kind.js): on the core,
 * activation takes the asking window (for its approvals document, and the
 * ask main binds to it) and the card's `feeAskId`, and a fee the core
 * stopped reaches the card as the core's verdict with the ask's ID; on js,
 * every handler passes exactly
 * what it passes today. What the core's path does is
 * safe/safe-service.core.test.js's.
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
jest.mock('./tx-recorder', () => ({
  signAndRecord: jest.fn(),
  KINDS: { WALLET_SEND: 'wallet-send' },
}));
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: jest.fn(() => 0),
  getWalletRecord: () => null,
}));
jest.mock('./rpc-manager', () => ({ retiredApiKeys: () => [] }));
jest.mock('../networks/network-registry', () => ({ withoutApiKeys: (text) => String(text) }));
jest.mock('./signers', () => ({ getSigner: jest.fn() }));
jest.mock('./dapp-permissions', () => ({
  getPermission: jest.fn(() => null),
  getSigningAutoApprove: jest.fn(() => false),
}));
jest.mock('../ens-resolver', () => ({ resolveEnsContent: jest.fn() }));
jest.mock('./safe/safe-service', () => ({
  createSafeAccount: jest.fn(),
  getSafeStatus: jest.fn(),
  activateSafe: jest.fn(),
  DEPLOY_CHAIN_ID: 100,
}));
const mockBackend = { kind: 'core' };
jest.mock('./safe/safe-backend-kind', () => ({ safeBackendKind: () => mockBackend.kind }));
jest.mock('../core/vault-backend', () => ({ vaultBackend: {} }));

const { ipcMain } = require('electron');
const { registerWalletIpc } = require('./wallet-ipc');
const service = require('./safe/safe-service');
const { FEE_CHECK_NEEDS_CONFIRMATION, feeCheckError } = require('./fee-check');

const CHROME = { id: 41 };
const VERDICT = {
  maxCost: '600000000000000',
  comparable: false,
  ratio: null,
  above: false,
  oneEndpoint: false,
  basis: null,
  autoApprove: false,
};
const FEE_CONFIRMATION = { confirmation: 'token', gasLimit: '300000', fees: { gasPrice: '1' } };
let handlers;

beforeEach(() => {
  mockBackend.kind = 'core';
  for (const fn of [service.createSafeAccount, service.getSafeStatus, service.activateSafe])
    fn.mockReset();
  ipcMain.handle.mockClear();
  registerWalletIpc();
  handlers = Object.fromEntries(ipcMain.handle.mock.calls.map(([channel, fn]) => [channel, fn]));
});

describe('wallet:activate-safe', () => {
  test("on the core: the asking window, the card's ask ID and the chrome's confirmation (burnt there)", async () => {
    service.activateSafe.mockResolvedValue({ safeAddress: '0xsafe', hash: '0xhash' });
    await expect(handlers['wallet:activate-safe']({ sender: CHROME }, 7)).resolves.toEqual({
      success: true,
      safeAddress: '0xsafe',
      hash: '0xhash',
    });
    expect(service.activateSafe).toHaveBeenLastCalledWith(7, {
      feeAskId: null,
      sender: CHROME,
      feeConfirmation: undefined,
      speedUp: false,
    });
    await handlers['wallet:activate-safe']({ sender: CHROME }, 7, {
      feeAskId: 'ask-1',
      feeConfirmation: FEE_CONFIRMATION,
      speedUp: false,
    });
    expect(service.activateSafe).toHaveBeenLastCalledWith(7, {
      feeAskId: 'ask-1',
      sender: CHROME,
      feeConfirmation: FEE_CONFIRMATION,
      speedUp: false,
    });
    // Only a string is an ask's ID; a bare acknowledgement is nothing.
    await handlers['wallet:activate-safe']({ sender: CHROME }, 7, { feeAskId: 7 });
    expect(service.activateSafe.mock.calls.at(-1)[1].feeAskId).toBeNull();
    await handlers['wallet:activate-safe']({ sender: CHROME }, 7, { feeAcknowledged: true });
    expect(service.activateSafe.mock.calls.at(-1)[1]).toEqual({
      feeAskId: null,
      sender: CHROME,
      feeConfirmation: undefined,
      speedUp: false,
    });
    // A held activation's speed-up (SAFE-3's PR 7): only `true` asks for it.
    await handlers['wallet:activate-safe']({ sender: CHROME }, 7, { speedUp: true, feeAskId: 'ask-3' });
    expect(service.activateSafe.mock.calls.at(-1)[1]).toEqual({
      feeAskId: 'ask-3',
      sender: CHROME,
      feeConfirmation: undefined,
      speedUp: true,
    });
    await handlers['wallet:activate-safe']({ sender: CHROME }, 7, { speedUp: 'yes' });
    expect(service.activateSafe.mock.calls.at(-1)[1].speedUp).toBe(false);
  });

  test("on the core: the core's fee reaches the card as its verdict and the ask's ID, with no offer", async () => {
    service.activateSafe.mockRejectedValueOnce(
      Object.assign(feeCheckError(FEE_CHECK_NEEDS_CONFIRMATION, VERDICT), {
        feeAskId: 'ask-2',
        feeAskAgain: true,
      })
    );
    await expect(handlers['wallet:activate-safe']({ sender: CHROME }, 7)).resolves.toEqual({
      success: false,
      code: FEE_CHECK_NEEDS_CONFIRMATION,
      error: "This payment's network fee needs your confirmation.",
      feeCheck: VERDICT,
      feeAskId: 'ask-2',
      feeAskAgain: true,
    });
    // The core's codes pass through; a locked vault is VAULT_LOCKED.
    service.activateSafe.mockRejectedValueOnce(
      Object.assign(new Error('Fund it'), { code: 'SAFE_NEEDS_FUNDS' })
    );
    await expect(handlers['wallet:activate-safe']({ sender: CHROME }, 7)).resolves.toEqual({
      success: false,
      code: 'SAFE_NEEDS_FUNDS',
      error: 'Fund it',
    });
    service.activateSafe.mockRejectedValueOnce(
      Object.assign(new Error('Vault is locked'), { code: 'vault_locked' })
    );
    await expect(handlers['wallet:activate-safe']({ sender: CHROME }, 7)).resolves.toMatchObject({
      code: 'VAULT_LOCKED',
    });
  });

  test("on js: exactly today's options, and no ask ID", async () => {
    mockBackend.kind = 'js';
    service.activateSafe.mockResolvedValue({ safeAddress: '0xsafe', hash: '0xhash' });
    await handlers['wallet:activate-safe']({ sender: CHROME }, 7, {
      feeAskId: 'ask-1',
      feeConfirmation: FEE_CONFIRMATION,
    });
    expect(service.activateSafe).toHaveBeenLastCalledWith(7, { feeConfirmation: FEE_CONFIRMATION });
    // An ask's ID on an error is the core's alone; today's offer goes as before.
    const offer = { executorIndex: 0, chainId: 100, to: '0x' + '22'.repeat(20) };
    service.activateSafe.mockRejectedValueOnce(
      Object.assign(feeCheckError(FEE_CHECK_NEEDS_CONFIRMATION, VERDICT), { offer })
    );
    await expect(handlers['wallet:activate-safe']({ sender: CHROME }, 7)).resolves.toEqual({
      success: false,
      code: FEE_CHECK_NEEDS_CONFIRMATION,
      error: "This payment's network fee needs your confirmation.",
      feeCheck: VERDICT,
      offer,
    });
  });
});

describe('wallet:create-safe and wallet:get-safe-status', () => {
  test.each(['core', 'js'])('%s: the same arguments, routed by safe-service.js', async (kind) => {
    mockBackend.kind = kind;
    service.createSafeAccount.mockResolvedValueOnce({ index: 9, type: 'safe' });
    await expect(
      handlers['wallet:create-safe']({ sender: CHROME }, 'Team', [0, 2], 1)
    ).resolves.toEqual({
      success: true,
      wallet: { index: 9, type: 'safe' },
    });
    expect(service.createSafeAccount).toHaveBeenCalledWith({
      name: 'Team',
      ownerIndexes: [0, 2],
      threshold: 1,
    });
    const status = { deployed: true, chainId: 100, setup: { state: 'unchanged' } };
    service.getSafeStatus.mockResolvedValueOnce(status);
    await expect(handlers['wallet:get-safe-status']({ sender: CHROME }, 7)).resolves.toEqual({
      success: true,
      status,
    });
    expect(service.getSafeStatus).toHaveBeenCalledWith(7);
  });
});
