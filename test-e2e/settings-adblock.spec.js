// Ad Blocking settings section — drives the actual freedom://settings page
// inside its webview: default toggle states, engine status line, and the
// allowlist add/remove round-trip through the adblock IPC surface.

const { test, expect } = require('./fixtures');

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
      settingsPage = electronApp
        .windows()
        .find((p) => p.url().includes('/pages/settings.html'));
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
