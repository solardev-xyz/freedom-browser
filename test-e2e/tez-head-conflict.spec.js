// Head-level disagreement between Tezos RPC providers is a hard block, not a
// soft "unverified" continue: with only two reachable providers the median is
// just the lower head, so a provider lying low would otherwise eject the
// honest one and have its own answer loaded. The resolver emits a `conflict`
// with the reported head levels as groups (and no block, since no anchor was
// ever agreed) — this spec drives the real interstitial for that payload.

const { test, expect } = require('./fixtures');

test('a Tezos chain-head disagreement renders the conflict interstitial', async ({
  window,
  harness,
}) => {
  await harness.setEnsFixture('lagged.tez', {
    type: 'conflict',
    system: 'tezos',
    reason: 'Tezos RPC providers disagree about the chain head',
    groups: [
      { value: 'chain head #1000', urls: ['rpc-one.test'] },
      { value: 'chain head #400', urls: ['rpc-two.test'] },
    ],
    trust: { level: 'conflict', system: 'tezos', block: null, k: 2, m: 1 },
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('lagged.tez');
  await input.press('Enter');

  const webviewUrl = async () =>
    window.evaluate(() => {
      const wv = document.querySelector('webview.active, webview:not(.hidden)');
      return wv?.getURL?.() || '';
    });

  await expect.poll(webviewUrl, { timeout: 10_000 }).toMatch(/pages\/ens-conflict\.html/);

  // Both disputed heads are shown with the provider that claimed them, and a
  // null block must not break the page. Polled — the webview element is
  // replaced across the interstitial navigation.
  let rendered = {};
  const readInterstitial = async () =>
    window.evaluate(() => {
      const wv = document.querySelector('webview.active, webview:not(.hidden)');
      if (!wv) return {};
      return wv.executeJavaScript(
        '({ text: document.body.innerText, hasContinue: Boolean(document.getElementById("continue-btn")) })'
      );
    });
  await expect
    .poll(
      async () => {
        rendered = await readInterstitial();
        return rendered.text || '';
      },
      { timeout: 10_000 }
    )
    .toContain('chain head #400');

  expect(rendered.text).toContain('lagged.tez');
  expect(rendered.text).toContain('rpc-one.test');
  expect(rendered.text).toContain('chain head #1000');
  expect(rendered.text).toContain('rpc-two.test');
  // No continue-once escape hatch on a conflict.
  expect(rendered.hasContinue).toBe(false);
});
