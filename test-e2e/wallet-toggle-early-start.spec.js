// The wallet toggle while the window starts, before the chrome's start-up has
// run. The window fixtures wait that start-up out (chromeStarted,
// chrome-window.js), so this spec launches the app itself and finds the
// chrome without the barrier.
//
// The window is shown at once and the toggle is static markup in index.html,
// so a user can click it before the sidebar has read the Identity & Wallet
// setting. Such a click used to be dropped without a sign: the toggle had no
// listener yet, or had one whose flag still read off. It now ships disabled
// and is enabled once the setting is known, or hidden with the wallet off.
//
// The launch arms the harness's chrome settings gate (test-harness.js), which
// holds the chrome window's settings reads until the spec lets them go, so
// each state is looked at for certain rather than if the spec gets there
// first:
//   1. Every read held. The chrome makes two before any module initializes:
//      the theme's, as index.js is evaluated, and index.js's own on
//      DOMContentLoaded, which it waits on before it initializes the modules.
//      The toggle is the static markup, with no listener.
//   2. Those two let go. The modules initialize, the sidebar's listener goes
//      on, and the sidebar's own read is held. It can't be one of the two:
//      the sidebar asks only once index.js's read is back.
//   3. The gate opened. The sidebar knows the setting.

const { test, expect } = require('./fixtures');
const { chromeWindow } = require('./chrome-window');

// Set in the environment the app is started with, as adblock-first-engine
// does for its gate, and put back straight after.
async function launchWithSettingsGate(relaunchApp) {
  const previous = process.env.FREEDOM_TEST_CHROME_SETTINGS_GATE;
  process.env.FREEDOM_TEST_CHROME_SETTINGS_GATE = '1';
  try {
    const app = await relaunchApp();
    return { app, win: await chromeWindow(app) };
  } finally {
    if (previous === undefined) delete process.env.FREEDOM_TEST_CHROME_SETTINGS_GATE;
    else process.env.FREEDOM_TEST_CHROME_SETTINGS_GATE = previous;
  }
}

const reads = (app) =>
  app.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.chromeSettingsReads());

// A click on a toggle that may be disabled: Playwright's own click would wait
// for it to be enabled, so this one skips that wait, as a user does. A
// disabled button gets no click from it.
const clickAsAUser = (toggle) => toggle.click({ force: true });

// States 1 and 2 above: the toggle is shown but disabled, and a click on it
// leaves the panel shut. Resolves with the app and window at state 2.
async function startUpToTheSidebarsRead(relaunchApp) {
  const { app, win } = await launchWithSettingsGate(relaunchApp);
  const toggle = win.locator('#wallet-toggle-btn');
  const sidebar = win.locator('#sidebar');

  // 1. index.js has asked for the settings and is waiting on them. Once
  // DOMContentLoaded has run, both reads are on their way; main gets them in
  // order. A third would be a new read before the modules start, which this
  // spec has to be told about (the header).
  await expect.poll(() => win.evaluate(() => document.readyState)).not.toBe('loading');
  await expect
    .poll(() => reads(app), { message: "the theme's read and index.js's, held" })
    .toEqual({ holding: true, seen: 2, held: 2 });
  await expect(toggle).toBeVisible();
  await expect(toggle, 'shown before any module has started').toBeDisabled();
  await clickAsAUser(toggle);
  await expect(sidebar).toHaveClass(/\bcollapsed\b/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // 2. Let those two go: the modules initialize, the sidebar among them.
  const sidebarUp = win.waitForEvent('console', {
    predicate: (message) => message.text() === '[Sidebar] Initialized',
  });
  for (let i = 0; i < 2; i += 1) {
    expect(
      await app.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.releaseChromeSettingsRead())
    ).toBe(true);
  }
  await sidebarUp;
  // The sidebar has asked too, and is held with the rest of the start-up's reads.
  await expect.poll(async () => (await reads(app)).held).toBeGreaterThan(0);
  await expect(toggle).toBeVisible();
  await expect(toggle, 'shown before the sidebar knows the setting').toBeDisabled();
  await clickAsAUser(toggle);
  await expect(sidebar).toHaveClass(/\bcollapsed\b/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  return { app, win, toggle, sidebar };
}

const openGate = (app) =>
  app.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.openChromeSettingsGate());

test.describe('wallet on', () => {
  test.use({ seedSettings: { enableIdentityWallet: true } });

  test('the toggle is disabled until the sidebar knows the setting, then opens the panel', async ({
    relaunchApp,
  }) => {
    const { app, toggle, sidebar } = await startUpToTheSidebarsRead(relaunchApp);

    // 3. The sidebar learns the wallet is on.
    await openGate(app);
    await expect(toggle).toBeEnabled();
    await expect(sidebar, 'the clicks while it was disabled did nothing').toHaveClass(
      /\bcollapsed\b/
    );
    await toggle.click();
    await expect(sidebar).not.toHaveClass(/\bcollapsed\b/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('wallet off', () => {
  test.use({ seedSettings: { enableIdentityWallet: false } });

  test('the toggle is disabled until the sidebar knows the setting, then hidden', async ({
    relaunchApp,
  }) => {
    const { app, toggle, sidebar } = await startUpToTheSidebarsRead(relaunchApp);

    // 3. The sidebar learns the wallet is off.
    await openGate(app);
    await expect(toggle).toBeHidden();
    await expect(sidebar).toHaveClass(/\bcollapsed\b/);
  });
});
