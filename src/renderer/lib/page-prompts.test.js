/**
 * The chrome's side of main's page prompts (freedom-core design 0011, "The
 * prompt protocol", before APS; PRQ-4): it renders what main shows, answers
 * that handle alone, and keeps the badges and the count on main's open
 * handles. The real dApp Connect screen renders the prompt here.
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SAFE = '0x3333333333333333333333333333333333333333';
const SITE = { key: `bzz://${'a'.repeat(64)}`, label: `bzz://${'a'.repeat(64)}` };
const VIEW = {
  accounts: [
    { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
    { index: 1000, name: 'Team Safe', address: SAFE, type: 'safe' },
  ],
  defaultIndex: 1000,
  chain: { id: 100, name: 'Gnosis Chain' },
};

const ELEMENT_IDS = [
  'dapp-connect-approve',
  'dapp-connect-back',
  'dapp-connect-favicon',
  'dapp-connect-icon',
  'dapp-connection-banner',
  'dapp-connection-disconnect',
  'dapp-connection-manage',
  'dapp-connection-site',
  'dapp-connection-wallet',
  'dapp-connect-reject',
  'dapp-connect-safe-note',
  'dapp-connect-site',
  'dapp-connect-wallet-address',
  'dapp-connect-wallet-btn',
  'dapp-connect-wallet-dropdown',
  'dapp-connect-wallet-list',
  'dapp-connect-wallet-name',
  'dapp-connect-wallet-selector',
  'sidebar-dapp-connect',
  'wallet-prompt-count',
];

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

async function load() {
  jest.resetModules();
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, createElement('button')]));
  elements['sidebar-dapp-connect'].classList.add('hidden');
  elements['wallet-prompt-count'].classList.add('hidden');
  global.document = createDocument({ elementsById: elements });

  const listeners = {};
  const decisions = [];
  let answerDecision = () => ({ ok: true });
  const grantPermission = jest.fn();
  const getCachedFavicon = jest.fn(async () => 'data:image/png;base64,AAAA');
  global.window = {
    pagePrompts: {
      onPending: (fn) => (listeners.pending = fn),
      onPrompt: (fn) => (listeners.prompt = fn),
      onHidden: (fn) => (listeners.hidden = fn),
      onClosed: (fn) => (listeners.closed = fn),
      decide: jest.fn(async (handle, approve, choices) => {
        decisions.push({ handle, approve, choices });
        return answerDecision(handle, approve, choices);
      }),
    },
    dappPermissions: { grantPermission, getPermission: jest.fn(async () => null) },
    electronAPI: { getCachedFavicon },
  };

  const identityView = createElement('div');
  const hiders = [];
  let inFlight = false;
  jest.doMock('./wallet/wallet-state.js', () => ({
    walletState: { identityView, activeWalletIndex: 0, selectedChainId: 100, derivedWallets: [] },
    registerScreenHider: jest.fn((fn) => hiders.push(fn)),
    hideAllSubscreens: jest.fn(() => hiders.forEach((fn) => fn())),
  }));
  jest.doMock('./wallet/signature-flight.js', () => ({
    isSignatureInFlight: () => inFlight,
    signatureInFlightError: () => Object.assign(new Error('in flight'), { code: -32002 }),
  }));
  jest.doMock('./wallet/wallet-utils.js', () => ({
    escapeHtml: (text) => text,
    isSafeAccount: () => false,
    isSafeDeployed: () => true,
  }));
  const sidebar = { open: jest.fn(), isVisible: jest.fn(() => true) };
  jest.doMock('./sidebar.js', () => sidebar);
  jest.doMock('./dapp-provider.js', () => ({
    getActiveWebview: () => null,
    getActiveDisplayUrl: () => '',
    getPermissionKey: (url) => url || null,
    emitAccountsChanged: jest.fn(),
    getNavigationGeneration: () => 0,
  }));
  jest.doMock('./wallet/permission-manage.js', () => ({ showDappPermissions: jest.fn() }));
  jest.doMock('./url-utils.js', () => ({ parseOnchainAppUrl: () => null }));
  const tabs = { setWalletPromptCounts: jest.fn() };
  jest.doMock('./tabs.js', () => tabs);

  const connect = await import('./wallet/dapp-connect.js');
  connect.initDappConnect();
  const guard = await import('./wallet/dapp-prompt-guard.js');
  const prompts = await import('./page-prompts.js');
  prompts.initPagePrompts();

  // Another approval screen of the chrome's own path (a signature), which
  // holds the sidebar while it shows.
  const other = { showing: false };
  guard.registerDappPrompt(() => other.showing);

  const screen = elements['sidebar-dapp-connect'];
  const showing = () => !screen.classList.contains('hidden');
  const otherScreenTakesOver = () => {
    other.showing = true;
    identityView.classList.add('hidden');
    hiders.forEach((fn) => fn());
  };
  const otherScreenDone = () => {
    other.showing = false;
    identityView.classList.remove('hidden');
  };
  return {
    elements,
    listeners,
    decisions,
    setAnswer: (fn) => (answerDecision = fn),
    grantPermission,
    getCachedFavicon,
    sidebar,
    tabs,
    identityView,
    showing,
    other,
    otherScreenTakesOver,
    otherScreenDone,
    setInFlight: (value) => (inFlight = value),
  };
}

const prompt = (handle, guest = 3) => ({ handle, guest, kind: 'eth.connect', site: SITE, view: VIEW });

describe('page prompts in the chrome (0011 PRQ-4)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('the badges and the count follow open handles until page:prompt-closed', async () => {
    const env = await load();
    const count = env.elements['wallet-prompt-count'];
    env.listeners.pending({ handle: 'h1', guest: 3 });
    env.listeners.pending({ handle: 'h2', guest: 4 });
    env.listeners.pending({ handle: 'h3', guest: 4 });
    expect([...env.tabs.setWalletPromptCounts.mock.calls.at(-1)[0]]).toEqual([
      [3, 1],
      [4, 2],
    ]);
    expect(count.textContent).toBe('3');
    expect(count.classList.contains('hidden')).toBe(false);
    env.listeners.closed({ handle: 'h2', reason: 'expired' });
    env.listeners.closed({ handle: 'h1', reason: 'navigated' });
    expect([...env.tabs.setWalletPromptCounts.mock.calls.at(-1)[0]]).toEqual([[4, 1]]);
    expect(count.textContent).toBe('1');
    env.listeners.closed({ handle: 'h3', reason: 'decided' });
    expect(count.classList.contains('hidden')).toBe(true);
    // A malformed message changes nothing.
    env.listeners.pending({ handle: 5, guest: 'x' });
    expect(count.classList.contains('hidden')).toBe(true);
  });

  test('a prompt main shows renders main\'s site and accounts, with no favicon, and opens the sidebar', async () => {
    const env = await load();
    env.listeners.pending({ handle: 'h1', guest: 3 });
    expect(env.showing()).toBe(false);
    env.listeners.prompt(prompt('h1'));
    expect(env.showing()).toBe(true);
    expect(env.elements['dapp-connect-site'].textContent).toBe(SITE.label);
    expect(env.elements['dapp-connect-wallet-name'].textContent).toBe('Team Safe');
    expect(env.elements['dapp-connect-safe-note'].classList.contains('hidden')).toBe(false);
    expect(env.elements['dapp-connect-icon'].classList.contains('hidden')).toBe(true);
    expect(env.getCachedFavicon).not.toHaveBeenCalled();
    expect(env.sidebar.open).toHaveBeenCalled();
  });

  test('Connect answers the handle with the account picked; the chrome writes no grant', async () => {
    const env = await load();
    env.listeners.prompt(prompt('h1'));
    env.elements['dapp-connect-approve'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: true, choices: { walletIndex: 1000 } }]);
    expect(env.grantPermission).not.toHaveBeenCalled();
    expect(env.showing()).toBe(false);
  });

  test.each(['dapp-connect-reject', 'dapp-connect-back'])('%s answers the handle with a rejection', async (id) => {
    const env = await load();
    env.listeners.prompt(prompt('h1'));
    env.elements[id].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: false, choices: {} }]);
    expect(env.showing()).toBe(false);
  });

  test('a decision main refuses takes the screen down', async () => {
    const env = await load();
    env.setAnswer(() => ({ ok: false, reason: 'not-shown' }));
    env.listeners.prompt(prompt('h1'));
    env.elements['dapp-connect-approve'].dispatch('click');
    await flush();
    expect(env.showing()).toBe(false);
  });

  test('page:prompt-hidden takes it down with no decision, and page:prompt shows it again', async () => {
    const env = await load();
    env.listeners.prompt(prompt('h1'));
    env.listeners.hidden({ handle: 'h1' });
    expect(env.showing()).toBe(false);
    expect(env.decisions).toEqual([]);
    expect(env.identityView.classList.contains('hidden')).toBe(false);
    // Another tab's prompt shows meanwhile, then A's again.
    env.listeners.prompt(prompt('h2', 4));
    expect(env.showing()).toBe(true);
    env.listeners.hidden({ handle: 'h2' });
    env.listeners.prompt(prompt('h1'));
    expect(env.showing()).toBe(true);
    env.elements['dapp-connect-approve'].dispatch('click');
    await flush();
    expect(env.decisions.map((d) => d.handle)).toEqual(['h1']);
  });

  test('page:prompt-closed takes down the prompt it names, and no other', async () => {
    const env = await load();
    env.listeners.prompt(prompt('h1'));
    env.listeners.closed({ handle: 'h9', reason: 'expired' });
    expect(env.showing()).toBe(true);
    env.listeners.closed({ handle: 'h1', reason: 'navigated' });
    expect(env.showing()).toBe(false);
  });

  test('while another approval holds the sidebar, main\'s prompt waits, and shows once the sidebar is free', async () => {
    jest.useFakeTimers();
    const env = await load();
    env.otherScreenTakesOver();
    env.listeners.prompt(prompt('h1'));
    expect(env.showing()).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(env.showing()).toBe(false);
    env.otherScreenDone();
    jest.advanceTimersByTime(300);
    expect(env.showing()).toBe(true);
    expect(env.decisions).toEqual([]);
  });

  test('while a device signature is in flight, main\'s prompt waits', async () => {
    jest.useFakeTimers();
    const env = await load();
    env.setInFlight(true);
    env.listeners.prompt(prompt('h1'));
    jest.advanceTimersByTime(1000);
    expect(env.showing()).toBe(false);
    env.setInFlight(false);
    jest.advanceTimersByTime(300);
    expect(env.showing()).toBe(true);
  });

  test('a prompt another screen takes the sidebar from shows again once that screen is done, still undecided', async () => {
    jest.useFakeTimers();
    const env = await load();
    env.listeners.prompt(prompt('h1'));
    expect(env.showing()).toBe(true);
    env.otherScreenTakesOver();
    expect(env.showing()).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(env.showing()).toBe(false);
    env.otherScreenDone();
    jest.advanceTimersByTime(300);
    expect(env.showing()).toBe(true);
    expect(env.decisions).toEqual([]);
    // Hidden by main meanwhile: it stays down.
    env.otherScreenTakesOver();
    env.listeners.hidden({ handle: 'h1' });
    env.otherScreenDone();
    jest.advanceTimersByTime(1000);
    expect(env.showing()).toBe(false);
  });

  test('a kind the chrome doesn\'t render yet is ignored', async () => {
    const env = await load();
    env.listeners.prompt({ ...prompt('h1'), kind: 'swarm.publish' });
    expect(env.showing()).toBe(false);
  });

  // PRQ-5a: the signing, unlock and board screens register themselves.
  test('a kind a screen registered shows there, comes down when main hides it, and shows again once displaced', async () => {
    jest.useFakeTimers();
    const env = await load();
    const registry = await import('./page-prompt-renderers.js');
    let current = null;
    const screen = {
      show: jest.fn((p) => (current = p.handle)),
      close: jest.fn((handle) => {
        if (current === handle) current = null;
        return true;
      }),
      isShowing: () => current,
    };
    registry.registerPagePromptRenderer('eth.sign', screen);
    env.listeners.prompt({ ...prompt('h1'), kind: 'eth.sign' });
    expect(screen.show).toHaveBeenCalledTimes(1);
    expect(env.showing()).toBe(false);
    // Another screen takes the sidebar: it shows again once that is done.
    current = null;
    env.otherScreenTakesOver();
    registry.pagePromptDisplaced('h1');
    jest.advanceTimersByTime(1000);
    expect(screen.show).toHaveBeenCalledTimes(1);
    env.otherScreenDone();
    jest.advanceTimersByTime(300);
    expect(screen.show).toHaveBeenCalledTimes(2);
    env.listeners.hidden({ handle: 'h1' });
    expect(screen.close).toHaveBeenCalledWith('h1');
    expect(current).toBeNull();
  });
});
