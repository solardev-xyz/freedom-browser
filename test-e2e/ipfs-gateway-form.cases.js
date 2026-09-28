// Gateway-form `ipfs:` URLs must not run content under the gateway host's
// shared origin (security audit O-3, #430). `ipfs://localhost/ipfs/<cidA>/`
// and `ipfs://localhost/ipfs/<cidB>/` used to both commit on the
// `ipfs://localhost` origin, so every CID loaded that way shared one
// localStorage. The renderer rewrites address-bar input (PR #352), but an
// `<iframe src>` never passes through it — that is the hole this spec pins.
//
// The harness stubs the `ipfs:`/`ipns:` schemes with fixture handlers that
// bypass `ipfs-protocol.js` entirely, so this spec puts the *real*
// `handleRequest` back on the default session and only swaps its native
// gateway call (`requestImpl`) for an in-memory file map. Everything between
// the page and that map — Chromium's frame loading, redirect following,
// origin assignment, storage partitioning — is the real thing.
//
// Deliberately NOT a `.spec.js`: CI runs a curated spec list per job, and a
// new spec file only runs once someone adds it to `.github/workflows/ci.yml`
// (the #319 lesson). These tests are declared by `address-bar.spec.js`, which
// the `e2e-address-bar-ens` job already runs, so they run wherever that spec
// does — `ipfs-gateway-form-wiring.test.js` pins that chain. They sit in
// their own `test.describe` so the `test.use`/`beforeEach` below stay scoped
// to them and never touch the address-bar tests.

const { test, expect } = require('./fixtures');

const cid = (c) => `bafybeib${c.repeat(51)}`;
const PARENT = cid('p');
const CID_A = cid('a');
const CID_B = cid('b');
const CID_C = cid('c');
const CID_IMG = cid('i');
const CID_JSON = cid('j');
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';

// A 1x1 transparent PNG.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Each frame claims a shared key, then reports what that key holds when
// asked. If the two frames share one origin, the later writer wins and the
// earlier frame reports the other frame's CID.
const frameHtml = (ref) =>
  '<!doctype html><meta charset="utf-8"><body style="font:14px sans-serif;margin:4px">' +
  `<b>${ref.slice(0, 12)}…</b><div id="o"></div><script>` +
  `localStorage.setItem('owner', ${JSON.stringify(ref)});` +
  "document.getElementById('o').textContent = 'origin: ' + location.origin;" +
  "addEventListener('message', (e) => { if (e.data !== 'report') return;" +
  ' parent.postMessage({ ref: ' +
  JSON.stringify(ref) +
  ", origin: location.origin, owner: localStorage.getItem('owner') }, '*'); });" +
  '</script></body>';

const PARENT_HTML =
  '<!doctype html><meta charset="utf-8"><title>gateway-form parent</title>' +
  '<body style="font:14px sans-serif"><h1>parent</h1>' +
  '<script>window.__reports = [];' +
  "addEventListener('message', (e) => window.__reports.push(e.data));" +
  'window.__fetched = null;' +
  `fetch('ipfs://localhost/ipfs/${CID_JSON}/data.json').then((r) => r.text())` +
  '.then((t) => { window.__fetched = t; }, (e) => { window.__fetched = "error: " + e; });' +
  '</script>' +
  `<iframe id="a" style="width:560px;height:70px" src="ipfs://localhost/ipfs/${CID_A}/"></iframe><br>` +
  `<iframe id="b" style="width:560px;height:70px" src="ipfs://localhost/ipfs/${CID_B}/"></iframe><br>` +
  `<iframe id="c" style="width:560px;height:70px" src="ipfs://127.0.0.1:8080/ipfs/${CID_C}/"></iframe><br>` +
  `<img id="img" src="ipfs://localhost/ipfs/${CID_IMG}/pixel.png">` +
  `<p><a id="gw-link" href="ipfs://localhost/ipfs/${CID_A}/">gateway-form link</a></p></body>`;

const FILES = {
  [`/ipfs/${PARENT}/`]: { body: PARENT_HTML, type: 'text/html; charset=utf-8' },
  [`/ipfs/${CID_A}/`]: { body: frameHtml(CID_A), type: 'text/html; charset=utf-8' },
  [`/ipfs/${CID_B}/`]: { body: frameHtml(CID_B), type: 'text/html; charset=utf-8' },
  [`/ipfs/${CID_C}/`]: { body: frameHtml(CID_C), type: 'text/html; charset=utf-8' },
  [`/ipfs/${CID_IMG}/pixel.png`]: { body: PIXEL_PNG, b64: true, type: 'image/png' },
  [`/ipfs/${CID_JSON}/data.json`]: { body: '{"ok":true}', type: 'application/json' },
  [`/ipns/${IPNS_KEY}/`]: {
    body: '<!doctype html><title>ipns page</title><h1>ipns page</h1>',
    type: 'text/html; charset=utf-8',
  },
};

const installRealIpfsHandler = (electronApp) =>
  electronApp.evaluate(({ session }, files) => {
    const load = process.mainModule.require.bind(process.mainModule);
    const { handleRequest } = load('./src/main/ipfs/ipfs-protocol');
    globalThis.__gwHits = [];
    const requestImpl = async ({ path, method }) => {
      globalThis.__gwHits.push(path);
      const file = files[path];
      if (!file) return new Response('not found', { status: 404 });
      const body = file.b64 ? Buffer.from(file.body, 'base64') : file.body;
      return new Response(method === 'HEAD' ? null : body, {
        status: 200,
        headers: { 'content-type': file.type, 'access-control-allow-origin': '*' },
      });
    };
    for (const scheme of ['ipfs', 'ipns']) {
      session.defaultSession.protocol.unhandle(scheme);
      session.defaultSession.protocol.handle(scheme, (request) =>
        handleRequest(scheme, request, { requestImpl })
      );
    }
  }, FILES);

const inGuest = (window, source) =>
  window.evaluate(async (js) => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    if (!wv?.executeJavaScript) return null;
    try {
      return await wv.executeJavaScript(js, true);
    } catch {
      return null;
    }
  }, source);

const webviewUrl = (window) =>
  window.evaluate(() => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    return wv?.getURL?.() || '';
  });

const navigateTo = async (window, value) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(value);
  await input.press('Enter');
};

test.describe('gateway-form ipfs: URLs (O-3)', () => {
  // Bookmarks bar visible on every page, so an old bookmark can be clicked.
  test.use({ seedSettings: { showBookmarkBar: true } });

  test.beforeEach(async ({ electronApp, window }) => {
    // `window` first: the harness registers its stub schemes during app
    // startup, and they have to exist before they can be swapped out.
    await window.waitForSelector('[data-test="address-input"]');
    await installRealIpfsHandler(electronApp);
  });

  test('gateway-form iframes land on their own canonical origins and do not share storage', async ({
    window,
  }, testInfo) => {
    await navigateTo(window, `ipfs://${PARENT}/`);
    await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe(`ipfs://${PARENT}/`);

    const askFrames =
      `(() => { for (const f of document.querySelectorAll('iframe'))` +
      ` f.contentWindow.postMessage('report', '*'); return true; })()`;
    await expect
      .poll(
        async () => {
          await inGuest(window, 'window.__reports.length = 0');
          await inGuest(window, askFrames);
          await new Promise((r) => setTimeout(r, 200));
          return (await inGuest(window, 'window.__reports.length')) || 0;
        },
        { timeout: 15_000 }
      )
      .toBe(3);

    const reports = await inGuest(window, 'window.__reports');
    const byRef = Object.fromEntries(reports.map((r) => [r.ref, r]));
    // A and B sit behind the same gateway host. Without the fix both commit
    // on `ipfs://localhost` and whichever wrote last owns the other's storage.
    // Checked first, so a regression reports the storage leak itself.
    expect(byRef[CID_A].owner).toBe(CID_A);
    expect(byRef[CID_B].owner).toBe(CID_B);
    expect(byRef[CID_C].owner).toBe(CID_C);
    // Each frame committed on its canonical per-CID origin, not the gateway's.
    expect(byRef[CID_A].origin).toBe(`ipfs://${CID_A}`);
    expect(byRef[CID_B].origin).toBe(`ipfs://${CID_B}`);
    expect(byRef[CID_C].origin).toBe(`ipfs://${CID_C}`);

    // Sub-resources on a gateway-form URL still load (through the redirect).
    await expect
      .poll(() => inGuest(window, "document.getElementById('img').naturalWidth"), {
        timeout: 10_000,
      })
      .toBe(1);
    await expect
      .poll(() => inGuest(window, 'window.__fetched'), { timeout: 10_000 })
      .toBe('{"ok":true}');

    await window.screenshot({ path: testInfo.outputPath('gateway-form-iframes.png') });
  });

  test('a gateway-form link clicked inside a page commits on the canonical origin', async ({
    window,
  }) => {
    await navigateTo(window, `ipfs://${PARENT}/`);
    await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe(`ipfs://${PARENT}/`);
    await expect
      .poll(() => inGuest(window, "!!document.getElementById('gw-link')"), { timeout: 10_000 })
      .toBe(true);
    await inGuest(window, "document.getElementById('gw-link').click()");
    await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe(`ipfs://${CID_A}/`);
    await expect
      .poll(() => inGuest(window, 'location.origin'), { timeout: 10_000 })
      .toBe(`ipfs://${CID_A}`);
  });

  test('canonical ipfs:// and ipns:// URLs and old gateway-form bookmarks still load', async ({
    window,
  }, testInfo) => {
    const address = window.locator('[data-test="address-input"]');

    await navigateTo(window, `ipns://${IPNS_KEY}/`);
    await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe(`ipns://${IPNS_KEY}/`);
    await expect
      .poll(() => inGuest(window, 'document.title'), { timeout: 10_000 })
      .toBe('ipns page');

    // An old bookmark saved in gateway form (Kubo dir-listing link shape).
    const gatewayBookmark = `ipfs://localhost:8080/ipfs/${CID_A}/`;
    await window.evaluate(
      (target) => window.electronAPI.addBookmark({ label: 'Old gateway bookmark', target }),
      gatewayBookmark
    );
    // The bar reads bookmarks at init; there is no change broadcast.
    await window.reload();
    await window.waitForSelector('[data-test="address-input"]');
    const item = window.locator(
      `[data-test="bookmarks-bar"] [data-test="bookmark-item"][data-hash="${gatewayBookmark}"]`
    );
    await expect(item).toBeVisible();
    await item.click();
    await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe(`ipfs://${CID_A}/`);
    await expect(address).toHaveValue(`ipfs://${CID_A}/`);
    await expect
      .poll(() => inGuest(window, 'location.origin'), { timeout: 10_000 })
      .toBe(`ipfs://${CID_A}`);
    await window.screenshot({ path: testInfo.outputPath('gateway-form-bookmark.png') });
  });
});
