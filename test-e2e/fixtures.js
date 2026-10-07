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

const { test: base, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  isPackagedRun,
  packagedLaunchTarget,
  launchApp: launchTarget,
} = require('./packaged-launch');
const { closeApp } = require('./close-app');

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
// closed at teardown. A packaged run is driven over CDP rather than through
// Playwright's Electron launcher; see packaged-launch.js.
function launchApp(userDataDir) {
  return launchTarget(launchOptions(userDataDir));
}

// Teardown deadline for one instance (see close-app.js). A packaged app has
// its own 90 s quit-then-SIGKILL in packaged-launch.js; stay above it so that
// path keeps deciding, and only a close that outlives it is reported here.
function closeOptions() {
  return isPackagedRun() ? { timeout: 100_000 } : {};
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

    await closeApp(app, closeOptions());
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

    // Close every instance even if one of them is stuck, then report it.
    const stuck = [];
    for (const app of started) {
      await closeApp(app, closeOptions()).catch((err) => stuck.push(err));
    }
    if (stuck.length) throw stuck[0];
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

// --- Pointer input at chrome drawn over the tab's <webview> ----------------
//
// Which helper, when:
//
// - `clickOverGuest(locator, clickOptions)` — click a chrome element that sits
//   over the tab's `<webview>` and has only just appeared, moved or been
//   revealed there (a menu row, a popover, a modal's button, a download card,
//   a control a sidebar just widened over the page). It clicks exactly once.
// - `hoverOverGuest(locator)` — the same, when the hover is the step under
//   test (a sibling menu row closing a flyout). `clickOverGuest` is this plus
//   one click.
// - Neither, for chrome that is not over the guest, or that has been on screen
//   for a while: a plain `locator.click()` is fine there. Calling the helper
//   on such an element is harmless, only slower.
// - Not a retry. Never re-issue a click until its effect shows: that also
//   passes a control that genuinely ate the first click. Specs that are not
//   about pointer input at all may instead `dispatchEvent('click')` to bypass
//   routing (`permission-fixtures.js` `answerPrompt`, `popup-blocker.spec.js`).
//
// Why. A Playwright click or hover is dispatched by the *browser* process,
// which picks the widget it goes to by hit-testing the point against viz's
// hit-test data for the last *presented* frame. In the window between "the
// menu is in the DOM" and "the menu is on screen", the browser still believes
// the point belongs to the `<webview>` guest behind it and routes the whole
// event there. The chrome sees no mousemove, no mousedown, nothing, and
// Playwright's own actionability checks cannot see it either: they run in the
// chrome renderer, where the DOM is already right, and treat "no event
// arrived" as success. The guest takes focus from a click it was handed,
// which is the only trace of it in the chrome. A real user cannot hit this —
// the pointer has to travel to a row that is already on screen — but a
// synthetic click that arrives in the same frame does, and a loaded CI runner
// or a just-launched app stretches that to tens or hundreds of milliseconds.
// Probed on CI with pointer/focus listeners in both the chrome and the guest:
// the create-profile dialog's Create click (#539) and the hamburger's New Tab
// hover (#537, PR #582), the page context menu's search item (#540, PR #583),
// and the download, tab-mute, identity-selector and focus-ring clicks that the
// retrying helper this replaces was written for (2026-09-29).
//
// Two `requestAnimationFrame`s (this file's old `waitForPopoverFrame`) are not
// enough: rAF only says the renderer *started* a frame, and presentation can
// lag several frames behind that in a just-launched app.
//
// How. A wait, a gate, then the input once:
// 1. `waitForPresentedFrame` paints a marker tagged `elementtiming` and waits
//    for Chromium's `PerformanceElementTiming.renderTime` for it, the
//    presentation time of the frame that first painted it. Frames are
//    presented in order, so everything in the DOM before the call is on screen
//    by then. No fixed delay: on a slow machine the wait is just longer. This
//    is what makes the first hover land (looped on CI 2026-10-07, 27 file runs
//    across Ubuntu/Windows/macOS: the gate below never had to re-send one). It
//    is not the gate: once in CI (e2e-chrome, 2026-10-07) no entry for the
//    marker arrived within 10 s and the retry passed in 2 s, so a missing
//    entry is logged and left to step 2 rather than failing the test. The
//    wait is bounded by (half of) the caller's `timeout`, never added to it.
// 2. Hover the element until it matches `:hover`. That only happens once a
//    pointer event at that point has reached this renderer, i.e. the browser
//    now routes the point to the chrome — the condition a click needs, and the
//    one that decides. A hover the browser still hands to the guest has no
//    effect on the page — unlike a click, which focuses (and over a field,
//    edits) whatever the guest has there — so the move, never the click, is
//    what may be re-sent. Hovering is the only input these helpers can send
//    more than once.
// The element must stay put between the hover and the click; a popover does.

// Resolve `true` once the chrome's current DOM has been *presented*, or `false`
// if no presentation entry for the marker arrived within `timeoutMs`.
const waitForPresentedFrame = (page, timeoutMs) =>
  page.evaluate(
    (timeoutMs) =>
      new Promise((resolve) => {
        const id = `e2e-presented-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const marker = document.createElement('div');
        marker.setAttribute('elementtiming', id);
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = '.';
        marker.style.cssText =
          'position:fixed;left:0;bottom:0;font-size:1px;line-height:1px;' +
          'pointer-events:none;z-index:2147483647';
        const done = (fn, value) => {
          clearTimeout(guard);
          observer.disconnect();
          marker.remove();
          fn(value);
        };
        const observer = new PerformanceObserver((list) => {
          if (list.getEntries().some((entry) => entry.identifier === id)) done(resolve, true);
        });
        const guard = setTimeout(() => done(resolve, false), timeoutMs);
        observer.observe({ type: 'element', buffered: false });
        document.body.append(marker);
      }),
    timeoutMs
  );

// Put the pointer on `locator` and return once the element itself is under it
// as far as the browser's input routing is concerned (see above).
//
// `timeout` bounds the whole call, presentation wait included, so a caller
// that retries around this (a menu that may need reopening) gets its retry
// even when the presentation entry never arrives. The wait takes at most half
// the budget (10 s at the default) and the `:hover` gate always has the rest.
const hoverOverGuest = async (locator, { timeout = 25_000 } = {}) => {
  const started = Date.now();
  const presentationTimeout = Math.min(10_000, Math.floor(timeout / 2));
  if (!(await waitForPresentedFrame(locator.page(), presentationTimeout))) {
    // Visible in the run log; whether the pointer reaches the chrome is still
    // decided by the `:hover` gate below, which fails the test if it never does.
    console.warn(
      `hoverOverGuest: no presentation entry in ${presentationTimeout} ms before hovering ${locator}`
    );
  }
  await expect(async () => {
    await locator.hover({ timeout: 1000 });
    expect(await locator.evaluate((element) => element.matches(':hover'))).toBe(true);
  }).toPass({ timeout: Math.max(1000, timeout - (Date.now() - started)) });
};

// Click `locator` exactly once, after `hoverOverGuest` has shown the click
// will reach it. `clickOptions` go to `locator.click` (e.g. `modifiers`).
const clickOverGuest = async (locator, clickOptions) => {
  await hoverOverGuest(locator);
  await locator.click(clickOptions);
};

// Convenience: an arbitrary 64-char Swarm hex hash for fixture-driven
// `bzz://` navigation. Specs should treat this as opaque.
const SAMPLE_BZZ_HASH = 'a'.repeat(64);
const SAMPLE_IPFS_CID = 'bafybeib' + 'a'.repeat(51);

module.exports = {
  test,
  expect,
  browserWindow,
  clickOverGuest,
  hoverOverGuest,
  SAMPLE_BZZ_HASH,
  SAMPLE_IPFS_CID,
};
