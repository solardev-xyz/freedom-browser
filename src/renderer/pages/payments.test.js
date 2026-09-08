const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this._textContent = '';
    this.innerHTML = '';
    this.value = '';
  }

  set textContent(value) {
    this._textContent = value == null ? '' : String(value);
    this.innerHTML = htmlEscape(this._textContent);
  }

  get textContent() {
    return this._textContent;
  }

  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  insertAdjacentHTML(_position, html) {
    this.innerHTML += html;
  }

  async fire(event) {
    for (const handler of this.listeners.get(event) || []) {
      await handler({ type: event, target: this });
    }
  }
}

function extractPaymentsScript() {
  const html = fs.readFileSync(path.join(__dirname, 'payments.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('payments.html inline script not found');
  return match[1];
}

async function flushPromises() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

function createPayment(overrides = {}) {
  return {
    kind: 'x402',
    origin: 'https://pay.example',
    amount: '2500000',
    asset: '0xUSDC',
    chainId: 8453,
    status: 'settled',
    toAddress: '0x1111111111111111111111111111111111111111',
    fromAddress: '0x2222222222222222222222222222222222222222',
    txHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    url: 'https://pay.example/article',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runPaymentsPage(options = {}) {
  const elements = {
    results: new FakeElement(),
    stats: new FakeElement(),
    'search-input': new FakeElement(),
    'kind-select': new FakeElement(),
    'chain-select': new FakeElement(),
    'clear-btn': new FakeElement(),
  };
  const timers = [];
  let paymentRecordedHandler = null;

  const freedomAPI = {
    getNetworkConfig: jest.fn().mockResolvedValue({
      success: true,
      networks: {
        8453: {
          name: 'Base',
          shortName: 'Base',
          blockExplorer: 'https://basescan.org',
        },
      },
    }),
    getTokens: jest.fn().mockResolvedValue({
      success: true,
      tokens: {
        '8453:0xUSDC': { symbol: 'USDC', decimals: 6 },
      },
    }),
    getPayments: jest.fn().mockResolvedValue({
      success: true,
      payments: options.payments || [createPayment()],
    }),
    clearPayments: jest.fn().mockResolvedValue({ success: true }),
    onPaymentRecorded: jest.fn((handler) => {
      paymentRecordedHandler = handler;
    }),
  };
  const confirm = jest.fn(() => true);
  const context = {
    window: { freedomAPI },
    document: {
      getElementById: jest.fn((id) => elements[id] || null),
      createElement: jest.fn(() => new FakeElement()),
    },
    console: {
      error: jest.fn(),
    },
    confirm,
    setTimeout: jest.fn((handler) => {
      timers.push(handler);
      return timers.length;
    }),
    clearTimeout: jest.fn(),
    Date,
    BigInt,
    Number,
    String,
    Map,
    Promise,
  };

  vm.runInNewContext(extractPaymentsScript(), context, { filename: 'payments.html' });
  await flushPromises();

  return {
    ...context,
    elements,
    freedomAPI,
    timers,
    getPaymentRecordedHandler: () => paymentRecordedHandler,
  };
}

describe('payments internal page', () => {
  test('renders payment history rows and applies client and server-side filters', async () => {
    const ctx = await runPaymentsPage();

    expect(ctx.elements.stats.textContent).toBe('1 payment');
    expect(ctx.elements.results.innerHTML).toContain('https://pay.example');
    expect(ctx.elements.results.innerHTML).toContain('2.5');
    expect(ctx.elements.results.innerHTML).toContain('USDC');
    expect(ctx.elements.results.innerHTML).toContain('https://basescan.org/tx/');

    ctx.elements['search-input'].value = 'nomatch';
    await ctx.elements['search-input'].fire('input');

    expect(ctx.elements.stats.textContent).toBe('0 of 1 payment');
    expect(ctx.elements.results.innerHTML).toContain('No payments match your filters');

    ctx.elements['search-input'].value = 'pay.example';
    await ctx.elements['search-input'].fire('input');
    expect(ctx.elements.stats.textContent).toBe('1 payment');

    ctx.elements['kind-select'].value = 'x402';
    await ctx.elements['kind-select'].fire('change');
    await flushPromises();
    expect(ctx.freedomAPI.getPayments).toHaveBeenLastCalledWith({
      kind: 'x402',
      chainId: undefined,
      limit: 500,
    });

    ctx.elements['chain-select'].value = '8453';
    await ctx.elements['chain-select'].fire('change');
    await flushPromises();
    expect(ctx.freedomAPI.getPayments).toHaveBeenLastCalledWith({
      kind: 'x402',
      chainId: 8453,
      limit: 500,
    });
  });

  test('clears history and refreshes after payment mutation broadcasts', async () => {
    const ctx = await runPaymentsPage();

    await ctx.elements['clear-btn'].fire('click');
    await flushPromises();

    expect(ctx.confirm).toHaveBeenCalledWith('Clear all payment history? This cannot be undone.');
    expect(ctx.freedomAPI.clearPayments).toHaveBeenCalled();
    expect(ctx.elements.stats.textContent).toBe('0 payments');
    expect(ctx.elements.results.innerHTML).toContain('No payments yet');

    ctx.freedomAPI.getPayments.mockClear();
    ctx.getPaymentRecordedHandler()();
    expect(ctx.timers).toHaveLength(1);

    await ctx.timers[0]();
    await flushPromises();

    expect(ctx.freedomAPI.getPayments).toHaveBeenCalledWith({
      kind: undefined,
      chainId: undefined,
      limit: 500,
    });
  });
});
