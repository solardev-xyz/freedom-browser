// #764: a dApp request is attributed to the tab that sent it, not to the
// site in the address bar. With a trusted dApp in the visible tab — connected
// and set to auto-approve signatures — a page in a background tab must not
// get its account, its auto-approve rules, or a prompt carrying its name.
//
// Two real tabs, two harness-served bzz:// pages, a real (pre-seeded) vault
// and the real main-process wallet handlers. From freedom-core design 0011
// PRQ-5a main attests the requester and reads the site's rule itself, so
// the chrome's claim of a site's rule is refused outright, and a background
// tab's signing prompt waits for its tab.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');

const repoRoot = path.resolve(__dirname, '..');
// The JS identity stack is the core's now; its frozen reference writes the
// vault the core reads (as the other wallet fixtures do).
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Attribution-2026!';
const TRUSTED_URL = `bzz://${'a'.repeat(64)}/`;
const TRUSTED_KEY = `bzz://${'a'.repeat(64)}`;
const OTHER_URL = `bzz://${'b'.repeat(64)}/`;
const OTHER_KEY = `bzz://${'b'.repeat(64)}`;
const MESSAGE = '0x' + Buffer.from('freedom #764', 'utf8').toString('hex');

const test = base.extend({
  // The base app plus a vault with one account, so signing really happens
  // (or really doesn't) in main.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-attr-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const identityDir = path.join(tmpRoot, 'identity');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        enableIdentityWallet: true,
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableRadicleIntegration: false,
      }),
      'utf-8'
    );
    const mnemonic = await identity.createVault(identityDir, VAULT_PASSWORD);
    const keys = identity.deriveAllKeys(mnemonic);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({
        addresses: { userWallet: keys.userWallet.address },
        activeWalletIndex: 0,
        derivedWallets: [{ index: 0, name: 'Main Wallet', address: keys.userWallet.address }],
      }),
      'utf-8'
    );

    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_IDENTITY_DATA: identityDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });
    await use(app);
    await closeApp(app);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },
});

/** Run `script` in the tab whose webview has `url` committed. */
function inTab(win, url, script) {
  return win.evaluate(
    async ({ url: u, js }) => {
      const wv = [...document.querySelectorAll('webview')].find((w) => {
        try {
          return w.getURL() === u;
        } catch {
          return false;
        }
      });
      if (!wv) return null;
      try {
        return await wv.executeJavaScript(js);
      } catch {
        return null;
      }
    },
    { url, js: script }
  );
}

/** Fire a provider request in that tab; the outcome lands on window.__r[id]. */
function request(win, url, id, method, params = []) {
  return inTab(
    win,
    url,
    `
    window.__r = window.__r || {};
    window.__r[${JSON.stringify(id)}] = 'pending';
    window.ethereum.request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })
      .then((v) => { window.__r[${JSON.stringify(id)}] = { ok: v }; })
      .catch((e) => { window.__r[${JSON.stringify(id)}] = { code: e?.code, message: String(e?.message || e) }; });
    true
  `
  );
}

const outcome = (win, url, id) => inTab(win, url, `window.__r && window.__r[${JSON.stringify(id)}]`);

// A connection, written in main as main writes one (freedom-core design
// 0011, PRQ-4): the chrome's own grant write is refused.
const grant = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    process.mainModule.require(`${args.root}/src/main/wallet/dapp-permissions`).grantPermission(args.key, 0, 100);
  }, { root: repoRoot, key });
// A site's signing rule, as main sets it from a prompt's "always allow"
// (PRQ-5a): the chrome may only clear one.
const signingRule = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    process.mainModule.require(`${args.root}/src/main/wallet/dapp-permissions`).setSigningAutoApprove(args.key, true);
  }, { root: repoRoot, key });

async function openIn(win, url) {
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(url);
  await address.press('Enter');
  await expect
    .poll(() => inTab(win, url, 'Boolean(window.ethereum?.request)'), { timeout: 30_000 })
    .toBe(true);
}

test('a background tab is attributed to its own site, never the visible one', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  for (const [url, title] of [[TRUSTED_URL, 'trusted dapp'], [OTHER_URL, 'other site']]) {
    await harness.setContentFixture(url, {
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><title>${title}</title><h1>${title}</h1>`,
    });
  }

  const unlock = await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD);
  expect(unlock.success).toBe(true);
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;

  // The trusted dApp: connected, signatures auto-approved.
  await grant(electronApp, TRUSTED_KEY);
  await signingRule(electronApp, TRUSTED_KEY);

  // Tab 1: the trusted dApp. Tab 2: the other site. Back to tab 1, so the
  // other site sits in a background tab while the address bar shows the
  // trusted dApp.
  await openIn(win, TRUSTED_URL);
  await win.locator('[data-test="new-tab-btn"]').click();
  await openIn(win, OTHER_URL);
  await win.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect(win.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', '1');
  await expect(win.locator('[data-test="address-input"]')).toHaveValue(TRUSTED_URL);

  // Positive control: the visible trusted dApp gets its account and an
  // auto-approved signature (main reads its rule, for its own key).
  await request(win, TRUSTED_URL, 'acc', 'eth_accounts');
  await expect.poll(() => outcome(win, TRUSTED_URL, 'acc')).toEqual({ ok: [account] });
  await request(win, TRUSTED_URL, 'sig', 'personal_sign', [MESSAGE, account]);
  await expect
    .poll(async () => (await outcome(win, TRUSTED_URL, 'sig'))?.ok || '')
    .toMatch(/^0x[0-9a-f]{130}$/i);

  // The background tab: no account, and no silent signature under the
  // trusted dApp's rule — it is simply not connected.
  await request(win, OTHER_URL, 'acc', 'eth_accounts');
  await expect.poll(() => outcome(win, OTHER_URL, 'acc')).toEqual({ ok: [] });
  await request(win, OTHER_URL, 'sig', 'personal_sign', [MESSAGE, account]);
  await expect
    .poll(async () => (await outcome(win, OTHER_URL, 'sig'))?.code)
    .toBe(4100);
  await expect(win.locator('#sidebar-dapp-sign')).toBeHidden();

  // Main does not take the renderer's word for the site either: since PRQ-9
  // the chrome has no signing call of its own to claim the trusted dApp's
  // rule with, for the background tab's guest or its own.
  expect(await win.evaluate(() => typeof window.wallet.signMessage)).toBe('undefined');

  // Once the other site is connected (no auto-approve), its signature needs
  // a prompt, which waits for its tab (PRQ-5a, as connecting does from
  // PRQ-4) and names the other site, not the visible one.
  await grant(electronApp, OTHER_KEY);
  await request(win, OTHER_URL, 'sig2', 'personal_sign', [MESSAGE, account]);
  await expect(win.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/has-wallet-prompt/, { timeout: 15_000 });
  await expect(win.locator('#sidebar-dapp-sign')).toBeHidden();
  await expect(win.locator('[data-test="address-input"]')).toHaveValue(TRUSTED_URL);
  // The connection banner keeps describing the visible tab.
  await expect(win.locator('#dapp-connection-site')).toHaveText(TRUSTED_KEY);
  await win.locator('[data-test="tab"][data-tab-id="2"]').click();
  await expect(win.locator('#sidebar-dapp-sign')).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-sign-site')).toHaveText(OTHER_KEY);
  // Let the sidebar finish sliding in before the evidence shot.
  await expect(win.locator('#dapp-sign-reject')).toBeInViewport({ ratio: 1 });
  await win.screenshot({ path: 'test-results/dapp-background-tab-prompt.png' });
  await win.click('#dapp-sign-reject');
  await expect.poll(async () => (await outcome(win, OTHER_URL, 'sig2'))?.code).toBe(4001);
});
