// Error page — when the swarm probe returns `not_found`, the renderer
// routes the active webview to `pages/error.html` with the original
// URL preserved in the address bar. We assert both via the chrome and
// the webview's URL (the error page itself is loaded from the host
// pages/ directory so it's accessible to Playwright as a frame).

const { test, expect, SAMPLE_BZZ_HASH, SAMPLE_IPFS_CID } = require('./fixtures');

test('a probe-not-found bzz:// navigation lands on the error page', async ({
  window,
  harness,
}) => {
  // Force the Swarm probe stub to time out for this hash so navigation
  // routes to error.html instead of the (also-stubbed) bzz:// fixture.
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found' });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}`);
  await input.press('Enter');

  // Address bar keeps the original URL so the user knows what failed.
  // The renderer's error path canonicalises to bzz://<hash>/ (trailing
  // slash); the success path strips it. Match either form.
  await expect(input).toHaveValue(new RegExp(`^bzz://${SAMPLE_BZZ_HASH}/?$`));

  // Active webview is the one whose container is visible. We poll its
  // src until it reports the error.html path; navigation is async.
  await expect
    .poll(
      async () => {
        return window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.getURL?.() || wv?.getAttribute?.('src') || '';
        });
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toMatch(/pages\/error\.html\?error=swarm_content_not_found/);
});

// #236: the error page used to declare no <title>, so Chromium never fired
// `page-title-updated` for it and the tab kept the previous page's title
// ("RPC servers disagreed" in the reported screenshot). Reproduced exactly as
// the issue describes: visit a titled fixture page, then a not-found hash.
test('the swarm error page does not inherit the previous page title', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`ipfs://${SAMPLE_IPFS_CID}`, {
    body: '<html><head><title>Alpha fixture page</title></head><body>alpha</body></html>',
  });
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found' });

  const input = window.locator('[data-test="address-input"]');
  const tabTitle = window.locator('[data-test="tab"] .tab-title').first();

  await input.click();
  await input.fill(`ipfs://${SAMPLE_IPFS_CID}`);
  await input.press('Enter');
  await expect(tabTitle).toHaveText('Alpha fixture page', { timeout: 10_000 });

  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}`);
  await input.press('Enter');

  await expect
    .poll(
      async () =>
        window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.getURL?.() || '';
        }),
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toMatch(/pages\/error\.html\?error=swarm_content_not_found/);

  // The error page names itself. `swarm_content_not_found` renders the
  // "Content not ready yet" headline and sets the document title to match.
  await expect(tabTitle).toHaveText('Content not ready yet', { timeout: 10_000 });
});

// The other half of #236: the tab title is what the history entry records at
// did-stop-loading. A page that declares no <title> of its own must not have
// the previous page's title written against its URL — that is what put the
// wrong title next to the URL in the autocomplete dropdown.
test('a page without a title does not record the previous page title in history', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`ipfs://${SAMPLE_IPFS_CID}`, {
    body: '<html><head><title>Alpha fixture page</title></head><body>alpha</body></html>',
  });
  await harness.setContentFixture('ipfs://QmNoTitleFixture', {
    body: '<html><body>no title of its own</body></html>',
  });

  const input = window.locator('[data-test="address-input"]');
  const tabTitle = window.locator('[data-test="tab"] .tab-title').first();

  await input.click();
  await input.fill(`ipfs://${SAMPLE_IPFS_CID}`);
  await input.press('Enter');
  await expect(tabTitle).toHaveText('Alpha fixture page', { timeout: 10_000 });

  await input.click();
  await input.fill('ipfs://QmNoTitleFixture');
  await input.press('Enter');

  const historyFor = async (urlPart) =>
    window.evaluate(async (part) => {
      const entries = await window.electronAPI.getHistory({ limit: 50 });
      return entries.find((entry) => entry.url.toLowerCase().includes(part)) || null;
    }, urlPart);

  await expect.poll(() => historyFor('qmnotitlefixture'), { timeout: 10_000 }).not.toBeNull();
  const entry = await historyFor('qmnotitlefixture');
  expect(entry.title).not.toBe('Alpha fixture page');
});
