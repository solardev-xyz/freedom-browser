// window.radicle's seeding through main, in real Electron (freedom-core
// design 0011, step PRQ-8b): `radicle_seed`, `radicle_unseed`, `radicle_sync`
// and `radicle_getSeedStatus` go from the app's preload to main on
// `page:request`. Main shows the node prompt (`radicle.node`), which the
// window's approvals panel renders and answers by handle (design 0011,
// APS-2), runs each node action
// under its guard, and sends `seedStatus` to the site's page. The chrome
// can't turn the node rule on, and its route refuses these methods. The
// harness runs no Radicle node: main's real manager runs over the add-on's
// calls stubbed in main (the rollback, FREEDOM_RADICLE_BACKEND=addon, under
// freedom-radicled's hold-lock), whose clone a test finishes by hand.

const path = require('path');
const { test, expect } = require('./fixtures');
const { approvalsPage, approvalsState, chromeWindowId, decideInPanel } = require('./approvals-fixtures');

const repoRoot = path.resolve(__dirname, '..');

const DAPP = `bzz://${'f'.repeat(64)}`;
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

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

/** Main's Radicle manager, started over the add-on's calls stubbed in main. */
const startFakeRadicle = (electronApp) =>
  electronApp.evaluate(async (_electron, root) => {
    const load = process.mainModule.require;
    const embedded = load(`${root}/src/main/radicle-embedded`);
    const state = { clones: [], unseeded: [], seeded: [], finish: [] };
    const saved = {};
    const patch = (name, fn) => {
      saved[name] = embedded[name];
      embedded[name] = fn;
    };
    let started = false;
    patch('isAvailable', () => true);
    patch('isStarted', () => started);
    patch('start', async () => {
      started = true;
      return { did: 'did:key:z6MkE2e' };
    });
    patch('shutdown', async () => {
      started = false;
      return { ok: true };
    });
    patch('connectSeeds', async () => ({ connected: 0, target: 0, targetReached: true }));
    // The clone writes the seeding policy as it starts, as the native one
    // does, and finishes when a test says so.
    patch('cloneRepoWithProgress', (rid, _timeout, onProgress) =>
      new Promise((resolve) => {
        state.clones.push(rid);
        if (!state.seeded.includes(rid)) state.seeded.push(rid);
        onProgress({ phase: 'connecting', nid: 'z6MkPeer' });
        state.finish.push(() => resolve({ ok: true }));
      })
    );
    patch('cancelClone', async () => ({ cancelled: true }));
    patch('unseedRepo', async (rid) => {
      state.unseeded.push(rid);
      state.seeded = state.seeded.filter((r) => r !== rid);
      return { unseeded: true };
    });
    patch('listSeededRepos', async () => state.seeded.map((rid) => ({ rid })));
    patch('seeders', async () => ({ seeding: 2 }));
    patch('repoInfo', async () => {
      throw new Error('not found');
    });
    patch('status', async () => ({ connectedPeers: 1 }));
    patch('listRepos', async () => []);
    patch('identity', async () => ({ did: 'did:key:z6MkE2e', nid: 'z6MkE2e', alias: 'e2e' }));
    globalThis.__fakeRadicle = { state, saved, embedded };
    // The add-on, development builds' rollback (FREEDOM_RADICLE_BACKEND=addon),
    // runs the stubbed node: under freedom-radicled's hold-lock (the job
    // downloads it), on a home with the key file the core writes for a vault
    // (radicle/radicled-gate.js, addonHomeRefusal).
    process.env.FREEDOM_RADICLE_BACKEND = 'addon';
    const fs = load('fs');
    const path = load('path');
    const home = await load(`${root}/src/main/profile-paths`).prepareRadicleDataDir();
    const keys = path.join(home, 'keys');
    if (!fs.existsSync(path.join(keys, 'radicle'))) {
      fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(keys, 'radicle'), 'e2e key', { mode: 0o600 });
    }
    return load(`${root}/src/main/radicle-manager`).startRadicle();
  }, repoRoot);

const stopFakeRadicle = (electronApp) =>
  electronApp.evaluate(async (_electron, root) => {
    const fake = globalThis.__fakeRadicle;
    if (!fake) return;
    for (const finish of fake.state.finish) finish();
    await process.mainModule.require(`${root}/src/main/radicle-manager`).stopRadicle();
    Object.assign(fake.embedded, fake.saved);
    delete process.env.FREEDOM_RADICLE_BACKEND;
    globalThis.__fakeRadicle = null;
  }, repoRoot);

const radicleState = (electronApp) =>
  electronApp.evaluate(() => {
    const { clones, unseeded, seeded } = globalThis.__fakeRadicle.state;
    return { clones: clones.slice(), unseeded: unseeded.slice(), seeded: seeded.slice() };
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
const seedStates = (win, url) =>
  inTab(win, url, `window.__events.filter(([e]) => e === 'seedStatus').map(([, d]) => d.rid + ' ' + d.state)`);

const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());

/** Count every Radicle request a page sends the chrome on the old path. The chrome has no relay for main's events (PRQ-8c). */
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
const oldPath = (win) => win.evaluate(() => ({ requests: window.__oldPath.slice(), relay: typeof window.radicleProvider }));

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

// Past the prompt's input-protection window (and the sidebar's slide-in,
// for the evidence shot), then the button.
// The window's approvals panel: its prompt approved there, once main's
// delay has passed.
async function approve(electronApp, shot) {
  const panel = await approvalsPage(electronApp);
  if (shot) await panel.screenshot({ path: test.info().outputPath(shot) });
  await decideInPanel(electronApp, { panel });
}
const panelShows = async (electronApp) =>
  (await approvalsState(electronApp))[await chromeWindowId(electronApp)]?.shown ?? null;

test.afterEach(async ({ electronApp }) => {
  await stopFakeRadicle(electronApp);
});

test('seeding through main: main\'s node prompt in the sidebar, each node action under main\'s guard, seedStatus from main, and the chrome\'s node rule and route refused (0011 PRQ-8b)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('forge'));
  expect(await startFakeRadicle(electronApp)).toMatchObject({ status: 'running' });
  // Connected already, as main writes a connection.
  // The identity core writes it (design 0012, APB-3), for the site's page.
  await electronApp.evaluate(async (_electron, args) => {
    await process.mainModule
      .require(`${args.root}/src/main/radicle/radicle-permissions`)
      .grantPermission(args.key, { page: { origin: args.key, top_origin: args.key, frame: 1, navigation: 1, agent: false } });
  }, { root: repoRoot, key: DAPP });
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);

  // A seed: main's prompt, with the repository main checked.
  await start(win, DAPP, 'seed', 'radicle_seed', { rid: RID.slice(4) });
  const panel = await approvalsPage(electronApp);
  await expect(panel.locator('#heading')).toHaveText('Seed this repository?', { timeout: 15_000 });
  await expect(panel.locator('#site')).toHaveText(DAPP);
  await expect(panel.locator('#body')).toContainText('asks your node to seed this repository');
  await expect(panel.locator('#body')).toContainText(`Repository${RID}`);
  const prompted = (await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt');
  expect(prompted.map((e) => [e.payload.kind, e.payload.view])).toEqual([['radicle.node', { method: 'radicle_seed', rid: RID }]]);
  expect((await radicleState(electronApp)).clones).toEqual([]);
  await approve(electronApp, 'page-radicle-seed-prompt.png');

  await expect.poll(() => outcome(win, DAPP, 'seed')).toMatchObject({
    ok: { rid: RID, seeded: true, status: { rid: RID, state: 'fetching' } },
  });
  await expect.poll(() => panelShows(electronApp)).toBeNull();
  expect((await radicleState(electronApp)).clones).toEqual([RID]);
  // The fetch's statuses reach the page from main; then the clone finishes.
  await expect.poll(() => seedStates(win, DAPP)).toContain(`${RID} fetching`);
  await electronApp.evaluate(() => globalThis.__fakeRadicle.state.finish.shift()());
  await expect.poll(() => seedStates(win, DAPP)).toContain(`${RID} fetched`);

  // A sync restarts the seeded repository's fetch, with no prompt.
  await start(win, DAPP, 'sync', 'radicle_sync', { rid: RID });
  await expect.poll(() => outcome(win, DAPP, 'sync')).toMatchObject({ ok: { rid: RID, status: { state: 'fetching' } } });
  expect((await radicleState(electronApp)).clones).toEqual([RID, RID]);
  await start(win, DAPP, 'status', 'radicle_getSeedStatus', { rid: RID });
  await expect.poll(() => outcome(win, DAPP, 'status')).toMatchObject({ ok: { rid: RID, state: 'fetching' } });
  await electronApp.evaluate(() => globalThis.__fakeRadicle.state.finish.shift()());

  // An unseed: main's prompt again.
  await start(win, DAPP, 'unseed', 'radicle_unseed', { rid: RID });
  await expect(panel.locator('#heading')).toHaveText('Stop seeding this repository?', { timeout: 15_000 });
  await approve(electronApp);
  await expect.poll(() => outcome(win, DAPP, 'unseed')).toEqual({ ok: { rid: RID, seeded: false } });
  expect((await radicleState(electronApp)).unseeded).toContain(RID);

  const served = (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.provider === 'radicle');
  expect(served.map((e) => e.method)).toEqual(['radicle_seed', 'radicle_sync', 'radicle_getSeedStatus', 'radicle_unseed']);
  const sent = (await trace(electronApp)).filter((e) => e.kind === 'event-sent' && e.provider === 'radicle');
  expect(new Set(sent.map((e) => e.event))).toEqual(new Set(['seedStatus']));

  // The chrome can't turn the node rule on, and has no route for seeding.
  const forged = await win.evaluate(async (key) => {
    const tryIt = (fn) => fn().then((value) => ({ value }), (err) => String(err?.message || err));
    return {
      rule: await tryIt(() => window.radiclePermissions.setAutoApprove(key, 'node', true)),
      off: await tryIt(() => window.radiclePermissions.setAutoApprove(key, 'node', false)),
    };
  }, DAPP);
  expect(forged.rule).toContain('Radicle node auto-approve can only be turned off here');
  expect(forged.off).toEqual({ value: true });
  expect((await radicleState(electronApp)).clones).toEqual([RID, RID]);
  // Nothing went through the chrome: no request, and no relay left.
  expect(await oldPath(win)).toEqual({ requests: [], relay: 'undefined' });
});
