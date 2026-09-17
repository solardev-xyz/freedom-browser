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

    send.resolve({ success: true, hash: '0xfeedface', explorerUrl: 'https://ex/0xfeedface' });
    await flush();
    expect(flight.isSignatureInFlight()).toBe(false);
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
});
