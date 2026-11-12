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
    this.children = [];
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
  }

  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  async fire(event, detail = {}) {
    for (const handler of this.listeners.get(event) || []) {
      await handler({ type: event, target: this, ...detail });
    }
  }
}

const elementIds = [
  'sidebar-swarm-manifest',
  'swarm-manifest-site',
  'swarm-manifest-name',
  'swarm-manifest-description',
  'swarm-manifest-rows',
  'swarm-manifest-identity-note',
  'swarm-manifest-reject',
  'swarm-manifest-individual',
  'swarm-manifest-allow',
  'swarm-manifest-back',
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
    createElement: jest.fn(() => new FakeElement()),
    addEventListener: jest.fn(),
  };
}

function manifestModel(origin, appName) {
  return {
    origin,
    name: appName,
    description: '',
    removed: [],
    changed: [{ label: 'Publish', why: 'Uploads site content' }],
    createsIdentity: false,
    preservedIdentity: false,
  };
}

async function loadPermissionManifest() {
  jest.resetModules();

  const document = createDocument();
  const identityView = new FakeElement();
  const openSidebarPanel = jest.fn();

  // Real screen-hider wiring: hideAllSubscreens() runs every registered
  // hider, which is what made concurrent prompts clobber each other.
  const screenHiders = [];
  const hideAllSubscreens = jest.fn(() => screenHiders.forEach((fn) => fn()));

  global.document = document;
  global.window = { pagePrompts: { decide: jest.fn().mockResolvedValue({ ok: true }) } };

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView },
    registerScreenHider: (fn) => screenHiders.push(fn),
    hideAllSubscreens,
  }));
  jest.doMock('../sidebar.js', () => ({
    open: openSidebarPanel,
    isVisible: jest.fn(() => false),
  }));

  const mod = await import('./permission-manifest.js');
  const pagePromptRenderers = await import('../page-prompt-renderers.js');
  mod.initPermissionManifest();

  return { mod, pagePromptRenderers, elements: document.elements, hideAllSubscreens, openSidebarPanel };
}

// Main's consent prompt for `site`, as `page:prompt` brings it to the sheet.
function showManifest(ctx, handle, site, appName = 'App') {
  ctx.pagePromptRenderers.pagePromptRenderer('swarm.manifest').show({
    handle,
    guest: 3,
    kind: 'swarm.manifest',
    site: { key: site, label: site },
    view: { model: manifestModel(site, appName) },
  });
}

// A freshly presented prompt ignores clicks for its input-protection window
// (PROMPT_ARM_DELAY_MS) so a double-click cannot settle a prompt the user has
// not seen. Tests step past it explicitly.
async function armPrompt() {
  jest.advanceTimersByTime(600);
  await Promise.resolve();
}

describe('the permission manifest sheet queues main\'s prompts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a second consent prompt waits its turn instead of clobbering the first', async () => {
    const ctx = await loadPermissionManifest();
    const screen = ctx.elements['sidebar-swarm-manifest'];
    const { decide } = global.window.pagePrompts;

    showManifest(ctx, 'h1', 'bzz://alpha', 'Alpha');
    showManifest(ctx, 'h2', 'bzz://beta', 'Beta');

    // Only the first prompt is on screen; the second is queued, not denied.
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://alpha');
    expect(decide).not.toHaveBeenCalled();

    // Allow all answers the first prompt only, then shows the queued one.
    await armPrompt();
    await ctx.elements['swarm-manifest-allow'].fire('click');
    expect(decide.mock.calls).toEqual([['h1', true, { outcome: 'allow' }]]);
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://beta');

    // "Connect, but ask each time" answers the second and closes the sheet.
    await armPrompt();
    await ctx.elements['swarm-manifest-individual'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('h2', true, { outcome: 'individual' });
    expect(screen.classList.contains('hidden')).toBe(true);
  });

  test('dismissing the sheet reports every queued prompt displaced', async () => {
    const ctx = await loadPermissionManifest();
    const displaced = jest.fn();
    ctx.pagePromptRenderers.onPagePromptDisplaced(displaced);

    showManifest(ctx, 'h1', 'bzz://alpha', 'Alpha');
    showManifest(ctx, 'h2', 'bzz://beta', 'Beta');

    // Another screen taking over the sidebar fires every screen hider.
    ctx.hideAllSubscreens();

    expect(displaced.mock.calls).toEqual([['h1'], ['h2']]);
    expect(global.window.pagePrompts.decide).not.toHaveBeenCalled();
    expect(ctx.elements['sidebar-swarm-manifest'].classList.contains('hidden')).toBe(true);
  });

  test('double-clicking Allow answers one prompt and leaves the queued one on screen', async () => {
    const ctx = await loadPermissionManifest();
    const { decide } = global.window.pagePrompts;

    showManifest(ctx, 'h1', 'bzz://alpha', 'Alpha');
    showManifest(ctx, 'h2', 'bzz://beta', 'Beta');

    await armPrompt();
    await Promise.all([
      ctx.elements['swarm-manifest-allow'].fire('click'),
      ctx.elements['swarm-manifest-allow'].fire('click'),
    ]);

    // The second click landed inside the queued prompt's arm window, so it
    // did not answer the prompt that just took the screen.
    expect(decide.mock.calls).toEqual([['h1', true, { outcome: 'allow' }]]);
    expect(ctx.elements['sidebar-swarm-manifest'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://beta');

    await armPrompt();
    await ctx.elements['swarm-manifest-reject'].fire('click');
    expect(decide).toHaveBeenLastCalledWith('h2', false, {});
  });

  test('buttons are disabled during the input-protection window', async () => {
    const ctx = await loadPermissionManifest();

    showManifest(ctx, 'h1', 'bzz://alpha', 'Alpha');
    expect(ctx.elements['swarm-manifest-allow'].disabled).toBe(true);
    expect(ctx.elements['swarm-manifest-individual'].disabled).toBe(true);
    expect(ctx.elements['swarm-manifest-reject'].disabled).toBe(true);

    await armPrompt();
    expect(ctx.elements['swarm-manifest-allow'].disabled).toBe(false);

    await ctx.elements['swarm-manifest-allow'].fire('click');
    expect(global.window.pagePrompts.decide).toHaveBeenCalledWith('h1', true, { outcome: 'allow' });
  });
});

// Main's own consent prompt for a page's request (freedom-core design 0011,
// PRQ-7b): the sheet renders main's model under main's site and answers the
// handle; the consent's token never reaches the chrome.
describe('main\'s manifest consent in the chrome', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const prompt = (handle) => ({
    handle,
    guest: 3,
    kind: 'swarm.manifest',
    site: { key: 'bzz://aaaa', label: 'bzz://aaaa' },
    view: { model: manifestModel('bzz://other', 'App') },
  });

  test('each answer goes back for the handle: allow and individual as approvals, reject as a denial', async () => {
    const ctx = await loadPermissionManifest();
    global.window.pagePrompts = { decide: jest.fn().mockResolvedValue({ ok: true }) };
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.manifest');
    for (const [button, handle, expected] of [
      ['swarm-manifest-allow', 'h1', [true, { outcome: 'allow' }]],
      ['swarm-manifest-individual', 'h2', [true, { outcome: 'individual' }]],
      ['swarm-manifest-reject', 'h3', [false, {}]],
    ]) {
      renderer.show(prompt(handle));
      expect(renderer.isShowing()).toBe(handle);
      // Main's site, whatever the model says.
      expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://aaaa');
      expect(ctx.elements['swarm-manifest-name'].textContent).toBe('App');
      await armPrompt();
      await ctx.elements[button].fire('click');
      expect(global.window.pagePrompts.decide).toHaveBeenLastCalledWith(handle, ...expected);
      expect(renderer.isShowing()).toBe(null);
    }
  });

  test('main closing the prompt takes the sheet down; another screen taking the sidebar reports it displaced', async () => {
    const ctx = await loadPermissionManifest();
    global.window.pagePrompts = { decide: jest.fn() };
    const displaced = jest.fn();
    ctx.pagePromptRenderers.onPagePromptDisplaced(displaced);
    const renderer = ctx.pagePromptRenderers.pagePromptRenderer('swarm.manifest');
    renderer.show(prompt('h4'));
    renderer.close('h4');
    expect(ctx.elements['sidebar-swarm-manifest'].classList.contains('hidden')).toBe(true);
    expect(renderer.isShowing()).toBe(null);
    renderer.show(prompt('h5'));
    ctx.hideAllSubscreens();
    expect(displaced).toHaveBeenCalledWith('h5');
    expect(global.window.pagePrompts.decide).not.toHaveBeenCalled();
  });
});
