/**
 * The chrome's side of the phone account check (#1078): main has the
 * phone sign a check before a phone account is added, and a phone
 * account added before that is unchecked until its phone shows it holds
 * it. Only a matched one can own a Safe. Wallet Settings runs the check;
 * the wallet list and the Safe screen say which accounts aren't checked.
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
  const stubWalletModules = () => {
    jest.resetModules();
    global.window = {};
    global.document = createDocument();
    jest.doMock('./wallet-state.js', () => ({
      walletState: { identityView: createElement('div'), derivedWallets: [] },
      registerScreenHider: jest.fn(),
    }));
    jest.doMock('./balance-display.js', () => ({ refreshBalances: jest.fn() }));
    jest.doMock('./safe-status.js', () => ({ refreshSafeStatusCard: jest.fn() }));
    jest.doMock('./device-account-list.js', () => ({ renderDeviceAccountList: jest.fn() }));
  };

  test("the wallet list badges a phone account that doesn't match", async () => {
    stubWalletModules();
    jest.dontMock('./wallet-selector.js'); // the settings tests stand it in
    const { addressCheckBadge } = await import('./wallet-selector.js');

    expect(addressCheckBadge({ ...PHONE, addressCheck: 'mismatched' })).toMatch(/Doesn't match/);
    expect(addressCheckBadge({ ...PHONE, addressCheck: 'unchecked' })).toBe('');
    expect(addressCheckBadge({ ...PHONE, addressCheck: 'matched' })).toBe('');
    expect(addressCheckBadge({ index: 0, name: 'Main Wallet' })).toBe('');
  });

  test("the Safe screen says which phone owners aren't checked", async () => {
    stubWalletModules();
    jest.doMock('./wallet-selector.js', () => ({
      loadDerivedWallets: jest.fn(),
      activateAddedWallet: jest.fn(),
    }));
    const { ownerSubLabel } = await import('./create-safe.js');

    expect(ownerSubLabel({ ...PHONE, addressCheck: 'unchecked' })).toBe('0x7099…79C8 · not checked on your phone yet');
    expect(ownerSubLabel({ ...PHONE, addressCheck: 'mismatched' })).toBe(
      '0x7099…79C8 · your phone answered from another account'
    );
    expect(ownerSubLabel({ ...PHONE, addressCheck: 'matched' })).toBe('0x7099…79C8');
    expect(ownerSubLabel({ index: 0, address: PHONE.address })).toBe('0x7099…79C8');
  });
});
