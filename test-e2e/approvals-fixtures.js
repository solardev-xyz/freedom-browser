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
const { chromeStarted } = require('./chrome-window');

const repoRoot = path.resolve(__dirname, '..');
const APPROVALS_URL = pathToFileURL(path.join(repoRoot, 'src', 'renderer', 'approvals', 'approvals.html')).href;
const VAULT_PASSWORD = 'Freedom-E2E-Approvals-2026!';
const DELAY_MS = 500;
// Comfortably past the delay, on a loaded CI runner too.
const PAST_DELAY_MS = 700;

/**
 * Seed a vault for a launch: the wallet on and the nodes off in
 * `userDataDir`'s settings, and a fresh vault (VAULT_PASSWORD) whose wallet
 * list is 'Main Wallet' (index 0) and then `wallets` (a Ledger or a phone
 * account main's list should hold), with `activeWalletIndex` active.
 * Resolves with the identity directory (FREEDOM_IDENTITY_DATA).
 */
async function seedVault(userDataDir, { wallets = [], activeWalletIndex = 0 } = {}) {
  const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));
  const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f-approvals-identity-'));
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
      activeWalletIndex,
      derivedWallets: [{ index: 0, name: 'Main Wallet', address: keys.userWallet.address }, ...wallets],
    }),
    'utf-8'
  );
  return identityDir;
}

const test = base.extend({
  // A vault with one account ('Main Wallet'), for the specs that connect,
  // sign or unlock; the settings turn the wallet on and the nodes off.
  withVault: [false, { option: true }],
  // More accounts for main's wallet list after it (a Ledger, a phone), and
  // the active one: `seedVault`'s options. Implies a vault.
  vaultWallets: [null, { option: true }],
  electronApp: async ({ userDataDir, withVault, vaultWallets }, use) => {
    const env = {
      ...process.env,
      FREEDOM_TEST_MODE: '1',
      FREEDOM_TEST_USER_DATA: userDataDir,
      FREEDOM_APPROVALS_DOCUMENT: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    };
    let identityDir = null;
    if (withVault || vaultWallets) {
      identityDir = await seedVault(userDataDir, vaultWallets || {});
      env.FREEDOM_IDENTITY_DATA = identityDir;
    }
    const app = await electron.launch({ args: ['.'], cwd: repoRoot, env, timeout: 20_000 });
    await use(app);
    await closeApp(app);
    if (identityDir) fs.rmSync(identityDir, { recursive: true, force: true });
  },
  // The chrome, not the approvals document, once its start-up has run: the
  // specs drive the sidebar and the wallet's screens straight away
  // (chrome-window.js).
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

const docDecides = async (electronApp) =>
  (await approvalsTrace(electronApp)).filter((e) => e.kind === 'decide').length;

// The decisions that reached main from the window's document.
const decidesIn = async (electronApp, windowId) =>
  (await approvalsTrace(electronApp)).filter((e) => e.kind === 'decide' && e.window === windowId);

// How many times an early-input probe runs before it gives up.
const EARLY_PROBES = 5;

/** While on, main refuses every decision that passes its own checks ('held'). */
const holdDecisions = (electronApp, on) =>
  electronApp.evaluate((_electron, value) => globalThis.__FREEDOM_TEST_APPROVALS__.holdDecisions(value), on);

/**
 * Send the window's document its prompt again, as main does when the
 * document loads: it renders it afresh (focus on Reject, the delay started
 * again) and reports it on screen again.
 */
const reshow = (electronApp, windowId) =>
  electronApp.evaluate((_electron, id) => globalThis.__FREEDOM_TEST_APPROVALS__.reshow(id), windowId);

/**
 * Probe the input delay on the prompt the window's document reports next,
 * with no bound on the host's latency (Codex, #1210). Main holds every
 * decision meanwhile, so one that a slow host let in after the delay
 * decides nothing: `attempt(report)` says whether it went in early, and if
 * not, the probe runs again on the prompt shown afresh (`reshow`). A delay
 * that let every attempt in fails after EARLY_PROBES, a fast host's too.
 */
async function probeEarly(electronApp, windowId, after, attempt) {
  await holdDecisions(electronApp, true);
  try {
    let reports = after;
    for (let probe = 1; ; probe += 1) {
      const report = await nextReport(electronApp, windowId, reports);
      if (await attempt(report)) return report;
      expect(probe, `each of ${EARLY_PROBES} attempts went in after the delay`).toBeLessThan(EARLY_PROBES);
      reports = await reportCount(electronApp, windowId);
      expect(await reshow(electronApp, windowId)).toBe(true);
    }
  } finally {
    await holdDecisions(electronApp, false);
  }
}

/**
 * Click Approve the moment main has the document's next report, inside the
 * delay: nothing reaches main, and the prompt stays. Returns its handle.
 */
async function clickTooSoon(electronApp, docPage, windowId, after) {
  const report = await probeEarly(electronApp, windowId, after, async ({ handle }) => {
    const before = (await decidesIn(electronApp, windowId)).length;
    const approve = docPage.locator('#approve');
    const box = await approve.boundingBox();
    await docPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(PAST_DELAY_MS);
    // A click the document let in has had main's answer by now.
    await expect(approve).toBeEnabled();
    expect((await approvalsState(electronApp))[windowId].shown).toBe(handle);
    const reached = (await decidesIn(electronApp, windowId)).slice(before);
    // Let in after the delay (a slow host): refused by main, decided nothing.
    for (const entry of reached) expect(['held', 'too-soon']).toContain(entry.reason);
    return reached.length === 0;
  });
  return report.handle;
}

/**
 * Send an approval straight from the document the moment main has its
 * report: main refuses it as too soon. Returns the report.
 */
async function decideTooSoon(electronApp, docPage, windowId, after) {
  return probeEarly(electronApp, windowId, after, async ({ handle }) => {
    const result = await docPage.evaluate((h) => window.approvals.decide(h, true, undefined), handle);
    // Sent after the delay (a slow host): held, decided nothing.
    if (result?.reason === 'held') return false;
    expect(result).toEqual({ ok: false, reason: 'too-soon' });
    return true;
  });
}

/**
 * Wait until window `windowId`'s panel shows a prompt whose report main
 * holds, and main's input delay has passed for it: PAST_DELAY_MS on main's
 * clock since the last report, with no move, new view or hide since. Resolves
 * with the handle it shows.
 */
async function panelArmed(electronApp, windowId, { timeout = 30_000 } = {}) {
  let handle = null;
  await expect
    .poll(
      async () => {
        handle = await electronApp.evaluate(
          (_electron, args) => {
            const hooks = globalThis.__FREEDOM_TEST_APPROVALS__;
            const panel = hooks.state()[args.id];
            if (!panel || !panel.visible || !panel.shown || panel.reported !== panel.shown) return null;
            const last = hooks.trace
              .filter((e) => e.window === args.id && ['shown', 'moved', 'prompt', 'hidden'].includes(e.kind))
              .at(-1);
            if (!last || last.kind !== 'shown' || last.handle !== panel.shown) return null;
            return performance.now() - last.at >= args.past ? panel.shown : null;
          },
          { id: windowId, past: PAST_DELAY_MS }
        );
        return handle;
      },
      { timeout, message: `waiting for window ${windowId}'s panel to show a prompt past its delay` }
    )
    .not.toBeNull();
  return handle;
}

/**
 * Decide what the first window's panel shows, as a user does: once it shows
 * `heading` (when given) and main's delay has passed, with the vault's
 * password typed first for an unlock (`password`) and the boxes labelled in
 * `check` ticked (the panel takes no input during its delay). Approves unless `approve`
 * is false. A press main still counts as too soon (a slow host) is made
 * again. Resolves with the handle decided.
 */
async function decideInPanel(electronApp, { approve = true, heading, password, check = [], windowId, panel } = {}) {
  const id = windowId ?? (await chromeWindowId(electronApp));
  const doc = panel ?? (await approvalsPage(electronApp));
  if (heading) await expect(doc.locator('#heading')).toHaveText(heading, { timeout: 30_000 });
  for (let attempt = 1; ; attempt += 1) {
    const handle = await panelArmed(electronApp, id);
    // The panel takes no input during its delay: its choices are made after.
    if (password !== undefined) await doc.fill('#body input[type="password"]', password);
    for (const label of check) await doc.getByLabel(label).check();
    const before = (await decidesIn(electronApp, id)).length;
    await doc.click(approve ? '#approve' : '#reject');
    // Main's answer: the decision recorded, or (for one that waits on its
    // request, a device's signature say) the prompt gone or waiting.
    let seen = null;
    await expect
      .poll(
        async () => {
          const entry = (await decidesIn(electronApp, id))[before];
          if (entry) {
            seen = entry.ok ? 'decided' : entry.reason;
            return seen;
          }
          const panel = (await approvalsState(electronApp))[id];
          seen = !panel || panel.shown !== handle || panel.waiting ? 'decided' : null;
          return seen;
        },
        { timeout: 15_000, message: `waiting for main's answer to the panel's ${approve ? 'approval' : 'rejection'}` }
      )
      .not.toBeNull();
    if (seen === 'decided') return handle;
    if (seen !== 'too-soon' || attempt >= 3) throw new Error(`the panel's decision was refused: ${seen}`);
  }
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
  docDecides,
  holdDecisions,
  reshow,
  clickTooSoon,
  decideTooSoon,
  panelArmed,
  decideInPanel,
  seedVault,
};
