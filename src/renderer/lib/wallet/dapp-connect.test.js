/**
 * Tests for the dApp Connect prompt: one approval at a time across the
 * wallet's dApp prompts (dapp-approval-slot.js).
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const DAPP_CONNECT_ELEMENT_IDS = [
  'address-input',
  'dapp-auto-approve-badge',
  'dapp-connect-approve',
  'dapp-connect-back',
  'dapp-connect-favicon',
  'dapp-connect-icon',
  'dapp-connection-banner',
  'dapp-connection-disconnect',
  'dapp-connection-manage',
  'dapp-connection-site',
  'dapp-connection-wallet',
  'dapp-connect-reject',
  'dapp-connect-safe-note',
  'dapp-connect-site',
  'dapp-connect-wallet-address',
  'dapp-connect-wallet-btn',
  'dapp-connect-wallet-dropdown',
  'dapp-connect-wallet-list',
  'dapp-connect-wallet-name',
  'dapp-connect-wallet-selector',
  'sidebar-dapp-connect',
];

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadDappConnect() {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_CONNECT_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  // As in index.html: the prompt starts hidden.
  elementsById['sidebar-dapp-connect'].classList.add('hidden');
  global.document = createDocument({ elementsById });

  const grantPermission = jest.fn().mockResolvedValue({ success: true });
  global.window = {
    dappPermissions: {
      grantPermission,
      getPermission: jest.fn().mockResolvedValue(null),
    },
  };

  jest.doMock('./wallet-state.js', () => ({
    walletState: {
      identityView: createElement('div'),
      activeWalletIndex: 0,
      selectedChainId: 100,
      derivedWallets: [{ index: 0, name: 'Main', address: '0x1111111111111111111111111111111111111111' }],
    },
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
  }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: jest.fn((text) => text),
    isSafeAccount: jest.fn(() => false),
    isSafeDeployed: jest.fn(() => true),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn(), isVisible: jest.fn(() => true) }));
  // Webviews by committed site; the active one is `provider.active`.
  const provider = { active: null, keys: new Map(), generations: new Map() };
  const emitAccountsChanged = jest.fn();
  jest.doMock('../dapp-provider.js', () => ({
    getActiveWebview: jest.fn(() => provider.active),
    emitAccountsChanged,
    getNavigationGeneration: jest.fn((wv) => provider.generations.get(wv) ?? 0),
    permissionKeyForWebview: jest.fn((wv) => provider.keys.get(wv) ?? null),
  }));
  jest.doMock('./permission-manage.js', () => ({ showDappPermissions: jest.fn() }));
  jest.doMock('../url-utils.js', () => ({ parseOnchainAppUrl: jest.fn(() => null) }));

  const mod = await import('./dapp-connect.js');
  mod.initDappConnect();
  const guard = await import('./dapp-prompt-guard.js');

  const tab = (site) => {
    const webview = { send: jest.fn() };
    provider.keys.set(webview, site);
    return webview;
  };

  function openConnect(site, webview = tab(site)) {
    const settled = { state: 'pending', webview };
    // showDappConnect reveals the screen synchronously, as in the app.
    mod.showDappConnect(
      site,
      site,
      (value) => Object.assign(settled, { state: 'resolved', value }),
      (value) => Object.assign(settled, { state: 'rejected', value }),
      webview
    );
    return settled;
  }

  const hideForOtherScreen = () => require('./wallet-state.js').registerScreenHider.mock.calls[0][0]();

  return { mod, elements: elementsById, grantPermission, openConnect, hideForOtherScreen, guard, provider, tab, emitAccountsChanged };
}

describe('dapp-connect prompt', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a newcomer never replaces the site on screen', async () => {
    const { elements, grantPermission, openConnect, guard } = await loadDappConnect();
    const first = openConnect('https://app.example');
    expect(guard.isDappPromptShowing()).toBe(true);

    const second = openConnect('https://other.example');
    expect(second).toMatchObject({ state: 'rejected', value: { code: -32002 } });
    expect(elements['dapp-connect-site'].textContent).toBe('https://app.example');

    elements['dapp-connect-approve'].dispatch('click');
    await flush();
    expect(grantPermission.mock.calls[0][0]).toBe('https://app.example');
    expect(first.state).toBe('resolved');
    expect(guard.isDappPromptShowing()).toBe(false);
  });

  test('a prompt another screen hid holds off nothing', async () => {
    const { openConnect, hideForOtherScreen } = await loadDappConnect();
    openConnect('https://app.example');

    hideForOtherScreen();
    expect(openConnect('https://other.example').state).toBe('pending');
  });

  test('while the grant is written, there is no way out and no second grant', async () => {
    const { elements, grantPermission, openConnect } = await loadDappConnect();
    let finishGrant;
    grantPermission.mockReturnValueOnce(new Promise((resolve) => (finishGrant = resolve)));
    const first = openConnect('https://app.example');

    elements['dapp-connect-approve'].dispatch('click');
    await flush();
    elements['dapp-connect-reject'].dispatch('click');
    elements['dapp-connect-back'].dispatch('click');
    elements['dapp-connect-approve'].dispatch('click');
    // Still deciding: a newcomer waits.
    expect(openConnect('https://other.example').state).toBe('rejected');

    finishGrant({ success: true });
    await flush();
    expect(first.state).toBe('resolved');
    expect(grantPermission).toHaveBeenCalledTimes(1);
  });

  test('a failed grant answers the dApp', async () => {
    const { elements, grantPermission, openConnect } = await loadDappConnect();
    grantPermission.mockRejectedValueOnce(new Error('disk full'));
    const first = openConnect('https://app.example');

    elements['dapp-connect-approve'].dispatch('click');
    await flush();
    expect(first).toMatchObject({ state: 'rejected', value: { code: -32603 } });
  });

  test("a grant's events reach only the document that asked", async () => {
    const { elements, grantPermission, openConnect, provider } = await loadDappConnect();
    let finishGrant;
    grantPermission.mockReturnValueOnce(new Promise((resolve) => (finishGrant = resolve)));
    const first = openConnect('https://app.example');

    elements['dapp-connect-approve'].dispatch('click');
    await flush();
    // The tab navigates to another site while the grant is written.
    provider.generations.set(first.webview, 1);
    finishGrant({ success: true });
    await flush();
    expect(first.webview.send).not.toHaveBeenCalled();
  });

  test("the banner follows the active tab's committed site, never the address bar", async () => {
    const { mod, elements, provider, tab } = await loadDappConnect();
    window.dappPermissions.getPermission.mockImplementation(async (key) =>
      key === 'https://app.example' ? { walletIndex: 0 } : null
    );
    window.wallet = { getDerivedWallets: jest.fn(async () => ({ success: true, wallets: [{ index: 0, name: 'Main' }] })) };
    provider.active = tab('https://other.example');
    elements['address-input'].value = 'https://app.example';

    await mod.updateConnectionBanner();
    expect(elements['dapp-connection-banner'].classList.contains('hidden')).toBe(true);
    // A background tab's connection doesn't repaint the active tab's banner.
    await mod.updateConnectionBanner('https://app.example');
    expect(elements['dapp-connection-banner'].classList.contains('hidden')).toBe(true);

    provider.active = tab('https://app.example');
    await mod.updateConnectionBanner();
    expect(elements['dapp-connection-site'].textContent).toBe('https://app.example');
  });

  test('disconnect tells the active tab only if it is the disconnected site', async () => {
    const { mod, provider, tab, emitAccountsChanged } = await loadDappConnect();
    window.dappPermissions.revokePermission = jest.fn(async () => ({ success: true }));
    provider.active = tab('https://other.example');

    await mod.disconnectDapp('https://app.example');
    expect(emitAccountsChanged).not.toHaveBeenCalled();

    provider.active = tab('https://app.example');
    await mod.disconnectDapp('https://app.example');
    expect(emitAccountsChanged).toHaveBeenCalledWith(provider.active, []);
  });
});
