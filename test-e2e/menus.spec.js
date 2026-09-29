// Hamburger and Nodes menus — dismissal.
//
// #306: Escape is how every other dismissible surface in the chrome closes
// (tab and page context menus, the bookmark menu, the trust popover, the
// permission prompt, the find bar). These two did not close on it at all, and
// they raise `#menu-backdrop` over the whole window — so the only way out was
// the mouse. Chrome closes the open menu on Escape, innermost submenu first,
// and gives the keyboard back to the button that opened it.

const { test, expect, waitForPopoverFrame, SAMPLE_BZZ_HASH } = require('./fixtures');
// The permission indicator's popover is the trust popover's sibling on the
// backdrop-dismissal path (#67), and reaching it needs a real granted
// permission — the same fixture page and helpers permissions.spec.js drives.
const {
  FIXTURE_BODY: PERMISSION_FIXTURE_BODY,
  clickAsk,
  answerPrompt,
  gotoPermissionFixture,
} = require('./permission-fixtures');

const menuState = (window) =>
  window.evaluate(() => ({
    hamburger: document.getElementById('menu-dropdown')?.classList.contains('open') === true,
    nodes: document.getElementById('bee-menu-dropdown')?.classList.contains('open') === true,
    flyout: document.getElementById('profile-menu')?.hidden === false,
    backdrop: document.getElementById('menu-backdrop')?.classList.contains('hidden') === false,
    // The other surfaces the backdrop is up for (#67): the autocomplete
    // dropdown raises it, and any of the three address-bar surfaces that raise
    // none of their own — the trust shield's popover, the permission
    // indicator's, or the GitHub-bridge panel — can be open underneath it.
    dropdown:
      document.getElementById('autocomplete-dropdown')?.classList.contains('hidden') === false,
    popover: document.getElementById('trust-popover')?.hidden === false,
    permPopover: document.getElementById('permission-popover')?.hidden === false,
    permExpanded: document.getElementById('permission-indicator')?.getAttribute('aria-expanded'),
    bridgePanel:
      document.getElementById('github-bridge-panel')?.classList.contains('hidden') === false,
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

  // The row is in the DOM, but a synthetic click only reaches the chrome once
  // the frame carrying the menu has gone out — until then the browser routes
  // it to the `<webview>` behind it (see `waitForPopoverFrame`).
  await waitForPopoverFrame(window);
  await window.locator('#downloads-btn').click();
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: false });

  await expect.poll(activeUrl, { timeout: 10_000 }).toMatch(/pages\/downloads\.html/);
  await expect(tabs).toHaveCount(initialTabs + 1);

  // Focusing that tab hands the keyboard to its <webview>. Settle on that
  // before driving the hamburger again, so the second open starts from a known
  // state rather than mid-transfer. (The transfer's window `blur` used to close
  // the menu that came next, which is what made this test flake in CI;
  // `onWindowDeactivated` now ignores an in-window guest blur — see the
  // dedicated test below — so this wait is a settle point, not the thing
  // carrying the test.)
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
  await waitForPopoverFrame(window);
  await window.locator('#downloads-btn').click();
  await expect.poll(activeUrl, { timeout: 10_000 }).toMatch(/pages\/downloads\.html/);
  await expect(tabs).toHaveCount(initialTabs + 1);

  // The menu is gone and the keyboard is back in the chrome, not stranded in
  // the guest that the second activation just handed the page focus to.
  await expect.poll(() => menuState(window)).toMatchObject({ hamburger: false });
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
// Real window-level blur (alt-tab, another app) still dismisses. The two are
// told apart by `document.hasFocus()` in `lib/window-deactivation.js` (#328):
// it stays true while focus is anywhere inside this window — a guest included
// — and goes false only when the OS hands another window the keyboard.
// `menu-backdrop.js` handles the other half of that same event, reclaiming the
// keyboard for the chrome element the guest cut in front of, which is what the
// `focused:` assertions below pin.
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

// The backdrop dismisses every transient overlay, not only the menus (#67).
//
// The trust popover is one of the two surfaces that raise no backdrop of their
// own (`ui-consistency.md`), so it can still be open under the one
// *autocomplete* raises: that `show()` closes the menus but, unlike every other
// raiser, not the popover. What closes the popover is a document `click` in
// navigation.js — and a press on the backdrop released inside the guest never
// produces one, because the pointer moves into the `<webview>`'s own frame and
// the embedder sees the `mousedown` without the matching `mouseup`. That left
// the popover stranded: no menu, no dropdown, no shield highlight, and nothing
// under the pointer to dismiss it. The backdrop is the neutral surface, so its
// `mousedown` resets the popover too — the mirror of `onAnyMenuOpening`, which
// has always chained the same two.
const RESOLVED_HASH = 'c'.repeat(64);

// A verified ENS name in the address bar is what grows the trust shield the
// popover hangs off.
const loadVerifiedName = async (window, harness) => {
  await harness.setEnsFixture('name.eth', {
    type: 'ok',
    name: 'name.eth',
    protocol: 'bzz',
    decoded: RESOLVED_HASH,
    uri: `bzz://${RESOLVED_HASH}`,
    trust: { level: 'verified', queried: ['a.test', 'b.test'], agreed: ['a.test', 'b.test'] },
  });
  await harness.setProbeFixture(RESOLVED_HASH, { ok: true });
  await harness.setContentFixture('bzz://name.eth/', {
    body: '<!doctype html><title>ResolvedName</title><h1>resolved</h1>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('name.eth');
  await input.press('Enter');
  await expect(window.locator('#trust-shield')).toBeVisible({ timeout: 15_000 });
};

// The popover open *and* the backdrop up. Both steps are keyboard-driven on
// purpose: a click anywhere outside the popover would dismiss it through the
// document-`click` listener these tests are about, and ArrowDown opens the
// autocomplete dropdown without rewriting the address bar — typing drops the
// shield on the first keystroke, and the popover with it.
const raiseTheBackdropOverTheTrustPopover = async (window) => {
  await window.locator('#trust-shield').click();
  await expect(window.locator('#trust-popover')).toBeVisible();
  await window.keyboard.press('Control+l');
  await window.keyboard.press('ArrowDown');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ popover: true, dropdown: true, backdrop: true });
};

// One point on the backdrop near the bottom edge of the window, one over the
// middle of the guest page.
const backdropPoints = (window) =>
  window.evaluate(() => {
    const guest = document.querySelector('webview:not(.hidden)').getBoundingClientRect();
    return {
      press: { x: Math.round(window.innerWidth / 2), y: window.innerHeight - 60 },
      guest: {
        x: Math.round(guest.x + guest.width / 2),
        y: Math.round(guest.y + guest.height / 2),
      },
    };
  });

const watchDocumentClicks = async (window) => {
  await window.evaluate(() => {
    window.__backdropClicks = [];
    document.addEventListener('click', (event) => {
      window.__backdropClicks.push(event.target?.id || event.target?.tagName || '?');
    });
  });
  return () => window.evaluate(() => window.__backdropClicks);
};

test('a press on the backdrop released inside the page closes the trust popover', async ({
  window,
  harness,
}) => {
  await loadVerifiedName(window, harness);
  await raiseTheBackdropOverTheTrustPopover(window);

  const points = await backdropPoints(window);
  const documentClicks = await watchDocumentClicks(window);

  await window.mouse.move(points.press.x, points.press.y);
  await window.mouse.down();
  await window.mouse.move(points.guest.x, points.guest.y);
  await window.mouse.up();

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ popover: false, dropdown: false, backdrop: false });

  // The premise, pinned: this document saw no `click` at all, so what dismissed
  // the popover was the backdrop's own `mousedown` and not navigation.js'
  // document-`click` closer. Should a future Chromium start delivering a click
  // for this gesture, this is the signal that the test has stopped covering the
  // stranded case rather than quietly passing for the wrong reason.
  expect(await documentClicks()).toEqual([]);
});

// Regression coverage for the reset itself, not a mutation guard. An ordinary
// click on the backdrop *sometimes* still produces a document `click`: if
// Chromium has not re-routed hit-testing into the guest by the time the
// `mouseup` arrives, the embedder sees it on the `<webview>` host and
// dispatches the click to the common ancestor `<body>`, where the surface's own
// click-away closer runs with no help from `closeAllOverlays`. The drag-off
// tests above are what pin the fix -- the pointer move gives the routing time
// to settle, so no click is ever dispatched and `toEqual([])` says so.
test('a click on the backdrop closes the dropdown and the trust popover together', async ({
  window,
  harness,
}) => {
  await loadVerifiedName(window, harness);
  await raiseTheBackdropOverTheTrustPopover(window);

  const points = await backdropPoints(window);
  await window.mouse.click(points.press.x, points.press.y);

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ popover: false, dropdown: false, backdrop: false });
  // The shield stays — only its popover was transient.
  await expect(window.locator('#trust-shield')).toBeVisible();
});

// The permission indicator's popover is the trust popover's sibling here: the
// other address-bar surface that raises no backdrop of its own, dismissed by
// its own document `click` listener in site-permissions-ui.js — so the same
// press-on-the-backdrop-release-in-the-guest gesture stranded it in exactly
// the same way, aria-expanded still true over a page with no dropdown and no
// menu. `closeAllOverlays` closes both.

// A granted permission is what grows the address-bar indicator the popover
// hangs off.
const loadGrantedPermission = async (window, harness) => {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, { body: PERMISSION_FIXTURE_BODY });
  await gotoPermissionFixture(window);
  await clickAsk(window);
  await expect(window.locator('[data-test="permission-prompt"]')).toBeVisible();
  await answerPrompt(window, 'allow');
  await expect(window.locator('[data-test="permission-indicator"]')).toBeVisible();
};

// The popover open *and* the backdrop up — keyboard-driven past the indicator
// click for the same reason as its trust-popover twin above.
const raiseTheBackdropOverThePermissionPopover = async (window) => {
  await window.locator('[data-test="permission-indicator"]').click();
  await expect(window.locator('#permission-popover')).toBeVisible();
  await window.keyboard.press('Control+l');
  await window.keyboard.press('ArrowDown');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ permPopover: true, dropdown: true, backdrop: true });
};

test('a press on the backdrop released inside the page closes the permission popover', async ({
  window,
  harness,
}) => {
  await loadGrantedPermission(window, harness);
  await raiseTheBackdropOverThePermissionPopover(window);

  const points = await backdropPoints(window);
  const documentClicks = await watchDocumentClicks(window);

  await window.mouse.move(points.press.x, points.press.y);
  await window.mouse.down();
  await window.mouse.move(points.guest.x, points.guest.y);
  await window.mouse.up();

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ permPopover: false, dropdown: false, backdrop: false, permExpanded: 'false' });

  // Same premise as the trust popover's case: no `click` reached this
  // document, so what closed the popover was the backdrop's own `mousedown`.
  expect(await documentClicks()).toEqual([]);
});

// Regression coverage for the reset itself, not a mutation guard. An ordinary
// click on the backdrop *sometimes* still produces a document `click`: if
// Chromium has not re-routed hit-testing into the guest by the time the
// `mouseup` arrives, the embedder sees it on the `<webview>` host and
// dispatches the click to the common ancestor `<body>`, where the surface's own
// click-away closer runs with no help from `closeAllOverlays`. The drag-off
// tests above are what pin the fix -- the pointer move gives the routing time
// to settle, so no click is ever dispatched and `toEqual([])` says so.
test('a click on the backdrop closes the dropdown and the permission popover together', async ({
  window,
  harness,
}) => {
  await loadGrantedPermission(window, harness);
  await raiseTheBackdropOverThePermissionPopover(window);

  const points = await backdropPoints(window);
  await window.mouse.click(points.press.x, points.press.y);

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ permPopover: false, dropdown: false, backdrop: false, permExpanded: 'false' });
  // The indicator stays — only its popover was transient.
  await expect(window.locator('[data-test="permission-indicator"]')).toBeVisible();
});

// Opening a menu puts the permission popover away too, the other half of the
// mirror: `onAnyMenuOpening` chains the same set as `closeAllOverlays`, so the
// popover can never end up stacked under a menu.
//
// Driven from the *tab context* menu rather than the hamburger on purpose. A
// left-click on any chrome button is itself a click-away that the popover's own
// document `click` listener already closes it on, so that gesture passes
// whether or not `onAnyMenuOpening` chains this popover — it proves nothing.
// A right-click dispatches `contextmenu` and no `click`, so the raiser's own
// chain is the only thing that can close the popover here.
test('right-clicking a tab to open its menu closes the permission popover', async ({
  window,
  harness,
}) => {
  await loadGrantedPermission(window, harness);
  await window.locator('[data-test="permission-indicator"]').click();
  await expect(window.locator('#permission-popover')).toBeVisible();

  const documentClicks = await watchDocumentClicks(window);
  await window.locator('[data-test="tab"]').first().click({ button: 'right' });

  await expect(window.locator('#tab-context-menu')).toBeVisible();
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ permPopover: false, permExpanded: 'false' });
  expect(await documentClicks()).toEqual([]);
});

// The GitHub-bridge "Seed to Radicle" panel is the third address-bar surface
// that raises no backdrop of its own. It is closed by its own document `click`
// listener and Escape — it has no blur closer at all — so the same
// press-on-the-backdrop-release-in-the-guest gesture stranded it over the page
// with no dropdown, no backdrop and nothing under the pointer to dismiss it.
// `closeAllOverlays` closes all three.

// A GitHub repo page in the address bar is what grows the bridge button the
// panel hangs off.
const loadGithubRepoPage = async (window, harness) => {
  const url = 'https://github.com/octocat/hello-world';
  await harness.setContentFixture(url, {
    body: '<!doctype html><title>hello-world</title><h1>repo</h1>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
  await expect(window.locator('#github-bridge-btn')).toBeVisible({ timeout: 15_000 });
};

// The panel open *and* the backdrop up — keyboard-driven past the button click
// for the same reason as both popovers above: any click outside the panel goes
// through the very document-`click` listener these tests are about.
const raiseTheBackdropOverTheBridgePanel = async (window) => {
  await window.locator('#github-bridge-btn').click();
  await expect(window.locator('#github-bridge-panel')).toBeVisible();
  await window.keyboard.press('Control+l');
  await window.keyboard.press('ArrowDown');
  await expect
    .poll(() => menuState(window))
    .toMatchObject({ bridgePanel: true, dropdown: true, backdrop: true });
};

test('a press on the backdrop released inside the page closes the GitHub-bridge panel', async ({
  window,
  harness,
}) => {
  await loadGithubRepoPage(window, harness);
  await raiseTheBackdropOverTheBridgePanel(window);

  const points = await backdropPoints(window);
  const documentClicks = await watchDocumentClicks(window);

  await window.mouse.move(points.press.x, points.press.y);
  await window.mouse.down();
  await window.mouse.move(points.guest.x, points.guest.y);
  await window.mouse.up();

  await expect
    .poll(() => menuState(window))
    .toMatchObject({ bridgePanel: false, dropdown: false, backdrop: false });

  // Same premise as both popovers' cases: no `click` reached this document, so
  // what closed the panel was the backdrop's own `mousedown`.
  expect(await documentClicks()).toEqual([]);
  // The button stays — only its panel was transient.
  await expect(window.locator('#github-bridge-btn')).toBeVisible();
});

// The `onAnyMenuOpening` half, driven from the tab context menu for the same
// reason as the permission popover's version above: a right-click dispatches
// `contextmenu` and no `click`, so the raiser's own chain is the only thing
// that can close the panel here.
test('right-clicking a tab to open its menu closes the GitHub-bridge panel', async ({
  window,
  harness,
}) => {
  await loadGithubRepoPage(window, harness);
  await window.locator('#github-bridge-btn').click();
  await expect(window.locator('#github-bridge-panel')).toBeVisible();

  const documentClicks = await watchDocumentClicks(window);
  await window.locator('[data-test="tab"]').first().click({ button: 'right' });

  await expect(window.locator('#tab-context-menu')).toBeVisible();
  await expect.poll(() => menuState(window)).toMatchObject({ bridgePanel: false });
  expect(await documentClicks()).toEqual([]);
});

// The page context menu is the one menu raised from *inside* the guest, and it
// was the one raiser not on the `onAnyMenuOpening` chain — so right-clicking the
// page left all three no-backdrop surfaces stacked beside it, the panel worst of
// all since it has no blur closer to fall back on. Driven with a synthetic
// `contextmenu` in the guest (the preload forwards the context to the shell),
// which dispatches no `click` in this document, so the raiser's own chain is
// again the only thing that can close the panel.
const openPageContextMenuInGuest = (window) =>
  window.evaluate(async () => {
    const webview = document.querySelector('webview:not(.hidden)');
    await webview.executeJavaScript(`(() => {
      document.body.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 40, clientY: 40,
      }));
      return true;
    })()`);
  });

test('right-clicking the page to open its menu closes the GitHub-bridge panel', async ({
  window,
  harness,
}) => {
  await loadGithubRepoPage(window, harness);
  await window.locator('#github-bridge-btn').click();
  await expect(window.locator('#github-bridge-panel')).toBeVisible();

  const documentClicks = await watchDocumentClicks(window);
  await openPageContextMenuInGuest(window);

  await expect(window.locator('#page-context-menu')).toBeVisible();
  await expect.poll(() => menuState(window)).toMatchObject({ bridgePanel: false });
  expect(await documentClicks()).toEqual([]);
});
