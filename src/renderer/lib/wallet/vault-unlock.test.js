/**
 * The vault unlock screen renders main's `vault.unlock` prompt (freedom-core
 * design 0011, PRQ-5a): a page's request under a site's rule found the vault
 * locked. The unlock itself stays in the chrome until APS-2; the screen
 * answers the handle once the vault is unlocked, or with a rejection.
 */

const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const IDS = [
  'sidebar-vault-unlock',
  'vault-unlock-site',
  'vault-unlock-back',
  'vault-unlock-cancel',
  'vault-unlock-touchid-btn',
  'vault-unlock-password-link',
  'vault-unlock-password-section',
  'vault-unlock-password-input',
  'vault-unlock-password-submit',
  'vault-unlock-error',
];
const SITE = { key: 'https://app.example', label: 'https://app.example' };

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

async function load() {
  jest.resetModules();
  const elements = Object.fromEntries(IDS.map((id) => [id, createElement('button')]));
  elements['sidebar-vault-unlock'].classList.add('hidden');
  global.document = createDocument({ elementsById: elements });
  const decisions = [];
  const unlock = jest.fn(async (password) => (password === 'right' ? { success: true } : { success: false, error: 'Incorrect password' }));
  global.window = {
    pagePrompts: {
      decide: jest.fn(async (handle, approve, choices) => {
        decisions.push({ handle, approve, choices });
        return { ok: true };
      }),
    },
    identity: { unlock, getVaultMeta: jest.fn(async () => ({ userKnowsPassword: true })) },
    quickUnlock: { canUseTouchId: jest.fn(async () => false), isEnabled: jest.fn(async () => false) },
  };
  const identityView = createElement('div');
  const hiders = [];
  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView },
    registerScreenHider: jest.fn((fn) => hiders.push(fn)),
    hideAllSubscreens: jest.fn(() => hiders.forEach((fn) => fn())),
  }));
  jest.doMock('../sidebar.js', () => ({ open: jest.fn() }));
  const mod = await import('./vault-unlock.js');
  mod.initVaultUnlock();
  const renderer = require('../page-prompt-renderers.js').pagePromptRenderer('vault.unlock');
  const show = (handle = 'h1') => renderer.show({ handle, guest: 3, kind: 'vault.unlock', site: SITE, view: { reason: 'sign' } });
  const showing = () => !elements['sidebar-vault-unlock'].classList.contains('hidden');
  return { mod, elements, decisions, unlock, renderer, show, showing, hiders };
}

describe('vault unlock: main\'s prompt (0011 PRQ-5a)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test("it shows main's site, and answers the handle once the vault is unlocked", async () => {
    const env = await load();
    env.show();
    await flush();
    expect(env.showing()).toBe(true);
    expect(env.renderer.isShowing()).toBe('h1');
    expect(env.elements['vault-unlock-site'].textContent).toBe(SITE.label);
    env.elements['vault-unlock-password-input'].value = 'wrong';
    env.elements['vault-unlock-password-submit'].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([]);
    expect(env.showing()).toBe(true);
    env.elements['vault-unlock-password-input'].value = 'right';
    env.elements['vault-unlock-password-submit'].dispatch('click');
    await flush();
    expect(env.unlock).toHaveBeenLastCalledWith('right');
    expect(env.decisions).toEqual([{ handle: 'h1', approve: true, choices: {} }]);
    expect(env.showing()).toBe(false);
  });

  test.each(['vault-unlock-cancel', 'vault-unlock-back'])('%s answers the handle with a rejection', async (id) => {
    const env = await load();
    env.show();
    await flush();
    env.elements[id].dispatch('click');
    await flush();
    expect(env.decisions).toEqual([{ handle: 'h1', approve: false, choices: {} }]);
    expect(env.showing()).toBe(false);
  });

  test('main hiding it takes it down with no decision', async () => {
    const env = await load();
    env.show();
    await flush();
    expect(env.renderer.close('h1')).toBe(true);
    expect(env.showing()).toBe(false);
    expect(env.decisions).toEqual([]);
    expect(env.renderer.close('h1')).toBe(false);
  });

  test('another screen hiding it reports it displaced, undecided', async () => {
    const env = await load();
    const displaced = [];
    require('../page-prompt-renderers.js').onPagePromptDisplaced((handle) => displaced.push(handle));
    env.show();
    await flush();
    env.hiders.forEach((fn) => fn());
    expect(displaced).toEqual(['h1']);
    expect(env.decisions).toEqual([]);
  });

  test("an unlock on the chrome's own path gives way to main's", async () => {
    const env = await load();
    const old = env.mod.showVaultUnlock('https://other.example');
    const outcome = old.then(
      () => 'resolved',
      (err) => err
    );
    env.show();
    expect(await outcome).toEqual({ code: 4001, message: 'Superseded by new unlock request' });
    expect(env.elements['vault-unlock-site'].textContent).toBe(SITE.label);
  });
});
