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
