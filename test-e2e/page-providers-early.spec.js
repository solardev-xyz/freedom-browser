// window.swarm / window.radicle exist before page scripts run, and a strict
// page CSP does not keep them out (#683), in real Chromium.
//
// webview-preload.js used to install both from an inline <script> it inserted
// at DOMContentLoaded. A page's own top-level script ran before that and saw
// `undefined`, and a page whose CSP has no 'unsafe-inline' refused the inline
// script outright, so the providers never appeared at all. They now run in the
// page's main world through contextBridge.executeInMainWorld at document start,
// the same way window.ethereum already did. The unit suite can only see which
// Electron API is called; this spec proves the page actually sees the result.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');
const { evalInWebview } = require('./permission-fixtures');

const BASE = `bzz://${SAMPLE_BZZ_HASH}`;

// What a page's first script records about the providers, before anything of
// Freedom's could have run on DOMContentLoaded.
const PROBE = `
  window.__early = {
    swarm: typeof window.swarm,
    swarmIsFreedom: window.swarm?.isFreedomBrowser === true,
    radicle: typeof window.radicle,
    radicleIsFreedom: window.radicle?.isFreedomBrowser === true,
    ethereum: typeof window.ethereum,
    readyState: document.readyState,
  };
`;

const EXPECTED_EARLY = {
  swarm: 'object',
  swarmIsFreedom: true,
  radicle: 'object',
  radicleIsFreedom: true,
  ethereum: 'object',
  readyState: 'loading',
};

async function open(window, harness, fixtures, path) {
  for (const [url, fixture] of fixtures) {
    await harness.setContentFixture(url, fixture);
  }
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`${BASE}${path}`);
  await input.press('Enter');
  await expect
    .poll(() => evalInWebview(window, 'window.__early ? JSON.stringify(window.__early) : null'), {
      message: `Waiting for ${path} to record its first script`,
      timeout: 15_000,
    })
    .not.toBeNull();
  return JSON.parse(await evalInWebview(window, 'JSON.stringify(window.__early)'));
}

test('an inline top-level script sees window.swarm and window.radicle', async ({
  window,
  harness,
}) => {
  const early = await open(
    window,
    harness,
    [
      [
        `${BASE}/inline/`,
        {
          body:
            '<!doctype html><html><head><title>inline probe</title>' +
            `<script>${PROBE}</script></head><body><p>inline</p>` +
            '<iframe src="frame.html"></iframe></body></html>',
        },
      ],
      [`${BASE}/inline/frame.html`, { body: '<!doctype html><title>frame</title><p>frame</p>' }],
    ],
    '/inline/'
  );
  expect(early).toEqual(EXPECTED_EARLY);

  // Still top frame only (#440): a same-origin sub-frame gets neither.
  await expect
    .poll(() =>
      evalInWebview(
        window,
        `(() => {
          const w = document.querySelector('iframe')?.contentWindow;
          if (!w || w.document.readyState !== 'complete' || !w.document.querySelector('p')) return null;
          return [typeof w.swarm, typeof w.radicle].join(',');
        })()`
      )
    )
    .toBe('undefined,undefined');
});

test("a page with script-src 'self' sees window.swarm and window.radicle", async ({
  window,
  harness,
}) => {
  const csp = "default-src 'self'; script-src 'self'";
  const early = await open(
    window,
    harness,
    [
      [
        `${BASE}/csp/`,
        {
          headers: { 'Content-Security-Policy': csp },
          body:
            '<!doctype html><html><head><title>csp probe</title>' +
            '<script src="app.js"></script></head><body><p>strict csp</p></body></html>',
        },
      ],
      [
        `${BASE}/csp/app.js`,
        {
          contentType: 'text/javascript; charset=utf-8',
          headers: { 'Content-Security-Policy': csp },
          body: PROBE,
        },
      ],
    ],
    '/csp/'
  );
  expect(early).toEqual(EXPECTED_EARLY);

  // The CSP really is in force: the page itself cannot run an inline script,
  // which is exactly what the old DOMContentLoaded <script> injection was.
  const inlineRan = await evalInWebview(
    window,
    `(() => {
      window.__inlineRan = false;
      const s = document.createElement('script');
      s.textContent = 'window.__inlineRan = true;';
      document.head.appendChild(s);
      return window.__inlineRan;
    })()`
  );
  expect(inlineRan).toBe(false);

  // Still there after load, and still Freedom's own objects.
  expect(
    await evalInWebview(
      window,
      'window.swarm?.isFreedomBrowser === true && window.radicle?.isFreedomBrowser === true'
    )
  ).toBe(true);
});
