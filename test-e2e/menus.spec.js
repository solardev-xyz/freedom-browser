// Hamburger and Nodes menus — dismissal.
//
// #306: Escape is how every other dismissible surface in the chrome closes
// (tab and page context menus, the bookmark menu, the trust popover, the
// permission prompt, the find bar). These two did not close on it at all, and
// they raise `#menu-backdrop` over the whole window — so the only way out was
// the mouse. Chrome closes the open menu on Escape, innermost submenu first,
// and gives the keyboard back to the button that opened it.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const menuState = (window) =>
  window.evaluate(() => ({
    hamburger: document.getElementById('menu-dropdown')?.classList.contains('open') === true,
    nodes: document.getElementById('bee-menu-dropdown')?.classList.contains('open') === true,
    flyout: document.getElementById('profile-menu')?.hidden === false,
    backdrop: document.getElementById('menu-backdrop')?.classList.contains('hidden') === false,
    focused: document.activeElement?.id || '',
  }));

test('Escape closes the hamburger menu and returns focus to its button', async ({ window }) => {
  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, backdrop: true });

  await window.keyboard.press('Escape');

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ hamburger: false, backdrop: false, focused: 'menu-button' });
});

test('Escape closes the Nodes menu and returns focus to its button', async ({ window }) => {
  await window.locator('#bee-menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ nodes: true, backdrop: true });

  await window.keyboard.press('Escape');

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ nodes: false, backdrop: false, focused: 'bee-menu-button' });
});

test('Escape closes the Profiles flyout first, the hamburger on the second press', async ({
  window,
}) => {
  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true });

  // A click on the Profiles row opens the flyout immediately (the hover delay
  // is for the pointer path).
  await window.locator('#profile-menu-btn').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, flyout: true });

  await window.keyboard.press('Escape');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ flyout: false, hamburger: true, focused: 'profile-menu-btn' });

  await window.keyboard.press('Escape');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ hamburger: false, backdrop: false, focused: 'menu-button' });
});

test('the backdrop stops swallowing clicks once Escape has closed the menu', async ({ window }) => {
  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, backdrop: true });

  await window.keyboard.press('Escape');
  await expect.poll(() => menuState(window)).toMatchObject({ backdrop: false });

  // With the backdrop up this click would land on it instead of the address
  // bar — the concrete cost of a menu with no keyboard way out.
  await window.locator('[data-test="address-input"]').click();
  await expect(window.locator('[data-test="address-input"]')).toBeFocused();
});

// Chrome closes only the *innermost* surface on one Escape press: dismissing a
// menu never also cancels whatever the page is doing behind it. The menu
// handler consumes the press with `preventDefault()`, and navigation.js's
// window-level Escape (stop loading + repaint the address bar + blur) stands
// down on `defaultPrevented`. `stopPropagation()` could not have done this —
// both listeners sit on `window`, and same-node listeners still run.
const loadState = (window) =>
  window.evaluate(() => ({
    reload: document.getElementById('reload-btn')?.dataset?.state || '',
    address: document.getElementById('address-input')?.value || '',
    focused: document.activeElement?.id || '',
  }));

test('Escape closing a menu leaves an in-flight page load running', async ({ window, harness }) => {
  // A fixture that holds its response open, so the tab is genuinely still
  // loading while the menu is up.
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: '<!doctype html><title>slow</title><h1>slow</h1>',
    delayMs: 8000,
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(SAMPLE_BZZ_HASH);
  await input.press('Enter');

  // The stop/reload button in its `stop` state is the app's own signal that a
  // load is in flight.
  await expect.poll(() => loadState(window)).toMatchObject({ reload: 'stop' });
  const loading = await loadState(window);

  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, backdrop: true });

  await window.keyboard.press('Escape');

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ hamburger: false, backdrop: false, focused: 'menu-button' });

  // The load is untouched: still in flight, the address bar was not repainted,
  // and the focus the menu handed back to its button is still there.
  expect(await loadState(window)).toEqual({
    reload: 'stop',
    address: loading.address,
    focused: 'menu-button',
  });

  // With no menu open, the very next Escape reaches the stop-loading handler —
  // the behaviour the guard above must not have removed.
  await window.keyboard.press('Escape');
  await expect.poll(() => loadState(window)).toMatchObject({ reload: 'reload' });
});

// #326: Downloads sits directly after History in the hamburger, Chrome's
// order (New tab, New window, New Incognito window, History, Downloads, …),
// with its shortcut hint rendered like every other row's.
test('the hamburger lists Downloads directly after History, with its shortcut hint', async ({
  window,
}) => {
  await window.locator('#menu-button').click();
  await expect(window.locator('#downloads-btn')).toBeVisible();

  const rows = await window.evaluate(() =>
    [...document.querySelectorAll('#menu-dropdown .menu-item')].map((el) => ({
      id: el.id,
      label: el.querySelector('.menu-item-label')?.textContent,
      hint: el.querySelector('.menu-item-shortcut')?.textContent || '',
    }))
  );
  const ids = rows.map((row) => row.id);
  expect(ids.indexOf('downloads-btn')).toBe(ids.indexOf('history-btn') + 1);

  const downloads = rows[ids.indexOf('downloads-btn')];
  const history = rows[ids.indexOf('history-btn')];
  expect(downloads.label).toBe('Downloads');
  // Same hint format as its neighbour ('Ctrl+Shift+J' / '⇧⌘J'), never the
  // unseparated 'CtrlShiftJ' form (#225).
  expect(downloads.hint).toMatch(/^(Ctrl\+Shift\+J|⇧⌘J)$/);
  expect(/[+]/.test(downloads.hint)).toBe(/[+]/.test(history.hint));

  // Clicking it closes the menu and lands on the downloads page.
  const tabs = window.locator('[data-test="tab"]');
  const initialTabs = await tabs.count();
  const activeUrl = () =>
    window.evaluate(() => {
      const wv = document.querySelector('webview.active, webview:not(.hidden)');
      return wv?.getURL?.() || wv?.getAttribute?.('src') || '';
    });

  await window.locator('#downloads-btn').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: false });

  await expect.poll(activeUrl, { timeout: 10_000 }).toMatch(/pages\/downloads\.html/);
  await expect(tabs).toHaveCount(initialTabs + 1);

  // Focusing that tab hands the keyboard to its <webview>. Settle on that
  // before driving the hamburger again, so the second open starts from a known
  // state rather than mid-transfer. (The transfer's window `blur` used to close
  // the menu that came next, which is what made this test flake in CI; the
  // dismissal now ignores an in-window guest blur — see the dedicated test
  // below — so this wait is a settle point, not the thing carrying the test.)
  await expect
    .poll(() => window.evaluate(() => document.activeElement?.tagName), { timeout: 10_000 })
    .toBe('WEBVIEW');

  // The internal-page singleton: a second open focuses that tab, it never
  // opens a duplicate. Switch away first so landing back on the downloads page
  // is positive evidence the click was processed — a bare count-unchanged
  // assertion after a fixed wait also passes when the second open simply hasn't
  // happened yet (same shape downloads.spec.js uses for the shelf's row).
  await window.locator('[data-test="tab"]').first().click();
  await expect.poll(activeUrl, { timeout: 10_000 }).not.toMatch(/pages\/downloads\.html/);

  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true });
  await window.locator('#downloads-btn').click();
  await expect.poll(activeUrl, { timeout: 10_000 }).toMatch(/pages\/downloads\.html/);
  await expect(tabs).toHaveCount(initialTabs + 1);
});

// A `<webview>` guest of this window taking focus fires the renderer's own
// `window` `blur` — but the window never lost focus, so it must not dismiss
// chrome. `<webview>.focus()` resolves asynchronously (the #304/#319
// asynchrony), so every tab activation that hands the page the keyboard emits
// that blur at a moment nothing in the chrome controls: on a loaded machine it
// lands *after* the user has opened the next menu and takes it away under the
// pointer. That is what made the second Downloads open above fail in CI — the
// menu closed between opening it and clicking the row, so the click reached
// the page and the row never ran.
//
// Real window-level blur (alt-tab, another app) still dismisses: it arrives
// from the main process as `menus:close` (`mainWindow.js` → `closeAllMenus`),
// which is the accurate signal.
test('a guest taking focus does not dismiss the open chrome menus', async ({ window }) => {
  // Exactly what a tab activation does, just issued explicitly so the transfer
  // provably lands while the menu is up.
  const stealFocusForTheGuest = () =>
    window.evaluate(
      () =>
        new Promise((resolve) => {
          window.addEventListener('blur', () => setTimeout(resolve, 0), { once: true });
          document.querySelector('webview:not(.hidden)')?.focus();
        })
    );

  await window.locator('#menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, backdrop: true });

  await stealFocusForTheGuest();
  // Still open — and the keyboard is back in the chrome, so Escape (a listener
  // on this window) still reaches the menu instead of dying in the guest.
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ hamburger: true, backdrop: true, focused: 'menu-button' });

  // Its Profiles flyout hangs off the same backdrop: closing only the flyout
  // would leave the two out of step.
  await window.locator('#profile-menu-btn').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, flyout: true });
  await stealFocusForTheGuest();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: true, flyout: true });

  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ hamburger: false, flyout: false, backdrop: false });

  // Same for the Nodes menu, the other half of `closeMenus`.
  await window.locator('#bee-menu-button').click();
  await expect.poll(() => menuState(window)).toMatchObject({ nodes: true, backdrop: true });
  await stealFocusForTheGuest();
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ nodes: true, backdrop: true, focused: 'bee-menu-button' });
  await window.keyboard.press('Escape');
  await expect.poll(() => menuState(window)).toMatchObject({ nodes: false, backdrop: false });
});
