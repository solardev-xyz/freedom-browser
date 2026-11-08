// Exporting and importing the account list (#1037), end to end: the real
// Settings tab and sub-screens, real IPC and a real vault holding Hardhat's
// default seed. Only the system's save and open dialogs are stubbed, in main.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'src', 'main', 'identity'));
const { closeApp } = require('./close-app');

const VAULT_PASSWORD = 'Freedom-E2E-Accounts-2026!';
const MNEMONIC = 'test test test test test test test test test test test junk';
const HARDWARE_INDEX_BASE = 1000000;
const LEDGER_ADDRESS = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const PHONE_ADDRESS = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';
const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const TEAM_SAFE_ADDRESS = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const STRANGER = '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f';
const METAMASK_2_PATH = "m/44'/60'/0'/0/2";

const at = (index) => identity.deriveUserWallet(MNEMONIC, index).address;
const defaultPath = (index) => `m/44'/60'/${index}'/0/0`;

const test = base.extend({
  // Shared by the fixture and the test: where the stubbed dialogs point.
  // eslint-disable-next-line no-empty-pattern
  tmpRoot: async ({}, use) => {
    // Deliberately /tmp, for the same socket-path reason as safe-fixtures.js.
    const tmpRoot = fs.mkdtempSync('/tmp/f-accounts-');
    await use(tmpRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },

  electronApp: async ({ tmpRoot }, use) => {
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

    // This computer after a reinstall: the seed is back, with a second
    // account, a Ledger and a Safe they own.
    await identity.importVault(identityDir, VAULT_PASSWORD, MNEMONIC);
    identity.lockVault();
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({
        addresses: { userWallet: at(0) },
        activeWalletIndex: 0,
        derivedWallets: [
          { index: 0, name: 'Main Wallet', address: at(0) },
          { index: 1, name: 'Wallet 2', address: at(1) },
          {
            index: HARDWARE_INDEX_BASE,
            name: 'Ledger 1',
            address: LEDGER_ADDRESS,
            type: 'ledger',
            path: "44'/60'/0'/0/0",
          },
          {
            index: HARDWARE_INDEX_BASE + 1,
            name: 'Joint',
            address: SAFE_ADDRESS,
            type: 'safe',
            owners: [0, HARDWARE_INDEX_BASE],
            threshold: 1,
            saltNonce: '42',
            deployed: {},
          },
        ],
        nextHardwareWalletIndex: HARDWARE_INDEX_BASE + 2,
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
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

function stubSaveDialog(electronApp, filePath) {
  return electronApp.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () =>
      target ? { canceled: false, filePath: target } : { canceled: true, filePath: '' };
  }, filePath);
}

function stubOpenDialog(electronApp, filePath) {
  return electronApp.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () =>
      target ? { canceled: false, filePaths: [target] } : { canceled: true, filePaths: [] };
  }, filePath);
}

async function openSettingsTab(win) {
  await win.click('#wallet-toggle-btn');
  await win.click('.sidebar-tab[data-tab="settings"]');
  await expect(win.locator('#sidebar-export-accounts-btn')).toBeVisible();
}

// A short window, so the screens below have to scroll.
async function shortWindow(electronApp, win) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows()[0];
    target.setMinimumSize(320, 300);
    target.setContentSize(1100, 480);
  });
  await expect.poll(() => win.evaluate(() => window.innerHeight)).toBe(480);
}

// Every visible list box shows all its rows: in a short window the screen
// scrolls, it doesn't squeeze the box and clip the rows away.
async function expectListsUnclipped(win, screen) {
  const boxes = await win
    .locator(`${screen} .account-list-group`)
    .evaluateAll((els) =>
      els
        .filter((el) => el.offsetParent)
        .map((el) => ({ rows: el.children.length, clipped: el.scrollHeight - el.clientHeight }))
    );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) expect(box).toEqual({ rows: box.rows, clipped: 0 });
  const pane = await win
    .locator(`${screen} .subscreen-content:visible`)
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(pane).toBe(true);
}

const group = (win, kind) => win.locator(`#import-accounts-groups [data-kind="${kind}"]`);
const rowNames = (win, kind) => group(win, kind).locator('.account-list-row-name');

test('exports the account list without secrets, and a canceled save changes nothing', async ({
  electronApp,
  window: win,
  tmpRoot,
}) => {
  test.setTimeout(60_000);
  await shortWindow(electronApp, win);
  await openSettingsTab(win);

  await win.click('#sidebar-export-accounts-btn');
  await expect(win.locator('#export-accounts-intro')).toContainText('these 4 accounts');
  await expect(win.locator('#export-accounts-rows .account-list-row-name')).toHaveText([
    'Main Wallet',
    'Wallet 2',
    'Ledger 1',
    'Joint',
  ]);
  await expect(win.locator('#export-accounts-rows .account-list-row-type')).toHaveText([
    'Software wallet',
    'Software wallet',
    'Ledger',
    'Safe · 1 of 2',
  ]);
  await expectListsUnclipped(win, '#sidebar-export-accounts');

  await stubSaveDialog(electronApp, null);
  await win.click('#export-accounts-save');
  await expect(win.locator('#export-accounts-save')).toBeEnabled();
  await expect(win.locator('#export-accounts-done')).toBeHidden();

  const target = path.join(tmpRoot, 'freedom-accounts.json');
  await stubSaveDialog(electronApp, target);
  await win.click('#export-accounts-save');
  await expect(win.locator('#export-accounts-done-count')).toHaveText('4 accounts saved to');
  await expect(win.locator('#export-accounts-done-file')).toHaveText('freedom-accounts.json');

  const text = fs.readFileSync(target, 'utf-8');
  expect(JSON.parse(text)).toEqual({
    format: 'freedom-account-list',
    version: 1,
    accounts: [
      { type: 'mnemonic', name: 'Main Wallet', address: at(0), path: defaultPath(0) },
      { type: 'mnemonic', name: 'Wallet 2', address: at(1), path: defaultPath(1) },
      { type: 'ledger', name: 'Ledger 1', address: LEDGER_ADDRESS, path: "44'/60'/0'/0/0" },
      {
        type: 'safe',
        name: 'Joint',
        address: SAFE_ADDRESS,
        owners: [at(0), LEDGER_ADDRESS],
        threshold: 1,
        saltNonce: '42',
      },
    ],
  });
  for (const word of ['junk', 'privateKey', '"mnemonic":', 'passphrase', VAULT_PASSWORD]) {
    expect(text).not.toContain(word);
  }

  await win.click('#export-accounts-finish');
  await expect(win.locator('#sidebar-export-accounts')).toBeHidden();
  await expect(win.locator('#sidebar-export-accounts-btn')).toBeVisible();
});

test('imports a list from another computer: renames, adds what the seed proves, keeps the rest', async ({
  electronApp,
  window: win,
  tmpRoot,
}) => {
  test.setTimeout(90_000);
  await shortWindow(electronApp, win);

  const file = path.join(tmpRoot, 'freedom-accounts-2026-11-02.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      format: 'freedom-account-list',
      version: 1,
      accounts: [
        { type: 'mnemonic', name: 'Main Wallet', address: at(0), path: defaultPath(0) },
        { type: 'mnemonic', name: 'Savings', address: at(1), path: defaultPath(1) },
        { type: 'ledger', name: 'Cold storage', address: LEDGER_ADDRESS, path: "44'/60'/0'/0/0" },
        {
          type: 'safe',
          name: 'Family Safe',
          address: SAFE_ADDRESS,
          owners: [at(0), LEDGER_ADDRESS],
          threshold: 1,
          saltNonce: '42',
        },
        { type: 'mnemonic', name: 'Trading', address: at(4), path: defaultPath(4) },
        {
          type: 'mnemonic',
          name: 'From MetaMask',
          address: identity.deriveWalletAtPath(MNEMONIC, METAMASK_2_PATH).address,
          path: METAMASK_2_PATH,
        },
        { type: 'mnemonic', name: 'Old account', address: STRANGER, path: defaultPath(7) },
        { type: 'remote', name: 'Pixel', address: PHONE_ADDRESS },
        {
          type: 'safe',
          name: 'Team Safe',
          address: TEAM_SAFE_ADDRESS,
          owners: [at(0), PHONE_ADDRESS],
          threshold: 1,
          saltNonce: '7',
        },
      ],
    }),
    'utf-8'
  );

  await openSettingsTab(win);

  // --- Something that isn't an account list is refused as a whole --------

  const notes = path.join(tmpRoot, 'notes.json');
  fs.writeFileSync(notes, '{"notes": []}', 'utf-8');
  await stubOpenDialog(electronApp, notes);
  await win.click('#sidebar-import-accounts-btn');
  await expect(win.locator('#import-accounts-invalid-text')).toContainText(
    "isn't an account list from Freedom"
  );

  // --- The real file, previewed while the vault is locked -----------------

  await stubOpenDialog(electronApp, file);
  await win.click('#import-accounts-choose');
  await expect(win.locator('#import-accounts-file')).toHaveText(
    'freedom-accounts-2026-11-02.json · 9 accounts'
  );
  await expect(win.locator('#import-accounts-unlock-text')).toContainText(
    'Unlock to check 3 software-wallet accounts'
  );
  await expect(rowNames(win, 'rename')).toHaveText([
    'Wallet 2 → Savings',
    'Ledger 1 → Cold storage',
    'Joint → Family Safe',
  ]);
  await expect(group(win, 'add')).toHaveCount(0);
  await expect(rowNames(win, 'skip')).toHaveText(['Pixel', 'Team Safe']);
  await expect(group(win, 'skip').locator('.account-list-row-note')).toHaveText([
    'Pair this phone and add its account, then import again to restore the name.',
    'Needs owner Pixel. Add it, then import again.',
  ]);
  await expect(rowNames(win, 'same')).toHaveText(['Main Wallet']);
  await expect(win.locator('#import-accounts-summary')).toHaveText(
    '3 renamed. Nothing is deleted.'
  );

  // --- Unlocking checks the recovery-phrase accounts ----------------------

  await win.fill('#import-accounts-password', 'wrong password');
  await win.click('#import-accounts-password-submit');
  await expect(win.locator('#import-accounts-unlock-error')).toBeVisible();

  await win.fill('#import-accounts-password', VAULT_PASSWORD);
  await win.press('#import-accounts-password', 'Enter');
  await expect(win.locator('#import-accounts-unlock')).toBeHidden();
  await expect(rowNames(win, 'add')).toHaveText(['Trading', 'From MetaMask']);
  await expect(rowNames(win, 'skip')).toHaveText(['Old account', 'Pixel', 'Team Safe']);
  await expectListsUnclipped(win, '#sidebar-import-accounts');
  await expect(win.locator('#import-accounts-summary')).toHaveText(
    '3 renamed, 2 added. Nothing is deleted.'
  );

  // --- Import -------------------------------------------------------------

  await win.click('#import-accounts-submit');
  await expect(win.locator('#import-accounts-done-text')).toHaveText(
    'Renamed 3 and added 2 accounts.'
  );
  await expect(win.locator('#import-accounts-done-left')).toHaveText(
    "3 weren't added. Add the missing Ledger, phone or owners, then import the same file again to restore their names."
  );

  const { wallets } = await win.evaluate(() => window.wallet.getDerivedWallets());
  expect(wallets.map(({ index, name, address, type }) => ({ index, name, address, type }))).toEqual(
    [
      { index: 0, name: 'Main Wallet', address: at(0), type: 'mnemonic' },
      { index: 1, name: 'Savings', address: at(1), type: 'mnemonic' },
      { index: HARDWARE_INDEX_BASE, name: 'Cold storage', address: LEDGER_ADDRESS, type: 'ledger' },
      { index: HARDWARE_INDEX_BASE + 1, name: 'Family Safe', address: SAFE_ADDRESS, type: 'safe' },
      { index: 4, name: 'Trading', address: at(4), type: 'mnemonic' },
      {
        index: HARDWARE_INDEX_BASE + 2,
        name: 'From MetaMask',
        address: identity.deriveWalletAtPath(MNEMONIC, METAMASK_2_PATH).address,
        type: 'mnemonic',
      },
    ]
  );

  await win.click('#import-accounts-finish');
  await expect(win.locator('#sidebar-import-accounts')).toBeHidden();

  // The selector shows the new names straight away.
  await win.click('.sidebar-tab[data-tab="wallet"]');
  await win.click('#wallet-selector-btn');
  for (const name of ['Savings', 'Cold storage', 'Family Safe', 'Trading', 'From MetaMask']) {
    await expect(win.locator('.wallet-selector-item', { hasText: name })).toBeVisible();
  }
});
