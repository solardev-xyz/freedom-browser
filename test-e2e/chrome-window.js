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

// In the page: whether the chrome's start-up has run. The address bar is
// static markup, up before any of it: index.js initializes the chrome's
// modules only once it has read the settings, and the sidebar reads them a
// second time before `sidebar.open()` does anything (initSidebar). A spec
// that drives the chrome sooner finds the open a no-op, so the sidebar never
// opens, and the wallet's screens not yet registered. The wallet's `eth.send`
// screen registers in that start-up (initWalletUi); the sidebar's flag
// matches the settings once its own read is back.
async function chromeStartedInPage() {
  const [{ pagePromptRenderer }, { isFeatureEnabled }, settings] = await Promise.all([
    import('./lib/page-prompt-renderers.js'),
    import('./lib/sidebar.js'),
    window.electronAPI.getSettings(),
  ]);
  return (
    pagePromptRenderer('eth.send') !== undefined &&
    isFeatureEnabled() === (settings?.enableIdentityWallet === true)
  );
}

/** Resolves once `win`'s chrome has run its start-up (above), within `timeout` ms. */
async function chromeStarted(win, { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  // Module scripts have run by then, so the probe's imports load nothing early.
  await win.waitForLoadState('domcontentloaded', { timeout });
  for (;;) {
    if (await win.evaluate(chromeStartedInPage).catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error(`The browser chrome did not start within ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

module.exports = { CHROME_PAGE, chromeWindow, chromeStarted };
