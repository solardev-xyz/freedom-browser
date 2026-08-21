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
  global.window = {};

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
  const signatureFlight = await import('./signature-flight.js');
  mod.initPermissionManifest();

  return { mod, signatureFlight, elements: document.elements, hideAllSubscreens, openSidebarPanel };
}

// Track settlement without awaiting a promise that may never settle.
function trackedConsent(promise) {
  const state = { outcome: undefined, settled: false, promise };
  promise.then((outcome) => {
    state.settled = true;
    state.outcome = outcome;
  });
  return state;
}

// A freshly presented prompt ignores clicks for its input-protection window
// (PROMPT_ARM_DELAY_MS) so a double-click cannot settle a prompt the user has
// not seen. Tests step past it explicitly.
async function armPrompt() {
  jest.advanceTimersByTime(600);
  await Promise.resolve();
}

describe('permission manifest consent queues concurrent requests', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a second consent request waits its turn instead of clobbering the first', async () => {
    const ctx = await loadPermissionManifest();
    const screen = ctx.elements['sidebar-swarm-manifest'];

    const first = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha')));
    const second = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://beta', 'Beta')));

    // Only the first request is on screen; the second is queued, not denied.
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://alpha');
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    // Allow all settles the first request only, then shows the queued one.
    await armPrompt();
    await ctx.elements['swarm-manifest-allow'].fire('click');
    expect(await first.promise).toBe('allow');
    expect(second.settled).toBe(false);
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://beta');

    // "Connect, but ask each time" settles the second and closes the sheet.
    await armPrompt();
    await ctx.elements['swarm-manifest-individual'].fire('click');
    expect(await second.promise).toBe('individual');
    expect(screen.classList.contains('hidden')).toBe(true);
  });

  test('dismissing the sheet denies the queued requests too', async () => {
    const ctx = await loadPermissionManifest();

    const first = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha')));
    const second = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://beta', 'Beta')));

    // Another screen taking over the sidebar fires every screen hider.
    ctx.hideAllSubscreens();

    expect(await first.promise).toBe('deny');
    expect(await second.promise).toBe('deny');
    expect(ctx.elements['sidebar-swarm-manifest'].classList.contains('hidden')).toBe(true);
  });

  test('double-clicking Allow settles one request and leaves the queued one on screen', async () => {
    const ctx = await loadPermissionManifest();

    const first = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha')));
    const second = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://beta', 'Beta')));

    await armPrompt();
    await Promise.all([
      ctx.elements['swarm-manifest-allow'].fire('click'),
      ctx.elements['swarm-manifest-allow'].fire('click'),
    ]);

    expect(await first.promise).toBe('allow');
    // The second click landed inside the queued prompt's arm window, so it
    // did not settle the request that just took the screen.
    expect(second.settled).toBe(false);
    expect(ctx.elements['sidebar-swarm-manifest'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://beta');

    await armPrompt();
    await ctx.elements['swarm-manifest-reject'].fire('click');
    expect(await second.promise).toBe('deny');
  });

  test('buttons are disabled during the input-protection window', async () => {
    const ctx = await loadPermissionManifest();

    const consent = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha')));
    expect(ctx.elements['swarm-manifest-allow'].disabled).toBe(true);
    expect(ctx.elements['swarm-manifest-individual'].disabled).toBe(true);
    expect(ctx.elements['swarm-manifest-reject'].disabled).toBe(true);

    await armPrompt();
    expect(ctx.elements['swarm-manifest-allow'].disabled).toBe(false);

    await ctx.elements['swarm-manifest-allow'].fire('click');
    expect(await consent.promise).toBe('allow');
  });

  test('a live device confirmation refuses the sheet with the standard error', async () => {
    const ctx = await loadPermissionManifest();
    const screen = ctx.elements['sidebar-swarm-manifest'];
    const signer = {};
    ctx.signatureFlight.beginSignatureFlight(signer);

    try {
      // Same pre-check as the sibling swarm prompts: the request is refused
      // with the standard in-flight error instead of a generic internal one,
      // and the sheet never touches the sidebar the device prompt owns.
      await expect(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha'), 'tok-1'))
        .rejects.toMatchObject({ code: -32002 });
      expect(screen.classList.contains('hidden')).toBe(true);
      expect(ctx.hideAllSubscreens).not.toHaveBeenCalled();
    } finally {
      ctx.signatureFlight.endSignatureFlight(signer);
    }

    // Nothing was cached against the refused token, so the retry the dApp is
    // told to make gets a real sheet once the device is done.
    const retry = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha'), 'tok-1'));
    expect(screen.classList.contains('hidden')).toBe(false);
    await armPrompt();
    await ctx.elements['swarm-manifest-allow'].fire('click');
    expect(await retry.promise).toBe('allow');
  });

  test('two tabs sharing one consent token get one sheet and one answer', async () => {
    const ctx = await loadPermissionManifest();
    const screen = ctx.elements['sidebar-swarm-manifest'];

    // Main hands both tabs the same outstanding token for the same origin.
    const tabA = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha'), 'tok-1'));
    const tabB = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha'), 'tok-1'));

    await armPrompt();
    await ctx.elements['swarm-manifest-allow'].fire('click');

    // One answer settles both, and no duplicate sheet is left behind.
    expect(await tabA.promise).toBe('allow');
    expect(await tabB.promise).toBe('allow');
    expect(screen.classList.contains('hidden')).toBe(true);

    // A tab arriving late on the same token replays the answer, no sheet.
    const tabC = trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://alpha', 'Alpha'), 'tok-1'));
    expect(await tabC.promise).toBe('allow');
    expect(screen.classList.contains('hidden')).toBe(true);

    // A different consent still gets its own sheet.
    trackedConsent(ctx.mod.showPermissionManifest(manifestModel('bzz://beta', 'Beta'), 'tok-2'));
    expect(screen.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['swarm-manifest-site'].textContent).toBe('bzz://beta');
  });
});
