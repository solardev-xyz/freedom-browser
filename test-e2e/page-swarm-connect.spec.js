// window.swarm's connecting and messaging through main, in real Electron
// (freedom-core design 0011, step PRQ-7b): `swarm_requestAccess` and the
// messaging methods go from the app's preload to main on `page:request`.
// Main shows their prompts (`swarm.connect`, `swarm.messaging`), which the
// chrome renders in its sidebar and answers by handle, writes the grants
// itself for the page's attested key, and sends `connect`, `disconnect` and
// a subscription's `message` to the page's own document. The chrome's grant
// writes are refused. A subscription ends with its document. The harness
// runs no node: a fake Ant in main answers `/node` and serves the PSS
// subscription socket.

const path = require('path');
const { test, expect } = require('./fixtures');

const repoRoot = path.resolve(__dirname, '..');

const DAPP = `bzz://${'d'.repeat(64)}`;

test.use({
  seedSettings: {
    enableIdentityWallet: true,
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
    enableRadicleIntegration: false,
  },
});

// A page that records every Swarm event it hears.
const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__events = [];
    for (const name of ['connect', 'disconnect', 'message']) {
      window.swarm.on(name, (data) => window.__events.push([name, data]));
    }
  </script><h1>${title}</h1>`,
});

/** A fake Ant in main: `/node`, and the PSS subscription socket, which a test can send on. */
const startFakeAnt = (electronApp) =>
  electronApp.evaluate(async (_electron, root) => {
    const load = process.mainModule.require;
    const http = load('http');
    const { WebSocketServer } = load(`${root}/node_modules/ws`);
    const state = { sockets: [], closed: [] };
    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/node') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ beeMode: 'light' }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
    });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/pss/subscribe/')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        state.sockets.push({ path: req.url, ws });
        ws.on('close', () => state.closed.push(req.url));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    globalThis.__fakeAnt = { server, wss, state };
    load(`${root}/src/main/service-registry`).updateService('ant', { api: `http://127.0.0.1:${server.address().port}` });
  }, repoRoot);

const stopFakeAnt = (electronApp) =>
  electronApp.evaluate(() => {
    const ant = globalThis.__fakeAnt;
    if (!ant) return;
    for (const { ws } of ant.state.sockets) ws.terminate();
    ant.wss.close();
    ant.server.close();
  });

const antState = (electronApp) =>
  electronApp.evaluate(() => ({
    open: globalThis.__fakeAnt.state.sockets.filter(({ ws }) => ws.readyState === 1).map(({ path: p }) => p),
    closed: globalThis.__fakeAnt.state.closed.slice(),
  }));

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

/** Start a page's Swarm request; its outcome lands in `window.__outcomes[name]`. */
const start = (win, url, name, method, params = {}) =>
  inTab(
    win,
    url,
    `window.__outcomes = window.__outcomes || {};
     window.swarm.request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })
       .then((ok) => { window.__outcomes[${JSON.stringify(name)}] = { ok }; },
             (e) => { window.__outcomes[${JSON.stringify(name)}] = { code: e?.code, message: String(e?.message || e), data: e?.data }; });
     0`
  );
const outcome = (win, url, name) => inTab(win, url, `(window.__outcomes || {})[${JSON.stringify(name)}] ?? null`);
const heard = (win, url) => inTab(win, url, 'window.__events');

const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());
const swarmGrant = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    const permissions = process.mainModule.require(`${args.root}/src/main/swarm/swarm-permissions`);
    const permission = permissions.getPermission(args.key);
    return permission ? { messaging: Boolean(permission.messaging), autoApprove: permission.autoApprove } : null;
  }, { root: repoRoot, key });

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
    .poll(() => inTab(win, ready, 'Boolean(window.swarm?.request) && Array.isArray(window.__events) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
}

// Past the prompt's input-protection window (and the sidebar's slide-in,
// for the evidence shot), then the button.
async function approve(win, selector, shot) {
  await win.waitForTimeout(600);
  if (shot) await win.screenshot({ path: test.info().outputPath(shot) });
  await win.locator(selector).click();
}

test.afterEach(async ({ electronApp }) => {
  await stopFakeAnt(electronApp);
});

test('connecting through main: main\'s prompt in the sidebar, the grant written by main for the page\'s key, connect from main, and the chrome\'s writes refused (0011 PRQ-7b)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  await startFakeAnt(electronApp);
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);

  await start(win, DAPP, 'access', 'swarm_requestAccess');
  const connectScreen = win.locator('#sidebar-swarm-connect');
  await expect(connectScreen).toBeVisible();
  // Main's site, as main attested it.
  await expect(win.locator('#swarm-connect-site')).toHaveText(DAPP);
  expect(await swarmGrant(electronApp, DAPP)).toBeNull();
  const prompted = (await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt');
  expect(prompted.map((e) => [e.payload.kind, e.payload.site])).toEqual([['swarm.connect', { key: DAPP, label: DAPP }]]);
  await approve(win, '#swarm-connect-approve', 'page-swarm-connect-prompt.png');

  await expect.poll(() => outcome(win, DAPP, 'access')).toEqual({
    ok: { connected: true, origin: DAPP, capabilities: ['publish'] },
  });
  await expect(connectScreen).toBeHidden();
  expect(await swarmGrant(electronApp, DAPP)).toMatchObject({ messaging: false });
  await expect.poll(() => heard(win, DAPP)).toEqual([['connect', { origin: DAPP }]]);

  // The chrome has no grant write of its own (PRQ-9: its preload exposes
  // none, and main refuses the channels, swarm-permissions.test.js), and
  // turning a rule on is refused, for any site.
  const forged = await win.evaluate(async (key) => {
    const tryIt = (fn) => fn().then(() => 'accepted', (err) => String(err?.message || err));
    return {
      grant: typeof window.swarmPermissions.grantPermission,
      messaging: typeof window.swarmPermissions.grantMessaging,
      rule: await tryIt(() => window.swarmPermissions.setAutoApprove(key, 'messaging', true)),
    };
  }, DAPP);
  expect(forged.grant).toBe('undefined');
  expect(forged.messaging).toBe('undefined');
  expect(forged.rule).toContain('Messaging auto-approve is turned on only from a messaging prompt');
  expect(await swarmGrant(electronApp, 'other.eth')).toBeNull();
  expect(await swarmGrant(electronApp, DAPP)).toMatchObject({ messaging: false, autoApprove: { messaging: false } });
  expect(await oldPath(win)).toEqual([]);
});

test('messaging through main: the messaging prompt, a subscription\'s message to its own document, the subscription ending with it, and disconnect from main (0011 PRQ-7b)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  await startFakeAnt(electronApp);
  // Connected already, as main writes a connection.
  await electronApp.evaluate((_electron, args) => {
    process.mainModule.require(`${args.root}/src/main/swarm/swarm-permissions`).grantPermission(args.key);
  }, { root: repoRoot, key: DAPP });
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);

  await start(win, DAPP, 'subscribe', 'swarm_subscribe', { kind: 'pss', topic: 'lobby' });
  const messagingScreen = win.locator('#sidebar-swarm-messaging-approve');
  await expect(messagingScreen).toBeVisible();
  await expect(win.locator('#swarm-messaging-title')).toHaveText('Messaging Access');
  await expect(win.locator('#swarm-messaging-site')).toHaveText(DAPP);
  await expect(win.locator('#swarm-messaging-topic')).toHaveText('lobby');
  await approve(win, '#swarm-messaging-confirm', 'page-swarm-messaging-prompt.png');

  await expect.poll(() => outcome(win, DAPP, 'subscribe'), { timeout: 15_000 }).toMatchObject({
    ok: { subscriptionId: expect.any(String), kind: 'pss' },
  });
  const { subscriptionId, key } = (await outcome(win, DAPP, 'subscribe')).ok;
  expect(await swarmGrant(electronApp, DAPP)).toMatchObject({ messaging: true });
  expect((await antState(electronApp)).open).toEqual([`/pss/subscribe/${key}`]);

  // The node delivers a message: main sends it to the document that
  // subscribed.
  await electronApp.evaluate(() => globalThis.__fakeAnt.state.sockets[0].ws.send(Buffer.from('hello lobby')));
  await expect.poll(() => heard(win, DAPP)).toEqual([
    [
      'message',
      {
        type: 'swarm_subscription',
        subscription: subscriptionId,
        result: {
          kind: 'pss',
          key,
          data: Buffer.from('hello lobby').toString('base64'),
          encoding: 'base64',
          receivedAt: expect.any(Number),
        },
      },
    ],
  ]);
  const sent = (await trace(electronApp)).filter((e) => e.kind === 'event-sent' && e.provider === 'swarm');
  expect(sent.map((e) => e.event)).toEqual(['message']);

  // The page reloads: its document, and with it the subscription, ends.
  await inTab(win, DAPP, 'location.reload(); 0');
  await expect
    .poll(() => inTab(win, DAPP, 'Array.isArray(window.__events) && document.readyState === "complete" && window.__events.length === 0'))
    .toBe(true);
  await expect.poll(async () => (await antState(electronApp)).closed).toEqual([`/pss/subscribe/${key}`]);
  expect(
    await electronApp.evaluate((_electron, args) =>
      process.mainModule.require(`${args.root}/src/main/swarm/subscription-registry`).countByOrigin(args.key), { root: repoRoot, key: DAPP })
  ).toBe(0);

  // Disconnecting from the chrome: main tells the site's page.
  await win.evaluate((k) => window.swarmPermissions.revokePermission(k), DAPP);
  await expect.poll(() => heard(win, DAPP)).toEqual([['disconnect', { origin: DAPP }]]);
  expect(await oldPath(win)).toEqual([]);
});
