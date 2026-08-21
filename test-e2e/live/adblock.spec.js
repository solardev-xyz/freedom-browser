// End-to-end network blocking through the real webRequest pipeline.
//
// Lives in the live project (no FREEDOM_TEST_MODE) because the harness
// project owns the http/https schemes via protocol.handle, which
// bypasses the network stack this feature intercepts. Ant/IPFS
// autostart is disabled via seeded settings — no nodes are needed.
//
// A local HTTP server plays three roles via *.localhost subdomains
// (Chromium resolves any *.localhost to loopback without DNS, but the
// hostnames are not in the adblock service's loopback-exempt set):
// `page.test.localhost` serves the page, `allowed.test.localhost` and
// `blocked.test.localhost` serve subresources. The app is launched with
// FREEDOM_ADBLOCK_DIR pointing at a fixture list that blocks the latter.
//
// Assertions read the server's hit log — a blocked request is cancelled
// in onBeforeRequest and never reaches the server, which is the exact
// behavior being shipped.

const { test, expect } = require('../live-fixtures');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

// Fixture list dir must exist before the electronApp fixture launches,
// and test.use() options are static — so build it at module load.
const adblockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-adblock-e2e-'));
fs.writeFileSync(
  path.join(adblockDir, 'manifest.json'),
  JSON.stringify({
    version: 'e2e',
    categories: { ads: { file: 'e2e-list.txt' } },
  })
);
fs.writeFileSync(
  path.join(adblockDir, 'e2e-list.txt'),
  ['||blocked.test.localhost^', '##.ad-slot'].join('\n')
);

test.use({
  launchEnv: { FREEDOM_ADBLOCK_DIR: adblockDir },
  seedSettings: {
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
  },
});

const PIXEL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
);

let server;
let port;
let hits;

test.beforeAll(async () => {
  hits = [];
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host.split(':')[0]}${req.url}`);
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PIXEL_PNG);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>adblock e2e</title>
      <img src="http://allowed.test.localhost:${port}/allowed-pixel.png">
      <img src="http://blocked.test.localhost:${port}/blocked-pixel.png">
      <div class="ad-slot" id="ad">ad</div>
      <div class="content" id="content">content</div>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(adblockDir, { recursive: true, force: true });
});

test('blocks listed third-party subresources and passes others through', async ({
  window,
  electronApp,
}) => {
  // The engine builds asynchronously after install; tiny fixture list, so
  // this settles in milliseconds. Playwright's evaluate scope has no
  // `require`, but `process` is the app's — its mainModule require
  // returns the live service instance (same absolute path).
  const servicePath = path.join(repoRoot, 'src', 'main', 'adblock', 'service.js');
  await expect
    .poll(() =>
      electronApp.evaluate(
        (_electron, p) => process.mainModule.require(p).isEngineReady(),
        servicePath
      )
    )
    .toBe(true);

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`http://page.test.localhost:${port}/index.html`);
  await input.press('Enter');

  // The allowed pixel reaching the server proves the page loaded and its
  // subresource requests went through the webRequest pipeline.
  await expect
    .poll(() => hits.includes('allowed.test.localhost/allowed-pixel.png'), { timeout: 30_000 })
    .toBe(true);

  // Both pixels are requested by the same page at the same time; once the
  // allowed one has landed, give any (wrongly) unblocked request a moment
  // to arrive before asserting it never did.
  await new Promise((resolve) => setTimeout(resolve, 750));
  expect(hits.includes('blocked.test.localhost/blocked-pixel.png')).toBe(false);
  expect(hits.includes('page.test.localhost/index.html')).toBe(true);

  // Cosmetic filtering: the preload requested `##.ad-slot` hiding CSS from
  // the engine and injected it, so the ad div is display:none while the
  // content div is untouched. The page renders inside a <webview> guest.
  let guest;
  await expect
    .poll(() => {
      guest = electronApp.windows().find((p) => p.url().includes('page.test.localhost'));
      return Boolean(guest);
    })
    .toBe(true);
  await expect
    .poll(() => guest.locator('#ad').evaluate((el) => getComputedStyle(el).display), {
      timeout: 15_000,
    })
    .toBe('none');
  expect(await guest.locator('#content').evaluate((el) => getComputedStyle(el).display)).not.toBe(
    'none'
  );
});
