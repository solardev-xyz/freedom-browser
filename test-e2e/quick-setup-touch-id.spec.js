// Quick Setup with Touch ID, end to end on macOS (freedom-core design 0013,
// PRF-2b and PRF-2d). Touch ID is stubbed in main: CI runners have none.
//
// - The wizard's Quick Setup button: main prompts for Touch ID first, then
//   creates the vault with quick unlock's credential in the core
//   (`quick_unlock: true`), and writes no quick-unlock.dat (PRF-2d). Touch
//   ID then unlocks through the core: main never unseals anything (its
//   safeStorage decrypt is made to throw).
// - Its failure paths delete nothing the core committed: Touch ID cancelled
//   makes no vault. Without safeStorage the setup still finishes, as it
//   seals nothing.
//
// It needs the real freedom-cored, its key store through main's executor,
// and the job's temporary keychain as the user's default (FREEDOM_TEST_KEYCHAIN,
// as for keystore.integration.test.js): skipped anywhere else, and with
// FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN=1 it refuses to skip.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeApp } = require('./close-app');
const { chromeStarted } = require('./chrome-window');

const repoRoot = path.resolve(__dirname, '..');
const keychainReady = process.platform === 'darwin' && Boolean(process.env.FREEDOM_TEST_KEYCHAIN);
if (process.env.FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN === '1' && !keychainReady) {
  throw new Error('FREEDOM_KEYSTORE_REQUIRE_KEYCHAIN=1 needs macOS and FREEDOM_TEST_KEYCHAIN');
}

const SETTINGS = {
  enableIdentityWallet: true,
  startAntAtLaunch: false,
  startIpfsAtLaunch: false,
  startRadicleAtLaunch: false,
  enableRadicleIntegration: false,
};

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  dirs: async ({}, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-quick-setup-e2e-'));
    const dirs = {
      root,
      userData: path.join(root, 'userData'),
      identity: path.join(root, 'identity'),
      // The wizard's last step injects a Radicle identity. Under macOS's long
      // os.tmpdir() the profile's own radicle-data is too long a path for the
      // node's control socket, and main refuses it: an explicit data dir, as
      // onboarding-fixtures.js gives, skips that check.
      radicle: path.join(root, 'radicle-data'),
    };
    fs.mkdirSync(dirs.userData);
    fs.mkdirSync(dirs.identity, { mode: 0o700 });
    fs.mkdirSync(dirs.radicle, { mode: 0o700 });
    fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify(SETTINGS), 'utf-8');
    await use(dirs);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  },
  electronApp: async ({ dirs }, use, testInfo) => {
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: dirs.userData,
        FREEDOM_IDENTITY_DATA: dirs.identity,
        FREEDOM_RADICLE_DATA: dirs.radicle,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 30_000,
    });
    // Main's own output, attached when a test fails: a refusal's cause is
    // logged there, not shown to the wizard.
    const mainLog = [];
    for (const stream of [app.process().stdout, app.process().stderr]) {
      stream?.on('data', (chunk) => {
        mainLog.push(String(chunk));
        if (mainLog.length > 400) mainLog.shift();
      });
    }
    await use(app);
    await closeApp(app);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('main-process-log', { body: mainLog.join(''), contentType: 'text/plain' });
      const lines = mainLog.join('').split('\n');
      console.log(lines.filter((line) => /QuickUnlock|Identity|Vault|[Kk]ey ?store|[Ee]rror/.test(line)).slice(-60).join('\n'));
    }
  },
  window: async ({ electronApp }, use) => {
    let win = null;
    await expect
      .poll(() => {
        win = electronApp.windows().find((p) => p.url().includes('/renderer/index.html')) || null;
        return Boolean(win);
      }, { timeout: 20_000 })
      .toBe(true);
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await chromeStarted(win);
    await use(win);
  },
});

/** Touch ID in main, stood in for: each prompt's reason recorded. */
function stubTouchId(electronApp, { cancel = false } = {}) {
  return electronApp.evaluate(({ systemPreferences }, cancelIt) => {
    globalThis.__touchIdPrompts = [];
    systemPreferences.canPromptTouchID = () => true;
    systemPreferences.promptTouchID = async (reason) => {
      globalThis.__touchIdPrompts.push(reason);
      if (cancelIt) throw new Error('Touch ID was cancelled');
    };
  }, cancel);
}

const touchIdPrompts = (electronApp) => electronApp.evaluate(() => globalThis.__touchIdPrompts);

/**
 * Waits for the wizard's last step, or for the first alert, which is how it
 * reports a failure: the alert's text is then the failure, at once.
 */
async function quickSetupFinished(win, dialogs) {
  const complete = win.locator('[data-step="complete"]');
  await expect
    .poll(async () => dialogs.length > 0 || (await complete.isVisible()), { timeout: 120_000 })
    .toBe(true);
  expect(dialogs).toEqual([]);
}

/** The wizard's welcome step, on its Quick Setup layout, and the button clicked. */
async function clickQuickSetup(win) {
  const dialogs = [];
  win.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss().catch(() => {});
  });
  await win.evaluate(() => document.getElementById('onboarding-modal').showModal());
  await win.locator('[data-step="welcome"]').waitFor({ state: 'visible' });
  // The welcome screen picked its layout at start, before Touch ID was
  // stubbed: show the one a Mac with Touch ID gets.
  await win.evaluate(() => {
    document.getElementById('welcome-quick-setup').classList.remove('hidden');
    document.getElementById('welcome-standard').classList.add('hidden');
  });
  await win.locator('[data-step="welcome"] [data-action="quick-setup"]').click();
  return dialogs;
}

function secrets(dirs) {
  const file = path.join(dirs.identity, 'secrets.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

test.describe('Quick Setup with Touch ID (0013, PRF-2b, PRF-2d)', () => {
  test.skip(!keychainReady, 'macOS with the temporary keychain only (FREEDOM_TEST_KEYCHAIN)');
  // A launch, the core's KDF and the keychain helper take longer than the
  // harness project's 30 s.
  test.describe.configure({ timeout: 180_000 });

  test('Touch ID first, the vault with its credential, no quick-unlock.dat; then Touch ID unlocks through the core', async ({
    electronApp,
    window: win,
    dirs,
  }) => {
    await stubTouchId(electronApp);
    const dialogs = await clickQuickSetup(win);
    await quickSetupFinished(win, dialogs);
    expect(await touchIdPrompts(electronApp)).toEqual(['set up Freedom Browser with Touch ID']);

    // The core's credential, made through main's executor in the keychain.
    const written = secrets(dirs);
    expect(written.keys.unattended.item).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(written.entries)).toEqual(['quick-unlock']);
    // No quick-unlock.dat (PRF-2d), and a vault the user has no password
    // for.
    const credentialPath = path.join(dirs.identity, 'quick-unlock.dat');
    expect(fs.existsSync(credentialPath)).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dirs.identity, 'vault-meta.json'), 'utf8'));
    expect(meta.userKnowsPassword).toBe(false);
    await expect(win.evaluate(() => window.quickUnlock.isEnabled())).resolves.toBe(true);

    // Locked, Touch ID unlocks through the core: main never unseals the file.
    await expect(win.evaluate(() => window.identity.lock())).resolves.toEqual({ success: true });
    await electronApp.evaluate(({ safeStorage }) => {
      safeStorage.decryptString = () => {
        throw new Error('main unsealed quick-unlock.dat');
      };
    });
    await expect(win.evaluate(() => window.quickUnlock.unlock())).resolves.toEqual({
      success: true,
    });
    await expect(win.evaluate(() => window.identity.isUnlocked())).resolves.toEqual({
      isUnlocked: true,
    });
    expect((await touchIdPrompts(electronApp)).at(-1)).toBe('unlock Freedom Browser');
    expect(fs.existsSync(credentialPath)).toBe(false);
  });

  test('Touch ID cancelled: no vault, nothing written, nothing deleted', async ({
    electronApp,
    window: win,
    dirs,
  }) => {
    await stubTouchId(electronApp, { cancel: true });
    const dialogs = await clickQuickSetup(win);
    await expect.poll(() => dialogs.length, { timeout: 60_000 }).toBe(1);
    expect(dialogs[0]).toMatch(/Quick Setup did not finish: Touch ID was cancelled/);
    await expect(win.evaluate(() => window.identity.hasVault())).resolves.toEqual({
      hasVault: false,
    });
    for (const name of ['identity-vault.json', 'quick-unlock.dat', 'secrets.json']) {
      expect({ name, exists: fs.existsSync(path.join(dirs.identity, name)) }).toEqual({
        name,
        exists: false,
      });
    }
  });

  test('without safeStorage: the vault keeps its credential, no file, the setup finishes', async ({
    electronApp,
    window: win,
    dirs,
  }) => {
    await stubTouchId(electronApp);
    await electronApp.evaluate(({ safeStorage }) => {
      safeStorage.isEncryptionAvailable = () => false;
      safeStorage.encryptString = () => {
        throw new Error('Encryption is not available');
      };
    });
    const dialogs = await clickQuickSetup(win);
    await quickSetupFinished(win, dialogs);
    expect(fs.existsSync(path.join(dirs.identity, 'identity-vault.json'))).toBe(true);
    expect(fs.existsSync(path.join(dirs.identity, 'quick-unlock.dat'))).toBe(false);
    expect(Object.keys(secrets(dirs).entries)).toEqual(['quick-unlock']);

    await expect(win.evaluate(() => window.identity.lock())).resolves.toEqual({ success: true });
    await expect(win.evaluate(() => window.quickUnlock.unlock())).resolves.toEqual({
      success: true,
    });
  });
});
