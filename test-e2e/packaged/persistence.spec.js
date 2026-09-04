// Packaged smoke — step 6 of the release-process.md §6 checklist:
// "change one trivial setting (e.g. theme), close the app fully, reopen,
// confirm the change stuck".
//
// Theme is the playbook's example and the setting `settings.spec.js` toggles
// from source. What makes this a *packaging* test is the second launch: it
// starts the same executable again against the same profile directory, so a
// package that cannot persist its userData (a sandboxed path, a store that
// only resolves in a source tree, a settings file written somewhere the next
// launch does not read) fails here instead of in a user's hands.

const fs = require('fs');
const path = require('path');

const { test, expect, browserWindow } = require('../fixtures');

// Start from an explicit theme rather than the default "system": "system"
// renders as light or dark depending on the host, whereas explicit "dark"
// always leaves <html> without data-theme and explicit "light" always sets it.
// The assertions below are then the same on every machine.
test.use({ seedSettings: { theme: 'dark' } });

test('a theme change survives a full quit and relaunch', async ({
  window,
  electronApp,
  relaunchApp,
  userDataDir,
}) => {
  const html = window.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', 'light');

  await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));
  await expect(html).toHaveAttribute('data-theme', 'light');

  // The change has to reach disk before the process goes away, otherwise the
  // relaunch would only be re-reading a race. saveSettings writes
  // <userData>/settings.json; poll for it so a future async write does not
  // turn this into a flake.
  const settingsFile = path.join(userDataDir, 'settings.json');
  await expect
    .poll(() => {
      try {
        return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).theme;
      } catch {
        return null;
      }
    })
    .toBe('light');

  // Full quit: every window closed and the main process gone, not a reload.
  await electronApp.close();

  const relaunched = await relaunchApp();
  const relaunchedWindow = await browserWindow(relaunched);

  // Had the setting not survived, the seeded "dark" would render here with no
  // data-theme attribute at all.
  await expect(relaunchedWindow.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(
    await relaunchedWindow.evaluate(async () => (await window.electronAPI.getSettings()).theme)
  ).toBe('light');
});
