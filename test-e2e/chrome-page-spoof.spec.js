// Chrome pages (the error page, the ENS/Tezos name-resolution interstitials)
// deliberately keep their own `file:///…/pages/*.html` URL out of the address
// bar and show the friendly target carried in a query param instead. That
// makes "is this URL one of our chrome pages?" a security decision: matched on
// a `/error.html` / `/ens-conflict.html` *substring*, any remote page could
// serve that path and pick what the address bar (and the protocol icon) says
// while rendering its own HTML. #235 — the checks are anchored to the shell's
// own resolved `pages/<file>` base instead.
//
// Both cases below are driven through the real chrome: the harness owns the
// https: scheme in test mode, so `evil.test` never reaches the network.

const { test, expect } = require('./fixtures');

const activeWebviewUrl = (window) =>
  window.evaluate(() => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    return wv?.getURL?.() || '';
  });

const navigateTo = async (window, url) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
  await expect
    .poll(() => activeWebviewUrl(window), { timeout: 10_000, intervals: [200, 500] })
    .toContain('evil.test');
  return input;
};

test('a remote interstitial look-alike cannot pick the address bar value', async ({ window }) => {
  const input = await navigateTo(window, 'https://evil.test/ens-conflict.html?name=bank.eth');

  // The attacker's `?name=` must never be shown as the location. The real URL
  // is; matching the interstitial branch would have replaced it with
  // `bank.eth`, with the trust shield free to badge that name.
  await expect(input).toHaveValue('https://evil.test/ens-conflict.html?name=bank.eth');
});

test('a remote error-page look-alike cannot pick the address bar value or protocol icon', async ({
  window,
}) => {
  const hostile = 'https://evil.test/error.html?url=bzz%3A%2F%2Fvitalik.eth&protocol=swarm';
  const input = await navigateTo(window, hostile);
  await expect(input).toHaveValue(hostile);

  // The switched-tab path derives its own display value, so it needs the same
  // check as the active-tab did-navigate handler: open a second tab, come
  // back, and confirm the repaint didn't hand the attacker the address bar.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);

  await expect(input).toHaveValue(hostile);
  // The protocol icon follows the same derived value — it showed the orange
  // Swarm mark for the spoofed `bzz://` target before the fix.
  await expect
    .poll(() =>
      window.evaluate(() => document.getElementById('protocol-icon')?.getAttribute('data-protocol'))
    )
    .toBe('https');
});
