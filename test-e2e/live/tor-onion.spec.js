// Real-network E2E: Arti cold-start -> .onion navigation -> page render.
//
// This runs without FREEDOM_TEST_MODE, starts the production Tor manager, and
// verifies Electron's session proxy can load a real onion service through the
// bundled Arti SOCKS proxy.

const { test, expect, HAS_ARTI_BINARY, ARTI_BINARY_PATH } = require('../live-fixtures');

// Default target. The previous default (The Guardian's onion) stopped
// publishing a descriptor — "Onion Service not found" on every attempt as of
// 2026-09-08 — so it was swapped for one that answers. Override both variables
// together to point at something else.
const DEFAULT_ONION_URL =
  'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/';
// A word from the rendered page that does not also appear in the onion address
// — see the sniffer below for why that matters.
const DEFAULT_ONION_CONTENT = 'privacy';
const ONION_URL = process.env.FREEDOM_TOR_E2E_ONION_URL || DEFAULT_ONION_URL;
// Only meaningful together with the URL: overriding the URL alone falls back to
// "the page rendered any body text", which the origin/error-page guards in the
// sniffer below still keep as a real assertion.
const ONION_CONTENT =
  process.env.FREEDOM_TOR_E2E_ONION_CONTENT
  || (ONION_URL === DEFAULT_ONION_URL ? DEFAULT_ONION_CONTENT : '');

const TOR_START_TIMEOUT_MS = 180_000;
const ONION_NAVIGATION_TIMEOUT_MS = 180_000;
const PAGE_RENDER_TIMEOUT_MS = 120_000;
const SETTINGS_TIMEOUT_MS = 30_000;

// Assert on a rendered onion page, not on an error surface that quotes the
// address it failed to reach. A failed `.onion` load lands the webview on
// Freedom's own interstitial (`src/renderer/pages/error.html?error=…&url=…`,
// title "Couldn't load this page"), whose body text repeats the onion
// hostname — so a marker that is a substring of that hostname matches there
// too. The old default did exactly that (`/guardian/i` against
// `guardian2zot….onion`) and so reported a pass while the service was down.
//
// The origin check is what catches that: Freedom's interstitial is a `file://`
// page, so a failed load can never satisfy it. The `#main-frame-error` check is
// a second, defensive guard for a navigation that ends on Chromium's own
// network-error page instead — which was not observed here, since Freedom's
// error handler took every failure, but which does keep the requested URL as
// its location and so would pass the origin check.
const ONION_RENDER_SNIFFER = `
  (() => {
    if (location.origin !== ${JSON.stringify(new URL(ONION_URL).origin)}) return false;
    if (document.querySelector('#main-frame-error')) return false;
    const text = [document.title, document.body?.innerText || ''].join('\\n');
    const marker = ${JSON.stringify(ONION_CONTENT)};
    return marker ? new RegExp(marker, 'i').test(text) : text.trim().length > 0;
  })()
`;

const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (s) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return false;
    try {
      return await wv.executeJavaScript(s);
    } catch {
      return false;
    }
  }, snippet);

const waitForWebviewCondition = (window, snippet, message) =>
  expect
    .poll(() => evalInActiveWebview(window, snippet), {
      message,
      timeout: PAGE_RENDER_TIMEOUT_MS,
      intervals: [2_000, 5_000],
    })
    .toBeTruthy();

const navigateWithAddressBar = async (
  window,
  target,
  expected,
  timeout = ONION_NAVIGATION_TIMEOUT_MS
) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(target);
  await input.press('Enter');
  await expect(input).toHaveValue(expected, { timeout });
};

async function enableTorIntegrationFromSettings(window) {
  await navigateWithAddressBar(
    window,
    'freedom://settings/experimental',
    /freedom:\/\/settings\/experimental/,
    SETTINGS_TIMEOUT_MS
  );

  await waitForWebviewCondition(
    window,
    `
      (() => location.hash === '#experimental'
        && !!document.querySelector('#enable-tor-integration'))()
    `,
    'Waiting for the Experimental settings section'
  );

  await expect
    .poll(
      async () => {
        const toggled = await evalInActiveWebview(
          window,
          `
            (() => {
              const checkbox = document.querySelector('#enable-tor-integration');
              if (!checkbox) return false;
              checkbox.scrollIntoView({ block: 'center' });
              if (!checkbox.checked) checkbox.click();
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
              return checkbox.checked;
            })()
          `
        );
        if (!toggled) return false;
        return window.evaluate(async () => {
          const settings = await window.electronAPI.getSettings();
          return settings.enableTorIntegration === true && settings.startTorAtLaunch === false;
        });
      },
      {
        message: 'Waiting for Tor settings to persist',
        timeout: SETTINGS_TIMEOUT_MS,
        intervals: [500, 1000],
      }
    )
    .toBe(true);
}

async function startTorFromNodesMenu(window) {
  const menuButton = window.locator('#bee-menu-button');
  const dropdown = window.locator('#bee-menu-dropdown');
  const torSection = window.locator('#tor-nodes-section');
  const torToggle = window.locator('#tor-toggle-btn');

  await menuButton.click();
  await expect(dropdown).toHaveClass(/open/);
  await expect(torSection).toBeVisible();
  await expect(torToggle).toBeEnabled();

  await torToggle.click();
  await expect
    .poll(async () => (await window.evaluate(() => window.tor.getStatus())).status, {
      message: 'Waiting for Tor manager to start Arti',
      timeout: TOR_START_TIMEOUT_MS,
      intervals: [1000, 2000, 5000],
    })
    .toBe('running');

  await expect(window.locator('#tor-status-label')).toHaveText(/SOCKS:/, {
    timeout: SETTINGS_TIMEOUT_MS,
  });
  await expect(window.locator('#tor-status-value')).toHaveText(/127\.0\.0\.1:\d+/, {
    timeout: SETTINGS_TIMEOUT_MS,
  });

  await menuButton.click();
  await expect(dropdown).not.toHaveClass(/open/);
}

test.describe('live Tor onion access', () => {
  test.skip(
    !HAS_ARTI_BINARY,
    `Live Tor E2E needs the Arti binary at ${ARTI_BINARY_PATH}. Run \`npm run tor:download\` to build it.`
  );

  test('cold-start: Arti starts and a real onion service renders', async ({ window }) => {
    await enableTorIntegrationFromSettings(window);
    await startTorFromNodesMenu(window);

    await navigateWithAddressBar(
      window,
      ONION_URL,
      new RegExp(`^${ONION_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      ONION_NAVIGATION_TIMEOUT_MS
    );

    await waitForWebviewCondition(
      window,
      ONION_RENDER_SNIFFER,
      `Waiting for onion page content from ${ONION_URL}`
    );
  });
});
