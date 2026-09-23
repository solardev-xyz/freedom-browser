// Filter-list scriptlets (`##+js(...)`) end to end: the engine resolves them
// against the real, sha256-pinned uBlock Origin resources, the webview preload
// fetches them synchronously and runs them in the page's main world before the
// page's own scripts — in the main frame and in a cross-origin iframe (#410).
//
// CI can't depend on youtube.com, so a local server plays it: a page shaped
// like a watch page (a `ytInitialPlayerResponse` parsed from JSON, a fetch of
// `/youtubei/v1/player`) and an embed page in an iframe, each carrying
// `adPlacements`/`playerAds`/`adSlots`. The fixture list holds the same
// `json-prune` / `json-prune-fetch-response` rules uBlock's lists use for
// YouTube, scoped to the fixture hosts. The page answers with a CSP that
// forbids eval, to prove the injection doesn't depend on the page allowing it.
//
// Lives in the live project for the same reason as adblock.spec.js (the
// harness owns http via protocol.handle) — and because the resources file is
// downloaded (pinned + checked) when `npm run adblock:download` hasn't run.

const { test, expect } = require('../live-fixtures');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RESOURCES, fetchResources } = require('../../scripts/fetch-adblock-lists');

const repoRoot = path.resolve(__dirname, '..', '..');
const bundledResources = path.join(repoRoot, 'assets', 'adblock', RESOURCES.file);

const PAGE_HOST = 'yt.test.localhost';
const EMBED_HOST = 'embed.test.localhost';

const adblockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-adblock-scriptlets-e2e-'));
fs.writeFileSync(
  path.join(adblockDir, 'manifest.json'),
  JSON.stringify({
    version: 'e2e',
    categories: { ublock: { file: 'ublock-e2e.txt' } },
    resources: { file: RESOURCES.file, version: RESOURCES.tag, sha256: RESOURCES.sha256 },
  })
);
fs.writeFileSync(
  path.join(adblockDir, 'ublock-e2e.txt'),
  [
    // uBlock's filters.txt rule for the parsed-in-page player config…
    `${PAGE_HOST},${EMBED_HOST}##+js(json-prune, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots)`,
    // …and its Quick fixes rule for the /youtubei/v1/player API response.
    `${PAGE_HOST},${EMBED_HOST}##+js(json-prune-fetch-response, adPlacements adSlots playerAds playerResponse.adPlacements playerResponse.adSlots playerResponse.playerAds, , propsToMatch, /player?)`,
  ].join('\n')
);

test.use({
  launchEnv: { FREEDOM_ADBLOCK_DIR: adblockDir },
  seedSettings: {
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
  },
});

const PLAYER = {
  videoDetails: { videoId: 'e2e' },
  adPlacements: [{ kind: 'preroll' }],
  playerAds: [{ kind: 'overlay' }],
  adSlots: [{ kind: 'slot' }],
};

// Inline script: runs during parsing, so anything it sees is what YouTube's
// own player code would see. `ytInitialPlayerResponse` comes from JSON.parse,
// the player API response from Response.json().
const pageScript = (label) => `
  var ytInitialPlayerResponse = JSON.parse(${JSON.stringify(JSON.stringify(PLAYER))});
  window.__${label} = {
    initial: Object.keys(ytInitialPlayerResponse).sort(),
    // The preload stops after the scriptlet step in a sub-frame: no wallet.
    wallet: 'ethereum' in window,
  };
  fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST' })
    .then((r) => r.json())
    .then((json) => { window.__${label}.api = Object.keys(json.playerResponse).sort(); })
    .catch((err) => { window.__${label}.api = 'error: ' + err.message; })
    .finally(() => { if (window.parent !== window) parent.postMessage(window.__${label}, '*'); });
`;

let server;
let port;

test.beforeAll(async () => {
  if (fs.existsSync(bundledResources)) {
    const bytes = fs.readFileSync(bundledResources);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest === RESOURCES.sha256) {
      fs.copyFileSync(bundledResources, path.join(adblockDir, RESOURCES.file));
    }
  }
  if (!fs.existsSync(path.join(adblockDir, RESOURCES.file))) {
    const { text } = await fetchResources();
    fs.writeFileSync(path.join(adblockDir, RESOURCES.file), text);
  }

  server = http.createServer((req, res) => {
    const host = req.headers.host.split(':')[0];
    if (req.url.startsWith('/youtubei/v1/player')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ playerResponse: PLAYER }));
      return;
    }
    const label = host === EMBED_HOST ? 'embed' : 'page';
    res.writeHead(200, {
      'Content-Type': 'text/html',
      // No 'unsafe-eval': the injection must not need the page's permission.
      'Content-Security-Policy': "script-src 'self' 'unsafe-inline'",
    });
    const iframe =
      label === 'page'
        ? `<iframe src="http://${EMBED_HOST}:${port}/embed"></iframe>
           <script>addEventListener('message', (e) => { window.__embed = e.data; });</script>`
        : '';
    res.end(`<!doctype html><title>scriptlets e2e ${label}</title>
      <script>${pageScript(label)}</script>${iframe}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(adblockDir, { recursive: true, force: true });
});

const PRUNED = ['videoDetails'];
const UNTOUCHED = ['adPlacements', 'adSlots', 'playerAds', 'videoDetails'];

test('prunes ad fields before page scripts read them; toggle and allowlist turn it off', async ({
  window,
  electronApp,
}) => {
  const servicePath = path.join(repoRoot, 'src', 'main', 'adblock', 'service.js');
  const settingsPath = path.join(repoRoot, 'src', 'main', 'settings-store.js');
  const allowlistPath = path.join(repoRoot, 'src', 'main', 'adblock', 'allowlist-store.js');
  await expect
    .poll(() =>
      electronApp.evaluate(
        (_electron, p) => process.mainModule.require(p).isEngineReady(),
        servicePath
      )
    )
    .toBe(true);

  // Record every frame URL the preload asks scriptlets for, by wrapping the
  // real sync handler (still answering through it).
  await electronApp.evaluate(({ ipcMain }) => {
    const [original] = ipcMain.listeners('adblock:scriptlets');
    ipcMain.removeListener('adblock:scriptlets', original);
    globalThis.__scriptletUrls = [];
    ipcMain.on('adblock:scriptlets', (event, args) => {
      globalThis.__scriptletUrls.push(args?.url);
      original(event, args);
    });
  });
  const askedUrls = () => electronApp.evaluate(() => globalThis.__scriptletUrls);

  const pageUrl = `http://${PAGE_HOST}:${port}/watch?v=e2e`;
  const visit = (n) => `${pageUrl}&n=${n}`;
  const input = window.locator('[data-test="address-input"]');
  const go = async (url) => {
    await input.click();
    await input.fill(url);
    await input.press('Enter');
  };
  const guestPage = async () => {
    let guest;
    await expect
      .poll(() => {
        guest = electronApp.windows().find((p) => p.url().includes(PAGE_HOST));
        return Boolean(guest);
      })
      .toBe(true);
    return guest;
  };
  // Wait for the page's own report, plus the embed's (posted up from the
  // cross-origin iframe once its fetch settled).
  // `n` tags each visit so a poll can't read the previous document's report.
  const results = async (guest, n) => {
    await expect
      .poll(
        () =>
          guest
            .evaluate(
              (visit) =>
                location.search.includes(`n=${visit}`) &&
                Boolean(window.__page?.api && window.__embed?.api),
              n
            )
            .catch(() => false),
        { timeout: 15_000 }
      )
      .toBe(true);
    return guest.evaluate(() => ({ page: window.__page, embed: window.__embed }));
  };

  // 1. Blocking on: both frames see the player data without its ad fields —
  //    already in the synchronous inline script, i.e. before any page code ran.
  await go(visit(1));
  let guest = await guestPage();
  expect(await results(guest, 1)).toEqual({
    page: { initial: PRUNED, api: PRUNED, wallet: true },
    embed: { initial: PRUNED, api: PRUNED, wallet: false },
  });
  const asked = await askedUrls();
  expect(asked).toContain(visit(1));
  expect(asked).toContain(`http://${EMBED_HOST}:${port}/embed`);

  // 2. Master toggle off: nothing is pruned.
  await electronApp.evaluate(
    (_electron, p) => process.mainModule.require(p).saveSettings({ adblockEnabled: false }),
    settingsPath
  );
  await go(visit(2));
  guest = await guestPage();
  expect(await results(guest, 2)).toEqual({
    page: { initial: UNTOUCHED, api: UNTOUCHED, wallet: true },
    embed: { initial: UNTOUCHED, api: UNTOUCHED, wallet: false },
  });

  // 3. Back on, but the tab's site allowlisted: the page and its iframe are
  //    both spared (the allowlist keys on the tab's top-level host).
  await electronApp.evaluate(
    (_electron, p) => process.mainModule.require(p).saveSettings({ adblockEnabled: true }),
    settingsPath
  );
  expect(
    await electronApp.evaluate(
      (_electron, { p, host }) => process.mainModule.require(p).addAllowlistedHost(host),
      { p: allowlistPath, host: PAGE_HOST }
    )
  ).toBe(true);
  await go(visit(3));
  guest = await guestPage();
  expect(await results(guest, 3)).toEqual({
    page: { initial: UNTOUCHED, api: UNTOUCHED, wallet: true },
    embed: { initial: UNTOUCHED, api: UNTOUCHED, wallet: false },
  });

  // 4. Internal pages never even ask.
  await go('freedom://history');
  await expect
    .poll(() => electronApp.windows().some((p) => p.url().includes('/pages/history.html')))
    .toBe(true);
  expect((await askedUrls()).filter((url) => !/^https?:/.test(url))).toEqual([]);
});
