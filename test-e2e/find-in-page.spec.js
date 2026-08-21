// Find-in-page — open the bar with Cmd/Ctrl+F, search fixture-served
// content in the active webview, walk matches with Enter/Shift+Enter,
// and close with Escape.
//
// The shortcut is pressed while the address bar (browser chrome) has
// focus: synthetic CDP key events don't trigger native menu accelerators,
// so the specs exercise the renderer's window-level Cmd/Ctrl+F fallback.
// With the page itself focused the same path runs via the Edit-menu
// accelerator, which e2e cannot simulate.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const FIXTURE_BODY =
  '<!doctype html><title>find fixture</title>' +
  '<p>needle one</p><p>needle two</p><p>NEEDLE three</p>';

// Navigate the active tab to the bzz:// fixture and wait until the content
// is committed inside the webview — findInPage can only see rendered pages.
async function loadFixturePage(window, harness) {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, { body: FIXTURE_BODY });

  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(`bzz://${SAMPLE_BZZ_HASH}/`);
  await address.press('Enter');

  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            return await wv.executeJavaScript('document.body ? document.body.textContent : null');
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for the find fixture page to render', timeout: 10_000 }
    )
    .toContain('needle one');
}

// Focus the chrome and open the bar via the renderer's keydown fallback.
async function openFindBar(window) {
  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press('ControlOrMeta+f');
  await expect(window.locator('[data-test="find-bar"]')).toBeVisible();
}

test('finds matches case-insensitively and cycles with Enter / Shift+Enter', async ({
  window,
  harness,
}) => {
  await loadFixturePage(window, harness);
  await openFindBar(window);

  const input = window.locator('[data-test="find-bar-input"]');
  const counter = window.locator('[data-test="find-bar-count"]');
  await expect(input).toBeFocused();

  // Find-as-you-type (debounced); "needle" hits NEEDLE too (Chromium's
  // find is case-insensitive by default).
  await input.fill('needle');
  await expect(counter).toHaveText('1/3');

  await input.press('Enter');
  await expect(counter).toHaveText('2/3');

  await input.press('Shift+Enter');
  await expect(counter).toHaveText('1/3');

  // Esc closes the bar and clears the highlights.
  await input.press('Escape');
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
});

test('zero matches shows 0/0 and tints the input', async ({ window, harness }) => {
  await loadFixturePage(window, harness);
  await openFindBar(window);

  const input = window.locator('[data-test="find-bar-input"]');
  await input.fill('definitely-not-on-this-page');

  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('0/0');
  await expect(input).toHaveClass(/find-bar-input--no-matches/);
});

test('closing right after typing leaves no orphaned find session', async ({ window, harness }) => {
  await loadFixturePage(window, harness);
  await openFindBar(window);

  const input = window.locator('[data-test="find-bar-input"]');
  const counter = window.locator('[data-test="find-bar-count"]');

  // Type and close inside the find-as-you-type debounce window: the queued
  // search must be dropped, not run against a bar the user already closed.
  await input.fill('needle');
  await input.press('Escape');
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();

  // Well past the debounce — the counter stays blank (no session ran) and
  // the page carries no highlights.
  await window.waitForTimeout(600);
  await expect(counter).toHaveText('');
  expect(
    await window.evaluate(async () => {
      const wv = document.querySelector('webview:not(.hidden)');
      return wv.executeJavaScript('window.getSelection().toString()');
    })
  ).toBe('');
});

test('switching tabs closes the find bar', async ({ window }) => {
  await openFindBar(window);

  // Opening a new tab activates it — the bar must not survive the switch.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
});
