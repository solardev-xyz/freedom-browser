// Real-network E2E for issue #346: opening a Chrome Web Store page must not
// kill the browser process.
//
// Electron 44.3.0 (Chromium 152) registered the `webstorePrivate` extension
// API and shipped the core `_api_features.json` entry that exposes it to
// ordinary web pages on `https://chromewebstore.google.com/*`, without a
// `WebstorePrivateAPIDelegate`. The store calls `chrome.webstorePrivate
// .getReferrerChain()` as soon as a detail page renders, and that call is a
// null-pointer method call on `CrBrowserMain` — SIGSEGV in the browser
// process, the whole app gone. Fixed upstream in electron/electron#53752,
// backported to 44-x-y in electron/electron#53776, shipped in v44.4.0.
//
// This has to be a live spec: the exposure is keyed on the real store origin,
// so no fixture page can stand in for it. Two assertions, in order:
//
//   1. On the store front page, `chrome.webstorePrivate` is undefined. This is
//      the direct, deterministic read of the bug — on 44.3.0 it is an object
//      with 23 functions.
//   2. Navigating straight to a detail page (the issue's no-click repro) leaves
//      the main process alive and answering IPC.
//
// Both legs were confirmed load-bearing against 44.3.0 on Linux: (1) reported
// `type: "object", functions: 23`, and (2) killed the browser process about a
// second after the window title committed to "Google Translate - Chrome Web
// Store".
//
// It also pins which Electron is under test from *inside* the app
// (`process.versions.electron`), because the original Linux non-repro of this
// bug was an artifact of a stale `node_modules/electron` — see
// scripts/check-electron-version.js.
//
// Order matters: Google bounces a fresh profile to `consent.google.com` before
// it will serve the store at all, and that consent page is served on its own
// origin where `webstorePrivate` is never exposed. Loading the *front* page
// first, clicking through consent there, and only then navigating to the detail
// URL is what keeps both legs from passing vacuously on a consent wall.

const { test, expect } = require('../live-fixtures');
const { readLockedElectronVersion } = require('../../scripts/check-electron-version');

const STORE_HOST = 'chromewebstore.google.com';
const STORE_FRONT_URL = `https://${STORE_HOST}/`;
// The exact extension the issue's repro navigates to (Google Translate).
const STORE_DETAIL_PATH = '/detail/google-translate/aapbdbdomjkkjkaonfhkkikfgjllcleb';
const STORE_DETAIL_URL = `https://${STORE_HOST}${STORE_DETAIL_PATH}`;

// Either the store itself or the consent wall it redirects through — asserted
// on the address bar only to confirm the navigation was accepted. Where the
// page actually ended up is read from inside the page, which a consent URL
// (whose `continue=` parameter quotes the store URL verbatim) cannot fake.
const GOOGLE_URL_PATTERN = /^https:\/\/(chromewebstore|consent)\.google\.com\//;

const NAVIGATION_TIMEOUT_MS = 90_000;
const PAGE_RENDER_TIMEOUT_MS = 120_000;
// The macOS repro crashed ~1 s after the detail page landed, and the Linux one
// about as fast. Hold the app open well past that — and keep asking the main
// process questions the whole time — so a delayed crash cannot slip through
// between the last assertion and teardown.
const CRASH_WATCH_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// No node needs to be running to load an https page, and a live spec that
// boots Ant/IPFS/Radicle/Tor would pay minutes of cold-start for nothing (and
// inherit their flakiness). Seeded here rather than via
// FREEDOM_LIVE_E2E_DISABLE_DEFAULT_NODES so the spec is self-contained however
// it is invoked.
test.use({
  seedSettings: {
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
    startTorAtLaunch: false,
  },
});

// Playwright's Electron API doesn't expose <webview> guests as Pages, so route
// through the host renderer and use the guest's own executeJavaScript(). Unlike
// the sibling live specs' helper this reports the failure instead of folding it
// into `false`: "the probe threw" and "the API is absent" are opposite verdicts
// here, and a probe that throws because the browser process just died has to be
// distinguishable from one that ran and found nothing.
const evalInActiveWebview = async (window, snippet) => {
  try {
    return await window.evaluate(async (s) => {
      const wv = document.querySelector('webview:not(.hidden)');
      if (!wv || typeof wv.executeJavaScript !== 'function') {
        return { ok: false, error: 'no active webview' };
      }
      try {
        return { ok: true, value: await wv.executeJavaScript(s) };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    }, snippet);
  } catch (err) {
    return { ok: false, error: `renderer unreachable: ${String((err && err.message) || err)}` };
  }
};

// Google's consent wall ("Before you continue to Google") and the store's
// "switch to Chrome" promo both sit between a fresh profile and the store
// itself. Click only exact, known labels — a loose text match would happily
// click a store card and navigate somewhere unintended. Reject rather than
// accept consent: nothing here needs cookies.
const DISMISS_INTERSTITIALS = `
  (() => {
    const CONSENT = [/^reject all$/i, /^alle ablehnen$/i, /^ablehnen$/i, /^tout refuser$/i];
    const PROMO = [/^no thanks$/i, /^not now$/i, /^dismiss$/i, /^close$/i, /^got it$/i];
    const labelOf = (el) =>
      String(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '')
        .replace(/\\s+/g, ' ')
        .trim();
    const clickFirst = (patterns) => {
      for (const el of document.querySelectorAll(
        'button, [role="button"], input[type="submit"]'
      )) {
        const label = labelOf(el);
        if (label && patterns.some((p) => p.test(label))) {
          el.click();
          return label;
        }
      }
      return null;
    };
    return {
      consent: clickFirst(CONSENT),
      promo: clickFirst(PROMO),
      host: location.hostname,
      path: location.pathname,
      title: document.title,
    };
  })()
`;

// Read the API the store page is (or is not) handed. Reading the property is
// safe on both versions — it is *calling* one of its functions that dereferences
// the null delegate — so this reports the bug rather than triggering it.
const WEBSTORE_PRIVATE_PROBE = `
  (() => {
    const api = window.chrome && window.chrome.webstorePrivate;
    return {
      host: location.hostname,
      origin: location.origin,
      type: typeof api,
      functions: api ? Object.keys(api).length : 0,
      hasChrome: typeof window.chrome,
    };
  })()
`;

const DETAIL_PAGE_RENDERED = `
  (() => {
    if (location.hostname !== ${JSON.stringify(STORE_HOST)}) return false;
    if (!location.pathname.startsWith('/detail/google-translate/')) return false;
    const text = [document.title, (document.body && document.body.innerText) || ''].join('\\n');
    return /google translate/i.test(text);
  })()
`;

const navigateWithAddressBar = async (window, target) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(target);
  await input.press('Enter');
  await expect(input).toHaveValue(GOOGLE_URL_PATTERN, { timeout: NAVIGATION_TIMEOUT_MS });
};

test.describe('live Chrome Web Store (issue #346)', () => {
  test('the store page gets no chrome.webstorePrivate and a detail page does not kill the main process', async ({
    electronApp,
    window,
  }) => {
    // (0) Pin the Electron actually running this app. The bug is per-version,
    // and the original Linux non-repro was a stale node_modules — the lockfile
    // alone proves nothing about what just launched.
    const runtimeElectron = await electronApp.evaluate(() => process.versions.electron);
    const lockedElectron = readLockedElectronVersion();
    console.log(
      `[#346] app is running Electron ${runtimeElectron} (lockfile pins ${lockedElectron})`
    );
    expect(runtimeElectron).toBe(lockedElectron);

    // A crash of the browser process closes the app; record it so the failure
    // message says "crashed" rather than reading as a confusing IPC timeout.
    let appClosed = false;
    electronApp.on('close', () => {
      appClosed = true;
    });
    const appPid = electronApp.process().pid;
    const mainProcessAlive = async () => {
      if (appClosed) return 'app closed (browser process gone)';
      try {
        process.kill(appPid, 0);
      } catch {
        return `browser process ${appPid} is not running`;
      }
      try {
        // A real round-trip through the main process, not just "the pid exists":
        // answers only if CrBrowserMain is still pumping its message loop.
        return await electronApp.evaluate(({ app }) => (app.isReady() ? 'alive' : 'not ready'));
      } catch (err) {
        return `main process did not answer: ${String((err && err.message) || err)}`;
      }
    };

    expect(await mainProcessAlive()).toBe('alive');

    // (1) Store front page → the API must not be there at all. Poll, clicking
    // through consent / "switch to Chrome" interstitials, until the webview is
    // actually sitting on the store origin: the API is only ever exposed there,
    // so probing anywhere else would pass vacuously.
    await navigateWithAddressBar(window, STORE_FRONT_URL);
    await expect
      .poll(
        async () => {
          const result = await evalInActiveWebview(window, DISMISS_INTERSTITIALS);
          return result.ok ? result.value.host : `probe failed: ${result.error}`;
        },
        {
          message:
            `Waiting for the webview to settle on ${STORE_HOST} (dismissing Google's ` +
            'consent / "switch to Chrome" interstitials)',
          timeout: PAGE_RENDER_TIMEOUT_MS,
          intervals: [1_000, 2_000, 5_000],
        }
      )
      .toBe(STORE_HOST);

    const probe = await evalInActiveWebview(window, WEBSTORE_PRIVATE_PROBE);
    expect(probe.ok, `webstorePrivate probe failed: ${probe.error}`).toBe(true);
    console.log(`[#346] store front probe: ${JSON.stringify(probe.value)}`);
    expect(probe.value.host).toBe(STORE_HOST);
    // The page really did get a `chrome` object — so "no webstorePrivate" is a
    // statement about this API, not about a page that got no chrome APIs at all.
    expect(probe.value.hasChrome).toBe('object');
    expect(probe.value.type).toBe('undefined');
    expect(probe.value.functions).toBe(0);

    // (2) The issue's no-click repro: navigate straight to a detail page. On
    // 44.3.0 the store calls webstorePrivate.getReferrerChain() as the page
    // renders and the browser process dies ~1 s later. Written as an explicit
    // loop rather than expect.poll so a dead main process fails immediately,
    // with the reason, instead of polling a corpse until the render timeout.
    await navigateWithAddressBar(window, STORE_DETAIL_URL);

    let rendered = false;
    const renderDeadline = Date.now() + PAGE_RENDER_TIMEOUT_MS;
    while (!rendered && Date.now() < renderDeadline) {
      expect(
        await mainProcessAlive(),
        'the main process died while the Chrome Web Store detail page was loading (issue #346)'
      ).toBe('alive');
      await evalInActiveWebview(window, DISMISS_INTERSTITIALS);
      const result = await evalInActiveWebview(window, DETAIL_PAGE_RENDERED);
      rendered = result.ok && result.value === true;
      if (!rendered) await sleep(1_000);
    }
    expect(rendered, `the ${STORE_DETAIL_PATH} page never rendered`).toBe(true);
    console.log('[#346] detail page rendered; watching the main process');

    // Keep questioning the main process past the crash window.
    const watchDeadline = Date.now() + CRASH_WATCH_MS;
    while (Date.now() < watchDeadline) {
      expect(
        await mainProcessAlive(),
        'the main process died after the Chrome Web Store detail page rendered (issue #346)'
      ).toBe('alive');
      await sleep(1_000);
    }

    // Still on the detail page, still rendering it — not a crash-recovered or
    // navigated-away tab.
    const after = await evalInActiveWebview(window, DETAIL_PAGE_RENDERED);
    expect(after.ok, `post-dwell probe failed: ${after.error}`).toBe(true);
    expect(after.value).toBe(true);
  });
});
