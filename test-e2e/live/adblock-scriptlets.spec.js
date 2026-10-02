// Filter-list scriptlets (`##+js(...)`) end to end: the engine resolves them
// against the real, sha256-pinned uBlock Origin resources, the webview preload
// fetches them synchronously and runs them in the page's main world before the
// page's own scripts — in the main frame and in a cross-origin iframe (#410),
// and in same-origin about:blank / srcdoc frames the page can reach into —
// through contentWindow/contentDocument or as window[i] / frames[i] (#414).
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

// Same-origin documents a page can reach into (#412 R1-M3): a script-created
// about:blank iframe whose JSON.parse the page calls straight away — the
// "borrow an unpatched global" move — and srcdoc and blob: iframes parsing in
// their own inline scripts. All inherit the page's origin, so all must be
// patched like the page itself, before the first line that touches them.
const PLAYER_JSON = JSON.stringify(JSON.stringify(PLAYER));
const srcdocHtml = `<script>
  parent.__srcdoc = Object.keys(JSON.parse(${PLAYER_JSON})).sort();
</script>`;
const blobHtml = srcdocHtml.replace('__srcdoc', '__blob');
const sameOriginFramesScript = `
  var blank = document.createElement('iframe');
  document.documentElement.appendChild(blank);
  window.__page.blank = Object.keys(blank.contentWindow.JSON.parse(${PLAYER_JSON})).sort();
  // The same through contentDocument, and one level deeper (an about:blank
  // frame created inside the first one, through that realm's own DOM).
  var viaDoc = document.createElement('iframe');
  document.documentElement.appendChild(viaDoc);
  var viaDocWin = viaDoc.contentDocument.defaultView;
  window.__page.blankDoc = Object.keys(viaDocWin.JSON.parse(${PLAYER_JSON})).sort();
  var nested = blank.contentDocument.createElement('iframe');
  blank.contentDocument.documentElement.appendChild(nested);
  window.__page.blankNested = Object.keys(nested.contentWindow.JSON.parse(${PLAYER_JSON})).sort();
  // No accessor at all (#414): a frame reached as window[i] / frames[i]
  // straight after insertion — through appendChild, innerHTML, and one whose
  // src is a cross-origin URL (until that navigation commits, the frame is a
  // same-origin about:blank realm), plus a nested frame reached as frames[i]
  // inside the first one.
  var last = function () { return window[window.length - 1]; };
  document.documentElement.appendChild(document.createElement('iframe'));
  window.__page.framesIndex = Object.keys(last().JSON.parse(${PLAYER_JSON})).sort();
  var holder = document.createElement('div');
  document.documentElement.appendChild(holder);
  holder.innerHTML = '<iframe></iframe>';
  window.__page.framesInnerHTML = Object.keys(frames[frames.length - 1].JSON.parse(${PLAYER_JSON})).sort();
  var pending = document.createElement('iframe');
  pending.src = 'http://${EMBED_HOST}:' + location.port + '/embed?pending';
  document.documentElement.appendChild(pending);
  window.__page.framesPending = Object.keys(last().JSON.parse(${PLAYER_JSON})).sort();
  var outer = last();
  outer.document.body.appendChild(outer.document.createElement('iframe'));
  window.__page.framesNested = Object.keys(outer[0].JSON.parse(${PLAYER_JSON})).sort();
  // Insertion APIs outside Node/ParentNode (#466 R1-M1): a frame carried in
  // by a table's caption setter, and by select.add inside an <option>.
  var table = document.createElement('table');
  document.documentElement.appendChild(table);
  var caption = document.createElement('caption');
  caption.appendChild(document.createElement('iframe'));
  table.caption = caption;
  window.__page.framesTable = Object.keys(last().JSON.parse(${PLAYER_JSON})).sort();
  var select = document.createElement('select');
  document.documentElement.appendChild(select);
  var option = document.createElement('option');
  option.appendChild(document.createElement('iframe'));
  select.add(option);
  window.__page.framesSelect = Object.keys(last().JSON.parse(${PLAYER_JSON})).sort();
  // Page code running inside the insertion itself (#466 R2-M1): a custom
  // element's connectedCallback fires at the end of appendChild, with the
  // fragment's iframe already in the document.
  customElements.define('x-frames-probe', class extends HTMLElement {
    connectedCallback() {
      window.__page.framesCustomElement = Object.keys(frames[frames.length - 1].JSON.parse(${PLAYER_JSON})).sort();
    }
  });
  var fragment = document.createDocumentFragment();
  fragment.append(document.createElement('iframe'), document.createElement('x-frames-probe'));
  document.documentElement.appendChild(fragment);
  // Form-associated reactions (#466 R3-M1): run in the same scope, when the
  // fragment lands in a <form> / a disabled <fieldset>.
  customElements.define('x-frames-form', class extends HTMLElement {
    static formAssociated = true;
    formAssociatedCallback(form) {
      if (form) window.__page.framesFormAssociated = Object.keys(frames[frames.length - 1].JSON.parse(${PLAYER_JSON})).sort();
    }
    formDisabledCallback(disabled) {
      if (disabled) window.__page.framesFormDisabled = Object.keys(frames[frames.length - 1].JSON.parse(${PLAYER_JSON})).sort();
    }
  });
  var form = document.createElement('form');
  document.documentElement.appendChild(form);
  fragment = document.createDocumentFragment();
  fragment.append(document.createElement('iframe'), document.createElement('x-frames-form'));
  form.appendChild(fragment);
  var fieldset = document.createElement('fieldset');
  fieldset.disabled = true;
  document.documentElement.appendChild(fieldset);
  fragment = document.createDocumentFragment();
  fragment.append(document.createElement('iframe'), document.createElement('x-frames-form'));
  fieldset.appendChild(fragment);
  var blob = document.createElement('iframe');
  blob.src = URL.createObjectURL(new Blob([${JSON.stringify(blobHtml).replace(/</g, '\\u003c')}], { type: 'text/html' }));
  document.documentElement.appendChild(blob);
`;
// A frame the parser inserted, read as frames[i] by the next inline script.
const parserFramesScript = `
  window.__page.framesParser = Object.keys(frames[frames.length - 1].JSON.parse(${PLAYER_JSON})).sort();
`;
const escapeAttr = (html) => html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

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
           <script>addEventListener('message', (e) => { window.__embed = e.data; });</script>
           <script>${sameOriginFramesScript}</script>
           <iframe></iframe>
           <script>${parserFramesScript}</script>
           <iframe srcdoc="${escapeAttr(srcdocHtml)}"></iframe>`
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
                Boolean(
                  window.__page?.api && window.__embed?.api && window.__srcdoc && window.__blob
                ),
              n
            )
            .catch(() => false),
        { timeout: 15_000 }
      )
      .toBe(true);
    return guest.evaluate(() => ({
      page: window.__page,
      embed: window.__embed,
      srcdoc: window.__srcdoc,
      blob: window.__blob,
    }));
  };

  // 1. Blocking on: both frames see the player data without its ad fields —
  //    already in the synchronous inline script, i.e. before any page code ran.
  await go(visit(1));
  let guest = await guestPage();
  expect(await results(guest, 1)).toEqual({
    page: {
      initial: PRUNED,
      api: PRUNED,
      wallet: true,
      blank: PRUNED,
      blankDoc: PRUNED,
      blankNested: PRUNED,
      framesIndex: PRUNED,
      framesInnerHTML: PRUNED,
      framesPending: PRUNED,
      framesNested: PRUNED,
      framesTable: PRUNED,
      framesSelect: PRUNED,
      framesCustomElement: PRUNED,
      framesFormAssociated: PRUNED,
      framesFormDisabled: PRUNED,
      framesParser: PRUNED,
    },
    embed: { initial: PRUNED, api: PRUNED, wallet: false },
    srcdoc: PRUNED,
    blob: PRUNED,
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
    page: {
      initial: UNTOUCHED,
      api: UNTOUCHED,
      wallet: true,
      blank: UNTOUCHED,
      blankDoc: UNTOUCHED,
      blankNested: UNTOUCHED,
      framesIndex: UNTOUCHED,
      framesInnerHTML: UNTOUCHED,
      framesPending: UNTOUCHED,
      framesNested: UNTOUCHED,
      framesTable: UNTOUCHED,
      framesSelect: UNTOUCHED,
      framesCustomElement: UNTOUCHED,
      framesFormAssociated: UNTOUCHED,
      framesFormDisabled: UNTOUCHED,
      framesParser: UNTOUCHED,
    },
    embed: { initial: UNTOUCHED, api: UNTOUCHED, wallet: false },
    srcdoc: UNTOUCHED,
    blob: UNTOUCHED,
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
    page: {
      initial: UNTOUCHED,
      api: UNTOUCHED,
      wallet: true,
      blank: UNTOUCHED,
      blankDoc: UNTOUCHED,
      blankNested: UNTOUCHED,
      framesIndex: UNTOUCHED,
      framesInnerHTML: UNTOUCHED,
      framesPending: UNTOUCHED,
      framesNested: UNTOUCHED,
      framesTable: UNTOUCHED,
      framesSelect: UNTOUCHED,
      framesCustomElement: UNTOUCHED,
      framesFormAssociated: UNTOUCHED,
      framesFormDisabled: UNTOUCHED,
      framesParser: UNTOUCHED,
    },
    embed: { initial: UNTOUCHED, api: UNTOUCHED, wallet: false },
    srcdoc: UNTOUCHED,
    blob: UNTOUCHED,
  });

  // 4. Internal pages never even ask.
  await go('freedom://history');
  await expect
    .poll(() => electronApp.windows().some((p) => p.url().includes('/pages/history.html')))
    .toBe(true);
  expect((await askedUrls()).filter((url) => !/^https?:/.test(url))).toEqual([]);
});
