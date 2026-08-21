// Private windows — ephemeral browsing on a per-window non-persisted
// partition. These specs drive the real File-menu item and assert the
// promises the feature makes: distinct badged chrome, isolated partition,
// wallet providers unavailable, and no traces (history rows, downloads
// history, cookies) surviving the window.
//
// All content is served by the in-process test harness (http/https and
// bzz/ipfs/ipns are stubbed per session — including private sessions,
// which get the same stubs via the private-session configurator).

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const DATA_URI = 'data:application/octet-stream;base64,ZnJlZWRvbS1wcml2YXRlLWUyZQ==';

// Click the real File-menu item (id: new-private-window) and wait for the
// new chrome window to boot. Resolved by URL rather than via
// electronApp.waitForEvent('window'): webview guests surface as separate
// Playwright pages too, so the first 'window' event after the click can be
// the private start page's guest instead of the chrome window.
async function openPrivateWindow(electronApp) {
  const knownChrome = new Set(
    electronApp
      .windows()
      .filter((page) => page.url().includes('privatePartition=private-'))
      .map((page) => page.url())
  );
  await electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('new-private-window');
    if (!item) throw new Error('New Private Window menu item not found');
    item.click();
  });
  let page;
  await expect
    .poll(
      () => {
        page = electronApp
          .windows()
          .find(
            (candidate) =>
              candidate.url().includes('privatePartition=private-') &&
              !knownChrome.has(candidate.url())
          );
        return !!page;
      },
      { message: 'Waiting for the private chrome window', timeout: 15_000 }
    )
    .toBe(true);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return page;
}

// Navigate a chrome window's active tab through the address bar.
async function navigateTo(page, url) {
  const input = page.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
}

// Run a script inside the window's active webview (poll until the guest
// page is ready).
// The polled value is returned as-is rather than re-evaluated: callers pass
// side-effectful scripts (the open-link spec appends an anchor and dispatches
// a contextmenu event), and running the script a second time on success
// duplicated those effects.
async function evalInActiveWebview(page, script) {
  let lastValue;
  await expect
    .poll(
      async () => {
        lastValue = await page.evaluate(async (guestScript) => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return undefined;
          try {
            return await wv.executeJavaScript(guestScript);
          } catch {
            return undefined;
          }
        }, script);
        return lastValue;
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .not.toBe(undefined);
  return lastValue;
}

// Wait until the active webview is on the harness https stub for `url`.
async function waitForStubPage(page, url) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            return await wv.executeJavaScript(
              'document.querySelector(\'[data-test="harness-http-stub-url"]\')?.textContent || null'
            );
          } catch {
            return null;
          }
        }),
      { message: `Waiting for harness stub at ${url}`, timeout: 10_000 }
    )
    .toBe(url);
}

// Close every private window (identified by the privatePartition query
// parameter its chrome renderer was loaded with).
//
// close() is asynchronous, so getAllWindows() still lists windows that are
// mid-teardown; reading webContents on one of those throws "Object has been
// destroyed". Skip them — a window on its way out is not one we need to close.
async function closePrivateWindows(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      if (win.webContents.getURL().includes('privatePartition=private-')) {
        win.close();
      }
    }
  });
}

// Record every title the NEXT window created is asked to display.
//
// Sampling getTitle() after the window exists would be vacuous: the
// BrowserWindow constructor seeds the title with a literal 'Freedom', so a
// poll resolves long before ready-to-show applies the shared title. Wrapping
// setTitle samples at the inheritance moment itself.
//
// The listener is stashed in a named global so `stopRecordingWindowTitles`
// can remove it: an `app.once` that never fires (the test failing between
// installation and the click) would lie in wait and wrap whatever window a
// later evaluation creates, mutating state across test boundaries.
async function recordNextWindowTitles(electronApp) {
  await electronApp.evaluate(({ app }) => {
    globalThis.__freshWindowTitles = [];
    globalThis.__freshWindowRecorder = (_event, win) => {
      const setTitle = win.setTitle.bind(win);
      win.setTitle = (value) => {
        globalThis.__freshWindowTitles.push(value);
        return setTitle(value);
      };
    };
    app.once('browser-window-created', globalThis.__freshWindowRecorder);
  });
}

async function stopRecordingWindowTitles(electronApp) {
  await electronApp
    .evaluate(({ app }) => {
      if (globalThis.__freshWindowRecorder) {
        app.removeListener('browser-window-created', globalThis.__freshWindowRecorder);
        delete globalThis.__freshWindowRecorder;
      }
    })
    .catch(() => {});
}

async function recordedWindowTitles(electronApp) {
  await expect
    .poll(() => electronApp.evaluate(() => (globalThis.__freshWindowTitles || []).length), {
      message: 'Waiting for the new window to be titled',
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  return electronApp.evaluate(() => globalThis.__freshWindowTitles);
}

// Belt-and-braces: the tests that assert post-close behaviour still call
// closePrivateWindows() inline where the close is part of the assertion, but
// a test that fails BEFORE its inline call would otherwise leak a live
// private window into the next test. The `electronApp` fixture is currently
// test-scoped (fresh app per test), so this only matters if it ever becomes
// worker-scoped — which is exactly when the leak would be invisible and
// confusing. The sweep is idempotent.
test.afterEach(async ({ electronApp }) => {
  await closePrivateWindows(electronApp).catch(() => {});
});

test('private window: badge, isolated partition, private start page, no wallet providers', async ({
  window,
  electronApp,
}) => {
  // Normal window: no badge, webviews carry no partition.
  await expect(window.locator('[data-test="private-badge"]')).toBeHidden();
  const normalPartition = await window.evaluate(() =>
    document.querySelector('webview')?.getAttribute('partition')
  );
  expect(normalPartition).toBeFalsy();

  const priv = await openPrivateWindow(electronApp);

  // Distinct chrome: badge + body class.
  await expect(priv.locator('[data-test="private-badge"]')).toBeVisible();
  expect(await priv.evaluate(() => document.body.classList.contains('private-window'))).toBe(true);

  // First tab is the private start page with the honest copy.
  const startPageBadge = await evalInActiveWebview(
    priv,
    'document.querySelector(\'[data-test="private-page-badge"]\')?.textContent || null'
  );
  expect(startPageBadge).toBe('Private window');
  const walletNote = await evalInActiveWebview(
    priv,
    'document.querySelector(\'[data-test="private-wallet-note"]\')?.textContent || null'
  );
  expect(walletNote).toContain('Wallet is disabled in private windows');

  // Every webview runs on the window's unique non-persisted partition.
  const partition = await priv.evaluate(() =>
    document.querySelector('webview')?.getAttribute('partition')
  );
  expect(partition).toMatch(/^private-[0-9a-f-]{36}$/);
  expect(partition.startsWith('persist:')).toBe(false);

  // Wallet providers are not injected in private windows…
  await navigateTo(priv, 'https://dapp.example');
  await waitForStubPage(priv, 'https://dapp.example/');
  expect(await evalInActiveWebview(priv, 'typeof window.ethereum')).toBe('undefined');
  expect(await evalInActiveWebview(priv, 'typeof window.swarm')).toBe('undefined');
  expect(await evalInActiveWebview(priv, 'typeof window.radicle')).toBe('undefined');

  // …but are injected on the same page in a normal window (sanity check
  // that the assertion above isn't vacuous).
  await navigateTo(window, 'https://dapp.example');
  await waitForStubPage(window, 'https://dapp.example/');
  expect(await evalInActiveWebview(window, 'typeof window.ethereum')).toBe('object');
  expect(await evalInActiveWebview(window, 'typeof window.swarm')).toBe('object');
  expect(await evalInActiveWebview(window, 'typeof window.radicle')).toBe('object');

  await closePrivateWindows(electronApp);
});

test('private browsing leaves no history, no downloads history, and no cookies behind', async ({
  window,
  electronApp,
}) => {
  const PRIVATE_URL = 'https://private-visit.example';
  const NORMAL_URL = 'https://normal-visit.example';

  // Sanity: prove the history pipeline works at all via a normal-window
  // navigation, so the "no private rows" assertions below can't pass
  // vacuously.
  await navigateTo(window, NORMAL_URL);
  await waitForStubPage(window, `${NORMAL_URL}/`);
  // The recorded display URL carries the canonical trailing slash.
  await expect
    .poll(
      () =>
        window.evaluate(async (prefix) => {
          const rows = await window.electronAPI.getHistory();
          return rows.filter((r) => r.url.startsWith(prefix)).length;
        }, NORMAL_URL),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);

  const priv = await openPrivateWindow(electronApp);

  // Browse in the private window and set a cookie on the stub origin.
  await navigateTo(priv, PRIVATE_URL);
  await waitForStubPage(priv, `${PRIVATE_URL}/`);
  await evalInActiveWebview(
    priv,
    "document.cookie = 'freedomtest=secret; path=/'; localStorage.setItem('freedomtest', 'secret'); document.cookie"
  );

  // Trigger a download from the private webview's (private) session.
  await priv.evaluate((dataUri) => {
    const wv = document.querySelector('webview:not(.hidden)');
    wv.downloadURL(dataUri);
  }, DATA_URI);

  // The download lands in the manager, flagged private — visible in the
  // private window's own (merged, in-memory) view…
  await expect
    .poll(
      () =>
        priv.evaluate(async () => {
          const rows = await window.electronAPI.getDownloads({});
          return rows.filter((r) => r.is_private === 1).length;
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);

  // …but NEVER in a normal window's view, even while the private window is
  // still open: private rows exist only in the in-memory partition store,
  // are never written to the profile database, and are never served to
  // normal-window queries.
  const normalViewPrivateRows = await window.evaluate(async () => {
    const rows = await window.electronAPI.getDownloads({});
    return rows.filter((r) => r.is_private === 1).length;
  });
  expect(normalViewPrivateRows).toBe(0);

  // Close the private window → its traces must evaporate.
  await closePrivateWindows(electronApp);

  // No history rows for the private navigation (the normal row stays).
  const historyUrls = await window.evaluate(async () => {
    const rows = await window.electronAPI.getHistory();
    return rows.map((r) => r.url);
  });
  expect(historyUrls.some((url) => url.startsWith(PRIVATE_URL))).toBe(false);
  expect(historyUrls.some((url) => url.startsWith(NORMAL_URL))).toBe(true);

  // No downloads-history rows survive the window (files stay on disk).
  // The in-memory partition store is dropped with the window; the profile
  // database never held the rows in the first place.
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const rows = await window.electronAPI.getDownloads({});
          return rows.filter((r) => r.is_private === 1).length;
        }),
      { timeout: 10_000 }
    )
    .toBe(0);

  // Cmd/Ctrl+Shift+T in the normal window must not resurrect private tabs.
  const tabCountBefore = await window.locator('[data-test="tab"]').count();
  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+T' : 'Control+Shift+T');
  await window.waitForTimeout(500);
  expect(await window.locator('[data-test="tab"]').count()).toBe(tabCountBefore);

  // A fresh private window gets a fresh partition: the cookie and
  // localStorage from the previous private session are gone.
  const priv2 = await openPrivateWindow(electronApp);
  await navigateTo(priv2, PRIVATE_URL);
  await waitForStubPage(priv2, `${PRIVATE_URL}/`);
  expect(await evalInActiveWebview(priv2, 'document.cookie')).toBe('');
  expect(await evalInActiveWebview(priv2, "localStorage.getItem('freedomtest')")).toBe(null);

  // And the default (normal-window) session never saw the cookie at all.
  const defaultSessionCookies = await electronApp.evaluate(async ({ session }) => {
    const cookies = await session.defaultSession.cookies.get({ name: 'freedomtest' });
    return cookies.length;
  });
  expect(defaultSessionCookies).toBe(0);

  await closePrivateWindows(electronApp);
});

// PRIVATE MODE GUARD (windows): the link-context-menu's "Open Link in New
// Window" carries a URL out of the window that asked for it. From a private
// window it must land in another PRIVATE window — a normal window would run
// it on the persistent default session (history row, cookies, providers).
test('Open Link in New Window from a private window opens another private window', async ({
  window,
  electronApp,
}) => {
  const LEAK_URL = 'https://leak.example/secret';

  const priv = await openPrivateWindow(electronApp);
  await navigateTo(priv, 'https://private-link.example');
  await waitForStubPage(priv, 'https://private-link.example/');

  // Right-click a real link in the private page — the webview preload turns
  // this into the chrome's link context menu.
  await evalInActiveWebview(
    priv,
    `(() => {
      const a = document.createElement('a');
      a.href = ${JSON.stringify(LEAK_URL)};
      a.textContent = 'leak';
      a.style.cssText = 'position:fixed;top:40px;left:40px;font-size:20px';
      document.body.appendChild(a);
      const rect = a.getBoundingClientRect();
      a.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(rect.left + 4),
          clientY: Math.round(rect.top + 4),
        })
      );
      return true;
    })()`
  );

  const menuItem = priv.locator('#page-context-menu [data-action="open-link-new-window"]');
  await expect(menuItem).toBeVisible();
  await priv.screenshot({ path: '/tmp/private-open-link-new-window-menu.png' });

  const knownPrivateUrls = new Set(
    electronApp
      .windows()
      .filter((page) => page.url().includes('privatePartition=private-'))
      .map((page) => page.url())
  );
  const normalWindowsBefore = electronApp
    .windows()
    .filter(
      (page) =>
        page.url().includes('/renderer/index.html') &&
        !page.url().includes('privatePartition=private-')
    ).length;

  await menuItem.click();

  // The new window is private: its chrome renderer carries a private
  // partition, and it is NOT the private window we came from.
  let opened;
  await expect
    .poll(
      () => {
        opened = electronApp
          .windows()
          .find(
            (page) =>
              page.url().includes('privatePartition=private-') && !knownPrivateUrls.has(page.url())
          );
        return !!opened;
      },
      { message: 'Waiting for a second private window', timeout: 15_000 }
    )
    .toBe(true);
  await opened.waitForLoadState('domcontentloaded');
  await expect(opened.locator('[data-test="private-badge"]')).toBeVisible();
  await waitForStubPage(opened, `${LEAK_URL}`);
  await opened.screenshot({ path: '/tmp/private-open-link-new-window-result.png' });

  // No extra normal window was spawned…
  const normalWindowsAfter = electronApp
    .windows()
    .filter(
      (page) =>
        page.url().includes('/renderer/index.html') &&
        !page.url().includes('privatePartition=private-')
    ).length;
  expect(normalWindowsAfter).toBe(normalWindowsBefore);

  // …the link ran on a non-persisted partition…
  const openedPartition = await opened.evaluate(() =>
    document.querySelector('webview')?.getAttribute('partition')
  );
  expect(openedPartition).toMatch(/^private-[0-9a-f-]{36}$/);

  // …and wallet providers stay out of it.
  expect(await evalInActiveWebview(opened, 'typeof window.ethereum')).toBe('undefined');

  await closePrivateWindows(electronApp);

  // Nothing about the link reached the profile's history.
  const historyUrls = await window.evaluate(async () => {
    const rows = await window.electronAPI.getHistory();
    return rows.map((r) => r.url);
  });
  expect(historyUrls.some((url) => url.startsWith('https://leak.example'))).toBe(false);
});

// PRIVATE MODE GUARD (window title): the renderer forwards the active tab's
// page title to the main process on every title update and tab switch. That
// title (for view-source tabs, a full URL) must not be appended to the
// persistent <userData>/logs/main.log, which outlives the window and the
// app, nor seed the process-wide title that every later NORMAL window
// inherits at ready-to-show.
test('a private page title reaches neither the persistent log nor a later normal window', async ({
  window,
  electronApp,
}) => {
  const SECRET = 'R3SECRETTITLEXYZZY';

  // Sanity: a normal-window title still reaches the log, so the "absent"
  // assertion below cannot pass vacuously.
  const NORMAL = 'R3NORMALTITLEPUBLIC';
  await navigateTo(window, 'https://normal-title.example');
  await waitForStubPage(window, 'https://normal-title.example/');
  await evalInActiveWebview(window, `document.title = '${NORMAL}'; document.title`);

  const priv = await openPrivateWindow(electronApp);
  await navigateTo(priv, 'https://private-title.example');
  await waitForStubPage(priv, 'https://private-title.example/');
  await evalInActiveWebview(priv, `document.title = '${SECRET}'; document.title`);

  // The private window's own native title still tracks the page (as Chrome
  // and Firefox do) — the guard is about shared and durable state.
  await expect
    .poll(
      () =>
        electronApp.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find(
            (w) =>
              !w.isDestroyed() &&
              !w.webContents.isDestroyed() &&
              w.webContents.getURL().includes('privatePartition=private-')
          );
          return win ? win.getTitle() : null;
        }),
      { message: 'Waiting for the private window title', timeout: 10_000 }
    )
    .toContain(SECRET);

  // A NORMAL window opened (via the real File menu) while the private one
  // is live must not inherit the private title through the shared
  // currentWindowTitle every window reads at ready-to-show.
  const knownIds = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.id)
  );
  await recordNextWindowTitles(electronApp);
  try {
    await electronApp.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((top) => top.submenu?.items || [])
        .find((entry) => entry.label === 'New Window');
      if (!item) throw new Error('New Window menu item not found');
      item.click();
    });
    await recordedWindowTitles(electronApp);
  } finally {
    await stopRecordingWindowTitles(electronApp);
  }
  const freshTitles = await electronApp.evaluate(({ BrowserWindow }, ids) => {
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && !ids.includes(w.id))
      .forEach((w) => w.close());
    return globalThis.__freshWindowTitles;
  }, knownIds);
  for (const title of freshTitles) {
    expect(title).not.toContain(SECRET);
  }
  // …and what it did inherit is the last NORMAL title: proof the ready-to-show
  // handler ran and really did copy the shared title over, so the assertion
  // above cannot pass vacuously.
  expect(freshTitles.some((title) => title.includes(NORMAL))).toBe(true);

  await closePrivateWindows(electronApp);

  // Nothing durable recorded the private title; the normal one is there.
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  const logText = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  expect(logText).toContain(NORMAL);
  expect(logText).not.toContain(SECRET);
});

// Reverse direction of the leak above: private windows must not CONSUME the
// shared currentWindowTitle either. A fresh private window that inherits it
// advertises whatever page the user last had focused in a NORMAL window —
// e.g. "mybank-statements.example - Freedom" — in its native title, i.e. the
// taskbar and window switcher, until its own renderer sends the first
// window:set-title. No private data escapes, but the wrong page is attributed
// to the private window in the most visible chrome there is.
test('a fresh private window does not inherit the last normal window title', async ({
  window,
  electronApp,
}) => {
  const NORMAL = 'R2NORMALTITLEPUBLIC';
  await navigateTo(window, 'https://normal-title.example');
  await waitForStubPage(window, 'https://normal-title.example/');
  await evalInActiveWebview(window, `document.title = '${NORMAL}'; document.title`);

  // Wait until the shared title really holds the normal page's title —
  // otherwise there would be nothing to leak and the assertion is vacuous.
  // Sampled from the native window title (the chrome renderer never touches
  // document.title; it forwards the active tab's title over window:set-title,
  // which is the same call that seeds the shared currentWindowTitle).
  await expect
    .poll(
      () =>
        electronApp.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find(
            (w) =>
              !w.isDestroyed() &&
              !w.webContents.isDestroyed() &&
              !w.webContents.getURL().includes('privatePartition=private-')
          );
          return win ? win.getTitle() : null;
        }),
      { message: 'Waiting for the shared window title', timeout: 10_000 }
    )
    .toContain(NORMAL);

  await recordNextWindowTitles(electronApp);
  let titles;
  try {
    await openPrivateWindow(electronApp);
    titles = await recordedWindowTitles(electronApp);
  } finally {
    await stopRecordingWindowTitles(electronApp);
  }

  // Nothing the fresh private window was asked to display carries the normal
  // page's title...
  for (const title of titles) {
    expect(title).not.toContain(NORMAL);
  }
  // ...and the ready-to-show handler demonstrably ran, applying the neutral
  // default instead — so the assertion above cannot pass vacuously.
  expect(titles).toContain('Freedom');
});

// PRIVATE MODE GUARD (dweb request + name logging): the bzz/ipfs/ipns/rad
// protocol handlers are registered on the private session too, and they log
// the request URL (and, underneath, the name they resolve) at info. That
// lands in the persistent <userData>/logs/main.log — the same history-grade
// trace the title/download/permission guards already close. Driven as a
// subresource fetch so the request reaches the private session's protocol
// handler directly, without the top-level navigation's probe.
test('a private dweb request writes no URL to the persistent log', async ({
  window,
  electronApp,
}) => {
  const SECRET_HASH = 'c0ffee'.padEnd(64, '1');
  const PUBLIC_HASH = 'decaf0'.padEnd(64, '2');

  // Sanity: a normal window's dweb request still lands in the log, so the
  // "absent" assertion below cannot pass vacuously.
  await navigateTo(window, 'https://normal-dweb.example');
  await waitForStubPage(window, 'https://normal-dweb.example/');
  await evalInActiveWebview(
    window,
    `fetch('bzz://${PUBLIC_HASH}/page.html').then(() => 'done', () => 'done')`
  );

  const priv = await openPrivateWindow(electronApp);
  await navigateTo(priv, 'https://private-dweb.example');
  await waitForStubPage(priv, 'https://private-dweb.example/');
  await evalInActiveWebview(
    priv,
    `fetch('bzz://${SECRET_HASH}/page.html').then(() => 'done', () => 'done')`
  );

  await closePrivateWindows(electronApp);

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  const logPath = path.join(userDataDir, 'logs', 'main.log');
  await expect
    .poll(() => fs.readFileSync(logPath, 'utf8'), {
      message: 'Waiting for the normal-window dweb request to reach the log',
      timeout: 10_000,
    })
    .toContain(PUBLIC_HASH);

  const logText = fs.readFileSync(logPath, 'utf8');
  // The private request is still visible as a request — just not as a place.
  expect(logText).toContain('bzz://<private>');
  expect(logText).not.toContain(SECRET_HASH);
});
