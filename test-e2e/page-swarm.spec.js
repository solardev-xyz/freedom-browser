// window.swarm's reads through main, in real Electron (freedom-core design
// 0011, step PRQ-7a): `swarm_getCapabilities`, `swarm_readChunk`,
// `swarm_readData`, `swarm_readSingleOwnerChunk`, `swarm_readFeedEntry` and
// `swarm_listFeeds` go from the app's preload to main on `page:request`, and
// main serves them with `executeSwarmMethod` under the requester's attested
// key: the answers main gives for that key, read off a node (a fake Ant here,
// the harness runs none). The chrome's old path sees none of them, and its
// own route (`swarm:provider-execute`) refuses them, whatever site it names.
// A DNS name over IPNS keeps its feed records through main's name binding
// until the name moves off its IPNS key; the permission-free reads answer on
// with no resolution.

const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

const DAPP = `bzz://${'d'.repeat(64)}`;
const KEYLESS = 'data:text/html,<!doctype html><title>keyless</title><h1>keyless</h1>';
const NAME = 'example.com';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } };

test.use({
  seedSettings: {
    enableIdentityWallet: true,
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
    enableRadicleIntegration: false,
  },
});

const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><h1>${title}</h1>`,
});

/**
 * A fake Ant in main: `/node` answers, and `/chunks/<ref>` serves one real
 * content-addressed chunk. Returns the chunk's reference and payload.
 */
const startFakeAnt = (electronApp) =>
  electronApp.evaluate(async (_electron, root) => {
    const load = process.mainModule.require;
    const http = load('http');
    const { Bee } = load(`${root}/node_modules/@ethersphere/bee-js`);
    const payload = 'hello from a swarm chunk';
    const chunk = new Bee('http://127.0.0.1:1633').makeContentAddressedChunk(new TextEncoder().encode(payload));
    const reference = chunk.address.toHex();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/node') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ beeMode: 'light' }));
      }
      if (req.method === 'GET' && url.pathname === `/chunks/${reference}`) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(Buffer.from(chunk.data));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    globalThis.__fakeAnt = server;
    load(`${root}/src/main/service-registry`).updateService('ant', { api: `http://127.0.0.1:${server.address().port}` });
    return { reference, payload };
  }, repoRoot);

const stopFakeAnt = (electronApp) => electronApp.evaluate(() => globalThis.__fakeAnt?.close());

// A site's feed records, written in main as createFeed writes them.
const seedFeeds = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    const store = process.mainModule.require(`${args.root}/src/main/swarm/feed-store`);
    store.setOriginEntry(args.key, { identityMode: 'app-scoped', feedGranted: true });
    store.setFeed(args.key, 'chat', { topic: 't'.repeat(64), owner: `0x${'ab'.repeat(20)}`, manifestReference: 'e'.repeat(64) });
  }, { root: repoRoot, key });

/** What main itself answers for `key`: executeSwarmMethod, as the dispatcher calls it. */
const mainAnswer = (electronApp, method, params, key) =>
  electronApp.evaluate(async (_electron, args) => {
    const { executeSwarmMethod } = process.mainModule.require(`${args.root}/src/main/swarm/swarm-provider-ipc`);
    const out = await executeSwarmMethod(args.method, args.params, args.key);
    return out.error ? { code: out.error.code, message: out.error.message, data: out.error.data } : { ok: out.result };
  }, { root: repoRoot, method, params, key });

const clearReadBudgets = (electronApp) =>
  electronApp.evaluate((_electron, root) => {
    process.mainModule.require(`${root}/src/main/swarm/swarm-provider-ipc`).clearPermissionFreeReadBudgets();
  }, repoRoot);

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

/** A page's Swarm request, as the page sees its outcome. */
const ask = (win, url, method, params = {}) =>
  inTab(
    win,
    url,
    `window.swarm.request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })
      .then((ok) => ({ ok }), (e) => ({ code: e?.code, message: String(e?.message || e), data: e?.data }))`
  );

/** The webview that shows `url` (a prefix of its URL), or null. */
const guestOf = (win, url) =>
  win.evaluate((u) => {
    const wv = [...document.querySelectorAll('webview')].find((w) => {
      try {
        return w.getURL().startsWith(u);
      } catch {
        return false;
      }
    });
    return wv ? wv.getWebContentsId() : null;
  }, url);

const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());

/** Count every Swarm request a page sends the chrome on the old path, in every tab. */
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

async function openIn(win, url, ready = url) {
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(url);
  await address.press('Enter');
  await expect
    .poll(() => inTab(win, ready, 'Boolean(window.swarm?.request) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
}

async function newTab(win, electronApp, url, ready = url) {
  const before = new Set(await win.evaluate(() => [...document.querySelectorAll('webview')].map((w) => w.getWebContentsId())));
  await win.locator('[data-test="new-tab-btn"]').click();
  let id = null;
  await expect
    .poll(async () => {
      id = await win.evaluate(() => document.querySelector('webview:not(.hidden)')?.getWebContentsId() ?? null);
      return id !== null && !before.has(id);
    })
    .toBe(true);
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id, url });
  await expect
    .poll(() => inTab(win, ready, 'Boolean(window.swarm?.request) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
  return id;
}

test.afterEach(async ({ electronApp }) => {
  await stopFakeAnt(electronApp);
});

test('Swarm\'s reads go to main, under the page\'s attested key, and the chrome\'s route refuses them (0011 PRQ-7a)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  const { reference, payload } = await startFakeAnt(electronApp);
  await seedFeeds(electronApp, DAPP);

  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);

  // A real chunk off the node, with no grant.
  const chunk = await ask(win, DAPP, 'swarm_readChunk', { reference });
  expect(chunk).toEqual({ ok: { data: Buffer.from(payload).toString('base64'), encoding: 'base64', span: payload.length } });
  // The page's own feed records, read under its key.
  const feeds = await ask(win, DAPP, 'swarm_listFeeds');
  expect(feeds.ok).toEqual([expect.objectContaining({ name: 'chat', topic: 't'.repeat(64), bzzUrl: `bzz://${'e'.repeat(64)}` })]);
  // Each of the six answers what main answers for this page's key, from the
  // same node and records (a fresh read budget each).
  const calls = [
    ['swarm_getCapabilities', {}],
    ['swarm_readChunk', { reference }],
    ['swarm_readChunk', { reference: 'f'.repeat(64) }],
    ['swarm_readData', { reference: 'f'.repeat(64) }],
    ['swarm_readSingleOwnerChunk', { address: 'f'.repeat(64) }],
    ['swarm_readFeedEntry', { name: 'chat' }],
    ['swarm_readFeedEntry', { name: 'missing' }],
    ['swarm_listFeeds', {}],
  ];
  for (const [method, params] of calls) {
    await clearReadBudgets(electronApp);
    const expected = await mainAnswer(electronApp, method, params, DAPP);
    await clearReadBudgets(electronApp);
    expect({ method, params, answer: await ask(win, DAPP, method, params) }).toEqual({ method, params, answer: expected });
  }

  // A keyless page reads chunks, and is refused what uses a key.
  const keylessId = await newTab(win, electronApp, KEYLESS, 'data:');
  await watchOldPath(win);
  expect((await ask(win, 'data:', 'swarm_readChunk', { reference })).ok).toEqual(chunk.ok);
  for (const method of ['swarm_getCapabilities', 'swarm_listFeeds', 'swarm_readFeedEntry']) {
    expect({ method, answer: await ask(win, 'data:', method, { name: 'chat' }) }).toEqual({ method, answer: NO_ADDRESS });
  }

  // Main answered every one, for the guest that asked; the chrome's old path
  // saw none.
  const recorded = (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.provider === 'swarm');
  const byGuest = (id) => [...new Set(recorded.filter((e) => e.guest === id).map((e) => e.method))].sort();
  expect(byGuest(await guestOf(win, DAPP))).toEqual(
    ['swarm_getCapabilities', 'swarm_listFeeds', 'swarm_readChunk', 'swarm_readData', 'swarm_readFeedEntry', 'swarm_readSingleOwnerChunk']
  );
  expect(byGuest(keylessId)).toEqual(['swarm_getCapabilities', 'swarm_listFeeds', 'swarm_readChunk', 'swarm_readFeedEntry']);
  expect(await oldPath(win)).toEqual([]);

  // A forged chrome origin: the chrome's own route refuses each of them, for
  // the page's key and for any other, and runs nothing.
  const forged = await win.evaluate(async (key) => {
    const out = [];
    for (const method of ['swarm_listFeeds', 'swarm_readFeedEntry', 'swarm_getCapabilities', 'swarm_readChunk']) {
      for (const origin of [key, 'other.eth']) {
        out.push(await window.swarmProvider.execute(method, { name: 'chat', reference: 'f'.repeat(64) }, origin));
      }
    }
    return out;
  }, DAPP);
  expect(forged).toHaveLength(8);
  for (const answer of forged) {
    expect(answer).toEqual({
      error: { code: 4100, message: 'The origin is not authorized for this operation', data: { reason: 'page_request_only' } },
    });
  }
  await win.screenshot({ path: test.info().outputPath('page-swarm-reads.png') });
});

test('a DNS name over IPNS: its feed records answer until the name moves off its key, then nothing; the reads answer with no resolution (0011 PRQ-7a)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  const { reference } = await startFakeAnt(electronApp);
  // Main resolves the bound name itself; the harness stands in for ENS.
  await electronApp.evaluate((_electron, args) => {
    globalThis.__names = { [args.name]: args.key };
    globalThis.__resolved = [];
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setResolveName(async (name) => {
      globalThis.__resolved.push(name);
      const decoded = globalThis.__names[name];
      return decoded ? { type: 'ok', protocol: 'ipns', decoded } : { type: 'not_found' };
    });
  }, { name: NAME, key: IPNS_KEY });
  // The chrome's own resolution, which loads the key.
  await harness.setEnsFixture(NAME, {
    type: 'ok',
    name: NAME,
    protocol: 'ipns',
    decoded: IPNS_KEY,
    uri: `ipns://${IPNS_KEY}`,
    trust: { level: 'verified', queried: ['a.test', 'b.test'], agreed: ['a.test', 'b.test'] },
  });
  await harness.setContentFixture(`ipns://${IPNS_KEY}/`, page('named'));
  // The name's feed records, kept under the name.
  await seedFeeds(electronApp, NAME);

  await openIn(win, `ens://${NAME}`, `ipns://${IPNS_KEY}`);
  await watchOldPath(win);
  const guest = await guestOf(win, `ipns://${IPNS_KEY}`);
  expect((await trace(electronApp)).filter((e) => e.kind === 'bind-name' && e.guest === guest).map((e) => e.ok)).toContain(true);
  const url = `ipns://${IPNS_KEY}`;
  const resolved = () => electronApp.evaluate(() => globalThis.__resolved.slice());

  expect((await ask(win, url, 'swarm_listFeeds')).ok).toEqual([expect.objectContaining({ name: 'chat' })]);
  expect(await resolved()).toContain(NAME);

  // The name moves to other content.
  await electronApp.evaluate((_electron, key) => {
    globalThis.__names['example.com'] = key;
    globalThis.__resolved = [];
  }, OTHER_IPNS_KEY);

  // The permission-free reads answer on, resolving nothing.
  expect((await ask(win, url, 'swarm_readChunk', { reference })).ok).toMatchObject({ encoding: 'base64' });
  expect(await resolved()).toEqual([]);

  // listFeeds checks the name, finds it moved, and reads nothing.
  expect(await ask(win, url, 'swarm_listFeeds')).toEqual(NO_ADDRESS);
  expect(await resolved()).toEqual([NAME]);
  // The binding has ended: the page is keyless now, and resolves nothing.
  expect(await ask(win, url, 'swarm_readFeedEntry', { name: 'chat' })).toEqual(NO_ADDRESS);
  expect(await ask(win, url, 'swarm_getCapabilities')).toEqual(NO_ADDRESS);
  expect((await ask(win, url, 'swarm_readChunk', { reference })).ok).toMatchObject({ encoding: 'base64' });
  expect(await resolved()).toEqual([NAME]);
  expect(await oldPath(win)).toEqual([]);
});
