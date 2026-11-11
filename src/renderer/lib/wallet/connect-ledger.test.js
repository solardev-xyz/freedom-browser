/**
 * Tests for the Connect Ledger detect-step status line.
 *
 * The spinner beside the status text is the screen's only claim that
 * detection is still running. When a detection attempt fails the line
 * reports the device error, so the spinner has to stop — otherwise the
 * screen reads as failed and still working at the same time (#241).
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const loadScreen = async () => {
  jest.resetModules();

  const screen = createElement('div', { classes: ['hidden'] });
  const statusEl = createElement('div', { classes: ['connect-ledger-status'] });
  const statusSpinner = createElement('span', { classes: ['connect-ledger-status-spinner'] });
  const statusText = createElement('span', { textContent: 'Looking for your Ledger…' });
  const detectView = createElement('div', { classes: ['hidden'] });
  const accountsView = createElement('div', { classes: ['hidden'] });
  const loadMoreBtn = createElement('button');

  const elementsById = {
    'sidebar-connect-ledger': screen,
    'connect-ledger-back': createElement('button'),
    'connect-ledger-detect': detectView,
    'connect-ledger-status': statusEl,
    'connect-ledger-status-spinner': statusSpinner,
    'connect-ledger-status-text': statusText,
    'connect-ledger-accounts-step': accountsView,
    'connect-ledger-scheme': createElement('select', { value: 'live' }),
    'connect-ledger-account-list': createElement('div'),
    'connect-ledger-load-more': loadMoreBtn,
    'connect-ledger-name-input': createElement('input'),
    'connect-ledger-submit': createElement('button'),
    'connect-ledger-error': createElement('div', { classes: ['hidden'] }),
    'connect-ledger-success': createElement('div', { classes: ['hidden'] }),
    'connect-ledger-result-name': createElement('div'),
    'connect-ledger-result-address': createElement('div'),
    'connect-ledger-done': createElement('button'),
  };

  const getAccounts = jest.fn(async () => ({ success: true, accounts: [] }));
  global.window = { ledger: { getAccounts, addAccount: jest.fn() } };
  global.document = createDocument({ elementsById });

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div'), derivedWallets: [] },
    registerScreenHider: jest.fn(),
  }));
  jest.doMock('./signature-flight.js', () => ({
    refuseSubscreenWhileInFlight: jest.fn(() => false),
  }));
  jest.doMock('./wallet-selector.js', () => ({
    loadDerivedWallets: jest.fn(async () => {}),
    activateAddedWallet: jest.fn(async () => {}),
  }));
  jest.doMock('./balance-display.js', () => ({ refreshBalances: jest.fn() }));
  jest.doMock('./wallet-utils.js', () => ({
    showInlineError: jest.fn(),
    hideInlineError: jest.fn(),
  }));
  jest.doMock('./device-account-list.js', () => ({
    renderDeviceAccountList: jest.fn(),
    existingWalletAddresses: jest.fn(() => new Set()),
  }));

  const mod = await import('./connect-ledger.js');
  mod.initConnectLedger();
  const { showInlineError } = await import('./wallet-utils.js');
  const { loadDerivedWallets } = await import('./wallet-selector.js');

  return {
    mod,
    screen,
    statusEl,
    statusSpinner,
    statusText,
    detectView,
    accountsView,
    getAccounts,
    showInlineError,
    loadDerivedWallets,
    loadMoreBtn,
  };
};

describe('connect ledger — detect status rendering', () => {
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

  test('a device error stops the spinner and marks the status line failed', async () => {
    const { mod, statusEl, statusSpinner, statusText, getAccounts } = await loadScreen();
    getAccounts.mockResolvedValue({
      success: false,
      error: 'Ledger error. Reconnect the device and try again.',
      code: 'LEDGER_UNKNOWN',
    });

    await mod.openConnectLedger();
    await flushMicrotasks();

    expect(statusText.textContent).toBe('Ledger error. Reconnect the device and try again.');
    expect(statusSpinner.classList.contains('hidden')).toBe(true);
    expect(statusEl.classList.contains('connect-ledger-status-failed')).toBe(true);
  });

  test('a failure with no message still stops the spinner', async () => {
    const { mod, statusEl, statusSpinner, statusText, getAccounts } = await loadScreen();
    getAccounts.mockResolvedValue({ success: false });

    await mod.openConnectLedger();
    await flushMicrotasks();

    expect(statusText.textContent).toBe('Failed to read accounts from the device');
    expect(statusSpinner.classList.contains('hidden')).toBe(true);
    expect(statusEl.classList.contains('connect-ledger-status-failed')).toBe(true);
  });

  test('a thrown bridge error is rendered the same way', async () => {
    const { mod, statusEl, statusSpinner, statusText, getAccounts } = await loadScreen();
    getAccounts.mockRejectedValue(new Error('Ledger bridge unavailable'));

    await mod.openConnectLedger();
    await flushMicrotasks();

    expect(statusText.textContent).toBe('Ledger bridge unavailable');
    expect(statusSpinner.classList.contains('hidden')).toBe(true);
    expect(statusEl.classList.contains('connect-ledger-status-failed')).toBe(true);
  });

  test('while waiting for the device the spinner keeps running', async () => {
    const { mod, statusEl, statusSpinner, statusText, getAccounts } = await loadScreen();
    // A poll that never settles: the screen is genuinely still working.
    getAccounts.mockReturnValue(new Promise(() => {}));

    await mod.openConnectLedger();
    await flushMicrotasks();

    expect(statusText.textContent).toBe('Looking for your Ledger…');
    expect(statusSpinner.classList.contains('hidden')).toBe(false);
    expect(statusEl.classList.contains('connect-ledger-status-failed')).toBe(false);
  });

  test('detection keeps polling after a failure and clears the error state on reopen', async () => {
    const { mod, statusEl, statusSpinner, statusText, detectView, accountsView, getAccounts } =
      await loadScreen();
    getAccounts.mockResolvedValue({ success: false, error: 'Ledger is locked. Unlock it with your PIN.' });

    await mod.openConnectLedger();
    await flushMicrotasks();
    expect(statusSpinner.classList.contains('hidden')).toBe(true);

    // The poll loop survives the error: the device showing up later still
    // moves the screen on, which is the screen's retry affordance.
    const calls = getAccounts.mock.calls.length;
    getAccounts.mockResolvedValue({ success: true, accounts: [{ address: '0xabc', path: "44'/60'/0'/0/0" }] });
    await jest.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();
    expect(getAccounts.mock.calls.length).toBeGreaterThan(calls);
    expect(accountsView.classList.contains('hidden')).toBe(false);
    expect(detectView.classList.contains('hidden')).toBe(true);

    // Reopening resets the line: waiting text, spinner back, error styling gone.
    await mod.closeConnectLedger();
    getAccounts.mockReturnValue(new Promise(() => {}));
    await mod.openConnectLedger();
    await flushMicrotasks();

    expect(statusText.textContent).toBe('Looking for your Ledger…');
    expect(statusSpinner.classList.contains('hidden')).toBe(false);
    expect(statusEl.classList.contains('connect-ledger-status-failed')).toBe(false);

    await mod.closeConnectLedger();
  });
});

describe('connect ledger — wallet accounts the device does not hold (#1065)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('the user is told which accounts, and the wallet list is reloaded', async () => {
    const { mod, getAccounts, showInlineError, loadDerivedWallets } = await loadScreen();
    getAccounts.mockResolvedValue({
      success: true,
      accounts: [{ address: '0xabc', path: "44'/60'/0'/0/0" }],
      mismatched: [{ index: 1000001, name: 'Old Ledger', address: '0xdef', path: "44'/60'/1'/0/0" }],
    });

    await mod.openConnectLedger();
    await flushMicrotasks();

    expect(showInlineError).toHaveBeenCalledWith(
      expect.anything(),
      'This Ledger doesn\'t hold "Old Ledger" at its path. It stays in your wallet list, ' +
        "but can't sign or own a Safe until you connect the Ledger that holds it."
    );
    expect(loadDerivedWallets).toHaveBeenCalled();
    await mod.closeConnectLedger();
  });

  test('nothing is said when every account matches', async () => {
    const { mod, getAccounts, showInlineError, loadDerivedWallets } = await loadScreen();
    getAccounts.mockResolvedValue({ success: true, accounts: [], mismatched: [] });

    await mod.openConnectLedger();
    await flushMicrotasks();

    expect(showInlineError).not.toHaveBeenCalled();
    expect(loadDerivedWallets).not.toHaveBeenCalled();
    await mod.closeConnectLedger();
  });

  test('only the first page asks main to check the records, not "Load more" (#1065)', async () => {
    const { mod, getAccounts, showInlineError, loadMoreBtn } = await loadScreen();
    const mismatched = [{ index: 1000001, name: 'Old Ledger', address: '0xdef', path: "44'/60'/1'/0/0" }];
    getAccounts.mockResolvedValue({
      success: true,
      accounts: [{ address: '0xabc', path: "44'/60'/0'/0/0" }],
      mismatched,
    });

    await mod.openConnectLedger();
    await flushMicrotasks();
    expect(getAccounts).toHaveBeenCalledTimes(1);
    expect(getAccounts.mock.calls[0][0]).toMatchObject({ start: 0, checkRecords: true });
    expect(showInlineError).toHaveBeenCalledTimes(1);

    // Main answers a page that wasn't checked with no mismatches.
    getAccounts.mockResolvedValue({
      success: true,
      accounts: [{ address: '0x123', path: "44'/60'/1'/0/0" }],
      mismatched: [],
    });
    loadMoreBtn.dispatch('click');
    await flushMicrotasks();
    expect(getAccounts).toHaveBeenCalledTimes(2);
    expect(getAccounts.mock.calls[1][0]).toMatchObject({ start: 1, checkRecords: false });
    expect(showInlineError).toHaveBeenCalledTimes(1);
    await mod.closeConnectLedger();
  });

  test('several accounts are named together', () => {
    return loadScreen().then(({ mod }) => {
      expect(mod.mismatchNotice([{ name: 'A' }, { name: 'B' }])).toBe(
        'This Ledger doesn\'t hold "A", "B" at their paths. They stay in your wallet list, ' +
          "but can't sign or own a Safe until you connect the Ledger that holds them."
      );
    });
  });
});
