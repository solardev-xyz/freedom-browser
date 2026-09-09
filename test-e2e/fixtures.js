// Custom Playwright fixtures for the Freedom renderer E2E suite.
//
// `electronApp` launches the app from the repo root with FREEDOM_TEST_MODE=1
// and a per-run temp `userData` dir, so each test gets clean settings,
// bookmarks, and history. `window` is the first BrowserWindow page.
// `harness` exposes ergonomic helpers backed by the main-process test
// harness (see `src/main/test-harness.js`).
//
// Setting `FREEDOM_E2E_EXECUTABLE` points the same fixtures at a *packaged*
// Freedom binary (`dist/linux-unpacked/freedom`, `/opt/Freedom/freedom`, an
// extracted AppImage) instead of the source tree — that is how the
// `packaged` project (`npm run test:e2e:packaged`) smoke-tests a release
// artifact. Unset, everything below behaves exactly as it did before.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { isPackagedRun, packagedLaunchTarget } = require('./packaged-launch');

const repoRoot = path.resolve(__dirname, '..');

// Launch options for one app instance against `userDataDir`. Which binary is
// launched (source tree vs FREEDOM_E2E_EXECUTABLE) and whether the sandbox is
// opted out of is decided in packaged-launch.js, shared with live-fixtures.js.
function launchOptions(userDataDir) {
  return {
    ...packagedLaunchTarget(),
    cwd: repoRoot,
    env: {
      ...process.env,
      FREEDOM_TEST_MODE: '1',
      FREEDOM_TEST_USER_DATA: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      // Force a deterministic locale so menu accelerators don't drift
      // by region (CmdOrCtrl resolves to Cmd on darwin regardless).
      LANG: 'en_US.UTF-8',
    },
    // A freshly installed package has a cold asar and cold shared libraries;
    // give its first launch more room than a warm source run needs.
    timeout: isPackagedRun() ? 45_000 : 20_000,
  };
}

// Launch one Freedom instance against `userDataDir`. Exported through the
// `relaunchApp` fixture rather than directly so every app a spec opens is
// closed at teardown.
function launchApp(userDataDir) {
  return electron.launch(launchOptions(userDataDir));
}

// First BrowserWindow, waited until the browser chrome has mounted. The
// address bar is the last toolbar element initialized; presence here implies
// tab bar, bookmarks bar, and menus are all live.
async function browserWindow(app) {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return win;
}

// We want a stable settings shape across runs. The main-process settings
// store loads JSON from `<userData>/settings.json` and merges over
// DEFAULT_SETTINGS, so writing this file before app launch lets specs
// pick known initial values without going through the saveSettings IPC
// (which broadcasts events and would fight with the renderer's bootstrap).
function seedSettings(userDataDir, overrides) {
  if (!overrides) return;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(overrides, null, 2),
    'utf-8'
  );
}

const test = base.extend({
  // Explicit per-test option: seed settings.json before launch.
  // Useful when a spec needs to start from a non-default UI state
  // (e.g., bookmarks bar visible, theme=light) without the racing
  // problem above.
  seedSettings: [null, { option: true }],

  // The scratch profile this test's app instances run against. Kept separate
  // from `electronApp` so a spec can shut the app down and start another one
  // on the same on-disk state (see `relaunchApp`).
  userDataDir: async ({ seedSettings: settingsOverride }, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-e2e-'));
    seedSettings(dir, settingsOverride);

    await use(dir);

    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — leftover dirs in /tmp are harmless.
    }
  },

  electronApp: async ({ userDataDir }, use) => {
    const app = await launchApp(userDataDir);

    await use(app);

    try {
      await app.close();
    } catch {
      // Window may already have been closed by the spec.
    }
  },

  // Start another instance of the same executable against the same scratch
  // profile, for specs that need state to survive a real process restart.
  // Close the running instance first (`await electronApp.close()`): Freedom
  // holds a per-profile lock, so a second instance on a live profile just
  // asks the first one to focus itself and exits.
  relaunchApp: async ({ userDataDir }, use) => {
    const started = [];

    await use(async () => {
      const app = await launchApp(userDataDir);
      started.push(app);
      return app;
    });

    for (const app of started) {
      try {
        await app.close();
      } catch {
        // Already closed by the spec.
      }
    }
  },

  window: async ({ electronApp }, use) => {
    await use(await browserWindow(electronApp));
  },

  // High-level helpers backed by the main-process test harness. Each
  // method round-trips through electronApp.evaluate() so it runs in the
  // main process where the harness state lives.
  harness: async ({ electronApp }, use) => {
    const setContentFixture = async (url, fixture) => {
      await electronApp.evaluate(
        ({ ipcMain: _ipcMain }, { url: u, fixture: f }) => {
          globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(u, f);
        },
        { url, fixture }
      );
    };

    const setEnsFixture = async (name, result) => {
      await electronApp.evaluate(
        ({ ipcMain: _ipcMain }, { name: n, result: r }) => {
          globalThis.__FREEDOM_TEST_HARNESS__.setEnsFixture(n, r);
        },
        { name, result }
      );
    };

    const setProbeFixture = async (hash, outcome) => {
      await electronApp.evaluate(
        ({ ipcMain: _ipcMain }, { hash: h, outcome: o }) => {
          globalThis.__FREEDOM_TEST_HARNESS__.setProbeFixture(h, o);
        },
        { hash, outcome }
      );
    };

    const reset = async () => {
      await electronApp.evaluate(() => {
        globalThis.__FREEDOM_TEST_HARNESS__.resetFixtures();
      });
    };

    const state = async () => {
      return electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.state());
    };

    await use({ setContentFixture, setEnsFixture, setProbeFixture, reset, state });
  },
});

// Wait until a chrome surface that has just appeared over the page can take a
// synthetic click.
//
// A Playwright click is dispatched by the *browser* process, which picks the
// widget it goes to by hit-testing the point against the compositor's own
// hit-test data. That data only changes when the renderer produces a frame, so
// in the window between "the menu is in the DOM" and "the menu is in a
// submitted frame", the browser still believes the point belongs to the
// `<webview>` guest behind it and routes the whole click there — the embedder
// sees no mousemove, no mousedown, nothing, and Playwright's own actionability
// checks cannot see it either (they run in the renderer, where the DOM is
// already right). The guest takes focus from the click it was handed, which is
// the only trace of it in the chrome.
//
// It is a `<webview>` property, not a bug in any one menu: the same probe
// (click N ms after opening the hamburger) is swallowed at N=0 on `main` and on
// this branch alike, and lands from ~8 ms on both. A real user cannot hit it —
// the menu opens *on* their click and the pointer has to travel to a row — but
// a synthetic click that arrives in the same frame does, and a loaded CI runner
// stretches "the same frame" to tens of milliseconds.
//
// Two `requestAnimationFrame`s are the wait for exactly the missing thing: the
// callback of the second runs at the start of the frame after the one that
// carried the popover, so a frame provably went out. It is not a timeout —
// where frames are slow the wait is long, which is the case that needs it.
const waitForPopoverFrame = (window) =>
  window.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );

// Convenience: an arbitrary 64-char Swarm hex hash for fixture-driven
// `bzz://` navigation. Specs should treat this as opaque.
const SAMPLE_BZZ_HASH = 'a'.repeat(64);
const SAMPLE_IPFS_CID = 'bafybeib' + 'a'.repeat(51);

module.exports = {
  test,
  expect,
  browserWindow,
  waitForPopoverFrame,
  SAMPLE_BZZ_HASH,
  SAMPLE_IPFS_CID,
};
