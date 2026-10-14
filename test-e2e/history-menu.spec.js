// The application menu's History menu (#584): Back/Forward, Recently Closed,
// Recently Visited and Show All History, read off — and clicked on — the
// *real* menu Electron built in the main process, not the template.
//
// All pages are the harness's https stub (no network); every stub page has
// the same <title>, so rows are told apart by what clicking them opens.

const { test, expect } = require('./fixtures');

const PAGE_A = 'https://history-menu-a.example';
const PAGE_B = 'https://history-menu-b.example';
const PAGE_C = 'https://history-menu-c.example';
const CLOSED_PAGE = 'https://history-menu-closed.example';
const PRIVATE_PAGE = 'https://history-menu-private.example';
const PRIVATE_CLOSED_PAGE = 'https://history-menu-private-closed.example';

// The History submenu as plain rows: { label, id, enabled, type }.
function readHistoryMenu(electronApp) {
  return electronApp.evaluate(({ Menu }) => {
    const history = Menu.getApplicationMenu()?.items.find((item) => item.label === 'History');
    if (!history?.submenu) return null;
    return history.submenu.items.map((item) => ({
      label: item.label,
      id: item.id || null,
      enabled: item.enabled,
      type: item.type,
    }));
  });
}

// Labels of one section's rows (after its header, up to the next separator).
function sectionLabels(rows, header) {
  const start = (rows || []).findIndex((row) => row.label === header);
  if (start === -1) return [];
  const out = [];
  for (const row of rows.slice(start + 1)) {
    if (row.type === 'separator') break;
    out.push(row.label);
  }
  return out;
}

// Click the `index`-th row of a section in the live menu.
function clickSectionRow(electronApp, header, index) {
  return electronApp.evaluate(
    ({ Menu }, [sectionHeader, rowIndex]) => {
      const history = Menu.getApplicationMenu().items.find((item) => item.label === 'History');
      const items = history.submenu.items;
      const start = items.findIndex((item) => item.label === sectionHeader);
      if (start === -1) throw new Error(`No ${sectionHeader} section`);
      items[start + 1 + rowIndex].click();
    },
    [header, index]
  );
}

function clickMenuItem(electronApp, id) {
  return electronApp.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId);
    if (!item) throw new Error(`No menu item ${itemId}`);
    item.click();
  }, id);
}

async function navigateTo(page, url) {
  const input = page.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
}

// URL the window's active webview is showing (the harness stub echoes it).
function activeStubUrl(page) {
  return page.evaluate(async () => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return null;
    try {
      return await wv.executeJavaScript(
        'document.querySelector(\'[data-test="harness-http-stub-url"]\')?.textContent || null'
      );
    } catch {
      return null;
    }
  });
}

async function visit(page, url) {
  await navigateTo(page, url);
  await expect.poll(() => activeStubUrl(page), { timeout: 10_000 }).toBe(`${url}/`);
}

function historyUrls(page) {
  return page.evaluate(async () => (await window.electronAPI.getHistory()).map((r) => r.url));
}

// Send a main→renderer menu channel to one chrome window, by its page URL.
function sendToWindow(electronApp, page, channel, ...args) {
  return electronApp.evaluate(
    ({ BrowserWindow }, [pageUrl, ch, rest]) => {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL() === pageUrl
      );
      if (!win) throw new Error(`No window at ${pageUrl}`);
      win.webContents.send(ch, ...rest);
    },
    [page.url(), channel, args]
  );
}

async function openPrivateWindow(electronApp) {
  const known = new Set(electronApp.windows().map((page) => page.url()));
  await clickMenuItem(electronApp, 'new-private-window');
  let page;
  await expect
    .poll(
      () => {
        page = electronApp
          .windows()
          .find(
            (candidate) =>
              candidate.url().includes('privatePartition=private-') && !known.has(candidate.url())
          );
        return !!page;
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return page;
}

test('History menu lists recent visits, reopens closed tabs, and follows history', async ({
  window,
  electronApp,
}) => {
  // Starts with nothing to list.
  await expect
    .poll(async () => sectionLabels(await readHistoryMenu(electronApp), 'Recently Visited'))
    .toEqual([]);

  await visit(window, PAGE_A);
  await visit(window, PAGE_B);
  await visit(window, PAGE_C);

  // Newest first: one row per visit, and the top row is C.
  await expect
    .poll(async () => sectionLabels(await readHistoryMenu(electronApp), 'Recently Visited'), {
      timeout: 10_000,
    })
    .toHaveLength(3);
  const recorded = await historyUrls(window);
  expect(recorded.slice(0, 3)).toEqual([`${PAGE_C}/`, `${PAGE_B}/`, `${PAGE_A}/`]);

  // Back/Forward follow the active tab: Back is on after three visits.
  await expect
    .poll(async () => {
      const rows = await readHistoryMenu(electronApp);
      return {
        back: rows.find((row) => row.id === 'history-back')?.enabled,
        forward: rows.find((row) => row.id === 'history-forward')?.enabled,
      };
    })
    .toEqual({ back: true, forward: false });
  await clickMenuItem(electronApp, 'history-back');
  await expect.poll(() => activeStubUrl(window), { timeout: 10_000 }).toBe(`${PAGE_B}/`);
  await expect
    .poll(
      async () =>
        (await readHistoryMenu(electronApp)).find((row) => row.id === 'history-forward')?.enabled
    )
    .toBe(true);
  await clickMenuItem(electronApp, 'history-forward');
  await expect.poll(() => activeStubUrl(window), { timeout: 10_000 }).toBe(`${PAGE_C}/`);

  // Clicking the bottom Recently Visited row (the oldest, A) loads it in the
  // active tab, through the address-bar path.
  await clickSectionRow(electronApp, 'Recently Visited', 2);
  await expect.poll(() => activeStubUrl(window), { timeout: 10_000 }).toBe(`${PAGE_A}/`);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(
    /history-menu-a\.example/
  );

  // Recently Closed: open a tab, close it, and it is listed; its row reopens it.
  await sendToWindow(electronApp, window, 'tab:new-with-url', CLOSED_PAGE);
  await expect.poll(() => activeStubUrl(window), { timeout: 10_000 }).toBe(`${CLOSED_PAGE}/`);
  const tabsBefore = await window.locator('.tab').count();
  await sendToWindow(electronApp, window, 'tab:close');
  await expect(window.locator('.tab')).toHaveCount(tabsBefore - 1);
  await expect
    .poll(async () => sectionLabels(await readHistoryMenu(electronApp), 'Recently Closed'), {
      timeout: 10_000,
    })
    .toHaveLength(1);
  await clickSectionRow(electronApp, 'Recently Closed', 0);
  await expect(window.locator('.tab')).toHaveCount(tabsBefore);
  await expect.poll(() => activeStubUrl(window), { timeout: 10_000 }).toBe(`${CLOSED_PAGE}/`);
  await expect
    .poll(async () => sectionLabels(await readHistoryMenu(electronApp), 'Recently Closed'))
    .toEqual([]);

  // Clearing history empties Recently Visited at once.
  await window.evaluate(() => window.electronAPI.clearHistory());
  await expect
    .poll(async () => sectionLabels(await readHistoryMenu(electronApp), 'Recently Visited'), {
      timeout: 5_000,
    })
    .toEqual([]);

  // A private window contributes nothing: neither its visit nor its closed
  // tab, and not while it is the focused window either.
  const priv = await openPrivateWindow(electronApp);
  await visit(priv, PRIVATE_PAGE);
  await sendToWindow(electronApp, priv, 'tab:new-with-url', PRIVATE_CLOSED_PAGE);
  await expect.poll(() => activeStubUrl(priv), { timeout: 10_000 }).toBe(`${PRIVATE_CLOSED_PAGE}/`);
  await sendToWindow(electronApp, priv, 'tab:close');
  await expect.poll(() => activeStubUrl(priv), { timeout: 10_000 }).toBe(`${PRIVATE_PAGE}/`);
  // Well past the menu's refresh debounce.
  await priv.waitForTimeout(1500);
  const rows = await readHistoryMenu(electronApp);
  expect(sectionLabels(rows, 'Recently Visited')).toEqual([]);
  expect(sectionLabels(rows, 'Recently Closed')).toEqual([]);
  expect(await historyUrls(window)).toEqual([]);
  // Back in the private window works off its own tab, all the same.
  expect(rows.find((row) => row.id === 'history-back')?.enabled).toBe(true);
});
