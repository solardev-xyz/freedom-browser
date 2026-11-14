// window.radicle's reads, connecting and disconnecting through main, in real
// Electron (freedom-core design 0011, step PRQ-8a): the five methods go from
// the app's preload to main on `page:request`. Main shows the connection
// prompt (`radicle.connect`), which the window's approvals panel renders and
// answers by handle (design 0011, APS-2), writes the grant itself for the page's attested key,
// and sends `connect` and `disconnect` to the site's pages. The chrome's
// connection grant and its route for these methods are refused. The harness
// runs no Radicle node: the methods answer as they do while it is stopped.

const path = require('path');
const { test, expect } = require('./fixtures');
const { approvalsPage, approvalsState, chromeWindowId, decideInPanel } = require('./approvals-fixtures');

const repoRoot = path.resolve(__dirname, '..');

const DAPP = `bzz://${'e'.repeat(64)}`;

test.use({
  seedSettings: {
    enableIdentityWallet: true,
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
  },
});

// A page that records every Radicle event it hears.
const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__events = [];
    for (const name of ['connect', 'disconnect', 'seedStatus']) {
      window.radicle.on(name, (data) => window.__events.push([name, data]));
    }
  </script><h1>${title}</h1>`,
});

function inTab(win, url, script) {
  return win.evaluate(
    async ({ u, js }) => {
      const wv = [...document.querySelectorAll('webview')].find((w) => {
        try {
          return w.getURL().startsWith(u);
        } catch {
          return false;
        }
      });
      if (!wv) return { missing: true };
      try {
        return await wv.executeJavaScript(js);
      } catch (err) {
        return { thrown: String(err?.message || err) };
      }
    },
    { u: url, js: script }
  );
}

/** Start a page's Radicle request; its outcome lands in `window.__outcomes[name]`. */
const start = (win, url, name, method, params = {}) =>
  inTab(
    win,
    url,
    `window.__outcomes = window.__outcomes || {};
     window.radicle.request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })
       .then((ok) => { window.__outcomes[${JSON.stringify(name)}] = { ok }; },
             (e) => { window.__outcomes[${JSON.stringify(name)}] = { code: e?.code, message: String(e?.message || e), data: e?.data }; });
     0`
  );
const outcome = (win, url, name) => inTab(win, url, `(window.__outcomes || {})[${JSON.stringify(name)}] ?? null`);
const heard = (win, url) => inTab(win, url, 'window.__events');

const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());
const radicleGrant = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    const permission = process.mainModule.require(`${args.root}/src/main/radicle/radicle-permissions`).getPermission(args.key);
    return permission ? { origin: permission.origin, signing: permission.signing } : null;
  }, { root: repoRoot, key });

/** Count every Radicle request a page sends the chrome on the old path, in every tab. */
const watchOldPath = (win) =>
  win.evaluate(() => {
    window.__oldPath = window.__oldPath || [];
    for (const wv of document.querySelectorAll('webview')) {
      if (wv.__watched) continue;
      wv.__watched = true;
      wv.addEventListener('ipc-message', (event) => {
        if (event.channel === 'radicle:provider-request') window.__oldPath.push(event.args[0]?.method);
      });
    }
  });
const oldPath = (win) => win.evaluate(() => window.__oldPath.slice());

async function openIn(win, url, ready = url) {
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(url);
  await address.press('Enter');
  await expect
    .poll(() => inTab(win, ready, 'Boolean(window.radicle?.request) && Array.isArray(window.__events) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
}

test('reads, connecting and disconnecting through main: main\'s prompt in the sidebar, the grant written by main for the page\'s key, connect and disconnect from main, and the chrome\'s writes and route refused (0011 PRQ-8a)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('forge'));
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);

  // Not connected yet: the capabilities say so, and the node status is
  // refused.
  await start(win, DAPP, 'before', 'radicle_getCapabilities');
  await expect.poll(() => outcome(win, DAPP, 'before')).toMatchObject({ ok: { canUseNode: false, reason: 'not-connected' } });
  await start(win, DAPP, 'refused', 'radicle_getNodeStatus');
  await expect.poll(() => outcome(win, DAPP, 'refused')).toEqual({
    code: 4100,
    message: 'Origin not authorized. Call radicle_requestAccess first.',
  });

  await start(win, DAPP, 'access', 'radicle_requestAccess');
  const windowId = await chromeWindowId(electronApp);
  const panel = await approvalsPage(electronApp);
  await expect(panel.locator('#heading')).toHaveText('Connect Radicle node?', { timeout: 15_000 });
  // Main's site, as main attested it.
  await expect(panel.locator('#site')).toHaveText(DAPP);
  expect(await radicleGrant(electronApp, DAPP)).toBeNull();
  const prompted = (await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt');
  expect(prompted.map((e) => [e.payload.kind, e.payload.site])).toEqual([['radicle.connect', { key: DAPP, label: DAPP }]]);
  await panel.screenshot({ path: test.info().outputPath('page-radicle-connect-prompt.png') });
  await decideInPanel(electronApp, { panel, windowId });

  await expect.poll(() => outcome(win, DAPP, 'access')).toMatchObject({
    ok: { connected: true, origin: DAPP, capabilities: { specVersion: '0.2', canUseNode: false } },
  });
  await expect.poll(async () => (await approvalsState(electronApp))[windowId]?.shown ?? null).toBeNull();
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ origin: DAPP, signing: false });
  await expect.poll(() => heard(win, DAPP)).toEqual([['connect', { origin: DAPP }]]);

  // The reads answer under the page's key: the harness's node is stopped.
  await start(win, DAPP, 'status', 'radicle_getNodeStatus');
  await expect.poll(() => outcome(win, DAPP, 'status')).toEqual({ ok: { running: false, status: expect.any(String) } });
  await start(win, DAPP, 'capabilities', 'radicle_getCapabilities');
  await expect.poll(() => outcome(win, DAPP, 'capabilities')).toMatchObject({ ok: { canUseNode: false } });
  const served = (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.provider === 'radicle');
  expect(served.map((e) => e.method)).toEqual([
    'radicle_getCapabilities',
    'radicle_getNodeStatus',
    'radicle_requestAccess',
    'radicle_getNodeStatus',
    'radicle_getCapabilities',
  ]);

  // The chrome has no connection grant of its own (PRQ-9: its preload
  // exposes none, and main refuses the channel, radicle-provider-ipc tests)
  // and no route for a Radicle method (PRQ-8c).
  const forged = await win.evaluate(async () => ({
    grant: typeof window.radiclePermissions.grantPermission,
    route: typeof window.radicleProvider,
  }));
  expect(forged.grant).toBe('undefined');
  expect(forged.route).toBe('undefined');
  expect(await radicleGrant(electronApp, 'other.eth')).toBeNull();
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ origin: DAPP, signing: false });

  // The page gives up its access: main revokes it and tells the page.
  await start(win, DAPP, 'disconnect', 'radicle_disconnect');
  await expect.poll(() => outcome(win, DAPP, 'disconnect')).toEqual({ ok: { connected: false } });
  expect(await radicleGrant(electronApp, DAPP)).toBeNull();
  await expect.poll(() => heard(win, DAPP)).toEqual([
    ['connect', { origin: DAPP }],
    ['disconnect', { origin: DAPP }],
  ]);

  // Revoking from the chrome stays open, and main tells the site's page.
  // The identity core writes it (design 0012, APB-3), for the site's page.
  await electronApp.evaluate(async (_electron, args) => {
    await process.mainModule
      .require(`${args.root}/src/main/radicle/radicle-permissions`)
      .grantPermission(args.key, { page: { origin: args.key, top_origin: args.key, frame: 1, navigation: 1, agent: false } });
  }, { root: repoRoot, key: DAPP });
  expect(await win.evaluate((k) => window.radiclePermissions.revokePermission(k), DAPP)).toBe(true);
  await expect.poll(() => heard(win, DAPP)).toEqual([
    ['connect', { origin: DAPP }],
    ['disconnect', { origin: DAPP }],
    ['disconnect', { origin: DAPP }],
  ]);
  const sent = (await trace(electronApp)).filter((e) => e.kind === 'event-sent' && e.provider === 'radicle');
  expect(sent.map((e) => e.event)).toEqual(['connect', 'disconnect', 'disconnect']);
  expect(await oldPath(win)).toEqual([]);
});
