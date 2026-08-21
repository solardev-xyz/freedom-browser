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
