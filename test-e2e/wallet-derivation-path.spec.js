// Adding a wallet account at an explicit derivation path, end to end: the
// real add-wallet screen, real IPC and a real vault holding Hardhat's default
// seed, whose published accounts follow MetaMask's scheme.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const { computeAddress } = require('ethers');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'src', 'main', 'identity'));
const { closeApp } = require('./close-app');

const VAULT_PASSWORD = 'Freedom-E2E-Paths-2026!';
const MNEMONIC = 'test test test test test test test test test test test junk';
const MAIN_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const METAMASK_2_PATH = "m/44'/60'/0'/0/2";
const METAMASK_2_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    // Deliberately /tmp, for the same socket-path reason as safe-fixtures.js.
    const tmpRoot = fs.mkdtempSync('/tmp/f-path-');
    const userDataDir = path.join(tmpRoot, 'userData');
    const identityDir = path.join(tmpRoot, 'identity');
    const radicleDir = path.join(tmpRoot, 'rad');
    for (const dir of [userDataDir, identityDir, radicleDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

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

    await identity.importVault(identityDir, VAULT_PASSWORD, MNEMONIC);
    identity.lockVault();
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({ addresses: { userWallet: MAIN_ADDRESS }, activeWalletIndex: 0 }),
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
        FREEDOM_RADICLE_DATA: radicleDir,
        // Shown, not hidden: see the note in safe-fixtures.js (#536).
        FREEDOM_TEST_HIDE_WINDOW: '0',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });

    await use(app);

    await closeApp(app);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

async function openAddWallet(win) {
  await win.click('#wallet-selector-btn');
  await win.click('#wallet-create-btn');
}

test('adds wallet accounts at preset and custom derivation paths', async ({ window: win }) => {
  test.setTimeout(120_000);

  await win.click('#wallet-toggle-btn');
  await openAddWallet(win);

  await win.fill('#create-wallet-password', VAULT_PASSWORD);
  await win.click('#create-wallet-password-submit');
  await expect(win.locator('#create-wallet-name-step')).toBeVisible();

  const submit = win.locator('#create-wallet-submit');
  const error = win.locator('#create-wallet-path-error');
  const preview = win.locator('#create-wallet-path-preview');

  // --- The normal flow is untouched: collapsed, and the next account ------

  await expect(win.locator('#create-wallet-path-scheme')).toBeHidden();
  await expect(submit).toBeEnabled();

  // --- MetaMask preset: a listed account, the node wallet, then a new one -

  await win.locator('#create-wallet-path summary').click();
  await win.selectOption('#create-wallet-path-scheme', 'metamask');
  await expect(error).toContainText('already in your wallet list as "Main Wallet"');
  await expect(submit).toBeDisabled();

  await win.fill('#create-wallet-path-index', '1');
  await expect(error).toContainText("Swarm node's wallet");
  await expect(preview).toBeHidden();
  await expect(submit).toBeDisabled();

  // Enter must not get past a path main refused.
  await win.fill('#create-wallet-name-input', 'From MetaMask');
  await win.press('#create-wallet-name-input', 'Enter');
  await expect(win.locator('#create-wallet-name-step')).toBeVisible();

  await win.fill('#create-wallet-path-index', '2');
  await expect(win.locator('#create-wallet-path-preview-address')).toHaveText(METAMASK_2_ADDRESS);
  await expect(win.locator('#create-wallet-path-preview-path')).toHaveText(METAMASK_2_PATH);
  await expect(error).toBeHidden();
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(win.locator('#create-wallet-result-address')).toHaveText(METAMASK_2_ADDRESS);
  await expect(win.locator('#create-wallet-result-path')).toHaveText(METAMASK_2_PATH);
  await win.click('#create-wallet-done');

  // --- The key the vault gives for that account really is that address ----

  const wallets = await win.evaluate(() => window.wallet.getDerivedWallets());
  const added = wallets.wallets.find((wallet) => wallet.address === METAMASK_2_ADDRESS);
  expect(added).toMatchObject({ name: 'From MetaMask', type: 'mnemonic', path: METAMASK_2_PATH });
  const exported = await win.evaluate(
    ([index, password]) => window.identity.exportPrivateKey(index, password),
    [added.index, VAULT_PASSWORD]
  );
  expect(computeAddress(exported.privateKey)).toBe(METAMASK_2_ADDRESS);

  // --- Custom path: malformed and reserved are refused, then a free one ---

  await openAddWallet(win);
  await expect(win.locator('#create-wallet-name-step')).toBeVisible();
  await expect(win.locator('#create-wallet-path')).not.toHaveJSProperty('open', true);

  await win.locator('#create-wallet-path summary').click();
  await win.selectOption('#create-wallet-path-scheme', 'custom');
  await expect(submit).toBeDisabled();

  await win.fill('#create-wallet-path-input', 'nonsense');
  await expect(error).toContainText('Enter a path like');
  await expect(submit).toBeDisabled();

  await win.fill('#create-wallet-path-input', "m/44'/73406'/0'/0/0");
  await expect(error).toContainText('reserved');
  await expect(submit).toBeDisabled();

  await win.fill('#create-wallet-path-input', "44'/60'/7'/5/9");
  await expect(win.locator('#create-wallet-path-preview-path')).toHaveText("m/44'/60'/7'/5/9");
  await expect(submit).toBeEnabled();

  await win.fill('#create-wallet-name-input', 'My own scheme');
  await submit.click();
  await expect(win.locator('#create-wallet-result-path')).toHaveText("m/44'/60'/7'/5/9");
  await win.click('#create-wallet-done');

  // --- Both show up in the selector, under the names they were given ------

  await win.click('#wallet-selector-btn');
  await expect(win.locator('.wallet-selector-item', { hasText: 'From MetaMask' })).toBeVisible();
  await expect(win.locator('.wallet-selector-item', { hasText: 'My own scheme' })).toBeVisible();
});

test('the default next account still works, and shows no path', async ({ window: win }) => {
  test.setTimeout(60_000);

  await win.click('#wallet-toggle-btn');
  await openAddWallet(win);
  await win.fill('#create-wallet-password', VAULT_PASSWORD);
  await win.click('#create-wallet-password-submit');

  await win.fill('#create-wallet-name-input', 'Next');
  await win.click('#create-wallet-submit');

  await expect(win.locator('#create-wallet-result-name')).toHaveText('Next');
  await expect(win.locator('#create-wallet-result-path')).toBeHidden();

  const wallets = await win.evaluate(() => window.wallet.getDerivedWallets());
  const next = wallets.wallets.find((wallet) => wallet.name === 'Next');
  expect(next.index).toBe(1);
  expect(next.path).toBeUndefined();
});
