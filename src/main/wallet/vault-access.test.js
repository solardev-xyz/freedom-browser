// withVaultAccount: the guard every vault-account signing goes through. It
// hands the operation a key reference for the identity core (freedom-core
// design 0002); no key reaches JS.
const mockResetVaultAutoLockTimer = jest.fn();
const mockGetWalletRecord = jest.fn();

jest.mock('../identity-manager', () => ({
  getWalletRecord: (...args) => mockGetWalletRecord(...args),
  // Mirrors identity-manager's HARDWARE_INDEX_BASE (inlined: jest.mock
  // factories may not close over out-of-scope constants).
  isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger' },
}));
jest.mock('../vault-timer', () => ({
  resetVaultAutoLockTimer: mockResetVaultAutoLockTimer,
}));

const { withVaultAccount } = require('./vault-access');

beforeEach(() => {
  mockGetWalletRecord.mockReset().mockReturnValue(null);
  mockResetVaultAutoLockTimer.mockClear();
});

describe('withVaultAccount', () => {
  test('passes the account key reference and returns the result', async () => {
    const operation = jest.fn(async (key) => `signed with ${key.kind} ${key.index}`);
    await expect(withVaultAccount(3, operation)).resolves.toBe('signed with account 3');
    expect(operation).toHaveBeenCalledWith({ kind: 'account', index: 3 });
  });

  test('resets the auto-lock timer on success', async () => {
    await withVaultAccount(0, () => undefined);
    expect(mockResetVaultAutoLockTimer).toHaveBeenCalledTimes(1);
  });

  test('a locked vault (refused by the core) does not reset the timer', async () => {
    const locked = Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
    await expect(
      withVaultAccount(0, async () => {
        throw locked;
      })
    ).rejects.toBe(locked);
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });

  test('does not reset the timer when the operation throws', async () => {
    // Only successful work extends the auto-lock lease. Failed signs or
    // sends shouldn't keep an idle vault alive.
    await expect(
      withVaultAccount(0, () => {
        throw new Error('signing failed');
      })
    ).rejects.toThrow('signing failed');
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });

  test.each([
    ['ledger', '0xstax'],
    ['remote', '0xphone'],
  ])('refuses a %s account index', async (type, address) => {
    // The chokepoint guard: even a caller that bypasses the signer factory
    // must never sign with a mnemonic key at a device account's index.
    mockGetWalletRecord.mockReturnValue({ index: 3, type, address });
    const operation = jest.fn();
    await expect(withVaultAccount(3, operation)).rejects.toThrow(
      'This account keeps its key on another device'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  test('refuses a deleted hardware account', async () => {
    // Deleting a Ledger removes its record, so the record-type guard no
    // longer fires. The index range must be decisive on its own: otherwise
    // a stale reference signs with a phantom key at m/44'/60'/1000000'/0/0.
    mockGetWalletRecord.mockReturnValue(null);
    const operation = jest.fn();
    await expect(withVaultAccount(1000000, operation)).rejects.toThrow(
      'This account keeps its key on another device'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  test.each([
    ['negative', -1],
    ['non-integer', 1.5],
    ['string', '0'],
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
  ])('rejects %s walletIndex without running the operation', async (_label, badIndex) => {
    const operation = jest.fn();
    await expect(withVaultAccount(badIndex, operation)).rejects.toThrow('Invalid wallet index');
    expect(operation).not.toHaveBeenCalled();
    expect(mockResetVaultAutoLockTimer).not.toHaveBeenCalled();
  });
});
