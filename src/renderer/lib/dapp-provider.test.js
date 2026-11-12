'use strict';

// The visible tab's site, for the chrome's connection banners. A page's
// requests never reach the chrome (freedom-core design 0011): main answers
// them, so this module only reports which site the banners describe.

const loadModule = async ({ committed = new Map(), knownEnsNames = new Map() } = {}) => {
  jest.resetModules();
  const walletUi = {
    updateConnectionBanner: jest.fn(),
    updateSwarmConnectionBanner: jest.fn(),
    updateX402ConnectionBanner: jest.fn(),
  };
  jest.doMock('./wallet-ui.js', () => walletUi);
  jest.doMock('./state.js', () => ({ state: { knownEnsNames } }));
  jest.doMock('./tabs.js', () => ({
    getDisplayUrlForWebview: jest.fn((wv) => committed.get(wv) ?? ''),
  }));
  const mod = await import('./dapp-provider.js');
  return { mod, walletUi };
};

// A tab's webview with `url` committed (its tab's committedDisplayUrl).
const webviewAt = (committed, url) => {
  const wv = { getURL: jest.fn(() => url) };
  committed.set(wv, url);
  return wv;
};

describe('dapp-provider: the visible tab\'s site', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('nothing is visible before tabs.js reports a tab', async () => {
    const { mod } = await loadModule();
    expect(mod.getActiveDisplayUrl()).toBe('');
    expect(mod.getActivePageUrl()).toBe('');
  });

  test('getActiveDisplayUrl reads the visible tab’s committed page, not the address bar', async () => {
    const committed = new Map();
    const { mod } = await loadModule({ committed });
    const visible = webviewAt(committed, 'https://trusted-dapp.example');
    const background = webviewAt(committed, 'https://attacker.example');

    mod.setActiveWebview(visible);
    expect(mod.getActiveDisplayUrl()).toBe('https://trusted-dapp.example');
    mod.setActiveWebview(background);
    expect(mod.getActiveDisplayUrl()).toBe('https://attacker.example');
  });

  test('a DNS-named ENS site over IPNS is keyed on its name; the page URL keeps its key', async () => {
    const B58 = '12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX';
    const B36 = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
    const committed = new Map();
    const knownEnsNames = new Map([[B58, 'example.com']]);
    const { mod } = await loadModule({ committed, knownEnsNames });
    const ipnsTab = webviewAt(committed, `ipns://${B36}/`);

    mod.setActiveWebview(ipnsTab);
    expect(mod.getActiveDisplayUrl()).toBe('ens://example.com/');
    expect(mod.getActivePageUrl()).toBe(`ipns://${B36}/`);
  });

  test('an onchain app is identified by its own app URL', async () => {
    const committed = new Map();
    const { mod } = await loadModule({ committed });
    const app = webviewAt(committed, 'web3://0x00000095643cffa7d9fae407a84dfcb6406456c6:100/');

    mod.setActiveWebview(app);
    expect(mod.getActiveDisplayUrl()).toMatch(/^web3:\/\/0x00000095643cffa7d9fae407a84dfcb6406456c6/);
  });

  test('a tab switch repaints the three connection banners', async () => {
    jest.useFakeTimers();
    const committed = new Map();
    const { mod, walletUi } = await loadModule({ committed });

    mod.setActiveWebview(webviewAt(committed, 'https://app.example'));
    expect(walletUi.updateConnectionBanner).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    expect(walletUi.updateConnectionBanner).toHaveBeenCalledTimes(1);
    expect(walletUi.updateSwarmConnectionBanner).toHaveBeenCalledTimes(1);
    expect(walletUi.updateX402ConnectionBanner).toHaveBeenCalledTimes(1);
  });
});
