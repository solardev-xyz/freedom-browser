// The browser chrome of the app's first window, for the fixtures and specs.
//
// Every chrome window has an approvals document too (freedom-core design
// 0011, on by default): a WebContentsView of its own, which Playwright lists
// as a page of the app, as it lists every tab's webview. Which page appears
// first isn't fixed, so `firstWindow()` alone can hand back the approvals
// document. This waits for the first page on the chrome's own URL instead.

const CHROME_PAGE = /\/renderer\/index\.html(?:[?#]|$)/;

/** Resolves with the first page on the chrome's URL, within `timeout` ms. */
async function chromeWindow(app, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  await app.firstWindow({ timeout });
  for (;;) {
    const win = app.windows().find((page) => CHROME_PAGE.test(page.url()));
    if (win) return win;
    if (Date.now() >= deadline) throw new Error(`No browser chrome appeared within ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

module.exports = { CHROME_PAGE, chromeWindow };
