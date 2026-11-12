// window.radicle's signing through main, in real Electron (freedom-core
// design 0011, step PRQ-8c): `radicle_getIdentity` and the COB writes go
// from the app's preload to main on `page:request`, with every other
// window.radicle method. Main asks for the signing grant and for each write
// (`radicle.sign`), which the chrome renders in its sidebar and answers by
// handle, writes the grant and the "always allow writes" rule itself, and
// runs each write under its guard. The chrome has no Radicle route left,
// and its signing grant and rule writes are refused. The harness runs no
// Radicle node: main's real manager runs over the add-on's calls stubbed in
// main.

const path = require('path');
const { test, expect } = require('./fixtures');

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
    return load(`${root}/src/main/radicle-manager`).startRadicle();
  }, repoRoot);

const stopFakeRadicle = (electronApp) =>
  electronApp.evaluate(async (_electron, root) => {
    const fake = globalThis.__fakeRadicle;
    if (!fake) return;
    for (const finish of fake.state.finish) finish();
    await process.mainModule.require(`${root}/src/main/radicle-manager`).stopRadicle();
    Object.assign(fake.embedded, fake.saved);
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
async function approve(win, shot) {
  await win.waitForTimeout(600);
  if (shot) await win.screenshot({ path: test.info().outputPath(shot) });
  await win.locator('#radicle-consent-approve').click();
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
  await electronApp.evaluate((_electron, args) => {
    process.mainModule.require(`${args.root}/src/main/radicle/radicle-permissions`).grantPermission(args.key);
  }, { root: repoRoot, key: DAPP });
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);
  const consent = win.locator('#sidebar-radicle-consent');

  // The identity: main asks for the signing grant first.
  await start(win, DAPP, 'identity', 'radicle_getIdentity');
  await expect(consent).toBeVisible();
  await expect(win.locator('#radicle-consent-title')).toHaveText('Act as your Radicle identity?');
  await expect(win.locator('#radicle-consent-site')).toHaveText(DAPP);
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ signing: false, rule: false });
  await approve(win);
  await expect.poll(() => outcome(win, DAPP, 'identity')).toEqual({ ok: { did: 'did:key:z6MkE2e', nid: 'z6MkE2e', alias: 'e2e' } });
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ signing: true, rule: false });

  // A write: main's prompt shows exactly what it signs, and offers the rule.
  await start(win, DAPP, 'issue', 'radicle_createIssue', { rid: RID.slice(4), title: 'Bug', description: 'Steps', labels: ['ui'] });
  await expect(consent).toBeVisible();
  await expect(win.locator('#radicle-consent-title')).toHaveText('Open this issue as you?');
  await expect(win.locator('#radicle-consent-allows li')).toHaveText(['Title: Bug', 'Description: Steps', 'Label: ui']);
  await expect(win.locator('#radicle-consent-always-row')).toBeVisible();
  const prompted = (await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt');
  expect(prompted.map((e) => [e.payload.kind, e.payload.view])).toEqual([
    ['radicle.sign', { mode: 'grant', method: 'radicle_getIdentity' }],
    ['radicle.sign', { mode: 'write', method: 'radicle_createIssue', rid: RID, title: 'Bug', description: 'Steps', labels: ['ui'], agentHeld: false, alwaysAllow: false }],
  ]);
  expect(await signedWrites(electronApp)).toEqual([]);
  await win.waitForTimeout(600);
  await win.locator('#radicle-consent-always').check();
  await win.screenshot({ path: test.info().outputPath('page-radicle-sign-prompt.png') });
  await win.locator('#radicle-consent-approve').click();
  await expect.poll(() => outcome(win, DAPP, 'issue')).toEqual({ ok: { id: 'c'.repeat(40) } });
  expect(await signedWrites(electronApp)).toEqual([['createIssue', RID, 'Bug', 'Steps', ['ui']]]);
  expect(await radicleGrant(electronApp, DAPP)).toEqual({ signing: true, rule: true });

  // The rule, written by main, answers the next write with no prompt.
  await start(win, DAPP, 'comment', 'radicle_commentIssue', { rid: RID, issueId: 'a'.repeat(40), body: 'Same here' });
  await expect.poll(() => outcome(win, DAPP, 'comment')).toEqual({ ok: { id: 'c'.repeat(40) } });
  await expect(consent).toBeHidden();
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
