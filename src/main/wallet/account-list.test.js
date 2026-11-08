const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDialog = { showSaveDialog: jest.fn(), showOpenDialog: jest.fn() };
let mockDownloads;
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockDownloads) },
  dialog: mockDialog,
}));

const mockIdentityManager = {
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  getDerivedWallets: jest.fn(),
  previewAccountListImport: jest.fn(),
  applyAccountListImport: jest.fn(),
};
jest.mock('../identity-manager', () => mockIdentityManager);

const mockPredictSafeAddress = jest.fn();
jest.mock('./safe/safe-executor', () => ({ predictSafeAddress: mockPredictSafeAddress }));
jest.mock('./safe/safe-service', () => ({ DEPLOY_CHAIN_ID: 100 }));

const {
  ACCOUNT_LIST_FORMAT,
  INVALID_ACCOUNT_LIST,
  buildAccountList,
  defaultFileName,
  parseAccountList,
  checkSafeAddresses,
  exportAccountList,
  openAccountList,
  previewImport,
  importAccountList,
} = require('./account-list');

const MAIN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SECOND = '0x8C8d35429F74ec245F8Ef2f4Fd1e551cFF97d650';
const LEDGER = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const PHONE = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';
const SAFE = '0x41aD4887971f90BB3fE4d83eCa65177281283261';

const WALLETS = [
  { index: 0, name: 'Main Wallet', address: MAIN, type: 'mnemonic' },
  { index: 1, name: 'Wallet 2', address: SECOND.toLowerCase(), type: 'mnemonic' },
  {
    index: 1000000,
    name: 'From MetaMask',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    type: 'mnemonic',
    path: "m/44'/60'/0'/0/2",
  },
  { index: 1000001, name: 'Ledger 1', address: LEDGER, type: 'ledger', path: "44'/60'/0'/0/0" },
  { index: 1000002, name: 'Pixel', address: PHONE, type: 'remote' },
  {
    index: 1000003,
    name: 'Joint',
    address: SAFE,
    type: 'safe',
    owners: [0, 1000001],
    threshold: 1,
    saltNonce: '42',
    deployed: { 100: true },
  },
];

const listText = (accounts, extra = {}) =>
  JSON.stringify({ format: ACCOUNT_LIST_FORMAT, version: 1, accounts, ...extra });

describe('buildAccountList', () => {
  test('names, addresses and the public details, never a key', () => {
    expect(buildAccountList(WALLETS)).toEqual({
      format: 'freedom-account-list',
      version: 1,
      accounts: [
        { type: 'mnemonic', name: 'Main Wallet', address: MAIN, path: "m/44'/60'/0'/0/0" },
        { type: 'mnemonic', name: 'Wallet 2', address: SECOND, path: "m/44'/60'/1'/0/0" },
        {
          type: 'mnemonic',
          name: 'From MetaMask',
          address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          path: "m/44'/60'/0'/0/2",
        },
        { type: 'ledger', name: 'Ledger 1', address: LEDGER, path: "44'/60'/0'/0/0" },
        { type: 'remote', name: 'Pixel', address: PHONE },
        // Owners by address: indexes only mean something on this computer.
        {
          type: 'safe',
          name: 'Joint',
          address: SAFE,
          owners: [MAIN, LEDGER],
          threshold: 1,
          saltNonce: '42',
        },
      ],
    });
  });

  test('leaves out an account with no address yet, and a Safe whose owner is gone', () => {
    const list = buildAccountList([
      { index: 0, name: 'Main Wallet', address: MAIN, type: 'mnemonic' },
      { index: 2, name: 'Legacy', address: null, type: 'mnemonic' },
      { ...WALLETS[5], owners: [0, 7] },
    ]);
    expect(list.accounts.map((account) => account.name)).toEqual(['Main Wallet']);
  });

  test('what it writes reads back as the same accounts', () => {
    const list = buildAccountList(WALLETS);
    // A Ledger's path is there for the user; import never adds a Ledger.
    const expected = list.accounts.map(({ path: walletPath, ...account }) =>
      account.type === 'ledger'
        ? account
        : { ...account, ...(walletPath ? { path: walletPath } : {}) }
    );
    expect(parseAccountList(JSON.stringify(list))).toEqual(expected);
  });
});

describe('parseAccountList', () => {
  const valid = [
    { type: 'mnemonic', name: 'Main Wallet', address: MAIN, path: "m/44'/60'/0'/0/0" },
  ];
  const safeEntry = (overrides) => ({
    type: 'safe',
    name: 'Joint',
    address: SAFE,
    owners: [MAIN, LEDGER],
    threshold: 1,
    saltNonce: '42',
    ...overrides,
  });

  test('trims names, cuts them to what the name fields take, and canonicalises paths', () => {
    const [account] = parseAccountList(
      listText([
        {
          type: 'mnemonic',
          name: `  ${'é'.repeat(40)}  `,
          address: MAIN.toLowerCase(),
          path: "44'/60'/03'/0/0",
        },
      ])
    );
    expect(account).toEqual({
      type: 'mnemonic',
      name: 'é'.repeat(32),
      address: MAIN,
      path: "m/44'/60'/3'/0/0",
    });
  });

  test('keeps only the fields import uses', () => {
    const [ledger] = parseAccountList(
      listText([
        { type: 'ledger', name: 'L', address: LEDGER, path: "44'/60'/0'/0/0", privateKey: '0x01' },
      ])
    );
    expect(ledger).toEqual({ type: 'ledger', name: 'L', address: LEDGER });
  });

  test.each([
    ['not JSON', 'nope'],
    ['another format', JSON.stringify({ format: 'something-else', version: 1, accounts: valid })],
    ['a newer version', listText(valid, { version: 2 })],
    ['no accounts', listText([])],
    [
      'accounts not a list',
      JSON.stringify({ format: ACCOUNT_LIST_FORMAT, version: 1, accounts: {} }),
    ],
    ['a bad checksum', listText([{ ...valid[0], address: MAIN.replace('f39F', 'F39f') }])],
    ['an empty name', listText([{ ...valid[0], name: '   ' }])],
    ['an unknown type', listText([{ ...valid[0], type: 'watch' }])],
    ['a malformed path', listText([{ ...valid[0], path: 'm/44/x' }])],
    ['a missing path', listText([{ type: 'mnemonic', name: 'A', address: MAIN }])],
    ['the same address twice', listText([valid[0], { ...valid[0], name: 'Again' }])],
    ['a Safe threshold Freedom never makes', listText([safeEntry({ threshold: 2 })])],
    ['a Safe owner twice', listText([safeEntry({ owners: [MAIN, MAIN.toLowerCase()] })])],
    ['a Safe salt that is not a number', listText([safeEntry({ saltNonce: '0x2a' })])],
    ['a Safe owner that is not an address', listText([safeEntry({ owners: [MAIN, 'bob'] })])],
    [
      'a Safe owned by a Safe',
      listText([safeEntry(), safeEntry({ name: 'Outer', address: PHONE, owners: [MAIN, SAFE] })]),
    ],
  ])('refuses %s', (_label, text) => {
    expect(() => parseAccountList(text)).toThrow(
      expect.objectContaining({ code: INVALID_ACCOUNT_LIST })
    );
  });
});

test('the default file name carries the local date', () => {
  expect(defaultFileName(new Date(2026, 10, 8, 23, 59))).toBe('freedom-accounts-2026-11-08.json');
});

describe('checkSafeAddresses', () => {
  beforeEach(() => {
    mockPredictSafeAddress.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const safeAccount = {
    type: 'safe',
    name: 'Joint',
    address: SAFE,
    owners: [MAIN, LEDGER],
    threshold: 1,
    saltNonce: '42',
  };

  test('predicts on Gnosis from the owners, threshold and salt', async () => {
    mockPredictSafeAddress.mockResolvedValue(SAFE);
    const checks = new Map();
    await checkSafeAddresses([safeAccount], checks);
    expect(mockPredictSafeAddress).toHaveBeenCalledWith({
      owners: [MAIN, LEDGER],
      threshold: 1,
      saltNonce: '42',
      chainId: 100,
    });
    expect(checks.get(SAFE.toLowerCase())).toBe(true);
  });

  test('a different predicted address is a mismatch', async () => {
    mockPredictSafeAddress.mockResolvedValue(PHONE);
    const checks = new Map();
    await checkSafeAddresses([safeAccount], checks);
    expect(checks.get(SAFE.toLowerCase())).toBe(false);
  });

  test('a failed or slow check leaves the Safe unchecked', async () => {
    mockPredictSafeAddress.mockRejectedValueOnce(new Error('no RPC'));
    const checks = new Map();
    await checkSafeAddresses([safeAccount], checks);
    expect(checks.has(SAFE.toLowerCase())).toBe(false);

    mockPredictSafeAddress.mockReturnValueOnce(new Promise(() => {}));
    await checkSafeAddresses([safeAccount], checks, { timeoutMs: 5 });
    expect(checks.has(SAFE.toLowerCase())).toBe(false);
  });
});

describe('the dialogs and the import session', () => {
  let tmpDir;
  const win = { id: 'window' };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-list-'));
    mockDownloads = tmpDir;
    mockDialog.showSaveDialog.mockReset();
    mockDialog.showOpenDialog.mockReset();
    mockPredictSafeAddress.mockReset();
    mockIdentityManager.getDerivedWallets.mockResolvedValue(WALLETS);
    mockIdentityManager.previewAccountListImport.mockReset();
    mockIdentityManager.applyAccountListImport.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeList = (name, text) => {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, text, 'utf-8');
    return filePath;
  };
  const pick = (filePath) =>
    mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });

  test('export offers a dated file in Downloads and writes the list there', async () => {
    const target = path.join(tmpDir, 'mine.json');
    mockDialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });

    const result = await exportAccountList(win);

    const [owner, options] = mockDialog.showSaveDialog.mock.calls[0];
    expect(owner).toBe(win);
    expect(path.dirname(options.defaultPath)).toBe(tmpDir);
    expect(path.basename(options.defaultPath)).toMatch(
      /^freedom-accounts-\d{4}-\d{2}-\d{2}\.json$/
    );
    expect(result).toEqual({ fileName: 'mine.json', count: 6 });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual(buildAccountList(WALLETS));
  });

  test('export canceled writes nothing', async () => {
    mockDialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    await expect(exportAccountList(null)).resolves.toEqual({ canceled: true });
    // No window: the options are the only argument.
    expect(mockDialog.showSaveDialog.mock.calls[0]).toHaveLength(1);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  test('open canceled starts no session', async () => {
    mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(openAccountList(win)).resolves.toEqual({ canceled: true });
  });

  test("a file that isn't an account list, or is far too big, is refused", async () => {
    pick(writeList('notes.json', '{"notes": []}'));
    await expect(openAccountList(win)).rejects.toMatchObject({ code: INVALID_ACCOUNT_LIST });

    pick(writeList('huge.json', ' '.repeat(1024 * 1024 + 1)));
    await expect(openAccountList(win)).rejects.toMatchObject({ code: INVALID_ACCOUNT_LIST });
  });

  test('preview checks only the Safes that could be added, once; import uses those checks', async () => {
    const list = buildAccountList(WALLETS);
    pick(writeList('backup.json', JSON.stringify(list)));
    const opened = await openAccountList(win);
    expect(opened).toEqual({ token: expect.any(String), fileName: 'backup.json', count: 6 });

    const safeRow = { kind: 'skip', reason: 'safe-unchecked', address: SAFE, name: 'Joint' };
    mockIdentityManager.previewAccountListImport
      .mockResolvedValueOnce([safeRow])
      .mockResolvedValueOnce([{ ...safeRow, kind: 'add', reason: undefined }])
      .mockResolvedValueOnce([{ ...safeRow, kind: 'add', reason: undefined }]);
    mockPredictSafeAddress.mockResolvedValue(SAFE);

    const preview = await previewImport(opened.token);
    expect(preview).toMatchObject({ fileName: 'backup.json', count: 6, rows: [{ kind: 'add' }] });
    expect(mockPredictSafeAddress).toHaveBeenCalledTimes(1);
    // The planner gets the file's accounts and the check that was made.
    const [accounts, { safeChecks }] = mockIdentityManager.previewAccountListImport.mock.calls[1];
    expect(accounts).toEqual(parseAccountList(JSON.stringify(list)));
    expect(safeChecks.get(SAFE.toLowerCase())).toBe(true);

    // After an unlock the preview runs again without asking the chain.
    await previewImport(opened.token);
    expect(mockPredictSafeAddress).toHaveBeenCalledTimes(1);

    mockIdentityManager.applyAccountListImport.mockResolvedValueOnce([{ kind: 'add' }]);
    await expect(importAccountList(opened.token)).resolves.toEqual({ rows: [{ kind: 'add' }] });
    expect(mockIdentityManager.applyAccountListImport.mock.calls[0][1].safeChecks).toBe(safeChecks);

    // The session ends with the import.
    await expect(previewImport(opened.token)).rejects.toThrow('Choose the file again');
  });

  test('an unknown token is refused', async () => {
    await expect(importAccountList('made-up')).rejects.toThrow('Choose the file again');
    expect(mockIdentityManager.applyAccountListImport).not.toHaveBeenCalled();
  });
});
