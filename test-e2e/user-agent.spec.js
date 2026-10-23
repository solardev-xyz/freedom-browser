// Web content sees a plain Chrome User-Agent (#471): no `Freedom/` or
// `Electron/` token in `navigator.userAgent`, in a worker, in the request
// header, or in a client-hints brand, in a normal tab and a private window.
//
// The page is served over https by a handler this spec installs on the default
// session in place of the harness's https stub, so it can see the request
// User-Agent header the real <webview> guest sends with the page request.
// (A worker's script fetch reaches a protocol.handle handler without one —
// Chromium adds it further down the network stack — so the worker is checked
// through its own navigator.userAgent instead.)

const { test, expect } = require('./fixtures');
const { evalInWebview } = require('./permission-fixtures');

const ORIGIN = 'https://ua-check.test';

// Stock Chrome's reduced UA: one of Chromium's frozen desktop platform tokens
// (never the host CPU, e.g. `Linux aarch64`), then `Chrome/<major>.0.0.0`.
const CHROME_SHAPE =
  /^Mozilla\/5\.0 \((?:X11; Linux x86_64|Macintosh; Intel Mac OS X 10_15_7|Windows NT 10\.0; Win64; x64)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/;

const PAGE = `<!doctype html><title>ua check</title><div id="out">none</div>
<script>
  const worker = new Worker('/worker.js');
  worker.onmessage = async (e) => {
    const he = await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
    window.__ua = {
      page: navigator.userAgent,
      appVersion: navigator.appVersion,
      worker: e.data,
      brands: navigator.userAgentData.brands.map((b) => b.brand),
      fullVersionList: he.fullVersionList.map((b) => b.brand),
    };
    document.getElementById('out').textContent = 'done';
  };
</script>`;

const WORKER = 'postMessage(navigator.userAgent);';

async function openPrivateWindow(electronApp) {
  const known = new Set(
    electronApp
      .windows()
      .map((page) => page.url())
      .filter((url) => url.includes('privatePartition=private-'))
  );
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().getMenuItemById('new-private-window').click();
  });
  let page;
  await expect
    .poll(() => {
      page = electronApp
        .windows()
        .find((p) => p.url().includes('privatePartition=private-') && !known.has(p.url()));
      return !!page;
    })
    .toBe(true);
  await page.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return page;
}

test('web content gets a plain Chrome User-Agent, not Freedom/Electron', async ({
  electronApp,
  window,
}) => {
  const chrome = await electronApp.evaluate(() => process.versions.chrome);

  await electronApp.evaluate(
    ({ session }, { page, worker }) => {
      globalThis.__uaRequests = {};
      const { protocol } = session.defaultSession;
      protocol.unhandle('https');
      protocol.handle('https', (request) => {
        const { pathname } = new URL(request.url);
        globalThis.__uaRequests[pathname] = request.headers.get('user-agent');
        const js = pathname === '/worker.js';
        return new Response(js ? worker : page, {
          headers: { 'Content-Type': js ? 'text/javascript' : 'text/html; charset=utf-8' },
        });
      });
    },
    { page: PAGE, worker: WORKER }
  );

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`${ORIGIN}/`);
  await input.press('Enter');
  await expect
    .poll(() => evalInWebview(window, "document.getElementById('out')?.textContent || null"), {
      timeout: 15_000,
    })
    .toBe('done');

  const seen = await evalInWebview(window, 'window.__ua');
  const headers = await electronApp.evaluate(() => globalThis.__uaRequests);
  const major = chrome.split('.')[0];

  expect(seen.page).toMatch(CHROME_SHAPE);
  expect(seen.page).toContain(` Chrome/${major}.0.0.0 `);
  expect(seen.page).not.toMatch(/Freedom|Electron/i);
  expect(seen.appVersion).not.toMatch(/Freedom|Electron/i);
  expect(seen.worker).toBe(seen.page);
  expect(headers['/']).toBe(seen.page);
  for (const brand of [...seen.brands, ...seen.fullVersionList]) {
    expect(brand).not.toMatch(/Freedom|Electron/i);
  }

  // A private window's partition inherits it too, and so does every
  // webContents the app has: chrome windows, guests, internal pages.
  const privateWindow = await openPrivateWindow(electronApp);
  await expect
    .poll(() => evalInWebview(privateWindow, 'navigator.userAgent'), { timeout: 15_000 })
    .toBe(seen.page);

  const everywhere = await electronApp.evaluate(async ({ webContents }) => {
    const out = [];
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      out.push({
        url: wc.getURL(),
        contents: wc.getUserAgent(),
        session: wc.session.getUserAgent(),
        navigator: await wc.executeJavaScript('navigator.userAgent').catch(() => null),
      });
    }
    return out;
  });
  expect(everywhere.some((wc) => wc.url.includes('privatePartition=private-'))).toBe(true);
  for (const wc of everywhere) {
    expect({ url: wc.url, ua: wc.contents }).toEqual({ url: wc.url, ua: seen.page });
    expect({ url: wc.url, ua: wc.session }).toEqual({ url: wc.url, ua: seen.page });
    if (wc.navigator !== null) {
      expect({ url: wc.url, ua: wc.navigator }).toEqual({ url: wc.url, ua: seen.page });
    }
  }
});
