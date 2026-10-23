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
