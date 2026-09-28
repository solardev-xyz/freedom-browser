// Provider requests only count when the guest's main frame sent them
// (security audit O-6, #433).
//
// Tab webviews run with nodeIntegrationInSubFrames, so a compromised
// cross-origin iframe renderer still has ipcRenderer.sendToHost and can emit
// `dapp:provider-request` / `swarm:provider-request` /
// `radicle:provider-request`. The chrome must not handle those under the tab's
// top page (its wallet, Swarm and Radicle grants).
//
// A real renderer compromise can't be staged from a test, so the forged
// message is injected where it would land: as an `ipc-message` event on the
// real <webview> element in the chrome, carrying the iframe's *real*
// [processId, routingId] as reported by the main process. A positive control
// sends the identical synthetic event with the main frame's pair and must
// raise the prompt, proving the injection path reaches the real listener.
// The real top-frame providers (window.ethereum / window.swarm /
// window.radicle) are exercised end to end first.

// Not a spec file on its own (no `.spec.js` suffix, so the harness project's
// testMatch skips it): `onchain-apps.spec.js` requires it, which puts these
// tests in CI's curated `e2e-tabs` job without a `.github/workflows` edit.
// These tests are the only check against the real Electron field names the
// guard reads (`ipc-message.frameId`, `did-frame-navigate`'s `isMainFrame` /
// `frameProcessId` / `frameRoutingId`). The unit tests feed synthetic events,
// so they would stay green if an Electron bump renamed any of those fields.
// The describe block scopes the test.use / beforeEach below to these tests.
//
// Run just these tests with:
//   xvfb-run -a npx playwright test --project=harness test-e2e/onchain-apps.spec.js -g 'O-6'

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const identity = require(path.join(__dirname, '..', 'src', 'main', 'identity'));

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
  // also needs a node, so it reports "no manifest" (legacy per-capability
  // prompts).
  async function recordProviderExecutes(electronApp) {
    await electronApp.evaluate(({ ipcMain }) => {
      const calls = [];
      globalThis.__providerExecuteCalls = calls;
      ipcMain.removeHandler('swarm:manifest-check');
      ipcMain.handle('swarm:manifest-check', () => ({ kind: 'legacy', reason: 'e2e' }));
      for (const channel of ['swarm:provider-execute', 'radicle:provider-execute']) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event, args) => {
          calls.push({ channel, method: args?.method, origin: args?.origin });
          if (args?.method === 'swarm_publishData') return { result: { reference: 'ab'.repeat(32) } };
          return { result: { connected: true, origin: args?.origin } };
        });
      }
    });
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
    const dappConnect = win.locator('#sidebar-dapp-connect');
    const swarmConnect = win.locator('#sidebar-swarm-connect');
    const radicleConsent = win.locator('#sidebar-radicle-consent');

    // One provider at a time: each prompt replaces the sidebar screen before
    // it, so a batch would only ever show the last one.
    const forged = [
      ['dapp:provider-request', { id: 9001, method: 'eth_requestAccounts', params: [] }],
      ['swarm:provider-request', { id: 9002, method: 'swarm_requestAccess', params: {} }],
      ['radicle:provider-request', { id: 9003, method: 'radicle_requestAccess', params: {} }],
    ];
    for (const [channel, request] of forged) {
      await injectRequest(win, channel, ids.sub, request);
      // Give a (wrongly) accepted request ample time to raise its prompt.
      await win.waitForTimeout(1000);
      await expect(dappConnect, channel).toBeHidden();
      await expect(swarmConnect, channel).toBeHidden();
      await expect(radicleConsent, channel).toBeHidden();
      expect(await executeCalls(electronApp), channel).toEqual([]);
    }
    await win.screenshot({ path: path.join(test.info().outputDir, 'subframe-ignored.png') });

    // --- Positive control: the same injection from the main frame is handled --
    await injectRequest(win, 'radicle:provider-request', ids.main, {
      id: 9004, method: 'radicle_requestAccess', params: {},
    });
    await expect(radicleConsent).toBeVisible();
    await win.click('#radicle-consent-reject');
    await expect(radicleConsent).toBeHidden();

    // --- Real top-frame calls, end to end -------------------------------------
    // window.ethereum: request + connect.
    expect(await inPage(win, 'window.ethereum.request({ method: "eth_chainId" })')).toMatch(/^0x[0-9a-f]+$/);
    await inPage(win, `window.__accounts = window.ethereum.request({ method: 'eth_requestAccounts' }); 0`);
    await expect(dappConnect).toBeVisible();
    await win.screenshot({ path: path.join(test.info().outputDir, 'top-frame-dapp-connect.png') });
    await win.click('#dapp-connect-approve');
    const accounts = await inPage(win, 'window.__accounts');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // window.swarm: connect + publish.
    await inPage(win, `window.__swarm = window.swarm.requestAccess(); 0`);
    await expect(swarmConnect).toBeVisible();
    await win.click('#swarm-connect-approve');
    await inPage(win, 'window.__swarm');
    await inPage(
      win,
      `window.__published = window.swarm.request({ method: 'swarm_publishData', params: { data: 'hello', contentType: 'text/plain' } }); 0`
    );
    const publishPrompt = win.locator('#sidebar-swarm-publish-approve');
    await expect(publishPrompt).toBeVisible();
    await win.screenshot({ path: path.join(test.info().outputDir, 'top-frame-swarm-publish.png') });
    await win.click('#swarm-publish-confirm');
    expect(await inPage(win, 'window.__published.then((r) => JSON.stringify(r))')).toContain('abab');

    // window.radicle: connect.
    await inPage(win, `window.__radicle = window.radicle.requestAccess(); 0`);
    await expect(radicleConsent).toBeVisible();
    await win.click('#radicle-consent-approve');
    expect(await inPage(win, 'window.__radicle.then((r) => JSON.stringify(r))')).toContain('connected');

    const calls = await executeCalls(electronApp);
    expect(calls.map((c) => `${c.channel} ${c.method}`)).toEqual(
      expect.arrayContaining([
        'swarm:provider-execute swarm_requestAccess',
        'swarm:provider-execute swarm_publishData',
        'radicle:provider-execute radicle_requestAccess',
      ])
    );
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
    await expect(publishPrompt).toBeHidden();
    expect(await executeCalls(electronApp)).toHaveLength(before);
  });
});
