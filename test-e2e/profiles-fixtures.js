// Fixtures for the profile-lifecycle E2E suite.
//
// Unlike the default `fixtures.js`, this launches the app in *catalog* mode so
// the profile manager is actually available. The catalog (create / list /
// switch / rename / delete) is only wired up when the active profile resolves
// with `source: 'catalog'` — and `resolveProfile` (src/main/profile-resolver.js)
// takes that path only in dev launches that are NOT pinned to a fixed
// `FREEDOM_TEST_USER_DATA` dir. Setting `FREEDOM_TEST_USER_DATA` (what
// fixtures.js does) forces `source: 'test-user-data'`, which disables the whole
// profile manager — so this suite must avoid it.
//
// Instead we point `FREEDOM_DEV_HOME` at a per-run temp dir: the dev app-data
// root (and thus the profile catalog) lives there, fully isolated per test, and
// the default profile is created/opened under `<devHome>/Profiles/default`.
//
// `FREEDOM_TEST_MODE=1` still installs the in-process harness (stubbed
// protocols/nodes, no real Bee/IPFS spawn) and — critically for these specs —
// the profile-launch recorder, so "open profile" records the intended launch
// instead of cold-starting a second Electron instance. See src/main/test-harness.js.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');

const test = base.extend({
  // Profile to launch as (`FREEDOM_PROFILE`), or null for the normal bare
  // launch that opens `default`. A spec that needs `default` to be a
  // *non-active* profile — e.g. to delete it (#124) — sets this via
  // `test.use({ launchProfile: 'work' })`; the first run still registers
  // `default` alongside it.
  launchProfile: [null, { option: true }],

  // Per-test isolated dev-home (the profile catalog root).
  // eslint-disable-next-line no-empty-pattern
  devHome: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-e2e-profiles-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — leftover dirs in /tmp are harmless.
    }
  },

  electronApp: async ({ devHome, launchProfile }, use) => {
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        // Catalog mode, isolated per run. NOTE: deliberately no
        // FREEDOM_TEST_USER_DATA — that would disable the profile manager.
        FREEDOM_DEV_HOME: devHome,
        ...(launchProfile ? { FREEDOM_PROFILE: launchProfile } : {}),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      // Catalog bootstrap (ensure default profile + acquire lock) adds a little
      // over the plain harness launch; keep generous headroom for cold CI.
      timeout: 30_000,
    });

    await use(app);

    try {
      await app.close();
    } catch {
      // Window may already have been closed by the spec.
    }
  },

  window: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await use(win);
  },
});

module.exports = { test, expect };
