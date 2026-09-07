// Headless driver for Freedom: launches the app under xvfb through Playwright's
// Electron support with the in-process test harness (FREEDOM_TEST_MODE=1) and
// exposes helpers to reach UI states and take screenshots.
//
// Run scripts with:
//   NODE_PATH=$PWD/node_modules xvfb-run -a -s "-screen 0 1440x900x24" node <script>
// See SKILL.md for the recipes and gotchas.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.FB_ROOT || path.resolve(__dirname, '..', '..', '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'freedom-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// Launch one app instance against a scratch profile. `seed` is written to
// settings.json before launch (e.g. { theme: 'light', showBookmarkBar: true }).
async function launch(seed) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-drive-'));
  if (seed) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(seed, null, 2));
  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: ROOT,
    env: {
      ...process.env,
      FREEDOM_TEST_MODE: '1',
      FREEDOM_TEST_USER_DATA: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow();
  win.setDefaultTimeout(8_000);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('[data-test="address-input"]', { state: 'visible', timeout: 30_000 });
  await win.waitForTimeout(1_200);
  return { app, win, userData };
}

async function shot(win, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await win.screenshot({ path: file });
  console.log('shot', file);
  return file;
}

// Type a URL/name into the address bar and press Enter.
async function go(win, url, settle = 1_500) {
  await win.click('[data-test="address-input"]');
  await win.fill('[data-test="address-input"]', url);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(settle);
}

// The Playwright page of a guest webview whose URL contains `sub`
// (e.g. 'settings.html'). Polls because guests attach a moment after commit.
async function pageFor(app, sub, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const page = app.windows().find((w) => w.url().includes(sub));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// Run JS inside the active guest webview.
function evalInWebview(win, code) {
  return win.evaluate(async (src) => {
    const wv = document.querySelector('webview:not(.hidden)');
    try {
      return await wv.executeJavaScript(src);
    } catch (e) {
      return `ERR ${e.message}`;
    }
  }, code);
}

// The Nodes/app menus leave #menu-backdrop open; Escape does not close them.
async function closeMenus(win) {
  for (let i = 0; i < 3; i++) {
    const backdrop = await win.$('#menu-backdrop');
    if (backdrop && (await backdrop.isVisible())) {
      await backdrop.click({ force: true });
      await win.waitForTimeout(200);
    } else {
      break;
    }
  }
  await win.keyboard.press('Escape');
}

// Dismiss the "Welcome to Freedom" onboarding modal that opens when the
// sidebar's Get Started is clicked (it blocks clicks on the sidebar).
async function dismissOnboarding(win) {
  await win.evaluate(() => {
    for (const b of document.querySelectorAll('button')) {
      if (b.textContent.trim() === 'Skip for now' && b.offsetParent) b.click();
    }
  });
  await win.waitForTimeout(300);
}

// Test-harness fixtures (main-process). See src/main/test-harness.js.
const harness = {
  content: (app, url, fixture) =>
    app.evaluate(
      (_e, { url: u, fixture: f }) => globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(u, f),
      { url, fixture }
    ),
  ens: (app, name, result) =>
    app.evaluate(
      (_e, { name: n, result: r }) => globalThis.__FREEDOM_TEST_HARNESS__.setEnsFixture(n, r),
      { name, result }
    ),
  probe: (app, hash, outcome) =>
    app.evaluate(
      (_e, { hash: h, outcome: o }) => globalThis.__FREEDOM_TEST_HARNESS__.setProbeFixture(h, o),
      { hash, outcome }
    ),
};

// Click an application-menu item by id (zoom-in, zoom-out, zoom-reset,
// new-private-window, ...). CDP key events never fire native accelerators.
function menuItem(app, id) {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) return false;
    item.click();
    return true;
  }, id);
}

module.exports = {
  ROOT,
  SHOTS,
  launch,
  shot,
  go,
  pageFor,
  evalInWebview,
  closeMenus,
  dismissOnboarding,
  harness,
  menuItem,
};
