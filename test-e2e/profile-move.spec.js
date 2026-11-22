// PRF-9's move at startup (freedom-core design 0013, "The move"; B3): main
// runs `freedom-cored profile migrate` before anything reads the profile, so
// a profile's Freedom-owned entries live in `<userData>/freedom/`.
//
// - **A new profile** starts in the new layout (the core's empty move):
//   `freedom/layout.json`, and the placeholder file at `identity`.
// - **A profile in the root layout**, as a build before the move left it,
//   moves at its start, and the app reads its settings from `freedom/`.
// - **A catalog profile** (catalog mode, `profile open` through the core)
//   starts in the new layout too.
// - **The guard:** after a full start and a quit, no name the move takes
//   (freedom-root.js's MOVED_ENTRIES) is at the profile's root but the
//   placeholder. A getter that skipped the Freedom root would make one.
//
// Needs freedom-cored (`npm run core:download`, or FREEDOM_CORED_PATH), as
// every launch does. A development build without it runs no move (MD1),
// which src/main/profile-open.test.js covers.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { test: catalogTest } = require('./profiles-fixtures');
const { closeApp } = require('./close-app');
const { MOVED_ENTRIES, PLACEHOLDER } = require('../src/main/freedom-root');

// Names the move takes found at the profile's root, but the placeholder file.
function movedNamesAtRoot(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => MOVED_ENTRIES.includes(name))
    .filter((name) => !(name === PLACEHOLDER && fs.lstatSync(path.join(dir, name)).isFile()));
}

function expectNewLayout(dir) {
  expect(fs.existsSync(path.join(dir, 'freedom', 'layout.json'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'freedom', '.move.json'))).toBe(false);
  expect(fs.lstatSync(path.join(dir, PLACEHOLDER)).isFile()).toBe(true);
}

test.describe('a new profile', () => {
  // No settings seeded: the profile directory is empty at the first start.
  test.use({ aiEnabled: null });

  test('starts in the new layout, and a full start leaves no moved name at the root', async ({
    electronApp,
    window,
    userDataDir,
  }) => {
    expectNewLayout(userDataDir);
    // A store written through main's getters lands in freedom/.
    await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));
    await expect
      .poll(() => fs.existsSync(path.join(userDataDir, 'freedom', 'settings.json')))
      .toBe(true);
    await closeApp(electronApp);
    expectNewLayout(userDataDir);
    expect(movedNamesAtRoot(userDataDir)).toEqual([]);
  });
});

test.describe('a profile in the root layout', () => {
  // Seeded at the root (freedomPath before the first start), as a build
  // before the move kept it.
  test.use({ seedSettings: { theme: 'light' } });

  test('moves at its start, and the app reads its settings from freedom/', async ({
    electronApp,
    window,
    userDataDir,
  }) => {
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
    expectNewLayout(userDataDir);
    expect(fs.existsSync(path.join(userDataDir, 'settings.json'))).toBe(false);
    const moved = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'freedom', 'settings.json'), 'utf8')
    );
    expect(moved.theme).toBe('light');
    await closeApp(electronApp);
    expect(movedNamesAtRoot(userDataDir)).toEqual([]);
  });
});

catalogTest(
  'a catalog profile starts in the new layout',
  async ({ electronApp, window, devHome }) => {
    await expect(window.locator('[data-test="address-input"]')).toBeVisible();
    const dir = path.join(devHome, 'Profiles', 'default');
    expectNewLayout(dir);
    await closeApp(electronApp);
    expect(movedNamesAtRoot(dir)).toEqual([]);
  }
);
