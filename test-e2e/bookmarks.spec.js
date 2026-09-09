// Bookmarks bar — add via the IPC the address-bar star uses, and assert
// the bar reflects the new entry. Removal goes through the same IPC.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

// Force the bookmarks bar to be visible on every page. Without this the
// bar is only shown on the home page, which complicates assertions when
// the active tab navigates away.
test.use({ seedSettings: { showBookmarkBar: true } });

test('adding a bookmark via IPC shows it in the bookmarks bar', async ({ window }) => {
  const items = window.locator('[data-test="bookmarks-bar"] [data-test="bookmark-item"]');
  const initialCount = await items.count();

  await window.evaluate(() =>
    window.electronAPI.addBookmark({
      label: 'Test Bookmark',
      target: 'https://example.com/freedom-e2e',
    })
  );

  // The bookmarks bar reads from the IPC at init and after explicit
  // user actions; there's no "bookmarks changed" broadcast for external
  // mutations. Reloading the renderer forces a fresh load.
  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');

  await expect(items).toHaveCount(initialCount + 1);
  await expect(
    window.locator(
      '[data-test="bookmarks-bar"] [data-test="bookmark-item"][data-hash="https://example.com/freedom-e2e"]'
    )
  ).toBeVisible();

  // Cleanup also goes through the IPC contract.
  await window.evaluate(() =>
    window.electronAPI.removeBookmark('https://example.com/freedom-e2e')
  );

  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');
  await expect(
    window.locator(
      '[data-test="bookmarks-bar"] [data-test="bookmark-item"][data-hash="https://example.com/freedom-e2e"]'
    )
  ).toHaveCount(0);
});

// #307: the bar handled a plain left click and nothing else — Ctrl/Cmd+click
// navigated the page you were reading away, middle-click did nothing at all,
// and the entries could not be dragged into a new order.
const BOOKMARK_ONE = 'https://one.example/freedom-e2e';
const BOOKMARK_TWO = 'https://two.example/freedom-e2e';

// Replace the bar's contents with a known pair, in a known order.
async function seedBookmarks(window) {
  await window.evaluate(
    async ({ one, two }) => {
      for (const existing of await window.electronAPI.getBookmarks()) {
        await window.electronAPI.removeBookmark(existing.target);
      }
      await window.electronAPI.addBookmark({ label: 'One', target: one });
      await window.electronAPI.addBookmark({ label: 'Two', target: two });
    },
    { one: BOOKMARK_ONE, two: BOOKMARK_TWO }
  );
  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');
  await expect(window.locator('[data-test="bookmark-item"]')).toHaveCount(2);
}

const barOrder = (window) =>
  window.evaluate(() =>
    [...document.querySelectorAll('[data-test="bookmark-item"]')].map((el) => el.dataset.hash)
  );

test('Ctrl+click and middle-click on a bookmark open a background tab', async ({ window }) => {
  await seedBookmarks(window);

  const tabs = window.locator('[data-test="tab"]');
  await expect(tabs).toHaveCount(1);
  const addressBefore = await window.locator('[data-test="address-input"]').inputValue();
  const first = window.locator('[data-test="bookmark-item"]').first();
  const box = await first.boundingBox();

  await window.keyboard.down('Control');
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await window.keyboard.up('Control');

  await expect(tabs).toHaveCount(2);
  // The tab that was in front still is, and the address bar still describes it.
  await expect(window.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', '1');
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(addressBefore);

  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down({ button: 'middle' });
  await window.mouse.up({ button: 'middle' });

  await expect(tabs).toHaveCount(3);
  await expect(window.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', '1');
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(addressBefore);
});

test('a plain click still opens the bookmark in the current tab', async ({ window }) => {
  await seedBookmarks(window);

  const tabs = window.locator('[data-test="tab"]');
  await window.locator('[data-test="bookmark-item"]').first().click();

  await expect(tabs).toHaveCount(1);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(BOOKMARK_ONE);
});

test('bookmarks can be dragged into a new order, and the order survives a restart', async ({
  window,
}) => {
  await seedBookmarks(window);
  expect(await barOrder(window)).toEqual([BOOKMARK_ONE, BOOKMARK_TWO]);

  const items = window.locator('[data-test="bookmark-item"]');
  await expect(items.first()).toHaveJSProperty('draggable', true);

  // Drag the first entry onto the right half of the second one.
  const source = await items.first().boundingBox();
  const target = await items.nth(1).boundingBox();
  await window.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await window.mouse.down();
  await window.mouse.move(target.x + target.width * 0.9, target.y + target.height / 2, {
    steps: 12,
  });
  await window.mouse.up();

  await expect.poll(() => barOrder(window)).toEqual([BOOKMARK_TWO, BOOKMARK_ONE]);

  // The new order is the stored order, not just a repaint: the reload re-reads
  // it from the bookmark store through the same IPC the bar loads with.
  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');
  await expect.poll(() => barOrder(window)).toEqual([BOOKMARK_TWO, BOOKMARK_ONE]);
});

// #306, dialog sibling: the bookmark add/edit editor is a modal <dialog>, and
// a modal dialog is an innermost surface exactly like the menus — one Escape
// closes it and nothing else. It cannot mark the press with
// `preventDefault()` the way a menu handler does (its Escape is the
// platform's own close request, dispatched after every keydown listener), so
// navigation.js's window-level Escape has to stand down while one is open.
// Before that guard the first Escape over an in-flight load stopped the load,
// repainted the address bar, blurred the focused field *and* — because it
// cancelled the press — left the dialog itself open, needing a second Escape.
const editorLoadState = (window) =>
  window.evaluate(() => ({
    dialogOpen: !!document.getElementById('add-bookmark-modal')?.open,
    reload: document.getElementById('reload-btn')?.dataset?.state || '',
    address: document.getElementById('address-input')?.value || '',
    focused: document.activeElement?.id || '',
  }));

test('Escape in the bookmark editor closes only the editor, not the load behind it', async ({
  window,
  harness,
}) => {
  await seedBookmarks(window);

  // A fixture that holds its response open, so the tab is genuinely still
  // loading while the editor is up (dweb pages routinely take seconds).
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: '<!doctype html><title>slow</title><h1>slow</h1>',
    delayMs: 30000,
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(SAMPLE_BZZ_HASH);
  await input.press('Enter');

  // The stop/reload button in its `stop` state is the app's own signal that a
  // load is in flight.
  await expect.poll(() => editorLoadState(window)).toMatchObject({ reload: 'stop' });
  const loading = await editorLoadState(window);

  // Right-click a bookmark → Edit… is the editor's reachable entry point over a
  // loading page (the address-bar star hides itself while the tab loads).
  await window.locator('[data-test="bookmark-item"]').first().click({ button: 'right' });
  await window.locator('.context-menu-item[data-action="edit"]').click();
  await expect
    .poll(() => editorLoadState(window))
    .toMatchObject({ dialogOpen: true, focused: 'bookmark-label' });

  await window.keyboard.press('Escape');

  // One press: the editor is gone, and the load behind it is untouched — still
  // in flight, with the address bar not repainted from the page snapshot.
  await expect.poll(() => editorLoadState(window)).toMatchObject({ dialogOpen: false });
  expect(await editorLoadState(window)).toMatchObject({
    reload: 'stop',
    address: loading.address,
  });

  // With nothing open, the very next Escape reaches the stop-loading handler —
  // the behaviour the guard must not have removed.
  await window.keyboard.press('Escape');
  await expect.poll(() => editorLoadState(window)).toMatchObject({ reload: 'reload' });
});
