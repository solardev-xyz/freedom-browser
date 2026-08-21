const mockGetAddress = jest.fn();
const mockClose = jest.fn(async () => {});
const mockOpen = jest.fn();
const mockList = jest.fn();
const mockEthConstructed = jest.fn();

jest.mock('@ledgerhq/hw-transport-node-hid', () => ({
  default: {
    open: (...args) => mockOpen(...args),
    list: (...args) => mockList(...args),
  },
}));
jest.mock('@ledgerhq/hw-app-eth', () => ({
  default: class MockEth {
    constructor(transport, scrambleKey, loadConfig) {
      this.transport = transport;
      mockEthConstructed({ scrambleKey, loadConfig });
    }
    getAddress(...args) {
      return mockGetAddress(...args);
    }
  },
}));

const { listAccounts, withEthApp, OFFLINE_LOAD_CONFIG } = require('./transport');
const { LEDGER_ERROR_CODES } = require('./errors');

beforeEach(() => {
  mockOpen.mockReset().mockResolvedValue({ close: mockClose });
  mockList.mockReset();
  mockGetAddress.mockReset();
  mockClose.mockClear();
  mockEthConstructed.mockClear();
});

describe('listAccounts', () => {
  test('walks the Ledger Live path scheme without on-device display', async () => {
    mockGetAddress.mockImplementation(async (path) => ({ address: `0xaddr:${path}` }));

    const accounts = await listAccounts({ scheme: 'live', start: 0, count: 3 });

    expect(accounts).toEqual([
      { path: "44'/60'/0'/0/0", address: "0xaddr:44'/60'/0'/0/0" },
      { path: "44'/60'/1'/0/0", address: "0xaddr:44'/60'/1'/0/0" },
      { path: "44'/60'/2'/0/0", address: "0xaddr:44'/60'/2'/0/0" },
    ]);
    expect(mockGetAddress).toHaveBeenCalledWith("44'/60'/0'/0/0", false);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test('supports the legacy path scheme and paging', async () => {
    mockGetAddress.mockImplementation(async (path) => ({ address: `0xaddr:${path}` }));

    const accounts = await listAccounts({ scheme: 'legacy', start: 5, count: 2 });

    expect(accounts.map((a) => a.path)).toEqual(["44'/60'/0'/5", "44'/60'/0'/6"]);
  });

  test('rejects unknown schemes before touching the device', async () => {
    await expect(listAccounts({ scheme: 'nope' })).rejects.toThrow('Unknown derivation scheme');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test('maps app-not-open APDU errors and still closes the transport', async () => {
    const apduError = new Error('0x6511');
    apduError.statusCode = 0x6511;
    mockGetAddress.mockRejectedValue(apduError);

    await expect(listAccounts()).rejects.toMatchObject({
      code: LEDGER_ERROR_CODES.ETH_APP_NOT_OPEN,
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test('maps transport-open failures to DEVICE_NOT_FOUND', async () => {
    mockOpen.mockRejectedValue(new Error('cannot open device with path'));
    await expect(listAccounts()).rejects.toMatchObject({
      code: LEDGER_ERROR_CODES.DEVICE_NOT_FOUND,
    });
  });
});

describe('hosted clear-signing services', () => {
  test('every Eth app is built with the offline load config', async () => {
    mockGetAddress.mockResolvedValue({ address: '0xok' });

    await withEthApp((eth) => eth.getAddress('x', false));

    expect(mockEthConstructed).toHaveBeenCalledTimes(1);
    expect(mockEthConstructed.mock.calls[0][0].loadConfig).toBe(OFFLINE_LOAD_CONFIG);
    // scrambleKey stays at hw-app-eth's own default.
    expect(mockEthConstructed.mock.calls[0][0].scrambleKey).toBeUndefined();
  });

  test('the offline config nulls every service URL the installed hw-app-eth would call', () => {
    // Resolved against the library's own defaults: a URL we forget to
    // null (or one a future version adds) falls back to Ledger's hosted
    // endpoint and would leak signing metadata off the machine.
    const { getLoadConfig } = require('@ledgerhq/hw-app-eth/lib/services/ledger/loadConfig');
    const resolved = getLoadConfig(OFFLINE_LOAD_CONFIG);

    const urlKeys = Object.keys(resolved).filter((key) => /URL$/.test(key));
    expect(urlKeys.length).toBeGreaterThan(0);
    for (const key of urlKeys) {
      expect(resolved[key]).toBeNull();
    }
  });
});

describe('withEthApp serialization', () => {
  test('device operations run one at a time, in order', async () => {
    const events = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = withEthApp(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 1;
    });
    const second = withEthApp(async () => {
      events.push('second:start');
      return 2;
    });

    // Give the second task a chance to (incorrectly) start early.
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('a failed operation does not wedge the queue', async () => {
    mockGetAddress.mockRejectedValueOnce(Object.assign(new Error('rejected'), { statusCode: 0x6985 }));
    await expect(withEthApp((eth) => eth.getAddress('x', false))).rejects.toMatchObject({
      code: LEDGER_ERROR_CODES.USER_REJECTED,
    });

    mockGetAddress.mockResolvedValueOnce({ address: '0xok' });
    await expect(withEthApp((eth) => eth.getAddress('x', false))).resolves.toEqual({ address: '0xok' });
  });
});
