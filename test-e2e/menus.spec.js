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

  // Focusing that tab hands the keyboard to its <webview>, and the transfer is
  // asynchronous: it fires a window `blur`, which menus.js closes every menu
  // on. Wait for it to land before driving the hamburger again — a late blur
  // otherwise closes the menu between opening it and clicking the row, and the
  // second open never happens at all.
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
