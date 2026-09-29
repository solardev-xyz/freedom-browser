// Packaged smoke — step 1 of the release-process.md §6 checklist:
// "the app opens cleanly — no crash dialog, main window appears".
//
// Runs against the binary named by FREEDOM_E2E_EXECUTABLE (see
// playwright.config.js). The failure this guards against is a package that
// cannot start at all: a missing asar entry, a native module built for the
// wrong ABI, an extraResources path that only resolves in a source tree.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');

test('the packaged app launches with its browser chrome', async ({ window, electronApp }) => {
  await expect(window.locator('[data-test="address-input"]')).toBeVisible();
  await expect(window.locator('[data-test="tab-bar"]')).toBeVisible();
  await expect(window.locator('[data-test="new-tab-btn"]')).toBeVisible();
  expect(await window.title()).toContain('Freedom');

  // Exactly one BrowserWindow: the main window, with no crash/error dialog
  // window alongside it. Counted in the main process (BrowserWindow.
  // getAllWindows(), via the harness's app-facts op), not from the CDP page
  // list, which also holds the home page's webview.
  const { windows } = await electronApp.appFacts();
  expect(windows).toHaveLength(1);
  expect(windows[0].destroyed).toBe(false);
  expect(windows[0].title).toContain('Freedom');
});

test('the binary under test really is a packaged Electron build', async ({
  window,
  electronApp,
}) => {
  // Read in the main process (the harness's app-facts op; packaged builds have
  // no main-process inspector to evaluate in, see packaged-launch.js).
  const facts = await electronApp.appFacts();
  const build = {
    electron: facts.electron,
    chrome: facts.chrome,
    packaged: facts.packaged,
    // Trips if the suite were pointed at a source checkout by mistake.
    executable: facts.execPath,
  };

  expect(build.electron).toMatch(/^\d+\.\d+/);
  expect(build.chrome).toMatch(/^\d+\./);
  expect(build.packaged).toBe(true);
  // process.execPath is symlink-resolved (/proc/self/exe), so compare real
  // paths: the .deb installs /usr/bin/freedom -> /etc/alternatives/freedom ->
  // /opt/Freedom/freedom, and a relative dist/linux-unpacked/freedom is fine too.
  expect(fs.realpathSync(build.executable)).toBe(
    fs.realpathSync(path.resolve((process.env.FREEDOM_E2E_EXECUTABLE || '').trim()))
  );

  // The renderer has to be running on that same Electron; anything else would
  // mean the window we are driving did not come from this package.
  const userAgent = await window.evaluate(() => navigator.userAgent);
  expect(userAgent).toContain(`Electron/${build.electron}`);
  expect(userAgent).toContain(`Chrome/${build.chrome}`);
});
