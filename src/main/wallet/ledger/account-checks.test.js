/**
 * #1065: the Ledger records no device has matched yet are checked
 * against the device the first time one is connected.
 */

const mockReadAddresses = jest.fn();
const mockGetLedgerRecordsToCheck = jest.fn();
const mockRecordLedgerAddressCheck = jest.fn();

jest.mock('./transport', () => ({ readAddresses: (...args) => mockReadAddresses(...args) }));
jest.mock('../../identity-manager', () => ({
  getLedgerRecordsToCheck: (...args) => mockGetLedgerRecordsToCheck(...args),
  recordLedgerAddressCheck: (...args) => mockRecordLedgerAddressCheck(...args),
  ADDRESS_CHECK: { UNCHECKED: 'unchecked', MATCHED: 'matched', MISMATCHED: 'mismatched' },
}));

const { checkLedgerAccounts } = require('./account-checks');

const HELD = {
  index: 1000000,
  name: 'Held',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  path: "44'/60'/0'/0/0",
  addressCheck: 'unchecked',
};
const PLANTED = {
  index: 1000001,
  name: 'Planted',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  path: "44'/60'/1'/0/0",
  addressCheck: 'unchecked',
};

beforeEach(() => {
  mockReadAddresses.mockReset();
  mockGetLedgerRecordsToCheck.mockReset();
  // The real one's answers: a match is matched, a mismatch mismatched.
  mockRecordLedgerAddressCheck.mockReset().mockImplementation((_index, matched) =>
    matched ? 'matched' : 'mismatched');
});

test('with nothing to check, the device is not touched', async () => {
  mockGetLedgerRecordsToCheck.mockReturnValue([]);
  await expect(checkLedgerAccounts()).resolves.toEqual([]);
  expect(mockReadAddresses).not.toHaveBeenCalled();
});

test('each record is read at its own path and its result kept; mismatches come back', async () => {
  mockGetLedgerRecordsToCheck.mockReturnValue([HELD, PLANTED]);
  // The device holds HELD's address at its path, and another one at PLANTED's.
  mockReadAddresses.mockResolvedValue([
    HELD.address.toLowerCase(),
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  ]);

  await expect(checkLedgerAccounts()).resolves.toEqual([
    { index: PLANTED.index, name: 'Planted', address: PLANTED.address, path: PLANTED.path },
  ]);
  expect(mockReadAddresses).toHaveBeenCalledWith([HELD.path, PLANTED.path]);
  expect(mockRecordLedgerAddressCheck).toHaveBeenCalledWith(HELD.index, true);
  expect(mockRecordLedgerAddressCheck).toHaveBeenCalledWith(PLANTED.index, false);
});

test('a record whose state stays matched is not reported', async () => {
  mockGetLedgerRecordsToCheck.mockReturnValue([PLANTED]);
  mockReadAddresses.mockResolvedValue(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8']);
  mockRecordLedgerAddressCheck.mockReturnValue('matched');
  await expect(checkLedgerAccounts()).resolves.toEqual([]);
});

test('a record without a path is left unchecked', async () => {
  mockGetLedgerRecordsToCheck.mockReturnValue([{ ...PLANTED, path: undefined }]);
  await expect(checkLedgerAccounts()).resolves.toEqual([]);
  expect(mockReadAddresses).not.toHaveBeenCalled();
  expect(mockRecordLedgerAddressCheck).not.toHaveBeenCalled();
});

test('a device that cannot be read changes nothing', async () => {
  mockGetLedgerRecordsToCheck.mockReturnValue([HELD]);
  mockReadAddresses.mockRejectedValue(Object.assign(new Error('locked'), { code: 'LEDGER_DEVICE_LOCKED' }));
  await expect(checkLedgerAccounts()).rejects.toMatchObject({ code: 'LEDGER_DEVICE_LOCKED' });
  expect(mockRecordLedgerAddressCheck).not.toHaveBeenCalled();
});
