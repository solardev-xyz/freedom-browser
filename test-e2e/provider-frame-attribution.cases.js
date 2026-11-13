// Provider requests only count when the guest's main frame sent them
// (security audit O-6, #433).
//
// Tab webviews run with nodeIntegrationInSubFrames, so a compromised
// cross-origin iframe renderer still has ipcRenderer.sendToHost and can emit
// `dapp:provider-request` / `swarm:provider-request` /
// `radicle:provider-request` to the chrome. Since freedom-core design 0011
// (PRQ-9) every provider request goes from the top frame's preload to main,
// which refuses a sub-frame's itself, and the chrome has no provider route at
// all: such a message must do nothing, whichever frame it names.
//
// A real renderer compromise can't be staged from a test, so the forged
// message is injected where it would land: as an `ipc-message` event on the
// real <webview> element in the chrome, carrying the iframe's *real*
// [processId, routingId] as reported by the main process, and then the main
// frame's. The real top-frame providers (window.ethereum / window.swarm /
// window.radicle) are exercised end to end, through main.

// Not a spec file on its own (no `.spec.js` suffix, so the harness project's
// testMatch skips it): `onchain-apps.spec.js` requires it, which puts these
// tests in CI's curated `e2e-tabs` job without a `.github/workflows` edit.
// The describe block scopes the test.use / beforeEach below to these tests.
//
// Run just these tests with:
//   xvfb-run -a npx playwright test --project=harness test-e2e/onchain-apps.spec.js -g 'O-6'

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { approvalsPage, approvalsState, chromeWindowId, decideInPanel } = require('./approvals-fixtures');

const identity = require(path.join(__dirname, '..', 'test', 'legacy-identity'));

// Harness-served bzz:// content (http/https are stubbed out in test mode).
// Different hashes are different sites, so the iframe is out-of-process.
const DAPP_HASH = 'd'.repeat(64);
const DAPP_URL = `bzz://${DAPP_HASH}/`;
const FRAME_URL = `bzz://${'a'.repeat(64)}/frame`;
const VAULT_PASSWORD = 'provider-frame-e2e';

test.describe('provider frame attribution (O-6)', () => {
  test.use({
    seedSettings: {
      enableIdentityWallet: true,
      startAntAtLaunch: false,
      startIpfsAtLaunch: false,
      startRadicleAtLaunch: false,
    },
  });

  // A real vault on disk, so the app boots past onboarding and the dApp connect
  // prompt has an account to offer.
  test.beforeEach(async ({ userDataDir }) => {
    const identityDir = path.join(userDataDir, 'identity');
    fs.mkdirSync(identityDir, { recursive: true });
    const mnemonic = await identity.createVault(identityDir, VAULT_PASSWORD);
    const keys = identity.deriveAllKeys(mnemonic);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({ addresses: { userWallet: keys.userWallet.address }, activeWalletIndex: 0 }),
      'utf-8'
    );
  });

  /** Run a script in the active tab's top frame. */
  function inPage(win, script) {
    return win.evaluate(async (js) => {
      const wv = document.querySelector('webview:not(.hidden)');
      return wv.executeJavaScript(js);
    }, script);
  }

  /** [processId, routingId] of the active tab's main frame and of its iframe. */
  async function frameIds(win, electronApp) {
    const webContentsId = await win.evaluate(() =>
      document.querySelector('webview:not(.hidden)').getWebContentsId()
    );
    return electronApp.evaluate(({ webContents }, { id, frameUrl }) => {
      const main = webContents.fromId(id).mainFrame;
      const sub = main.frames.find((frame) => frame.url === frameUrl);
      return {
        main: [main.processId, main.routingId],
        sub: sub ? [sub.processId, sub.routingId] : null,
      };
    }, { id: webContentsId, frameUrl: FRAME_URL });
  }

  /** Inject a provider request as an `ipc-message` from the given frame. */
  function injectRequest(win, channel, frameId, request) {
    return win.evaluate(({ channel: ch, frameId: fid, request: req }) => {
      const wv = document.querySelector('webview:not(.hidden)');
      const event = new Event('ipc-message');
      Object.assign(event, { channel: ch, frameId: fid, args: [req] });
      wv.dispatchEvent(event);
    }, { channel, frameId, request });
  }

  // Replace main's provider execute handlers with recorders: the harness runs
  // no Ant node and no Radicle addon, and what matters here is whether the
  // chrome forwarded a request at all. The Swarm permission-manifest lookup
  // also needs a node, so main's own (PRQ-7b) reports "no manifest" (legacy
  // per-capability prompts). A publish goes to main (PRQ-7c), which uploads
  // it to a fake Ant here, answering every upload with one reference.
  async function recordProviderExecutes(electronApp) {
    await electronApp.evaluate(async (_electron, root) => {
      const load = process.mainModule.require;
      const http = load('http');
      const ant = http.createServer((req, res) => {
        const json = (body) => {
          res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && req.url === '/stamps') {
          return json({ stamps: [{ batchID: 'e2'.repeat(32), utilization: 0, usable: true, label: 'e2e', depth: 24, amount: '100000000000', bucketDepth: 16, blockNumber: 1, immutableFlag: true, batchTTL: 365 * 24 * 3600 }] });
        }
        if (req.method === 'POST' && req.url.startsWith('/bzz')) {
          req.resume();
          req.on('end', () => json({ reference: 'ab'.repeat(32) }));
          return undefined;
        }
        res.writeHead(404);
        return res.end();
      });
      await new Promise((resolve) => ant.listen(0, '127.0.0.1', resolve));
      globalThis.__attributionAnt = ant;
      load(`${root}/src/main/service-registry`).updateService('ant', { api: `http://127.0.0.1:${ant.address().port}` });
      load(`${root}/src/main/swarm/publish-setup-service`).getPublishSetupService().getPublishReadiness = async () => ({ ok: true });
      const calls = [];
      globalThis.__providerExecuteCalls = calls;
      process.mainModule.require(`${root}/src/main/swarm/permission-manifests`).checkPageManifest = async () => ({
        kind: 'legacy',
        reason: 'e2e',
      });
      // All of window.swarm (PRQ-7d) and window.radicle (PRQ-8c) is main's:
      // the chrome has no route left to record.
    }, path.resolve(__dirname, '..'));
  }

  const executeCalls = (electronApp) =>
    electronApp.evaluate(() => globalThis.__providerExecuteCalls.slice());

  async function openDapp(win, harness) {
    await harness.setContentFixture(DAPP_URL, {
      contentType: 'text/html; charset=utf-8',
      body:
        '<!doctype html><title>frame attribution dapp</title><h1>dApp top frame</h1>' +
        `<iframe src="${FRAME_URL}" width="300" height="80"></iframe>`,
    });
    await harness.setContentFixture(FRAME_URL, {
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><p>third-party iframe</p>',
    });
    const input = win.locator('[data-test="address-input"]');
    await input.click();
    await input.fill(DAPP_URL);
    await input.press('Enter');
    await expect
      .poll(
        () =>
          inPage(
            win,
            'Boolean(window.ethereum?.request && window.swarm?.request && window.radicle?.request) && document.querySelector("iframe")?.contentDocument === null'
          ).catch(() => false),
        { timeout: 20_000 }
      )
      .toBe(true);
  }

  test('top-frame providers still work; forged sub-frame requests are ignored', async ({
    window: win,
    electronApp,
    harness,
  }) => {
    test.setTimeout(120_000);
    await recordProviderExecutes(electronApp);
    await openDapp(win, harness);

    const ids = await frameIds(win, electronApp);
    expect(ids.sub, 'the cross-site iframe committed').not.toBeNull();
    expect(ids.sub).not.toEqual(ids.main);

    // --- Forged requests from the iframe: nothing happens ---------------------
    // The prompts show in the window's approvals panel (design 0011, APS-2):
    // main shows none for a forged request.
    const windowId = await chromeWindowId(electronApp);
    const panel = await approvalsPage(electronApp);
    const panelShows = async () => (await approvalsState(electronApp))[windowId]?.shown ?? null;

    // One provider at a time, as a prompt for each would be shown in turn.
    const forged = [
      ['dapp:provider-request', { id: 9001, method: 'eth_requestAccounts', params: [] }],
      ['swarm:provider-request', { id: 9002, method: 'swarm_requestAccess', params: {} }],
      ['radicle:provider-request', { id: 9003, method: 'radicle_requestAccess', params: {} }],
    ];
    for (const [channel, request] of forged) {
      await injectRequest(win, channel, ids.sub, request);
      // Give a (wrongly) accepted request ample time to raise its prompt.
      await win.waitForTimeout(1000);
      expect(await panelShows(), channel).toBeNull();
      expect(await executeCalls(electronApp), channel).toEqual([]);
    }
    await win.screenshot({ path: path.join(test.info().outputDir, 'subframe-ignored.png') });

    // --- The same injection from the main frame: the chrome has no route ----
    // (PRQ-9). A page's requests reach main only through its preload.
    for (const [channel, request] of forged) {
      await injectRequest(win, channel, ids.main, { ...request, id: request.id + 100 });
      await win.waitForTimeout(1000);
      expect(await panelShows(), channel).toBeNull();
      expect(await executeCalls(electronApp), channel).toEqual([]);
    }

    // --- Real top-frame calls, end to end -------------------------------------
    // window.ethereum: request + connect.
    expect(await inPage(win, 'window.ethereum.request({ method: "eth_chainId" })')).toMatch(/^0x[0-9a-f]+$/);
    await inPage(win, `window.__accounts = window.ethereum.request({ method: 'eth_requestAccounts' }); 0`);
    await expect(panel.locator('#heading')).toHaveText('Connect', { timeout: 15_000 });
    await panel.screenshot({ path: path.join(test.info().outputDir, 'top-frame-dapp-connect.png') });
    await decideInPanel(electronApp, { panel, windowId });
    const accounts = await inPage(win, 'window.__accounts');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // window.swarm: connect + publish. Both go to main, which shows its own
    // prompts in the panel, writes the grant (freedom-core design 0011,
    // PRQ-7b) and publishes (PRQ-7c).
    await inPage(win, `window.__swarm = window.swarm.requestAccess(); 0`);
    await expect(panel.locator('#heading')).toHaveText('Swarm Access', { timeout: 15_000 });
    await decideInPanel(electronApp, { panel, windowId });
    expect(await inPage(win, 'window.__swarm.then((r) => JSON.stringify(r))')).toContain('connected');
    const swarmRecorded = await electronApp.evaluate(() =>
      globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.filter((e) => e.kind === 'recorded' && e.provider === 'swarm').map((e) => e.method)
    );
    expect(swarmRecorded).toContain('swarm_requestAccess');
    await inPage(
      win,
      `window.__published = window.swarm.request({ method: 'swarm_publishData', params: { data: 'hello', contentType: 'text/plain' } }); 0`
    );
    await expect(panel.locator('#heading')).toHaveText('Confirm Publish', { timeout: 15_000 });
    await panel.screenshot({ path: path.join(test.info().outputDir, 'top-frame-swarm-publish.png') });
    await decideInPanel(electronApp, { panel, windowId });
    expect(await inPage(win, 'window.__published.then((r) => JSON.stringify(r))')).toContain('abab');
    const swarmMain = await electronApp.evaluate(() =>
      globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.filter((e) => e.kind === 'recorded' && e.provider === 'swarm').map((e) => e.method)
    );
    expect(swarmMain).toContain('swarm_publishData');

    // window.radicle: connect.
    await inPage(win, `window.__radicle = window.radicle.requestAccess(); 0`);
    await expect(panel.locator('#heading')).toHaveText('Connect Radicle node?', { timeout: 15_000 });
    await decideInPanel(electronApp, { panel, windowId });
    expect(await inPage(win, 'window.__radicle.then((r) => JSON.stringify(r))')).toContain('connected');

    const calls = await executeCalls(electronApp);
    expect(calls.map((c) => c.method)).not.toContain('swarm_requestAccess');
    expect(calls.map((c) => c.method)).not.toContain('swarm_publishData');
    // window.radicle's connecting goes to main too (PRQ-8a), which shows
    // its prompt and writes its grant: the chrome's route sees none of it.
    expect(calls.map((c) => c.method)).not.toContain('radicle_requestAccess');
    const radicleMain = await electronApp.evaluate(() =>
      globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.filter((e) => e.kind === 'recorded' && e.provider === 'radicle').map((e) => e.method)
    );
    expect(radicleMain).toContain('radicle_requestAccess');
    // Every forwarded call ran under the top page's origin.
    expect(calls.every((c) => c.origin?.includes(DAPP_HASH))).toBe(true);

    // --- Now connected: a forged sub-frame request still gets nothing ----------
    // (with the grants in place it would otherwise be answered silently)
    const before = (await executeCalls(electronApp)).length;
    await injectRequest(win, 'swarm:provider-request', ids.sub, {
      id: 9005, method: 'swarm_publishData', params: { data: 'forged', contentType: 'text/plain' },
    });
    await injectRequest(win, 'radicle:provider-request', ids.sub, {
      id: 9006, method: 'radicle_getNodeStatus', params: {},
    });
    await win.waitForTimeout(1500);
    expect(await panelShows()).toBeNull();
    expect(await executeCalls(electronApp)).toHaveLength(before);
  });
});
