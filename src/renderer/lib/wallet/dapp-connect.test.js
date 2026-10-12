/**
 * Tests for the dApp Connect prompt: one approval at a time across the
 * wallet's dApp prompts (dapp-approval-slot.js).
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const DAPP_CONNECT_ELEMENT_IDS = [
  'address-input',
  'dapp-auto-approve-badge',
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
];

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadDappConnect() {
  jest.resetModules();

  const elementsById = Object.fromEntries(
    DAPP_CONNECT_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  // As in index.html: the prompt starts hidden.
  elementsById['sidebar-dapp-connect'].classList.add('hidden');
  global.document = createDocument({ elementsById });

  const grantPermission = jest.fn().mockResolvedValue({ success: true });
  global.window = {
    dappPermissions: {
      grantPermission,
      getPermission: jest.fn().mockResolvedValue(null),
    },
  };

  jest.doMock('./wallet-state.js', () => ({
    walletState: {
      identityView: createElement('div'),
      activeWalletIndex: 0,
      selectedChainId: 100,
      derivedWallets: [{ index: 0, name: 'Main', address: '0x1111111111111111111111111111111111111111' }],
    },
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
  }));
  jest.doMock('./wallet-utils.js', () => ({
    escapeHtml: jest.fn((text) => text),
    isSafeAccount: jest.fn(() => false),
    isSafeDeployed: jest.fn(() => true),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn(), isVisible: jest.fn(() => true) }));
  jest.doMock('../dapp-provider.js', () => ({
    getActiveWebview: jest.fn(() => null),
    emitAccountsChanged: jest.fn(),
    getPermissionKey: jest.fn((url) => url),
  }));
  jest.doMock('./permission-manage.js', () => ({ showDappPermissions: jest.fn() }));
  jest.doMock('../url-utils.js', () => ({ parseOnchainAppUrl: jest.fn(() => null) }));

  const mod = await import('./dapp-connect.js');
  mod.initDappConnect();
  const slot = await import('./dapp-approval-slot.js');

  function openConnect(site) {
    const settled = { state: 'pending' };
    mod.showDappConnect(
      site,
      site,
      (value) => Object.assign(settled, { state: 'resolved', value }),
      (value) => Object.assign(settled, { state: 'rejected', value }),
      { send: jest.fn() }
    );
    // Revealed, as the real screen is once shown.
    elementsById['sidebar-dapp-connect'].classList.remove('hidden');
    return settled;
  }

  const hideForOtherScreen = () => require('./wallet-state.js').registerScreenHider.mock.calls[0][0]();

  return { elements: elementsById, grantPermission, openConnect, hideForOtherScreen, slot };
}

describe('dapp-connect approval slot', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a newcomer never replaces the site on screen', async () => {
    const { elements, grantPermission, openConnect, slot } = await loadDappConnect();
    const first = openConnect('https://app.example');
    expect(slot.isDappApprovalPending()).toBe(true);

    const second = openConnect('https://other.example');
    expect(second).toMatchObject({ state: 'rejected', value: { code: -32002 } });
    expect(elements['dapp-connect-site'].textContent).toBe('https://app.example');

    // Connect grants what was shown.
    elements['dapp-connect-approve'].dispatch('click');
    await flush();
    expect(grantPermission.mock.calls[0][0]).toBe('https://app.example');
    expect(first.state).toBe('resolved');
    expect(slot.isDappApprovalPending()).toBe(false);
  });

  test('reject frees the slot', async () => {
    const { elements, openConnect, slot } = await loadDappConnect();
    const first = openConnect('https://app.example');

    elements['dapp-connect-reject'].dispatch('click');
    await flush();
    expect(first).toMatchObject({ state: 'rejected', value: { code: 4001 } });
    expect(slot.isDappApprovalPending()).toBe(false);
  });

  test('a prompt another screen hides is rejected and frees the slot', async () => {
    const { openConnect, hideForOtherScreen, slot } = await loadDappConnect();
    const first = openConnect('https://app.example');

    hideForOtherScreen();
    expect(first).toMatchObject({ state: 'rejected', value: { code: 4001 } });
    expect(slot.isDappApprovalPending()).toBe(false);
    expect(openConnect('https://app.example').state).toBe('pending');
  });

  test('a screen opening while the grant is written does not reject it', async () => {
    const { elements, grantPermission, openConnect, hideForOtherScreen } = await loadDappConnect();
    let finishGrant;
    grantPermission.mockReturnValueOnce(new Promise((resolve) => (finishGrant = resolve)));
    const first = openConnect('https://app.example');

    elements['dapp-connect-approve'].dispatch('click');
    await flush();
    hideForOtherScreen();
    finishGrant({ success: true });
    await flush();
    expect(first.state).toBe('resolved');
  });
});
