const { createIpcMainMock } = require('../../../../test/helpers/main-process-test-utils');

const mockIpcMain = createIpcMainMock();
const mockListAccounts = jest.fn();
const mockCheckLedgerAccounts = jest.fn();

jest.mock('electron', () => ({ ipcMain: mockIpcMain }));
jest.mock('./transport', () => ({ listAccounts: (...args) => mockListAccounts(...args) }));
jest.mock('./account-checks', () => ({ checkLedgerAccounts: (...args) => mockCheckLedgerAccounts(...args) }));

const { registerLedgerIpc } = require('./ipc');

const ACCOUNTS = [{ path: "44'/60'/0'/0/0", address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }];

beforeAll(() => registerLedgerIpc());

beforeEach(() => {
  mockListAccounts.mockReset().mockResolvedValue(ACCOUNTS);
  mockCheckLedgerAccounts.mockReset().mockResolvedValue([]);
});

describe('ledger:get-accounts', () => {
  test('a connected device also checks the unchecked Ledger records (#1065)', async () => {
    const mismatched = [{ index: 1000001, name: 'Planted', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', path: "44'/60'/1'/0/0" }];
    mockCheckLedgerAccounts.mockResolvedValue(mismatched);

    await expect(
      mockIpcMain.invoke('ledger:get-accounts', { scheme: 'live', start: 0, count: 5, checkRecords: true })
    ).resolves.toEqual({
      success: true,
      accounts: ACCOUNTS,
      mismatched,
    });
    expect(mockCheckLedgerAccounts).toHaveBeenCalledTimes(1);
    // The check flag is main's, not the transport's.
    expect(mockListAccounts).toHaveBeenCalledWith({ scheme: 'live', start: 0, count: 5 });
  });

  test('a page that does not ask (Load more, the Safe board) is not checked', async () => {
    mockCheckLedgerAccounts.mockResolvedValue([{ index: 1000001, name: 'Planted' }]);
    await expect(
      mockIpcMain.invoke('ledger:get-accounts', { scheme: 'live', start: 5, count: 5 })
    ).resolves.toEqual({ success: true, accounts: ACCOUNTS, mismatched: [] });
    await expect(
      mockIpcMain.invoke('ledger:get-accounts', { scheme: 'live', start: 0, count: 1 })
    ).resolves.toEqual({ success: true, accounts: ACCOUNTS, mismatched: [] });
    // Only a literal `true` asks; a truthy string from the renderer doesn't.
    await mockIpcMain.invoke('ledger:get-accounts', { checkRecords: 'yes' });
    expect(mockCheckLedgerAccounts).not.toHaveBeenCalled();
  });

  test('a failed check does not fail discovery', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCheckLedgerAccounts.mockRejectedValue(new Error('unplugged'));
    await expect(mockIpcMain.invoke('ledger:get-accounts', { checkRecords: true })).resolves.toEqual({
      success: true,
      accounts: ACCOUNTS,
      mismatched: [],
    });
  });

  test('no device: discovery fails and nothing is checked', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockListAccounts.mockRejectedValue(Object.assign(new Error('No Ledger device found.'), { code: 'LEDGER_DEVICE_NOT_FOUND' }));
    await expect(mockIpcMain.invoke('ledger:get-accounts', { checkRecords: true })).resolves.toMatchObject({
      success: false,
      code: 'LEDGER_DEVICE_NOT_FOUND',
    });
    expect(mockCheckLedgerAccounts).not.toHaveBeenCalled();
  });
});
