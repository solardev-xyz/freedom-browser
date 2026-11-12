// Fixtures for the approvals document's specs (freedom-core design 0011,
// APS-1 and APS-2): the app with FREEDOM_APPROVALS_DOCUMENT=1, optionally a
// vault with one account, the chrome window (the document is a page of the
// app as well), and the helpers that read main's view of each window's
// panel and drive its input on main's clock.

const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');

const repoRoot = path.resolve(__dirname, '..');
const APPROVALS_URL = pathToFileURL(path.join(repoRoot, 'src', 'renderer', 'approvals', 'approvals.html')).href;
const VAULT_PASSWORD = 'Freedom-E2E-Approvals-2026!';
const DELAY_MS = 500;
// Comfortably past the delay, on a loaded CI runner too.
const PAST_DELAY_MS = 700;

const test = base.extend({
  // A vault with one account ('Main Wallet'), for the specs that connect,
  // sign or unlock; the settings turn the wallet on and the nodes off.
  withVault: [false, { option: true }],
  electronApp: async ({ userDataDir, withVault }, use) => {
    const env = {
      ...process.env,
      FREEDOM_TEST_MODE: '1',
      FREEDOM_TEST_USER_DATA: userDataDir,
      FREEDOM_APPROVALS_DOCUMENT: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    };
    let identityDir = null;
    if (withVault) {
      const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));
      identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f-approvals-identity-'));
      const settingsFile = path.join(userDataDir, 'settings.json');
      const seeded = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {};
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          ...seeded,
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
      env.FREEDOM_IDENTITY_DATA = identityDir;
    }
    const app = await electron.launch({ args: ['.'], cwd: repoRoot, env, timeout: 20_000 });
    await use(app);
    await closeApp(app);
    if (identityDir) fs.rmSync(identityDir, { recursive: true, force: true });
  },
  // The chrome, not the approvals document.
  window: async ({ electronApp }, use) => {
    let win = null;
    await expect
      .poll(() => {
        win = electronApp.windows().find((p) => p.url().includes('/renderer/index.html')) || null;
        return Boolean(win);
      }, { timeout: 20_000 })
      .toBe(true);
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await use(win);
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const activeGuestId = (win) =>
  win.evaluate(() => document.querySelector('webview:not(.hidden)')?.getWebContentsId() ?? null);
const inGuest = (electronApp, id, js) =>
  electronApp.evaluate(({ webContents }, args) => webContents.fromId(args.id).executeJavaScript(args.js), { id, js });

const approvalsState = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_APPROVALS__.state());
const approvalsTrace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_APPROVALS__.trace.slice());
const promptState = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.promptState());
const pageTrace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());

/** The chrome window's id. */
const chromeWindowId = (electronApp) =>
  electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/renderer/index.html')).id
  );

/** The first window's approvals document, as a Playwright page. */
async function approvalsPage(electronApp) {
  let found = null;
  await expect
    .poll(() => {
      found = electronApp.windows().find((p) => p.url() === APPROVALS_URL) || null;
      return Boolean(found);
    })
    .toBe(true);
  return found;
}

/** Open a new tab on `url` and wait until `ready` holds in it; returns its guest id. */
async function openTab(electronApp, win, url, ready = 'window.__ready === true') {
  const before = await activeGuestId(win);
  await win.locator('[data-test="new-tab-btn"]').click();
  let id = null;
  await expect
    .poll(async () => {
      id = await activeGuestId(win).catch(() => null);
      return id !== null && id !== before;
    })
    .toBe(true);
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id, url });
  await expect
    .poll(() => inGuest(electronApp, id, `(${ready}) && document.readyState === "complete"`).catch(() => false), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
  return id;
}

/** How many times the window's document has reported a prompt on screen. */
const reportCount = async (electronApp, windowId) =>
  (await approvalsTrace(electronApp)).filter((e) => e.kind === 'shown' && e.window === windowId).length;

/**
 * Wait, in main, for the window's document to report a prompt on screen
 * (its input delay starts there) after `after` earlier reports; resolves as
 * soon as main has it, with the handle and main's time of the report.
 */
function nextReport(electronApp, windowId, after) {
  return electronApp.evaluate(
    (_electron, args) =>
      new Promise((resolve, reject) => {
        const hooks = globalThis.__FREEDOM_TEST_APPROVALS__;
        const deadline = Date.now() + 15_000;
        const check = () => {
          const reports = hooks.trace.filter((e) => e.kind === 'shown' && e.window === args.windowId);
          if (reports.length > args.after) return resolve({ handle: reports.at(-1).handle, at: reports.at(-1).at });
          if (Date.now() > deadline) return reject(new Error('no report'));
          setTimeout(check, 2);
        };
        check();
      }),
    { windowId, after }
  );
}

/** Milliseconds on main's clock since `at`. */
const since = (electronApp, at) => electronApp.evaluate((_electron, t) => performance.now() - t, at);

const docDecides = async (electronApp) =>
  (await approvalsTrace(electronApp)).filter((e) => e.kind === 'decide').length;

/**
 * Click Approve the moment main has the document's next report, inside the
 * delay: nothing reaches main, and the prompt stays. Returns its handle.
 */
async function clickTooSoon(electronApp, docPage, windowId, after) {
  const decidedBefore = await docDecides(electronApp);
  const report = await nextReport(electronApp, windowId, after);
  const box = await docPage.locator('#approve').boundingBox();
  await docPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // The click went in well inside the delay, so this tests what it says.
  expect(await since(electronApp, report.at), 'the click went in too late to test the delay').toBeLessThan(DELAY_MS - 50);
  await sleep(PAST_DELAY_MS);
  expect(await docDecides(electronApp)).toBe(decidedBefore);
  expect((await approvalsState(electronApp))[windowId].shown).toBe(report.handle);
  return report.handle;
}

module.exports = {
  test,
  expect,
  repoRoot,
  APPROVALS_URL,
  VAULT_PASSWORD,
  DELAY_MS,
  PAST_DELAY_MS,
  sleep,
  activeGuestId,
  inGuest,
  approvalsState,
  approvalsTrace,
  promptState,
  pageTrace,
  chromeWindowId,
  approvalsPage,
  openTab,
  reportCount,
  nextReport,
  since,
  docDecides,
  clickTooSoon,
};
