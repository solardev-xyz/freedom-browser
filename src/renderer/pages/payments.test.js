const {
  runPageScript,
  flush: flushPromises,
} = require('../../../test/helpers/page-script-harness');

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
  let paymentRecordedHandler = null;

  const freedomAPI = {
    getNetworkConfig: jest.fn().mockResolvedValue({
      success: true,
      networks: options.networks || {
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
  const page = await runPageScript('payments', {
    ids: {
      results: 'div',
      stats: 'p',
      'search-input': 'input',
      'kind-select': 'select',
      'chain-select': 'select',
      'clear-btn': 'button',
    },
    freedomAPI,
    confirm,
  });

  return {
    ...page,
    confirm,
    freedomAPI,
    getPaymentRecordedHandler: () => paymentRecordedHandler,
  };
}

describe('payments internal page', () => {
  test('renders payment history rows and applies client and server-side filters', async () => {
    const ctx = await runPaymentsPage();

    expect(ctx.elements.stats.textContent).toBe('1 payment');
    expect(ctx.elements.results.textContent).toContain('https://pay.example');
    expect(ctx.elements.results.textContent).toContain('2.5');
    expect(ctx.elements.results.textContent).toContain('USDC');
    expect(ctx.elements.results.querySelector('.tx-link').href).toBe(
      `https://basescan.org/tx/${createPayment().txHash}`
    );

    ctx.elements['search-input'].value = 'nomatch';
    await ctx.elements['search-input'].fire('input');

    expect(ctx.elements.stats.textContent).toBe('0 of 1 payment');
    expect(ctx.elements.results.textContent).toContain('No payments match your filters');

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
    expect(ctx.elements.results.textContent).toContain('No payments yet');

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
