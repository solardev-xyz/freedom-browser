// Internal pages run with `script-src 'self'` — no inline script, no inline
// event handlers (#432). Dropping 'unsafe-inline' fails *silently*: a handler
// or inline block left behind just stops running, and Chromium only says so
// in the page's console. So every spec here records every console message
// from every webContents in the main process, drives an internal page's main
// interactions, and then asserts that no Content Security Policy violation
// was logged anywhere.
//
// It also plants site-controlled strings that are dangerous as HTML — a page
// title, a download filename — and checks History and Downloads show them as
// text rather than parsing them.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

// Dangerous in both text and attribute context. `data-xss` marks any element
// that got parsed out of it.
const HOSTILE = `"><img src=x data-xss="1" onerror="window.__xss=1">'<b>bold</b>`;

const navigate = async (window, url) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
};

// The page inside the active `<webview>`, surfaced by Playwright as its own
// page on the Electron app.
const pageFor = async (electronApp, file) => {
  let found;
  await expect
    .poll(
      () => {
        found = electronApp.windows().find((candidate) => candidate.url().includes(file));
        return Boolean(found);
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  await found.waitForLoadState('domcontentloaded');
  return found;
};

// Keystrokes go to whichever webContents has focus — after typing a URL in
// the address bar that is the chrome, not the guest page. Click the field
// first so the input lands in the page.
const fillIn = async (page, selector, value) => {
  await page.locator(selector).click();
  await page.locator(selector).fill(value);
};

// Record every console message from every webContents, present and future.
// Electron 44 hands `console-message` a single details object; older majors
// passed (event, level, message, line, sourceId) — accept both.
const installConsoleRecorder = (electronApp) =>
  electronApp.evaluate(({ app, webContents }) => {
    globalThis.__cspSpecConsole = [];
    const hook = (contents) => {
      if (contents.__cspSpecHooked) return;
      contents.__cspSpecHooked = true;
      contents.on('console-message', (details, legacyLevel, legacyMessage) => {
        const message = details?.message ?? legacyMessage ?? '';
        let url = '';
        try {
          url = contents.getURL();
        } catch {
          // Destroyed mid-message.
        }
        globalThis.__cspSpecConsole.push({ url, level: details?.level ?? legacyLevel, message });
      });
    };
    webContents.getAllWebContents().forEach(hook);
    app.on('web-contents-created', (_event, contents) => hook(contents));
  });

const cspViolations = (electronApp) =>
  electronApp.evaluate(() =>
    globalThis.__cspSpecConsole.filter(({ message }) =>
      /Content Security Policy|Refused to (execute|load|evaluate|apply)/i.test(message)
    )
  );

test.beforeEach(async ({ electronApp }) => {
  await installConsoleRecorder(electronApp);
});

test('the recorder sees a CSP violation on an internal page (positive control)', async ({
  window,
  electronApp,
}) => {
  await navigate(window, 'freedom://history');
  const page = await pageFor(electronApp, '/pages/history.html');
  // An inline <script> inserted into the page is exactly what the CSP must
  // refuse; if the recorder can't see this, "no violations" below means nothing.
  const ran = await page.evaluate(() => {
    window.__inlineRan = false;
    const script = document.createElement('script');
    script.textContent = 'window.__inlineRan = true;';
    document.body.append(script);
    return window.__inlineRan;
  });
  expect(ran).toBe(false);
  await expect
    .poll(async () => (await cspViolations(electronApp)).map((v) => v.message).join('\n'))
    .toMatch(/Content Security Policy/);
});

test('history: a hostile title renders as text; search and delete work', async ({
  window,
  electronApp,
  harness,
}) => {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: `<html><head><title>${HOSTILE}</title></head><body>hostile</body></html>`,
  });
  await navigate(window, `bzz://${SAMPLE_BZZ_HASH}`);
  await pageFor(electronApp, `bzz://${SAMPLE_BZZ_HASH}`);

  await navigate(window, 'freedom://history');
  const page = await pageFor(electronApp, '/pages/history.html');

  const hostileRow = page.locator('.history-item', {
    has: page.locator('.history-title', { hasText: 'data-xss' }),
  });
  // The title is recorded when the page reports it; re-run the page's own
  // loader (a global of its classic script) until it lands.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.loadHistory());
        return hostileRow.count();
      },
      { timeout: 15_000 }
    )
    .toBe(1);
  await expect(hostileRow.locator('.history-title')).toHaveText(HOSTILE);
  await expect(page.locator('[data-xss]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // Search filters by title, then clears back to the full list.
  const total = await page.locator('.history-item').count();
  await fillIn(page, '#search-input', 'no-such-entry-anywhere');
  await expect(page.locator('.history-item')).toHaveCount(0);
  await fillIn(page, '#search-input', 'data-xss');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await fillIn(page, '#search-input', '');
  await expect(page.locator('.history-item')).toHaveCount(total);

  // Sort switches between the grouped and the flat layout.
  await page.selectOption('#sort-select', 'title');
  await expect(page.locator('.date-group')).toHaveCount(0);
  await expect(page.locator('.history-item')).toHaveCount(total);
  await page.selectOption('#sort-select', 'recent');
  await expect(page.locator('.date-group').first()).toBeVisible();

  // Delete removes exactly that row.
  await hostileRow.hover();
  await hostileRow.locator('.delete-btn').click();
  await expect(hostileRow).toHaveCount(0);
  await expect(page.locator('.history-item')).toHaveCount(total - 1);

  await page.screenshot({ path: test.info().outputPath('history.png') });
  expect(await cspViolations(electronApp)).toEqual([]);
});

// #503: the page loads 200 rows at a time from main's history search worker
// instead of the whole table, and "Show more" appends the next page.
test('history: a long history loads a page at a time with Show more', async ({
  window,
  electronApp,
}) => {
  const historyModule = require.resolve('../src/main/history');
  await electronApp.evaluate((_electron, modulePath) => {
    // The same module instance (and database) the app registered its IPC on.
    const history = process.mainModule.require(modulePath);
    history.getDb().transaction(() => {
      for (let i = 0; i < 250; i++) {
        history.addHistoryEntry({
          url: `https://paged-${i}.example/`,
          title: `Paged entry ${i}`,
          protocol: 'https',
        });
      }
    })();
  }, historyModule);

  await navigate(window, 'freedom://history');
  const page = await pageFor(electronApp, '/pages/history.html');
  const rows = page.locator('.history-item');
  const showMore = page.locator('#show-more-btn');

  await expect(rows).toHaveCount(200);
  const total = Number((await page.locator('#stats').textContent()).match(/^(\d+) pages$/)[1]);
  expect(total).toBeGreaterThanOrEqual(250);
  await expect(showMore).toHaveText(`Show more (${total - 200} remaining)`);
  await page.screenshot({ path: test.info().outputPath('history-paged.png') });

  await showMore.click();
  await expect(rows).toHaveCount(total);
  await expect(showMore).toHaveCount(0);
  // Newest first, each row once.
  const urls = await rows.evaluateAll((items) => items.map((item) => item.dataset.url));
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls.indexOf('https://paged-249.example/')).toBeLessThan(
    urls.indexOf('https://paged-0.example/')
  );

  // Search is a query to main too; the counter says how many match.
  await fillIn(page, '#search-input', 'paged entry 24');
  await expect(rows).toHaveCount(11); // 24, 240-249
  await expect(page.locator('#stats')).toHaveText(`11 of ${total} pages`);
  await expect(showMore).toHaveCount(0);

  expect(await cspViolations(electronApp)).toEqual([]);
});

test('downloads: a hostile filename renders as text; remove works', async ({
  window,
  electronApp,
  harness,
}) => {
  const url = `bzz://${SAMPLE_BZZ_HASH}/file.bin`;
  await harness.setContentFixture(url, {
    contentType: 'application/octet-stream',
    headers: { 'Content-Disposition': `attachment; filename="${HOSTILE.replace(/"/g, "'")}.txt"` },
    body: 'freedom-downloads-csp',
  });
  await electronApp.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].webContents.downloadURL(target);
  }, url);

  await navigate(window, 'freedom://downloads');
  const page = await pageFor(electronApp, '/pages/downloads.html');
  const row = page.locator('.download-item.state-completed');
  await expect(row).toHaveCount(1, { timeout: 15_000 });

  // Chromium sanitises `<`, `>` and `/` out of the name it saves under, so
  // what reaches the page is whatever it recorded — which must show verbatim
  // as text, not as markup.
  const [recorded] = await page.evaluate(() => window.freedomAPI.getDownloads());
  expect(recorded.filename).toContain('data-xss');
  await expect(row.locator('.download-name')).toHaveText(recorded.filename);
  await expect(row.locator('.download-url')).toHaveText(url);
  await expect(page.locator('[data-xss]')).toHaveCount(0);
  await expect(row.locator('[data-action="open"]')).toBeVisible();
  await expect(row.locator('[data-action="show"]')).toBeVisible();

  await page.screenshot({ path: test.info().outputPath('downloads.png') });

  await fillIn(page, '#search-input', 'no-such-download');
  await expect(page.locator('.download-item')).toHaveCount(0);
  await fillIn(page, '#search-input', '');
  await expect(page.locator('.download-item')).toHaveCount(1);

  await row.locator('[data-action="remove"]').click();
  await expect(page.locator('.download-item')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toContainText('No downloads yet');

  expect(await cspViolations(electronApp)).toEqual([]);
});

test('payments, profiles, links and protocol-test run their scripts', async ({
  window,
  electronApp,
}) => {
  // Payments: the empty list renders, and the server-side filters re-query.
  await navigate(window, 'freedom://payments');
  const payments = await pageFor(electronApp, '/pages/payments.html');
  await expect(payments.locator('#stats')).toHaveText('0 payments');
  await expect(payments.locator('.empty-state')).toContainText('No payments yet');
  await payments.selectOption('#kind-select', 'x402');
  await expect(payments.locator('.empty-state')).toContainText('No payments yet');
  // Chain options come from the network config, built as <option> nodes.
  expect(await payments.locator('#chain-select option').count()).toBeGreaterThan(1);

  // Profiles: the page script runs and fills its counter. The plain harness
  // has no profile catalog (profiles.spec.js drives the full manager in
  // catalog mode), so the list reports itself unavailable here; what matters
  // is that the counter moved off its static "Loading…".
  await navigate(window, 'freedom://profiles');
  const profiles = await pageFor(electronApp, '/pages/profiles.html');
  await expect(profiles.locator('#stats')).not.toHaveText('Loading…');

  // Links: the window.open() buttons used to be inline onclick handlers.
  await navigate(window, 'freedom://links');
  const links = await pageFor(electronApp, '/pages/links.html');
  const tabs = window.locator('[data-test="tab"]');
  const before = await tabs.count();
  await links.locator('button[data-open-url="https://example.com"]').click();
  await expect(tabs).toHaveCount(before + 1);

  // Protocol test: the load/error status lines used to be inline handlers.
  // Whatever the fixture protocols answer, each line must leave "Loading…".
  await navigate(window, 'freedom://protocol-test');
  const protocolTest = await pageFor(electronApp, '/pages/protocol-test.html');
  await expect(protocolTest.locator('.status.loading')).toHaveCount(0, { timeout: 15_000 });
  await expect(protocolTest.locator('.status.success, .status.error')).toHaveCount(3);

  expect(await cspViolations(electronApp)).toEqual([]);
});

test('settings: changing a control saves it and the chrome follows', async ({
  window,
  electronApp,
}) => {
  await navigate(window, 'freedom://settings/appearance');
  const settings = await pageFor(electronApp, '/pages/settings.html');
  await expect(settings.locator('#theme-mode')).toBeVisible();

  await settings.selectOption('#theme-mode', 'light');
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
  await settings.selectOption('#theme-mode', 'dark');
  await expect(window.locator('html')).not.toHaveAttribute('data-theme', 'light');

  // Section navigation and the page-wide search are both page script.
  await settings.locator('.nav-item[data-target="downloads"]').click();
  await expect(settings.locator('section#downloads')).toBeVisible();
  await expect(settings.locator('section#appearance')).toBeHidden();
  await settings.screenshot({ path: test.info().outputPath('settings.png') });

  expect(await cspViolations(electronApp)).toEqual([]);
});

test('error page: renders the failure and Try Again retries', async ({
  window,
  electronApp,
  harness,
}) => {
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found' });
  await navigate(window, `bzz://${SAMPLE_BZZ_HASH}`);
  const errorPage = await pageFor(electronApp, '/pages/error.html');
  await expect(errorPage.locator('#title')).toHaveText('Content not found yet');
  await expect(errorPage.locator('#details')).toContainText(`bzz://${SAMPLE_BZZ_HASH}`);
  await errorPage.screenshot({ path: test.info().outputPath('error.png') });

  // Let the retry succeed, then press the button.
  await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: true });
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: '<html><head><title>Retried fixture</title></head><body>retried</body></html>',
  });
  await errorPage.locator('#retry-btn').click();
  await expect
    .poll(() =>
      window.evaluate(() => {
        const wv = document.querySelector('webview.active, webview:not(.hidden)');
        return wv?.getURL?.() || '';
      })
    )
    .toMatch(new RegExp(`^bzz://${SAMPLE_BZZ_HASH}`));

  expect(await cspViolations(electronApp)).toEqual([]);
});

test('home and publish load without a violation', async ({ window, electronApp }) => {
  // home.html is the new-tab page (already open at launch, before the recorder
  // was installed, so load it again); publish is the other routable page with
  // a script of its own.
  await navigate(window, 'freedom://publish');
  const publish = await pageFor(electronApp, '/pages/publish.html');
  await publish.waitForLoadState('load');
  await navigate(window, 'freedom://home');
  const home = await pageFor(electronApp, '/pages/home.html');
  await home.waitForLoadState('load');

  expect(await cspViolations(electronApp)).toEqual([]);
});
