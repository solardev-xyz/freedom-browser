/**
 * Tests for the dApp Connect prompt and the connection banner. The Connect,
 * Sign and Send prompts share the sidebar: while one shows an undecided
 * request, a newcomer is refused (dapp-prompt-guard.js).
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...names) {
    for (const name of names) this.classes.add(name);
  }

  remove(...names) {
    for (const name of names) this.classes.delete(name);
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.classes.has(name) : !!force;
    if (shouldAdd) this.classes.add(name);
    else this.classes.delete(name);
    return shouldAdd;
  }
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.textContent = '';
  }

  addEventListener() {}
}

const elementIds = [
  'dapp-connection-banner',
  'dapp-connection-site',
  'dapp-connection-wallet',
  'dapp-connection-disconnect',
  'dapp-auto-approve-badge',
  'dapp-connection-manage',
];

async function loadDappConnect({ activeDisplayUrl = '', activeWebview = null } = {}) {
  jest.resetModules();

  const elements = {};
  for (const id of elementIds) {
    elements[id] = new FakeElement();
    elements[id].classList.add('hidden');
  }
  global.document = {
    getElementById: jest.fn((id) => elements[id] || null),
    addEventListener: jest.fn(),
  };
  global.window = {
    dappPermissions: {
      getPermission: jest.fn().mockResolvedValue({ walletIndex: 0, autoApprove: {} }),
      revokePermission: jest.fn().mockResolvedValue({ success: true }),
    },
    wallet: {
      getDerivedWallets: jest.fn().mockResolvedValue({ success: true, wallets: [{ index: 0, name: 'Main' }] }),
    },
  };

  const provider = {
    getActiveWebview: jest.fn(() => activeWebview),
    getActiveDisplayUrl: jest.fn(() => activeDisplayUrl),
    emitAccountsChanged: jest.fn(),
    getPermissionKey: jest.fn((url) => url || null),
    getNavigationGeneration: jest.fn(() => 0),
  };
  jest.doMock('./wallet-state.js', () => ({
    walletState: {},
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn(), isVisible: jest.fn(() => true) }));
  jest.doMock('../dapp-provider.js', () => provider);
  jest.doMock('./permission-manage.js', () => ({ showDappPermissions: jest.fn() }));

  const mod = await import('./dapp-connect.js');
  mod.initDappConnect();
  return { mod, elements, provider };
}

describe('dApp connection banner', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  // A key from the permissions list (permission-manage.js) can name a site in
  // another tab: revoking it must leave the visible, still-connected site's
  // banner and page alone. Revoking the visible site hides the banner and
  // tells its page.
  test('disconnecting another site leaves the visible site\'s banner and page alone', async () => {
    const visible = {};
    const ctx = await loadDappConnect({ activeDisplayUrl: 'visible.eth', activeWebview: visible });
    const banner = ctx.elements['dapp-connection-banner'];

    await ctx.mod.updateConnectionBanner();
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['dapp-connection-site'].textContent).toBe('visible.eth');

    await ctx.mod.disconnectDapp('background.eth');
    expect(global.window.dappPermissions.revokePermission).toHaveBeenCalledWith('background.eth');
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(ctx.provider.emitAccountsChanged).not.toHaveBeenCalled();

    await ctx.mod.disconnectDapp('visible.eth');
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(ctx.provider.emitAccountsChanged).toHaveBeenCalledWith(visible, []);
  });

  test('the banner\'s own Disconnect (no key) revokes the site it shows', async () => {
    const visible = {};
    const ctx = await loadDappConnect({ activeDisplayUrl: 'visible.eth', activeWebview: visible });
    const banner = ctx.elements['dapp-connection-banner'];

    await ctx.mod.updateConnectionBanner();
    await ctx.mod.disconnectDapp();
    expect(global.window.dappPermissions.revokePermission).toHaveBeenCalledWith('visible.eth');
    expect(banner.classList.contains('hidden')).toBe(true);
  });

  test('a refresh hint for a site that is not on screen paints nothing', async () => {
    const ctx = await loadDappConnect({ activeDisplayUrl: 'visible.eth' });
    await ctx.mod.updateConnectionBanner('background.eth');
    expect(global.window.dappPermissions.getPermission).not.toHaveBeenCalled();
    expect(ctx.elements['dapp-connection-banner'].classList.contains('hidden')).toBe(true);
  });
});

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

async function loadDappConnectPrompt() {
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
    getActiveDisplayUrl: jest.fn(() => provider.keys.get(provider.active) ?? ''),
    getPermissionKey: jest.fn((url) => url || null),
    emitAccountsChanged,
    getNavigationGeneration: jest.fn((wv) => provider.generations.get(wv) ?? 0),
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
    const { elements, grantPermission, openConnect, guard } = await loadDappConnectPrompt();
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
    const { openConnect, hideForOtherScreen } = await loadDappConnectPrompt();
    openConnect('https://app.example');

    hideForOtherScreen();
    expect(openConnect('https://other.example').state).toBe('pending');
  });

  test('while the grant is written, there is no way out and no second grant', async () => {
    const { elements, grantPermission, openConnect } = await loadDappConnectPrompt();
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
    const { elements, grantPermission, openConnect } = await loadDappConnectPrompt();
    grantPermission.mockRejectedValueOnce(new Error('disk full'));
    const first = openConnect('https://app.example');

    elements['dapp-connect-approve'].dispatch('click');
    await flush();
    expect(first).toMatchObject({ state: 'rejected', value: { code: -32603 } });
  });

  test("a grant's events reach only the document that asked", async () => {
    const { elements, grantPermission, openConnect, provider } = await loadDappConnectPrompt();
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

  test("an earlier request's favicon never lands on a later one", async () => {
    const { elements, openConnect } = await loadDappConnectPrompt();
    let faviconA;
    window.electronAPI = {
      getCachedFavicon: jest
        .fn()
        .mockReturnValueOnce(new Promise((resolve) => (faviconA = resolve)))
        .mockResolvedValue(null),
    };
    openConnect('https://a.example');
    elements['dapp-connect-reject'].dispatch('click');
    openConnect('https://b.example');
    await flush();
    faviconA('data:image/png;base64,AAAA');
    await flush();
    expect(elements['dapp-connect-favicon'].src).toBe('');
  });

  test("a stale banner lookup never repaints a newer one", async () => {
    const { mod, elements, provider, tab } = await loadDappConnectPrompt();
    let failA;
    window.wallet = { getDerivedWallets: jest.fn(async () => ({ success: true, wallets: [{ index: 0, name: 'Main' }] })) };
    window.dappPermissions.getPermission
      .mockReturnValueOnce(new Promise((_resolve, reject) => (failA = reject)))
      .mockResolvedValue({ walletIndex: 0 });
    provider.active = tab('https://a.example');
    const stale = mod.updateConnectionBanner();
    // The user switches tabs; B's banner completes first.
    provider.active = tab('https://b.example');
    await mod.updateConnectionBanner();
    expect(elements['dapp-connection-site'].textContent).toBe('https://b.example');
    failA(new Error('lookup failed'));
    await stale;
    expect(elements['dapp-connection-banner'].classList.contains('hidden')).toBe(false);
  });
});
