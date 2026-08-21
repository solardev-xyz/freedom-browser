// Regression: in a light-theme private window the active tab must keep the
// plum private palette. light-theme.css hardcodes #ffffff on .tab.active
// (rather than routing through --toolbar), which left the active tab white
// against the plum toolbar — a jarring split only visible in light theme.
// private.css re-routes body.private-window .tab.active back through --toolbar.
const { test, expect } = require('./fixtures');

async function openPrivateWindow(electronApp) {
  const known = new Set(
    electronApp.windows().filter((p) => p.url().includes('privatePartition=private-')).map((p) => p.url())
  );
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('new-private-window')?.click();
  });
  let page;
  await expect
    .poll(() => {
      page = electronApp
        .windows()
        .find((c) => c.url().includes('privatePartition=private-') && !known.has(c.url()));
      return !!page;
    }, { timeout: 15_000 })
    .toBe(true);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return page;
}

test.use({ seedSettings: { theme: 'light' } });

test('light-theme private window: active tab uses plum toolbar, not white', async ({ electronApp, window }) => {
  await window.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  const priv = await openPrivateWindow(electronApp);
  expect(await priv.evaluate(() => document.body.classList.contains('private-window'))).toBe(true);
  // documentElement is in light theme, confirming the bug's precondition.
  expect(await priv.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
  await priv.waitForSelector('.tab.active', { state: 'attached' });
  const bg = await priv.evaluate(() =>
    getComputedStyle(document.querySelector('.tab.active')).backgroundColor
  );
  // Plum --toolbar #352b47 -> rgb(53, 43, 71). Must NOT be white rgb(255,255,255).
  expect(bg).toBe('rgb(53, 43, 71)');
});
