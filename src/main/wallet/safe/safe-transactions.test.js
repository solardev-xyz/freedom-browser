const fs = require('fs');
const os = require('os');
const path = require('path');

const { ownerWallet } = require('./__tests__/helpers/test-owners');

const OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];
const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const SAFE_TX_HASH = '0x' + 'cd'.repeat(32);
const TX_HASH = '0x' + 'ab'.repeat(32);

let mockTmpDir;
jest.mock('electron', () => ({
  app: { getPath: () => mockTmpDir },
}));

const mockWalletRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[1], type: 'ledger' },
  4: { index: 4, name: 'My Phone', address: OWNERS[2], type: 'remote' },
  5: {
    index: 5,
    name: 'Joint',
    address: SAFE_ADDRESS,
    type: 'safe',
    owners: [0, 2, 4],
    threshold: 2,
    saltNonce: '7508',
    deployed: { 100: true },
  },
  6: {
    index: 6,
    name: 'Fresh',
    address: SAFE_ADDRESS.replace('41', '42'),
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '9',
    deployed: {},
  },
};
const mockIsVaultUnlocked = jest.fn(async () => true);
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockWalletRecords[index] || null,
  isVaultUnlocked: (...args) => mockIsVaultUnlocked(...args),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));

const builtResult = {
  safeAddress: SAFE_ADDRESS,
  deployed: true,
  safeTxData: { to: OWNERS[2], value: '1000', data: '0x', nonce: 3 },
  safeTxHash: SAFE_TX_HASH,
  typedData: { domain: {}, types: {}, message: {} },
};
const signatureOf = (index) => ({
  signer: OWNERS[index === 0 ? 0 : index === 2 ? 1 : 2],
  data: '0x' + 'ee'.repeat(65),
});

const mockBuildSafeTransaction = jest.fn(async () => builtResult);
const mockCollectOwnerSignature = jest.fn(async ({ ownerIndex }) => signatureOf(ownerIndex));
const mockExecTransaction = jest.fn(async () => ({
  hash: TX_HASH,
  explorerUrl: `https://gnosisscan.io/tx/${TX_HASH}`,
  recorded: true,
}));
jest.mock('./safe-executor', () => ({
  buildSafeTransaction: (...args) => mockBuildSafeTransaction(...args),
  collectOwnerSignature: (...args) => mockCollectOwnerSignature(...args),
  execTransaction: (...args) => mockExecTransaction(...args),
  pickDefaultExecutor: jest.requireActual('./safe-executor').pickDefaultExecutor,
}));

// Chain reads (the Safe nonce guard).
const mockRpcRequest = jest.fn(async () => '0x3'); // == pending nonce → executable
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: (...args) => mockRpcRequest(...args) }),
}));

const {
  startSafeSend,
  signSafePending,
  executeSafePending,
  getSafeSendState,
  getAllSafeSendStates,
  cancelSafeSend,
} = require('./safe-transactions');
const { getPending, clearPending } = require('./pending-store');

const DISPLAY = {
  toAddress: OWNERS[2],
  asset: null,
  amount: '1000',
  symbol: 'xDAI',
  decimals: 18,
  formattedAmount: '0.000000000000001',
};
const TX = { to: OWNERS[2], value: '1000', data: '0x' };

const start = (safeIndex = 5) => startSafeSend({ safeIndex, tx: TX, display: DISPLAY });

beforeEach(() => {
  mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-pending-'));
  jest.clearAllMocks();
  mockIsVaultUnlocked.mockResolvedValue(true);
  mockRpcRequest.mockResolvedValue('0x3');
  for (const index of [5, 6]) clearPending(index);
});

afterEach(() => {
  fs.rmSync(mockTmpDir, { recursive: true, force: true });
});

describe('startSafeSend', () => {
  test('builds, persists, silently signs the mnemonic owner only, never executes', async () => {
    const state = await start();

    expect(mockBuildSafeTransaction).toHaveBeenCalledWith({
      chainId: 100,
      // owners resolved to ADDRESSES for the executor layer
      safe: { ...mockWalletRecords[5], owners: OWNERS },
      tx: TX,
    });
    // only the free (mnemonic) owner was asked — devices are never cold-called
    expect(mockCollectOwnerSignature).toHaveBeenCalledTimes(1);
    expect(mockCollectOwnerSignature).toHaveBeenCalledWith({ typedData: builtResult.typedData, ownerIndex: 0 });
    expect(mockExecTransaction).not.toHaveBeenCalled();

    expect(state).toMatchObject({
      safeIndex: 5,
      chainId: 100,
      safeTxHash: SAFE_TX_HASH,
      threshold: 2,
      collected: 1,
      status: 'awaiting',
      display: DISPLAY,
      executorIndex: 0,
      owners: [
        { index: 0, type: 'mnemonic', signed: true },
        { index: 2, type: 'ledger', signed: false },
        { index: 4, type: 'remote', signed: false },
      ].map((owner) => expect.objectContaining(owner)),
    });
    expect(getPending(5).signatures).toEqual([signatureOf(0)]);
  });

  test('a locked vault skips the silent signing entirely', async () => {
    mockIsVaultUnlocked.mockResolvedValue(false);
    const state = await start();
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    expect(state.collected).toBe(0);
  });

  test('an auto-sign failure degrades the owner to a manual row instead of failing', async () => {
    mockCollectOwnerSignature.mockRejectedValueOnce(new Error('Vault is locked'));
    const state = await start();
    expect(state.collected).toBe(0);
    expect(state.status).toBe('awaiting');
  });

  test('refuses a second pending transaction (typed code)', async () => {
    await start();
    await expect(start()).rejects.toMatchObject({ code: 'SAFE_PENDING_EXISTS' });
  });

  test('refuses safes not yet deployed and non-safe accounts', async () => {
    await expect(start(6)).rejects.toThrow(/activate/i);
    await expect(start(0)).rejects.toThrow(/not a Safe/i);
  });
});

describe('signSafePending', () => {
  test('signs exactly the requested owner and persists it', async () => {
    await start(); // collected: owner 0
    mockCollectOwnerSignature.mockClear();

    const state = await signSafePending(5, 2);

    expect(mockCollectOwnerSignature).toHaveBeenCalledWith({ typedData: builtResult.typedData, ownerIndex: 2 });
    expect(state.collected).toBe(2);
    expect(state.owners.find((o) => o.index === 2).signed).toBe(true);
    expect(getPending(5).signatures).toHaveLength(2);
    expect(mockExecTransaction).not.toHaveBeenCalled(); // execution is a separate step
  });

  test('is idempotent for an already-signed owner', async () => {
    await start();
    mockCollectOwnerSignature.mockClear();
    const state = await signSafePending(5, 0);
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    expect(state.collected).toBe(1);
  });

  test('a device failure leaves the pending transaction intact', async () => {
    await start();
    mockCollectOwnerSignature.mockRejectedValueOnce(
      Object.assign(new Error('Ledger not connected'), { code: 'LEDGER_NOT_CONNECTED' })
    );

    await expect(signSafePending(5, 2)).rejects.toMatchObject({ code: 'LEDGER_NOT_CONNECTED' });
    expect(getPending(5).signatures).toHaveLength(1); // owner 0's survives
    expect(getSafeSendState(5).status).toBe('awaiting'); // guard released
  });

  test('refuses concurrent steps (SAFE_BUSY) and exposes the signing status', async () => {
    await start();
    let resolveSign;
    mockCollectOwnerSignature.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSign = resolve))
    );

    const inFlight = signSafePending(5, 2);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(signSafePending(5, 4)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    expect(() => cancelSafeSend(5)).toThrow(/current step/i);

    resolveSign(signatureOf(2));
    await inFlight;
    expect(getSafeSendState(5).status).toBe('awaiting');
  });

  test('drops a signature whose transaction was replaced mid-ceremony', async () => {
    await start();
    mockCollectOwnerSignature.mockImplementationOnce(async ({ ownerIndex }) => {
      // While the device ceremony runs, the pending entry disappears
      // (simulates a discard path that bypassed the guard).
      clearPending(5);
      return signatureOf(ownerIndex);
    });

    await expect(signSafePending(5, 2)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(getPending(5)).toBeNull();
  });
});

describe('executeSafePending', () => {
  async function readyPending() {
    await start();
    await signSafePending(5, 2);
  }

  test('executes at threshold with recording, clears pending, returns the result', async () => {
    await readyPending();

    const state = await executeSafePending(5);

    expect(mockExecTransaction).toHaveBeenCalledWith({
      chainId: 100,
      safeAddress: SAFE_ADDRESS,
      safeTxData: builtResult.safeTxData,
      signatures: [signatureOf(0), signatureOf(2)],
      executorIndex: 0,
      record: {
        kind: 'safe-send',
        fromAddress: SAFE_ADDRESS,
        toAddress: DISPLAY.toAddress,
        asset: null,
        amount: '1000',
        metadata: { safeAddress: SAFE_ADDRESS, safeTxHash: SAFE_TX_HASH },
      },
    });
    expect(state.status).toBe('executed');
    expect(state.executed).toEqual({ hash: TX_HASH, explorerUrl: `https://gnosisscan.io/tx/${TX_HASH}` });
    expect(getPending(5)).toBeNull();
    expect(getSafeSendState(5)).toBeNull();
  });

  test('refuses below the threshold', async () => {
    await start(); // 1 of 2
    await expect(executeSafePending(5)).rejects.toThrow(/not enough signatures/i);
    expect(mockExecTransaction).not.toHaveBeenCalled();
  });

  test('a moved Safe nonce flips the transaction to a terminal superseded state', async () => {
    await readyPending();
    mockRpcRequest.mockResolvedValue('0x4'); // chain nonce > SafeTx nonce 3

    const state = await executeSafePending(5);

    expect(state.status).toBe('superseded');
    expect(mockExecTransaction).not.toHaveBeenCalled();
    // persisted: the board renders it terminal without another chain read
    expect(getSafeSendState(5).status).toBe('superseded');
    await expect(signSafePending(5, 4)).rejects.toThrow(/discard/i);
    // discard is the way out
    cancelSafeSend(5);
    expect(getSafeSendState(5)).toBeNull();
  });

  test("maps the executor's empty wallet to SAFE_NEEDS_FUNDS, signatures intact", async () => {
    await readyPending();
    mockExecTransaction.mockRejectedValueOnce(new Error('Insufficient funds for transaction'));

    await expect(executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_NEEDS_FUNDS' });
    expect(getPending(5).signatures).toHaveLength(2);
  });

  test('a failed broadcast keeps everything for a retry', async () => {
    await readyPending();
    mockExecTransaction.mockRejectedValueOnce(new Error('RPC down'));

    await expect(executeSafePending(5)).rejects.toThrow('RPC down');
    expect(getPending(5).signatures).toHaveLength(2);

    const state = await executeSafePending(5); // retry, no re-signing
    expect(state.status).toBe('executed');
    expect(mockCollectOwnerSignature).toHaveBeenCalledTimes(2); // from setup only
  });
});

describe('getSafeSendState / cancelSafeSend', () => {
  test('null when nothing is pending; cancel clears', async () => {
    expect(getSafeSendState(5)).toBeNull();
    await start();
    expect(getSafeSendState(5)).not.toBeNull();
    cancelSafeSend(5);
    expect(getSafeSendState(5)).toBeNull();
  });
});

describe('getAllSafeSendStates', () => {
  test('lists every pending SafeTx, oldest first', async () => {
    expect(getAllSafeSendStates()).toEqual([]);
    await start();
    const states = getAllSafeSendStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ safeIndex: 5, collected: 1, threshold: 2 });
  });
});
