// #1152: Sign-In with Ethereum over HTTP authentication, end to end. A real
// (pre-seeded) vault, the real main-process interception and wallet
// handlers, and the reference server from scripts/ answering 401 with a
// SIWE challenge: the card appears for the page, signs the message main
// built, and the page reloads signed in. Rejecting leaves the site's 401
// page, and the account used last is preselected next time.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'src', 'main', 'identity'));
const { createSiweReferenceServer } = require(
  path.join(repoRoot, 'scripts', 'siwe-reference-server')
);

const VAULT_PASSWORD = 'Freedom-E2E-SIWE-2026!';

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-siwe-'));
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

let server;
let siteOrigin;

test.beforeAll(async () => {
  server = createSiweReferenceServer({ statement: 'Sign in to the Freedom e2e club' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  siteOrigin = `http://localhost:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** The visible tab's page text, or '' while it loads. */
function pageText(win) {
  return win.evaluate(async () => {
    const wv = document.querySelector('webview:not(.hidden)');
    try {
      return (await wv?.executeJavaScript('document.body ? document.body.innerText : ""')) || '';
    } catch {
      return '';
    }
  });
}

async function go(win, url) {
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(url);
  await address.press('Enter');
}

test("a site's SIWE challenge signs in through the card, and Reject leaves the 401 page", async ({
  electronApp,
  window: win,
}) => {
  test.setTimeout(120_000);
  // Test mode answers every http:// load from a static stub; this spec needs
  // the real network path (the SIWE hooks are webRequest handlers), so it
  // hands http back to Chromium for the reference server on localhost.
  await electronApp.evaluate(({ session }) => session.defaultSession.protocol.unhandle('http'));
  const unlock = await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD);
  expect(unlock.success).toBe(true);
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  const host = new URL(siteOrigin).host;

  await go(win, `${siteOrigin}/members`);

  const card = win.locator('#sidebar-siwe-signin');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(win.locator('#siwe-signin-site')).toHaveText(host);
  await expect(win.locator('#siwe-signin-account-name')).toHaveText('Main Wallet');
  await expect(win.locator('#siwe-signin-remembered')).toBeHidden();
  const message = win.locator('#siwe-signin-message');
  await expect(message).toContainText(
    `${siteOrigin} wants you to sign in with your Ethereum account:`
  );
  await expect(message).toContainText(account);
  await expect(message).toContainText('Sign in to the Freedom e2e club');
  await expect(message).toContainText(`URI: ${siteOrigin}/members`);
  // The site's own 401 page stays behind the card.
  await expect.poll(() => pageText(win)).toContain('Sign in required');

  await expect(win.locator('#siwe-signin-cancel')).toBeInViewport({ ratio: 1 });
  await win.screenshot({ path: 'test-results/siwe-signin-card.png' });

  await expect(win.locator('#siwe-signin-approve')).toBeEnabled();
  await win.click('#siwe-signin-approve');
  await expect(card).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => pageText(win), { timeout: 15_000 }).toContain('Welcome, member');
  expect(await pageText(win)).toContain(account);

  // The session cookie keeps the visitor in: no card on the next load.
  await go(win, `${siteOrigin}/members`);
  await expect.poll(() => pageText(win)).toContain('Welcome, member');
  await expect(card).toBeHidden();

  // Signed out, the site asks again; the account used last is preselected.
  await go(win, `${siteOrigin}/logout`);
  await expect.poll(() => pageText(win)).toContain('SIWE reference server');
  await go(win, `${siteOrigin}/members`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(win.locator('#siwe-signin-remembered')).toBeVisible();

  await win.click('#siwe-signin-cancel');
  await expect(card).toBeHidden();
  await expect.poll(() => pageText(win)).toContain('Sign in required');
});
