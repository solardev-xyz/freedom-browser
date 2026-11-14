// window.swarm's feeds and signing through main, in real Electron
// (freedom-core design 0011, step PRQ-7d): `swarm_getSigningIdentity` and
// `swarm_writeSingleOwnerChunk` (and the feed methods beside them) go from
// the app's preload to main on `page:request`. Main unlocks a locked vault
// on its own prompt (`vault.unlock`), then shows the feed prompt
// (`swarm.feed`) with the site's publisher identities and their owners,
// which the window's approvals panel renders and answers by handle with the
// identity the user picked (design 0011, APS-2). Main makes that identity the site's, grants feed
// access and sets the rule itself, and the identity core signs. With 7d all
// of window.swarm is main's: the chrome's route, its manifest check and
// decide, and its rule and feed-grant writes are gone or refused.
//
// The harness runs no node: a fake Ant in main takes the single-owner chunk
// upload and answers with the chunk's address, as the node does.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('./fixtures');
const { approvalsPage, approvalsState, chromeWindowId, decideInPanel } = require('./approvals-fixtures');
const { closeApp } = require('./close-app');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Page-Swarm-Feeds-2026!';
const DAPP = `bzz://${'d'.repeat(64)}`;
const IDENTIFIER = 'c1'.repeat(32);

const test = base.extend({
  // The base app plus a vault with one account, locked at start.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-page-swarm-feeds-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const identityDir = path.join(tmpRoot, 'identity');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        enableIdentityWallet: true,
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableRadicleIntegration: false,
      }),
      'utf-8'
    );
    const mnemonic = await identity.createVault(identityDir, VAULT_PASSWORD);
    const keys = identity.deriveAllKeys(mnemonic);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({
        addresses: { userWallet: keys.userWallet.address },
        activeWalletIndex: 0,
        derivedWallets: [{ index: 0, name: 'Main Wallet', address: keys.userWallet.address }],
      }),
      'utf-8'
    );
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_IDENTITY_DATA: identityDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });
    await use(app);
    await closeApp(app);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },
});

const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__outcomes = {};
    window.__start = (name, method, params) => {
      delete window.__outcomes[name];
      window.swarm.request({ method, params }).then(
        (ok) => { window.__outcomes[name] = { ok }; },
        (e) => { window.__outcomes[name] = { code: e?.code, message: String(e?.message || e), data: e?.data }; }
      );
      return 0;
    };
  </script><h1>${title}</h1>`,
});

/**
 * A fake Ant in main: `/node`, `/stamps` (one usable batch), and a
 * single-owner chunk's upload (`POST /soc/<owner>/<identifier>`), answered
 * with its address, keccak256(identifier ‖ owner), as the node does.
 */
const startFakeAnt = (electronApp) =>
  electronApp.evaluate(async (_electron, root) => {
    const load = process.mainModule.require;
    const http = load('http');
    const { keccak256, concat } = load(`${root}/node_modules/ethers`);
    const state = { socs: [] };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && url.pathname === '/node') return json(200, { beeMode: 'light' });
      if (req.method === 'GET' && url.pathname === '/stamps') {
        return json(200, {
          stamps: [{ batchID: 'e2'.repeat(32), utilization: 0, usable: true, label: 'e2e', depth: 24, amount: '100000000000', bucketDepth: 16, blockNumber: 1, immutableFlag: true, batchTTL: 365 * 24 * 3600 }],
        });
      }
      const soc = /^\/soc\/([0-9a-f]{40})\/([0-9a-f]{64})$/.exec(url.pathname);
      if (req.method === 'POST' && soc) {
        req.resume();
        req.on('end', () => {
          state.socs.push({ owner: soc[1], identifier: soc[2], signed: url.searchParams.has('sig') });
          json(201, { reference: keccak256(concat([`0x${soc[2]}`, `0x${soc[1]}`])).slice(2) });
        });
        return undefined;
      }
      return json(404, { code: 404, message: 'Not Found' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    globalThis.__fakeAnt = { server, state };
    load(`${root}/src/main/service-registry`).updateService('ant', { api: `http://127.0.0.1:${server.address().port}` });
    const setup = load(`${root}/src/main/swarm/publish-setup-service`).getPublishSetupService();
    setup.getPublishReadiness = async () => ({ ok: true });
  }, repoRoot);

const stopFakeAnt = (electronApp) => electronApp.evaluate(() => globalThis.__fakeAnt?.server.close());

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

const start = (win, url, name, method, params = {}) =>
  inTab(win, url, `window.__start(${JSON.stringify(name)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
const outcome = (win, url, name) => inTab(win, url, `window.__outcomes[${JSON.stringify(name)}] ?? null`);
const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());
const promptsOf = async (electronApp, kind) =>
  (await trace(electronApp))
    .filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt' && e.payload.kind === kind)
    .map((e) => e.payload);

/** The site's grants and identity, as main holds them. */
const siteState = (electronApp, key) =>
  electronApp.evaluate(async (_electron, args) => {
    const load = process.mainModule.require;
    const permissions = load(`${args.root}/src/main/swarm/swarm-permissions`);
    const feeds = load(`${args.root}/src/main/swarm/feed-store`);
    const permission = permissions.getPermission(args.key);
    const entry = feeds.getOriginEntry(args.key);
    return {
      autoApprove: permission?.autoApprove || null,
      feedGranted: feeds.hasFeedGrant(args.key),
      activeIdentityId: entry?.activeIdentityId || null,
    };
  }, { root: repoRoot, key });

const watchOldPath = (win) =>
  win.evaluate(() => {
    window.__oldPath = window.__oldPath || [];
    for (const wv of document.querySelectorAll('webview')) {
      if (wv.__watched) continue;
      wv.__watched = true;
      wv.addEventListener('ipc-message', (event) => {
        if (event.channel === 'swarm:provider-request') window.__oldPath.push(event.args[0]?.method);
      });
    }
  });
const oldPath = (win) => win.evaluate(() => window.__oldPath.slice());

async function openIn(win, url) {
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(url);
  await address.press('Enter');
  await expect
    .poll(() => inTab(win, url, 'Boolean(window.swarm?.request) && typeof window.__start === "function" && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
}

test.afterEach(async ({ electronApp }) => {
  await stopFakeAnt(electronApp);
});

test('feeds and signing through main: the vault unlocked on main\'s prompt, the feed prompt with main\'s identities, the pick and the rule written by main, the identity core\'s signature, and no Swarm route left in the chrome (0011 PRQ-7d)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  await startFakeAnt(electronApp);
  // Connected already, as main writes a connection.
  // The identity core writes it (design 0012, APB-3), for the site's page.
  await electronApp.evaluate(async (_electron, args) => {
    await process.mainModule
      .require(`${args.root}/src/main/swarm/swarm-permissions`)
      .grantPermission(args.key, { page: { origin: args.key, top_origin: args.key, frame: 1, navigation: 1, agent: false } });
  }, { root: repoRoot, key: DAPP });
  await win.evaluate(() => window.identity.lock());
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);

  // The signing identity: the vault first, on main's own prompt.
  const windowId = await chromeWindowId(electronApp);
  const panel = await approvalsPage(electronApp);
  await start(win, DAPP, 'identity', 'swarm_getSigningIdentity');
  await expect(panel.locator('#heading')).toHaveText('Unlock Vault', { timeout: 15_000 });
  await expect(panel.locator('#site')).toHaveText(DAPP);
  expect((await promptsOf(electronApp, 'vault.unlock')).map((p) => [p.site, p.view])).toEqual([
    [{ key: DAPP, label: DAPP }, { reason: 'signing' }],
  ]);
  await decideInPanel(electronApp, { password: VAULT_PASSWORD, panel, windowId });

  // Then the feed prompt, with main's identities and their owners.
  await expect(panel.locator('#heading')).toHaveText('Publisher Signing', { timeout: 15_000 });
  await expect(panel.locator('#site')).toHaveText(DAPP);
  await expect(panel.locator('#body input[type="password"]')).toHaveCount(0);
  const [feedPrompt] = await promptsOf(electronApp, 'swarm.feed');
  const owner0 = await electronApp.evaluate(async (_electron, root) =>
    process.mainModule.require(`${root}/src/main/identity-manager`).getPublisherAddress(0), repoRoot);
  expect(feedPrompt.view).toMatchObject({
    method: 'swarm_getSigningIdentity',
    mode: 'signing',
    newIdentity: { id: 'app-scoped:0', mode: 'app-scoped', owner: owner0, stored: false },
    activeIdentityId: 'app-scoped:0',
  });
  expect(feedPrompt.view.identities.map((i) => [i.id, typeof i.owner])).toEqual([['bee-wallet', 'string']]);
  expect(await siteState(electronApp, DAPP)).toMatchObject({ feedGranted: false, activeIdentityId: null });
  await panel.screenshot({ path: test.info().outputPath('page-swarm-feed-prompt.png') });
  await decideInPanel(electronApp, {
    check: ['Always allow this site to use this publisher identity without asking'],
    panel,
    windowId,
  });

  await expect.poll(() => outcome(win, DAPP, 'identity'), { timeout: 15_000 }).toEqual({
    ok: { owner: owner0, identityMode: 'app-scoped' },
  });
  await expect.poll(async () => (await approvalsState(electronApp))[windowId]?.shown ?? null).toBeNull();
  expect(await siteState(electronApp, DAPP)).toMatchObject({
    feedGranted: true,
    activeIdentityId: 'app-scoped:0',
    autoApprove: { signing: true, feeds: false },
  });

  // The signing rule, read by main, answers a single-owner chunk: the
  // identity core signs, and the chunk goes to the node.
  await start(win, DAPP, 'soc', 'swarm_writeSingleOwnerChunk', { identifier: IDENTIFIER, data: 'signed by the core' });
  await expect.poll(() => outcome(win, DAPP, 'soc'), { timeout: 15_000 }).toMatchObject({
    ok: { identifier: IDENTIFIER, owner: owner0, reference: expect.stringMatching(/^[0-9a-f]{64}$/) },
  });
  expect(await electronApp.evaluate(() => globalThis.__fakeAnt.state.socs)).toEqual([
    { owner: owner0.slice(2).toLowerCase(), identifier: IDENTIFIER, signed: true },
  ]);
  expect(await promptsOf(electronApp, 'swarm.feed')).toHaveLength(1);

  // The chrome has no route and writes no Swarm grant.
  const forged = await win.evaluate(async (key) => {
    const tryIt = (fn) => Promise.resolve().then(fn).then((v) => ({ value: v ?? null }), (err) => ({ refused: String(err?.message || err) }));
    return {
      route: typeof window.swarmProvider,
      check: typeof window.swarmManifest?.check,
      decide: typeof window.swarmManifest?.decide,
      feedsRule: await tryIt(() => window.swarmPermissions.setAutoApprove(key, 'feeds', true)),
      // PRQ-9: no feed grant in the chrome's preload; main refuses the
      // channel too (feed-store.test.js).
      feedGrant: typeof window.swarmFeedStore.setFeedIdentity,
      off: await tryIt(() => window.swarmPermissions.setAutoApprove(key, 'signing', false)),
    };
  }, DAPP);
  expect(forged).toEqual({
    route: 'undefined',
    check: 'undefined',
    decide: 'undefined',
    feedsRule: { refused: expect.stringContaining('Feed auto-approve is turned on only from a feed prompt') },
    feedGrant: 'undefined',
    off: { value: true },
  });
  expect(await siteState(electronApp, DAPP)).toMatchObject({ autoApprove: { signing: false, feeds: false } });
  expect(await siteState(electronApp, 'other.eth')).toMatchObject({ feedGranted: false, autoApprove: null });
  expect(await oldPath(win)).toEqual([]);
});
