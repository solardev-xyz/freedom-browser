// #764: a dApp request is attributed to the tab that sent it, not to the
// site in the address bar. With a trusted dApp in the visible tab — connected
// and set to auto-approve signatures — a page in a background tab must not
// get its account, its auto-approve rules, or a prompt carrying its name.
//
// Two real tabs, two harness-served bzz:// pages, a real (pre-seeded) vault
// and the real main-process wallet handlers: the renderer's attribution and
// main's check of the claimed site against the requesting guest's own URL
// are both exercised end to end.

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
  await win.evaluate(async (key) => {
    await window.dappPermissions.grantPermission(key, 0, 100);
    await window.dappPermissions.setSigningAutoApprove(key, true);
  }, TRUSTED_KEY);

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
  // auto-approved signature (main honours the claim for its own guest).
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

  // Main does not take the renderer's word for the site either: the trusted
  // dApp's key claimed for the background tab's guest is refused, while the
  // same claim for the trusted tab's own guest signs.
  const refused = await win.evaluate(
    async ({ url, key, message }) => {
      const guestOf = (u) =>
        [...document.querySelectorAll('webview')].find((w) => w.getURL() === u).getWebContentsId();
      return {
        borrowed: await window.wallet.signMessage(message, 0, {
          autoApprove: key,
          webContentsId: guestOf(url.other),
        }),
        noGuest: await window.wallet.signMessage(message, 0, { autoApprove: key }),
        own: await window.wallet.signMessage(message, 0, {
          autoApprove: key,
          webContentsId: guestOf(url.trusted),
        }),
      };
    },
    { url: { other: OTHER_URL, trusted: TRUSTED_URL }, key: TRUSTED_KEY, message: MESSAGE }
  );
  expect(refused.borrowed).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
  expect(refused.noGuest).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
  expect(refused.own).toMatchObject({ success: true });

  // Once the other site is connected (no auto-approve), its signature needs
  // a prompt — and the prompt names the other site, not the visible one.
  await win.evaluate((key) => window.dappPermissions.grantPermission(key, 0, 100), OTHER_KEY);
  await request(win, OTHER_URL, 'sig2', 'personal_sign', [MESSAGE, account]);
  await expect(win.locator('#sidebar-dapp-sign')).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-sign-site')).toHaveText(OTHER_KEY);
  await expect(win.locator('[data-test="address-input"]')).toHaveValue(TRUSTED_URL);
  // Let the sidebar finish sliding in before the evidence shot.
  await expect(win.locator('#dapp-sign-reject')).toBeInViewport({ ratio: 1 });
  await win.screenshot({ path: 'test-results/dapp-background-tab-prompt.png' });
  await win.click('#dapp-sign-reject');
  await expect.poll(async () => (await outcome(win, OTHER_URL, 'sig2'))?.code).toBe(4001);

  // The connection banner keeps describing the visible tab.
  await expect(win.locator('#dapp-connection-site')).toHaveText(TRUSTED_KEY);
  void electronApp;
});
