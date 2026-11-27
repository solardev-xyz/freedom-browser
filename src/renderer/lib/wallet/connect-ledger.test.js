/**
 * Tests for the Connect Ledger screen, on both Ledger backends
 * (FREEDOM_LEDGER_BACKEND; freedom-core design 0016, LDG-3's PR 8):
 * - `js`: `window.ledger` is a scripted bridge, answering as main's JS
 *   backend does (transport.js, account-checks.js);
 * - `core`: `window.ledger` reaches main's own IPC handlers on the core's
 *   backend (wallet/ledger/ipc.js, identity-manager.js, through
 *   core-accounts.js and vault-backend.js's `ledgerCall`), with a scripted
 *   core that plays `ledger.accounts` and `ledger.add`
 *   (test/helpers/fake-ledger-accounts-core.js), main's relay, and a
 *   seeded device behind it; the core and main share one vault-meta.json.
 *
 * The detect step: the spinner beside the status text is the screen's only
 * claim that detection is still running. When a detection attempt fails
 * the line reports the device error, so the spinner has to stop —
 * otherwise the screen reads as failed and still working at the same time
 * (#241). The accounts step: the wallet's Ledger accounts the device
 * doesn't hold (#1065), and adding the chosen account, during which the
 * screen asks for no discovery (the core answers it LEDGER_BUSY while
 * `ledger.add` waits for the user on the device).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');
const { loadMainModule } = require('../../../../test/helpers/main-process-test-utils.js');
const { settle, until } = require('../../../../test/helpers/fake-ledger-core.js');
const {
  HARDWARE_INDEX_BASE,
  addressAnswer,
  deviceAccount,
  startAccountsCore,
} = require('../../../../test/helpers/fake-ledger-accounts-core.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalIdentityData = process.env.FREEDOM_IDENTITY_DATA;

const restoreIdentityData = () => {
  if (originalIdentityData === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
  else process.env.FREEDOM_IDENTITY_DATA = originalIdentityData;
};

const LOCKED = 'Ledger is locked. Unlock it with your PIN.';
const BUSY = 'Ledger is busy with another request. Finish or dismiss it on the device.';
const MAIN = {
  index: 0,
  name: 'Main Wallet',
  address: '0x0000000000000000000000000000000000000001',
};
const live = (i) => `44'/60'/${i}'/0/0`;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

/**
 * The core's world: a scripted core and a seeded device behind main's
 * relay, sharing `identityDir`'s vault-meta.json with main.
 */
async function startCoreWorld() {
  const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-ledger-core-'));
  const writeMeta = (wallets = []) =>
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({ activeWalletIndex: 0, derivedWallets: [MAIN, ...wallets] }, null, 2)
    );
  writeMeta();
  const world = await startAccountsCore({ identityDir, log: silent });
  return {
    ...world,
    identityDir,
    writeMeta,
    readMeta: () => JSON.parse(fs.readFileSync(path.join(identityDir, 'vault-meta.json'), 'utf8')),
    async dispose() {
      await world.stop();
      fs.rmSync(identityDir, { recursive: true, force: true });
    },
  };
}

/**
 * Main's handlers on the core's backend, loaded into this test's module
 * registry with the world's client and relay as core-process.js's, and the
 * bridge the chrome's preload gives the screen over them.
 */
function mainBridge(world) {
  const silentLogger = () => ({ ...silent, log() {} });
  const unused = () => {
    throw new Error('the JS backend’s transport is not used on the core’s');
  };
  process.env.FREEDOM_IDENTITY_DATA = world.identityDir;
  const main = loadMainModule(require.resolve('../../../main/identity-manager'), {
    userDataDir: world.identityDir,
    extraMocks: {
      [require.resolve('../../../main/logger')]: silentLogger,
      [require.resolve('../../../main/core/core-process')]: () => ({
        getCoreClient: () => world.client,
        getLedgerRelay: () => world.relay,
      }),
      [require.resolve('../../../main/wallet/ledger/ledger-backend-kind')]: () => ({
        ledgerBackendKind: () => 'core',
      }),
      [require.resolve('../../../main/wallet/ledger/transport')]: () => ({
        listAccounts: unused,
        readAddresses: unused,
      }),
    },
  });
  main.mod.registerIdentityIpc();
  require('../../../main/wallet/ledger/ipc').registerLedgerIpc();
  const { ipcMain } = main;
  // preload.js's `ledger` bridge, counting the requests still unanswered.
  let inFlight = 0;
  const counted = (promise) => {
    inFlight += 1;
    return promise.finally(() => {
      inFlight -= 1;
    });
  };
  return {
    getAccounts: jest.fn((options) => counted(ipcMain.invoke('ledger:get-accounts', options))),
    addAccount: jest.fn((name, scheme, index) =>
      counted(ipcMain.invoke('wallet:add-ledger-wallet', name, scheme, index))
    ),
    inFlight: () => inFlight,
  };
}

const loadScreen = async ({ world = null } = {}) => {
  jest.resetModules();

  const screen = createElement('div', { classes: ['hidden'] });
  const statusEl = createElement('div', { classes: ['connect-ledger-status'] });
  const statusSpinner = createElement('span', { classes: ['connect-ledger-status-spinner'] });
  const statusText = createElement('span', { textContent: 'Looking for your Ledger…' });
  const detectView = createElement('div', { classes: ['hidden'] });
  const accountsView = createElement('div', { classes: ['hidden'] });
  const schemeSelect = createElement('select', { value: 'live' });
  const loadMoreBtn = createElement('button');
  const nameInput = createElement('input');
  const submitBtn = createElement('button');
  const successView = createElement('div', { classes: ['hidden'] });
  const resultName = createElement('div');
  const resultAddress = createElement('div');
  const confirmEl = createElement('div', { classes: ['connect-ledger-status', 'hidden'] });
  const confirmText = createElement('span');

  const elementsById = {
    'sidebar-connect-ledger': screen,
    'connect-ledger-back': createElement('button'),
    'connect-ledger-detect': detectView,
    'connect-ledger-status': statusEl,
    'connect-ledger-status-spinner': statusSpinner,
    'connect-ledger-status-text': statusText,
    'connect-ledger-accounts-step': accountsView,
    'connect-ledger-scheme': schemeSelect,
    'connect-ledger-account-list': createElement('div'),
    'connect-ledger-load-more': loadMoreBtn,
    'connect-ledger-name-input': nameInput,
    'connect-ledger-submit': submitBtn,
    'connect-ledger-error': createElement('div', { classes: ['hidden'] }),
    'connect-ledger-success': successView,
    'connect-ledger-result-name': resultName,
    'connect-ledger-result-address': resultAddress,
    'connect-ledger-done': createElement('button'),
    'connect-ledger-confirm': confirmEl,
    'connect-ledger-confirm-text': confirmText,
  };

  const bridge = world
    ? mainBridge(world)
    : {
        getAccounts: jest.fn(async () => ({ success: true, accounts: [] })),
        addAccount: jest.fn(),
      };
  // preload.js's switch: the core drives the Ledger (LDG-3).
  bridge.coreBackend = Boolean(world);
  global.window = { ledger: bridge };
  global.document = createDocument({ elementsById });

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div'), derivedWallets: [], fullAddresses: {} },
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
  const { loadDerivedWallets, activateAddedWallet } = await import('./wallet-selector.js');
  const { renderDeviceAccountList } = await import('./device-account-list.js');

  return {
    mod,
    screen,
    statusEl,
    statusSpinner,
    statusText,
    detectView,
    accountsView,
    schemeSelect,
    loadMoreBtn,
    nameInput,
    submitBtn,
    successView,
    resultName,
    resultAddress,
    confirmEl,
    confirmText,
    getAccounts: bridge.getAccounts,
    addAccount: bridge.addAccount,
    inFlight: bridge.inFlight,
    showInlineError,
    loadDerivedWallets,
    activateAddedWallet,
    /** The accounts the list shows, and choosing one as the user would. */
    listed: () => renderDeviceAccountList.mock.calls.at(-1)?.[1] ?? [],
    choose: (account) => renderDeviceAccountList.mock.calls.at(-1)[2].onSelect(account),
  };
};

/**
 * One backend's way to script the device and to let the screen run:
 * `failsLocked()`, `waits()`, `ready()`, and `settled()` once the screen's
 * requests are answered. On `js` a request is the bridge's mock; on `core`
 * it runs through main, the core, the relay and the device, in real turns
 * of the event loop (setTimeout alone is faked, for the poll).
 */
const BACKENDS = {
  js: {
    useTimers: () => jest.useFakeTimers(),
    async start() {
      return { world: null };
    },
    failsLocked: (ctx) =>
      ctx.getAccounts.mockResolvedValue({
        success: false,
        error: LOCKED,
        code: 'LEDGER_DEVICE_LOCKED',
      }),
    waits: (ctx) => ctx.getAccounts.mockReturnValue(new Promise(() => {})),
    failsBusy: (ctx) =>
      ctx.getAccounts.mockResolvedValue({ success: false, error: BUSY, code: 'LEDGER_BUSY' }),
    ready: (ctx) =>
      ctx.getAccounts.mockResolvedValue({
        success: true,
        accounts: [{ address: deviceAccount('device-a', live(0)).address, path: live(0) }],
      }),
    settled: () => flushMicrotasks(),
  },
  core: {
    useTimers: () =>
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }),
    async start() {
      return { world: await startCoreWorld() };
    },
    failsLocked: (ctx) => {
      ctx.world.device.script = () => '5515';
    },
    waits: (ctx) => {
      ctx.world.device.script = () => ({ hold: true });
    },
    failsBusy: (ctx) => {
      ctx.world.device.script = () => ({ fail: 'busy' });
    },
    ready: (ctx) => {
      ctx.world.device.script = null;
    },
    async settled(ctx) {
      // Every request the screen made has its answer, and the relay holds no parent.
      await flushMicrotasks();
      await until(
        () => ctx.inFlight() === 0 && ctx.world.relay.stats().parents === 0,
        'the core to answer'
      );
      await settle();
      await flushMicrotasks();
    },
  },
};

describe.each(Object.keys(BACKENDS))('connect ledger on the %s backend', (backend) => {
  const driver = BACKENDS[backend];
  let ctx;

  const open = async ({ seed } = {}) => {
    const { world } = await driver.start();
    if (world && seed) seed(world);
    ctx = { ...(await loadScreen({ world })), world };
    return ctx;
  };

  beforeEach(() => {
    driver.useTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    ctx = null;
  });

  afterEach(async () => {
    if (ctx?.world) {
      try {
        expect(ctx.world.core().faults).toEqual([]);
        await ctx.mod.closeConnectLedger();
      } finally {
        await ctx.world.dispose();
        // What the core's exit ends (a held poll) settles before the mocks go.
        await settle();
      }
    }
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    restoreIdentityData();
    jest.restoreAllMocks();
  });

  describe('detect status rendering', () => {
    test('a device error stops the spinner and marks the status line failed', async () => {
      await open();
      driver.failsLocked(ctx);

      await ctx.mod.openConnectLedger();
      await driver.settled(ctx);

      expect(ctx.statusText.textContent).toBe(LOCKED);
      expect(ctx.statusSpinner.classList.contains('hidden')).toBe(true);
      expect(ctx.statusEl.classList.contains('connect-ledger-status-failed')).toBe(true);
    });

    test('while waiting for the device the spinner keeps running', async () => {
      await open();
      // A poll that never settles: the screen is genuinely still working.
      driver.waits(ctx);

      await ctx.mod.openConnectLedger();
      if (ctx.world) await until(() => ctx.world.devices.held.length === 1, 'the held APDU');
      await flushMicrotasks();

      expect(ctx.statusText.textContent).toBe('Looking for your Ledger…');
      expect(ctx.statusSpinner.classList.contains('hidden')).toBe(false);
      expect(ctx.statusEl.classList.contains('connect-ledger-status-failed')).toBe(false);
    });

    // LDG-3's PR 10 (design 0016, deviation `discovery-busy`): on the
    // core's backend discovery answers LEDGER_BUSY at once while another
    // request holds the device (a signature waiting): a wait, not a failure.
    test('a busy Ledger keeps the spinner, says so, and polls on until it is free', async () => {
      await open();
      driver.failsBusy(ctx);

      await ctx.mod.openConnectLedger();
      await driver.settled(ctx);
      expect(ctx.statusText.textContent).toBe(BUSY);
      expect(ctx.statusSpinner.classList.contains('hidden')).toBe(false);
      expect(ctx.statusEl.classList.contains('connect-ledger-status-failed')).toBe(false);

      driver.ready(ctx);
      await jest.advanceTimersByTimeAsync(1500);
      await driver.settled(ctx);
      expect(ctx.accountsView.classList.contains('hidden')).toBe(false);
    });

    test('detection keeps polling after a failure and clears the error state on reopen', async () => {
      await open();
      driver.failsLocked(ctx);

      await ctx.mod.openConnectLedger();
      await driver.settled(ctx);
      expect(ctx.statusSpinner.classList.contains('hidden')).toBe(true);

      // The poll loop survives the error: the device showing up later still
      // moves the screen on, which is the screen's retry affordance.
      const calls = ctx.getAccounts.mock.calls.length;
      driver.ready(ctx);
      await jest.advanceTimersByTimeAsync(1500);
      await driver.settled(ctx);
      expect(ctx.getAccounts.mock.calls.length).toBeGreaterThan(calls);
      expect(ctx.accountsView.classList.contains('hidden')).toBe(false);
      expect(ctx.detectView.classList.contains('hidden')).toBe(true);

      // Reopening resets the line: waiting text, spinner back, error styling gone.
      await ctx.mod.closeConnectLedger();
      driver.waits(ctx);
      await ctx.mod.openConnectLedger();
      if (ctx.world) await until(() => ctx.world.devices.held.length === 1, 'the held APDU');
      await flushMicrotasks();

      expect(ctx.statusText.textContent).toBe('Looking for your Ledger…');
      expect(ctx.statusSpinner.classList.contains('hidden')).toBe(false);
      expect(ctx.statusEl.classList.contains('connect-ledger-status-failed')).toBe(false);
    });
  });

  describe('wallet accounts the device does not hold (#1065)', () => {
    const OLD = {
      index: HARDWARE_INDEX_BASE + 1,
      name: 'Old Ledger',
      address: deviceAccount('device-b', live(1)).address,
      path: live(1),
    };

    test('the user is told which accounts, and the wallet list is reloaded', async () => {
      await open({ seed: (world) => world.writeMeta([{ ...OLD, type: 'ledger' }]) });
      if (backend === 'js') {
        ctx.getAccounts.mockResolvedValue({
          success: true,
          accounts: [{ address: '0xabc', path: live(0) }],
          mismatched: [OLD],
        });
      }

      await ctx.mod.openConnectLedger();
      await driver.settled(ctx);

      expect(ctx.showInlineError).toHaveBeenCalledWith(
        expect.anything(),
        'This Ledger doesn\'t hold "Old Ledger" at its path. It stays in your wallet list, ' +
          "but can't sign or own a Safe until you connect the Ledger that holds it."
      );
      expect(ctx.loadDerivedWallets).toHaveBeenCalled();
      if (ctx.world) {
        // The core checked the record after discovery's APDUs and kept the result.
        expect(ctx.world.readMeta().derivedWallets[1].addressCheck).toBe('mismatched');
      }
    });

    test('nothing is said when every account matches', async () => {
      const held = { ...OLD, name: 'Held', address: deviceAccount('device-a', live(1)).address };
      await open({ seed: (world) => world.writeMeta([{ ...held, type: 'ledger' }]) });
      if (backend === 'js') {
        ctx.getAccounts.mockResolvedValue({ success: true, accounts: [], mismatched: [] });
      }

      await ctx.mod.openConnectLedger();
      await driver.settled(ctx);

      expect(ctx.showInlineError).not.toHaveBeenCalled();
      expect(ctx.loadDerivedWallets).not.toHaveBeenCalled();
      if (ctx.world) expect(ctx.world.readMeta().derivedWallets[1].addressCheck).toBe('matched');
    });
  });

  describe('adding the chosen account', () => {
    const toAccountsStep = async () => {
      driver.ready(ctx);
      await ctx.mod.openConnectLedger();
      await driver.settled(ctx);
      expect(ctx.accountsView.classList.contains('hidden')).toBe(false);
    };

    test('the account is added, and the success step shows its address', async () => {
      const onDevice = deviceAccount('device-a', live(0)).address;
      await open();
      await toAccountsStep();
      if (backend === 'js') {
        ctx.addAccount.mockResolvedValue({
          success: true,
          wallet: { index: HARDWARE_INDEX_BASE, name: 'My Stax', address: onDevice },
        });
      }

      ctx.choose(ctx.listed()[0]);
      ctx.nameInput.value = ' My Stax ';
      ctx.submitBtn.dispatch('click');
      await driver.settled(ctx);
      await flushMicrotasks();

      // The JS backend's account by its address and path; the core's by its
      // scheme and index, never an address.
      expect(ctx.addAccount).toHaveBeenCalledWith(
        'My Stax',
        ...(backend === 'js' ? [onDevice, live(0)] : ['live', 0])
      );
      expect(ctx.successView.classList.contains('hidden')).toBe(false);
      expect(ctx.resultName.textContent).toBe('My Stax');
      expect(ctx.resultAddress.textContent).toBe(onDevice);
      expect(ctx.activateAddedWallet).toHaveBeenCalledWith(
        expect.objectContaining({ address: onDevice })
      );
      if (ctx.world) {
        // The device showed the address for the user to confirm, and the
        // core wrote the record.
        expect(ctx.world.devices.bytes().at(-1).slice(0, 8)).toBe('e0020100');
        expect(ctx.world.readMeta().derivedWallets[1]).toEqual({
          index: HARDWARE_INDEX_BASE,
          name: 'My Stax',
          address: onDevice,
          type: 'ledger',
          path: live(0),
          addressCheck: 'matched',
        });
        expect(ctx.world.core().requests('accounts.add_ledger')).toEqual([]);
      }
    });

    test('no discovery while the add waits; the success step stays after it', async () => {
      await open();
      await toAccountsStep();
      let finish;
      if (backend === 'js') {
        ctx.addAccount.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      } else {
        // The user hasn't confirmed the address on the device yet.
        ctx.world.device.script = (apdu) => (apdu[2] === 0x01 ? { hold: true } : undefined);
      }
      const asked = ctx.getAccounts.mock.calls.length;

      ctx.choose(ctx.listed()[0]);
      ctx.submitBtn.dispatch('click');
      if (ctx.world)
        await until(() => ctx.world.devices.held.length === 1, 'the add on the device');
      await flushMicrotasks();

      // On the core's backend the device shows the address: the screen says
      // to confirm it there (LDG-3's PR 10). The JS backend shows nothing.
      const chosen = ctx.listed()[0].address;
      if (backend === 'core') {
        expect(ctx.submitBtn.textContent).toBe('Confirm on your Ledger…');
        expect(ctx.confirmEl.classList.contains('hidden')).toBe(false);
        expect(ctx.confirmText.textContent).toBe(`Check that your Ledger shows ${chosen}, and approve it there.`);
      } else {
        expect(ctx.submitBtn.textContent).toBe('Adding…');
        expect(ctx.confirmEl.classList.contains('hidden')).toBe(true);
      }
      expect(ctx.schemeSelect.disabled).toBe(true);
      expect(ctx.loadMoreBtn.disabled).toBe(true);
      ctx.schemeSelect.dispatch('change');
      ctx.loadMoreBtn.dispatch('click');
      await jest.advanceTimersByTimeAsync(10 * 1500);
      await flushMicrotasks();
      expect(ctx.getAccounts.mock.calls.length).toBe(asked);
      if (ctx.world) {
        expect(ctx.world.core().requests('ledger.accounts')).toHaveLength(asked);
      }

      const address = deviceAccount('device-a', live(0)).address;
      if (backend === 'js') {
        finish({
          success: true,
          wallet: { index: HARDWARE_INDEX_BASE, name: 'Ledger 1', address },
        });
      } else {
        ctx.world.devices.release(addressAnswer('device-a', live(0)).toString('hex'));
      }
      await (ctx.world ? driver.settled(ctx) : flushMicrotasks());
      await flushMicrotasks();
      expect(ctx.successView.classList.contains('hidden')).toBe(false);
      expect(ctx.resultAddress.textContent).toBe(address);
      expect(ctx.confirmEl.classList.contains('hidden')).toBe(true);

      // Nothing polls behind the success step.
      await jest.advanceTimersByTimeAsync(10 * 1500);
      await flushMicrotasks();
      expect(ctx.getAccounts.mock.calls.length).toBe(asked);
      expect(ctx.successView.classList.contains('hidden')).toBe(false);
      expect(ctx.schemeSelect.disabled).toBe(false);
    });

    test('a failed add hands the controls back', async () => {
      await open();
      await toAccountsStep();
      if (backend === 'js') {
        ctx.addAccount.mockResolvedValue({
          success: false,
          error: 'Request rejected on the Ledger device.',
          code: 'LEDGER_USER_REJECTED',
        });
      } else {
        ctx.world.device.script = (apdu) => (apdu[2] === 0x01 ? '6985' : undefined);
      }

      ctx.choose(ctx.listed()[0]);
      ctx.submitBtn.dispatch('click');
      await driver.settled(ctx);
      await flushMicrotasks();

      expect(ctx.showInlineError).toHaveBeenLastCalledWith(
        expect.anything(),
        'Request rejected on the Ledger device.'
      );
      expect(ctx.successView.classList.contains('hidden')).toBe(true);
      expect(ctx.submitBtn.disabled).toBe(false);
      expect(ctx.submitBtn.textContent).toBe('Add Account');
      expect(ctx.schemeSelect.disabled).toBe(false);
      expect(ctx.loadMoreBtn.disabled).toBe(false);
      if (ctx.world) expect(ctx.world.readMeta().derivedWallets).toEqual([MAIN]);
    });
  });
});

describe('connect ledger on the core backend: the address is the device’s', () => {
  let ctx;

  beforeEach(() => {
    BACKENDS.core.useTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    try {
      expect(ctx.world.core().faults).toEqual([]);
      await ctx.mod.closeConnectLedger();
    } finally {
      await ctx.world.dispose();
    }
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    restoreIdentityData();
    jest.restoreAllMocks();
  });

  test('a chrome listing another address adds the one the device holds, never its own', async () => {
    const world = await startCoreWorld();
    ctx = { ...(await loadScreen({ world })), world };
    await ctx.mod.openConnectLedger();
    await BACKENDS.core.settled(ctx);
    const planted = deviceAccount('device-b', live(0)).address;
    // The account as the chrome holds it, its address changed.
    ctx.choose({ ...ctx.listed()[0], address: planted });

    ctx.submitBtn.dispatch('click');
    await BACKENDS.core.settled(ctx);
    await flushMicrotasks();

    const onDevice = deviceAccount('device-a', live(0)).address;
    expect(ctx.addAccount).toHaveBeenCalledWith('', 'live', 0);
    expect(
      ctx.world
        .core()
        .requests('ledger.add')
        .map((m) => m.params)
    ).toEqual([{ scheme: 'live', index: 0, name: '' }]);
    expect(ctx.resultAddress.textContent).toBe(onDevice);
    expect(ctx.world.readMeta().derivedWallets[1].address).toBe(onDevice);
    expect(JSON.stringify(ctx.world.readMeta())).not.toContain(planted.slice(2));
  });
});

describe('connect ledger: the screen alone', () => {
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

  test('several accounts are named together', async () => {
    const { mod } = await loadScreen();
    expect(mod.mismatchNotice([{ name: 'A' }, { name: 'B' }])).toBe(
      'This Ledger doesn\'t hold "A", "B" at their paths. They stay in your wallet list, ' +
        "but can't sign or own a Safe until you connect the Ledger that holds them."
    );
  });
});
