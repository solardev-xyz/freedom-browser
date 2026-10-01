// Tab audio indicator + click-to-mute — mute via the tab context menu,
// unmute via the on-tab speaker button, and the menu label round-trip.

const { test, expect, clickOverGuest } = require('./fixtures');

// Right-click a tab and click a context-menu action until `verify` passes.
// Retried as a unit: a stray window blur (e.g. the previous Electron
// instance releasing OS focus) can close the menu between the right-click
// and the item click, turning the click into a no-op. The menu opens over the
// tab's `<webview>`, so the item click itself can also go to the guest
// (`clickOverGuest`); that leaves the menu open, and its backdrop would take
// the next right-click, so an open menu is not reopened.
async function clickTabContextAction(window, tabLocator, action, verify) {
  const menu = window.locator('#tab-context-menu');
  const landed = () =>
    verify().then(
      () => true,
      () => false
    );
  await expect(async () => {
    if (!(await menu.isVisible())) {
      await tabLocator.click({ button: 'right' });
      await expect(menu).toBeVisible({ timeout: 1000 });
    }
    await clickOverGuest(
      window,
      () => menu.locator(`[data-action="${action}"]`).click({ timeout: 1000 }),
      landed,
      { timeout: 5000 }
    );
  }).toPass({ timeout: 15_000 });
}

test('Mute Tab context-menu item toggles the muted indicator', async ({ window }) => {
  const tab = window.locator('[data-test="tab"]').first();
  const audioBtn = tab.locator('[data-test="tab-audio"]');

  // No audio state initially: indicator hidden.
  await expect(audioBtn).toBeHidden();

  // Muted via the context menu: indicator shows the muted speaker even
  // without audio playing.
  await clickTabContextAction(window, tab, 'mute', async () => {
    await expect(tab).toHaveAttribute('data-audio-state', 'muted', { timeout: 1000 });
  });
  await expect(audioBtn).toBeVisible();

  // Clicking the indicator unmutes (and hides it again — nothing audible).
  await audioBtn.click();
  await expect(audioBtn).toBeHidden();

  // Menu label reflects the unmuted state again.
  const muteItem = window.locator('#tab-context-menu [data-action="mute"]');
  await expect(async () => {
    await tab.click({ button: 'right' });
    await expect(muteItem).toHaveText('Mute Tab', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await window.keyboard.press('Escape');
});

test('a muted pinned tab still shows the audio badge', async ({ window }) => {
  const tab = window.locator('[data-test="tab"]').first();
  const audioBtn = tab.locator('[data-test="tab-audio"]');

  await clickTabContextAction(window, tab, 'pin', async () => {
    await expect(tab).toHaveClass(/pinned/, { timeout: 1000 });
  });

  // Muting a pinned tab must keep an indicator visible — the fixed 36px
  // width hides the inline button, so the badge overlay takes over.
  await clickTabContextAction(window, tab, 'mute', async () => {
    await expect(tab).toHaveAttribute('data-audio-state', 'muted', { timeout: 1000 });
  });
  await expect(audioBtn).toBeVisible();

  // The badge is still a working mute toggle.
  await audioBtn.click();
  await expect(audioBtn).toBeHidden();
});
