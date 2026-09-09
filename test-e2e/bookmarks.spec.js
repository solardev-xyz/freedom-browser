// Bookmarks bar — add via the IPC the address-bar star uses, and assert
// the bar reflects the new entry. Removal goes through the same IPC.

const { test, expect } = require('./fixtures');

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
