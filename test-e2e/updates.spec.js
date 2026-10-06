// Auto-update progress in the hamburger menu and Settings → Updates (#87).
//
// The real updater never runs in test mode (index.js skips initUpdater, and
// there is no update server), so the spec drives the main-process state
// machine through the harness's `dispatchUpdate` — the same entry point
// electron-updater's events use — and checks what both renderers paint from
// the resulting `update:state` broadcast. "Check now" / "Restart to update"
// go through the real IPC path (chrome preload, and the settings webview's
// preload + the main-side sender policy) into updater.js, where the harness's
// recorder stands in for the network and for quitting the app.

const { test, expect } = require('./fixtures');

const dispatch = (app, event) =>
  app.evaluate((_electron, ev) => globalThis.__FREEDOM_TEST_HARNESS__.dispatchUpdate(ev), event);
const requests = (app) => app.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.updaterRequests());

async function openSettingsUpdates(window, electronApp) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  // Updates is a panel of About Freedom since #268.
  await input.fill('freedom://settings/about/updates');
  await input.press('Enter');
  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/settings.html'));
      return Boolean(page);
    })
    .toBe(true);
  await page.waitForSelector('#update-status-row');
  return page;
}

async function openMenu(window) {
  await window.click('#menu-button');
  await expect(window.locator('#menu-dropdown')).toHaveClass(/open/);
}

test('without a running updater both surfaces say so instead of offering a dead button', async ({
  window,
  electronApp,
}) => {
  const settings = await openSettingsUpdates(window, electronApp);
  await expect(settings.locator('#update-status-message')).toHaveText(
    "Updates aren't checked in this session."
  );
  await expect(settings.locator('#update-check-now')).toBeDisabled();
  await expect(settings.locator('#update-current-version')).toHaveText(/^Freedom \d+\.\d+\.\d+/);
  // The existing toggle is still there.
  await expect(settings.locator('#auto-update')).toHaveCount(1);

  await openMenu(window);
  const row = window.locator('#check-updates-btn');
  await expect(row).toHaveAttribute('data-update-status', 'unsupported');
  await expect(window.locator('#update-menu-status')).toHaveText('Unavailable');
  // Clicking it explains why, in Settings → About Freedom's Updates panel,
  // rather than doing nothing.
  await window.locator('[data-test="address-input"]').evaluate((el) => el.blur());
  await row.click();
  await expect(window.locator('#menu-dropdown')).not.toHaveClass(/open/);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(
    'freedom://settings/about/updates'
  );
  await expect(settings.locator('.nav-item.active')).toHaveAttribute('data-target', 'about');
  await expect(settings.locator('#update-status-row')).toBeInViewport();
  expect(await requests(electronApp)).toEqual([]);
});

test('check → download → ready walks both surfaces, and the actions reach the updater', async ({
  window,
  electronApp,
}) => {
  await dispatch(electronApp, { type: 'supported' });
  const settings = await openSettingsUpdates(window, electronApp);

  // Idle: Check now is live and goes through the settings webview's preload
  // and the sender policy to updater.js.
  const checkNow = settings.locator('#update-check-now');
  await expect(checkNow).toBeEnabled();
  await expect(settings.locator('#update-last-checked')).toHaveText(
    'Not checked yet this session.'
  );
  await checkNow.click();
  await expect.poll(() => requests(electronApp)).toEqual(['check']);

  await dispatch(electronApp, { type: 'checking' });
  await expect(checkNow).toBeDisabled();
  await expect(checkNow).toHaveText('Checking…');
  await expect(settings.locator('#update-status-message')).toHaveText('Checking for updates…');
  await openMenu(window);
  await expect(window.locator('#update-menu-label')).toHaveText('Checking for Updates…');
  await expect(window.locator('#check-updates-btn')).toBeDisabled();

  await dispatch(electronApp, { type: 'available', version: '9.9.9' });
  await dispatch(electronApp, {
    type: 'progress',
    percent: 42.6,
    transferred: 42 * 1024 * 1024,
    total: 100 * 1024 * 1024,
    bytesPerSecond: 3 * 1024 * 1024,
  });
  await expect(window.locator('#update-menu-label')).toHaveText('Downloading Update…');
  await expect(window.locator('#update-menu-status')).toHaveText('42%');
  await expect(window.locator('#update-menu-progress')).toBeVisible();
  await expect(settings.locator('#update-status-message')).toHaveText(
    'Downloading Freedom 9.9.9… 42%'
  );
  await expect(settings.locator('#update-progress')).toBeVisible();
  await expect(settings.locator('#update-progress')).toHaveAttribute('aria-valuenow', '42');
  await expect(settings.locator('#update-status-detail')).toHaveText('42 MB of 100 MB · 3.0 MB/s');
  await expect(settings.locator('#update-last-checked')).toHaveText('Last checked just now.');

  const ready = await dispatch(electronApp, { type: 'downloaded', version: '9.9.9' });
  // The harness launches on an explicit --user-data profile, which can't be
  // relaunched into after an install (updater.js getInstallRelaunchMode), so
  // the action is install-and-close here; the default profile gets "Restart".
  expect(ready).toMatchObject({
    installLabel: 'Install update and close',
    menuInstallLabel: 'Install Update and Close',
  });
  // The dot is on the hamburger button itself, so it shows with the menu shut.
  await window.keyboard.press('Escape');
  await expect(window.locator('#menu-dropdown')).not.toHaveClass(/open/);
  await expect(window.locator('#menu-update-badge')).toBeVisible();
  await expect(window.locator('#menu-button')).toHaveAttribute('aria-label', 'Menu (update ready)');

  await expect(settings.locator('#update-status-message')).toHaveText(
    `Freedom 9.9.9 is ready to install. ${ready.installNote}`
  );
  await expect(checkNow).toBeHidden();
  const restart = settings.locator('#update-restart');
  await expect(restart).toBeVisible();
  await expect(restart).toHaveText('Install update and close');
  await restart.click();
  await expect.poll(() => requests(electronApp)).toEqual(['check', 'install']);

  await openMenu(window);
  await expect(window.locator('#update-menu-label')).toHaveText('Install Update and Close');
  await expect(window.locator('#update-menu-status')).toHaveText('v9.9.9');
  await window.locator('#check-updates-btn').click();
  await expect.poll(() => requests(electronApp)).toEqual(['check', 'install', 'install']);
});

test('a Settings tab opened after the update landed hydrates from getUpdateState', async ({
  window,
  electronApp,
}) => {
  await dispatch(electronApp, { type: 'supported' });
  await dispatch(electronApp, { type: 'available', version: '9.9.9' });
  await dispatch(electronApp, { type: 'downloaded', version: '9.9.9' });

  const settings = await openSettingsUpdates(window, electronApp);
  await expect(settings.locator('#update-restart')).toBeVisible();
  await expect(settings.locator('#update-status-row')).toHaveAttribute(
    'data-update-status',
    'ready'
  );
  await expect(window.locator('#menu-update-badge')).toBeVisible();
});

test('a failed check is shown and can be retried', async ({ window, electronApp }) => {
  await dispatch(electronApp, { type: 'supported' });
  await dispatch(electronApp, { type: 'checking' });
  await dispatch(electronApp, { type: 'error', kind: 'network' });

  const settings = await openSettingsUpdates(window, electronApp);
  await expect(settings.locator('#update-status-message')).toHaveText(
    "Couldn't reach the update server. Freedom will try again later."
  );
  await expect(settings.locator('#update-check-now')).toBeEnabled();

  await openMenu(window);
  await expect(window.locator('#update-menu-status')).toHaveText('Failed');
  await expect(window.locator('#check-updates-btn')).toBeEnabled();
});

test('with automatic checks off the status line stops promising background checks', async ({
  window,
  electronApp,
}) => {
  await dispatch(electronApp, { type: 'supported' });
  const settings = await openSettingsUpdates(window, electronApp);
  const message = settings.locator('#update-status-message');
  const toggle = settings.locator('#auto-update');
  await expect(message).toHaveText('Freedom checks for updates automatically.');
  await expect(toggle).toBeChecked();

  // Flipping the real switch re-words the line without any updater event.
  await settings.locator('label.toggle:has(#auto-update)').click();
  await expect(toggle).not.toBeChecked();
  await expect(message).toHaveText('Automatic update checks are off.');

  // A failed manual check with the switch off doesn't promise a retry.
  await dispatch(electronApp, { type: 'checking' });
  await dispatch(electronApp, { type: 'error', kind: 'network' });
  await expect(message).toHaveText("Couldn't reach the update server. Automatic checks are off, so Freedom won't retry on its own.");
  await expect(settings.locator('#update-check-now')).toBeEnabled();
  // The hamburger row shows the same sentence as its tooltip; its button is
  // "Check for Updates…", not "Check now", so the sentence names neither.
  const menuRow = window.locator('#check-updates-btn');
  await expect(menuRow).toHaveAttribute(
    'title',
    "Couldn't reach the update server. Automatic checks are off, so Freedom won't retry on its own."
  );

  await settings.locator('label.toggle:has(#auto-update)').click();
  await expect(message).toHaveText(
    "Couldn't reach the update server. Freedom will try again later."
  );
});
