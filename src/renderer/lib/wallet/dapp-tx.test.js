const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const DAPP_TX_ELEMENT_IDS = [
  'sidebar-dapp-tx',
  'dapp-tx-back',
  'dapp-tx-site',
  'dapp-tx-to',
  'dapp-tx-value',
  'dapp-tx-data',
  'dapp-tx-data-row',
  'dapp-tx-network',
  'dapp-tx-fee',
  'dapp-tx-warning',
  'dapp-tx-unlock',
  'dapp-tx-touchid-btn',
  'dapp-tx-password-link',
  'dapp-tx-password-section',
  'dapp-tx-password-input',
  'dapp-tx-password-submit',
  'dapp-tx-error',
  'dapp-tx-reject',
  'dapp-tx-approve',
  'dapp-tx-auto-approve-row',
  'dapp-tx-auto-approve-phone-note',
  'dapp-tx-auto-approve',
  'dapp-tx-fee-max',
  'dapp-tx-fee-note',
  'dapp-tx-fee-warning',
  'dapp-tx-fee-warning-text',
  'dapp-tx-fee-retry-row',
  'dapp-tx-fee-retry',
];

const LEDGER_INDEX = 1000000;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function loadDappTx() {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_TX_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  elementsById['dapp-tx-auto-approve'].checked = false;
  // As in index.html: the prompt, and the phone's note, start hidden.
  elementsById['sidebar-dapp-tx'].classList.add('hidden');
  elementsById['dapp-tx-auto-approve-phone-note'].classList.add('hidden');
  global.document = createDocument({ elementsById });

  // Main quotes, checks and sends a page's transaction: the screen asks
  // none of these (the tests check that it doesn't).
  // `page:prompt-waiting` listeners (preload.js `pagePrompts.onWaiting`),
  // which the screen registers as it starts.
  const waiting = [];
  global.window = {
    wallet: {
      estimateGas: jest.fn().mockResolvedValue({ success: true, gasLimit: '21000' }),
      feeCheck: jest.fn(),
      confirmSigning: jest.fn(),
    },
    pagePrompts: { onWaiting: jest.fn((listener) => waiting.push(listener)) },
  };

  // The Ledger account bypasses the vault-unlock gate, the same as in the app.
  jest.doMock('./wallet-utils.js', () => ({
    bypassUnlockGateForDevice: jest.fn((_index, _unlockEl, confirmBtn) => {
      if (confirmBtn) confirmBtn.disabled = false;
      return true;
    }),
    bypassUnlockGateForSafe: jest.fn(() => false),
    renderSafeFeePayer: jest.fn(),
    signingButtonLabel: jest.fn(() => 'Confirm on your Ledger…'),
  }));
  jest.doMock('./safe-signing.js', () => ({
    isSafeSigningBoardOpen: jest.fn(() => false),
  }));
  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div') },
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn() }));

  const mod = await import('./dapp-tx.js');
  mod.initDappTx();

  // The screen hider this module registered (another screen opening).
  const hideForOtherScreen = () => require('./wallet-state.js').registerScreenHider.mock.calls[0][0]();

  // Main says a decided prompt waits on a Ledger Reject still reaches.
  const deviceWaits = (handle) => waiting.forEach((listener) => listener({ handle }));

  return { mod, elements: elementsById, hideForOtherScreen, deviceWaits };
}

describe("dapp-tx: main's prompt (0011 PRQ-5b)", () => {
  const SITE = { key: 'https://app.example', label: 'https://app.example' };
  const ACCOUNT = { index: LEDGER_INDEX, name: 'Ledger', address: '0xledger', type: 'ledger' };
  const VERDICT = { maxCost: '21000000000000', comparable: true, ratio: '1', above: false, autoApprove: true };
  const ABOVE = { ...VERDICT, ratio: '20', above: true, autoApprove: false };
  const VIEW = {
    account: ACCOUNT,
    chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
    tx: {
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      value: '500000000000000000',
      data: '0x095ea7b300000000000000000000000000000000000000000000000000000000000000ff',
    },
    fee: { gasLimit: '21000', gasPrice: '1000000000', estimate: '21000000000000' },
    feeCheck: VERDICT,
    feeAskAgain: false,
    alwaysAllow: true,
  };

  async function loadPage(options) {
    const env = await loadDappTx(options);
    const decisions = [];
    let answer = deferred();
    Object.assign(global.window.pagePrompts, {
      decide: jest.fn((handle, approve, choices) => {
        decisions.push({ handle, approve, choices });
        return answer.promise;
      }),
    });
    const renderer = require('../page-prompt-renderers.js').pagePromptRenderer('eth.send');
    const prompt = (view = {}, handle = 'h1') => ({ handle, guest: 3, kind: 'eth.send', site: SITE, view: { ...VIEW, ...view } });
    const show = (view, handle) => renderer.show(prompt(view, handle));
    const showing = () => !env.elements['sidebar-dapp-tx'].classList.contains('hidden');
    return { ...env, decisions, renderer, prompt, show, showing, answer: () => answer };
  }

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test("it renders main's site, the transaction in main's form, the fee and its check", async () => {
    const env = await loadPage();
    env.show();
    await flush();
    expect(env.showing()).toBe(true);
    expect(env.renderer.isShowing()).toBe('h1');
    expect(env.elements['dapp-tx-site'].textContent).toBe(SITE.label);
    expect(env.elements['dapp-tx-to'].title).toBe(VIEW.tx.to);
    expect(env.elements['dapp-tx-value'].textContent).toBe('0.500000 xDAI');
    expect(env.elements['dapp-tx-network'].textContent).toBe('Gnosis Chain');
    expect(env.elements['dapp-tx-fee'].textContent).toBe('~0.000021 xDAI');
    expect(env.elements['dapp-tx-fee-max'].textContent).toBe('Up to 0.000021 xDAI');
    expect(env.elements['dapp-tx-auto-approve-row'].classList.contains('hidden')).toBe(false);
    expect(env.elements['dapp-tx-approve'].disabled).toBe(false);
    // Nothing asked of main but the decision: no quote, no fee check, no token.
    expect(window.wallet.estimateGas).not.toHaveBeenCalled();
    expect(window.wallet.feeCheck).not.toHaveBeenCalled();
    expect(window.wallet.confirmSigning).not.toHaveBeenCalled();
  });

  test('Confirm answers the handle; a device signature keeps the screen until main answers', async () => {
    const env = await loadPage();
    env.show();
    await flush();
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: true, choices: { alwaysAllow: false } }]);
    // Main closes the handle as decided while the device signs: still up.
    env.renderer.close('h1');
    expect(env.showing()).toBe(true);
    expect(env.elements['dapp-tx-approve'].textContent).toBe('Confirm on your Ledger…');
    expect(env.elements['dapp-tx-reject'].disabled).toBe(true);
    const flight = require('./signature-flight.js');
    expect(flight.isSignatureInFlight()).toBe(true);
    env.answer().resolve({ ok: true });
    await flush();
    expect(env.showing()).toBe(false);
    expect(flight.isSignatureInFlight()).toBe(false);
  });

  // LDG-3's PR 10 (freedom-core design 0016, deviation `cancel`): on the
  // core's Ledger backend main says when Reject still reaches the device.
  test("main's word brings Reject back while the Ledger waits; Reject is main's cancel, and its notice stays a moment", async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const env = await loadPage();
      const notice = 'Cancelled. If your Ledger still shows the request, reject it there.';
      const answer = env.answer();
      window.pagePrompts.cancel = jest.fn(async () => {
        // Main answers the page at once, which answers the decision too.
        answer.resolve({ ok: true });
        return { ok: true, notice };
      });
      env.show();
      await flush();
      env.elements['dapp-tx-approve'].dispatch('click');
      await flush();
      env.renderer.close('h1');
      expect(env.elements['dapp-tx-reject'].disabled).toBe(true);
      // Another handle's word changes nothing.
      env.deviceWaits('h2');
      expect(env.elements['dapp-tx-reject'].disabled).toBe(true);
      env.deviceWaits('h1');
      expect(env.elements['dapp-tx-reject'].disabled).toBe(false);
      // Back stays off: only Reject reaches the device.
      expect(env.elements['dapp-tx-back'].disabled).toBe(true);
      env.elements['dapp-tx-reject'].dispatch('click');
      await flush();
      await flush();
      expect(window.pagePrompts.cancel).toHaveBeenCalledWith('h1');
      // No second decision went to main.
      expect(env.decisions).toHaveLength(1);
      expect(env.showing()).toBe(true);
      expect(env.elements['dapp-tx-error'].textContent).toBe(notice);
      expect(env.elements['dapp-tx-reject'].disabled).toBe(true);
      expect(env.elements['dapp-tx-approve'].disabled).toBe(true);
      expect(require('./signature-flight.js').isSignatureInFlight()).toBe(false);
      jest.advanceTimersByTime(6000);
      expect(env.showing()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('Back closes the notice sooner; a Cancel main refused gives Reject back while the device waits', async () => {
    const env = await loadPage();
    const answer = env.answer();
    window.pagePrompts.cancel = jest.fn(async () => ({ ok: false, reason: 'not-waiting' }));
    env.show();
    await flush();
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    env.deviceWaits('h1');
    env.elements['dapp-tx-reject'].dispatch('click');
    await flush();
    expect(env.elements['dapp-tx-reject'].disabled).toBe(false);
    expect(env.showing()).toBe(true);
    // The device answers after all: the screen goes with main's answer.
    answer.resolve({ ok: true });
    await flush();
    expect(env.showing()).toBe(false);

    // A Cancel that went through, and Back right after its notice.
    const again = await loadPage();
    const second = again.answer();
    window.pagePrompts.cancel = jest.fn(async () => {
      second.resolve({ ok: true });
      return { ok: true, notice: 'Cancelled.' };
    });
    again.show();
    await flush();
    again.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    again.deviceWaits('h1');
    again.elements['dapp-tx-reject'].dispatch('click');
    await flush();
    await flush();
    expect(again.showing()).toBe(true);
    expect(again.elements['dapp-tx-back'].disabled).toBe(false);
    again.elements['dapp-tx-back'].dispatch('click');
    expect(again.showing()).toBe(false);
  });

  test('with no word from main (the JS backend), Reject stays off while the device signs', async () => {
    const env = await loadPage();
    window.pagePrompts.cancel = jest.fn();
    env.show();
    await flush();
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    env.elements['dapp-tx-reject'].dispatch('click');
    await flush();
    expect(window.pagePrompts.cancel).not.toHaveBeenCalled();
    expect(env.decisions).toHaveLength(1);
    env.answer().resolve({ ok: true });
    await flush();
  });

  // Design 0012, PHN-2 ("A phone payment's rule"): a phone send's "Always
  // allow" is saved only once its payment is checked, and the note under
  // the box says so, for a phone's send it is offered on alone.
  test('the phone\'s note shows only for a phone\'s send that offers "always allow"', async () => {
    const env = await loadPage();
    const note = () => !env.elements['dapp-tx-auto-approve-phone-note'].classList.contains('hidden');
    const PHONE = { ...ACCOUNT, index: LEDGER_INDEX + 1, name: 'Phone', type: 'remote' };
    env.show({ account: PHONE }, 'h1');
    await flush();
    expect(env.elements['dapp-tx-auto-approve-row'].classList.contains('hidden')).toBe(false);
    expect(note()).toBe(true);
    env.show({ account: PHONE, alwaysAllow: false }, 'h2');
    await flush();
    expect(note()).toBe(false);
    env.show({ account: PHONE }, 'h3');
    await flush();
    expect(note()).toBe(true);
    env.show({}, 'h4');
    await flush();
    expect(env.elements['dapp-tx-auto-approve-row'].classList.contains('hidden')).toBe(false);
    expect(note()).toBe(false);
  });

  test('"always allow" goes to main as the choice, only where main offers it', async () => {
    const env = await loadPage();
    env.show();
    await flush();
    env.elements['dapp-tx-auto-approve'].checked = true;
    env.elements['dapp-tx-approve'].dispatch('click');
    env.answer().resolve({ ok: true });
    await flush();
    env.show({ alwaysAllow: false, tx: { ...VIEW.tx, data: '0x' } }, 'h2');
    await flush();
    expect(env.elements['dapp-tx-auto-approve-row'].classList.contains('hidden')).toBe(true);
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([
      { handle: 'h1', approve: true, choices: { alwaysAllow: true } },
      { handle: 'h2', approve: true, choices: {} },
    ]);
  });

  test.each(['dapp-tx-reject', 'dapp-tx-back'])('%s answers the handle with a rejection and takes the screen down', async (id) => {
    const env = await loadPage();
    env.show();
    await flush();
    env.elements[id].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: false, choices: {} }]);
    expect(env.showing()).toBe(false);
  });

  test('a fee above the threshold is confirmed twice before main is answered', async () => {
    const env = await loadPage();
    env.show({ feeCheck: ABOVE });
    await flush();
    expect(env.elements['dapp-tx-fee-warning'].classList.contains('hidden')).toBe(false);
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([]);
    expect(env.elements['dapp-tx-approve'].textContent).toBe('Send anyway');
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: true, choices: { alwaysAllow: false, feeAcknowledged: true } }]);
  });

  test("main asking again at the press: the screen takes the request's next prompt in place", async () => {
    const env = await loadPage();
    env.show();
    await flush();
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    const flight = require('./signature-flight.js');
    expect(flight.isSignatureInFlight()).toBe(true);
    env.renderer.close('h1');
    const next = env.prompt({ feeCheck: { ...ABOVE, askAgain: true }, feeAskAgain: true }, 'h2');
    // Another tab's prompt is not this request's.
    expect(env.renderer.takesOver({ ...next, guest: 4 })).toBe(false);
    expect(env.renderer.takesOver(next)).toBe(true);
    env.renderer.show(next);
    await flush();
    expect(flight.isSignatureInFlight()).toBe(false);
    expect(env.renderer.isShowing()).toBe('h2');
    expect(env.elements['dapp-tx-approve'].textContent).toBe('Send anyway');
    expect(env.elements['dapp-tx-reject'].disabled).toBe(false);
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(env.decisions.at(-1)).toEqual({ handle: 'h2', approve: true, choices: { alwaysAllow: false, feeAcknowledged: true } });
    // The first decision's answer, when main answers, leaves the new one up.
    env.answer().resolve({ ok: true });
    await flush();
    expect(env.showing()).toBe(false);
  });

  test("a fee main couldn't quote: Confirm waits, and Try again asks main to quote it again", async () => {
    const env = await loadPage();
    env.show({ fee: null, feeCheck: null });
    await flush();
    expect(env.elements['dapp-tx-fee'].textContent).toBe('Unable to estimate');
    expect(env.elements['dapp-tx-approve'].disabled).toBe(true);
    expect(env.elements['dapp-tx-fee-retry-row'].classList.contains('hidden')).toBe(false);
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([]);
    env.elements['dapp-tx-fee-retry'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: true, choices: {} }]);
    expect(require('./signature-flight.js').isSignatureInFlight()).toBe(false);
    expect(env.elements['dapp-tx-fee'].textContent).toBe('Estimating…');
    expect(env.renderer.takesOver(env.prompt({}, 'h2'))).toBe(true);
  });

  test('a Safe: its approval takes the screen down at once, for the board main shows next', async () => {
    const env = await loadPage({ safe: true });
    env.show({ account: { ...ACCOUNT, type: 'safe' }, fee: { paidBy: 'executor' }, feeCheck: null, alwaysAllow: false });
    await flush();
    expect(require('./wallet-utils.js').renderSafeFeePayer).toHaveBeenCalled();
    env.elements['dapp-tx-approve'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: true, choices: {} }]);
    expect(env.showing()).toBe(false);
    expect(require('./signature-flight.js').isSignatureInFlight()).toBe(false);
  });

  test('main hiding it takes it down with no decision; another screen hiding it reports it displaced', async () => {
    const env = await loadPage();
    env.show();
    await flush();
    expect(env.renderer.close('h1')).toBe(true);
    expect(env.showing()).toBe(false);
    const displaced = [];
    require('../page-prompt-renderers.js').onPagePromptDisplaced((handle) => displaced.push(handle));
    env.show();
    await flush();
    env.hideForOtherScreen();
    expect(displaced).toEqual(['h1']);
    expect(env.renderer.isShowing()).toBeNull();
    expect(env.decisions).toEqual([]);
  });

  test("a view the screen can't show is rejected, never sent", async () => {
    const env = await loadPage();
    env.show({ tx: { ...VIEW.tx, value: 'not a number' } });
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: false, choices: {} }]);
    expect(env.showing()).toBe(false);
  });
});
