const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

// The list's markup is rendered as a string; the fake DOM doesn't parse it,
// so these tests read the markup and drive the actions through
// handleAction (the e2e spec clicks the real buttons).

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const MINUTES_AGO = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();

const IDS = [
  'held-payments-row',
  'held-payments-row-label',
  'held-payments-count',
  'sidebar-held-payments',
  'held-payments-message',
  'held-payments-list',
  'held-payments-back',
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

function held(overrides = {}) {
  return {
    intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a01',
    chainId: 100,
    sender: ALICE,
    nonce: 7,
    hash: `0x${'ab'.repeat(32)}`,
    state: 'held',
    kind: 'wallet-send',
    origin: null,
    walletIndex: 0,
    fields: {
      type: 0,
      to: BOB,
      value: '1500000000000000000',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '1000000000',
    },
    createdAt: MINUTES_AGO(5),
    attention: 'refused',
    lastOutcome: { outcome: 'rejected', reasonClass: 'insufficient funds' },
    replacement: null,
    receipt: null,
    ...overrides,
  };
}

async function load(intents) {
  jest.resetModules();
  const elements = Object.fromEntries(
    IDS.map((id) => [
      id,
      createElement(
        'div',
        ['held-payments-row', 'sidebar-held-payments'].includes(id) ? { classes: ['hidden'] } : {}
      ),
    ])
  );
  global.document = createDocument({ elementsById: elements });
  const listeners = {};
  global.window = {
    addEventListener: jest.fn((type, listener) => {
      listeners[type] = listener;
    }),
    wallet: {
      intentsList: jest.fn().mockResolvedValue({ success: true, intents }),
      intentResend: jest.fn(),
      intentReplacementFees: jest.fn(),
      intentReplace: jest.fn(),
      onIntentsChanged: jest.fn((listener) => {
        listeners.intentsChanged = listener;
      }),
      confirmSigning: jest.fn().mockResolvedValue({ success: true, token: 'confirm-token' }),
    },
  };
  jest.doMock('./wallet-utils.js', () => ({
    ...jest.requireActual('./wallet-utils.js'),
    escapeHtml: (text) =>
      String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
  }));
  const state = await import('./wallet-state.js');
  state.walletState.identityView = createElement('div');
  state.walletState.fullAddresses.wallet = ALICE;
  state.walletState.derivedWallets = [
    { index: 0, name: 'Main account', address: ALICE, type: 'mnemonic' },
    { index: 1000000, name: 'Ledger 1', address: BOB, type: 'ledger' },
  ];
  state.walletState.registeredChains = { 100: { name: 'Gnosis', nativeSymbol: 'xDAI' } };
  state.walletState.registeredTokens = {
    'gnosis-usdc': { chainId: 100, symbol: 'USDC', decimals: 6, address: TOKEN },
  };
  const flight = await import('./signature-flight.js');
  const mod = await import('./held-payments.js');
  mod.initHeldPayments();
  await flush();
  return { mod, elements, listeners, flight };
}

const markup = (elements) => elements['held-payments-list'].innerHTML;

afterEach(() => {
  jest.dontMock('./wallet-utils.js');
  delete global.document;
  delete global.window;
});

describe('payments waiting: the row and the list', () => {
  test('the row is hidden with nothing waiting', async () => {
    const { elements } = await load([held({ receipt: 'confirmed' })]);
    expect(elements['held-payments-row'].classList.contains('hidden')).toBe(true);
    expect(elements['held-payments-row-label'].textContent).toBe('Payments waiting');
  });

  test('the row counts the waiting payments; a mined one no longer waits', async () => {
    const { elements, listeners } = await load([
      held(),
      held({ intentId: 'b', nonce: 8, attention: 'uncertain', receipt: 'confirmed' }),
    ]);
    expect(elements['held-payments-row'].classList.contains('hidden')).toBe(false);
    expect(elements['held-payments-count'].textContent).toBe('1');

    // The records change: the list is asked again.
    window.wallet.intentsList.mockResolvedValue({ success: true, intents: [] });
    listeners.intentsChanged();
    await flush();
    expect(elements['held-payments-row'].classList.contains('hidden')).toBe(true);
  });

  test('each payment says what it pays, from which account, where, at which nonce, and why it waits', async () => {
    const transfer =
      '0xa9059cbb' + BOB.slice(2).padStart(64, '0') + 2500000n.toString(16).padStart(64, '0');
    const { mod, elements } = await load([
      held({
        intentId: 'b',
        nonce: 9,
        attention: 'uncertain',
        lastOutcome: { outcome: 'uncertain' },
      }),
      held(),
      held({
        intentId: 'c',
        nonce: 8,
        kind: 'dapp-send',
        origin: 'https://app.example',
        fields: { ...held().fields, to: TOKEN, value: '0', data: transfer },
        attention: 'not-sent',
        lastOutcome: { outcome: 'not_sent' },
      }),
    ]);
    await mod.openHeldPayments();
    expect(elements['sidebar-held-payments'].classList.contains('hidden')).toBe(false);
    expect(elements['held-payments-message'].textContent).toContain('it can only be paid once');

    const html = markup(elements);
    // Oldest nonce first: the order the network takes them in.
    const order = ['nonce 7', 'nonce 8', 'nonce 9'].map((text) => html.indexOf(text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('1.5 xDAI to 0x2222…2222');
    expect(html).toContain('2.5 USDC to 0x2222…2222');
    expect(html).toContain('Main account · Gnosis · nonce 7 · 5 minutes ago');
    expect(html).toContain('Requested by https://app.example');
    expect(html).toContain('The network refused it: insufficient funds');
    expect(html).toContain('Not sent; nothing left this computer');
    expect(html).toContain('Sent, waiting for confirmation');
    expect(html).not.toMatch(/please try again/i);
  });

  test('a payment offers a higher fee only where that is the fix', async () => {
    const { mod, elements } = await load([
      held({ intentId: 'a', nonce: 7 }),
      held({
        intentId: 'b',
        nonce: 8,
        replacement: 'replace',
        lastOutcome: { outcome: 'rejected', reasonClass: 'transaction underpriced' },
      }),
      held({ intentId: 'c', nonce: 9, replacement: 'speed-up', attention: 'uncertain' }),
    ]);
    await mod.openHeldPayments();
    const rows = markup(elements).split('data-intent=').slice(1);
    expect(rows.map((row) => (row.match(/data-action="(\w+)"/g) || []).join(' '))).toEqual([
      'data-action="resend"',
      'data-action="resend" data-action="replace"',
      'data-action="resend" data-action="replace"',
    ]);
    expect(rows[1]).toContain('Raise the fee');
    expect(rows[2]).toContain('Speed up');
  });
});

describe('payments waiting: Send again', () => {
  test("the user's own payment is sent again at the press, as the held payment", async () => {
    const payment = held();
    const { mod, elements } = await load([payment]);
    await mod.openHeldPayments();
    window.wallet.intentResend.mockResolvedValue({
      success: true,
      outcome: 'sent',
      hash: payment.hash,
    });

    await mod.handleAction('resend', payment);

    expect(window.wallet.confirmSigning).toHaveBeenCalledWith('intent-resend', null, {
      intentId: payment.intentId,
      chainId: 100,
      sender: ALICE,
      nonce: 7,
      hash: payment.hash,
    });
    expect(window.wallet.intentResend).toHaveBeenCalledWith(payment.intentId, {
      confirmation: 'confirm-token',
    });
    expect(markup(elements)).toContain('Sent, waiting for confirmation');
  });

  test("a dApp's payment asks once more, naming the site and when, before it is sent again", async () => {
    const payment = held({
      kind: 'dapp-send',
      origin: 'https://app.example',
      createdAt: MINUTES_AGO(42),
    });
    const { mod, elements } = await load([payment]);
    await mod.openHeldPayments();

    await mod.handleAction('resend', payment);
    expect(window.wallet.confirmSigning).not.toHaveBeenCalled();
    expect(window.wallet.intentResend).not.toHaveBeenCalled();
    expect(markup(elements)).toContain(
      'Send the payment https://app.example requested 42 minutes ago again? It is the same signed payment.'
    );
    expect(markup(elements)).toContain('data-action="confirm-resend"');

    // Cancel sends nothing.
    await mod.handleAction('cancel', payment);
    expect(markup(elements)).not.toContain('confirm-resend');
    expect(window.wallet.intentResend).not.toHaveBeenCalled();

    await mod.handleAction('resend', payment);
    window.wallet.intentResend.mockResolvedValue({
      success: false,
      error: 'insufficient funds',
      outcome: 'rejected',
      reasonClass: 'insufficient funds',
    });
    await mod.handleAction('confirm-resend', payment);
    expect(window.wallet.confirmSigning).toHaveBeenCalledWith(
      'intent-resend',
      null,
      expect.objectContaining({ intentId: payment.intentId })
    );
    expect(window.wallet.intentResend).toHaveBeenCalledTimes(1);
    expect(markup(elements)).toContain('The network refused it: insufficient funds');
  });

  test("a stale confirmation (a replacement changed the hash) is minted again against main's hash", async () => {
    const payment = held();
    const { mod, elements } = await load([payment]);
    await mod.openHeldPayments();
    const replaced = { ...payment, hash: `0x${'cd'.repeat(32)}` };
    window.wallet.intentResend
      .mockResolvedValueOnce({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: 'Signing was not confirmed',
        intentId: payment.intentId,
        intent: replaced,
      })
      .mockResolvedValueOnce({ success: true, outcome: 'sent', hash: replaced.hash });
    await mod.handleAction('resend', payment);
    const hashes = window.wallet.confirmSigning.mock.calls
      .filter(([kind]) => kind === 'intent-resend')
      .map(([, , binding]) => binding.hash);
    expect(hashes).toEqual([payment.hash, replaced.hash]);
    expect(markup(elements)).toContain('Sent, waiting for confirmation');
  });

  test('a confirmation main refuses to mint sends nothing', async () => {
    const payment = held();
    const { mod, elements } = await load([payment]);
    await mod.openHeldPayments();
    window.wallet.confirmSigning.mockResolvedValue({ success: false, error: 'Invalid hash' });
    await mod.handleAction('resend', payment);
    expect(window.wallet.intentResend).not.toHaveBeenCalled();
    expect(markup(elements)).toContain('Invalid hash');
  });
});

describe('payments waiting: replacing with a higher fee', () => {
  test('the new fee is shown, and Confirm signs the same payment with it, confirmed as such', async () => {
    const payment = held({
      walletIndex: 1000000,
      sender: BOB,
      replacement: 'replace',
      lastOutcome: { outcome: 'rejected', reasonClass: 'transaction underpriced' },
    });
    const { mod, elements, flight } = await load([payment]);
    await mod.openHeldPayments();
    window.wallet.intentReplacementFees.mockResolvedValue({
      success: true,
      fees: { gasPrice: '2000000000' },
    });

    await mod.handleAction('replace', payment);
    expect(window.wallet.intentReplacementFees).toHaveBeenCalledWith(payment.intentId);
    // 21000 gas at 2 gwei.
    expect(markup(elements)).toContain('New network fee: up to 0.000042 xDAI');
    expect(markup(elements)).toContain('Only one of the two can go through.');
    expect(window.wallet.intentReplace).not.toHaveBeenCalled();

    let flightDuringReplace;
    window.wallet.intentReplace.mockImplementation(async () => {
      flightDuringReplace = flight.isSignatureInFlight();
      // A device signature owns the sidebar: Back does nothing meanwhile.
      mod.closeHeldPayments();
      return { success: true, replaced: true, outcome: 'sent' };
    });
    await mod.handleAction('confirm-replace', payment);

    expect(window.wallet.confirmSigning).toHaveBeenCalledWith('intent-replace', null, {
      intentId: payment.intentId,
      chainId: 100,
      sender: BOB,
      nonce: 7,
      to: BOB,
      value: '1500000000000000000',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '2000000000',
    });
    expect(window.wallet.intentReplace).toHaveBeenCalledWith(
      payment.intentId,
      { gasPrice: '2000000000' },
      { confirmation: 'confirm-token' }
    );
    expect(flightDuringReplace).toBe(true);
    expect(flight.isSignatureInFlight()).toBe(false);
    expect(elements['sidebar-held-payments'].classList.contains('hidden')).toBe(false);
    expect(markup(elements)).toContain('Replaced with a higher fee');
  });

  test('a refused replacement says why and releases the sidebar', async () => {
    const payment = held({ replacement: 'speed-up', attention: 'uncertain' });
    const { mod, elements, flight } = await load([payment]);
    await mod.openHeldPayments();
    window.wallet.intentReplacementFees.mockResolvedValue({
      success: true,
      fees: { maxFeePerGas: '3000000000', maxPriorityFeePerGas: '1100000000' },
    });
    await mod.handleAction('replace', payment);
    window.wallet.intentReplace.mockResolvedValue({
      success: false,
      error: 'A replacement must raise the fee by at least 10%.',
      code: 'INTENT_FEE_TOO_LOW',
    });
    await mod.handleAction('confirm-replace', payment);
    expect(window.wallet.confirmSigning).toHaveBeenCalledWith(
      'intent-replace',
      null,
      expect.objectContaining({ maxFeePerGas: '3000000000', maxPriorityFeePerGas: '1100000000' })
    );
    expect(markup(elements)).toContain('A replacement must raise the fee by at least 10%.');
    expect(flight.isSignatureInFlight()).toBe(false);
  });
});

describe('payments waiting: what a new send waits behind (D11)', () => {
  test('the earliest of the account’s payments on the chain that leaves a gap', async () => {
    const { mod } = await load([
      held({ intentId: 'other-chain', chainId: 1, nonce: 1 }),
      held({ intentId: 'other-account', sender: BOB, nonce: 2 }),
      held({ intentId: 'uncertain', nonce: 3, attention: 'uncertain' }),
      held({ intentId: 'mined', nonce: 4, receipt: 'confirmed' }),
      held({ intentId: 'recovered', nonce: 6, attention: 'pending' }),
      held({ intentId: 'refused', nonce: 5 }),
    ]);
    await expect(
      mod.waitingPaymentBehind(100, ALICE.toUpperCase().replace('0X', '0x'))
    ).resolves.toMatchObject({
      intentId: 'refused',
    });
    await expect(mod.waitingPaymentBehind(1, BOB)).resolves.toBeNull();
    window.wallet.intentsList.mockRejectedValue(new Error('no main'));
    await expect(mod.waitingPaymentBehind(100, ALICE)).resolves.toBeNull();
  });
});

describe('payments waiting: amounts', () => {
  test('what a payment pays is exact, and its maximum fee is never understated', async () => {
    const payment = held({ fields: { ...held().fields, value: '1' }, replacement: 'speed-up' });
    const { mod, elements } = await load([payment]);
    expect(mod.describePayment(payment)).toBe('0.000000000000000001 xDAI to 0x2222…2222');

    await mod.openHeldPayments();
    // 21000 gas at 1.1 gwei and 1 wei: 23100.000021 gwei, shown as 23101.
    window.wallet.intentReplacementFees.mockResolvedValue({
      success: true,
      fees: { gasPrice: '1100000001' },
    });
    await mod.handleAction('replace', payment);
    expect(markup(elements)).toContain('New network fee: up to 0.000023101 xDAI');
  });
});

// #710 review: the list is fetched before it opens; meanwhile another
// screen, or a device prompt, may have taken the sidebar.
describe('payments waiting: opening the list', () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const shown = (elements) => !elements['sidebar-held-payments'].classList.contains('hidden');

  async function delayedOpening(intents) {
    const loaded = await load(intents);
    const reply = deferred();
    window.wallet.intentsList.mockReturnValueOnce(reply.promise);
    const opening = loaded.mod.openHeldPayments();
    await flush();
    return { ...loaded, opening, release: () => reply.resolve({ success: true, intents }) };
  }

  test('not while a device signature owns the sidebar', async () => {
    const { mod, elements, flight } = await load([held()]);
    const token = {};
    flight.beginSignatureFlight(token);
    await mod.openHeldPayments();
    expect(shown(elements)).toBe(false);
    flight.endSignatureFlight(token);
    await mod.openHeldPayments();
    expect(shown(elements)).toBe(true);
  });

  test('a late list after a device signature began opens nothing', async () => {
    const { elements, flight, opening, release } = await delayedOpening([held()]);
    flight.beginSignatureFlight({});
    release();
    await opening;
    expect(shown(elements)).toBe(false);
  });

  test('a late list after another screen took the sidebar opens nothing', async () => {
    const { elements, opening, release } = await delayedOpening([held()]);
    const state = await import('./wallet-state.js');
    // The Send screen opens: it hides the identity view.
    state.walletState.identityView.classList.add('hidden');
    release();
    await opening;
    expect(shown(elements)).toBe(false);
  });

  test('a late list for an opening called off (Back, or a screen hider) opens nothing', async () => {
    const first = await delayedOpening([held()]);
    first.mod.closeHeldPayments();
    first.release();
    await first.opening;
    expect(shown(first.elements)).toBe(false);

    const second = await delayedOpening([held()]);
    const state = await import('./wallet-state.js');
    state.hideAllSubscreens();
    second.release();
    await second.opening;
    expect(shown(second.elements)).toBe(false);
  });
});

// PR 7: what the finality tracker's reads saw of a payment recovered after
// a restart.
describe('payments waiting: after a restart', () => {
  test('one the reads show is not on chain says so, offers a speed-up, and leaves a gap', async () => {
    const recovered = held({
      attention: 'absent',
      observed: 'absent',
      lastOutcome: null,
      replacement: 'speed-up',
    });
    const { mod, elements } = await load([recovered]);
    await mod.openHeldPayments();
    expect(markup(elements)).toContain('Not on chain yet');
    expect(markup(elements)).toContain('Speed up');
    await expect(mod.waitingPaymentBehind(100, ALICE)).resolves.toMatchObject({
      intentId: recovered.intentId,
    });
  });

  test('one still unread says Pending', async () => {
    const { mod, elements } = await load([
      held({ attention: 'pending', observed: null, lastOutcome: null }),
    ]);
    await mod.openHeldPayments();
    expect(markup(elements)).toContain('Pending');
  });
});
