// Packaged smoke for #503: address-bar history lookups run in a
// worker_threads worker (src/main/history-search-worker.js) that loads
// better-sqlite3 itself. In a package that worker script sits inside
// app.asar and the native binding in app.asar.unpacked (`asarUnpack`), a
// layout a source-tree run never exercises. If the worker cannot load the
// module the host quietly answers on the main thread for the rest of the
// session — suggestions still work, so only its warning gives it away.
// Checked against a doctored asar whose worker requires a missing module:
// this spec fails on that warning.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { test, expect } = require('../fixtures');

test('history suggestions are served by the search worker, not the main-thread fallback', async ({
  window,
  userDataDir,
}) => {
  // A local page to put in history (the packaged build has no content stubs).
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Quokka Field Notes</title><h1>quokka</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = `http://127.0.0.1:${server.address().port}/quokka-notes`;
    const input = window.locator('[data-test="address-input"]');
    await input.fill(page);
    await input.press('Enter');

    // Retype until the visit is recorded and suggested.
    await expect
      .poll(
        async () => {
          await input.click();
          await input.fill('');
          await window.keyboard.type('quokka-no');
          await window.waitForTimeout(500);
          return window.evaluate(() =>
            [...document.querySelectorAll('#autocomplete-dropdown [data-url]')].map(
              (row) => row.dataset.url
            )
          );
        },
        { timeout: 20_000 }
      )
      .toContain(page);
    await window.keyboard.press('Escape');

    const logFile = path.join(userDataDir, 'logs', 'main.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    expect(log).toContain('[History] Opening database');
    expect(log).not.toMatch(/\[HistorySearch\] worker (unavailable|failed to start)/);
  } finally {
    server.close();
  }
});
