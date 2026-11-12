const originalWindow = global.window;
const originalDocument = global.document;

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.classes = new Set();
  }

  sync() {
    this.el._className = Array.from(this.classes).join(' ');
  }

  add(...names) {
    for (const name of names) this.classes.add(name);
    this.sync();
  }

  remove(...names) {
    for (const name of names) this.classes.delete(name);
    this.sync();
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.classes.has(name) : !!force;
    if (shouldAdd) this.classes.add(name);
    else this.classes.delete(name);
    this.sync();
    return shouldAdd;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.classList = new FakeClassList(this);
    this._className = '';
    this._innerHTML = '';
    this._textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.min = '';
    this.step = '';
  }

  set className(value) {
    this._className = String(value || '');
    this.classList.classes = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get className() {
    return this._className;
  }

  set textContent(value) {
    this._textContent = value == null ? '' : String(value);
    this._innerHTML = htmlEscape(this._textContent);
  }

  get textContent() {
    return this._textContent;
  }

  set innerHTML(value) {
    this._innerHTML = value == null ? '' : String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  async fire(event, detail = {}) {
    for (const handler of this.listeners.get(event) || []) {
      await handler({ type: event, target: this, ...detail });
    }
  }

  querySelector(selector) {
    return findDescendant(this, selector);
  }
}

function matchesSelector(el, selector) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function findDescendant(root, selector) {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) return child;
    const found = findDescendant(child, selector);
    if (found) return found;
  }
  return null;
}

const permissionElementIds = [
  'sidebar-dapp-permissions',
  'dapp-perms-back',
  'dapp-perms-site',
  'dapp-perms-signing-toggle',
  'dapp-perms-tx-list',
  'dapp-perms-disconnect',
  'sidebar-swarm-permissions',
  'swarm-perms-back',
  'swarm-perms-site',
  'swarm-perms-publish-toggle',
  'swarm-perms-feeds-toggle',
  'swarm-perms-signing-toggle',
  'swarm-perms-messaging-toggle',
  'swarm-perms-disconnect',
  'sidebar-x402-permissions',
  'x402-perms-back',
  'x402-perms-site',
  'x402-perms-error',
  'x402-perms-list',
  'x402-perms-revoke-all',
];

function createDocument() {
  const elements = {};
  for (const id of permissionElementIds) {
    elements[id] = new FakeElement();
  }
  return {
    elements,
    createElement: jest.fn((tagName) => new FakeElement(tagName)),
    getElementById: jest.fn((id) => elements[id] || null),
  };
}

function createPermission(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    origin: 'https://pay.example',
    chainId: 8453,
    asset: '0xUSDC',
    capAmount: '10000000',
    spentAmount: '2000000',
    createdAt: now - 60,
    expiresAt: now + 30 * 24 * 60 * 60,
    ...overrides,
  };
}

async function loadPermissionManage(options = {}) {
  jest.resetModules();

  const document = createDocument();
  const identityView = new FakeElement();
  const hideAllSubscreens = jest.fn();
  const registerScreenHider = jest.fn();
  const openSidebarPanel = jest.fn();
  const updateConnectionBanner = jest.fn();
  const updateSwarmConnectionBanner = jest.fn();
  const updateX402ConnectionBanner = jest.fn().mockResolvedValue(undefined);
  const disconnectDapp = jest.fn().mockResolvedValue(undefined);
  const disconnectSwarmApp = jest.fn().mockResolvedValue(undefined);
  const disconnectX402 = jest.fn().mockResolvedValue(undefined);
  const permission = options.permission || createPermission();

  document.elements['sidebar-x402-permissions'].classList.add('hidden');
  document.elements['x402-perms-error'].classList.add('hidden');

  global.document = document;
  global.window = {
    wallet: {
      confirmSigning: jest.fn().mockResolvedValue(
        options.mintResult || { success: true, token: 'cap-edit-token', expiresAt: 0 }
      ),
    },
    dappPermissions: {
      getPermission: jest.fn().mockResolvedValue(null),
      setSigningAutoApprove: jest.fn().mockResolvedValue({ success: true }),
      removeTransactionAutoApprove: jest.fn().mockResolvedValue({ success: true }),
    },
    swarmPermissions: {
      getPermission: jest.fn().mockResolvedValue(null),
      setAutoApprove: jest.fn().mockResolvedValue({ success: true }),
    },
    electronAPI: {
      x402GetAllPermissions: jest.fn().mockResolvedValue({
        success: true,
        permissions: [permission],
      }),
      x402UpdatePermission: jest.fn().mockResolvedValue(
        options.updateResult || { success: true }
      ),
    },
    tokens: {
      getToken: jest.fn().mockResolvedValue({
        success: true,
        token: options.token || { symbol: 'USDC', decimals: 6 },
      }),
    },
    networks: {
      getChain: jest.fn().mockResolvedValue({
        success: true,
        chain: options.chain || { chainId: 8453, name: 'Base' },
      }),
    },
  };

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView },
    hideAllSubscreens,
    registerScreenHider,
  }));
  jest.doMock('../sidebar.js', () => ({ open: openSidebarPanel }));
  jest.doMock('./dapp-connect.js', () => ({
    updateConnectionBanner,
    disconnectDapp,
  }));
  jest.doMock('./swarm-connect.js', () => ({
    updateSwarmConnectionBanner,
    disconnectSwarmApp,
  }));
  jest.doMock('./dapp-x402.js', () => ({
    updateX402ConnectionBanner,
    disconnectX402,
  }));

  const mod = await import('./permission-manage.js');
  mod.initPermissionManage();

  return {
    mod,
    document,
    elements: document.elements,
    identityView,
    hideAllSubscreens,
    openSidebarPanel,
    updateX402ConnectionBanner,
    disconnectX402,
    electronAPI: global.window.electronAPI,
    wallet: global.window.wallet,
  };
}

describe('permission-manage x402 subscreen', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('renders active caps and saves spend-cap edits', async () => {
    const ctx = await loadPermissionManage();

    await ctx.mod.showX402Permissions('https://pay.example');

    const list = ctx.elements['x402-perms-list'];
    const block = list.children[0];
    const capInput = block.querySelector('input');

    expect(ctx.hideAllSubscreens).toHaveBeenCalled();
    expect(ctx.openSidebarPanel).toHaveBeenCalled();
    expect(ctx.elements['sidebar-x402-permissions'].classList.contains('hidden')).toBe(false);
    expect(ctx.identityView.classList.contains('hidden')).toBe(true);
    expect(ctx.elements['x402-perms-site'].textContent).toBe('https://pay.example');
    expect(block.querySelector('.x402-perm-asset-name').textContent).toBe('USDC');
    expect(block.querySelector('.x402-perm-usage-summary').textContent).toBe('2 of 10 USDC spent');
    expect(capInput.value).toBe('10');

    capInput.value = '25';
    await capInput.fire('change');

    // The edit is confirmed with main first, then applied with that token.
    const edit = {
      origin: 'https://pay.example',
      chainId: 8453,
      asset: '0xUSDC',
      capAmount: '25000000',
    };
    expect(ctx.wallet.confirmSigning).toHaveBeenCalledWith('x402-cap-update', null, edit);
    expect(ctx.electronAPI.x402UpdatePermission).toHaveBeenCalledWith({
      ...edit,
      confirmation: 'cap-edit-token',
    });
    expect(ctx.updateX402ConnectionBanner).toHaveBeenCalledWith('https://pay.example');
    expect(ctx.elements['x402-perms-error'].classList.contains('hidden')).toBe(true);
  });

  test('a cap edit main refuses to confirm is not applied', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadPermissionManage({
      mintResult: { success: false, error: 'No such auto-pay cap' },
    });

    await ctx.mod.showX402Permissions('https://pay.example');
    const capInput = ctx.elements['x402-perms-list'].children[0].querySelector('input');
    capInput.value = '25';
    await capInput.fire('change');

    expect(ctx.electronAPI.x402UpdatePermission).not.toHaveBeenCalled();
    expect(ctx.elements['x402-perms-error'].textContent).toBe('No such auto-pay cap');
  });

  test('surfaces failed cap edits and refreshes the permission views', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadPermissionManage({
      updateResult: { success: false, error: 'Cap update rejected.' },
    });

    await ctx.mod.showX402Permissions('https://pay.example');
    const capInput = ctx.elements['x402-perms-list'].children[0].querySelector('input');

    capInput.value = '25';
    await capInput.fire('change');

    expect(ctx.elements['x402-perms-error'].textContent).toBe('Cap update rejected.');
    expect(ctx.elements['x402-perms-error'].classList.contains('hidden')).toBe(false);
    expect(ctx.updateX402ConnectionBanner).toHaveBeenCalledWith('https://pay.example');
  });

  test('revokes all x402 caps for the current origin and closes the subscreen', async () => {
    const ctx = await loadPermissionManage();

    await ctx.mod.showX402Permissions('https://pay.example');
    await ctx.elements['x402-perms-revoke-all'].fire('click');

    expect(ctx.disconnectX402).toHaveBeenCalledWith('https://pay.example');
    expect(ctx.elements['sidebar-x402-permissions'].classList.contains('hidden')).toBe(true);
    expect(ctx.identityView.classList.contains('hidden')).toBe(false);
  });
});

// freedom-core design 0011, PRQ-5a: main sets a site's signing rule from the
// user's "always allow" on a signing prompt. Here it can only be turned off.
describe('permission-manage: the signing rule can only be turned off here (0011 PRQ-5a)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('an off rule shows disabled; an on rule turns off, and stays off', async () => {
    const ctx = await loadPermissionManage();
    const toggle = ctx.elements['dapp-perms-signing-toggle'];
    global.window.dappPermissions.getPermission.mockResolvedValue({ walletIndex: 0, autoApprove: { signing: false } });
    await ctx.mod.showDappPermissions('https://app.example');
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);

    global.window.dappPermissions.getPermission.mockResolvedValue({ walletIndex: 0, autoApprove: { signing: true } });
    await ctx.mod.showDappPermissions('https://app.example');
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    toggle.checked = false;
    await toggle.fire('change');
    await Promise.resolve();
    expect(global.window.dappPermissions.setSigningAutoApprove).toHaveBeenCalledWith('https://app.example', false);
    expect(toggle.disabled).toBe(true);
  });

  test('turning it on asks main for nothing', async () => {
    const ctx = await loadPermissionManage();
    const toggle = ctx.elements['dapp-perms-signing-toggle'];
    global.window.dappPermissions.getPermission.mockResolvedValue({ walletIndex: 0, autoApprove: { signing: false } });
    await ctx.mod.showDappPermissions('https://app.example');
    toggle.checked = true;
    await toggle.fire('change');
    expect(toggle.checked).toBe(false);
    expect(global.window.dappPermissions.setSigningAutoApprove).not.toHaveBeenCalled();
  });
});

// freedom-core design 0011, PRQ-7b: main grants Swarm messaging from the
// user's decision on its own messaging prompt. Here it can only be revoked.
describe('permission-manage: Swarm messaging can only be revoked here (0011 PRQ-7b)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  async function showSwarm(ctx, granted) {
    Object.assign(global.window.swarmPermissions, {
      getPermission: jest.fn().mockResolvedValue({ origin: 'bzz://aaaa', autoApprove: {} }),
      hasMessagingGrant: jest.fn().mockResolvedValue(granted),
      revokeMessaging: jest.fn().mockResolvedValue(true),
    });
    global.window.identity = { getStatus: jest.fn().mockResolvedValue({ isUnlocked: true }) };
    global.window.swarmFeedStore = {
      getOriginIdentities: jest.fn().mockResolvedValue({ activeIdentityId: 'a', identities: [{ id: 'a', mode: 'app-scoped', stored: true }] }),
    };
    await ctx.mod.showSwarmPermissions('bzz://aaaa');
    return ctx.elements['swarm-perms-messaging-toggle'];
  }

  test('no grant shows disabled, and turning it on asks main for nothing', async () => {
    const ctx = await loadPermissionManage();
    const toggle = await showSwarm(ctx, false);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    toggle.checked = true;
    await toggle.fire('change');
    expect(toggle.checked).toBe(false);
  });

  test('a grant can be revoked, and then shows disabled', async () => {
    const ctx = await loadPermissionManage();
    const toggle = await showSwarm(ctx, true);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    toggle.checked = false;
    await toggle.fire('change');
    expect(global.window.swarmPermissions.revokeMessaging).toHaveBeenCalledWith('bzz://aaaa');
    expect(toggle.disabled).toBe(true);
  });
});

// Publishing's rule is turned on only by "Always allow" on main's publish
// prompt (freedom-core design 0011, PRQ-7c): the site's screen only turns
// it off.
describe('the Swarm auto-approve toggles: publish (PRQ-7c), feeds and signing (PRQ-7d)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  async function showSwarm(ctx, publish, type = 'publish') {
    Object.assign(global.window.swarmPermissions, {
      getPermission: jest.fn().mockResolvedValue({ origin: 'bzz://aaaa', autoApprove: { [type]: publish } }),
      hasMessagingGrant: jest.fn().mockResolvedValue(false),
      setAutoApprove: jest.fn().mockResolvedValue(true),
    });
    global.window.identity = { getStatus: jest.fn().mockResolvedValue({ isUnlocked: true }) };
    global.window.swarmFeedStore = {
      getOriginIdentities: jest.fn().mockResolvedValue({ activeIdentityId: 'a', identities: [{ id: 'a', mode: 'app-scoped', stored: true }] }),
    };
    await ctx.mod.showSwarmPermissions('bzz://aaaa');
    return ctx.elements[`swarm-perms-${type}-toggle`];
  }

  test.each(['publish', 'feeds', 'signing'])('%s: off shows disabled, and turning it on asks main for nothing', async (type) => {
    const ctx = await loadPermissionManage();
    const toggle = await showSwarm(ctx, false, type);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    toggle.checked = true;
    await toggle.fire('change');
    expect(toggle.checked).toBe(false);
    expect(global.window.swarmPermissions.setAutoApprove).not.toHaveBeenCalled();
  });

  test.each(['publish', 'feeds', 'signing'])('%s: on can be turned off, and then shows disabled', async (type) => {
    const ctx = await loadPermissionManage();
    const toggle = await showSwarm(ctx, true, type);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    toggle.checked = false;
    await toggle.fire('change');
    expect(global.window.swarmPermissions.setAutoApprove).toHaveBeenCalledWith('bzz://aaaa', type, false);
    expect(toggle.disabled).toBe(true);
  });
});
