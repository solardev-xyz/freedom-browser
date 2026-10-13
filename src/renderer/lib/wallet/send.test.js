class FakeTextNode {
  constructor(text) {
    this.textContent = String(text);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.title = '';
  }

  replaceChildren(...children) {
    this.children = children;
    this.textContent = children.map((child) => child?.textContent || '').join('');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
}

const ADDRESS = '0x1111111111111111111111111111111111111111';

const installDocument = () => {
  global.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeTextNode(text),
  };
};

const loadSendTestApi = async () => {
  jest.resetModules();
  jest.doMock('./wallet-state.js', () => ({
    walletState: {
      fullAddresses: { wallet: ADDRESS, swarm: '', ipfs: '', radicle: '' },
      identityView: null,
      registeredChains: {},
      registeredTokens: {},
      currentBalances: {},
    },
    registerScreenHider: jest.fn(),
  }));
  jest.doMock('./balance-display.js', () => ({
    refreshBalances: jest.fn(),
    getTokensWithBalance: jest.fn(() => []),
    getChainsWithBalance: jest.fn(() => []),
    sortTokens: jest.fn((tokens) => tokens),
  }));
  jest.doMock('../tabs.js', () => ({ createTab: jest.fn() }));

  const mod = await import('./send.js');
  return mod.__test__;
};

describe('send wallet review', () => {
  afterEach(() => {
    jest.dontMock('./wallet-state.js');
    jest.dontMock('./balance-display.js');
    jest.dontMock('../tabs.js');
    delete global.document;
    delete global.window;
  });

  test('accepts DNS, subdomain and Unicode ENS candidates', async () => {
    installDocument();
    global.window = { location: { href: 'file:///app/index.html' }, internalPages: { routable: {} } };
    const { isEnsLikeName } = await loadSendTestApi();
    for (const name of ['ur.integration-tests.eth', 'test.offchaindemo.eth', 'gregskril.com', '🦇🔊.eth', 'RaFFY.eth']) {
      expect(isEnsLikeName(name)).toBe(true);
    }
    for (const name of ['name', '.eth', 'foo..eth', 'name.eth/path', 'https://a.com', 'a@b.com', 'a b.eth', 'a\u0000.eth']) {
      expect(isEnsLikeName(name)).toBe(false);
    }
  });

  test('maps unverified reverse lookup results to the warning render path', async () => {
    installDocument();
    global.window = {
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: {} },
      electronAPI: {
        resolveEnsReverse: jest.fn().mockResolvedValue({
          success: false,
          reason: 'UNVERIFIED',
          claimedName: 'spoof.gwei',
        }),
      },
    };
    const { lookupPrimaryNameForAddress } = await loadSendTestApi();

    await expect(lookupPrimaryNameForAddress(ADDRESS)).resolves.toEqual({
      warning: 'unverified',
      claimedName: 'spoof.gwei',
    });
  });

  test('hides unverified reverse claimed names behind the warning glyph', async () => {
    installDocument();
    global.window = {
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: {} },
      electronAPI: {},
    };
    const { renderRecipientReview } = await loadSendTestApi();
    const container = new FakeElement('div');

    renderRecipientReview(container, ADDRESS, {
      warning: 'unverified',
      claimedName: 'spoof.gwei',
    });

    expect(container.textContent).toContain(ADDRESS);
    expect(container.textContent).not.toContain('spoof.gwei');

    const warning = container.children.find((child) => child.className === 'send-review-warning');
    expect(warning).toBeTruthy();
    expect(warning.title).toContain('spoof.gwei');
    expect(warning.getAttribute('aria-label')).toContain('spoof.gwei');
  });
});

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const SEND_ELEMENT_IDS = [
  'sidebar-send', 'send-back', 'send-input-view', 'send-review-view',
  'send-pending-view', 'send-success-view', 'send-error-view', 'send-recipient',
  'send-recipient-error', 'send-chain-selector', 'send-chain-btn', 'send-chain-logo',
  'send-chain-name', 'send-chain-dropdown', 'send-chain-list', 'send-asset-selector',
  'send-asset-btn', 'send-asset-logo', 'send-asset-name', 'send-asset-dropdown',
  'send-asset-list', 'send-amount', 'send-max-btn', 'send-balance-hint',
  'send-amount-error', 'send-continue-btn', 'send-general-error', 'send-review-to',
  'send-review-amount', 'send-review-network', 'send-review-fee-value',
  'send-review-total', 'send-edit-btn', 'send-confirm-btn', 'send-unlock-section',
  'send-touchid-btn', 'send-password-link', 'send-password-section',
  'send-password-input', 'send-password-submit', 'send-unlock-error',
  'send-review-error', 'send-explorer-link', 'send-done-btn', 'send-error-text',
  'send-retry-btn', 'wallet-send-btn',
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The review recipient is painted either as bare text (no name known) or as
// a span list via replaceChildren; the fake DOM does not aggregate the two.
const reviewRecipientText = (elements) => {
  const el = elements['send-review-to'];
  return el.children.length
    ? el.children.map((child) => child.textContent || '').join('')
    : el.textContent;
};

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

// Drives the real send screen against the real wallet-state/signature-flight
// modules, so the shared sidebar lock under test is the same instance every
// other approval surface would see.
async function loadSendScreen({ chains = [{ chainId: 100, name: 'Gnosis' }], reverseLookup = null } = {}) {
  jest.resetModules();
  // The screen arms focus/balance-refresh timers we don't care about here;
  // faking them keeps no handles alive past the test.
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });

  // The screen and its views start hidden, as they do in index.html, so
  // that showing/hiding them is observable.
  const startsHidden = new Set([
    'sidebar-send', 'send-input-view', 'send-review-view', 'send-pending-view',
    'send-success-view', 'send-error-view',
  ]);
  const elements = Object.fromEntries(
    SEND_ELEMENT_IDS.map((id) => [
      id,
      createElement('div', startsHidden.has(id) ? { classes: ['hidden'] } : {}),
    ])
  );
  global.document = createDocument({ elementsById: elements });

  const send = deferred();
  global.window = {
    location: { href: 'file:///app/index.html' },
    internalPages: { routable: {} },
    electronAPI: reverseLookup ? { resolveEnsReverse: reverseLookup } : {},
    wallet: {
      parseAmount: jest.fn().mockResolvedValue({ success: true, value: '1000' }),
      confirmSigning: jest.fn().mockResolvedValue({ success: true, token: 'confirm-token' }),
      sendTransaction: jest.fn(() => send.promise),
      estimateGas: jest.fn().mockResolvedValue({ success: true, gasLimit: '21000' }),
      getGasPrice: jest.fn().mockResolvedValue({ success: true, type: 'legacy', gasPrice: '1' }),
      formatUnits: jest.fn(() => '0.000021'),
    },
    dispatchEvent: jest.fn(),
    CustomEvent: class {},
  };
  global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };

  const token = { key: 'gnosis-native', symbol: 'xDAI', decimals: 18, address: null };
  jest.doMock('./balance-display.js', () => ({
    refreshBalances: jest.fn(),
    getTokensWithBalance: jest.fn(() => [token]),
    getChainsWithBalance: jest.fn(() => chains),
    sortTokens: jest.fn((tokens) => tokens),
  }));
  jest.doMock('../tabs.js', () => ({ createTab: jest.fn() }));

  const state = await import('./wallet-state.js');
  const flight = await import('./signature-flight.js');
  state.walletState.fullAddresses.wallet = ADDRESS;
  state.walletState.identityView = createElement('div');
  state.walletState.selectedChainId = chains[0].chainId;
  state.walletState.registeredChains = Object.fromEntries(
    chains.map((chain) => [chain.chainId, { name: chain.name }])
  );
  // A hardware account: the send waits on a device prompt that cannot be
  // recalled, which is what makes the sidebar lock necessary.
  state.walletState.activeWalletIndex = 0;
  state.walletState.derivedWallets = [{ index: 0, type: 'ledger' }];

  const mod = await import('./send.js');
  mod.initSend();

  return { mod, state, flight, elements, send };
}

describe('send screen sidebar ownership', () => {
  afterEach(() => {
    jest.dontMock('./balance-display.js');
    jest.dontMock('../tabs.js');
    delete global.document;
    delete global.window;
    delete global.CustomEvent;
    jest.useRealTimers();
  });

  test('a confirming send holds the shared sidebar lock until the device answers', async () => {
    const { mod, flight, elements, send } = await loadSendScreen();

    mod.openSend();
    expect(flight.isSignatureInFlight()).toBe(false);

    elements['send-confirm-btn'].dispatch('click');
    await flush();
    expect(window.wallet.sendTransaction).toHaveBeenCalled();
    expect(flight.isSignatureInFlight()).toBe(true);
    // Main signs only against a confirmation minted for exactly these
    // fields (security audit O-7).
    const [txParams, , authorization] = window.wallet.sendTransaction.mock.calls[0];
    expect(window.wallet.confirmSigning).toHaveBeenCalledWith('wallet-send', null, txParams);
    expect(authorization).toEqual({ confirmation: 'confirm-token' });

    send.resolve({ success: true, hash: '0xfeedface', explorerUrl: 'https://ex/0xfeedface' });
    await flush();
    expect(flight.isSignatureInFlight()).toBe(false);
  });

  test('a confirmed send reports what it paid, and close tells the opener', async () => {
    const { mod, elements, send } = await loadSendScreen();
    const onClose = jest.fn();

    await mod.openSend({ recipient: ADDRESS, chainId: 100, amount: '0.45', onClose });
    elements['send-confirm-btn'].dispatch('click');
    await flush();
    send.resolve({ success: true, hash: '0xfeedface', explorerUrl: 'https://ex/0xfeedface' });
    await flush();

    // The publish setup tracks only a payment that still goes to its node.
    const event = window.dispatchEvent.mock.calls
      .map(([e]) => e)
      .find((e) => e.type === 'wallet:tx-success');
    expect(event.detail).toEqual({
      hash: '0xfeedface',
      chainId: 100,
      asset: null,
      to: ADDRESS,
      value: '1000',
    });

    elements['send-done-btn'].dispatch('click');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ handedOff: false });
  });

  test('another screen taking the sidebar ends the opener\'s Send as handed off', async () => {
    const { mod, state } = await loadSendScreen();
    const onClose = jest.fn();

    await mod.openSend({ recipient: ADDRESS, chainId: 100, amount: '0.45', onClose });
    // A dApp prompt (connect, sign) hides every sub-screen.
    state.hideAllSubscreens();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ handedOff: true });

    // A later close (another Send, the coordinator) must not fire it again:
    // the publish setup would reopen over whatever the user went to.
    mod.closeSend();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('nothing may hide the send screen while its signature is in flight', async () => {
    const { mod, state, elements, send } = await loadSendScreen();

    mod.openSend();
    elements['send-confirm-btn'].dispatch('click');
    await flush();

    // The shared teardown a dApp request would use (personal_sign,
    // eth_requestAccounts) must refuse rather than paint over the live
    // "Confirm on your Ledger" screen.
    expect(() => state.hideAllSubscreens()).toThrow(/already in progress/);
    expect(elements['sidebar-send'].classList.contains('hidden')).toBe(false);
    expect(elements['send-pending-view'].classList.contains('hidden')).toBe(false);

    // Back / sidebar-close / closeAllSubscreens land on closeSend().
    mod.closeSend();
    expect(elements['sidebar-send'].classList.contains('hidden')).toBe(false);
    expect(elements['send-back'].disabled).toBe(true);

    send.resolve({ success: true, hash: '0xfeedface', explorerUrl: 'https://ex/0xfeedface' });
    await flush();

    // Once the device has answered the screen is ordinary again.
    expect(elements['send-success-view'].classList.contains('hidden')).toBe(false);
    expect(elements['send-back'].disabled).toBe(false);
    state.hideAllSubscreens();
    expect(elements['sidebar-send'].classList.contains('hidden')).toBe(true);
  });

  test.each(['reverse', 'unlock'])('a network switch during %s preparation refuses the stale review', async (stage) => {
    const reverse = deferred();
    const { mod, state, elements } = await loadSendScreen({
      chains: [
        { chainId: 100, name: 'Gnosis' },
        { chainId: 8453, name: 'Base' },
      ],
      reverseLookup: jest.fn(() => stage === 'reverse'
        ? reverse.promise : Promise.resolve({ success: true, name: 'gnosis-only.eth' })),
    });
    if (stage === 'unlock') {
      state.walletState.derivedWallets = [{ index: 0, type: 'software' }];
      window.identity = { getStatus: jest.fn(() => reverse.promise) };
    }

    await mod.openSend({
      chainId: 100,
      tokenKey: 'gnosis-native',
      recipient: ADDRESS,
      amount: '1',
    });

    elements['send-continue-btn'].dispatch('click');
    await flush();
    expect(window.electronAPI.resolveEnsReverse).toHaveBeenCalledWith(ADDRESS, 100);

    if (stage === 'unlock') expect(window.identity.getStatus).toHaveBeenCalled();
    // The user switches to Base while review preparation is still in flight.
    elements['send-chain-btn'].dispatch('click');
    elements['send-chain-list'].children[1].dispatch('click');

    reverse.resolve(stage === 'reverse'
      ? { success: true, name: 'gnosis-only.eth' } : { isUnlocked: true });
    await flush();

    expect(elements['send-review-view'].classList.contains('hidden')).toBe(true);
    expect(elements['send-general-error'].textContent).toContain('Network changed');
    expect(reviewRecipientText(elements)).not.toContain('gnosis-only.eth');
  });

  test('a reverse-lookup name that settles on the same chain still shows', async () => {
    const { mod, elements } = await loadSendScreen({
      reverseLookup: jest.fn().mockResolvedValue({ success: true, name: 'stable.eth' }),
    });

    await mod.openSend({
      chainId: 100,
      tokenKey: 'gnosis-native',
      recipient: ADDRESS,
      amount: '1',
    });

    elements['send-continue-btn'].dispatch('click');
    await flush();
    await flush();

    expect(elements['send-review-view'].classList.contains('hidden')).toBe(false);
    expect(reviewRecipientText(elements)).toContain('stable.eth');
    expect(reviewRecipientText(elements)).toContain(ADDRESS);
  });

  test.each([
    ['gas', 'test.ses.eth'], ['unlock', 'test.ses.eth'], ['gas', ADDRESS],
  ])('a network switch during %s preparation refuses review for %s', async (stage, recipient) => {
    const pending = deferred();
    const { mod, state, elements } = await loadSendScreen({
      chains: [
        { chainId: 100, name: 'Gnosis' },
        { chainId: 8453, name: 'Base' },
      ],
    });
    window.electronAPI.resolveEnsAddress = jest.fn().mockResolvedValue({
      success: true, name: 'test.ses.eth', address: ADDRESS,
    });
    if (stage === 'gas') {
      window.wallet.estimateGas.mockImplementationOnce(() => pending.promise);
    } else {
      state.walletState.derivedWallets = [{ index: 0, type: 'software' }];
      window.identity = { getStatus: jest.fn(() => pending.promise) };
    }
    await mod.openSend({ chainId: 100, tokenKey: 'gnosis-native', recipient, amount: '1' });
    elements['send-continue-btn'].dispatch('click');
    await flush();
    if (recipient !== ADDRESS) expect(window.electronAPI.resolveEnsAddress).toHaveBeenCalledWith(recipient, 100);
    expect(stage === 'gas' ? window.wallet.estimateGas : window.identity.getStatus).toHaveBeenCalled();

    elements['send-chain-btn'].dispatch('click');
    elements['send-chain-list'].children[1].dispatch('click');
    pending.resolve(stage === 'gas' ? { success: true, gasLimit: '21000' } : { isUnlocked: true });
    await flush();

    expect(elements['send-review-view'].classList.contains('hidden')).toBe(true);
    expect(elements['send-general-error'].textContent).toContain('Network changed');
    expect(elements['send-continue-btn'].disabled).toBe(false);
    expect(window.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  test.each([false, true])('automatic Touch ID waits for an accepted review (network changed: %s)', async (changeNetwork) => {
    const pending = deferred();
    const { mod, state, elements } = await loadSendScreen({
      chains: [{ chainId: 100, name: 'Gnosis' }, { chainId: 8453, name: 'Base' }],
    });
    state.walletState.derivedWallets = [{ index: 0, type: 'software' }];
    window.identity = {
      getStatus: jest.fn().mockResolvedValue({ isUnlocked: false }),
      getVaultMeta: jest.fn(() => pending.promise),
    };
    window.quickUnlock = {
      canUseTouchId: jest.fn().mockResolvedValue(true),
      isEnabled: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue({ success: false, error: 'Touch ID cancelled' }),
    };
    await mod.openSend({ chainId: 100, tokenKey: 'gnosis-native', recipient: ADDRESS, amount: '1' });
    elements['send-continue-btn'].dispatch('click');
    await flush();
    expect(window.identity.getVaultMeta).toHaveBeenCalled();
    if (changeNetwork) {
      elements['send-chain-btn'].dispatch('click');
      elements['send-chain-list'].children[1].dispatch('click');
    }
    pending.resolve({ userKnowsPassword: true });
    await flush();
    await jest.advanceTimersByTimeAsync(100);
    expect(window.quickUnlock.unlock).toHaveBeenCalledTimes(changeNetwork ? 0 : 1);
    expect(elements['send-review-view'].classList.contains('hidden')).toBe(changeNetwork);
  });

  test('editing a reviewed address and changing networks replaces its previous primary name', async () => {
    const { mod, elements } = await loadSendScreen({
      chains: [{ chainId: 100, name: 'Gnosis' }, { chainId: 8453, name: 'Base' }],
      reverseLookup: jest.fn()
        .mockResolvedValueOnce({ success: true, name: 'gnosis-only.eth' })
        .mockResolvedValueOnce({ success: true, name: 'base-only.eth' }),
    });
    await mod.openSend({ chainId: 100, tokenKey: 'gnosis-native', recipient: ADDRESS, amount: '1' });
    elements['send-continue-btn'].dispatch('click');
    await flush();
    expect(reviewRecipientText(elements)).toContain('gnosis-only.eth');

    elements['send-edit-btn'].dispatch('click');
    elements['send-chain-btn'].dispatch('click');
    elements['send-chain-list'].children[1].dispatch('click');
    elements['send-continue-btn'].dispatch('click');
    await flush();

    expect(window.electronAPI.resolveEnsReverse).toHaveBeenLastCalledWith(ADDRESS, 8453);
    expect(reviewRecipientText(elements)).toContain('base-only.eth');
    expect(reviewRecipientText(elements)).not.toContain('gnosis-only.eth');
  });

  test('the send screen refuses to open over another surface\'s device confirmation', async () => {
    const { mod, flight, elements } = await loadSendScreen();

    // An x402 payment / dApp transaction is waiting on the device.
    const other = {};
    flight.beginSignatureFlight(other);

    mod.openSend();
    expect(elements['sidebar-send'].classList.contains('hidden')).toBe(true);
    expect(elements['send-input-view'].classList.contains('hidden')).toBe(true);

    // …and opens normally once the device has answered.
    flight.endSignatureFlight(other);
    mod.openSend();
    expect(elements['sidebar-send'].classList.contains('hidden')).toBe(false);
    expect(elements['send-input-view'].classList.contains('hidden')).toBe(false);
  });

  test('the explorer link opens a tab on click and on middle-click, never a popup', async () => {
    const { mod, elements, send } = await loadSendScreen();
    const { createTab } = await import('../tabs.js');

    mod.openSend();
    elements['send-confirm-btn'].dispatch('click');
    await flush();
    send.resolve({ success: true, hash: '0xfeedface', explorerUrl: 'https://ex/0xfeedface' });
    await flush();
    const link = elements['send-explorer-link'];
    expect(link.href).toBe('https://ex/0xfeedface');

    const click = { button: 0, preventDefault: jest.fn() };
    link.dispatch('click', click);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(createTab).toHaveBeenLastCalledWith('https://ex/0xfeedface', { background: false });

    // Middle-click arrives as auxclick; the chrome window denies the popup
    // target="_blank" would ask for, so without this it did nothing.
    const middle = { button: 1, preventDefault: jest.fn() };
    link.dispatch('auxclick', middle);
    expect(middle.preventDefault).toHaveBeenCalled();
    expect(createTab).toHaveBeenLastCalledWith('https://ex/0xfeedface', { background: true });
    expect(createTab).toHaveBeenCalledTimes(2);
  });
});

describe('send again after a failed send (5)', () => {
  afterEach(() => {
    jest.dontMock('./balance-display.js');
    jest.dontMock('../tabs.js');
    delete global.document;
    delete global.window;
    delete global.CustomEvent;
    jest.useRealTimers();
  });

  const HELD = {
    intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a01',
    chainId: 100,
    sender: ADDRESS,
    nonce: 7,
    hash: '0x' + 'ab'.repeat(32),
    state: 'held',
    attention: 'refused',
  };

  async function failedSend(reply) {
    const loaded = await loadSendScreen();
    const { mod, elements, send } = loaded;
    // The result views' titles, which the outcome rewrites.
    for (const [view, title] of [
      ['send-error-view', 'send-error-title'],
      ['send-success-view', 'send-success-title'],
    ]) {
      elements[view].appendChild(createElement('h3', { classes: [title] }));
    }
    window.wallet.intentResend = jest.fn();
    await mod.openSend({ recipient: ADDRESS, chainId: 100, amount: '0.45' });
    elements['send-confirm-btn'].dispatch('click');
    await flush();
    send.resolve(reply);
    await flush();
    return loaded;
  }

  const title = (elements, view) =>
    elements[view].querySelector(`.${view.replace('-view', '-title')}`);

  test('a refused send says why, and Send again sends the same payment at its nonce', async () => {
    const { elements } = await failedSend({
      success: false,
      error: 'Insufficient funds for transaction',
      outcome: 'rejected',
      reasonClass: 'insufficient funds',
      intentId: HELD.intentId,
      intent: HELD,
    });
    expect(elements['send-error-view'].classList.contains('hidden')).toBe(false);
    expect(title(elements, 'send-error-view').textContent).toBe('Refused by the network');
    expect(elements['send-error-text'].textContent).toBe(
      'The network refused it: insufficient funds'
    );
    expect(elements['send-retry-btn'].textContent).toBe('Send again');

    window.wallet.intentResend.mockResolvedValue({
      success: true,
      outcome: 'sent',
      resent: true,
      explorerUrl: 'https://ex/0xab',
    });
    elements['send-retry-btn'].dispatch('click');
    await flush();

    // Confirmed as the held payment main reported, then sent again; no new
    // payment is signed.
    expect(window.wallet.confirmSigning).toHaveBeenLastCalledWith('intent-resend', null, {
      intentId: HELD.intentId,
      chainId: 100,
      sender: ADDRESS,
      nonce: 7,
      hash: HELD.hash,
    });
    expect(window.wallet.intentResend).toHaveBeenCalledWith(HELD.intentId, {
      confirmation: 'confirm-token',
    });
    expect(window.wallet.sendTransaction).toHaveBeenCalledTimes(1);
    expect(elements['send-success-view'].classList.contains('hidden')).toBe(false);
    expect(title(elements, 'send-success-view').textContent).toBe('Transaction Sent');
  });

  test('a payment that never left is said so, and a second refusal keeps Send again', async () => {
    const { elements } = await failedSend({
      success: false,
      error: 'Myotis is not ready',
      outcome: 'not_sent',
      intentId: HELD.intentId,
      intent: { ...HELD, attention: 'not-sent' },
    });
    expect(title(elements, 'send-error-view').textContent).toBe('Not sent');
    expect(elements['send-error-text'].textContent).toBe('Not sent; nothing left this computer');

    window.wallet.intentResend.mockResolvedValue({
      success: false,
      error: 'Insufficient funds for transaction',
      outcome: 'rejected',
      reasonClass: 'insufficient funds',
      intent: HELD,
    });
    elements['send-retry-btn'].dispatch('click');
    await flush();
    expect(elements['send-error-text'].textContent).toBe(
      'The network refused it: insufficient funds'
    );
    expect(elements['send-retry-btn'].textContent).toBe('Send again');
    expect(elements['send-retry-btn'].disabled).toBe(false);
  });

  test('a send that may have gone out is shown as sent, waiting', async () => {
    const { elements } = await failedSend({
      success: true,
      hash: HELD.hash,
      outcome: 'uncertain',
      intentId: HELD.intentId,
      explorerUrl: 'https://ex/0xab',
    });
    expect(elements['send-success-view'].classList.contains('hidden')).toBe(false);
    expect(title(elements, 'send-success-view').textContent).toBe('Sent, waiting for confirmation');
  });

  test('a failure before any payment existed goes back to the form, as before', async () => {
    const { elements } = await failedSend({ success: false, error: 'Rejected on the Ledger' });
    expect(elements['send-error-text'].textContent).toBe('Rejected on the Ledger');
    expect(elements['send-retry-btn'].textContent).toBe('Try Again');
    elements['send-retry-btn'].dispatch('click');
    await flush();
    expect(window.wallet.intentResend).not.toHaveBeenCalled();
    expect(elements['send-input-view'].classList.contains('hidden')).toBe(false);
  });

  // 709-B1: once a send has an intent, Retry only ever sends that payment
  // again, or closes: it never goes back to the form, whose Confirm would
  // sign the payment again at the next nonce.
  const refused = { success: false, outcome: 'rejected', intentId: HELD.intentId, intent: HELD };
  const isShown = (elements, view) => !elements[view].classList.contains('hidden');
  const formReachable = (elements) =>
    isShown(elements, 'send-input-view') || isShown(elements, 'send-review-view');
  const resendBindings = () =>
    window.wallet.confirmSigning.mock.calls
      .filter(([kind]) => kind === 'intent-resend')
      .map(([, , payload]) => payload);

  test('an authorization refusal with no word on the payment keeps Send again, never the form', async () => {
    const { elements } = await failedSend(refused);
    // The reviewer's reply shape: the refusal names nothing.
    window.wallet.intentResend.mockResolvedValue({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: 'Signing was not confirmed: confirmation expired',
    });
    for (let press = 0; press < 3; press += 1) {
      elements['send-retry-btn'].dispatch('click');
      await flush();
      expect(elements['send-retry-btn'].textContent).toBe('Send again');
      expect(formReachable(elements)).toBe(false);
    }
    expect(window.wallet.intentResend).toHaveBeenCalledTimes(3);
    expect(window.wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  test("a lapsed or stale confirmation is minted again against main's current hash, once", async () => {
    const { elements } = await failedSend(refused);
    const replaced = { ...HELD, hash: '0x' + 'cd'.repeat(32) };
    window.wallet.intentResend
      .mockResolvedValueOnce({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        error: 'Signing was not confirmed',
        intentId: HELD.intentId,
        intent: replaced,
      })
      .mockResolvedValueOnce({ success: true, hash: replaced.hash, outcome: 'sent', resent: true });
    elements['send-retry-btn'].dispatch('click');
    await flush();
    expect(resendBindings().map((binding) => binding.hash)).toEqual([HELD.hash, replaced.hash]);
    expect(window.wallet.intentResend).toHaveBeenCalledTimes(2);
    expect(isShown(elements, 'send-success-view')).toBe(true);
    expect(window.wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  test('a second refusal of the fresh confirmation stops there, still offering Send again', async () => {
    const { elements } = await failedSend(refused);
    window.wallet.intentResend.mockResolvedValue({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: 'Signing was not confirmed',
      intentId: HELD.intentId,
      intent: HELD,
    });
    elements['send-retry-btn'].dispatch('click');
    await flush();
    expect(window.wallet.intentResend).toHaveBeenCalledTimes(2);
    expect(elements['send-retry-btn'].textContent).toBe('Send again');
    expect(formReachable(elements)).toBe(false);
  });

  test('no reply at all (a confirmation main refused to mint, a failed IPC) keeps the payment', async () => {
    const { elements } = await failedSend(refused);
    window.wallet.confirmSigning.mockResolvedValueOnce({
      success: false,
      error: 'Invalid transaction hash',
    });
    elements['send-retry-btn'].dispatch('click');
    await flush();
    expect(window.wallet.intentResend).not.toHaveBeenCalled();
    expect(elements['send-retry-btn'].textContent).toBe('Send again');
    window.wallet.intentResend.mockRejectedValueOnce(new Error('IPC channel closed'));
    elements['send-retry-btn'].dispatch('click');
    await flush();
    expect(elements['send-retry-btn'].textContent).toBe('Send again');
    expect(formReachable(elements)).toBe(false);
    expect(window.wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  test('a payment main reports settled or unknown closes: Retry closes the screen, never the form', async () => {
    for (const reply of [
      {
        success: false,
        code: 'INTENT_NOT_HELD',
        error: 'This payment is already settled.',
        intentId: HELD.intentId,
        intent: { ...HELD, state: 'settled' },
      },
      {
        success: false,
        code: 'INTENT_UNKNOWN',
        error: "This payment is not in the wallet's records.",
      },
    ]) {
      const { elements } = await failedSend(refused);
      window.wallet.intentResend.mockResolvedValue(reply);
      elements['send-retry-btn'].dispatch('click');
      await flush();
      expect(elements['send-error-text'].textContent).toBe(reply.error);
      expect(elements['send-retry-btn'].textContent).toBe('Close');
      elements['send-retry-btn'].dispatch('click');
      await flush();
      expect(isShown(elements, 'sidebar-send')).toBe(false);
      expect(formReachable(elements)).toBe(false);
      expect(window.wallet.sendTransaction).toHaveBeenCalledTimes(1);
    }
  });

  test('a first send naming a payment main no longer holds closes too', async () => {
    const { elements } = await failedSend({ ...refused, intent: { ...HELD, state: 'voided' } });
    expect(elements['send-retry-btn'].textContent).toBe('Close');
  });

  // 709-M1: a resend's late result belongs to the screen it started on.
  async function screenBWithItsOwnHeldPayment(loaded) {
    const { mod, elements } = loaded;
    mod.closeSend();
    await mod.openSend({ recipient: '0x' + '22'.repeat(20), chainId: 100, amount: '0.99' });
    const heldB = {
      ...HELD,
      intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1b02',
      nonce: 8,
      hash: '0x' + 'bc'.repeat(32),
    };
    window.wallet.sendTransaction.mockResolvedValueOnce({
      success: false,
      error: 'Refused B',
      outcome: 'rejected',
      intentId: heldB.intentId,
      intent: heldB,
    });
    elements['send-continue-btn'].dispatch('click');
    await flush();
    elements['send-confirm-btn'].dispatch('click');
    await flush();
    expect(window.wallet.sendTransaction).toHaveBeenCalledTimes(2);
    expect(elements['send-retry-btn'].textContent).toBe('Send again');
    return heldB;
  }

  test("a delayed refusal of A's resend leaves B's screen and its Send again alone", async () => {
    const loaded = await failedSend(refused);
    const { elements } = loaded;
    const later = deferred();
    window.wallet.intentResend.mockReturnValueOnce(later.promise);
    elements['send-retry-btn'].dispatch('click');
    await flush();

    const heldB = await screenBWithItsOwnHeldPayment(loaded);
    const textB = elements['send-error-text'].textContent;
    later.resolve({
      success: false,
      error: 'Refused A',
      outcome: 'rejected',
      intentId: HELD.intentId,
      intent: HELD,
    });
    await flush();
    expect(elements['send-error-text'].textContent).toBe(textB);
    expect(elements['send-retry-btn'].textContent).toBe('Send again');

    // B's Send again sends B.
    window.wallet.intentResend.mockResolvedValue({
      success: true,
      hash: heldB.hash,
      outcome: 'sent',
    });
    elements['send-retry-btn'].dispatch('click');
    await flush();
    expect(window.wallet.intentResend).toHaveBeenLastCalledWith(heldB.intentId, expect.any(Object));
    expect(resendBindings().at(-1)).toMatchObject({
      intentId: heldB.intentId,
      nonce: 8,
      hash: heldB.hash,
    });
  });

  test("a delayed success of A's resend doesn't paint into B's screen", async () => {
    const loaded = await failedSend(refused);
    const { elements } = loaded;
    const later = deferred();
    window.wallet.intentResend.mockReturnValueOnce(later.promise);
    elements['send-retry-btn'].dispatch('click');
    await flush();
    await screenBWithItsOwnHeldPayment(loaded);
    later.resolve({ success: true, hash: HELD.hash, outcome: 'sent', resent: true });
    await flush();
    expect(isShown(elements, 'send-success-view')).toBe(false);
    expect(isShown(elements, 'send-error-view')).toBe(true);
  });

  test('a delayed result after the screen closed paints nothing', async () => {
    const loaded = await failedSend(refused);
    const { mod, elements } = loaded;
    const later = deferred();
    window.wallet.intentResend.mockReturnValueOnce(later.promise);
    elements['send-retry-btn'].dispatch('click');
    await flush();
    mod.closeSend();
    // No outcome: a repaint would show this text.
    later.resolve({ success: false, error: 'Refused A', intentId: HELD.intentId, intent: HELD });
    await flush();
    expect(isShown(elements, 'sidebar-send')).toBe(false);
    expect(isShown(elements, 'send-error-view')).toBe(true); // as it was left: the screen itself is hidden
    expect(elements['send-error-text'].textContent).not.toBe('Refused A');
  });
});

describe('send review: a payment that would wait behind a held one (D11)', () => {
  afterEach(() => {
    jest.dontMock('./balance-display.js');
    jest.dontMock('../tabs.js');
    delete global.document;
    delete global.window;
    delete global.CustomEvent;
    jest.useRealTimers();
  });

  const waiting = (overrides) => ({
    intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a01',
    chainId: 100,
    sender: ADDRESS,
    nonce: 7,
    hash: '0x' + 'ab'.repeat(32),
    state: 'held',
    kind: 'wallet-send',
    walletIndex: 0,
    fields: {
      type: 0,
      to: ADDRESS,
      value: '450000000000000000',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '1',
    },
    attention: 'refused',
    lastOutcome: { outcome: 'rejected', reasonClass: 'insufficient funds' },
    receipt: null,
    ...overrides,
  });

  async function review(intents) {
    const loaded = await loadSendScreen();
    const { mod, state, elements } = loaded;
    elements['send-held-warning'] = createElement('div', { classes: ['hidden'] });
    elements['send-held-warning-text'] = createElement('span');
    state.walletState.registeredChains[100].nativeSymbol = 'xDAI';
    window.wallet.intentsList = jest.fn().mockResolvedValue({ success: true, intents });
    await mod.openSend({
      chainId: 100,
      tokenKey: 'gnosis-native',
      recipient: ADDRESS,
      amount: '0.45',
    });
    elements['send-continue-btn'].dispatch('click');
    await flush();
    await flush();
    await flush();
    return elements;
  }

  const shown = (elements) => !elements['send-held-warning'].classList.contains('hidden');

  test('names the held payment and its nonce', async () => {
    const elements = await review([waiting()]);
    expect(elements['send-review-view'].classList.contains('hidden')).toBe(false);
    expect(shown(elements)).toBe(true);
    expect(elements['send-held-warning-text'].textContent).toBe(
      "This payment will wait behind an earlier one that hasn't gone through yet: " +
        '0.45 xDAI to 0x1111…1111 (nonce 7). Send that one again or raise its fee first, ' +
        'from Payments waiting.'
    );
  });

  test('says nothing for a payment that is only waiting to be mined, mined, or elsewhere', async () => {
    for (const intents of [
      [],
      [waiting({ attention: 'uncertain' })],
      [waiting({ attention: 'sent' })],
      [waiting({ receipt: 'confirmed' })],
      [waiting({ chainId: 1 })],
      [waiting({ sender: '0x2222222222222222222222222222222222222222' })],
    ]) {
      const elements = await review(intents);
      expect({ intents, shown: shown(elements) }).toEqual({ intents, shown: false });
    }
  });
});
