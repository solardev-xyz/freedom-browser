/**
 * The sidebar's Radicle banner and Radicle Permissions screen: the chrome's
 * way to switch a site's "always allow writes" rule (autoApprove.signing,
 * R-6) off at any time, without waiting for the rate limiter to raise a
 * fallback prompt. Driven from the real triggers (banner click, toggle
 * change) against a stateful stand-in for main's permission store.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const ORIGIN = 'https://forge.example';

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const ELEMENT_IDS = [
  'radicle-connection-banner',
  'radicle-connection-site',
  'radicle-auto-approve-badge',
  'radicle-connection-manage',
  'radicle-connection-disconnect',
  'sidebar-radicle-permissions',
  'radicle-perms-back',
  'radicle-perms-site',
  'radicle-perms-writes-toggle',
  'radicle-perms-writes-note',
  'radicle-perms-disconnect',
  'sidebar-setup-cta',
];

async function load({ viewMode = 'identity', activeUrl = ORIGIN, rule = true } = {}) {
  jest.resetModules();

  const elementsById = Object.fromEntries(ELEMENT_IDS.map((id) => [id, createElement('div')]));
  for (const id of [
    'radicle-connection-banner',
    'sidebar-radicle-permissions',
    'radicle-auto-approve-badge',
  ]) {
    elementsById[id].classList.add('hidden');
  }
  if (viewMode !== 'setup') elementsById['sidebar-setup-cta'].classList.add('hidden');
  const identityView = createElement('div');
  if (viewMode !== 'identity') identityView.classList.add('hidden');

  global.document = createDocument({ elementsById });

  const store = {
    [ORIGIN]: { origin: ORIGIN, signing: true, autoApprove: { node: false, signing: rule } },
  };
  global.window = {
    radiclePermissions: {
      getPermission: jest.fn(async (key) => (store[key] ? structuredClone(store[key]) : null)),
      getAutoApprove: jest.fn(async (key, type) => store[key]?.autoApprove?.[type] === true),
      setAutoApprove: jest.fn(async (key, type, enabled) => {
        if (!store[key]) return false;
        store[key].autoApprove[type] = enabled === true;
        return true;
      }),
    },
  };

  const state = { activeUrl };
  const hideAllSubscreens = jest.fn();
  const registerScreenHider = jest.fn();
  const openSidebarPanel = jest.fn();
  const disconnectRadicleSite = jest.fn(async (key) => {
    delete store[key];
  });

  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView, viewMode },
    hideAllSubscreens,
    registerScreenHider,
  }));
  jest.doMock('./signature-flight.js', () => ({ isSignatureInFlight: () => false }));
  jest.doMock('../sidebar.js', () => ({ open: openSidebarPanel, isVisible: () => true }));
  jest.doMock('../dapp-provider.js', () => ({
    getPermissionKey: (url) => url || null,
    getActivePageUrl: () => state.activeUrl,
  }));
  jest.doMock('../radicle-provider.js', () => ({ disconnectRadicleSite }));

  const mod = await import('./radicle-connection.js');
  mod.initRadicleConnection();

  const el = (id) => elementsById[id];
  const fireDocument = async (event, payload = {}) => {
    global.document.handlers[event]?.(payload);
    await flush();
  };
  const openFromBanner = async () => {
    await fireDocument('sidebar-opened');
    el('radicle-connection-manage').dispatch('click');
    await flush();
  };
  const switchToggle = async (checked) => {
    el('radicle-perms-writes-toggle').checked = checked;
    el('radicle-perms-writes-toggle').dispatch('change');
    await flush();
  };

  return {
    mod,
    el,
    store,
    state,
    identityView,
    hideAllSubscreens,
    registerScreenHider,
    openSidebarPanel,
    disconnectRadicleSite,
    fireDocument,
    openFromBanner,
    switchToggle,
  };
}

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
  jest.restoreAllMocks();
});

describe('Radicle connection banner', () => {
  test('shows the visible tab\'s connected site, with "auto" while the writes rule is on', async () => {
    const t = await load();
    await t.fireDocument('sidebar-opened');
    expect(t.el('radicle-connection-banner').classList.contains('hidden')).toBe(false);
    expect(t.el('radicle-connection-site').textContent).toBe(ORIGIN);
    expect(t.el('radicle-auto-approve-badge').classList.contains('hidden')).toBe(false);
  });

  test('stays hidden for a site that is not connected', async () => {
    const t = await load({ activeUrl: 'https://other.example' });
    await t.fireDocument('sidebar-opened');
    expect(t.el('radicle-connection-banner').classList.contains('hidden')).toBe(true);
  });

  test('a prompt changing the rule repaints the badge', async () => {
    const t = await load();
    await t.fireDocument('sidebar-opened');
    t.store[ORIGIN].autoApprove.signing = false;
    await t.fireDocument('radicle-permissions-changed', { detail: { origin: ORIGIN } });
    expect(t.el('radicle-auto-approve-badge').classList.contains('hidden')).toBe(true);
  });
});

describe('Radicle Permissions screen', () => {
  test('clicking the banner opens it with the writes rule shown on', async () => {
    const t = await load();
    await t.openFromBanner();
    expect(t.hideAllSubscreens).toHaveBeenCalled();
    expect(t.openSidebarPanel).toHaveBeenCalled();
    expect(t.el('sidebar-radicle-permissions').classList.contains('hidden')).toBe(false);
    expect(t.identityView.classList.contains('hidden')).toBe(true);
    expect(t.el('radicle-perms-site').textContent).toBe(ORIGIN);
    expect(t.el('radicle-perms-writes-toggle').checked).toBe(true);
    expect(t.el('radicle-perms-writes-note').textContent).toMatch(/^On:/);
  });

  test('switching the toggle off turns the rule off in main', async () => {
    const t = await load();
    await t.openFromBanner();
    await t.switchToggle(false);

    expect(window.radiclePermissions.setAutoApprove).toHaveBeenCalledWith(ORIGIN, 'signing', false);
    expect(t.store[ORIGIN].autoApprove.signing).toBe(false);
    // The connection and the signing grant stay; only the rule goes.
    expect(t.store[ORIGIN].signing).toBe(true);
    expect(t.el('radicle-perms-writes-toggle').checked).toBe(false);
    expect(t.el('radicle-perms-writes-note').textContent).toMatch(/^Off:/);
    expect(t.el('radicle-auto-approve-badge').classList.contains('hidden')).toBe(true);
    expect(t.el('radicle-perms-writes-toggle').disabled).toBe(false);
  });

  test('a failed save never shows "off" over a rule that is still on', async () => {
    const t = await load();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    window.radiclePermissions.setAutoApprove.mockRejectedValueOnce(new Error('ipc down'));
    await t.openFromBanner();
    await t.switchToggle(false);

    expect(t.store[ORIGIN].autoApprove.signing).toBe(true);
    expect(t.el('radicle-perms-writes-toggle').checked).toBe(true);
    expect(t.el('radicle-perms-writes-note').textContent).toMatch(/^On:/);
    expect(t.el('radicle-auto-approve-badge').classList.contains('hidden')).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  test("switching it back on is the user's choice too", async () => {
    const t = await load({ rule: false });
    await t.openFromBanner();
    expect(t.el('radicle-perms-writes-toggle').checked).toBe(false);
    await t.switchToggle(true);
    expect(t.store[ORIGIN].autoApprove.signing).toBe(true);
    expect(t.el('radicle-perms-writes-toggle').checked).toBe(true);
  });

  test('reachable without a wallet: Back returns to the set-up view', async () => {
    const t = await load({ viewMode: 'setup' });
    await t.openFromBanner();
    expect(t.el('sidebar-setup-cta').classList.contains('hidden')).toBe(true);
    await t.switchToggle(false);
    expect(t.store[ORIGIN].autoApprove.signing).toBe(false);

    t.el('radicle-perms-back').dispatch('click');
    expect(t.el('sidebar-radicle-permissions').classList.contains('hidden')).toBe(true);
    expect(t.el('sidebar-setup-cta').classList.contains('hidden')).toBe(false);
    expect(t.identityView.classList.contains('hidden')).toBe(true);
  });

  test('a rule change from a prompt while the screen is open repaints the toggle', async () => {
    const t = await load();
    await t.openFromBanner();
    t.store[ORIGIN].autoApprove.signing = false;
    await t.fireDocument('radicle-permissions-changed', { detail: { origin: ORIGIN } });
    expect(t.el('radicle-perms-writes-toggle').checked).toBe(false);
  });

  test("Disconnect goes through main's radicle_disconnect and closes the screen", async () => {
    const t = await load();
    await t.openFromBanner();
    t.el('radicle-perms-disconnect').dispatch('click');
    await flush();
    expect(t.disconnectRadicleSite).toHaveBeenCalledWith(ORIGIN);
    expect(t.el('sidebar-radicle-permissions').classList.contains('hidden')).toBe(true);
    expect(t.identityView.classList.contains('hidden')).toBe(false);
    expect(t.el('radicle-connection-banner').classList.contains('hidden')).toBe(true);
  });

  test("the banner's × disconnects too", async () => {
    const t = await load();
    await t.fireDocument('sidebar-opened');
    t.el('radicle-connection-disconnect').dispatch('click');
    await flush();
    expect(t.disconnectRadicleSite).toHaveBeenCalledWith(ORIGIN);
    expect(t.el('radicle-connection-banner').classList.contains('hidden')).toBe(true);
  });

  test('the toggle\'s "50 writes a day" matches main\'s limit', () => {
    const fs = require('fs');
    const path = require('path');
    const { LIMITS } = require('../../../main/radicle/auto-write-limiter.js');
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
    expect(html).toMatch(
      new RegExp(`Always allow writes as you \\(at most ${LIMITS.DAILY_MAX} writes a day\\)`)
    );
  });
});
