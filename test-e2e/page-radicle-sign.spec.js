// window.radicle's signing through main, in real Electron (freedom-core
// design 0011, step PRQ-8c): `radicle_getIdentity` and the COB writes go
// from the app's preload to main on `page:request`, with every other
// window.radicle method. Main asks for the signing grant and for each write
// (`radicle.sign`), which the window's approvals panel renders and answers
// by handle (design 0011, APS-2), writes the grant and the "always allow writes" rule itself, and
// runs each write under its guard. The chrome has no Radicle route left,
// and its signing grant and rule writes are refused. The harness runs no
// Radicle node: main's real manager runs over the add-on's calls stubbed in
// main (the rollback, FREEDOM_RADICLE_BACKEND=addon, under freedom-radicled's
// hold-lock).

const path = require('path');
const { test, expect } = require('./fixtures');
const { approvalsPage, approvalsState, chromeWindowId, decideInPanel } = require('./approvals-fixtures');

const repoRoot = path.resolve(__dirname, '..');

const DAPP = `bzz://${'c'.repeat(64)}`;
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
    // The add-on's signed writes, which it signs and publishes in one call.
    state.writes = [];
    for (const name of ['createIssue', 'commentIssue', 'editIssueState', 'commentPatch']) {
      patch(name, async (...args) => {
        state.writes.push([name, ...args]);
        return { id: 'c'.repeat(40) };
      });
    }
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

const signedWrites = (electronApp) => electronApp.evaluate(() => globalThis.__fakeRadicle.state.writes.slice());
const radicleGrant = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    const permission = process.mainModule.require(`${args.root}/src/main/radicle/radicle-permissions`).getPermission(args.key);
    return permission ? { signing: permission.signing, rule: permission.autoApprove?.signing === true } : null;
  }, { root: repoRoot, key });

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
async function approve(electronApp, shot, check = []) {
  const panel = await approvalsPage(electronApp);
  if (shot) await panel.screenshot({ path: test.info().outputPath(shot) });
  await decideInPanel(electronApp, { check, panel });
}

test.afterEach(async ({ electronApp }) => {
  await stopFakeRadicle(electronApp);
});

test('signing through main: main\'s grant and per-write prompts in the sidebar, the grant and the rule written by main, each write under main\'s guard, and no Radicle route or grant write left to the chrome (0011 PRQ-8c)', async ({
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
  const windowId = await chromeWindowId(electronApp);
  const panel = await approvalsPage(electronApp);
  const panelShows = async () => (await approvalsState(electronApp))[windowId]?.shown ?? null;

  // The identity: main asks for the signing grant first.
  await start(win, DAPP, 'identity', 'radicle_getIdentity');
  await expect(panel.locator('#heading')).toHaveText('Act as your Radicle identity?', { timeout: 15_000 });
  await expect(panel.locator('#site')).toHaveText(DAPP);
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ signing: false, rule: false });
  await approve(electronApp);
  await expect.poll(() => outcome(win, DAPP, 'identity')).toEqual({ ok: { did: 'did:key:z6MkE2e', nid: 'z6MkE2e', alias: 'e2e' } });
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ signing: true, rule: false });

  // A write: main's prompt shows exactly what it signs, and offers the rule.
  await start(win, DAPP, 'issue', 'radicle_createIssue', { rid: RID.slice(4), title: 'Bug', description: 'Steps', labels: ['ui'] });
  await expect(panel.locator('#heading')).toHaveText('Open this issue as you?', { timeout: 15_000 });
  for (const line of ['TitleBug', 'DescriptionSteps', 'Labelui']) await expect(panel.locator('#body')).toContainText(line);
  const ALWAYS = 'Always allow this site to write as you without asking (at most 50 writes a day)';
  await expect(panel.getByLabel(ALWAYS)).toBeVisible();
  const prompted = (await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt');
  expect(prompted.map((e) => [e.payload.kind, e.payload.view])).toEqual([
    ['radicle.sign', { mode: 'grant', method: 'radicle_getIdentity' }],
    ['radicle.sign', { mode: 'write', method: 'radicle_createIssue', rid: RID, title: 'Bug', description: 'Steps', labels: ['ui'], agentHeld: false, alwaysAllow: false }],
  ]);
  expect(await signedWrites(electronApp)).toEqual([]);
  await approve(electronApp, 'page-radicle-sign-prompt.png', [ALWAYS]);
  await expect.poll(() => outcome(win, DAPP, 'issue')).toEqual({ ok: { id: 'c'.repeat(40) } });
  expect(await signedWrites(electronApp)).toEqual([['createIssue', RID, 'Bug', 'Steps', ['ui']]]);
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ signing: true, rule: true });

  // The rule, written by main, answers the next write with no prompt.
  await start(win, DAPP, 'comment', 'radicle_commentIssue', { rid: RID, issueId: 'a'.repeat(40), body: 'Same here' });
  await expect.poll(() => outcome(win, DAPP, 'comment')).toEqual({ ok: { id: 'c'.repeat(40) } });
  await expect.poll(panelShows).toBeNull();
  expect((await signedWrites(electronApp)).map(([name]) => name)).toEqual(['createIssue', 'commentIssue']);

  const served = (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.provider === 'radicle');
  expect(served.map((e) => e.method)).toEqual(['radicle_getIdentity', 'radicle_createIssue', 'radicle_commentIssue']);

  // The chrome has no Radicle route, can't grant signing or turn the rule
  // on, and may still turn the rule off.
  const forged = await win.evaluate(async (key) => {
    const tryIt = (fn) => fn().then((value) => ({ value }), (err) => String(err?.message || err));
    return {
      route: typeof window.radicleProvider,
      grant: typeof window.radiclePermissions.grantSigning,
      rule: await tryIt(() => window.radiclePermissions.setAutoApprove('other.eth', 'signing', true)),
      off: await tryIt(() => window.radiclePermissions.setAutoApprove(key, 'signing', false)),
    };
  }, DAPP);
  expect(forged.route).toBe('undefined');
  // PRQ-9: no signing grant in the chrome's preload; main refuses the
  // channel too (radicle-provider-ipc tests).
  expect(forged.grant).toBe('undefined');
  expect(forged.rule).toContain('Radicle signing auto-approve is turned on only from a write prompt');
  expect(forged.off).toEqual({ value: true });
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ signing: true, rule: false });
  expect(await radicleGrant(electronApp, 'other.eth')).toBeNull();
  expect(await oldPath(win)).toEqual({ requests: [], relay: 'undefined' });
});
