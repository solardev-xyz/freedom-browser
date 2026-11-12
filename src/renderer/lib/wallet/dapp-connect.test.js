/**
 * Tests for the dApp connection banner. Main's connect prompt (`eth.connect`)
 * is tested with the page prompts (page-prompts.test.js).
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
    getActiveDisplayUrl: jest.fn(() => activeDisplayUrl),
  };
  const sent = [];
  if (activeWebview) activeWebview.send = jest.fn((...args) => sent.push(args));
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
  return { mod, elements, provider, sent };
}

describe('dApp connection banner', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  // A key from the permissions list (permission-manage.js) can name a site in
  // another tab: revoking it must leave the visible, still-connected site's
  // banner alone. Revoking the visible site hides the banner. Main tells
  // the site's pages (freedom-core design 0011, PRQ-6): the chrome sends
  // none an event.
  test('disconnecting another site leaves the visible site\'s banner alone, and the chrome tells no page', async () => {
    const visible = {};
    const ctx = await loadDappConnect({ activeDisplayUrl: 'visible.eth', activeWebview: visible });
    const banner = ctx.elements['dapp-connection-banner'];

    await ctx.mod.updateConnectionBanner();
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['dapp-connection-site'].textContent).toBe('visible.eth');

    await ctx.mod.disconnectDapp('background.eth');
    expect(global.window.dappPermissions.revokePermission).toHaveBeenCalledWith('background.eth');
    expect(banner.classList.contains('hidden')).toBe(false);

    await ctx.mod.disconnectDapp('visible.eth');
    expect(global.window.dappPermissions.revokePermission).toHaveBeenCalledWith('visible.eth');
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(ctx.sent).toEqual([]);
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

async function loadDappConnectPrompt() {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_CONNECT_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  // As in index.html: the prompt starts hidden.
  elementsById['sidebar-dapp-connect'].classList.add('hidden');
  global.document = createDocument({ elementsById });

  global.window = {
    dappPermissions: {
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
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn(), isVisible: jest.fn(() => true) }));
  // Webviews by committed site; the active one is `provider.active`.
  const provider = { active: null, keys: new Map() };
  jest.doMock('../dapp-provider.js', () => ({
    getActiveDisplayUrl: jest.fn(() => provider.keys.get(provider.active) ?? ''),
  }));
  jest.doMock('./permission-manage.js', () => ({ showDappPermissions: jest.fn() }));

  const mod = await import('./dapp-connect.js');
  mod.initDappConnect();

  const tab = (site) => {
    const webview = {};
    provider.keys.set(webview, site);
    return webview;
  };

  return { mod, elements: elementsById, provider, tab };
}

describe('dapp-connect banner updates', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
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
