/**
 * The storage screen while Ant looks for storage this wallet already owns
 * (#510, /health.walletScan): the search and its progress in place of the
 * empty state, the stalled warning once publish setup gives up on it, and
 * the normal empty state as soon as the hold ends. Also the loading line and
 * the cached list a return visit shows while /stamps refreshes (#595).
 */

class FakeClassList {
  constructor(classes = []) {
    this.set = new Set(classes);
  }
  add(c) {
    this.set.add(c);
  }
  remove(c) {
    this.set.delete(c);
  }
  contains(c) {
    return this.set.has(c);
  }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : force;
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
}

class FakeElement {
  constructor(classes = []) {
    this.classList = new FakeClassList(classes);
    this.listeners = {};
    this.children = [];
    this.textContent = '';
    this.dataset = {};
  }
  set innerHTML(value) {
    if (value === '') this.children = [];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  appendChild(node) {
    this.children.push(node);
  }
  querySelector() {
    return null;
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const SCANNING =
  'Looking for your existing storage… 42% checked. Storage plans appear if this wallet has none.';
// What the Storage screen shows for SCANNING: no plans appear there.
const SCANNING_HERE =
  'Looking for your existing storage… 42% checked. Storage this wallet already owns is listed here once found.';
const SCANNING_UNREPORTED = 'Looking for your existing storage…';
const RETRYING =
  'Looking for your existing storage… 42% checked. Gnosis Chain did not answer, so the Swarm node is trying again. If this lasts, check the Gnosis RPC in Settings.';
const STALLED =
  'The Swarm node could not finish looking for storage this wallet already owns: Gnosis Chain keeps failing. Check the Gnosis RPC in Settings before buying, or you may pay for storage you already have.';

const held = (message, rediscovery = 'running', progress = 42, scanMessage) => ({
  canBuy: true,
  stamps: { known: true, usable: 0, pending: 0, total: 0 },
  readiness: {
    key: 'checking',
    ok: false,
    message,
    rediscovery,
    progress,
    ...(scanMessage ? { scanMessage } : {}),
  },
});
const needsStorage = (extra = {}) => ({
  canBuy: true,
  stamps: { known: true, usable: 0, pending: 0, total: 0 },
  readiness: {
    key: 'needs-storage',
    ok: false,
    message: 'Publishing needs storage. Pick a storage plan to start.',
    ...extra,
  },
});
const ready = () => ({
  canBuy: true,
  stamps: { known: true, usable: 1, pending: 0, total: 1 },
  readiness: { key: 'ready', ok: true, message: 'Ready to publish. 1 storage batch available.' },
});

const BATCH = {
  batchId: 'a'.repeat(64),
  usable: true,
  sizeBytes: 1e9,
  usagePercent: 3,
  ttlSeconds: 30 * 86400,
  depth: 22,
};

async function load({ state, stamps = [] }) {
  jest.resetModules();
  const elements = {};
  global.document = {
    getElementById: (id) => (elements[id] ||= new FakeElement(['hidden'])),
    createElement: () => new FakeElement(),
  };
  let push = null;
  global.window = {
    publishSetup: {
      onState: (fn) => {
        push = fn;
      },
      watch: jest.fn().mockResolvedValue(),
      getState: jest.fn().mockResolvedValue(state),
    },
    swarmNode: {
      getStamps: jest.fn().mockImplementation(async () => ({ success: true, stamps })),
    },
  };
  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: new FakeElement() },
    registerScreenHider: jest.fn(),
  }));
  jest.doMock('./signature-flight.js', () => ({ refuseSubscreenWhileInFlight: () => false }));
  jest.doMock('./publish-setup.js', () => ({ openPublishSetup: jest.fn() }));

  const mod = await import('./stamp-manager.js');
  mod.initStampManager();
  await mod.openStampManager();
  await flush();
  const visible = (id) => !elements[id].classList.contains('hidden');
  const setStamps = (next) => {
    stamps = next;
  };
  const emit = async (next) => {
    push(next);
    await flush();
  };
  return { elements, visible, emit, setStamps, mod };
}

afterEach(() => {
  for (const name of ['./wallet-state.js', './signature-flight.js', './publish-setup.js']) {
    jest.dontMock(name);
  }
  delete global.document;
  delete global.window;
});

describe('the storage screen during the wallet-history search', () => {
  test.each([
    ['scanning with a percentage', held(SCANNING), SCANNING],
    [
      'scanning, worded for this screen',
      held(SCANNING, 'running', 42, SCANNING_HERE),
      SCANNING_HERE,
    ],
    [
      'scanning with no percentage',
      held(SCANNING_UNREPORTED, 'running', null),
      SCANNING_UNREPORTED,
    ],
    ['retrying', held(RETRYING, 'retrying'), RETRYING],
  ])('%s shows the search, not "no storage yet"', async (_label, state, text) => {
    const { elements, visible } = await load({ state });
    expect(visible('stamp-scan-status')).toBe(true);
    expect(elements['stamp-scan-status'].textContent).toBe(text);
    expect(visible('stamp-list-empty')).toBe(false);
    expect(visible('stamp-scan-warning')).toBe(false);
  });

  test('the progress follows the pushed state', async () => {
    const { elements, emit } = await load({ state: held(SCANNING_UNREPORTED, 'running', null) });
    await emit(held(SCANNING));
    expect(elements['stamp-scan-status'].textContent).toBe(SCANNING);
  });

  test('a stalled search shows the warning over the normal empty state', async () => {
    const { elements, visible } = await load({
      state: needsStorage({ message: STALLED, scanStalled: true }),
    });
    expect(visible('stamp-scan-warning')).toBe(true);
    expect(elements['stamp-scan-warning-text'].textContent).toBe(STALLED);
    expect(visible('stamp-scan-status')).toBe(false);
    expect(visible('stamp-list-empty')).toBe(true);
  });

  test('a search that found nothing falls back to the empty state', async () => {
    const { elements, visible, emit } = await load({ state: held(SCANNING) });
    expect(visible('stamp-list-empty')).toBe(false);

    await emit(needsStorage());
    expect(visible('stamp-scan-status')).toBe(false);
    expect(elements['stamp-scan-status'].textContent).toBe('');
    expect(visible('stamp-scan-warning')).toBe(false);
    expect(visible('stamp-list-empty')).toBe(true);
  });

  test('a search that found storage lists it, with no status and no empty text', async () => {
    const { elements, visible, emit, setStamps } = await load({ state: held(SCANNING) });
    setStamps([BATCH]);
    await emit(ready());
    expect(visible('stamp-scan-status')).toBe(false);
    expect(visible('stamp-scan-warning')).toBe(false);
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
  });

  test('with storage and no search, neither line shows', async () => {
    const { elements, visible } = await load({ state: ready(), stamps: [BATCH] });
    expect(visible('stamp-scan-status')).toBe(false);
    expect(visible('stamp-scan-warning')).toBe(false);
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
  });

  test('no storage and no search keeps the plain empty state', async () => {
    const { visible } = await load({ state: needsStorage() });
    expect(visible('stamp-scan-status')).toBe(false);
    expect(visible('stamp-scan-warning')).toBe(false);
    expect(visible('stamp-list-empty')).toBe(true);
  });

  test("reopening forgets the last visit's batches until this visit's list lands", async () => {
    const { elements, visible, mod, setStamps } = await load({
      state: ready(),
      stamps: [BATCH],
    });
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
    mod.closeStampManager();
    // Closing drops the cards along with the count.
    expect(elements['stamp-batch-list'].children).toHaveLength(0);

    // The batches are gone by the next visit, and the list is slow to come.
    setStamps([]);
    let land;
    global.window.swarmNode.getStamps.mockImplementation(
      () => new Promise((resolve) => (land = resolve))
    );
    global.window.publishSetup.getState.mockResolvedValue(needsStorage());
    await mod.openStampManager();
    await flush();
    // Not "no storage yet" before this visit knows; no previous visit's cards.
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(0);
    expect(elements['stamp-buy-another-btn'].textContent).toBe('Buy Storage');

    land({ success: true, stamps: [] });
    await flush();
    expect(visible('stamp-list-empty')).toBe(true);
  });

  test("opening clears a previous visit's cards even if close never ran", async () => {
    // A screen switch can hide the screen without closeStampManager (the
    // screen hider runs it, but openStampManager must not depend on that).
    const { elements, visible, mod } = await load({ state: ready(), stamps: [BATCH] });
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
    global.window.swarmNode.getStamps.mockImplementation(() => new Promise(() => {}));
    global.window.publishSetup.getState.mockResolvedValue(needsStorage());
    await mod.openStampManager();
    await flush();
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(0);
  });

  test('a wallet with storage never reads "no storage yet" while the list loads', async () => {
    const { elements, visible, mod } = await load({ state: ready(), stamps: [BATCH] });
    // This visit's /stamps is slow to answer.
    let land;
    global.window.swarmNode.getStamps.mockImplementation(
      () => new Promise((resolve) => (land = resolve))
    );
    mod.closeStampManager();
    await mod.openStampManager();
    await flush();
    expect(visible('stamp-scan-status')).toBe(false);
    expect(visible('stamp-list-empty')).toBe(false);
    expect(visible('stamp-buy-another-btn')).toBe(true);

    land({ success: true, stamps: [BATCH] });
    await flush();
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
    expect(elements['stamp-buy-another-btn'].textContent).toBe('Buy More Storage');
  });
});

describe('the storage screen while /stamps loads (#595)', () => {
  const WALLET = '0x' + '1'.repeat(40);
  const OTHER_WALLET = '0x' + '2'.repeat(40);
  const withWallet = (state, walletAddress = WALLET) => ({
    ...state,
    account: { walletAddress, chequebook: null },
  });
  const slowStamps = () => {
    const pending = {};
    global.window.swarmNode.getStamps.mockImplementation(
      () => new Promise((resolve) => (pending.resolve = resolve))
    );
    return pending;
  };
  const reopen = async (mod) => {
    mod.closeStampManager();
    await mod.openStampManager();
    await flush();
  };

  test('a first visit shows the spinner in place of the list, then the list', async () => {
    // The first load found nothing, so there is nothing cached to show.
    const { elements, visible, mod } = await load({ state: withWallet(needsStorage()) });
    expect(visible('stamp-list-loading')).toBe(false);
    const pending = slowStamps();
    await reopen(mod);
    expect(visible('stamp-list-loading')).toBe(true);
    expect(elements['stamp-list-loading-text'].textContent).toBe('Loading your storage…');
    expect(elements['stamp-batch-list'].children).toHaveLength(0);
    expect(visible('stamp-list-empty')).toBe(false);

    pending.resolve({ success: true, stamps: [BATCH] });
    await flush();
    expect(visible('stamp-list-loading')).toBe(false);
    expect(elements['stamp-list-loading-text'].textContent).toBe('');
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
  });

  test('a return visit shows the cached batches at once, with a spinner', async () => {
    const { elements, visible, mod } = await load({
      state: withWallet(ready()),
      stamps: [BATCH],
    });
    expect(visible('stamp-list-loading')).toBe(false);
    const pending = slowStamps();
    await reopen(mod);

    expect(elements['stamp-batch-list'].children).toHaveLength(1);
    expect(elements['stamp-buy-another-btn'].textContent).toBe('Buy More Storage');
    expect(visible('stamp-list-empty')).toBe(false);
    expect(visible('stamp-list-loading')).toBe(true);
    expect(elements['stamp-list-loading-text'].textContent).toBe('Checking for changes…');
    const card = elements['stamp-batch-list'].children[0];

    // Nothing changed: the spinner goes and the same cards stay.
    pending.resolve({ success: true, stamps: [BATCH] });
    await flush();
    expect(visible('stamp-list-loading')).toBe(false);
    expect(elements['stamp-batch-list'].children[0]).toBe(card);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
  });

  test('a refresh that brings a different list swaps it in', async () => {
    const { elements, visible, mod } = await load({
      state: withWallet(ready()),
      stamps: [BATCH],
    });
    const pending = slowStamps();
    await reopen(mod);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);

    const second = { ...BATCH, batchId: 'b'.repeat(64) };
    pending.resolve({ success: true, stamps: [BATCH, second] });
    await flush();
    expect(visible('stamp-list-loading')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(2);
  });

  test('a failed refresh keeps the cached batches, never "no storage yet"', async () => {
    const { elements, visible, mod } = await load({
      state: withWallet(ready()),
      stamps: [BATCH],
    });
    const pending = slowStamps();
    await reopen(mod);

    pending.resolve({ success: false, error: 'node unreachable' });
    await flush();
    expect(visible('stamp-list-loading')).toBe(false);
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
    expect(elements['stamp-buy-another-btn'].textContent).toBe('Buy More Storage');
  });

  test('a refresh that finds the batches gone drops the cache', async () => {
    const { elements, visible, mod } = await load({
      state: withWallet(ready()),
      stamps: [BATCH],
    });
    const pending = slowStamps();
    await reopen(mod);
    pending.resolve({ success: true, stamps: [] });
    await flush();
    expect(visible('stamp-list-empty')).toBe(true);
    expect(elements['stamp-batch-list'].children).toHaveLength(0);

    slowStamps();
    await reopen(mod);
    expect(elements['stamp-batch-list'].children).toHaveLength(0);
    expect(elements['stamp-list-loading-text'].textContent).toBe('Loading your storage…');
  });

  test("another wallet's state drops the cache before the next visit", async () => {
    const { elements, visible, mod, emit } = await load({
      state: withWallet(ready()),
      stamps: [BATCH],
    });
    mod.closeStampManager();
    await emit(withWallet(needsStorage(), OTHER_WALLET));
    slowStamps();
    global.window.publishSetup.getState.mockResolvedValue(withWallet(needsStorage(), OTHER_WALLET));
    await mod.openStampManager();
    await flush();
    expect(elements['stamp-batch-list'].children).toHaveLength(0);
    expect(visible('stamp-list-empty')).toBe(false);
    expect(visible('stamp-list-loading')).toBe(true);
    expect(elements['stamp-list-loading-text'].textContent).toBe('Loading your storage…');
  });

  test("a wallet change while open clears the previous wallet's cards and reloads", async () => {
    const { elements, visible, emit } = await load({
      state: withWallet(ready()),
      stamps: [BATCH],
    });
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
    const pending = slowStamps();
    await emit(withWallet(ready(), OTHER_WALLET));
    expect(elements['stamp-batch-list'].children).toHaveLength(0);
    expect(visible('stamp-list-loading')).toBe(true);

    pending.resolve({ success: true, stamps: [] });
    await flush();
    expect(visible('stamp-list-empty')).toBe(true);
  });

  test('cached batches show beside the wallet-history search', async () => {
    const { elements, visible, mod } = await load({
      state: withWallet(ready()),
      stamps: [BATCH],
    });
    slowStamps();
    global.window.publishSetup.getState.mockResolvedValue(withWallet(held(SCANNING)));
    await reopen(mod);
    expect(visible('stamp-scan-status')).toBe(true);
    expect(visible('stamp-list-empty')).toBe(false);
    expect(elements['stamp-batch-list'].children).toHaveLength(1);
  });
});
