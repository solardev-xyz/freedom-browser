const { createIpcMainMock } = require('../../../../test/helpers/main-process-test-utils');

const mockIpcMain = createIpcMainMock();
const mockListAccounts = jest.fn();
const mockCheckLedgerAccounts = jest.fn();
const mockDiscoverAccounts = jest.fn();
const mockBackend = { kind: 'js' };

jest.mock('electron', () => ({ ipcMain: mockIpcMain }));
jest.mock('./transport', () => ({ listAccounts: (...args) => mockListAccounts(...args) }));
jest.mock('./account-checks', () => ({ checkLedgerAccounts: (...args) => mockCheckLedgerAccounts(...args) }));
jest.mock('./ledger-backend-kind', () => ({ ledgerBackendKind: () => mockBackend.kind }));
jest.mock('./core-accounts', () => ({ discoverAccounts: (...args) => mockDiscoverAccounts(...args) }));

const { registerLedgerIpc } = require('./ipc');

const ACCOUNTS = [{ path: "44'/60'/0'/0/0", address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }];

beforeAll(() => registerLedgerIpc());

beforeEach(() => {
  mockBackend.kind = 'js';
  mockListAccounts.mockReset().mockResolvedValue(ACCOUNTS);
  mockCheckLedgerAccounts.mockReset().mockResolvedValue([]);
  mockDiscoverAccounts.mockReset();
});

describe('ledger:get-accounts', () => {
  test('a connected device also checks the unchecked Ledger records (#1065)', async () => {
    const mismatched = [{ index: 1000001, name: 'Planted', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', path: "44'/60'/1'/0/0" }];
    mockCheckLedgerAccounts.mockResolvedValue(mismatched);

    await expect(mockIpcMain.invoke('ledger:get-accounts', { scheme: 'live' })).resolves.toEqual({
      success: true,
      accounts: ACCOUNTS,
      mismatched,
    });
    expect(mockCheckLedgerAccounts).toHaveBeenCalledTimes(1);
  });

  test('a failed check does not fail discovery', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCheckLedgerAccounts.mockRejectedValue(new Error('unplugged'));
    await expect(mockIpcMain.invoke('ledger:get-accounts', {})).resolves.toEqual({
      success: true,
      accounts: ACCOUNTS,
      mismatched: [],
    });
  });

  test('no device: discovery fails and nothing is checked', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockListAccounts.mockRejectedValue(Object.assign(new Error('No Ledger device found.'), { code: 'LEDGER_DEVICE_NOT_FOUND' }));
    await expect(mockIpcMain.invoke('ledger:get-accounts', {})).resolves.toMatchObject({
      success: false,
      code: 'LEDGER_DEVICE_NOT_FOUND',
    });
    expect(mockCheckLedgerAccounts).not.toHaveBeenCalled();
  });
});

describe('ledger:get-accounts on the core’s backend (FREEDOM_LEDGER_BACKEND=core, design 0016)', () => {
  beforeEach(() => {
    mockBackend.kind = 'core';
  });

  test('discovery is the core’s ledger.accounts, its check the core’s: account-checks.js is not run', async () => {
    const mismatched = [{ index: 1000001, name: 'Planted', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', path: "44'/60'/1'/0/0" }];
    const accounts = ACCOUNTS.map((account) => ({ ...account, scheme: 'live', index: 0 }));
    mockDiscoverAccounts.mockResolvedValue({ accounts, mismatched });

    await expect(mockIpcMain.invoke('ledger:get-accounts', { scheme: 'live', start: 0, count: 1 })).resolves.toEqual({
      success: true,
      accounts,
      mismatched,
    });
    expect(mockDiscoverAccounts).toHaveBeenCalledWith({ scheme: 'live', start: 0, count: 1 });
    expect(mockListAccounts).not.toHaveBeenCalled();
    expect(mockCheckLedgerAccounts).not.toHaveBeenCalled();
  });

  test('a failure carries its LEDGER_* code, as on the JS backend', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDiscoverAccounts.mockRejectedValue(
      Object.assign(new Error('Ledger is busy with another request. Finish or dismiss it on the device.'), { code: 'LEDGER_BUSY' })
    );
    await expect(mockIpcMain.invoke('ledger:get-accounts')).resolves.toEqual({
      success: false,
      error: 'Ledger is busy with another request. Finish or dismiss it on the device.',
      code: 'LEDGER_BUSY',
    });
    expect(mockListAccounts).not.toHaveBeenCalled();
  });
});

describe("the hash-only notice's report and Cancel (design 0016, Q23; LDG-3's PR 11)", () => {
  test('registered whichever backend runs; a report naming no notice changes nothing', () => {
    expect(mockIpcMain.listeners.has('ledger:hash-only-notice-shown')).toBe(true);
    expect(mockIpcMain.listeners.has('ledger:hash-only-notice-cancel')).toBe(true);
    expect(() => mockIpcMain.emit('ledger:hash-only-notice-shown', { sender: {} }, { id: 'ab'.repeat(16) })).not.toThrow();
    expect(() => mockIpcMain.emit('ledger:hash-only-notice-cancel', { sender: {} }, { id: 'ab'.repeat(16) })).not.toThrow();
  });
});
