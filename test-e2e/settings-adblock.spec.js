// Ad Blocking settings section — drives the actual freedom://settings page
// inside its webview: default toggle states, engine status line, and the
// allowlist add/remove round-trip through the adblock IPC surface.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('./fixtures');

// Launch the app with FREEDOM_ADBLOCK_DIR pointed at an empty directory, so
// the engine finds no filter lists at all (the state #274 is about). The
// updater's own dir under the scratch profile is empty too.
async function launchWithoutLists(relaunchApp) {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-e2e-no-lists-'));
  const previous = process.env.FREEDOM_ADBLOCK_DIR;
  process.env.FREEDOM_ADBLOCK_DIR = emptyDir;
  try {
    const app = await relaunchApp();
    const window = await app.firstWindow();
    await window.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    return { app, window };
  } finally {
    if (previous === undefined) delete process.env.FREEDOM_ADBLOCK_DIR;
    else process.env.FREEDOM_ADBLOCK_DIR = previous;
  }
}

const ADBLOCK_TOGGLES = [
  '#adblock-enabled',
  '#adblock-ads',
  '#adblock-privacy',
  '#adblock-cookies',
  '#adblock-annoyances',
  '#adblock-autoupdate',
];

async function openAdblockSettings(window, electronApp) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/adblock');
  await input.press('Enter');

  // The settings page renders inside a <webview>; its guest webContents
  // surfaces as an additional Playwright page.
  let settingsPage;
  await expect
    .poll(() => {
      settingsPage = electronApp.windows().find((p) => p.url().includes('/pages/settings.html'));
      return Boolean(settingsPage);
    })
    .toBe(true);
  // Toggle inputs are visually hidden by the custom-slider CSS; wait on a
  // visible element of the section instead.
  await settingsPage.waitForSelector('#adblock-status');
  return settingsPage;
}

test('adblock section shows iOS-matching defaults and engine status', async ({
  window,
  electronApp,
}) => {
  const page = await openAdblockSettings(window, electronApp);

  await expect(page.locator('#adblock-enabled')).toBeChecked();
  await expect(page.locator('#adblock-ads')).toBeChecked();
  await expect(page.locator('#adblock-privacy')).toBeChecked();
  await expect(page.locator('#adblock-cookies')).not.toBeChecked();
  await expect(page.locator('#adblock-annoyances')).not.toBeChecked();

  // Bundled lists exist in the dev tree (assets/adblock), so the status
  // line names a lists version; the engine may still be compiling.
  await expect(page.locator('#adblock-status')).toContainText('Filter lists');

  // With lists present every toggle stays live, and a category row's helper
  // is its live rule count alone, no filter-list brand name (#274).
  for (const selector of ADBLOCK_TOGGLES) {
    await expect(page.locator(selector)).toBeEnabled();
  }
  await expect(page.locator('#adblock-cookies-help')).toHaveText(/^\d[\d,.\s]* rules$/);
  await expect(page.locator('#adblock-enabled-row')).not.toHaveClass(/\bdisabled\b/);
});

test('with no filter lists the section says once it cannot run and disables its toggles', async ({
  relaunchApp,
}) => {
  const { app, window } = await launchWithoutLists(relaunchApp);
  const page = await openAdblockSettings(window, app);

  await expect(page.locator('#adblock-status')).toHaveText(
    'No filter lists available. Ad blocking cannot run.'
  );
  // Settings are untouched (master still on); only the controls are inert.
  await expect(page.locator('#adblock-enabled')).toBeChecked();
  for (const selector of ADBLOCK_TOGGLES.filter((s) => s !== '#adblock-autoupdate')) {
    await expect(page.locator(selector)).toBeDisabled();
  }
  for (const row of ['enabled', 'ads', 'privacy', 'cookies', 'annoyances']) {
    await expect(page.locator(`#adblock-${row}-row`)).toHaveClass(/\bdisabled\b/);
  }
  // Auto-update stays usable: switching it off is how a user stops the
  // Swarm list updater's background fetches while the master is held on.
  const autoUpdate = page.locator('#adblock-autoupdate');
  await expect(autoUpdate).toBeChecked();
  await expect(autoUpdate).toBeEnabled();
  await page.locator('#adblock-autoupdate-row .slider').click();
  await expect(autoUpdate).not.toBeChecked();
  await expect(autoUpdate).toBeEnabled();
});

test.describe('with no filter lists and ad blocking switched off', () => {
  test.use({ seedSettings: { adblockEnabled: false } });

  test('the master switch stays usable so the list updater can run', async ({ relaunchApp }) => {
    const { app, window } = await launchWithoutLists(relaunchApp);
    const page = await openAdblockSettings(window, app);

    await expect(page.locator('#adblock-status')).toHaveText(
      'No filter lists available. Ad blocking cannot run.'
    );
    const master = page.locator('#adblock-enabled');
    await expect(master).not.toBeChecked();
    await expect(master).toBeEnabled();

    // Switching it on is the way out; once on, it is frozen like the rest.
    await page.locator('#adblock-enabled-row .slider').click();
    await expect(master).toBeChecked();
    await expect(master).toBeDisabled();
    await expect(page.locator('#adblock-ads')).toBeDisabled();
  });
});

test('ad blocking and site permissions are separate navigable sections', async ({
  window,
  electronApp,
}) => {
  const page = await openAdblockSettings(window, electronApp);
  const adblockNav = page.locator('.nav-item[data-target="adblock"]');
  const permissionsNav = page.locator('.nav-item[data-target="permissions"]');

  await expect(adblockNav).toHaveCount(1);
  await expect(adblockNav).toContainText('Ad Blocking');
  await expect(permissionsNav).toHaveCount(1);
  await expect(permissionsNav).toContainText('Site Permissions');
  await expect(adblockNav).toHaveClass(/active/);
  await expect(page.locator('#adblock')).not.toHaveClass(/hidden/);

  await permissionsNav.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#permissions');
  await expect(permissionsNav).toHaveClass(/active/);
  await expect(page.locator('#permissions')).not.toHaveClass(/hidden/);
  await expect(page.locator('#adblock')).toHaveClass(/hidden/);

  await adblockNav.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#adblock');
  await expect(adblockNav).toHaveClass(/active/);
  await expect(page.locator('#adblock')).not.toHaveClass(/hidden/);
});

test('allowlist hosts can be added and removed through the section', async ({
  window,
  electronApp,
}) => {
  const page = await openAdblockSettings(window, electronApp);

  const field = page.locator('#adblock-allowlist-input');
  await field.click();
  await field.fill('WWW.Example.COM');
  await expect(field).toHaveValue('WWW.Example.COM');
  await page.locator('#adblock-allowlist-add').click();

  // Rendered normalized, and live in the main-process service state.
  const row = page.locator('#adblock-allowlist-list .row-label');
  await expect(row).toHaveText('example.com');
  const serviceHosts = () =>
    electronApp.evaluate(() =>
      process.mainModule.require('./src/main/adblock/allowlist-store').getAllowlistedHosts()
    );
  expect(await serviceHosts()).toEqual(['example.com']);

  await page.locator('#adblock-allowlist-list button').click();
  await expect(page.locator('#adblock-allowlist-list .row-label')).toHaveCount(0);
  expect(await serviceHosts()).toEqual([]);
});
