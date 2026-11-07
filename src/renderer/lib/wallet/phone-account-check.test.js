/**
 * The chrome's side of the phone account check (#1078): main has the
 * phone sign a check before a phone account is added, and a phone
 * account added before that is unchecked until its phone shows it holds
 * it. Only a matched one can own a Safe. Wallet Settings runs the check;
 * the wallet list and the Safe screen say which accounts aren't checked,
 * for Ledger accounts (#1065) as well as phone ones.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const PHONE = {
  index: 1000001,
  name: 'My Phone',
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  type: 'remote',
};

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
  jest.restoreAllMocks();
});

describe('Wallet Settings phone check', () => {
  const loadSettings = async (wallet) => {
    jest.resetModules();

    const elements = {
      'sidebar-wallet-settings': createElement('div', { classes: ['hidden'] }),
      'wallet-settings-back': createElement('button'),
      'wallet-settings-name': createElement('div'),
      'wallet-settings-address': createElement('code'),
      'wallet-settings-delete': createElement('button'),
      'wallet-settings-btn': createElement('button'),
      'wallet-settings-phone-check': createElement('div', { classes: ['hidden'] }),
      'wallet-settings-phone-check-text': createElement('p'),
      'wallet-settings-phone-check-btn': createElement('button'),
      'wallet-settings-phone-check-error': createElement('div', { classes: ['hidden'] }),
    };
    const checkAccount = jest.fn();
    global.window = { remoteSigner: { checkAccount } };
    global.document = createDocument({ elementsById: elements });

    const walletState = {
      identityView: createElement('div'),
      derivedWallets: [{ index: 0, name: 'Main Wallet', address: '0x01' }, wallet],
      activeWalletIndex: wallet.index,
    };
    const loadDerivedWallets = jest.fn(async () => {});
    jest.doMock('./wallet-state.js', () => ({ walletState, registerScreenHider: jest.fn() }));
    jest.doMock('./signature-flight.js', () => ({ refuseSubscreenWhileInFlight: jest.fn(() => false) }));
    jest.doMock('./wallet-selector.js', () => ({ selectWallet: jest.fn(), loadDerivedWallets }));

    const mod = await import('./wallet-settings.js');
    mod.initWalletSettings(jest.fn());
    elements['wallet-settings-btn'].dispatch('click');

    return {
      mod,
      checkAccount,
      loadDerivedWallets,
      section: elements['wallet-settings-phone-check'],
      text: elements['wallet-settings-phone-check-text'],
      button: elements['wallet-settings-phone-check-btn'],
      error: elements['wallet-settings-phone-check-error'],
    };
  };

  test('an unchecked phone account is offered the check, and a match is kept', async () => {
    const wallet = { ...PHONE, addressCheck: 'unchecked' };
    const { checkAccount, loadDerivedWallets, section, text, button } = await loadSettings(wallet);

    expect(section.classList.contains('hidden')).toBe(false);
    expect(text.textContent).toMatch(/hasn't yet shown that it holds this account, so it can't own a Safe/);

    checkAccount.mockResolvedValue({ success: true, wallet: { ...wallet, addressCheck: 'matched' } });
    button.dispatch('click');
    await flushMicrotasks();

    expect(checkAccount).toHaveBeenCalledWith(PHONE.index);
    expect(loadDerivedWallets).toHaveBeenCalled();
    expect(wallet.addressCheck).toBe('matched');
    expect(text.textContent).toBe('Checked: your phone holds this account.');
    expect(button.classList.contains('hidden')).toBe(true);
  });

  test('a phone that answers from another account leaves the account marked, not deleted', async () => {
    const wallet = { ...PHONE, addressCheck: 'unchecked' };
    const { checkAccount, loadDerivedWallets, section, text, button } = await loadSettings(wallet);

    checkAccount.mockResolvedValue({ success: true, wallet: { ...wallet, addressCheck: 'mismatched' } });
    button.dispatch('click');
    await flushMicrotasks();

    expect(loadDerivedWallets).toHaveBeenCalled();
    expect(wallet.addressCheck).toBe('mismatched');
    expect(section.classList.contains('hidden')).toBe(false);
    expect(text.textContent).toMatch(/last answered from a different account/);
  });

  test('no answer from the phone is shown and changes nothing', async () => {
    const wallet = { ...PHONE, addressCheck: 'unchecked' };
    const { checkAccount, loadDerivedWallets, button, error } = await loadSettings(wallet);

    checkAccount.mockResolvedValue({
      success: false,
      error: 'Your phone did not respond in time. Try again with a new QR code.',
      code: 'REMOTE_TIMEOUT',
    });
    button.dispatch('click');
    await flushMicrotasks();

    expect(error.classList.contains('hidden')).toBe(false);
    expect(error.textContent).toBe('Your phone did not respond in time. Try again with a new QR code.');
    expect(wallet.addressCheck).toBe('unchecked');
    expect(loadDerivedWallets).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  test('a matched phone account and other accounts show no check', async () => {
    const { section, button, checkAccount } = await loadSettings({ ...PHONE, addressCheck: 'matched' });
    expect(section.classList.contains('hidden')).toBe(true);
    button.dispatch('click');
    await flushMicrotasks();
    expect(checkAccount).not.toHaveBeenCalled();

    const { mod } = await loadSettings({ ...PHONE, addressCheck: 'mismatched' });
    expect(mod.phoneCheckStatus({ ...PHONE, addressCheck: 'mismatched' })).toMatch(/different account/);
    expect(mod.phoneCheckStatus({ index: 2, type: 'ledger', addressCheck: 'unchecked' })).toBeNull();
    expect(mod.phoneCheckStatus({ index: 0, name: 'Main Wallet' })).toBeNull();
  });
});

describe('the wallet list and the Safe screen', () => {
  const WALLETS = [
    { index: 0, name: 'Main Wallet', address: '0x0000000000000000000000000000000000000001' },
    { ...PHONE, addressCheck: 'unchecked' },
    { index: 1000002, name: 'Other Phone', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', type: 'remote', addressCheck: 'mismatched' },
    { index: 1000003, name: 'Checked Phone', address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', type: 'remote', addressCheck: 'matched' },
    // Ledger accounts carry the same states, with their own texts (#1065).
    { index: 1000004, name: 'Old Ledger', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', type: 'ledger', path: "44'/60'/0'/0/0", addressCheck: 'unchecked' },
    { index: 1000005, name: 'Other Ledger', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', type: 'ledger', path: "44'/60'/1'/0/0", addressCheck: 'mismatched' },
    { index: 1000006, name: 'Checked Ledger', address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', type: 'ledger', path: "44'/60'/2'/0/0", addressCheck: 'matched' },
  ];

  const stubWalletModules = (elementsById = {}) => {
    jest.resetModules();
    global.window = {};
    global.document = createDocument({ elementsById });
    const renderDeviceAccountList = jest.fn();
    jest.doMock('./wallet-state.js', () => ({
      walletState: {
        identityView: createElement('div'),
        derivedWallets: WALLETS,
        activeWalletIndex: 0,
        fullAddresses: {},
      },
      registerScreenHider: jest.fn(),
    }));
    jest.doMock('./balance-display.js', () => ({ refreshBalances: jest.fn() }));
    jest.doMock('./safe-status.js', () => ({ refreshSafeStatusCard: jest.fn() }));
    jest.doMock('./device-account-list.js', () => ({ renderDeviceAccountList }));
    return { renderDeviceAccountList };
  };

  test("the wallet list badges a phone or Ledger account that doesn't match", async () => {
    const list = createElement('div');
    stubWalletModules({
      'wallet-selector': createElement('div'),
      'wallet-selector-btn': createElement('button'),
      'wallet-selector-dropdown': createElement('div', { classes: ['hidden'] }),
      'wallet-selector-list': list,
    });
    jest.dontMock('./wallet-selector.js'); // the settings tests stand it in
    const { initWalletSelector, addressCheckBadge } = await import('./wallet-selector.js');

    initWalletSelector();
    global.document.getElementById('wallet-selector-btn').dispatch('click');

    // One row per wallet, in order (the fake DOM's escapeHtml drops the names).
    const rows = list.children.map((item) => item.innerHTML);
    expect(rows).toHaveLength(WALLETS.length);
    expect(rows[2]).toMatch(/Doesn't match/); // Other Phone: mismatched
    expect(rows[1]).not.toMatch(/Doesn't match/); // My Phone: unchecked
    expect(rows[3]).not.toMatch(/Doesn't match/); // Checked Phone
    expect(rows[5]).toMatch(/Doesn't match/); // Other Ledger: mismatched
    expect(rows[4]).not.toMatch(/Doesn't match/); // Old Ledger: unchecked
    expect(rows[6]).not.toMatch(/Doesn't match/); // Checked Ledger
    // Each kind's badge says what to do for that kind.
    expect(addressCheckBadge(WALLETS[2])).toMatch(/Your phone last answered from a different account/);
    expect(addressCheckBadge(WALLETS[5])).toMatch(/The Ledger last connected doesn't hold this address/);
    expect(addressCheckBadge({ index: 0, name: 'Main Wallet' })).toBe('');
    expect(addressCheckBadge({ index: 0, name: 'Main Wallet', addressCheck: 'mismatched' })).toBe('');
  });

  test("the Safe screen says which phone and Ledger owners aren't checked", async () => {
    const preset = createElement('button', { classes: ['safe-preset'], dataset: { threshold: '1', owners: '2' } });
    const { renderDeviceAccountList } = stubWalletModules({
      'sidebar-create-safe': createElement('div', { classes: ['hidden'] }),
      'create-safe-owner-list': createElement('div'),
      'create-safe-preset-standard': preset,
    });
    jest.doMock('./wallet-selector.js', () => ({
      loadDerivedWallets: jest.fn(),
      activateAddedWallet: jest.fn(),
    }));
    jest.doMock('./wallet-utils.js', () => ({
      truncateAddress: (address) => `${address.slice(0, 6)}…${address.slice(-4)}`,
      isSafeAccount: () => false,
      showInlineError: jest.fn(),
      hideInlineError: jest.fn(),
    }));
    const { initCreateSafe, openCreateSafe, ownerSubLabel } = await import('./create-safe.js');

    initCreateSafe();
    openCreateSafe();

    const accounts = renderDeviceAccountList.mock.calls.at(-1)[1];
    expect(accounts.map((account) => account.subLabel)).toEqual([
      '0x0000…0001',
      '0x7099…79C8 · not checked on your phone yet',
      '0x8335…2913 · your phone answered from another account',
      '0x2096…287C',
      '0x3C44…93BC · not checked on its Ledger yet',
      '0x90F7…b906 · not on the Ledger last connected',
      '0x15d3…6A65',
    ]);
    // Only phone and Ledger accounts carry the state.
    expect(ownerSubLabel({ index: 2, address: PHONE.address, type: 'mnemonic', addressCheck: 'unchecked' }))
      .toBe('0x7099…79C8');
    expect(ownerSubLabel({ index: 2, address: PHONE.address, addressCheck: 'mismatched' })).toBe('0x7099…79C8');
  });
});
