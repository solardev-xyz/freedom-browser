// Unverified-name interstitial for Tezos Domains — a `.tez` name that only
// one RPC could confirm is soft-blocked, and the page's "Continue once"
// button must actually navigate to the resolved content. `ens://<name>.tez`
// is not a parseable input (parseEnsInput rejects the legacy scheme for
// Tezos names), so re-dispatching the continue with that prefix made the
// button a silent no-op — this spec drives the real button.

const { test, expect } = require('./fixtures');

test('the unverified interstitial "Continue once" loads the .tez content', async ({
  window,
  harness,
}) => {
  await harness.setEnsFixture('retry.tez', {
    type: 'ok',
    system: 'tezos',
    protocol: 'ipfs',
    decoded: 'QmRetryTez',
    uri: 'ipfs://QmRetryTez',
    trust: { level: 'unverified', system: 'tezos', agreed: ['rpc-one.test'] },
  });
  await harness.setContentFixture('ipfs://retry.tez/', {
    body: '<html><body>retry.tez content loaded</body></html>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('retry.tez');
  await input.press('Enter');

  const webviewUrl = async () =>
    window.evaluate(() => {
      const wv = document.querySelector('webview.active, webview:not(.hidden)');
      return wv?.getURL?.() || '';
    });

  // Single-provider agreement → soft block on the interstitial.
  await expect.poll(webviewUrl, { timeout: 10_000 }).toMatch(/pages\/ens-unverified\.html/);

  // The interstitial is chrome, not content (#235): the address bar keeps the
  // name the user typed and must never expose the interstitial's own
  // `file:///…/pages/ens-unverified.html` path. Polled on the interstitial's
  // rendered name so the assertion runs after the navigation has committed
  // (dom-ready follows did-navigate, which is what repaints the address bar),
  // then read once — a retrying matcher could otherwise go green on the
  // pre-navigation value before the file:// path replaced it.
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.executeJavaScript?.('document.getElementById("name-el")?.textContent || ""');
        }),
      { timeout: 10_000 }
    )
    .toBe('retry.tez');
  expect(await input.inputValue()).toBe('retry.tez');

  // Click the interstitial's own button inside the webview so the real
  // sendToHost → `ens:continue-unverified` ipc-message path runs.
  await window.evaluate(() => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    return wv.executeJavaScript('document.getElementById("continue-btn").click()');
  });

  // Continue once re-dispatches the bare name and lands on the resolved
  // content, keeping the .tez name as the origin.
  await expect.poll(webviewUrl, { timeout: 10_000 }).toMatch(/^ipfs:\/\/retry\.tez/);
  await expect(input).toHaveValue(/^ipfs:\/\/retry\.tez/);
});
