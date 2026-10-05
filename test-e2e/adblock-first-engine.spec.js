// The first page of a fresh session, with the real filter lists and no
// serialized engine cache (#524).
//
// Since #519 the first engine of a session is parsed in a worker. Until it
// lands, a frame's scriptlet lookup — a sync IPC its preload makes before any
// page script runs — and its request checks wait for it, bounded by a 5 s
// hold. That is the path a user takes on the first launch after install and
// after every update that bumps the adblocker version, and the one nothing in
// per-PR CI exercised: the fixture-list specs build in milliseconds, and
// without the real lists there is no engine to wait for. Only the nightly's
// full harness run had both, which is where #524 surfaced.
//
// Runs in the e2e-settings CI job, which downloads the real lists. Every
// test gets a fresh profile, so there is no engine cache; the test checks
// the log to be sure the engine really was parsed, not loaded from one.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const LISTS_MANIFEST = path.join(__dirname, '..', 'assets', 'adblock', 'manifest.json');
const PAGE_URL = 'https://first-engine.example/page';

const readMainLog = (userDataDir) => {
  try {
    return fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf-8');
  } catch {
    return '';
  }
};

// The tab's page has committed and finished loading: its webview is the
// visible one, on PAGE_URL, and no longer loading.
const pageLoaded = (window) =>
  window.evaluate((url) => {
    const webview = document.querySelector('webview:not(.hidden)');
    return Boolean(webview) && webview.getURL() === url && !webview.isLoading();
  }, PAGE_URL);

test.beforeEach(() => {
  // CI must not skip its way to green: the job that runs this downloads the
  // lists, so their absence there is a broken job, not an optional feature.
  if (!fs.existsSync(LISTS_MANIFEST)) {
    if (process.env.CI) throw new Error(`no filter lists at ${LISTS_MANIFEST}`);
    test.skip(true, 'needs the real filter lists: npm run adblock:download');
  }
});

test('the first page of a fresh session waits for the engine build, not the hold timeout', async ({
  window,
  userDataDir,
}) => {
  // Navigate as soon as the window is up — on a fresh profile that is
  // before the engine has landed, so the page is held behind its build.
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_URL);
  const enteredAt = Date.now();
  await input.press('Enter');
  await expect.poll(() => pageLoaded(window), { timeout: 15_000, intervals: [25] }).toBe(true);
  const loadMs = Date.now() - enteredAt;

  // The engine was parsed (no cache to load) and its build released whatever
  // was waiting on it; the hold never ran out.
  await expect.poll(() => readMainLog(userDataDir)).toMatch(/first-engine hold released after/);
  const log = readMainLog(userDataDir);
  const ready = log.match(/\[adblock\] filter engine ready \(.*built in (\d+) ms[^)]*\)/);
  expect(ready, 'engine built from the lists, not loaded from a cache').not.toBeNull();
  expect(log).not.toContain('[adblock] filter engine ready (cache)');
  expect(log).not.toMatch(/filter engine not ready after/);
  const released = log.match(/first-engine hold released after (\d+) ms \((\d+) request/);
  // The page really was held behind the build — otherwise the engine landed
  // before Enter and this test proved nothing about the held-first-page path.
  expect(Number(released[2]), 'the first page waited on the engine build').toBeGreaterThan(0);
  console.log(
    `[#524] first load ${loadMs} ms; engine built in ${ready[1]} ms; ` +
      `hold released after ${released[1]} ms with ${released[2]} waiting`
  );

  // The page is live and scriptable straight away (what menus.spec's guest
  // context-menu test does next), and the engine's cosmetic filters reach it:
  // an element matching the generic EasyList rule `##.ad-slot` gets hidden.
  // (The harness's https stub serves its own page, so the element is added
  // here rather than served.)
  const guest = (script) =>
    window.evaluate(
      (code) => document.querySelector('webview:not(.hidden)').executeJavaScript(code),
      script
    );
  await guest(`(() => {
    for (const [id, cls] of [['ad', 'ad-slot'], ['content', 'article']]) {
      const el = document.createElement('div');
      el.id = id;
      el.className = cls;
      el.textContent = id;
      document.body.appendChild(el);
    }
  })()`);
  await expect
    .poll(() => guest(`getComputedStyle(document.getElementById('ad')).display`))
    .toBe('none');
  expect(await guest(`getComputedStyle(document.getElementById('content')).display`)).toBe('block');
});
