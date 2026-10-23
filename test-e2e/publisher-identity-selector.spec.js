// Publisher identity selector — identities the main process flags as
// `unavailable` (a stored Ethereum wallet identity, a mode removed by
// freedom-core design 0002 #89) must render as inert, not as an ordinary
// pick that only fails later.
//
// The selector is shared by the feed prompt, the Swarm permission screen
// and publisher identity management, so asserting it here covers all
// three call sites at once.

const { test, expect, clickOverGuest } = require('./fixtures');

const STATE = {
  origin: 'myapp.eth',
  activeIdentityId: 'app-scoped:0',
  identities: [
    {
      id: 'app-scoped:0',
      mode: 'app-scoped',
      label: 'myapp.eth identity',
      publisherKeyIndex: 0,
      owner: '0x1111111111111111111111111111111111111111',
      stored: true,
    },
    {
      id: 'app-scoped:1',
      mode: 'app-scoped',
      label: 'Second identity',
      publisherKeyIndex: 1,
      owner: '0x2222222222222222222222222222222222222222',
      stored: true,
    },
    {
      id: 'ethereum-wallet:1',
      mode: 'ethereum-wallet',
      label: 'Main Wallet',
      walletIndex: 1,
      owner: '0x3333333333333333333333333333333333333333',
      stored: true,
      unavailable: true,
    },
  ],
};

test('an unavailable publisher identity renders inert and cannot be selected', async ({
  window,
}) => {
  const result = await window.evaluate(async (state) => {
    const mod = await import('./lib/wallet/publisher-identity-selector.js');

    // Park the selector over the chrome so it is visible for the shot.
    const host = document.createElement('div');
    host.id = 'e2e-identity-selector';
    host.style.cssText =
      'position:fixed;top:140px;left:50%;transform:translateX(-50%);width:340px;z-index:99999;'
      + 'background:var(--bg);padding:12px;border-radius:10px;';
    document.body.appendChild(host);

    const selected = [];
    mod.renderPublisherIdentitySelector(host, state, {
      onSelect: (identity) => selected.push(identity.id),
    });

    host.querySelector('.publisher-identity-selector-btn').click();

    const items = Array.from(host.querySelectorAll('.publisher-identity-selector-item'));
    const unavailable = items.find((item) => item.textContent.includes('Main Wallet'));
    const usable = items.find((item) => item.textContent.includes('Second identity'));

    unavailable.click();
    usable.click();

    return {
      unavailableDisabled: unavailable.disabled,
      unavailableNote: unavailable.textContent.includes('sign feeds'),
      usableDisabled: usable.disabled,
      selected,
    };
  }, STATE);

  expect(result.unavailableDisabled).toBe(true);
  expect(result.unavailableNote).toBe(true);
  expect(result.usableDisabled).toBe(false);
  // Clicking the unavailable row is a no-op; the usable one still selects.
  expect(result.selected).toEqual(['app-scoped:1']);

  // Selecting closes the dropdown; reopen it so the shot shows the list.
  // Wait for the close to settle before toggling — under load a reopen click
  // that lands mid-close races the toggle and leaves the list hidden.
  const list = window.locator('#e2e-identity-selector .wallet-selector-list');
  // The selector was parked over the tab's `<webview>` (`clickOverGuest`).
  await expect(list).toBeHidden();
  await clickOverGuest(window.locator('#e2e-identity-selector .publisher-identity-selector-btn'));
  await expect(list).toBeVisible();
  const box = await window.locator('#e2e-identity-selector').boundingBox();
  await window.screenshot({
    path: '/tmp/publisher-identity-unavailable.png',
    clip: { x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 300 },
  });
});
