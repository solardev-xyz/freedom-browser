const { test, expect } = require('./fixtures');

test('TON documents have secure origins, Fetch, WebCrypto and isolated service workers', async ({
  electronApp,
}) => {
  const result = await electronApp.evaluate(async ({ BrowserWindow, session }) => {
    const mainRequire = process
      .getBuiltinModule('module')
      .createRequire(`${process.cwd()}/package.json`);
    const http = mainRequire('node:http');
    const { registerTonProtocol } = mainRequire('./src/main/ton-protocol');
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('/sw.js')) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(
          "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));"
        );
      } else if (req.url.endsWith('/asset')) {
        res.setHeader('Content-Type', 'text/plain');
        res.end('TON asset');
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>TON test</title>TON test');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const windows = [];
    try {
      const results = [];
      for (const partition of ['ton-test-normal', 'ton-test-private']) {
        const targetSession = session.fromPartition(partition);
        registerTonProtocol(targetSession, { getProxyUrl: () => endpoint });
        const win = new BrowserWindow({
          show: false,
          webPreferences: { partition, sandbox: true, contextIsolation: true },
        });
        windows.push(win);
        await win.loadURL('tonsite://test.ton/');
        results.push(
          await win.webContents.executeJavaScript(`(async () => {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('TON'));
          const asset = await fetch('/asset').then(r => r.text());
          const registration = await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          const previous = localStorage.getItem('isolation');
          localStorage.setItem('isolation', 'stored');
          return { url: location.href, secure: isSecureContext, digestBytes: digest.byteLength,
            asset, scope: registration.scope, previous };
        })()`)
        );
      }
      return results;
    } finally {
      for (const win of windows) win.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  expect(result).toEqual(
    Array(2).fill({
      url: 'tonsite://test.ton/',
      secure: true,
      digestBytes: 32,
      asset: 'TON asset',
      scope: 'tonsite://test.ton/',
      previous: null,
    })
  );
});

for (const theme of ['dark', 'light']) {
  test.describe(`TON settings in ${theme}`, () => {
    test.use({ seedSettings: { theme, enableTonIntegration: false, startTonAtLaunch: false } });
    test('places Beta activation in Advanced and configuration/startup in Nodes', async ({
      electronApp,
      window,
    }) => {
      const recipes = require('../.claude/skills/run-freedom/recipes');
      const page = await recipes.settings({ app: electronApp, win: window }, 'advanced');
      const row = page.locator('.row').filter({ has: page.locator('#enable-ton-integration') });
      await expect(row.locator('.resolver-badge')).toHaveText('Beta');
      await expect(row.locator('#enable-ton-integration')).not.toBeChecked();
      await page.locator('label.toggle:has(#enable-ton-integration)').click();
      await expect
        .poll(() =>
          window.evaluate(async () => (await window.electronAPI.getSettings()).enableTonIntegration)
        )
        .toBe(true);
      await page.evaluate(() => {
        location.hash = '#nodes';
      });
      const node = page.locator('.profile-node[data-protocol="ton"]');
      await expect(node).toBeVisible();
      await expect(node.locator('[data-node-mode]')).toHaveValue('managed');
      await expect(node.locator('[data-node-mode] option')).toHaveText([
        'Managed by Freedom',
        'Disabled',
      ]);
      await page.evaluate(() => {
        location.hash = '#nodes/startup';
      });
      await expect(page.locator('#start-ton-at-launch')).toBeEnabled();
      await page.locator('label.toggle:has(#start-ton-at-launch)').click();
      await expect
        .poll(() =>
          window.evaluate(async () => (await window.electronAPI.getSettings()).startTonAtLaunch)
        )
        .toBe(true);
      await page.evaluate(() => {
        location.hash = '#advanced';
      });
      await page.locator('label.toggle:has(#enable-ton-integration)').click();
      await expect
        .poll(() =>
          window.evaluate(async () => (await window.electronAPI.getSettings()).enableTonIntegration)
        )
        .toBe(false);
      await page.evaluate(() => {
        location.hash = '#nodes/startup';
      });
      await expect(page.locator('#start-ton-at-launch')).toBeDisabled();
      await expect(page.locator('#start-ton-help')).toHaveText(
        'Turn on Enable TON Sites under Advanced first.'
      );
      await expect(page.locator('.profile-node[data-protocol="ton"]')).toHaveCount(0);
    });
  });
}
