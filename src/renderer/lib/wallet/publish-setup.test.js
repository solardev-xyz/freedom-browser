/**
 * The publish setup screen's own routing: which view a readiness state
 * shows, and how the pay step hands over to the Send screen and back.
 */

const NODE_WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';

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
    this.disabled = false;
  }
  set innerHTML(value) {
    if (value === '') this.children = [];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type) {
    (this.listeners[type] || []).forEach((fn) => fn({ type }));
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  appendChild(node) {
    this.children.push(node);
  }
  removeAttribute() {}
  querySelector() {
    return null;
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function readiness(key) {
  return { key, ok: key === 'ready', message: `readiness ${key}` };
}

function payState() {
  return {
    canBuy: true,
    readiness: readiness('needs-storage'),
    plans: [],
    operation: {
      phase: 'awaiting-funds',
      request: { kind: 'buy', planId: 'starter' },
      quote: {
        walletAddress: NODE_WALLET,
        send: { wei: '450000000000000000', display: '0.45' },
      },
    },
  };
}

async function load({ state, openSendResult = { opened: true } }) {
  jest.resetModules();
  jest.useFakeTimers();

  const elements = {};
  global.document = {
    getElementById: (id) => (elements[id] ||= new FakeElement(['hidden'])),
    createElement: () => new FakeElement(),
  };
  const windowListeners = {};
  global.window = {
    addEventListener: (type, fn) => (windowListeners[type] ||= []).push(fn),
    publishSetup: {
      onState: jest.fn(),
      watch: jest.fn().mockResolvedValue(),
      getState: jest.fn().mockResolvedValue(state),
      getPlans: jest.fn().mockResolvedValue({ plans: [] }),
      trackFundingTx: jest.fn().mockResolvedValue(),
      arm: jest.fn(),
      cancel: jest.fn(),
      dismiss: jest.fn(),
    },
  };

  const identityView = new FakeElement();
  const walletState = { identityView };
  const openSend = jest.fn().mockResolvedValue(openSendResult);
  jest.doMock('./wallet-state.js', () => ({ walletState, registerScreenHider: jest.fn() }));
  jest.doMock('./signature-flight.js', () => ({ refuseSubscreenWhileInFlight: () => false }));
  jest.doMock('./send.js', () => ({ openSend }));
  jest.doMock('./receive.js', () => ({ generateThemedQr: jest.fn().mockResolvedValue(null) }));
  jest.doMock('./stamp-manager.js', () => ({ openStampManager: jest.fn() }));
  jest.doMock('./funding-actions.js', () => ({
    GNOSIS_CHAIN_ID: 100,
    XDAI_TOKEN_KEY: '100:native',
  }));
  jest.doMock('../tabs.js', () => ({ createTab: jest.fn() }));
  jest.doMock('../sidebar.js', () => ({ isVisible: () => true }));

  const mod = await import('./publish-setup.js');
  mod.initPublishSetup();
  const visible = (id) => !elements[id].classList.contains('hidden');
  const emit = (type, detail) => (windowListeners[type] || []).forEach((fn) => fn({ detail }));
  return { mod, elements, identityView, openSend, visible, emit };
}

afterEach(() => {
  for (const name of [
    './wallet-state.js',
    './signature-flight.js',
    './send.js',
    './receive.js',
    './stamp-manager.js',
    './funding-actions.js',
    '../tabs.js',
    '../sidebar.js',
  ]) {
    jest.dontMock(name);
  }
  delete global.document;
  delete global.window;
  jest.useRealTimers();
});

describe('views', () => {
  test('a site whose write found no room is told why, not "Ready to publish"', async () => {
    const { mod, elements, visible } = await load({
      state: { canBuy: true, readiness: readiness('ready'), plans: [] },
    });
    await mod.openPublishSetup({ origin: 'app.eth', reason: 'no-usable-stamps' });
    expect(visible('publish-setup-ready')).toBe(true);
    expect(visible('publish-setup-origin')).toBe(true);
    expect(elements['publish-setup-origin-text'].textContent).toBe(
      'app.eth tried to publish more than your storage has room for.'
    );
    expect(elements['publish-setup-ready-text'].textContent).toMatch(
      /has room for that upload\. Make one bigger under Manage Storage, or buy more storage\./
    );

    // Any other reason, or no site, keeps the readiness wording.
    await mod.openPublishSetup({ origin: 'app.eth', reason: 'node-not-ready' });
    expect(elements['publish-setup-origin-text'].textContent).toBe(
      'app.eth wants to publish on Swarm. Set up publishing to let it.'
    );
    expect(elements['publish-setup-ready-text'].textContent).toBe('readiness ready');
    await mod.openPublishSetup({ reason: 'no-usable-stamps' });
    expect(visible('publish-setup-origin')).toBe(false);
    expect(elements['publish-setup-ready-text'].textContent).toBe('readiness ready');
  });

  test('a site sent for no storage at all still gets the setup wording', async () => {
    const { mod, elements, visible } = await load({
      state: { canBuy: true, readiness: readiness('needs-storage'), plans: [] },
    });
    await mod.openPublishSetup({ origin: 'app.eth', reason: 'no-usable-stamps' });
    expect(visible('publish-setup-plans')).toBe(true);
    expect(elements['publish-setup-origin-text'].textContent).toBe(
      'app.eth wants to publish on Swarm. Set up publishing to let it.'
    );
  });

  test.each(['ready', 'storage-pending'])(
    'Buy More Storage from %s shows the plan list',
    async (key) => {
      const { mod, elements, visible } = await load({
        state: { canBuy: true, readiness: readiness(key), plans: [] },
      });
      await mod.openPublishSetup();
      expect(visible('publish-setup-ready')).toBe(true);

      elements['publish-setup-buy-more'].dispatch('click');
      // A pending batch may be one the peers never accept: a new plan must
      // still be reachable, not the node view with no action.
      expect(visible('publish-setup-plans')).toBe(true);
      expect(visible('publish-setup-node')).toBe(false);
      expect(visible('publish-setup-ready')).toBe(false);
    }
  );
});

describe('paying from the Freedom wallet', () => {
  async function openPay(options) {
    const ctx = await load({ state: payState(), ...options });
    await ctx.mod.openPublishSetup();
    expect(ctx.visible('publish-setup-pay')).toBe(true);
    ctx.elements['publish-pay-wallet'].dispatch('click');
    await flush();
    return ctx;
  }

  test('tracks only a transaction that pays the node', async () => {
    const { emit } = await openPay();
    const paid = { chainId: 100, asset: null, to: NODE_WALLET, value: '450000000000000000' };

    emit('wallet:tx-success', { ...paid, hash: '0x01', to: OTHER });
    emit('wallet:tx-success', { ...paid, hash: '0x02', value: '100' });
    emit('wallet:tx-success', { ...paid, hash: '0x03', chainId: 1 });
    emit('wallet:tx-success', { ...paid, hash: '0x04', asset: '0xtoken' });
    expect(window.publishSetup.trackFundingTx).not.toHaveBeenCalled();

    emit('wallet:tx-success', {
      ...paid,
      hash: '0x05',
      to: NODE_WALLET.toUpperCase().replace('0X', '0x'),
    });
    expect(window.publishSetup.trackFundingTx).toHaveBeenCalledWith('0x05');
  });

  test('a transaction outside the pay step is not tracked', async () => {
    const { emit } = await load({ state: payState() });
    emit('wallet:tx-success', {
      hash: '0x01',
      chainId: 100,
      asset: null,
      to: NODE_WALLET,
      value: '450000000000000000',
    });
    expect(window.publishSetup.trackFundingTx).not.toHaveBeenCalled();
  });

  test('comes back after Send closes', async () => {
    const { openSend, visible } = await openPay();
    expect(visible('sidebar-publish-setup')).toBe(false);

    openSend.mock.calls[0][0].onClose({ handedOff: false });
    await jest.advanceTimersByTimeAsync(0);
    expect(visible('sidebar-publish-setup')).toBe(true);
  });

  test('stays away when a Safe send hands the sidebar to its signing board', async () => {
    const { openSend, visible } = await openPay();

    // send.js closes with handedOff, then the board takes the sidebar.
    // The close alone settles it: no timer is left to race the board.
    openSend.mock.calls[0][0].onClose({ handedOff: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(visible('sidebar-publish-setup')).toBe(false);
  });

  test('stays away when another screen took the sidebar before the timer', async () => {
    const { openSend, visible, identityView } = await openPay();

    openSend.mock.calls[0][0].onClose({ handedOff: false });
    identityView.classList.add('hidden');
    await jest.advanceTimersByTimeAsync(0);
    expect(visible('sidebar-publish-setup')).toBe(false);
  });

  test('does not paint over a Safe board that openSend opened instead', async () => {
    const ctx = await load({
      state: payState(),
      openSendResult: { opened: false, reason: 'This Safe already has a transaction waiting.' },
    });
    await ctx.mod.openPublishSetup();
    ctx.openSend.mockImplementation(async () => {
      ctx.identityView.classList.add('hidden'); // the board's open
      return { opened: false, reason: 'This Safe already has a transaction waiting.' };
    });
    ctx.elements['publish-pay-wallet'].dispatch('click');
    await flush();
    expect(ctx.visible('sidebar-publish-setup')).toBe(false);
  });
});

describe('finished operations and refusals', () => {
  const finished = (phase, extra = {}) => ({
    canBuy: true,
    readiness: readiness('ready'),
    plans: [],
    operation: {
      id: 7,
      phase,
      kind: 'extend',
      request: { kind: 'extend', batchId: 'a'.repeat(64), days: 30, depth: null },
      result: phase === 'done' ? { batchId: 'a'.repeat(64) } : null,
      error: phase === 'failed' ? 'The extension failed.' : null,
      ...extra,
    },
  });

  test.each(['done', 'failed'])(
    'leaving a %s result the user saw dismisses it, and only that one',
    async (phase) => {
      const { mod, elements, visible } = await load({ state: finished(phase) });
      window.publishSetup.dismiss.mockResolvedValue({ ok: true });
      await mod.openPublishSetup();
      expect(visible(`publish-setup-${phase}`)).toBe(true);

      elements['publish-setup-back'].dispatch('click');
      expect(window.publishSetup.dismiss).toHaveBeenCalledWith(7);
      // A dismissal, not a cancel: main keeps the result while another
      // window's setup screen still shows it.
      expect(window.publishSetup.cancel).not.toHaveBeenCalled();
    }
  );

  test('a result this window left stays hidden here while main still holds it', async () => {
    const state = finished('failed', { uncertain: true });
    const { mod, elements, visible } = await load({ state });
    // Main keeps the operation: another window is showing it.
    window.publishSetup.dismiss.mockResolvedValue({ ok: true, state });
    await mod.openPublishSetup();
    expect(visible('publish-setup-failed')).toBe(true);

    elements['publish-setup-back'].dispatch('click');
    await flush();
    await mod.openPublishSetup();
    expect(visible('publish-setup-failed')).toBe(false);
    expect(visible('publish-setup-ready')).toBe(true);

    // A new operation armed later shows as usual.
    window.publishSetup.getState.mockResolvedValue({
      ...state,
      operation: { ...state.operation, id: 8, phase: 'failed', uncertain: false },
    });
    await mod.openPublishSetup();
    expect(visible('publish-setup-failed')).toBe(true);
  });

  test('leaving the pay step keeps the purchase armed', async () => {
    const { mod, elements } = await load({ state: { ...payState(), operation: { ...payState().operation, id: 3 } } });
    await mod.openPublishSetup();
    elements['publish-setup-back'].dispatch('click');
    expect(window.publishSetup.cancel).not.toHaveBeenCalled();
  });

  test('a refused Try Again says why over the failed view', async () => {
    const { mod, elements, visible } = await load({ state: finished('failed') });
    window.publishSetup.arm.mockResolvedValue({
      ok: false,
      error: 'Freedom is already buying storage. Wait for it to finish.',
    });
    await mod.openPublishSetup();
    expect(visible('publish-setup-error')).toBe(false);

    elements['publish-failed-retry'].dispatch('click');
    await flush();
    expect(visible('publish-setup-failed')).toBe(true);
    expect(visible('publish-setup-error')).toBe(true);
    expect(elements['publish-setup-error'].textContent).toBe(
      'Freedom is already buying storage. Wait for it to finish.'
    );
  });

  test('an opener’s refusal (storage, deposit screens) shows on arrival, and not on the next visit', async () => {
    const { mod, elements, visible } = await load({ state: payState() });
    await mod.openPublishSetup({ error: 'Your new storage is still reaching the network.' });
    expect(visible('publish-setup-error')).toBe(true);
    expect(elements['publish-setup-error'].textContent).toMatch(/still reaching/);

    mod.closePublishSetup();
    await mod.openPublishSetup();
    expect(visible('publish-setup-error')).toBe(false);
  });

  test('a stale "Send screen could not open" is gone on the next visit', async () => {
    const ctx = await load({
      state: payState(),
      openSendResult: { opened: false, reason: 'The Send screen could not open.' },
    });
    await ctx.mod.openPublishSetup();
    ctx.elements['publish-pay-wallet'].dispatch('click');
    await flush();
    expect(ctx.visible('publish-pay-wallet-error')).toBe(true);

    ctx.mod.closePublishSetup();
    await ctx.mod.openPublishSetup();
    expect(ctx.visible('publish-pay-wallet-error')).toBe(false);
  });

  test('a failed price fetch is retried once it is stale', async () => {
    const state = { canBuy: true, readiness: readiness('needs-storage'), plans: [] };
    const { mod } = await load({ state });
    window.publishSetup.getPlans.mockRejectedValueOnce(new Error('node busy'));
    await mod.openPublishSetup();
    await flush();
    expect(window.publishSetup.getPlans).toHaveBeenCalledTimes(1);

    // The next state push re-renders; a fresh failure is not refetched yet.
    const push = window.publishSetup.onState.mock.calls[0][0];
    push(state);
    expect(window.publishSetup.getPlans).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 10_000);
    push(state);
    await flush();
    expect(window.publishSetup.getPlans).toHaveBeenCalledTimes(2);
  });
});
