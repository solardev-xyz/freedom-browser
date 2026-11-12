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
    this.listeners = new Map();
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
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
}

const elementIds = [
  'sidebar-swarm-connect',
  'swarm-connect-back',
  'swarm-connect-site',
  'swarm-connect-reject',
  'swarm-connect-approve',
  'swarm-connection-banner',
  'swarm-connection-site',
  'swarm-connection-disconnect',
  'swarm-auto-approve-badge',
  'swarm-connection-manage',
  'sidebar-swarm-publish-approve',
  'swarm-publish-back',
  'swarm-publish-site',
  'swarm-publish-type',
  'swarm-publish-size',
  'swarm-publish-name-row',
  'swarm-publish-name',
  'swarm-publish-paths-row',
  'swarm-publish-paths',
  'swarm-publish-reject',
  'swarm-publish-confirm',
  'swarm-publish-auto-approve',
  'sidebar-swarm-messaging-approve',
  'swarm-messaging-back',
  'swarm-messaging-title',
  'swarm-messaging-site',
  'swarm-messaging-wants',
  'swarm-messaging-topic-row',
  'swarm-messaging-topic',
  'swarm-messaging-size-row',
  'swarm-messaging-size',
  'swarm-messaging-warning',
  'swarm-messaging-auto-approve-label',
  'swarm-messaging-auto-approve',
  'swarm-messaging-reject',
  'swarm-messaging-confirm',
  'sidebar-swarm-feed-approve',
  'swarm-feed-back',
  'swarm-feed-title',
  'swarm-feed-site',
  'swarm-feed-wants',
  'swarm-feed-detail-label',
  'swarm-feed-name',
  'swarm-feed-identity-choice',
  'swarm-feed-identity-selector',
  'swarm-feed-reject',
  'swarm-feed-approve',
  'swarm-feed-auto-approve',
  'swarm-feed-auto-approve-label',
  'swarm-feed-warning',
  'swarm-feed-unlock',
  'address-input',
];

function createDocument() {
  const elements = {};
  for (const id of elementIds) {
    elements[id] = new FakeElement();
    elements[id].classList.add('hidden');
  }
  return {
    elements,
    getElementById: jest.fn((id) => elements[id] || null),
    addEventListener: jest.fn(),
  };
}

async function loadSwarmConnect() {
  jest.resetModules();

  const document = createDocument();
  const identityView = new FakeElement();
  const openSidebarPanel = jest.fn();

  // Real screen-hider wiring: hideAllSubscreens() runs every registered
  // hider, which is what made concurrent prompts clobber each other.
  const screenHiders = [];
  const hideAllSubscreens = jest.fn(() => screenHiders.forEach((fn) => fn()));

  global.document = document;
  global.window = {
    swarmPermissions: {
      getPermission: jest.fn().mockResolvedValue(null),
      setAutoApprove: jest.fn().mockResolvedValue({ success: true }),
    },
    pagePrompts: {
      decide: jest.fn().mockResolvedValue({ ok: true }),
    },
    identity: {
      getStatus: jest.fn().mockResolvedValue({ isUnlocked: true }),
    },
    swarmFeedStore: {
      getOriginIdentities: jest.fn().mockResolvedValue({
        activeIdentityId: 'ident-1',
        identities: [{ id: 'ident-1', mode: 'app-scoped', stored: true }],
      }),
      activateFeedIdentity: jest.fn().mockResolvedValue({ success: true }),
    },
  };

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView },
    registerScreenHider: (fn) => screenHiders.push(fn),
    hideAllSubscreens,
  }));
  jest.doMock('../sidebar.js', () => ({
    open: openSidebarPanel,
    isVisible: jest.fn(() => false),
  }));
  jest.doMock('../origin-utils.js', () => ({
    ...jest.requireActual('../origin-utils.js'),
    getPermissionKey: jest.fn((url) => url),
  }));
  jest.doMock('../dapp-provider.js', () => ({
    getActiveWebview: jest.fn(() => null),
    getActivePageUrl: jest.fn(() => ''),
  }));
  jest.doMock('./permission-manage.js', () => ({ showSwarmPermissions: jest.fn() }));
  const renderPublisherIdentitySelector = jest.fn();
  jest.doMock('./publisher-identity-selector.js', () => ({
    BEE_WALLET_IDENTITY_ID: 'bee-wallet',
    getActivePublisherIdentity: jest.fn(
      (state) =>
        state?.identities?.find((identity) => identity.id === state.activeIdentityId) ?? null
    ),
    identityLabel: jest.fn((identity) => identity?.label || identity?.mode || 'Publisher identity'),
    renderPublisherIdentitySelector,
  }));

  const mod = await import('./swarm-connect.js');
  const pagePromptRenderers = await import('../page-prompt-renderers.js');
  mod.initSwarmConnect();

  return {
    mod,
    pagePromptRenderers,
    elements: document.elements,
    hideAllSubscreens,
    openSidebarPanel,
    renderPublisherIdentitySelector,
  };
}

const SITE = { key: 'bzz://aaaa', label: 'bzz://aaaa' };

// Main's prompt of `kind`, as `page:prompt` brings it to the screen.
function showPrompt(ctx, kind, handle, view = {}, site = SITE) {
  ctx.pagePromptRenderers.pagePromptRenderer(kind).show({ handle, guest: 7, kind, site, view });
}

// A freshly presented prompt ignores clicks for its input-protection window
// (PROMPT_ARM_DELAY_MS) so a double-click cannot settle a prompt the user has
// not seen. Tests step past it explicitly.
async function armPrompt() {
  jest.advanceTimersByTime(600);
  await Promise.resolve();
}

describe('swarm screens queue main\'s prompts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a second messaging prompt waits its turn instead of clobbering the first', async () => {
    const ctx = await loadSwarmConnect();
    const screen = ctx.elements['sidebar-swarm-messaging-approve'];
    const { decide } = global.window.pagePrompts;

    showPrompt(ctx, 'swarm.messaging', 'm1', { method: 'swarm_subscribe', grantMode: true, topic: 'alpha' });
    showPrompt(ctx, 'swarm.messaging', 'm2', { method: 'swarm_subscribe', grantMode: false, topic: 'beta' });

    // Only the first prompt is on screen; the second is queued, not answered.
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-messaging-topic'].textContent).toBe('alpha');
    expect(ctx.elements['swarm-messaging-title'].textContent).toBe('Messaging Access');
    expect(decide).not.toHaveBeenCalled();

    // Allow answers the first prompt only, then shows the queued one.
    await armPrompt();
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(decide.mock.calls).toEqual([['m1', true, {}]]);
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-messaging-topic'].textContent).toBe('beta');
    expect(ctx.elements['swarm-messaging-title'].textContent).toBe('Confirm Message');

    // Allow answers the second prompt and leaves the screen closed.
    await armPrompt();
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('m2', true, {});
    expect(screen.classList.contains('hidden')).toBe(true);
  });

  test('rejecting a messaging prompt answers only that one and shows the next', async () => {
    const ctx = await loadSwarmConnect();
    const { decide } = global.window.pagePrompts;

    showPrompt(ctx, 'swarm.messaging', 'm1', { method: 'swarm_sendPss', topic: 'alpha', size: 3 });
    showPrompt(ctx, 'swarm.messaging', 'm2', { method: 'swarm_sendPss', topic: 'beta', size: 3 });

    await armPrompt();
    await ctx.elements['swarm-messaging-reject'].fire('click');

    expect(decide.mock.calls).toEqual([['m1', false, {}]]);
    expect(ctx.elements['sidebar-swarm-messaging-approve'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-messaging-topic'].textContent).toBe('beta');

    await armPrompt();
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('m2', true, { alwaysAllow: false });
  });

  test('dismissing the messaging screen reports every queued prompt displaced', async () => {
    const ctx = await loadSwarmConnect();
    const displaced = jest.fn();
    ctx.pagePromptRenderers.onPagePromptDisplaced(displaced);

    showPrompt(ctx, 'swarm.messaging', 'm1', { method: 'swarm_sendPss' });
    showPrompt(ctx, 'swarm.messaging', 'm2', { method: 'swarm_sendPss' });

    // Another screen taking over the sidebar fires every screen hider.
    ctx.hideAllSubscreens();

    expect(displaced.mock.calls).toEqual([['m1'], ['m2']]);
    expect(global.window.pagePrompts.decide).not.toHaveBeenCalled();
    expect(ctx.elements['sidebar-swarm-messaging-approve'].classList.contains('hidden')).toBe(true);
  });

  test('concurrent publish prompts queue as well', async () => {
    const ctx = await loadSwarmConnect();
    const { decide } = global.window.pagePrompts;

    showPrompt(ctx, 'swarm.publish', 'p1', { method: 'swarm_publishData', kind: 'data', size: 3, contentType: 'text/plain', name: 'first.txt' });
    showPrompt(ctx, 'swarm.publish', 'p2', { method: 'swarm_publishData', kind: 'data', size: 3, contentType: 'text/plain', name: 'second.txt' });

    expect(ctx.elements['swarm-publish-name'].textContent).toBe('first.txt');

    await armPrompt();
    await ctx.elements['swarm-publish-confirm'].fire('click');
    expect(decide.mock.calls).toEqual([['p1', true, { alwaysAllow: false }]]);
    expect(ctx.elements['sidebar-swarm-publish-approve'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-publish-name'].textContent).toBe('second.txt');

    await armPrompt();
    await ctx.elements['swarm-publish-confirm'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('p2', true, { alwaysAllow: false });
  });

  test('concurrent connect prompts queue as well', async () => {
    const ctx = await loadSwarmConnect();
    const { decide } = global.window.pagePrompts;

    showPrompt(ctx, 'swarm.connect', 'c1', {}, { key: 'a.eth', label: 'a.eth' });
    showPrompt(ctx, 'swarm.connect', 'c2', {}, { key: 'b.eth', label: 'b.eth' });

    expect(ctx.elements['swarm-connect-site'].textContent).toBe('a.eth');

    await armPrompt();
    await ctx.elements['swarm-connect-approve'].fire('click');
    expect(decide.mock.calls).toEqual([['c1', true, {}]]);
    expect(ctx.elements['sidebar-swarm-connect'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-connect-site'].textContent).toBe('b.eth');

    await armPrompt();
    await ctx.elements['swarm-connect-reject'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('c2', false, {});
  });

  test('double-clicking Approve answers one prompt and leaves the queued one on screen', async () => {
    const ctx = await loadSwarmConnect();
    const { decide } = global.window.pagePrompts;

    showPrompt(ctx, 'swarm.connect', 'c1', {}, { key: 'a.eth', label: 'a.eth' });
    showPrompt(ctx, 'swarm.connect', 'c2', {}, { key: 'b.eth', label: 'b.eth' });

    await armPrompt();
    // Two clicks landing before the first approval finishes: the second must
    // not answer the prompt again, nor the one queued behind it.
    await Promise.all([
      ctx.elements['swarm-connect-approve'].fire('click'),
      ctx.elements['swarm-connect-approve'].fire('click'),
    ]);

    expect(decide.mock.calls).toEqual([['c1', true, {}]]);
    // The queued prompt is on screen, not silently dropped.
    expect(ctx.elements['sidebar-swarm-connect'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-connect-site'].textContent).toBe('b.eth');

    await armPrompt();
    await ctx.elements['swarm-connect-approve'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('c2', true, {});
  });

  test('a click landing on a just-presented prompt is ignored until the user can read it', async () => {
    const ctx = await loadSwarmConnect();
    const { decide } = global.window.pagePrompts;

    showPrompt(ctx, 'swarm.messaging', 'm1', { method: 'swarm_subscribe', grantMode: true, topic: 'grant' });
    showPrompt(ctx, 'swarm.messaging', 'm2', { method: 'swarm_sendGsoc', topic: 'send', size: 3 });

    await armPrompt();
    // The click that approves the grant prompt also presents the send prompt.
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(ctx.elements['swarm-messaging-topic'].textContent).toBe('send');

    // The second half of a double-click lands on the send prompt's buttons.
    expect(ctx.elements['swarm-messaging-confirm'].disabled).toBe(true);
    expect(ctx.elements['swarm-messaging-reject'].disabled).toBe(true);
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(ctx.elements['sidebar-swarm-messaging-approve'].classList.contains('hidden')).toBe(false);

    // Once the window has elapsed the same click answers it normally.
    await armPrompt();
    expect(ctx.elements['swarm-messaging-confirm'].disabled).toBe(false);
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('m2', true, { alwaysAllow: false });
  });

  test('the feed Always-allow choice survives a queued prompt resetting the checkbox', async () => {
    const ctx = await loadSwarmConnect();
    const { decide } = global.window.pagePrompts;
    const identities = [{ id: 'ident-1', mode: 'app-scoped', shared: false, stored: true }];

    showPrompt(ctx, 'swarm.feed', 'f1', { method: 'swarm_createFeed', mode: 'feeds', name: 'first-feed', identities, activeIdentityId: 'ident-1' });
    showPrompt(ctx, 'swarm.feed', 'f2', { method: 'swarm_updateFeed', mode: 'feeds', name: 'second-feed', identities, activeIdentityId: 'ident-1' });

    await armPrompt();
    ctx.elements['swarm-feed-auto-approve'].checked = true;
    await ctx.elements['swarm-feed-approve'].fire('click');

    // Presenting the queued prompt reset the shared checkbox — the choice the
    // user actually made must still be the answer.
    expect(ctx.elements['swarm-feed-auto-approve'].checked).toBe(false);
    expect(decide.mock.calls).toEqual([['f1', true, { identity: 'ident-1', alwaysAllow: true }]]);
    expect(ctx.elements['swarm-feed-name'].textContent).toBe('second-feed');
  });
});

describe('Single Owner Chunk prompt under a shared identity (SW-1)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
  });

  async function showSigning(method, identities) {
    const ctx = await loadSwarmConnect();
    showPrompt(ctx, 'swarm.feed', 's1', {
      method,
      mode: 'signing',
      identifier: 'ab'.repeat(32),
      identities,
      activeIdentityId: identities[0].id,
    });
    await armPrompt();
    return ctx;
  }

  test('says the identity is shared and keeps Allow off until another is chosen', async () => {
    const ctx = await showSigning('swarm_writeSingleOwnerChunk', [
      { id: 'bee-wallet', mode: 'bee-wallet', label: 'Ant wallet identity', shared: true },
      { id: 'app-scoped:3', mode: 'app-scoped', label: 'App-scoped identity 4', shared: false },
    ]);
    expect(ctx.elements['swarm-feed-approve'].disabled).toBe(true);

    // The user picks the identity only this site uses.
    const { onSelect } = ctx.renderPublisherIdentitySelector.mock.calls.at(-1)[2];
    await onSelect({ id: 'app-scoped:3', mode: 'app-scoped', shared: false });
    expect(ctx.elements['swarm-feed-warning'].textContent).toBe(
      'Publisher signing can create Single Owner Chunks and reveal the active publisher owner for this site.'
    );
    expect(ctx.elements['swarm-feed-approve'].disabled).toBe(false);

    // And back to the shared one: the notice says why Allow is off.
    await onSelect({ id: 'bee-wallet', mode: 'bee-wallet', label: 'Ant wallet identity', shared: true });
    const warning = ctx.elements['swarm-feed-warning'].textContent;
    expect(warning).toContain('Ant wallet identity is also used by other sites');
    expect(warning).toContain('cannot write Single Owner Chunks');
    expect(ctx.elements['swarm-feed-approve'].disabled).toBe(true);
  });

  test('disclosing a shared signing identity is allowed, with the notice', async () => {
    const ctx = await showSigning('swarm_getSigningIdentity', [
      { id: 'app-scoped:1', mode: 'app-scoped', label: 'App-scoped identity 2', shared: false },
      { id: 'ethereum-wallet:0', mode: 'ethereum-wallet', label: 'Main Wallet', shared: true },
    ]);

    const { onSelect } = ctx.renderPublisherIdentitySelector.mock.calls.at(-1)[2];
    await onSelect({ id: 'ethereum-wallet:0', mode: 'ethereum-wallet', label: 'Main Wallet', shared: true });
    expect(ctx.elements['swarm-feed-warning'].textContent).toBe(
      'Main Wallet is also used by other sites: they sign as the same owner address.'
    );
    expect(ctx.elements['swarm-feed-approve'].disabled).toBe(false);
  });
});

describe('disconnectSwarmApp', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  // A key from the permissions list can name a site in another tab: revoking
  // it must leave the visible, still-connected site's banner alone; revoking
  // the visible site hides the banner. Main tells the site's pages, every
  // one of them (freedom-core design 0011, PRQ-7b): the chrome sends no
  // event into a page.
  test('hides the banner only when the revoked site is the one it shows', async () => {
    const ctx = await loadSwarmConnect();
    const provider = await import('../dapp-provider.js');
    const visible = { send: jest.fn() };
    provider.getActivePageUrl.mockReturnValue('bzz://visible');
    provider.getActiveWebview.mockReturnValue(visible);
    global.window.swarmPermissions.getPermission.mockResolvedValue({ autoApprove: {} });
    global.window.swarmPermissions.revokePermission = jest.fn().mockResolvedValue({ success: true });
    const banner = ctx.elements['swarm-connection-banner'];

    await ctx.mod.updateSwarmConnectionBanner();
    expect(banner.classList.contains('hidden')).toBe(false);

    await ctx.mod.disconnectSwarmApp('bzz://background');
    expect(global.window.swarmPermissions.revokePermission).toHaveBeenCalledWith('bzz://background');
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(visible.send).not.toHaveBeenCalled();

    await ctx.mod.disconnectSwarmApp('bzz://visible');
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(visible.send).not.toHaveBeenCalled();
  });
});

// Main's own prompts for a page's requests (freedom-core design 0011,
// PRQ-7b): the screens render what main sends and answer its handle alone.
// They name no site and write no grant.
describe('main\'s Swarm prompts in the chrome', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('swarm.connect: main\'s site shows, and Connect answers the handle once armed, writing nothing itself', async () => {
    const ctx = await loadSwarmConnect();
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.connect');
    renderer.show({ handle: 'h1', guest: 7, kind: 'swarm.connect', site: SITE, view: {} });
    const screen = ctx.elements['sidebar-swarm-connect'];
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-connect-site'].textContent).toBe('bzz://aaaa');
    expect(renderer.isShowing()).toBe('h1');
    // Inside the input-protection window a click does nothing.
    await ctx.elements['swarm-connect-approve'].fire('click');
    expect(global.window.pagePrompts.decide).not.toHaveBeenCalled();
    await armPrompt();
    await ctx.elements['swarm-connect-approve'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenCalledWith('h1', true, {});
    expect(screen.classList.contains('hidden')).toBe(true);
    expect(renderer.isShowing()).toBe(null);
  });

  test('swarm.connect: Reject answers the handle; main closing it takes the screen down', async () => {
    const ctx = await loadSwarmConnect();
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.connect');
    renderer.show({ handle: 'h2', guest: 7, kind: 'swarm.connect', site: SITE, view: {} });
    await armPrompt();
    await ctx.elements['swarm-connect-reject'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenCalledWith('h2', false, {});

    renderer.show({ handle: 'h3', guest: 7, kind: 'swarm.connect', site: SITE, view: {} });
    expect(renderer.isShowing()).toBe('h3');
    renderer.close('h3');
    expect(ctx.elements['sidebar-swarm-connect'].classList.contains('hidden')).toBe(true);
    expect(renderer.isShowing()).toBe(null);
    await armPrompt();
    await ctx.elements['swarm-connect-approve'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenCalledTimes(1);
  });

  test('a screen another one takes the sidebar from reports main\'s prompt displaced, and rejects nothing', async () => {
    const ctx = await loadSwarmConnect();
    const displaced = jest.fn();
    ctx.pagePromptRenderers.onPagePromptDisplaced(displaced);
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.connect');
    renderer.show({ handle: 'h4', guest: 7, kind: 'swarm.connect', site: SITE, view: {} });
    showPrompt(ctx, 'swarm.publish', 'p9', { method: 'swarm_publishData', kind: 'data', size: 1 });
    expect(displaced).toHaveBeenCalledWith('h4');
    expect(renderer.isShowing()).toBe(null);
    expect(global.window.pagePrompts.decide).not.toHaveBeenCalled();
  });

  test('swarm.messaging: a send shows main\'s topic and size and offers "always allow"; the grant prompt offers none', async () => {
    const ctx = await loadSwarmConnect();
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.messaging');
    renderer.show({
      handle: 'm1',
      guest: 7,
      kind: 'swarm.messaging',
      site: SITE,
      view: { method: 'swarm_sendPss', grantMode: false, topic: 'room', size: 5 },
    });
    expect(ctx.elements['swarm-messaging-site'].textContent).toBe('bzz://aaaa');
    expect(ctx.elements['swarm-messaging-topic'].textContent).toBe('room');
    expect(ctx.elements['swarm-messaging-size'].textContent).toContain('5');
    expect(ctx.elements['swarm-messaging-size-row'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-messaging-auto-approve-label'].classList.contains('hidden')).toBe(false);
    ctx.elements['swarm-messaging-auto-approve'].checked = true;
    await armPrompt();
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenCalledWith('m1', true, { alwaysAllow: true });
    expect(global.window.swarmPermissions.setAutoApprove).not.toHaveBeenCalled();

    renderer.show({
      handle: 'm2',
      guest: 7,
      kind: 'swarm.messaging',
      site: SITE,
      view: { method: 'swarm_subscribe', grantMode: true },
    });
    expect(ctx.elements['swarm-messaging-title'].textContent).toBe('Messaging Access');
    expect(ctx.elements['swarm-messaging-auto-approve-label'].classList.contains('hidden')).toBe(true);
    ctx.elements['swarm-messaging-auto-approve'].checked = true;
    await armPrompt();
    await ctx.elements['swarm-messaging-confirm'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenLastCalledWith('m2', true, {});
  });

  test('swarm.publish: main\'s view shows (a files upload\'s count, size and paths, a data upload\'s type, size and name); Publish answers the handle with "always allow", writing no rule', async () => {
    const ctx = await loadSwarmConnect();
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.publish');
    renderer.show({
      handle: 'p1',
      guest: 7,
      kind: 'swarm.publish',
      site: SITE,
      view: { method: 'swarm_publishFiles', kind: 'files', count: 5, size: 2048, paths: ['index.html', 'a.js', 'b.css'] },
    });
    expect(ctx.elements['sidebar-swarm-publish-approve'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-publish-site'].textContent).toBe('bzz://aaaa');
    expect(ctx.elements['swarm-publish-type'].textContent).toBe('5 files');
    expect(ctx.elements['swarm-publish-size'].textContent).toContain('2');
    expect(ctx.elements['swarm-publish-paths'].textContent).toBe('index.html, a.js, b.css \u2026and 2 more');
    expect(ctx.elements['swarm-publish-paths-row'].classList.contains('hidden')).toBe(false);
    expect(renderer.isShowing()).toBe('p1');
    ctx.elements['swarm-publish-auto-approve'].checked = true;
    await armPrompt();
    await ctx.elements['swarm-publish-confirm'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenCalledWith('p1', true, { alwaysAllow: true });
    expect(global.window.swarmPermissions.setAutoApprove).not.toHaveBeenCalled();
    expect(renderer.isShowing()).toBe(null);

    renderer.show({
      handle: 'p2',
      guest: 7,
      kind: 'swarm.publish',
      site: SITE,
      view: { method: 'swarm_publishData', kind: 'data', size: 5, contentType: 'text/plain', name: 'note.txt' },
    });
    // A new prompt starts with "always allow" off.
    expect(ctx.elements['swarm-publish-auto-approve'].checked).toBe(false);
    expect(ctx.elements['swarm-publish-type'].textContent).toBe('text/plain');
    expect(ctx.elements['swarm-publish-name'].textContent).toBe('note.txt');
    expect(ctx.elements['swarm-publish-name-row'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-publish-paths-row'].classList.contains('hidden')).toBe(true);
    await armPrompt();
    await ctx.elements['swarm-publish-reject'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenLastCalledWith('p2', false, {});

    renderer.show({ handle: 'p3', guest: 7, kind: 'swarm.publish', site: SITE, view: { method: 'swarm_publishChunk', kind: 'chunk', size: 40 } });
    expect(ctx.elements['swarm-publish-type'].textContent).toBe('Swarm chunk');
    expect(ctx.elements['swarm-publish-name-row'].classList.contains('hidden')).toBe(true);
    renderer.close('p3');
    expect(ctx.elements['sidebar-swarm-publish-approve'].classList.contains('hidden')).toBe(true);
    expect(global.window.pagePrompts.decide).toHaveBeenCalledTimes(2);
  });

  test('swarm.feed: main\'s identities and owners show, with no unlock asked; Allow answers the handle with the pick and "always allow", writing nothing itself', async () => {
    const ctx = await loadSwarmConnect();
    global.window.identity.getStatus.mockClear();
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.feed');
    const view = {
      method: 'swarm_writeSingleOwnerChunk',
      mode: 'signing',
      identifier: 'cc'.repeat(32),
      identities: [{ id: 'bee-wallet', mode: 'bee-wallet', label: 'Ant wallet identity', owner: '0xBee', shared: true, stored: true }],
      newIdentity: { id: 'app-scoped:4', mode: 'app-scoped', label: 'App-scoped identity 5', owner: '0xPub4', shared: false, stored: false },
      activeIdentityId: 'bee-wallet',
    };
    renderer.show({ handle: 'f1', guest: 7, kind: 'swarm.feed', site: SITE, view });
    expect(ctx.elements['sidebar-swarm-feed-approve'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-feed-site'].textContent).toBe('bzz://aaaa');
    expect(ctx.elements['swarm-feed-title'].textContent).toBe('Publisher Signing');
    expect(ctx.elements['swarm-feed-name'].textContent).toBe(`Single Owner Chunk ${'cc'.repeat(32)}`);
    expect(ctx.elements['swarm-feed-unlock'].classList.contains('hidden')).toBe(true);
    // Main's identities, not the chrome's own reads.
    const [, state, handlers] = ctx.renderPublisherIdentitySelector.mock.calls.at(-1);
    expect(state).toEqual({ activeIdentityId: 'bee-wallet', identities: view.identities });
    expect(global.window.swarmFeedStore.getOriginIdentities).not.toHaveBeenCalled();
    expect(global.window.identity.getStatus).not.toHaveBeenCalled();
    await armPrompt();
    // A raw chunk under the shared Ant wallet: Allow stays off.
    expect(ctx.elements['swarm-feed-approve'].disabled).toBe(true);
    // "Create new app-scoped identity" offers main's new one, with no request.
    await handlers.onCreateAppScoped();
    expect(ctx.renderPublisherIdentitySelector.mock.calls.at(-1)[1].activeIdentityId).toBe('app-scoped:4');
    expect(ctx.elements['swarm-feed-approve'].disabled).toBe(false);
    ctx.elements['swarm-feed-auto-approve'].checked = true;
    await ctx.elements['swarm-feed-approve'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenCalledWith('f1', true, { identity: 'app-scoped:4', alwaysAllow: true });
    expect(global.window.swarmFeedStore.activateFeedIdentity).not.toHaveBeenCalled();
    expect(global.window.swarmPermissions.setAutoApprove).not.toHaveBeenCalled();
    expect(renderer.isShowing()).toBe(null);

    // A feed write with the site's own identity active; Reject answers.
    renderer.show({
      handle: 'f2',
      guest: 7,
      kind: 'swarm.feed',
      site: SITE,
      view: { ...view, method: 'swarm_createFeed', mode: 'feeds', identifier: undefined, name: 'blog', activeIdentityId: 'app-scoped:4', identities: [view.newIdentity] },
    });
    expect(ctx.elements['swarm-feed-title'].textContent).toBe('Feed Access');
    expect(ctx.elements['swarm-feed-name'].textContent).toBe('blog');
    await armPrompt();
    await ctx.elements['swarm-feed-reject'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenLastCalledWith('f2', false, {});
  });
});
