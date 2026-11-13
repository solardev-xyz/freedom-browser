// The wallet toggle while the window starts, before the chrome's start-up has
// run. The window fixtures wait that start-up out (chromeStarted,
// chrome-window.js), so this spec takes the app from `electronApp` and finds
// the chrome itself, without the barrier.
//
// The window is shown at once and the toggle is static markup in index.html,
// so a user can click it before the sidebar has read the Identity & Wallet
// setting. Such a click used to be dropped without a sign: the toggle had no
// listener yet, or had one whose flag still read off. It now ships disabled
// and is enabled once the setting is known (hidden with the wallet off), so
// an early click is either refused on a visibly disabled toggle or, on an
// enabled one, opens the panel.

const { test, expect } = require('./fixtures');
const { chromeWindow } = require('./chrome-window');

// In the page: as soon as the toggle is shown, click it, in the same task as
// reading whether it was disabled. A disabled button ignores click(), as it
// ignores the user's. With the wallet off the sidebar may have hidden the
// toggle before this runs; there is nothing to click then.
function clickToggleOnceShown() {
  return new Promise((resolve) => {
    const attempt = () => {
      const toggle = document.getElementById('wallet-toggle-btn');
      if (toggle?.classList.contains('hidden')) {
        resolve({ shown: false });
        return;
      }
      if (toggle?.checkVisibility()) {
        const disabled = toggle.disabled;
        toggle.click();
        resolve({ shown: true, disabled });
        return;
      }
      setTimeout(attempt, 1);
    };
    attempt();
  });
}

test.describe('wallet on', () => {
  test.use({ seedSettings: { enableIdentityWallet: true } });

  test('a click on the toggle as soon as it shows is refused visibly or opens the panel', async ({
    electronApp,
  }) => {
    const win = await chromeWindow(electronApp);
    const { shown, disabled } = await win.evaluate(clickToggleOnceShown);
    expect(shown).toBe(true);
    const toggle = win.locator('#wallet-toggle-btn');
    const sidebar = win.locator('#sidebar');

    if (disabled) {
      // Refused, and the user could see it. The panel stayed shut; the
      // toggle comes up enabled once the setting is in, and then works.
      await expect(sidebar).toHaveClass(/\bcollapsed\b/);
      await expect(toggle).toBeEnabled();
      await toggle.click();
    }
    await expect(sidebar).not.toHaveClass(/\bcollapsed\b/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('wallet off', () => {
  test.use({ seedSettings: { enableIdentityWallet: false } });

  test('the toggle, clicked as soon as it shows, leaves the panel shut and is hidden once the setting is in', async ({
    electronApp,
  }) => {
    const win = await chromeWindow(electronApp);
    const { shown, disabled } = await win.evaluate(clickToggleOnceShown);
    // Shown only until the setting is in, so if it was shown at all it was
    // shown disabled.
    if (shown) expect(disabled).toBe(true);

    await expect(win.locator('#wallet-toggle-btn')).toBeHidden();
    await expect(win.locator('#sidebar')).toHaveClass(/\bcollapsed\b/);
  });
});
