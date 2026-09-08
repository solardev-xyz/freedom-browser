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
  return point;
}

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
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);

  // Switch back to the first tab.
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);
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

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_A);
  await input.press('Enter');

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);

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
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);
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
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).not.toHaveClass(/active/);
  // The background tab's webview must be hidden — it is created after the
  // switch that would otherwise have hidden it.
  expect(
    await window.evaluate(() => document.querySelectorAll('webview:not(.hidden)').length)
  ).toBe(1);

  // Middle-click behaves the same way.
  await window.mouse.click(point.x, point.y, { button: 'middle' });
  await expect(tabs).toHaveCount(3);
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);

  // The background tabs really did load Page B (a background tab that never
  // navigates would pass every assertion above).
  await expect
    .poll(async () => (await tabTitles(window)).map((tab) => tab.title), {
      message: 'Waiting for the background tabs to load Page B',
      timeout: 15_000,
    })
    .toEqual(['Page A', 'Page B', 'Page B']);
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
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);
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
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);
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
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);
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
