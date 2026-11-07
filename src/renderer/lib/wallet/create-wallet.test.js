/**
 * Tests for the derivation path form on the create wallet screen.
 *
 * Whether the button is enabled has two separate inputs: main has accepted the
 * form's path, and no request is in flight. If either one clears the other,
 * a wallet can be created from a path nothing has checked, or the default
 * account created while a path is still selected.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const PATH = "m/44'/60'/0'/0/2";
const ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const loadScreen = async () => {
  jest.resetModules();

  const hidden = () => createElement('div', { classes: ['hidden'] });
  const elements = {
    'sidebar-create-wallet': hidden(),
    'create-wallet-back': createElement('button'),
    'create-wallet-unlock': hidden(),
    'create-wallet-touchid-btn': createElement('button'),
    'create-wallet-password-section': hidden(),
    'create-wallet-password': createElement('input'),
    'create-wallet-password-submit': createElement('button'),
    'create-wallet-unlock-error': hidden(),
    'create-wallet-name-step': hidden(),
    'create-wallet-name-input': createElement('input'),
    'create-wallet-submit': createElement('button'),
    'create-wallet-name-error': hidden(),
    'create-wallet-path': createElement('details'),
    'create-wallet-path-scheme': createElement('select', { value: 'next' }),
    'create-wallet-path-index-row': hidden(),
    'create-wallet-path-index': createElement('input', { value: '0' }),
    'create-wallet-path-input': createElement('input', { classes: ['hidden'] }),
    'create-wallet-path-preview': hidden(),
    'create-wallet-path-preview-path': createElement('code'),
    'create-wallet-path-preview-address': createElement('code'),
    'create-wallet-path-error': hidden(),
    'create-wallet-path-note': hidden(),
    'create-wallet-success': hidden(),
    'create-wallet-result-name': createElement('span'),
    'create-wallet-result-address': createElement('code'),
    'create-wallet-result-path': createElement('code', { classes: ['hidden'] }),
    'create-wallet-done': createElement('button'),
  };

  const wallet = {
    previewWalletAtPath: jest.fn(async (path) => ({
      success: true,
      path,
      address: ADDRESS,
      existingName: null,
    })),
    addWalletAtPath: jest.fn(async (name, path) => ({
      success: true,
      wallet: { index: 1000000, name, address: ADDRESS, type: 'mnemonic', path },
    })),
    createDerivedWallet: jest.fn(async (name) => ({
      success: true,
      wallet: { index: 1, name, address: ADDRESS, type: 'mnemonic' },
    })),
  };
  global.window = {
    wallet,
    identity: { getStatus: jest.fn(async () => ({ isUnlocked: true })) },
  };
  global.document = createDocument({ elementsById: elements });

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div'), derivedWallets: [], fullAddresses: {} },
    registerScreenHider: jest.fn(),
  }));
  jest.doMock('./signature-flight.js', () => ({
    refuseSubscreenWhileInFlight: jest.fn(() => false),
  }));
  jest.doMock('./wallet-selector.js', () => ({
    loadDerivedWallets: jest.fn(async () => {}),
    updateWalletSelectorDisplay: jest.fn(),
  }));
  jest.doMock('./balance-display.js', () => ({ refreshBalances: jest.fn() }));

  const mod = await import('./create-wallet.js');
  mod.initCreateWallet();
  await mod.openCreateWallet();
  await flushMicrotasks();

  const submit = elements['create-wallet-submit'];
  const nameInput = elements['create-wallet-name-input'];
  const scheme = elements['create-wallet-path-scheme'];
  const pathInput = elements['create-wallet-path-input'];

  const choose = async (value) => {
    scheme.value = value;
    scheme.dispatch('change');
    await flushMicrotasks();
  };
  const typePath = async (value) => {
    pathInput.value = value;
    pathInput.dispatch('input');
    await flushMicrotasks();
  };

  nameInput.value = 'Imported';

  return { elements, wallet, submit, nameInput, choose, typePath };
};

describe('create wallet — derivation path form', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('the default flow creates the next account and asks main about no path', async () => {
    const { wallet, submit } = await loadScreen();

    expect(submit.disabled).toBe(false);
    submit.dispatch('click');
    await flushMicrotasks();

    expect(wallet.createDerivedWallet).toHaveBeenCalledWith('Imported');
    expect(wallet.addWalletAtPath).not.toHaveBeenCalled();
    expect(wallet.previewWalletAtPath).not.toHaveBeenCalled();
  });

  test('a checked path is what gets added', async () => {
    const { wallet, submit, elements, choose, typePath } = await loadScreen();

    await choose('custom');
    expect(submit.disabled).toBe(true);

    await typePath(PATH);
    expect(submit.disabled).toBe(false);
    expect(elements['create-wallet-path-preview-address'].textContent).toBe(ADDRESS);

    submit.dispatch('click');
    await flushMicrotasks();

    expect(wallet.addWalletAtPath).toHaveBeenCalledWith('Imported', PATH);
    expect(wallet.createDerivedWallet).not.toHaveBeenCalled();
    expect(elements['create-wallet-result-path'].textContent).toBe(PATH);
    expect(elements['create-wallet-result-path'].classList.contains('hidden')).toBe(false);
  });

  test('a failed add does not re-enable the button for a path cleared meanwhile', async () => {
    const { wallet, submit, nameInput, choose, typePath } = await loadScreen();
    await choose('custom');
    await typePath(PATH);

    const pending = deferred();
    wallet.addWalletAtPath.mockReturnValueOnce(pending.promise);
    submit.dispatch('click');
    await flushMicrotasks();

    await typePath('');
    pending.resolve({ success: false, error: 'Vault must be unlocked' });
    await flushMicrotasks();

    expect(submit.disabled).toBe(true);

    submit.dispatch('click');
    nameInput.dispatch('keydown', { key: 'Enter' });
    await flushMicrotasks();

    expect(wallet.addWalletAtPath).toHaveBeenCalledTimes(1);
    expect(wallet.createDerivedWallet).not.toHaveBeenCalled();
  });

  test('a preview answering during a request does not allow a second one', async () => {
    const { wallet, submit, choose, typePath } = await loadScreen();
    await choose('custom');
    await typePath(PATH);

    const pending = deferred();
    wallet.addWalletAtPath.mockReturnValueOnce(pending.promise);
    submit.dispatch('click');
    await flushMicrotasks();

    await typePath("m/44'/60'/0'/0/3");
    expect(submit.disabled).toBe(true);
    submit.dispatch('click');
    await flushMicrotasks();
    expect(wallet.addWalletAtPath).toHaveBeenCalledTimes(1);

    pending.resolve({ success: false, error: 'Nope' });
    await flushMicrotasks();

    expect(submit.disabled).toBe(false);
  });

  test('a failed add leaves a still-checked path ready to retry', async () => {
    const { wallet, submit, choose, typePath } = await loadScreen();
    await choose('custom');
    await typePath(PATH);

    wallet.addWalletAtPath.mockResolvedValueOnce({ success: false, error: 'Nope' });
    submit.dispatch('click');
    await flushMicrotasks();

    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Create Wallet');
  });

  test('a slower preview does not overwrite the answer for the latest path', async () => {
    const { wallet, submit, elements, choose, typePath } = await loadScreen();
    await choose('custom');

    const slow = deferred();
    wallet.previewWalletAtPath.mockReturnValueOnce(slow.promise);
    await typePath("m/44'/60'/0'/0/1");

    wallet.previewWalletAtPath.mockResolvedValueOnce({
      success: false,
      error: 'Enter a path like',
    });
    await typePath('nonsense');

    slow.resolve({ success: true, path: "m/44'/60'/0'/0/1", address: ADDRESS, existingName: null });
    await flushMicrotasks();

    expect(submit.disabled).toBe(true);
    expect(elements['create-wallet-path-error'].textContent).toBe('Enter a path like');
    expect(elements['create-wallet-path-preview'].classList.contains('hidden')).toBe(true);
  });

  test('names the account a path already belongs to and refuses it', async () => {
    const { wallet, submit, elements, choose } = await loadScreen();
    wallet.previewWalletAtPath.mockResolvedValueOnce({
      success: true,
      path: "m/44'/60'/0'/0/0",
      address: ADDRESS,
      existingName: 'Main Wallet',
    });

    await choose('metamask');

    expect(submit.disabled).toBe(true);
    expect(elements['create-wallet-path-error'].textContent).toContain('"Main Wallet"');
  });

  test('going back to the next account re-enables the button, with no path check', async () => {
    const { wallet, submit, choose } = await loadScreen();
    wallet.previewWalletAtPath.mockResolvedValueOnce({ success: false, error: 'Swarm node' });
    await choose('metamask');
    expect(submit.disabled).toBe(true);

    await choose('next');

    expect(submit.disabled).toBe(false);
    submit.dispatch('click');
    await flushMicrotasks();
    expect(wallet.createDerivedWallet).toHaveBeenCalledWith('Imported');
  });
});
