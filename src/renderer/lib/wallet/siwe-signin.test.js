/**
 * Tests for the Sign-In with Ethereum card (#1152): it shows only for the
 * active tab, preselects the account used last on the site, signs the
 * message main prepared through the wallet's confirmation path, and leaves
 * with its page.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const IDS = [
  'sidebar-siwe-signin',
  'siwe-signin-back',
  'siwe-signin-site',
  'siwe-signin-selector',
  'siwe-signin-account-btn',
  'siwe-signin-account-name',
  'siwe-signin-account-address',
  'siwe-signin-account-kind',
  'siwe-signin-dropdown',
  'siwe-signin-account-list',
  'siwe-signin-remembered',
  'siwe-signin-message',
  'siwe-signin-note',
  'siwe-signin-unlock',
  'siwe-signin-touchid-btn',
  'siwe-signin-password-link',
  'siwe-signin-password-section',
  'siwe-signin-password-input',
  'siwe-signin-password-submit',
  'siwe-signin-unlock-error',
  'siwe-signin-error',
  'siwe-signin-cancel',
  'siwe-signin-approve',
];

const MAIN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SAVINGS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const LEDGER_INDEX = 1000000;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await flush();
}

function challenge(overrides = {}) {
  return {
    id: 'c1',
    webContentsId: 7,
    url: 'https://club.example/members',
    origin: 'https://club.example',
    domain: 'club.example',
    statement: 'Sign in to Example Club',
    chainId: 1,
    rememberedAddress: null,
    ...overrides,
  };
}

async function loadCard({ activeGuestId = 7, unlocked = true, wallets } = {}) {
  jest.resetModules();

  const elements = Object.fromEntries(IDS.map((id) => [id, createElement('div')]));
  for (const id of [
    'sidebar-siwe-signin',
    'siwe-signin-dropdown',
    'siwe-signin-remembered',
    'siwe-signin-unlock',
    'siwe-signin-error',
    'siwe-signin-unlock-error',
    'siwe-signin-account-kind',
  ]) {
    elements[id].classList.add('hidden');
  }
  global.document = createDocument({ elementsById: elements });

  const listeners = {};
  const open = new Map();
  const electronAPI = {
    onSiweChallenge: jest.fn((cb) => {
      listeners.challenge = cb;
    }),
    onSiweChallengeClosed: jest.fn((cb) => {
      listeners.closed = cb;
    }),
    siweGetChallenge: jest.fn(async ({ id }) => open.get(id) || null),
    siwePrepare: jest.fn(async ({ walletIndex }) => {
      const wallet = (wallets || defaultWallets).find((w) => w.index === walletIndex);
      return {
        success: true,
        address: wallet.address,
        message: `club.example wants you to sign in…\n${wallet.address}`,
      };
    }),
    siweComplete: jest.fn(async () => ({ success: true })),
    siweCancel: jest.fn(async () => ({ success: true })),
  };
  const defaultWallets = [
    { index: 0, name: 'Main Wallet', address: MAIN, type: 'mnemonic' },
    { index: 2, name: 'Savings', address: SAVINGS, type: 'mnemonic' },
    {
      index: 5,
      name: 'Team Safe',
      address: '0x1111111111111111111111111111111111111111',
      type: 'safe',
    },
    {
      index: LEDGER_INDEX,
      name: 'Ledger 1',
      address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      type: 'ledger',
    },
  ];
  const state = { status: { isUnlocked: unlocked } };
  global.window = {
    electronAPI,
    wallet: {
      getDerivedWallets: jest.fn(async () => ({
        success: true,
        wallets: wallets || defaultWallets,
      })),
      signMessage: jest.fn(async () => ({ success: true, signature: '0xsig' })),
    },
    identity: {
      getStatus: jest.fn(async () => state.status),
      getVaultMeta: jest.fn(async () => ({ userKnowsPassword: true })),
      unlock: jest.fn(async () => {
        state.status = { isUnlocked: true };
        return { success: true };
      }),
    },
    quickUnlock: {
      canUseTouchId: jest.fn(async () => false),
      isEnabled: jest.fn(async () => false),
      unlock: jest.fn(),
    },
  };

  const walletState = {
    derivedWallets: [],
    activeWalletIndex: 2,
    identityView: createElement('div'),
  };
  const hiders = [];
  jest.doMock('./wallet-state.js', () => ({
    walletState,
    registerScreenHider: (fn) => hiders.push(fn),
    hideAllSubscreens: jest.fn(() => hiders.forEach((fn) => fn())),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn() }));
  const recordFor = (index) => (wallets || defaultWallets).find((w) => w.index === index);
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: (text) => String(text),
    truncateAddress: (address) => `${address.slice(0, 6)}…${address.slice(-4)}`,
    isSafeAccount: (index) => recordFor(index)?.type === 'safe',
    isDeviceAccount: (index) => recordFor(index)?.type === 'ledger',
    deviceLabel: (index) => (recordFor(index)?.type === 'ledger' ? 'your Ledger' : null),
    signingButtonLabel: (index) =>
      recordFor(index)?.type === 'ledger' ? 'Confirm on your Ledger…' : 'Signing…',
  }));
  const confirmSigning = jest.fn(async () => ({ confirmation: 'token-1' }));
  jest.doMock('./signing-confirmation.js', () => ({ confirmSigning }));
  const tabs = { active: activeGuestId, listener: null };
  jest.doMock('../tabs.js', () => ({
    getActiveWebview: () => (tabs.active === null ? null : { getWebContentsId: () => tabs.active }),
    subscribeTabPresentation: (listener) => {
      tabs.listener = listener;
      listener([]);
    },
  }));

  const mod = await import('./siwe-signin.js');
  mod.initSiweSignin();

  const card = elements['sidebar-siwe-signin'];
  return {
    elements,
    electronAPI,
    confirmSigning,
    card,
    shown: () => !card.classList.contains('hidden'),
    async arrive(c) {
      open.set(c.id, c);
      listeners.challenge(c);
      await settle();
    },
    async closed(id) {
      open.delete(id);
      listeners.closed({ id });
      await settle();
    },
    async switchTo(guestId) {
      tabs.active = guestId;
      tabs.listener([]);
      await settle();
    },
    async click(id) {
      elements[id].dispatch('click', {});
      await settle();
    },
  };
}

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
  jest.restoreAllMocks();
});

describe('SIWE sign-in card', () => {
  test('shows for the active tab with the message main prepared, and signs it', async () => {
    const ctx = await loadCard();
    await ctx.arrive(challenge());

    expect(ctx.shown()).toBe(true);
    expect(ctx.elements['siwe-signin-site'].textContent).toBe('club.example');
    expect(ctx.elements['siwe-signin-note'].textContent).toContain('Signing in shows club.example');
    // No account remembered: the active account is preselected.
    expect(ctx.elements['siwe-signin-account-name'].textContent).toBe('Savings');
    expect(ctx.electronAPI.siwePrepare).toHaveBeenCalledWith({ id: 'c1', walletIndex: 2 });
    const message = `club.example wants you to sign in…\n${SAVINGS}`;
    expect(ctx.elements['siwe-signin-message'].textContent).toBe(message);
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(false);

    await ctx.click('siwe-signin-approve');

    expect(ctx.confirmSigning).toHaveBeenCalledWith('sign-message', 2, message);
    expect(global.window.wallet.signMessage).toHaveBeenCalledWith(message, 2, {
      confirmation: 'token-1',
    });
    expect(ctx.electronAPI.siweComplete).toHaveBeenCalledWith({
      id: 'c1',
      walletIndex: 2,
      signature: '0xsig',
    });
    expect(ctx.shown()).toBe(false);
  });

  test('preselects the account used last on the site and says so', async () => {
    const ctx = await loadCard();
    await ctx.arrive(challenge({ rememberedAddress: MAIN.toLowerCase() }));
    expect(ctx.elements['siwe-signin-account-name'].textContent).toBe('Main Wallet');
    expect(ctx.elements['siwe-signin-remembered'].classList.contains('hidden')).toBe(false);
  });

  test('never offers a Safe account', async () => {
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    await ctx.click('siwe-signin-account-btn');
    const names = ctx.elements['siwe-signin-account-list'].children.map((item) => item.innerHTML);
    expect(names.some((html) => html.includes('Team Safe'))).toBe(false);
    expect(names.some((html) => html.includes('Ledger 1'))).toBe(true);
  });

  test('without an account that can sign in it explains and cannot sign', async () => {
    const ctx = await loadCard({
      wallets: [
        {
          index: 5,
          name: 'Team Safe',
          address: '0x1111111111111111111111111111111111111111',
          type: 'safe',
        },
      ],
    });
    await ctx.arrive(challenge());
    expect(ctx.shown()).toBe(true);
    expect(ctx.elements['siwe-signin-error'].textContent).toMatch(/Add an Ethereum account/);
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(true);
  });

  test('a Ledger account names the device on the button and skips the unlock', async () => {
    const ctx = await loadCard({ unlocked: false });
    await ctx.arrive(
      challenge({ rememberedAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' })
    );
    expect(ctx.elements['siwe-signin-account-kind'].textContent).toBe('Ledger');
    expect(ctx.elements['siwe-signin-unlock'].classList.contains('hidden')).toBe(true);
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(false);

    let finish;
    global.window.wallet.signMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    ctx.elements['siwe-signin-approve'].dispatch('click', {});
    await settle();
    expect(ctx.elements['siwe-signin-approve'].textContent).toBe('Confirm on your Ledger…');
    expect(ctx.elements['siwe-signin-cancel'].disabled).toBe(true);
    finish({ success: true, signature: '0xsig' });
    await settle();
    expect(ctx.shown()).toBe(false);
  });

  test('a locked vault must be unlocked before signing in', async () => {
    const ctx = await loadCard({ unlocked: false });
    await ctx.arrive(challenge());
    expect(ctx.elements['siwe-signin-unlock'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(true);

    ctx.elements['siwe-signin-password-input'].value = 'hunter2';
    await ctx.click('siwe-signin-password-submit');
    expect(global.window.identity.unlock).toHaveBeenCalledWith('hunter2');
    expect(ctx.elements['siwe-signin-unlock'].classList.contains('hidden')).toBe(true);
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(false);
  });

  test('a challenge from a background tab waits until that tab is shown', async () => {
    const ctx = await loadCard({ activeGuestId: 3 });
    await ctx.arrive(challenge());
    expect(ctx.shown()).toBe(false);
    expect(ctx.electronAPI.siwePrepare).not.toHaveBeenCalled();

    await ctx.switchTo(7);
    expect(ctx.shown()).toBe(true);
  });

  test('switching tabs takes the card away and switching back returns it', async () => {
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    expect(ctx.shown()).toBe(true);

    await ctx.switchTo(3);
    expect(ctx.shown()).toBe(false);
    expect(ctx.electronAPI.siweCancel).not.toHaveBeenCalled();

    await ctx.switchTo(7);
    expect(ctx.shown()).toBe(true);
  });

  test('Cancel tells main and closes the card', async () => {
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    await ctx.click('siwe-signin-cancel');
    expect(ctx.electronAPI.siweCancel).toHaveBeenCalledWith({ id: 'c1' });
    expect(ctx.shown()).toBe(false);
  });

  test('the card closes when its page goes away', async () => {
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    await ctx.closed('c1');
    expect(ctx.shown()).toBe(false);
  });

  test('a page that went away while signing leaves an error and no way to retry', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    ctx.electronAPI.siweComplete.mockResolvedValueOnce({
      success: false,
      code: 'stale',
      error: 'The page changed before you signed in.',
    });
    await ctx.click('siwe-signin-approve');
    expect(ctx.shown()).toBe(true);
    expect(ctx.elements['siwe-signin-error'].textContent).toBe(
      'The page changed before you signed in.'
    );
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(true);
    expect(ctx.elements['siwe-signin-cancel'].disabled).toBe(false);
  });

  test('a signature that fails after another tab was shown takes the card away with its page', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(
      challenge({ rememberedAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' })
    );
    let decline;
    global.window.wallet.signMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          decline = resolve;
        })
    );
    ctx.elements['siwe-signin-approve'].dispatch('click', {});
    await settle();

    // Mid-signature the card stays (a device prompt can't be recalled)…
    await ctx.switchTo(3);
    expect(ctx.shown()).toBe(true);
    // …and when the device declines, it leaves instead of re-arming over tab 3.
    decline({ success: false, error: 'Rejected on the device' });
    await settle();
    expect(ctx.shown()).toBe(false);

    await ctx.switchTo(7);
    expect(ctx.shown()).toBe(true);
  });

  test('a vault that locked while the card was open shows the unlock after a failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    expect(ctx.elements['siwe-signin-unlock'].classList.contains('hidden')).toBe(true);

    global.window.identity.getStatus.mockResolvedValue({ isUnlocked: false });
    global.window.wallet.signMessage.mockResolvedValueOnce({
      success: false,
      error: 'Vault is locked',
    });
    await ctx.click('siwe-signin-approve');

    expect(ctx.elements['siwe-signin-unlock'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(true);
  });

  test('a challenge that arrived under another prompt shows once that prompt is gone', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const ctx = await loadCard();
      const guard = await import('./dapp-prompt-guard.js');
      let otherPromptShowing = true;
      guard.registerDappPrompt(() => otherPromptShowing);

      await ctx.arrive(challenge());
      expect(ctx.shown()).toBe(false);

      otherPromptShowing = false;
      jest.advanceTimersByTime(1000);
      await settle();
      expect(ctx.shown()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a newer challenge that arrived during a failed signature is not lost when the card leaves', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(
      challenge({ rememberedAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' })
    );
    let decline;
    global.window.wallet.signMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          decline = resolve;
        })
    );
    ctx.elements['siwe-signin-approve'].dispatch('click', {});
    await settle();

    await ctx.arrive(challenge({ id: 'c2' }));
    await ctx.switchTo(3);
    decline({ success: false, error: 'Rejected on the device' });
    await settle();
    expect(ctx.shown()).toBe(false);

    await ctx.switchTo(7);
    expect(ctx.shown()).toBe(true);
    // The newer challenge, with its own preselection (the active account).
    expect(ctx.electronAPI.siwePrepare).toHaveBeenLastCalledWith({ id: 'c2', walletIndex: 2 });
  });

  test('a vault check answered after the user picked a Ledger does not lock the Ledger out', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    let answer;
    global.window.identity.getStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    global.window.wallet.signMessage.mockResolvedValueOnce({
      success: false,
      error: 'Vault is locked',
    });
    await ctx.click('siwe-signin-approve');

    await ctx.click('siwe-signin-account-btn');
    ctx.elements['siwe-signin-account-list'].children[2].dispatch('click', {
      stopPropagation() {},
    });
    await settle();
    answer({ isUnlocked: false });
    await settle();

    expect(ctx.elements['siwe-signin-account-name'].textContent).toBe('Ledger 1');
    expect(ctx.elements['siwe-signin-unlock'].classList.contains('hidden')).toBe(true);
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(false);
  });

  test('a request main has closed is never handed to the signer', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    ctx.electronAPI.siweGetChallenge.mockResolvedValueOnce(null);
    await ctx.click('siwe-signin-approve');
    expect(ctx.confirmSigning).not.toHaveBeenCalled();
    expect(global.window.wallet.signMessage).not.toHaveBeenCalled();
    expect(ctx.elements['siwe-signin-error'].textContent).toBe(
      'This sign-in request is no longer open.'
    );
    expect(ctx.elements['siwe-signin-approve'].disabled).toBe(true);
  });

  test('a tab switch while the request is being checked stops the signature', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    let reply;
    ctx.electronAPI.siweGetChallenge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        })
    );
    ctx.elements['siwe-signin-approve'].dispatch('click', {});
    await settle();
    await ctx.switchTo(3);
    reply(challenge());
    await settle();

    expect(ctx.confirmSigning).not.toHaveBeenCalled();
    expect(global.window.wallet.signMessage).not.toHaveBeenCalled();
    expect(ctx.shown()).toBe(false);
    await ctx.switchTo(7);
    expect(ctx.shown()).toBe(true);
  });

  test('a tab switch while the confirmation is being issued stops the signature', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    let issue;
    ctx.confirmSigning.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          issue = resolve;
        })
    );
    ctx.elements['siwe-signin-approve'].dispatch('click', {});
    await settle();
    expect(ctx.confirmSigning).toHaveBeenCalled();
    await ctx.switchTo(3);
    issue({ confirmation: 'token-1' });
    await settle();

    expect(global.window.wallet.signMessage).not.toHaveBeenCalled();
    expect(ctx.shown()).toBe(false);
  });

  test('a newer challenge in the same tab replaces the card', async () => {
    const ctx = await loadCard();
    await ctx.arrive(challenge());
    await ctx.arrive(challenge({ id: 'c2', statement: 'Again' }));
    expect(ctx.shown()).toBe(true);
    expect(ctx.electronAPI.siwePrepare).toHaveBeenLastCalledWith({ id: 'c2', walletIndex: 2 });
  });
});
