const originalWindow = global.window;
const originalDocument = global.document;

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.classes = new Set();
  }

  add(...names) {
    for (const name of names) this.classes.add(name);
    this.el.className = Array.from(this.classes).join(' ');
  }

  remove(...names) {
    for (const name of names) this.classes.delete(name);
    this.el.className = Array.from(this.classes).join(' ');
  }

  contains(name) {
    return this.classes.has(name);
  }
}

class FakeElement {
  constructor() {
    this.innerHTML = '';
    this.textContent = '';
    this.className = '';
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
  }

  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  async fire(event, detail = {}) {
    const eventObject = {
      type: event,
      target: this,
      preventDefault: jest.fn(),
      ...detail,
    };
    for (const handler of this.listeners.get(event) || []) {
      await handler(eventObject);
    }
    return eventObject;
  }
}

function createWindowEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    }),
    async emit(event, detail = {}) {
      for (const handler of listeners.get(event) || []) {
        await handler({ type: event, detail });
      }
    },
  };
}

async function loadRecentPayments() {
  jest.resetModules();

  const listEl = new FakeElement();
  const viewAllLink = new FakeElement();
  const openOrFocusInternalPage = jest.fn();
  const eventTarget = createWindowEventTarget();
  const payments = {
    getRecent: jest.fn().mockResolvedValue({ success: true, payments: [] }),
  };

  global.document = {
    getElementById: jest.fn((id) => {
      if (id === 'recent-payments-list') return listEl;
      if (id === 'recent-payments-view-all') return viewAllLink;
      return null;
    }),
    createElement: jest.fn(() => new FakeElement()),
  };
  global.window = {
    ...eventTarget,
    payments,
  };

  jest.doMock('../tabs.js', () => ({ openOrFocusInternalPage }));
  jest.doMock('./wallet-state.js', () => ({
    walletState: {
      registeredTokens: {
        '8453:0xUSDC': { symbol: 'USDC', decimals: 6 },
      },
    },
  }));

  const mod = await import('./recent-payments.js');
  return { mod, listEl, viewAllLink, openOrFocusInternalPage, payments, eventTarget };
}

describe('recent-payments sidebar section', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('renders the header-only state and opens the full payments page', async () => {
    const ctx = await loadRecentPayments();

    ctx.mod.initRecentPayments();
    await Promise.resolve();

    expect(ctx.listEl.innerHTML).toBe('');
    expect(ctx.payments.getRecent).not.toHaveBeenCalled();

    const clickEvent = await ctx.viewAllLink.fire('click');
    expect(clickEvent.preventDefault).toHaveBeenCalled();
    // Singleton, not a second Payments tab: the sidebar goes through the same
    // internal-page routing every other chrome surface uses (#325).
    expect(ctx.openOrFocusInternalPage).toHaveBeenCalledWith('payments');
  });

  test('listens for payment mutations without hitting IPC while the mini-list limit is zero', async () => {
    const ctx = await loadRecentPayments();

    ctx.mod.initRecentPayments();
    await ctx.eventTarget.emit('payments:tx-recorded', { kind: 'x402' });

    expect(ctx.listEl.innerHTML).toBe('');
    expect(ctx.payments.getRecent).not.toHaveBeenCalled();
  });
});
