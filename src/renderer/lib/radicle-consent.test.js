/**
 * Tests for the Radicle consent subscreen — specifically the owner binding:
 * a pending prompt is owned by the webview whose document requested it, and
 * dismissRadicleConsent(owner) rejects it only for that owner (used when the
 * requesting document navigates away or its tab closes).
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalDocument = global.document;

const loadConsent = async () => {
  jest.resetModules();

  const walletStateMocks = {
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
    walletState: { identityView: createElement('div') },
  };
  const sidebarMocks = {
    openForConsent: jest.fn(),
    close: jest.fn(),
    isVisible: jest.fn(() => false),
  };

  const elementsById = {
    'sidebar-radicle-consent': createElement('div', { classes: ['hidden'] }),
    'radicle-consent-title': createElement('h2'),
    'radicle-consent-site': createElement('div'),
    'radicle-consent-wants': createElement('div'),
    'radicle-consent-allows': createElement('ul'),
    'radicle-consent-warning': createElement('p'),
    'radicle-consent-approve': createElement('button'),
    'radicle-consent-reject': createElement('button'),
    'radicle-consent-back': createElement('button'),
  };

  global.document = createDocument({ elementsById });

  jest.doMock('./wallet/wallet-state.js', () => walletStateMocks);
  jest.doMock('./sidebar.js', () => sidebarMocks);

  const mod = await import('./radicle-consent.js');
  mod.initRadicleConsent();

  return { mod, elementsById, sidebarMocks };
};

describe('radicle-consent owner binding', () => {
  afterEach(() => {
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('dismissRadicleConsent(owner) rejects the pending prompt of that owner', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');

    const promptPromise = mod.showRadicleConnect('https://app.example', owner);
    mod.dismissRadicleConsent(owner);

    await expect(promptPromise).rejects.toEqual({
      code: 4001,
      message: 'User rejected the request',
    });
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(true);
  });

  test('dismissRadicleConsent with a different owner is a no-op', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');
    const otherWebview = createElement('webview');

    const promptPromise = mod.showRadicleSigningApproval('https://app.example', owner);
    let settled = false;
    promptPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    mod.dismissRadicleConsent(otherWebview);
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(false);

    // Approval still works afterwards — the prompt was untouched.
    elementsById['radicle-consent-approve'].dispatch('click');
    await expect(promptPromise).resolves.toBeUndefined();
  });

  test('dismissRadicleConsent without a pending prompt is a no-op', async () => {
    const { mod } = await loadConsent();
    expect(() => mod.dismissRadicleConsent(createElement('webview'))).not.toThrow();
  });
});
