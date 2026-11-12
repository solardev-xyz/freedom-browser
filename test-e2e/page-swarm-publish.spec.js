// window.swarm's publishing through main, in real Electron (freedom-core
// design 0011, step PRQ-7c): `swarm_publishData`, `swarm_publishFiles`,
// `swarm_publishChunk` and `swarm_getUploadStatus` go from the app's preload
// to main on `page:request`, a large upload on its ticket (`page:reserve`).
// Main shows the publish prompt (`swarm.publish`), which the chrome renders
// in its sidebar and answers by handle; main sets the publish rule on
// "always allow", reads it itself, and uploads for the page's attested key.
// The chrome's rule write is refused, and it has no route.
//
// The uploads' charges are measured on the real path: main's heap and
// external memory at each copy main reports (`context.copied`) and while the
// upload streams to the node, the IPC value and every live copy included,
// stay within the request's charge. The node is a fake Ant in its own
// process, so what it receives is never counted in main.

const path = require('path');
const { test, expect } = require('./fixtures');
const { measurePageRequest, pageRequestMaxBytes } = require('../src/shared/page-request-bounds');

const repoRoot = path.resolve(__dirname, '..');
const ANT_SCRIPT = path.join(__dirname, 'page-swarm-publish-ant.js');

const DAPP = `bzz://${'d'.repeat(64)}`;
const NAME = 'example.com';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet', data: { reason: 'no_address' } };
const SITES = ['a', 'b', 'c'].map((c) => `bzz://${c.repeat(64)}`);
const MiB = 1024 * 1024;
const NONCE = '0'.repeat(32);

test.use({
  seedSettings: {
    enableIdentityWallet: true,
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    startRadicleAtLaunch: false,
    enableRadicleIntegration: false,
  },
});

// A page that builds its uploads itself: `__params(method, form, payload,
// note)` makes the params, the payload `payload` bytes in `form` and `note`
// a string of that many bytes the method ignores, so that a request can be
// exactly its method's size with its payload at the method's own limit.
const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__outcomes = {};
    window.__params = (method, form, payload, note) => {
      const bytes = form === 'two-byte'
        ? String.fromCharCode(0x100) + 'a'.repeat(payload - 2)
        : new Uint8Array(payload).fill(255);
      const params = method === 'swarm_publishFiles'
        ? { files: [{ path: 'index.html', bytes }] }
        : { data: bytes, contentType: 'text/plain' };
      if (note > 0) params.note = 'n'.repeat(note);
      return params;
    };
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
 * The params' sizes for a request of exactly `size` bytes by the walk, its
 * payload `payload` bytes: the note that fills the rest.
 */
function noteFor(method, form, size, payload) {
  const shape = (note) => {
    const bytes = form === 'two-byte' ? `${String.fromCharCode(0x100)}${'a'.repeat(payload - 2)}` : new Uint8Array(payload);
    const params = method === 'swarm_publishFiles' ? { files: [{ path: 'index.html', bytes }] } : { data: bytes, contentType: 'text/plain' };
    if (note !== null) params.note = note;
    return params;
  };
  const measure = (params) => measurePageRequest({ nonce: NONCE, provider: 'swarm', method, params }, pageRequestMaxBytes('swarm', method)).size;
  return size - measure(shape(''));
}

/** A fake Ant in a process of its own; main's service registry points at it. */
const startFakeAnt = (electronApp) =>
  electronApp.evaluate(async (_electron, args) => {
    const load = process.mainModule.require;
    const { fork } = load('child_process');
    const child = fork(args.script, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const state = { child, started: [], received: [] };
    child.on('message', (message) => {
      if (message?.kind === 'upload-started') state.started.push(message.id);
      if (message?.kind === 'upload-received') state.received.push(message.upload);
    });
    const port = await new Promise((resolve) => {
      child.on('message', (message) => {
        if (message?.kind === 'listening') resolve(message.port);
      });
    });
    globalThis.__fakeAnt = state;
    load(`${args.root}/src/main/service-registry`).updateService('ant', { api: `http://127.0.0.1:${port}` });
    // Publishing's readiness is the setup service's (its own tests); here
    // the node is ready unless a test says otherwise.
    const setup = load(`${args.root}/src/main/swarm/publish-setup-service`).getPublishSetupService();
    globalThis.__readiness = { ok: true };
    setup.getPublishReadiness = async () => globalThis.__readiness;
  }, { root: repoRoot, script: ANT_SCRIPT });

const stopFakeAnt = (electronApp) =>
  electronApp.evaluate(() => {
    const ant = globalThis.__fakeAnt;
    if (!ant) return;
    try {
      ant.child.send({ kind: 'stop' });
    } catch {
      // Gone already.
    }
    setTimeout(() => ant.child.kill(), 1000).unref();
    globalThis.__fakeAnt = null;
  });

const antSend = (electronApp, message) => electronApp.evaluate((_electron, m) => globalThis.__fakeAnt.child.send(m), message);
const antState = (electronApp) =>
  electronApp.evaluate(() => ({
    started: globalThis.__fakeAnt.started.length,
    received: globalThis.__fakeAnt.received.map((u) => ({ query: u.query, length: u.length, type: u.headers['content-type'], head: u.head })),
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

const start = (win, url, name, method, params) =>
  inTab(win, url, `window.__start(${JSON.stringify(name)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
/** Start an upload the page builds itself (see `page`). */
const startBuilt = (win, url, name, method, form, payload, note = 0) =>
  inTab(
    win,
    url,
    `window.__start(${JSON.stringify(name)}, ${JSON.stringify(method)}, window.__params(${JSON.stringify(method)}, ${JSON.stringify(form)}, ${payload}, ${note}))`
  );
const outcome = (win, url, name) => inTab(win, url, `window.__outcomes[${JSON.stringify(name)}] ?? null`);

const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());
const swarmGrant = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    const permission = process.mainModule.require(`${args.root}/src/main/swarm/swarm-permissions`).getPermission(args.key);
    return permission ? { autoApprove: permission.autoApprove } : null;
  }, { root: repoRoot, key });
const connectInMain = (electronApp, key, { publishRule = false } = {}) =>
  electronApp.evaluate((_electron, args) => {
    const permissions = process.mainModule.require(`${args.root}/src/main/swarm/swarm-permissions`);
    permissions.grantPermission(args.key);
    if (args.publishRule) permissions.setAutoApprove(args.key, 'publish', true);
  }, { root: repoRoot, key, publishRule });

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
    .poll(() => inTab(win, ready, 'Boolean(window.swarm?.request) && typeof window.__start === "function" && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
}

async function newTab(win, electronApp, url) {
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
    .poll(() => inTab(win, url, 'typeof window.__start === "function" && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
  return id;
}

async function approve(win, selector, shot) {
  await win.waitForTimeout(600);
  if (shot) await win.screenshot({ path: test.info().outputPath(shot) });
  await win.locator(selector).click();
}

test.afterEach(async ({ electronApp }) => {
  await electronApp.evaluate(() => {
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__?.setOnCopy(null);
  });
  await stopFakeAnt(electronApp);
});

test('publishing through main: main\'s prompt in the sidebar, the upload for the page\'s key, the rule set and read by main, and the chrome\'s route and rule write refused (0011 PRQ-7c)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  await startFakeAnt(electronApp);
  await connectInMain(electronApp, DAPP);
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);

  await start(win, DAPP, 'data', 'swarm_publishData', { data: 'hello swarm', contentType: 'text/plain', name: 'note.txt' });
  const publishScreen = win.locator('#sidebar-swarm-publish-approve');
  await expect(publishScreen).toBeVisible();
  await expect(win.locator('#swarm-publish-site')).toHaveText(DAPP);
  await expect(win.locator('#swarm-publish-type')).toHaveText('text/plain');
  await expect(win.locator('#swarm-publish-name')).toHaveText('note.txt');
  const prompted = (await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt');
  expect(prompted.map((e) => [e.payload.kind, e.payload.site, e.payload.view])).toEqual([
    ['swarm.publish', { key: DAPP, label: DAPP }, { method: 'swarm_publishData', kind: 'data', size: 11, contentType: 'text/plain', name: 'note.txt' }],
  ]);
  expect((await antState(electronApp)).received).toEqual([]);
  await win.locator('#swarm-publish-auto-approve').check();
  await approve(win, '#swarm-publish-confirm', 'page-swarm-publish-prompt.png');

  await expect.poll(() => outcome(win, DAPP, 'data')).toMatchObject({ ok: { reference: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  await expect(publishScreen).toBeHidden();
  expect((await antState(electronApp)).received).toEqual([
    { query: '?name=note.txt', length: 11, type: 'text/plain', head: 'hello swarm' },
  ]);
  expect(await swarmGrant(electronApp, DAPP)).toMatchObject({ autoApprove: { publish: true } });

  // The rule, read by main, answers the next uploads with no prompt.
  await inTab(win, DAPP, `window.__start('files', 'swarm_publishFiles', { files: [{ path: 'index.html', bytes: new TextEncoder().encode('<p>hi</p>') }], indexDocument: 'index.html' })`);
  await expect.poll(() => outcome(win, DAPP, 'files')).toMatchObject({ ok: { tagUid: expect.any(Number) } });
  const { tagUid } = (await outcome(win, DAPP, 'files')).ok;
  await start(win, DAPP, 'status', 'swarm_getUploadStatus', { tagUid });
  await expect.poll(() => outcome(win, DAPP, 'status')).toMatchObject({ ok: { tagUid, split: 4, done: true } });
  expect((await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt')).toHaveLength(1);

  // A write the node refuses because publishing isn't set up: main tells
  // the chrome, which routes the user to the setup.
  await win.evaluate(() => {
    window.__setupNeeded = [];
    window.electronAPI.onPublishSetupNeeded((payload) => window.__setupNeeded.push(payload));
  });
  await electronApp.evaluate(() => {
    globalThis.__readiness = { ok: false, reason: 'no-usable-stamps' };
  });
  await start(win, DAPP, 'unready', 'swarm_publishChunk', { data: 'chunk' });
  await expect.poll(() => outcome(win, DAPP, 'unready')).toMatchObject({ code: 4900, data: { reason: 'no-usable-stamps' } });
  await expect.poll(() => win.evaluate(() => window.__setupNeeded)).toEqual([{ origin: DAPP, reason: 'no-usable-stamps' }]);

  // The chrome's route and its rule write are refused, for any site.
  const forged = await win.evaluate(async (key) => {
    const tryIt = (fn) => fn().then((v) => v, (err) => String(err?.message || err));
    return {
      rule: await tryIt(() => window.swarmPermissions.setAutoApprove('other.eth', 'publish', true)),
      // No route to name a site on (PRQ-7d).
      route: typeof window.swarmProvider,
      off: await tryIt(() => window.swarmPermissions.setAutoApprove(key, 'publish', false)),
    };
  }, DAPP);
  expect(forged.rule).toContain('Publish auto-approve is turned on only from a publish prompt');
  expect(forged.route).toBe('undefined');
  expect(forged.off).toBe(true);
  expect(await swarmGrant(electronApp, DAPP)).toMatchObject({ autoApprove: { publish: false } });
  expect((await antState(electronApp)).received).toHaveLength(2);
  expect(await oldPath(win)).toEqual([]);
});

test('the uploads\' largest requests stay within their charges on the real path: a 50 MiB Uint8Array\'s swarm_publishFiles, and swarm_publishData as a Uint8Array and as a two-byte string (0011 PRQ-7c)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(300_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  await startFakeAnt(electronApp);
  await connectInMain(electronApp, DAPP, { publishRule: true });
  await openIn(win, `${DAPP}/`);
  await electronApp.evaluate(() => {
    process.mainModule.require('v8').setFlagsFromString('--expose-gc');
    const gc = process.mainModule.require('vm').runInNewContext('gc');
    const used = () => {
      gc();
      gc();
      const memory = process.memoryUsage();
      return memory.heapUsed + memory.external;
    };
    const state = { baseline: 0, copies: [], samples: [], timer: null };
    state.mark = () => {
      state.copies = [];
      state.samples = [];
      state.baseline = used();
      clearInterval(state.timer);
      // While the upload streams to the node, between the copies main reports.
      state.timer = setInterval(() => state.samples.push(used() - state.baseline), 25);
      state.timer.unref();
    };
    state.stop = () => clearInterval(state.timer);
    globalThis.__budgets = state;
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setOnCopy((entry) => {
      state.copies.push({ label: entry.label, inPlace: entry.inPlace, charge: entry.charge, charged: entry.charged, used: used() - state.baseline });
    });
  });

  const cases = [
    ['swarm_publishFiles', 'u8', 50 * MiB],
    ['swarm_publishData', 'u8', 10 * MiB],
    ['swarm_publishData', 'two-byte', 10 * MiB],
  ];
  const record = {};
  for (const [method, form, payload] of cases) {
    const size = pageRequestMaxBytes('swarm', method);
    const note = noteFor(method, form, size, payload);
    const label = `${method} ${form}`;
    // Once unmeasured, so main compiles the path first.
    for (const measured of [false, true]) {
      if (measured) await electronApp.evaluate(() => globalThis.__budgets.mark());
      const before = (await antState(electronApp)).received.length;
      await startBuilt(win, DAPP, label, method, form, payload, note);
      await expect.poll(() => outcome(win, DAPP, label), { timeout: 60_000 }).toMatchObject({ ok: { reference: expect.any(String) } });
      const received = (await antState(electronApp)).received;
      expect(received).toHaveLength(before + 1);
      if (!measured) continue;
      const { copies, samples } = await electronApp.evaluate(() => {
        globalThis.__budgets.stop();
        return { copies: globalThis.__budgets.copies.slice(), samples: globalThis.__budgets.samples.slice() };
      });
      // The upload reached the node whole.
      expect(received.at(-1).length).toBeGreaterThanOrEqual(payload);
      expect(copies.map((c) => [c.label, c.inPlace])).toEqual(
        form === 'two-byte' ? [['upload', true]] : [['normalizeBytes', true], ['upload', true]]
      );
      const charge = copies[0].charge;
      // The ticket's charge, the most a request of its size can be charged,
      // is what the request holds.
      for (const copy of copies) expect(copy.charged).toBeGreaterThanOrEqual(charge);
      const peak = Math.max(...copies.map((c) => c.used), ...samples);
      record[label] = { charge, peak, spare: charge - peak, samples: samples.length };
      expect({ label, peak, charge, within: peak <= charge }).toEqual({ label, peak, charge, within: true });
    }
    // Its ticket, burnt on arrival.
    const kinds = (await trace(electronApp)).filter((e) => e.kind === 'ticket-granted' || e.kind === 'ticket-burnt').map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(['ticket-granted', 'ticket-burnt']);
  }
  console.log(JSON.stringify({ measured: record }, null, 2));

  // One byte more than its size: the preload refuses it, and main hears nothing.
  const from = (await trace(electronApp)).length;
  const over = noteFor('swarm_publishFiles', 'u8', pageRequestMaxBytes('swarm', 'swarm_publishFiles') + 1, 50 * MiB);
  await startBuilt(win, DAPP, 'over', 'swarm_publishFiles', 'u8', 50 * MiB, over);
  await expect.poll(() => outcome(win, DAPP, 'over')).toEqual({
    code: -32602,
    message: 'Total size exceeds maximum of 52428800 bytes',
    data: { reason: 'payload_too_large', limit: 52428800, actual: pageRequestMaxBytes('swarm', 'swarm_publishFiles') + 1 },
  });
  expect((await trace(electronApp)).slice(from)).toEqual([]);
});

test('three uploads of the largest size from three documents of one window run two at a time within the window\'s budget; the third waits for its ticket and is granted when one ends (0011 PRQ-7c)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(300_000);
  for (const site of SITES) {
    await harness.setContentFixture(`${site}/`, page(site));
    await connectInMain(electronApp, site, { publishRule: true });
  }
  await startFakeAnt(electronApp);
  await antSend(electronApp, { kind: 'hold', on: true });
  await openIn(win, `${SITES[0]}/`);
  await newTab(win, electronApp, `${SITES[1]}/`);
  await newTab(win, electronApp, `${SITES[2]}/`);

  const size = pageRequestMaxBytes('swarm', 'swarm_publishFiles');
  const note = noteFor('swarm_publishFiles', 'u8', size, 50 * MiB);
  for (const site of SITES) await startBuilt(win, site, 'big', 'swarm_publishFiles', 'u8', 50 * MiB, note);

  // Two run; the node holds their answers. The third waits for its turn.
  await expect.poll(async () => (await antState(electronApp)).received.length, { timeout: 60_000 }).toBe(2);
  const stats = () => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.stats());
  let usage = await stats();
  expect(usage).toMatchObject({ turns: 2, waiting: 1 });
  const windowBytes = Object.values(usage.windows).reduce((max, w) => Math.max(max, w.bytes), 0);
  expect(windowBytes).toBeLessThanOrEqual(256 * MiB);
  let kinds = (await trace(electronApp)).map((e) => e.kind);
  expect(kinds.filter((k) => k === 'reservation-waiting')).toHaveLength(3);
  expect(kinds.filter((k) => k === 'ticket-granted')).toHaveLength(2);
  await win.waitForTimeout(500);
  expect((await antState(electronApp)).started).toBe(2);

  // One ends: the third's ticket is granted, and it runs.
  await antSend(electronApp, { kind: 'release', count: 1 });
  await expect.poll(async () => (await antState(electronApp)).received.length, { timeout: 60_000 }).toBe(3);
  kinds = (await trace(electronApp)).map((e) => e.kind);
  expect(kinds.filter((k) => k === 'ticket-granted')).toHaveLength(3);
  usage = await stats();
  expect(usage.turns).toBe(2);
  await antSend(electronApp, { kind: 'release' });
  for (const site of SITES) {
    await expect.poll(() => outcome(win, site, 'big'), { timeout: 60_000 }).toMatchObject({ ok: { tagUid: expect.any(Number) } });
  }
  await expect.poll(async () => (await stats()).turns).toBe(0);
});

test('a DNS name over IPNS publishes under the name\'s rule; once the name moves off its IPNS key, publishing and swarm_getUploadStatus are refused with nothing uploaded or read (0011 PRQ-7c)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await startFakeAnt(electronApp);
  // Main resolves the bound name itself; the harness stands in for ENS.
  await electronApp.evaluate((_electron, args) => {
    globalThis.__names = { [args.name]: args.key };
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setResolveName(async (name) => {
      const decoded = globalThis.__names[name];
      return decoded ? { type: 'ok', protocol: 'ipns', decoded } : { type: 'not_found' };
    });
  }, { name: NAME, key: IPNS_KEY });
  await harness.setEnsFixture(NAME, {
    type: 'ok',
    name: NAME,
    protocol: 'ipns',
    decoded: IPNS_KEY,
    uri: `ipns://${IPNS_KEY}`,
    trust: { level: 'verified', queried: ['a.test', 'b.test'], agreed: ['a.test', 'b.test'] },
  });
  await harness.setContentFixture(`ipns://${IPNS_KEY}/`, page('named'));
  // Connected, with the publish rule, under the name.
  await connectInMain(electronApp, NAME, { publishRule: true });
  const url = `ipns://${IPNS_KEY}`;
  await openIn(win, `ens://${NAME}`, url);
  await watchOldPath(win);

  await inTab(win, url, `window.__start('files', 'swarm_publishFiles', { files: [{ path: 'index.html', bytes: new TextEncoder().encode('<p>hi</p>') }] })`);
  await expect.poll(() => outcome(win, url, 'files')).toMatchObject({ ok: { tagUid: expect.any(Number) } });
  const { tagUid } = (await outcome(win, url, 'files')).ok;
  expect((await antState(electronApp)).received).toHaveLength(1);

  // The name moves to other content.
  await electronApp.evaluate((_electron, key) => {
    globalThis.__names['example.com'] = key;
  }, OTHER_IPNS_KEY);
  await start(win, url, 'data', 'swarm_publishData', { data: 'after', contentType: 'text/plain' });
  await expect.poll(() => outcome(win, url, 'data')).toEqual(NO_ADDRESS);
  await start(win, url, 'status', 'swarm_getUploadStatus', { tagUid });
  await expect.poll(() => outcome(win, url, 'status')).toEqual(NO_ADDRESS);
  expect((await antState(electronApp)).received).toHaveLength(1);
  expect((await trace(electronApp)).filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt')).toEqual([]);
  expect(await oldPath(win)).toEqual([]);
});

test('a page that navigates away while its large upload stalls on the node: main stops the upload, and its charge and turn go (0011 PRQ-7c)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  await startFakeAnt(electronApp);
  await connectInMain(electronApp, DAPP, { publishRule: true });
  await antSend(electronApp, { kind: 'stall', on: true });
  await openIn(win, `${DAPP}/`);
  const stats = () => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.stats());

  const size = pageRequestMaxBytes('swarm', 'swarm_publishFiles');
  await startBuilt(win, DAPP, 'stalled', 'swarm_publishFiles', 'u8', 50 * MiB, noteFor('swarm_publishFiles', 'u8', size, 50 * MiB));
  // The node takes the connection and reads nothing: the upload holds its
  // charge and a turn.
  await expect.poll(async () => (await antState(electronApp)).started, { timeout: 30_000 }).toBe(1);
  expect(await stats()).toMatchObject({ turns: 1, records: 1 });

  // The page navigates: main answers its request (gone), aborts the upload,
  // and lets its charge and turn go.
  await inTab(win, DAPP, 'location.reload(); 0');
  await expect.poll(stats, { timeout: 15_000 }).toMatchObject({ turns: 0, records: 0, browser: { requests: 0, bytes: 0 } });
  expect((await antState(electronApp)).received).toEqual([]);
});
