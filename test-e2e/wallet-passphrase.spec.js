// A BIP-39 passphrase end to end: the real onboarding screens, real IPC and a
// real vault. Expected addresses are worked out here with ethers rather than
// through the app's own derivation.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const { computeAddress, HDNodeWallet, Mnemonic } = require('ethers');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const { closeApp } = require('./close-app');

const VAULT_PASSWORD = 'Freedom-E2E-Passphrase-2026!';
const NEW_VAULT_PASSWORD = 'Freedom-E2E-Changed-2026!';
const WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'TREZOR';
const MAIN_PATH = "m/44'/60'/0'/0/0";
const METAMASK_2_PATH = "m/44'/60'/0'/0/2";

function addressAt(words, passphrase, derivationPath) {
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(words, passphrase), derivationPath).address;
}

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  dataDirs: async ({}, use) => {
    // Deliberately /tmp, for the same socket-path reason as safe-fixtures.js.
    const root = fs.mkdtempSync('/tmp/f-pass-');
    const dirs = {
      root,
      userData: path.join(root, 'userData'),
      identity: path.join(root, 'identity'),
      ant: path.join(root, 'ant'),
      ipfs: path.join(root, 'ipfs'),
      radicle: path.join(root, 'rad'),
    };
    for (const dir of Object.values(dirs)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dirs.userData, 'settings.json'),
      JSON.stringify({
        enableIdentityWallet: true,
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableRadicleIntegration: false,
      }),
      'utf-8'
    );
    await use(dirs);
    fs.rmSync(root, { recursive: true, force: true });
  },

  electronApp: async ({ dataDirs }, use) => {
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: dataDirs.userData,
        FREEDOM_IDENTITY_DATA: dataDirs.identity,
        FREEDOM_ANT_DATA: dataDirs.ant,
        FREEDOM_IPFS_DATA: dataDirs.ipfs,
        FREEDOM_RADICLE_DATA: dataDirs.radicle,
        // Shown, not hidden: see the note in safe-fixtures.js (#536).
        FREEDOM_TEST_HIDE_WINDOW: '0',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });
    await use(app);
    await closeApp(app);
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

function readVaultFile(dataDirs) {
  return fs.readFileSync(path.join(dataDirs.identity, 'identity-vault.json'), 'utf-8');
}

/** Open the wizard on one of the welcome screen's two paths. */
async function openWizardAt(win, action, stepName) {
  await win.evaluate(() => document.getElementById('onboarding-modal').showModal());
  const step = win.locator(`[data-step="${stepName}"]`);
  // The first click after showModal() is occasionally swallowed: see
  // live/onboarding-identity.spec.js.
  await expect(async () => {
    if (await step.isVisible()) return;
    await win
      .locator(`[data-step="welcome"] [data-action="${action}"]:visible`)
      .first()
      .click({ timeout: 5_000 });
    await step.waitFor({ state: 'visible', timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  return step;
}

/** Machines with Touch ID get an extra step; skip it so every platform matches. */
async function skipTouchIdIfOffered(win, nextStep) {
  const touchId = win.locator('[data-step="touch-id"]');
  const next = win.locator(`[data-step="${nextStep}"]`);
  await expect.poll(async () => (await touchId.isVisible()) || (await next.isVisible())).toBe(true);
  if (await touchId.isVisible()) {
    await touchId.locator('[data-action="skip-touch-id"]').click();
  }
  await next.waitFor({ state: 'visible', timeout: 60_000 });
}

async function setCreatePassword(win) {
  await win.fill('#create-password', VAULT_PASSWORD);
  await win.locator('#create-password-confirm').waitFor({ state: 'visible' });
  await win.fill('#create-password-confirm', VAULT_PASSWORD);
}

/** Pick a derivation path on its screen: a radio list, so the row is what's clicked. */
async function choosePathScheme(win, scheme) {
  await win.locator(`label.choice:has(input[value="${scheme}"])`).click();
}

async function setPassphrase(win, value, confirm = value) {
  await win.fill('#passphrase-input', value);
  await win.fill('#passphrase-confirm', confirm);
}

async function finishBackup(win) {
  await win.check('#backup-confirmed');
  await win.click('[data-step="backup"] [data-action="continue-to-verify"]');
  await win.locator('[data-step="complete"]').waitFor({ state: 'visible', timeout: 60_000 });
}

test('imports a seed with a passphrase and a path, and keeps them', async ({
  window: win,
  dataDirs,
}) => {
  test.setTimeout(180_000);

  const mainAddress = addressAt(WORDS, PASSPHRASE, MAIN_PATH);
  const pathAddress = addressAt(WORDS, PASSPHRASE, METAMASK_2_PATH);
  const wordsOnlyAddress = addressAt(WORDS, '', MAIN_PATH);

  const step = await openWizardAt(win, 'import', 'import');
  const importBtn = step.locator('[data-action="import-vault"]');
  const passphraseStatus = step.locator('.passphrase-status');
  const pathStatus = win.locator('#import-path-status');
  const importAddress = win.locator('#import-preview .onboarding-address').first();
  const passphraseAddress = win.locator('#passphrase-preview .onboarding-address').first();
  const pathAddressEl = win.locator('#path-preview .onboarding-address').first();
  const pathError = win.locator('#import-path-error');
  const back = win.locator('#onboarding-back');

  // --- The normal flow is untouched: nothing Advanced to fill in ------------

  await expect(back).toContainText('Welcome');
  await expect(win.locator('#onboarding-close')).toBeHidden();
  await expect(passphraseStatus).toHaveText('Off');
  await expect(pathStatus).toHaveText('Default');

  await win.fill('#import-mnemonic', WORDS);
  await win.fill('#import-password', VAULT_PASSWORD);
  await win.fill('#import-password-confirm', VAULT_PASSWORD);
  await expect(win.locator('#import-mnemonic-hint')).toHaveText('Valid 12-word phrase');
  await expect(importBtn).toBeEnabled();
  await expect(win.locator('#import-preview')).toBeHidden();

  await step.locator('[data-action="open-path"]').click();
  await expect(pathAddressEl).toHaveText(wordsOnlyAddress);
  await win.click('#onboarding-back');

  // --- The passphrase screen: the address follows it, once both entries match

  await step.locator('[data-action="open-passphrase"]').click();
  await expect(win.locator('#onboarding-nav-title')).toHaveText('Passphrase');
  await expect(back).toContainText('Import');
  await expect(win.locator('#onboarding-done')).toBeVisible();
  await expect(win.locator('#passphrase-explanation')).toContainText('not your password');
  await expect(win.locator('#passphrase-input')).toBeHidden();

  await win.check('#passphrase-enabled');
  await win.fill('#passphrase-input', PASSPHRASE);
  await expect(passphraseStatus).toHaveText("Doesn't match");
  await expect(importBtn).toBeDisabled();
  await expect(win.locator('#passphrase-preview')).toBeHidden();

  await win.fill('#passphrase-confirm', 'TREZO');
  await expect(win.locator('#passphrase-note')).toHaveText("Passphrases don't match.");

  await win.fill('#passphrase-confirm', PASSPHRASE);
  await expect(passphraseAddress).toHaveText(mainAddress);
  await expect(win.locator('#passphrase-preview .onboarding-caption')).toHaveText(
    'Your main wallet'
  );
  await expect(passphraseStatus).toHaveText('On');

  // A space is easy to miss, and it changes the wallet.
  await setPassphrase(win, `${PASSPHRASE} `);
  await expect(win.locator('#passphrase-note')).toContainText('Spaces at the start or end');
  await expect(passphraseAddress).toHaveText(addressAt(WORDS, `${PASSPHRASE} `, MAIN_PATH));
  await setPassphrase(win, PASSPHRASE);
  await expect(passphraseAddress).toHaveText(mainAddress);

  // Show reveals both fields, exactly as typed.
  await win.click('#passphrase-toggle');
  await expect(win.locator('#passphrase-input')).toHaveAttribute('type', 'text');
  await expect(win.locator('#passphrase-confirm')).toHaveAttribute('type', 'text');
  await win.click('#passphrase-toggle');
  await expect(win.locator('#passphrase-input')).toHaveAttribute('type', 'password');

  // Switching it off clears it, and the wallet goes back to the words alone.
  await win.uncheck('#passphrase-enabled');
  await expect(passphraseStatus).toHaveText('Off');
  await expect(win.locator('#passphrase-input')).toHaveValue('');
  await win.check('#passphrase-enabled');
  await setPassphrase(win, PASSPHRASE);

  // Leaving with a mismatch shows on the row and blocks the import.
  await setPassphrase(win, PASSPHRASE, 'TREZO');
  await win.click('#onboarding-done');
  await expect(step).toBeVisible();
  await expect(passphraseStatus).toHaveText("Doesn't match");
  await expect(importBtn).toBeDisabled();

  await step.locator('[data-action="open-passphrase"]').click();
  await expect(win.locator('#passphrase-confirm')).toHaveValue('TREZO');
  await setPassphrase(win, PASSPHRASE);
  await win.click('#onboarding-back');

  await expect(passphraseStatus).toHaveText('On');
  await expect(importAddress).toHaveText(mainAddress);
  await expect(importBtn).toBeEnabled();

  // --- A path: refused ones block the import, the first account is main ----

  await step.locator('[data-action="open-path"]').click();
  await expect(win.locator('#onboarding-nav-title')).toHaveText('Derivation Path');
  await expect(pathAddressEl).toHaveText(mainAddress);

  await choosePathScheme(win, 'metamask');
  await expect(pathAddressEl).toHaveText(mainAddress);
  await expect(win.locator('#path-preview .onboarding-caption')).toHaveText('Your main wallet');
  await expect(win.locator('#import-path-minus')).toBeDisabled();

  await win.click('#import-path-plus');
  await expect(win.locator('#import-path-index')).toHaveValue('1');
  await expect(pathError).toContainText("Swarm node's wallet");
  await expect(win.locator('#path-preview')).toBeHidden();
  await expect(importBtn).toBeDisabled();
  await expect(pathStatus).toHaveText('Refused');
  await expect(win.locator('#import-advanced-error')).toContainText("Swarm node's wallet");

  await choosePathScheme(win, 'custom');
  await expect(importBtn).toBeDisabled();
  await win.fill('#import-path-custom', "m/44'/73406'/0'/0/0");
  await expect(pathError).toContainText('reserved');
  await expect(importBtn).toBeDisabled();
  await win.fill('#import-path-custom', 'nope');
  await expect(pathError).toContainText('Enter a path like');

  await choosePathScheme(win, 'metamask');
  await win.fill('#import-path-index', '2');
  await expect(pathAddressEl).toHaveText(pathAddress);
  await expect(win.locator('#path-preview .onboarding-address.small')).toHaveText(METAMASK_2_PATH);
  await expect(win.locator('#path-preview .onboarding-caption')).toContainText(
    'Added next to your main wallet'
  );
  await win.click('#onboarding-done');

  await expect(pathStatus).toHaveText('MetaMask, account 2');
  await expect(importAddress).toHaveText(pathAddress);
  await expect(importBtn).toBeEnabled();

  // --- Import ---------------------------------------------------------------

  await importBtn.click();
  await skipTouchIdIfOffered(win, 'complete');
  await expect(win.locator('#identity-wallet')).toHaveText(pathAddress);
  await expect(back).toBeHidden();

  const vaultFile = readVaultFile(dataDirs);
  expect(JSON.parse(vaultFile).version).toBe(2);
  expect(vaultFile).not.toContain(PASSPHRASE);

  const { wallets } = await win.evaluate(() => window.wallet.getDerivedWallets());
  expect(wallets.map((wallet) => wallet.address)).toEqual([mainAddress, pathAddress]);
  const meta = await win.evaluate(() => window.identity.getVaultMeta());
  expect(meta.activeWalletIndex).toBe(wallets[1].index);
  expect(meta.addresses.userWallet).toBe(mainAddress);
  expect(JSON.stringify(meta)).not.toContain(PASSPHRASE);

  // The Swarm node gets the key from the same seed.
  const nodeWallet = addressAt(WORDS, PASSPHRASE, "m/44'/60'/0'/0/1");
  expect(meta.addresses.beeWallet).toBe(nodeWallet);
  const keystore = JSON.parse(
    fs.readFileSync(path.join(dataDirs.ant, 'keys', 'swarm.key'), 'utf-8')
  );
  expect(`0x${keystore.address}`.toLowerCase()).toBe(nodeWallet.toLowerCase());

  await win.click('[data-step="complete"] [data-action="finish"]');
  await expect(win.locator('#onboarding-modal')).toBeHidden();
  // Nothing is left in the wizard's fields for the rest of the session.
  for (const field of [
    '#import-mnemonic',
    '#import-password',
    '#import-password-confirm',
    '#passphrase-input',
    '#passphrase-confirm',
    '#import-path-custom',
  ]) {
    await expect(win.locator(field)).toHaveValue('');
  }
  await expect(win.locator('#passphrase-enabled')).not.toBeChecked();

  // --- The recovery screen shows it with the words --------------------------

  await win.click('#wallet-toggle-btn');
  await win.click('.sidebar-tab[data-tab="settings"]');
  await win.click('#sidebar-export-mnemonic-btn');
  await win.fill('#export-password-input', VAULT_PASSWORD);
  await win.click('#export-password-submit');
  await expect(win.locator('#mnemonic-words .mnemonic-word')).toHaveCount(12);
  await expect(win.locator('#export-passphrase-value')).toHaveText(PASSPHRASE);
  await expect(win.locator('#export-passphrase-note')).toContainText('different, empty wallet');

  await win.click('#export-mnemonic-back');
  await expect(win.locator('#export-passphrase-value')).toBeEmpty();

  // --- Locking, and changing the vault password, keep the same wallet -------

  const changed = await win.evaluate(
    ([current, next]) => window.identity.changePassword(current, next),
    [VAULT_PASSWORD, NEW_VAULT_PASSWORD]
  );
  expect(changed.success).toBe(true);
  await win.evaluate(() => window.identity.lock());

  const wrong = await win.evaluate((password) => window.identity.unlock(password), VAULT_PASSWORD);
  expect(wrong.success).toBe(false);
  const unlocked = await win.evaluate(
    (password) => window.identity.unlock(password),
    NEW_VAULT_PASSWORD
  );
  expect(unlocked.success).toBe(true);

  expect(JSON.parse(readVaultFile(dataDirs)).version).toBe(2);
  const exported = await win.evaluate(
    (password) => window.identity.exportMnemonic(password),
    NEW_VAULT_PASSWORD
  );
  expect(exported).toEqual({ success: true, mnemonic: WORDS, passphrase: PASSPHRASE });

  // The signing keys, not just the listed addresses.
  for (const wallet of wallets) {
    const { privateKey } = await win.evaluate(
      ([index, password]) => window.identity.exportPrivateKey(index, password),
      [wallet.index, NEW_VAULT_PASSWORD]
    );
    expect(computeAddress(privateKey)).toBe(wallet.address);
  }
});

test('creates a seed with a passphrase and shows it for backup', async ({
  window: win,
  dataDirs,
}) => {
  test.setTimeout(120_000);

  // Markup and trailing space on purpose: it's free text, shown exactly as typed.
  const passphrase = '<b>café</b> ';

  const step = await openWizardAt(win, 'create', 'create-password');
  const continueBtn = step.locator('[data-action="create-vault"]');

  await setCreatePassword(win);
  await expect(continueBtn).toBeEnabled();

  await step.locator('[data-action="open-passphrase"]').click();
  await expect(win.locator('#onboarding-back')).toContainText('Password');
  await expect(win.locator('#passphrase-explanation')).toContainText(
    "words alone won't open this wallet"
  );
  await win.check('#passphrase-enabled');
  await expect(win.locator('#passphrase-preview')).toBeHidden();
  await setPassphrase(win, passphrase, 'something else');
  await expect(win.locator('#passphrase-note')).toHaveText("Passphrases don't match.");
  await expect(continueBtn).toBeDisabled();
  await setPassphrase(win, passphrase);
  await expect(win.locator('#passphrase-note')).toContainText('Spaces at the start or end');
  // There's no address yet, and no recovery phrase to ask for.
  await expect(win.locator('#passphrase-preview')).toBeHidden();
  await win.click('#onboarding-done');
  await expect(step.locator('.passphrase-status')).toHaveText('On');
  await expect(continueBtn).toBeEnabled();

  await continueBtn.click();
  await skipTouchIdIfOffered(win, 'backup');

  const section = win.locator('#backup-passphrase');
  const value = win.locator('#backup-passphrase-value');
  await expect(section).toBeVisible();
  expect(await value.textContent()).toBe(passphrase);
  await expect(value.locator('b')).toHaveCount(0);
  await expect(section).toHaveClass(/blurred/);
  await expect(win.locator('#mnemonic-display')).toHaveClass(/blurred/);
  await expect(win.locator('#backup-passphrase-note')).toContainText('starts or ends with a space');
  await expect(win.locator('#backup-confirmed-label')).toContainText('and passphrase');
  await expect(win.locator('#onboarding-start-over')).toBeVisible();
  await expect(win.locator('#onboarding-back')).toBeHidden();

  await win.click('#toggle-mnemonic');
  await expect(section).not.toHaveClass(/blurred/);
  await expect(win.locator('#toggle-mnemonic')).toHaveText('Hide');

  await finishBackup(win);

  const exported = await win.evaluate(
    (password) => window.identity.exportMnemonic(password),
    VAULT_PASSWORD
  );
  expect(exported.passphrase).toBe(passphrase);
  expect(exported.mnemonic.split(' ')).toHaveLength(24);

  const expected = addressAt(exported.mnemonic, passphrase, MAIN_PATH);
  await expect(win.locator('#identity-wallet')).toHaveText(expected);
  expect(expected).not.toBe(addressAt(exported.mnemonic, '', MAIN_PATH));

  expect(JSON.parse(readVaultFile(dataDirs)).version).toBe(2);
  expect(readVaultFile(dataDirs)).not.toContain('caf');

  await win.click('[data-step="complete"] [data-action="finish"]');
  await expect(win.locator('#onboarding-modal')).toBeHidden();
  // Nothing is left in the wizard's fields or the backup screen.
  for (const field of [
    '#create-password',
    '#create-password-confirm',
    '#passphrase-input',
    '#passphrase-confirm',
  ]) {
    await expect(win.locator(field)).toHaveValue('');
  }
  await expect(win.locator('#mnemonic-display .mnemonic-word')).toHaveCount(0);
  await expect(win.locator('#backup-passphrase-value')).toBeEmpty();
  await expect(win.locator('#backup-confirmed')).not.toBeChecked();
});

test('creating a seed with no passphrase is unchanged', async ({ window: win, dataDirs }) => {
  test.setTimeout(120_000);

  const step = await openWizardAt(win, 'create', 'create-password');

  await expect(step.locator('.passphrase-status')).toHaveText('Off');
  await setCreatePassword(win);
  await step.locator('[data-action="create-vault"]').click();
  await skipTouchIdIfOffered(win, 'backup');

  await expect(win.locator('#backup-passphrase')).toBeHidden();
  await expect(win.locator('#backup-confirmed-label')).toHaveText("I've saved my recovery phrase");

  await finishBackup(win);

  const exported = await win.evaluate(
    (password) => window.identity.exportMnemonic(password),
    VAULT_PASSWORD
  );
  expect(exported.passphrase).toBe('');
  await expect(win.locator('#identity-wallet')).toHaveText(
    addressAt(exported.mnemonic, '', MAIN_PATH)
  );
  expect(JSON.parse(readVaultFile(dataDirs)).version).toBe(1);
});

test('Start Over asks first, then throws the words away', async ({ window: win }) => {
  test.setTimeout(120_000);

  const step = await openWizardAt(win, 'create', 'create-password');
  await setCreatePassword(win);
  await step.locator('[data-action="open-passphrase"]').click();
  await win.check('#passphrase-enabled');
  await setPassphrase(win, PASSPHRASE);
  await win.click('#onboarding-done');
  await step.locator('[data-action="create-vault"]').click();
  await skipTouchIdIfOffered(win, 'backup');

  const sheet = win.locator('#onboarding-start-over-sheet');
  await win.click('#onboarding-start-over');
  await expect(sheet).toBeVisible();

  // Keeping them changes nothing, and so does Escape.
  await win.click('#onboarding-start-over-cancel');
  await expect(sheet).toBeHidden();
  await expect(win.locator('#mnemonic-display .mnemonic-word')).toHaveCount(24);
  await win.click('#onboarding-start-over');
  await win.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(win.locator('[data-step="backup"]')).toBeVisible();

  await win.click('#onboarding-start-over');
  await win.click('#onboarding-start-over-confirm');
  await expect(win.locator('[data-step="welcome"]')).toBeVisible();
  await expect(win.locator('#mnemonic-display .mnemonic-word')).toHaveCount(0);
  await expect(win.locator('#backup-passphrase-value')).toBeEmpty();
  await expect(win.locator('#create-password')).toHaveValue('');
  await expect(win.locator('#passphrase-input')).toHaveValue('');
});

test('opening from the sidebar puts focus on the dialog, not the close button', async ({
  window: win,
}) => {
  test.setTimeout(60_000);

  await win.click('#wallet-toggle-btn');
  await win.click('#sidebar-setup-btn');
  await expect(win.locator('[data-step="welcome"]')).toBeVisible();
  expect(await win.evaluate(() => document.activeElement?.id)).toBe('onboarding-modal');
});

test('without Touch ID, welcome offers create as the main button and one clean row', async ({
  window: win,
}) => {
  test.setTimeout(60_000);

  await win.evaluate(() => document.getElementById('onboarding-modal').showModal());
  const welcome = win.locator('[data-step="welcome"]');
  await expect(welcome).toBeVisible();
  // Set by hand on a machine that does have Touch ID, so this holds everywhere.
  await win.evaluate(() => {
    document.getElementById('welcome-quick-setup').classList.add('hidden');
    document.getElementById('welcome-standard').classList.remove('hidden');
    document.getElementById('welcome-create-row').classList.add('hidden');
  });

  await expect(win.locator('#welcome-standard')).toHaveText('Create New Identity');
  const importRow = welcome.locator('.onboarding-row[data-action="import"]');
  const hairline = await importRow.evaluate((row) => getComputedStyle(row, '::before').content);
  expect(hairline).toBe('none');
});

test('Escape goes back a screen and never closes the dialog', async ({ window: win }) => {
  test.setTimeout(60_000);

  const step = await openWizardAt(win, 'import', 'import');
  await step.locator('[data-action="open-path"]').click();
  await expect(win.locator('[data-step="derivation-path"]')).toBeVisible();

  await win.keyboard.press('Escape');
  await expect(step).toBeVisible();
  await expect(win.locator('[data-step="derivation-path"]')).toBeHidden();

  await win.keyboard.press('Escape');
  await expect(win.locator('[data-step="welcome"]')).toBeVisible();
  await expect(win.locator('#onboarding-close')).toBeVisible();

  await win.keyboard.press('Escape');
  await expect(win.locator('#onboarding-modal')).toBeVisible();
  await expect(win.locator('[data-step="welcome"]')).toBeVisible();
});

/** Hold main's answers on a channel until releaseIpc, to see what the form does meanwhile. */
async function holdIpc(electronApp, channel) {
  await electronApp.evaluate(({ ipcMain }, heldChannel) => {
    const original = ipcMain._invokeHandlers.get(heldChannel);
    const held = [];
    globalThis.__heldIpcCount = () => held.length;
    globalThis.__releaseHeldIpc = () => {
      held.splice(0).forEach((release) => release());
      ipcMain.removeHandler(heldChannel);
      ipcMain.handle(heldChannel, original);
    };
    ipcMain.removeHandler(heldChannel);
    ipcMain.handle(
      heldChannel,
      (...args) =>
        new Promise((resolve) => {
          held.push(() => resolve(original(...args)));
        })
    );
  }, channel);
}

async function heldIpcCount(electronApp) {
  return electronApp.evaluate(() => globalThis.__heldIpcCount());
}

async function releaseIpc(electronApp) {
  await electronApp.evaluate(() => globalThis.__releaseHeldIpc());
}

test('import waits until the address for what was typed is on screen', async ({
  window: win,
  electronApp,
}) => {
  test.setTimeout(60_000);

  const otherWords = 'test test test test test test test test test test test junk';
  const step = await openWizardAt(win, 'import', 'import');
  const importBtn = step.locator('[data-action="import-vault"]');
  const preview = win.locator('#import-preview');
  const previewAddress = win.locator('#import-preview .onboarding-address').first();

  await win.fill('#import-mnemonic', WORDS);
  await win.fill('#import-password', VAULT_PASSWORD);
  await win.fill('#import-password-confirm', VAULT_PASSWORD);
  await expect(importBtn).toBeEnabled();

  // --- A passphrase, with main's answer still on its way --------------------

  await step.locator('[data-action="open-passphrase"]').click();
  await win.check('#passphrase-enabled');
  await holdIpc(electronApp, 'identity:preview-import');
  await setPassphrase(win, PASSPHRASE);
  await expect(win.locator('#passphrase-preview')).toBeHidden();
  await expect(importBtn).toBeDisabled();

  await releaseIpc(electronApp);
  await expect(win.locator('#passphrase-preview .onboarding-address').first()).toHaveText(
    addressAt(WORDS, PASSPHRASE, MAIN_PATH)
  );
  await win.click('#onboarding-done');
  await expect(previewAddress).toHaveText(addressAt(WORDS, PASSPHRASE, MAIN_PATH));
  await expect(importBtn).toBeEnabled();

  // --- Different words: the old address goes straight away ------------------

  await holdIpc(electronApp, 'identity:validate-mnemonic');
  await win.fill('#import-mnemonic', otherWords);
  await expect(preview).toBeHidden();
  await expect(importBtn).toBeDisabled();

  await releaseIpc(electronApp);
  await expect(previewAddress).toHaveText(addressAt(otherWords, PASSPHRASE, MAIN_PATH));
  await expect(importBtn).toBeEnabled();

  // --- Words that stop being valid ------------------------------------------

  await win.fill('#import-mnemonic', 'not enough words');
  await expect(preview).toBeHidden();
  await expect(importBtn).toBeDisabled();
  await expect(win.locator('#import-mnemonic-hint')).toContainText('3 words entered');

  // Advanced still says what it's waiting for.
  await step.locator('[data-action="open-path"]').click();
  await expect(win.locator('#path-preview .onboarding-caption')).toContainText(
    'Enter your recovery phrase'
  );
});

for (const startFrom of ['the password field', 'the Continue button']) {
  test(`keys pressed while loading do not run the step again, from ${startFrom}`, async ({
    window: win,
    electronApp,
  }) => {
    test.setTimeout(60_000);

    const step = await openWizardAt(win, 'create', 'create-password');
    await setCreatePassword(win);

    await holdIpc(electronApp, 'identity:generate-mnemonic');
    if (startFrom === 'the password field') {
      await win.focus('#create-password-confirm');
    } else {
      // Focused, as a click leaves it on Linux and Windows (not on macOS).
      await step.locator('[data-action="create-vault"]').focus();
    }
    // Straight after, before anything else can move focus: on a slow machine
    // the keys arrive before Chromium takes focus off what just went inert.
    await win.keyboard.press('Enter');
    await win.keyboard.press('Enter');
    await win.keyboard.press('Space');
    await win.keyboard.press('Escape');
    await expect(win.locator('#onboarding-loading')).toBeVisible();
    expect(await heldIpcCount(electronApp)).toBe(1);
    await releaseIpc(electronApp);

    await skipTouchIdIfOffered(win, 'backup');
    await win.waitForTimeout(600);
    await expect(win.locator('[data-step="backup"]')).toBeVisible();
    await win.check('#backup-confirmed');
    await expect(win.locator('[data-action="continue-to-verify"]')).toBeEnabled();
  });
}

test('keys pressed in a dialog over onboarding stay in that dialog', async ({
  window: win,
  dataDirs,
}) => {
  test.setTimeout(60_000);

  const step = await openWizardAt(win, 'import', 'import');
  await win.fill('#import-mnemonic', WORDS);
  await win.fill('#import-password', VAULT_PASSWORD);
  await win.fill('#import-password-confirm', VAULT_PASSWORD);
  await expect(step.locator('[data-action="import-vault"]')).toBeEnabled();

  // The profile dialog can open from the app menu with onboarding still up.
  await win.evaluate(() => document.getElementById('add-bookmark-modal').showModal());
  await win.focus('#bookmark-label');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);
  await expect(win.locator('#onboarding-loading')).toBeHidden();
  expect(fs.existsSync(path.join(dataDirs.identity, 'identity-vault.json'))).toBe(false);

  await win.evaluate(() => document.getElementById('add-bookmark-modal').close());
  await expect(step).toBeVisible();
  await expect(win.locator('#import-mnemonic')).toHaveValue(WORDS);
});

test('an answer arriving after Back does not count for the cleared words', async ({
  window: win,
  electronApp,
}) => {
  test.setTimeout(60_000);

  const step = await openWizardAt(win, 'import', 'import');
  await holdIpc(electronApp, 'identity:validate-mnemonic');
  await win.fill('#import-mnemonic', WORDS);

  await win.click('#onboarding-back');
  await win.locator('[data-step="welcome"]').waitFor({ state: 'visible' });
  await releaseIpc(electronApp);

  await win.locator('[data-step="welcome"] [data-action="import"]:visible').first().click();
  await step.waitFor({ state: 'visible' });
  await expect(win.locator('#import-mnemonic')).toHaveValue('');
  await win.fill('#import-password', VAULT_PASSWORD);
  await win.fill('#import-password-confirm', VAULT_PASSWORD);

  await expect(step.locator('[data-action="import-vault"]')).toBeDisabled();
});

test('going back clears what was typed on Advanced screens', async ({ window: win }) => {
  test.setTimeout(60_000);

  const step = await openWizardAt(win, 'import', 'import');
  await step.locator('[data-action="open-passphrase"]').click();
  await win.check('#passphrase-enabled');
  await setPassphrase(win, PASSPHRASE);
  await win.click('#onboarding-back');
  await step.locator('[data-action="open-path"]').click();
  await choosePathScheme(win, 'custom');
  await win.fill('#import-path-custom', METAMASK_2_PATH);
  await win.click('#onboarding-back');

  await win.click('#onboarding-back');
  await win.locator('[data-step="welcome"]').waitFor({ state: 'visible' });
  await win.locator('[data-step="welcome"] [data-action="import"]:visible').first().click();
  await step.waitFor({ state: 'visible' });

  await expect(step.locator('.passphrase-status')).toHaveText('Off');
  await expect(win.locator('#import-path-status')).toHaveText('Default');
  await expect(win.locator('#passphrase-enabled')).not.toBeChecked();
  await expect(win.locator('#passphrase-input')).toHaveValue('');
  await expect(win.locator('#import-path-custom')).toHaveValue('');
});
