// Downloads — a triggered download pops a shelf card in the owning window's
// chrome and lands as an entry on the freedom://downloads page.
//
// The download is triggered via webContents.downloadURL with a data: URI so
// the spec needs no network and no fixture content; it exercises the same
// will-download path as page-initiated downloads. Test mode redirects
// app.getPath('downloads') into the per-run temp userData dir, so nothing
// is written to the real ~/Downloads.

const { test, expect } = require('./fixtures');

// "freedom-downloads-e2e" as base64 (application/octet-stream forces the
// download code path rather than rendering).
const DATA_URI = 'data:application/octet-stream;base64,ZnJlZWRvbS1kb3dubG9hZHMtZTJl';

test('a download shows a shelf card and a freedom://downloads entry', async ({
  window,
  electronApp,
}) => {
  await electronApp.evaluate(({ BrowserWindow }, dataUri) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.downloadURL(dataUri);
  }, DATA_URI);

  // Shelf card appears in the chrome. A data: URI download completes almost
  // instantly, so assert the completed-state affordances rather than the
  // transient progress bar.
  const card = window.locator('#download-shelf .download-card');
  await expect(card).toHaveCount(1, { timeout: 10_000 });
  await expect(card.locator('[data-test="download-show-in-folder"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(card.locator('[data-test="download-open"]')).toBeVisible();

  // Open the downloads page via the address bar (the Cmd/Ctrl+Shift+J menu
  // item routes to the same freedom://downloads singleton tab).
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://downloads');
  await input.press('Enter');

  // Active webview lands on pages/downloads.html...
  await expect
    .poll(
      async () => {
        return window.evaluate(() => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          return wv?.getURL?.() || wv?.getAttribute?.('src') || '';
        });
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toMatch(/pages\/downloads\.html/);

  // ...and lists the completed download. The page lives inside the webview,
  // so reach into it with executeJavaScript.
  await expect
    .poll(
      async () => {
        return window.evaluate(async () => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          if (!wv?.executeJavaScript) return 'no-webview';
          try {
            return await wv.executeJavaScript(
              `[...document.querySelectorAll('.download-item')].map((el) =>
                 el.querySelector('.download-name')?.textContent + '|' + el.className
               ).join(';')`
            );
          } catch {
            return 'not-ready';
          }
        });
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toMatch(/download\|.*state-completed/);
});

test('shelf cards dismiss manually and Clear All empties the downloads page', async ({
  window,
  electronApp,
}) => {
  // An in-flight download is hard to hold open with a data: URI (it
  // completes in one chunk), so cancel/pause/resume live in the Jest
  // manager suite; here we drive the post-completion surfaces.
  await electronApp.evaluate(({ BrowserWindow }, dataUri) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.downloadURL(dataUri);
  }, DATA_URI);

  const card = window.locator('#download-shelf .download-card');
  await expect(card.locator('[data-test="download-open"]')).toBeVisible({ timeout: 10_000 });

  // Dismiss the card manually (auto-dismiss would also clear it).
  await card.locator('[data-test="download-close"]').click();
  await expect(card).toHaveCount(0);

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://downloads');
  await input.press('Enter');

  await expect
    .poll(
      async () => {
        return window.evaluate(async () => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          if (!wv?.executeJavaScript) return -1;
          try {
            return await wv.executeJavaScript(`document.querySelectorAll('.download-item').length`);
          } catch {
            return -1;
          }
        });
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toBeGreaterThan(0);

  // Clear All removes settled entries (auto-confirmed: the page uses
  // window.confirm, which Playwright accepts by default via the dialog
  // handler below).
  window.on('dialog', (dialog) => dialog.accept());
  await window.evaluate(async () => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    await wv.executeJavaScript(
      `(() => { window.confirm = () => true; document.getElementById('clear-btn').click(); })()`
    );
  });

  await expect
    .poll(
      async () => {
        return window.evaluate(async () => {
          const wv = document.querySelector('webview.active, webview:not(.hidden)');
          try {
            return await wv.executeJavaScript(`document.querySelectorAll('.download-item').length`);
          } catch {
            return -1;
          }
        });
      },
      { timeout: 10_000, intervals: [200, 500, 1000] }
    )
    .toBe(0);
});

// #309: the × on a running download used to last exactly one progress tick —
// main emits one every 250 ms, so the card blinked out and came straight back
// for the length of the transfer. A data: URI download settles in one chunk,
// so the in-flight payloads are fed to the shelf directly: this is the exact
// `downloads:updated` shape main sends, applied through the real card UI.
test('a card dismissed mid-download stays dismissed', async ({ window }) => {
  const feed = (download) =>
    window.evaluate(async (payload) => {
      const mod = await import('./lib/downloads-ui.js');
      mod.handleDownloadUpdate(payload);
    }, download);

  // Counted with a one-shot read, never a polling locator: a settled card
  // auto-dismisses after 5 s, so a *retrying* "no cards" assertion would go
  // green on the timer alone even with the card resurrected (it did, before
  // this was written this way).
  const cardCount = () =>
    window.evaluate(() => document.querySelectorAll('#download-shelf .download-card').length);
  const cardNames = () =>
    window.evaluate(() =>
      [...document.querySelectorAll('#download-shelf .download-card-name')].map(
        (el) => el.textContent
      )
    );

  const cards = window.locator('#download-shelf .download-card');
  const tick = (received) => ({
    id: 4242,
    filename: 'big.iso',
    state: 'progressing',
    received_bytes: received,
    total_bytes: 100_000,
  });

  await feed(tick(1_000));
  await expect(cards).toHaveCount(1);
  await expect(cards.locator('[data-test="download-cancel"]')).toBeVisible();

  await cards.locator('[data-test="download-close"]').click();
  expect(await cardCount()).toBe(0);

  // The next progress ticks are ignored — this is the quarter-second the card
  // used to come back in.
  await feed(tick(2_000));
  expect(await cardCount()).toBe(0);
  await feed(tick(90_000));
  expect(await cardCount()).toBe(0);

  // ...as is the terminal update when the transfer finishes.
  await feed({
    id: 4242,
    filename: 'big.iso',
    state: 'completed',
    received_bytes: 100_000,
    total_bytes: 100_000,
  });
  expect(await cardCount()).toBe(0);

  // Another download still shows: the dismissal is per item, not a mute.
  await feed({
    id: 4243,
    filename: 'other.iso',
    state: 'progressing',
    received_bytes: 10,
    total_bytes: 100,
  });
  expect(await cardNames()).toEqual(['other.iso']);
});
