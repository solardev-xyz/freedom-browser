// Tab strip — open via the new-tab button, close via the per-tab close
// affordance, count tabs from the renderer DOM directly.
//
// The Chrome-parity behaviours (#303 link dispositions, #304 tab-switch
// focus, #311 strip overflow, #315 context-menu dismissal) are driven with
// real pointer/keyboard input at window coordinates rather than DOM
// `element.click()`, because they are about focus, modifiers and dismissal —
// the exact things a synthetic dispatch cannot exercise.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const PAGE_A = `bzz://${SAMPLE_BZZ_HASH}/`;
const PAGE_B = `bzz://${'b'.repeat(64)}/`;

// A guest swallows input for a moment after it attaches, so the first click on
// a freshly rendered page can be lost — and a lost *link* click is a false
// failure, not a regression. Spend that window on an empty part of the page
// (bottom-right of the webview, clear of every fixture's links) so the click
// under test is the second one. Deliberately not a retry loop: retrying the
// activation itself could paper over the very dispositions being asserted.
async function wakeGuest(window) {
  const spot = await window.evaluate(() => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv) return null;
    const rect = wv.getBoundingClientRect();
    return { x: rect.right - 12, y: rect.bottom - 12 };
  });
  if (spot) await window.mouse.click(spot.x, spot.y);
  await window.waitForTimeout(150);
}

// Serve a page whose only content is a link to `PAGE_B`, and open it in the
// active tab. Returns the link's coordinates in *window* space, so
// `page.mouse` clicks go through the real hit-test path into the guest.
async function openLinkPage(window, harness) {
  await harness.setContentFixture(PAGE_A, {
    body:
      '<!doctype html><title>Page A</title><style>body{margin:0;padding:40px}' +
      'a{display:inline-block;padding:20px;font-size:24px}</style>' +
      `<a id="lnk" href="${PAGE_B}">link</a>`,
  });
  await harness.setContentFixture(PAGE_B, {
    body: '<!doctype html><title>Page B</title><h1>B</h1>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  let point;
  await expect
    .poll(
      async () => {
        point = await window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            const box = await wv.executeJavaScript(
              "(() => { const a = document.getElementById('lnk'); if (!a) return null;" +
                'const r = a.getBoundingClientRect();' +
                'return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()'
            );
            if (!box) return null;
            const rect = wv.getBoundingClientRect();
            return { x: rect.x + box.x, y: rect.y + box.y };
          } catch {
            return null;
          }
        });
        return !!point;
      },
      { message: 'Waiting for the link fixture to render', timeout: 15_000 }
    )
    .toBe(true);
  // Spend the guest's post-attach input-swallow window before the caller's
  // click on the link — see `wakeGuest`.
  await wakeGuest(window);
  return point;
}

// The tab element of the tab *before* the active one carries `before-active`,
// which `toHaveClass(/active/)` also matches — so "tab N is the active one" is
// asserted against the single `.active` element by id rather than by a regex
// over one tab's class string.
const expectActiveTab = (window, tabId) =>
  expect(window.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', String(tabId));

const tabTitles = (window) =>
  window.evaluate(() =>
    [...document.querySelectorAll('[data-test="tab"]')].map((tab) => ({
      title: tab.querySelector('.tab-title')?.textContent,
      active: tab.classList.contains('active'),
    }))
  );

// Click an application-menu item by id. Keyboard shortcuts cannot be driven
// with `page.keyboard` once the page has focus (which, after #304, is where
// focus lives right after a tab switch): input dispatched to the chrome window
// is routed to the focused guest frame, exactly as in a real browser. The
// accelerators are application-menu items in the main process, so clicking the
// item is the same path a real Ctrl+Tab / Ctrl+W takes.
const clickMenuItem = (electronApp, id) =>
  electronApp.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`Menu item not found: ${itemId}`);
    item.click();
  }, id);

// Count real browser windows from the main process rather than Playwright's
// page list: a webview guest surfaces as a page too, and a freshly created
// window's page URL is still `about:blank` for a while on a loaded machine.
const chromeWindowCount = (electronApp) =>
  electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
  );

test('starts with one tab, can open more, can close them', async ({ window }) => {
  const tabs = window.locator('[data-test="tab"]');
  await expect(tabs).toHaveCount(1);

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(2);

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(3);

  // Close the first tab via its close button. Its data-tab-id is "1"
  // because tabs.js counts from one and never recycles ids.
  await window.locator('[data-test="tab"][data-tab-id="1"] [data-test="tab-close"]').click();
  await expect(tabs).toHaveCount(2);
});

test('clicking a tab activates it', async ({ window }) => {
  const tabs = window.locator('[data-test="tab"]');
  await expect(tabs).toHaveCount(1);

  // Open a second tab; new tabs become active automatically.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(2);
  await expectActiveTab(window, 2);

  // Switch back to the first tab.
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expectActiveTab(window, 1);
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).not.toHaveClass(/active/);
});

// #304: activating a tab focuses that tab's page, so scrolling and typing
// work immediately. Before the fix, DOM focus in the chrome document stayed
// on the `<button class="tab">` that was clicked (mouse switch) or on the
// outgoing tab's button (Ctrl+Tab), and the guest reported
// `document.hasFocus() === false`.
test('switching tabs focuses the page, not the tab button', async ({
  window,
  electronApp,
  harness,
}) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>Page A</title><p>a</p>',
  });
  await harness.setContentFixture(PAGE_B, {
    body: '<!doctype html><title>Page B</title><p>b</p>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  // Put the second tab on a real page too: a tab still sitting on the new-tab
  // page hands the keyboard to the address bar instead, which is the next
  // test's subject.
  await input.click();
  await input.fill(PAGE_B);
  await input.press('Enter');

  // Mouse switch back to the first tab.
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const el = document.activeElement;
          return `${el?.tagName}.${el?.className || ''}`;
        }),
      { message: 'Waiting for the page to take focus after a mouse tab switch' }
    )
    .toMatch(/^WEBVIEW/);

  // The focused webview is the visible one, never a hidden background tab.
  expect(await window.evaluate(() => document.activeElement?.classList.contains('hidden'))).toBe(
    false
  );

  // Keyboard switch (Ctrl+Tab) has to do the same — that was the mirror-image
  // half of the bug, which left focus on the *outgoing* tab's button.
  await clickMenuItem(electronApp, 'next-tab');
  await expectActiveTab(window, 2);
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const el = document.activeElement;
          return `${el?.tagName}.${el?.className || ''}`;
        }),
      { message: 'Waiting for the page to take focus after Ctrl+Tab' }
    )
    .toMatch(/^WEBVIEW/);
});

// #304, the other end of the same rule: a tab sitting on this window's new-tab
// page has no focus target inside its guest (`home.html`/`private.html` are
// inert documents), so handing it the keyboard means the next keystroke goes
// nowhere. Chrome focuses the omnibox when you switch to a tab on the NTP.
test('switching back to a tab on the new-tab page focuses the address bar', async ({
  window,
  electronApp,
  harness,
}) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>Page A</title><p>a</p>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  // A second tab, left on the new-tab page.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);

  // Away to the page tab (whose guest takes the keyboard) …
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  const focusedTag = () =>
    window.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.id || ''}`);
  await expect
    .poll(focusedTag, { message: 'Waiting for the page to take focus' })
    .toMatch(/^WEBVIEW/);

  // … and back to the new-tab-page tab by keyboard (Ctrl+Tab), the case the
  // user hits after a switch, not on a fresh tab.
  await clickMenuItem(electronApp, 'next-tab');
  await expectActiveTab(window, 2);
  await expect
    .poll(focusedTag, { message: 'Waiting for the address bar to take focus' })
    .toBe('INPUT.address-input');
  await expect(input).toHaveValue('');

  // The point of focusing it: typing immediately goes into the address bar
  // rather than being swallowed by the inert guest.
  await window.keyboard.type('example.com');
  await expect(input).toHaveValue('example.com');
});

// The other side of #304: with focus living in the guest after every tab
// switch, a keypress no longer reaches the shell's own `keydown` handlers — so
// the page context menu (the one chrome surface raised from *inside* the
// guest) has to take the keyboard while it is up, the way a native menu does,
// or Escape never dismisses it and every item stays live.
test('the page context menu takes the keyboard from the page and hands it back', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>Page A</title><p>a</p>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  // Switch away and back, which is what leaves the guest holding focus.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expectActiveTab(window, 1);
  const focusedTag = () =>
    window.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.id || ''}`);
  await expect
    .poll(focusedTag, { message: 'Waiting for the page to take focus after the tab switch' })
    .toMatch(/^WEBVIEW/);

  // Right-click inside the guest, through the real hit-test path.
  await wakeGuest(window);
  const spot = await window.evaluate(() => {
    const rect = document.querySelector('webview:not(.hidden)').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await window.mouse.click(spot.x, spot.y, { button: 'right' });

  const menu = window.locator('#page-context-menu');
  await expect(menu).toBeVisible();
  // The shell, not the guest, owns the keyboard while the menu is up.
  await expect
    .poll(focusedTag, { message: 'Waiting for the menu to take focus' })
    .toBe('DIV.page-context-menu');

  await window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // …and the page gets it back, so scrolling and typing keep working — read
  // from the guest itself, not just from the chrome document's activeElement.
  await expect
    .poll(focusedTag, { message: 'Waiting for the page to get focus back' })
    .toMatch(/^WEBVIEW/);
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          try {
            return await wv.executeJavaScript('document.hasFocus()');
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for the guest to report the keyboard back' }
    )
    .toBe(true);
});

// #303: Ctrl/Cmd+click and middle-click open a BACKGROUND tab — the tab is
// created and loads, but the current page stays active and keeps focus.
test('ctrl+click and middle-click open a background tab', async ({ window, harness }) => {
  const point = await openLinkPage(window, harness);
  const tabs = window.locator('[data-test="tab"]');
  await expect(tabs).toHaveCount(1);

  await window.keyboard.down('Control');
  await window.mouse.click(point.x, point.y);
  await window.keyboard.up('Control');

  await expect(tabs).toHaveCount(2);
  // Still on Page A, and its tab is still the active one.
  await expectActiveTab(window, 1);
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).not.toHaveClass(/active/);
  // The background tab's webview must be hidden — it is created after the
  // switch that would otherwise have hidden it.
  expect(
    await window.evaluate(() => document.querySelectorAll('webview:not(.hidden)').length)
  ).toBe(1);

  // Middle-click behaves the same way.
  await window.mouse.click(point.x, point.y, { button: 'middle' });
  await expect(tabs).toHaveCount(3);
  await expectActiveTab(window, 1);

  // The background tabs really did load Page B (a background tab that never
  // navigates would pass every assertion above).
  await expect
    .poll(async () => (await tabTitles(window)).map((tab) => tab.title), {
      message: 'Waiting for the background tabs to load Page B',
      timeout: 15_000,
    })
    .toEqual(['Page A', 'Page B', 'Page B']);
});

// Coordinates, in *window* space, of an element in the foreground guest.
async function pointInGuest(window, selector) {
  let point;
  await expect
    .poll(
      async () => {
        point = await window.evaluate(async (sel) => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            const box = await wv.executeJavaScript(
              `(() => { const a = document.querySelector(${JSON.stringify(sel)});` +
                'if (!a) return null; const r = a.getBoundingClientRect();' +
                'return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()'
            );
            if (!box) return null;
            const rect = wv.getBoundingClientRect();
            return { x: rect.x + box.x, y: rect.y + box.y };
          } catch {
            return null;
          }
        }, selector);
        return !!point;
      },
      { message: `Waiting for ${selector} to render in the guest`, timeout: 15_000 }
    )
    .toBe(true);
  return point;
}

const ctrlClick = async (window, point) => {
  await window.keyboard.down('Control');
  await window.mouse.click(point.x, point.y);
  await window.keyboard.up('Control');
};

const tabSnapshot = (window) =>
  window.evaluate(() =>
    [...document.querySelectorAll('[data-test="tab"]')].map((tab) => ({
      id: tab.dataset.tabId,
      title: tab.querySelector('.tab-title')?.textContent,
      active: tab.classList.contains('active'),
    }))
  );

// Open Settings the way a user does — hamburger menu → Settings — and retry the
// whole gesture until `expected` (a tab snapshot) holds.
//
// The gesture can be lost before it reaches the item: a webview guest that
// attaches while the menu is up takes the keyboard, which blurs the chrome
// window, and menus.js closes every menu on `window.blur`. The item click then
// lands on nothing and the menu simply re-opens on the next attempt, exactly as
// a user would re-open it. That is pre-existing app behaviour, unrelated to the
// singleton rule under test — and re-opening Settings is idempotent *because*
// of that rule, so retrying cannot manufacture a pass: a build that duplicates
// the tab fails the snapshot on the first attempt and on every later one.
const openSettingsFromMenu = (window, expected) =>
  expect(async () => {
    await window.locator('#menu-button').click();
    await expect(window.locator('#settings-btn')).toBeVisible({ timeout: 2_000 });
    await window.locator('#settings-btn').click({ timeout: 2_000 });
    await expect(window.locator('#menu-backdrop')).toBeHidden({ timeout: 2_000 });
    expect(await tabSnapshot(window)).toEqual(expected);
  }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] });

// The `location.hash` of the Settings guest — the page's own source of truth
// for which section is shown (`resolveSection`/`showSection` in settings.html).
const settingsHash = (window) =>
  window.evaluate(async () => {
    const webview = [...document.querySelectorAll('webview')].find((candidate) => {
      try {
        return /settings\.html/.test(candidate.getURL() || '');
      } catch {
        return false;
      }
    });
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    try {
      return await webview.executeJavaScript('location.hash');
    } catch {
      return null;
    }
  });

// #325: every `freedom://` internal page is a singleton tab. The regression
// this covers was in the *chrome* paths — the hamburger menu's Settings item
// and an address-bar commit both went straight to `loadTarget`, which
// navigated whatever tab was in front, so a second open next to an existing
// Settings tab produced a duplicate rather than focusing it.
test('opening Settings from the hamburger menu and the address bar reuses one tab', async ({
  window,
}) => {
  const tabs = window.locator('[data-test="tab"]');
  const SETTINGS_TAB = { id: '1', title: 'Settings', active: true };
  const NEW_TAB = { id: '2', title: 'New Tab', active: false };

  // 1. From the empty New Tab the window starts on, Settings takes that tab
  //    over rather than leaving an unused NTP behind (Chrome's
  //    ShowSingletonTabOverwritingNTP).
  await openSettingsFromMenu(window, [SETTINGS_TAB]);

  // 2. Re-opening Settings from the Settings tab is a no-op, not a second tab.
  await openSettingsFromMenu(window, [SETTINGS_TAB]);

  // 3. From a *new* empty tab, the menu focuses the existing Settings tab —
  //    the duplicate in the bug report ("Settings", "Settings").
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs).toHaveCount(2);
  await expectActiveTab(window, 2);
  await openSettingsFromMenu(window, [SETTINGS_TAB, NEW_TAB]);

  // 4. Typing the URL in the second tab's address bar does the same.
  await window.locator('[data-test="tab"][data-tab-id="2"]').click();
  await expectActiveTab(window, 2);
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings');
  await input.press('Enter');
  await expect
    .poll(() => tabSnapshot(window), {
      message: 'Waiting for the address-bar commit to focus the existing Settings tab',
      timeout: 15_000,
    })
    .toEqual([SETTINGS_TAB, NEW_TAB]);

  // 5. A sub-path deep link reuses that same tab and routes it to the section.
  await window.locator('[data-test="tab"][data-tab-id="2"]').click();
  await expectActiveTab(window, 2);
  await input.click();
  await input.fill('freedom://settings/shortcuts');
  await input.press('Enter');
  await expect
    .poll(() => tabSnapshot(window), {
      message: 'Waiting for the deep link to focus the existing Settings tab',
      timeout: 15_000,
    })
    .toEqual([SETTINGS_TAB, NEW_TAB]);
  await expect
    .poll(() => settingsHash(window), {
      message: 'Waiting for the reused Settings tab to route to the Shortcuts section',
      timeout: 15_000,
    })
    .toBe('#shortcuts');
});

// #325, the other half of the Chrome model: with no Settings tab to focus and
// a *non-empty* tab in front, Settings opens in a new tab instead of
// navigating the page the user is reading out from under them.
test('opening Settings from a page with content opens a new tab', async ({ window, harness }) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>Page A</title><p>a</p>',
  });
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');
  await expect
    .poll(async () => (await tabTitles(window)).map((tab) => tab.title), {
      message: 'Waiting for Page A to load',
      timeout: 15_000,
    })
    .toEqual(['Page A']);

  await openSettingsFromMenu(window, [
    { id: '1', title: 'Page A', active: false },
    { id: '2', title: 'Settings', active: true },
  ]);
});

// #303: a `freedom://` internal page is a singleton tab, but the singleton
// rule must not outrank the disposition. Ctrl+click on a freedom:// link had
// the tab-reuse branch run before `background` was consulted, so it switched
// the user onto Settings — the exact "stay on this page" behaviour the
// modifier asks for.
test('ctrl+click on a freedom:// link opens the internal page in the background', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(PAGE_A, {
    body:
      '<!doctype html><title>Page A</title><style>body{margin:0;padding:40px}' +
      'a{display:inline-block;padding:20px;font-size:24px}</style>' +
      '<a id="settings" href="freedom://settings">settings</a>',
  });
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  const point = await pointInGuest(window, '#settings');
  await wakeGuest(window);
  await ctrlClick(window, point);

  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  // Still on Page A: the Settings tab was opened behind it, hidden.
  await expectActiveTab(window, 1);
  expect(
    await window.evaluate(() => document.querySelectorAll('webview:not(.hidden)').length)
  ).toBe(1);
  // The background tab really is Settings (a tab that never navigated would
  // pass every assertion above).
  await expect
    .poll(async () => (await tabTitles(window)).map((tab) => tab.title), {
      message: 'Waiting for the background Settings tab to load',
      timeout: 15_000,
    })
    .toEqual(['Page A', 'Settings']);

  // A second Ctrl+click reuses the singleton tab rather than opening a
  // duplicate — and still leaves the user on Page A.
  await ctrlClick(window, point);
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await expectActiveTab(window, 1);
});

// #303: Chrome resolves the modifier before the `target` attribute — a
// Ctrl+click never re-navigates the window a name already points at. When that
// window is the tab the user is reading, reuse navigated the page out from
// under them, the opposite of what the modifier asks for.
//
// Driven over `ipfs://`, not `bzz://`, on purpose: only `ipfs:`/`ipns:`/`web3:`
// hrefs (and everything on a `web3:` page) are intercepted by
// webview-preload's own disposition heuristic, which forwards the `target`
// attribute in every disposition. A `bzz://` link goes out through Chromium's
// `setWindowOpenHandler` instead, and Chromium has already dropped the frame
// name by then — so a bzz fixture would pass with or without this fix.
test('ctrl+click on a named-target link opens a new tab instead of reusing the named one', async ({
  window,
  harness,
}) => {
  const IPFS_A = `ipfs://bafybeib${'a'.repeat(51)}/`;
  const IPFS_B = `ipfs://bafybeib${'b'.repeat(51)}/`;
  const IPFS_C = `ipfs://bafybeib${'c'.repeat(51)}/`;
  // Page B lives in the tab named "foo" and links to Page C with the same
  // target — the self-targeting case from the audit.
  await harness.setContentFixture(IPFS_A, {
    body:
      '<!doctype html><title>Page A</title><style>body{margin:0;padding:40px}' +
      'a{display:inline-block;padding:20px;font-size:24px}</style>' +
      `<a id="lnk" target="foo" href="${IPFS_B}">b</a>`,
  });
  await harness.setContentFixture(IPFS_B, {
    body:
      '<!doctype html><title>Page B</title><style>body{margin:0;padding:40px}' +
      'a{display:inline-block;padding:20px;font-size:24px}</style>' +
      `<a id="lnk" target="foo" href="${IPFS_C}">c</a>`,
  });
  await harness.setContentFixture(IPFS_C, {
    body: '<!doctype html><title>Page C</title><h1>C</h1>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(IPFS_A);
  await input.press('Enter');

  // Plain click: Page B opens in a new foreground tab, which takes the name.
  const linkInA = await pointInGuest(window, '#lnk');
  await wakeGuest(window);
  await window.mouse.click(linkInA.x, linkInA.y);
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await expectActiveTab(window, 2);
  await expect
    .poll(async () => (await tabTitles(window)).map((tab) => tab.title), {
      message: 'Waiting for the named tab to load Page B',
      timeout: 15_000,
    })
    .toEqual(['Page A', 'Page B']);

  // Ctrl+click the target="foo" link *inside* that tab: a third tab opens in
  // the background and Page B stays where it is.
  const linkInB = await pointInGuest(window, '#lnk');
  await wakeGuest(window);
  await ctrlClick(window, linkInB);
  await expect(window.locator('[data-test="tab"]')).toHaveCount(3);
  await expectActiveTab(window, 2);
  await expect
    .poll(async () => (await tabTitles(window)).map((tab) => tab.title), {
      message: 'Waiting for the background tab to load Page C',
      timeout: 15_000,
    })
    .toEqual(['Page A', 'Page B', 'Page C']);
});

// #303: Ctrl+Shift+click promotes the same link to a FOREGROUND tab.
test('ctrl+shift+click opens a foreground tab', async ({ window, harness }) => {
  const point = await openLinkPage(window, harness);

  await window.keyboard.down('Control');
  await window.keyboard.down('Shift');
  await window.mouse.click(point.x, point.y);
  await window.keyboard.up('Shift');
  await window.keyboard.up('Control');

  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await expectActiveTab(window, 2);
});

// #303: Shift+click opens a new *window*, not a tab in this one.
test('shift+click opens a new window', async ({ window, electronApp, harness }) => {
  const point = await openLinkPage(window, harness);
  const before = await chromeWindowCount(electronApp);

  await window.keyboard.down('Shift');
  await window.mouse.click(point.x, point.y);
  await window.keyboard.up('Shift');

  await expect
    .poll(() => chromeWindowCount(electronApp), {
      message: 'Waiting for the shift+click window',
      timeout: 15_000,
    })
    .toBe(before + 1);
  // …and no extra tab in the window the link was clicked in.
  await expect(window.locator('[data-test="tab"]')).toHaveCount(1);
});

// #311: past the tabs' minimum width the strip scrolls instead of clipping,
// and the active tab is always scrolled into view. Before the fix a 20th tab
// in a 1200px window sat past the container's right edge, invisible and
// unclickable, with no scroll or overflow affordance at all.
test('the tab strip scrolls instead of clipping, keeping the active tab visible', async ({
  window,
  electronApp,
}) => {
  const newTabBtn = window.locator('[data-test="new-tab-btn"]');
  for (let i = 0; i < 19; i += 1) {
    await newTabBtn.click();
  }
  await expect(window.locator('[data-test="tab"]')).toHaveCount(20);

  const measure = () =>
    window.evaluate(() => {
      const container = document.querySelector('.tabs-container');
      const rect = container.getBoundingClientRect();
      const active = document.querySelector('[data-test="tab"].active');
      const activeRect = active.getBoundingClientRect();
      return {
        scrollable: container.scrollWidth - container.clientWidth > 1,
        overflowX: getComputedStyle(container).overflowX,
        activeVisible: activeRect.left >= rect.left - 1 && activeRect.right <= rect.right + 1,
        activeTabId: active.dataset.tabId,
        hasEdgeFade:
          container.classList.contains('overflow-start') ||
          container.classList.contains('overflow-end'),
      };
    });

  const overflowing = await measure();
  expect(overflowing.overflowX).toBe('auto');
  expect(overflowing.scrollable).toBe(true);
  // The most recently opened tab is the active one and it is on screen.
  expect(overflowing.activeTabId).toBe('20');
  expect(overflowing.activeVisible).toBe(true);
  // An edge fade marks the direction the hidden tabs are in.
  expect(overflowing.hasEdgeFade).toBe(true);

  // Switching to a tab scrolled off the other end brings it into view too —
  // this is the case that used to leave you on a tab you could not see.
  await window.evaluate(() => {
    document.querySelector('.tabs-container').scrollLeft = 0;
  });
  await clickMenuItem(electronApp, 'next-tab');
  await expectActiveTab(window, 1);
  const wrapped = await measure();
  expect(wrapped.activeTabId).toBe('1');
  expect(wrapped.activeVisible).toBe(true);
});

// #315: the tab context menu was dismissed by a mouse tab switch (the strip
// click reaches the document listener) but not by a keyboard one, leaving
// Close Tab / Close Others / Close to the Right / Pin / Mute live against a
// tab the user was no longer on.
test('the tab context menu closes on a keyboard tab switch and on a tab close', async ({
  window,
  electronApp,
}) => {
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();

  const menu = window.locator('#tab-context-menu');
  const openMenuOnFirstTab = async () => {
    await window.locator('[data-test="tab"][data-tab-id="1"]').click({ button: 'right' });
    await expect(menu).toBeVisible();
  };

  await openMenuOnFirstTab();
  await clickMenuItem(electronApp, 'next-tab');
  await expectActiveTab(window, 2);
  await expect(menu).toBeHidden();
  // Both tabs are still there: the switch dismissed the menu rather than
  // leaving Close Tab / Close Others live against the tab just left.
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);

  // A tab closing invalidates the menu's anchor and its target as well —
  // here the menu is raised on tab 1 while tab 2 is the one being closed.
  await openMenuOnFirstTab();
  await clickMenuItem(electronApp, 'close-tab');
  await expect(window.locator('[data-test="tab"]')).toHaveCount(1);
  await expect(menu).toBeHidden();
});

// #308: a context menu describes one document. Raise a link menu on page A,
// let page A navigate itself to page B, and the menu used to still be up over
// B — with Open Link in New Tab / Copy Link Address still bound to A's link.
test('the page context menu closes when the page navigates under it', async ({
  window,
  harness,
}) => {
  const PAGE_C = `bzz://${'c'.repeat(64)}/`;

  await harness.setContentFixture(PAGE_A, {
    body:
      '<!doctype html><title>Page A</title><style>body{margin:0;padding:40px}' +
      'a{display:inline-block;padding:20px;font-size:24px}</style>' +
      `<a id="lnk" href="${PAGE_C}">link to C</a>`,
  });
  await harness.setContentFixture(PAGE_B, {
    body: '<!doctype html><title>Page B</title><h1>Page B - no links here</h1>',
  });
  await harness.setContentFixture(PAGE_C, {
    body: '<!doctype html><title>Page C</title><h1>Page C</h1>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  let point;
  await expect
    .poll(
      async () => {
        point = await window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            const box = await wv.executeJavaScript(
              "(() => { const a = document.getElementById('lnk'); if (!a) return null;" +
                'const r = a.getBoundingClientRect();' +
                'return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()'
            );
            if (!box) return null;
            const rect = wv.getBoundingClientRect();
            return { x: rect.x + box.x, y: rect.y + box.y };
          } catch {
            return null;
          }
        });
        return !!point;
      },
      { message: 'Waiting for the link fixture to render', timeout: 15_000 }
    )
    .toBe(true);

  // Right-click page A's link.
  await wakeGuest(window);
  await window.mouse.click(point.x, point.y, { button: 'right' });
  const menu = window.locator('#page-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-group="link"]')).toHaveClass(/visible/);

  // Page A navigates itself out from under the open menu — the client-side
  // redirect from the bug report, driven deterministically rather than on a
  // timer so the right-click above can't race it.
  await window.evaluate(
    (url) =>
      document
        .querySelector('webview:not(.hidden)')
        .executeJavaScript(`location.href = ${JSON.stringify(url)}`),
    PAGE_B
  );
  await expect
    .poll(
      () => window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || ''),
      { message: 'Waiting for the navigation to commit', timeout: 15_000 }
    )
    .toContain('bbbb');

  // The menu is gone, so nothing of page A's is left to click...
  await expect(menu).toBeHidden();
  await expect(window.locator('#menu-backdrop')).toBeHidden();
  // ...and no tab was opened for page A's link.
  await expect(window.locator('[data-test="tab"]')).toHaveCount(1);
});

// #308: the same rule for a tab switch — the menu belongs to the document it
// was raised on, not to whichever tab is in front.
test('the page context menu closes on a tab switch', async ({ window, harness, electronApp }) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>Page A</title><p>page a</p>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  // A second tab to switch to, opened before the menu goes up: while the menu
  // is open `#menu-backdrop` covers the window, so any *mouse* path would
  // dismiss it through the click-away listener and prove nothing.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expectActiveTab(window, 1);

  await wakeGuest(window);
  const spot = await window.evaluate(() => {
    const rect = document.querySelector('webview:not(.hidden)').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await window.mouse.click(spot.x, spot.y, { button: 'right' });
  const menu = window.locator('#page-context-menu');
  await expect(menu).toBeVisible();

  // Keyboard switch (Ctrl+Tab), driven through the application menu item the
  // accelerator maps to — see `clickMenuItem`.
  await clickMenuItem(electronApp, 'next-tab');
  await expectActiveTab(window, 2);

  await expect(menu).toBeHidden();
  await expect(window.locator('#menu-backdrop')).toBeHidden();
});
