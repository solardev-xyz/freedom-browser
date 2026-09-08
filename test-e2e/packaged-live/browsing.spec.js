// Packaged smoke — step 3 of the release-process.md §6 checklist:
// "type https://example.com, confirm a basic HTTPS page renders and the
// address-bar shield is in its default state".
//
// Two tests, deliberately in this order:
//   1. a page served by a local http server started inside the test. No
//      network, no DNS, no TLS — if this fails, the packaged app's own
//      browsing stack (webview, protocol handlers, session setup) is broken.
//   2. https://example.com over the real network. If 1 passed and 2 fails,
//      the runner's connectivity or TLS trust store is the suspect, not the
//      package.
//
// Both run through the live fixtures (no FREEDOM_TEST_MODE), because in test
// mode http(s) is served by the harness stub and would prove nothing about
// the artifact. The bundled nodes are seeded off: navigation over http(s)
// does not go through them, and their boot time is charged to
// packaged-live/nodes.spec.js instead.

const http = require('http');

const { test, expect } = require('../live-fixtures');

// Distinctive enough that finding it in the rendered DOM cannot be a
// coincidence (an error page, a search result, a cached anything).
const MARKER = 'freedom-packaged-live-marker-b7f31c';

const LOCAL_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Freedom packaged smoke</title>
  </head>
  <body>
    <h1 id="marker">${MARKER}</h1>
  </body>
</html>
`;

const NAVIGATION_TIMEOUT_MS = 30_000;
const LOCAL_RENDER_TIMEOUT_MS = 30_000;
// example.com over a cold connection on a loaded runner: DNS + TLS + fetch.
// Long enough that a slow first connection is not a failure, short enough
// that a genuinely broken network stack fails inside the test's own budget
// rather than the project's 10-minute one.
const REMOTE_RENDER_TIMEOUT_MS = 120_000;

const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (source) => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    try {
      return await webview.executeJavaScript(source);
    } catch {
      return null;
    }
  }, snippet);

const waitForWebviewText = (window, pattern, { message, timeout }) =>
  expect
    .poll(
      () =>
        evalInActiveWebview(
          window,
          '[document.title, document.body ? document.body.innerText : ""].join("\\n")'
        ),
      { message, timeout, intervals: [500, 1_000, 2_000] }
    )
    .toMatch(pattern);

// Drive the address bar the way a user would: focus, fill, Enter.
const navigate = async (window, url) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
};

// The shield is only shown for pages that carry provenance to report (an
// Ethereum name resolution, an onchain app). Plain http(s) browsing must
// leave it hidden and unlabelled — that is "its default state", and a
// leftover badge from an earlier page is exactly what the check in the
// playbook is looking for.
const expectShieldDefault = async (window) => {
  const shield = window.locator('#trust-shield');
  await expect(shield).toBeHidden();
  await expect(shield).not.toHaveAttribute('data-trust', /.*/);
  await expect(shield).toHaveAttribute('aria-label', 'Site provenance status');
  await expect(window.locator('#trust-popover')).toBeHidden();
};

test.describe('packaged browsing', () => {
  test.use({
    seedSettings: {
      startAntAtLaunch: false,
      startIpfsAtLaunch: false,
      startRadicleAtLaunch: false,
      enableTorIntegration: false,
      startTorAtLaunch: false,
    },
  });

  let server;
  let localPort;
  let localUrl;

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(LOCAL_PAGE);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // Port 0: the OS picks a free one, so two smoke legs on the same runner
      // can never collide.
      server.listen(0, '127.0.0.1', resolve);
    });
    localPort = server.address().port;
    localUrl = `http://127.0.0.1:${localPort}/`;
  });

  test.afterAll(async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  });

  test('a local http page renders in the packaged app', async ({ window }) => {
    await navigate(window, localUrl);

    const input = window.locator('[data-test="address-input"]');
    await expect(input).toHaveValue(new RegExp(`^http://127\\.0\\.0\\.1:${localPort}/?$`), {
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    await waitForWebviewText(window, new RegExp(MARKER), {
      message: `Waiting for the marker page served at ${localUrl}`,
      timeout: LOCAL_RENDER_TIMEOUT_MS,
    });

    // The marker has to be the page's own DOM, not just text somewhere on an
    // error page that happened to echo the URL.
    expect(
      await evalInActiveWebview(window, 'document.getElementById("marker")?.textContent')
    ).toBe(MARKER);

    await expect(window.locator('#protocol-icon')).toHaveAttribute('data-protocol', 'http');
    await expectShieldDefault(window);
  });

  test('https://example.com renders and the address-bar shield stays default', async ({
    window,
  }) => {
    await navigate(window, 'https://example.com');

    const input = window.locator('[data-test="address-input"]');
    await expect(input).toHaveValue(/^https:\/\/example\.com\/?$/, {
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    await waitForWebviewText(window, /Example Domain/i, {
      message: 'Waiting for https://example.com to render',
      timeout: REMOTE_RENDER_TIMEOUT_MS,
    });

    // A real TLS load, not an interstitial: the page's own <h1> is what the
    // error page would not have.
    expect(await evalInActiveWebview(window, 'document.querySelector("h1")?.textContent')).toMatch(
      /Example Domain/i
    );
    expect(await evalInActiveWebview(window, 'location.protocol')).toBe('https:');

    await expect(window.locator('#protocol-icon')).toHaveAttribute('data-protocol', 'https');
    await expectShieldDefault(window);
  });
});
