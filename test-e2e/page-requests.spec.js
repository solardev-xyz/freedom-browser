// The page request channels in real Electron (freedom-core design 0011,
// step PRQ-2): the app's own preload says hello and sends a request on
// `page:request`, main answers only the document that asked, an event main
// held past its check reaches a replacement document and is dropped there by
// the nonce, and a sub-frame or a private window gets nothing.
//
// No provider method takes the new path yet. The harness's test hooks
// (src/main/page/page-requests.js, `enablePageRequestTestHooks`) route two
// Swarm methods through main for this spec, by the boot switch of tabs
// opened after `setRoutes`, and serve them with a test dispatcher.

const path = require('path');
const { test, expect } = require('./fixtures');

const A = `bzz://${'c'.repeat(64)}`;
const FRAME = `bzz://${'b'.repeat(64)}/frame`;
const FORGED_PRELOAD = path.join(__dirname, 'page-requests-forged-preload.js');

// A page that records every Swarm response and event the preload posts it,
// and every `message` its provider emits.
const page = (title, extra = '') => ({
  contentType: 'text/html; charset=utf-8',
  body:
    `<!doctype html><title>${title}</title><script>
      window.__seen = [];
      window.__events = [];
      addEventListener('message', (e) => {
        const d = e.data;
        if (d && (d.type === 'FREEDOM_SWARM_RESPONSE' || d.type === 'FREEDOM_SWARM_EVENT')) {
          window.__seen.push(JSON.parse(JSON.stringify(d)));
        }
      });
      window.swarm.on('message', (data) => window.__events.push(data));
      window.__ready = true;
    </script><h1>${title}</h1>${extra}`,
});

/** Serve the page's Swarm requests with a dispatcher that can hold. */
async function routeThroughMain(electronApp) {
  await electronApp.evaluate(() => {
    const hooks = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__;
    const state = { log: [], held: {}, forged: [] };
    globalThis.__prq = state;
    hooks.setDispatch((context) => {
      const params = context.params || {};
      state.log.push({ id: context.id, method: context.method, tag: params.tag, requester: context.requester });
      if (params.hold) {
        return new Promise((resolve) => {
          state.held[params.tag] = resolve;
        });
      }
      return { result: `chunk:${params.tag}` };
    });
  });
}

const state = (electronApp) =>
  electronApp.evaluate(() => ({
    log: globalThis.__prq.log.slice(),
    forged: globalThis.__prq.forged.slice(),
    held: Object.keys(globalThis.__prq.held),
    trace: globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice(),
  }));

const activeGuestId = (win) =>
  win.evaluate(() => document.querySelector('webview:not(.hidden)')?.getWebContentsId() ?? null);

const inPage = (win, js) =>
  win.evaluate((code) => document.querySelector('webview:not(.hidden)').executeJavaScript(code), js);

const load = (electronApp, id, url) =>
  electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id, url });

/** Wait until the active tab shows `url`, its page script has run, and its hello has bound. */
async function settled(electronApp, win, id, url, helloCount) {
  await expect
    .poll(
      async () => {
        const ready = await inPage(win, `location.href === ${JSON.stringify(url)} && window.__ready === true`).catch(() => false);
        const hellos = (await state(electronApp)).trace.filter((e) => e.kind === 'hello' && e.result.ok).length;
        return ready && hellos >= helloCount;
      },
      { message: `waiting for ${url} to load and say hello`, timeout: 20_000 }
    )
    .toBe(true);
}

/** Observe the forged preload's reports on a guest. */
const watchForged = (electronApp, id) =>
  electronApp.evaluate(({ webContents }, guestId) => {
    webContents.fromId(guestId).on('ipc-message', (_event, channel, payload) => {
      if (channel === 'page-requests-test:forged') globalThis.__prq.forged.push(payload);
    });
  }, id);

test('the page request channels answer only the document that asked (0011 PRQ-2)', async ({
  window: win,
  electronApp,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${A}/one`, page('one'));
  await harness.setContentFixture(`${A}/two`, page('two'));
  await harness.setContentFixture(`${A}/framed`, page('framed', `<iframe src="${FRAME}"></iframe>`));
  await harness.setContentFixture(FRAME, page('frame'));
  await routeThroughMain(electronApp);

  // A tab opened after the routes were set, so its boot switch carries them.
  const before = await activeGuestId(win);
  await win.locator('[data-test="new-tab-btn"]').click();
  let id = null;
  await expect
    .poll(async () => {
      id = await activeGuestId(win).catch(() => null);
      return id !== null && id !== before;
    })
    .toBe(true);

  // The app's preload says hello, and a routed request reaches main as this
  // document's: its key, its URL, its guest.
  await load(electronApp, id, `${A}/one`);
  await settled(electronApp, win, id, `${A}/one`, 1);
  expect(await inPage(win, "window.swarm.request({ method: 'swarm_readChunk', params: { tag: 'first' } })")).toBe(
    'chunk:first'
  );
  let seen = await state(electronApp);
  const first = seen.log.find((e) => e.tag === 'first');
  expect(first.requester).toEqual(expect.objectContaining({ guest: id, url: `${A}/one`, key: A, transportKey: A }));

  // A request sent, the page navigated, the request finished: no reply, and
  // nothing reaches the new document.
  await inPage(win, "window.swarm.request({ method: 'swarm_publishData', params: { tag: 'held', hold: true } }); true");
  await expect.poll(async () => (await state(electronApp)).held).toContain('held');
  const helloCount = (await state(electronApp)).trace.filter((e) => e.kind === 'hello' && e.result.ok).length;
  await load(electronApp, id, `${A}/two`);
  await settled(electronApp, win, id, `${A}/two`, helloCount + 1);
  await electronApp.evaluate(() => globalThis.__prq.held.held({ result: 'published' }));
  // A request of the new document's own, answered after the stale one's
  // work ended: had the stale answer reached this document, it would show
  // first.
  expect(await inPage(win, "window.swarm.request({ method: 'swarm_readChunk', params: { tag: 'control' } })")).toBe(
    'chunk:control'
  );
  seen = await state(electronApp);
  const heldId = seen.log.find((e) => e.tag === 'held').id;
  expect(seen.trace.filter((e) => e.id === heldId).map((e) => e.kind)).toEqual(['recorded', 'gone', 'dropped', 'released']);
  expect(await inPage(win, 'window.__seen')).toEqual([
    { type: 'FREEDOM_SWARM_RESPONSE', id: 1, result: 'chunk:control' },
  ]);
  const two = seen.log.find((e) => e.tag === 'control').requester;
  expect(two.navigation).toBeGreaterThan(first.requester.navigation);

  // An event for a replaced document is dropped: main checks the record, the
  // hook holds the send, the frame reloads (same process, same key), and the
  // send goes to the new document, whose preload drops the old nonce.
  await electronApp.evaluate(() => {
    globalThis.__prq.sending = null;
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setBeforeEventSend(
      () =>
        new Promise((resolve) => {
          globalThis.__prq.releaseEvent = resolve;
        })
    );
  });
  await electronApp.evaluate((_electron, target) => {
    globalThis.__prq.sending = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.sendEvent(target, 'swarm', 'message', { n: 'stale' });
  }, two);
  await expect.poll(() => electronApp.evaluate(() => typeof globalThis.__prq.releaseEvent)).toBe('function');
  const processBefore = await electronApp.evaluate(({ webContents }, guestId) => webContents.fromId(guestId).mainFrame.processId, id);
  await electronApp.evaluate(({ webContents }, guestId) => webContents.fromId(guestId).reload(), id);
  await settled(electronApp, win, id, `${A}/two`, helloCount + 2);
  expect(
    await electronApp.evaluate(({ webContents }, guestId) => webContents.fromId(guestId).mainFrame.processId, id),
    'the reload stays in its process'
  ).toBe(processBefore);
  const sent = await electronApp.evaluate(async () => {
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setBeforeEventSend(null);
    globalThis.__prq.releaseEvent();
    return globalThis.__prq.sending;
  });
  expect(sent, 'main sent it, to the frame that now holds the new document').toEqual({ ok: true });

  // The new document's own event, sent after the stale one, arrives; the
  // stale one never did.
  expect(await inPage(win, "window.swarm.request({ method: 'swarm_readChunk', params: { tag: 'reloaded' } })")).toBe(
    'chunk:reloaded'
  );
  const reloaded = (await state(electronApp)).log.find((e) => e.tag === 'reloaded').requester;
  expect(reloaded.navigation).toBeGreaterThan(two.navigation);
  expect(await electronApp.evaluate(
    (_electron, target) => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.sendEvent(target, 'swarm', 'message', { n: 'fresh' }),
    reloaded
  )).toEqual({ ok: true });
  await expect.poll(() => inPage(win, 'window.__events')).toEqual([{ n: 'fresh' }]);
  expect((await inPage(win, 'window.__seen')).filter((m) => m.type === 'FREEDOM_SWARM_EVENT')).toEqual([
    { type: 'FREEDOM_SWARM_EVENT', event: 'message', data: { n: 'fresh' } },
  ]);

  // A compromised renderer calling page:request itself: a sub-frame is
  // refused by the sender policy before main reads it, and the top frame,
  // without its document's nonce, by main.
  await watchForged(electronApp, id);
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).session.registerPreloadScript({
      type: 'frame',
      id: 'page-requests-test-forged',
      filePath: args.preload,
    });
  }, { id, preload: FORGED_PRELOAD });
  await load(electronApp, id, `${A}/framed`);
  await expect.poll(async () => (await state(electronApp)).forged.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await electronApp.evaluate(({ webContents }, guestId) => {
    webContents.fromId(guestId).session.unregisterPreloadScript('page-requests-test-forged');
  }, id);
  const forged = (await state(electronApp)).forged;
  expect(forged.find((e) => !e.top && e.href === FRAME).outcome).toEqual({
    rejected: expect.stringContaining('IPC channel "page:request" is not available to this sender'),
  });
  expect(forged.find((e) => e.top && e.href === `${A}/framed`).outcome).toEqual({
    answer: { error: { code: 4100, message: 'Unauthorized', data: { reason: 'wrong-nonce' } } },
  });
  // Neither ran anything.
  expect((await state(electronApp)).log.filter((e) => e.tag === 'forged')).toEqual([]);
});

test('a private window\'s page gets no providers, and main refuses one that asks anyway (0011 PRQ-2)', async ({
  window: _win,
  electronApp,
  harness,
}) => {
  test.setTimeout(90_000);
  await harness.setContentFixture(`${A}/secret`, {
    contentType: 'text/html; charset=utf-8',
    body: "<!doctype html><title>secret</title><script>window.__swarm = typeof window.swarm;</script><h1>secret</h1>",
  });
  await routeThroughMain(electronApp);

  const known = new Set(electronApp.windows().map((p) => p.url()));
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().getMenuItemById('new-private-window').click();
  });
  let privateWin;
  await expect
    .poll(() => {
      privateWin = electronApp.windows().find((p) => p.url().includes('privatePartition=private-') && !known.has(p.url()));
      return Boolean(privateWin);
    }, { timeout: 15_000 })
    .toBe(true);
  await privateWin.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  await expect.poll(() => privateWin.evaluate(() => Boolean(document.querySelector('webview:not(.hidden)')))).toBe(true);
  const id = await activeGuestId(privateWin);

  await watchForged(electronApp, id);
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).session.registerPreloadScript({
      type: 'frame',
      id: 'page-requests-test-forged',
      filePath: args.preload,
    });
  }, { id, preload: FORGED_PRELOAD });
  const hellosBefore = (await state(electronApp)).trace.filter((e) => e.kind === 'hello').length;
  await load(electronApp, id, `${A}/secret`);
  await expect
    .poll(async () => (await state(electronApp)).forged.find((e) => e.top && e.href === `${A}/secret`), { timeout: 20_000 })
    .toBeTruthy();

  expect(await inPage(privateWin, 'window.__swarm')).toBe('undefined');
  // The app's preload sent no hello from the private page.
  expect((await state(electronApp)).trace.filter((e) => e.kind === 'hello').length).toBe(hellosBefore);
  const forged = (await state(electronApp)).forged.find((e) => e.top && e.href === `${A}/secret`);
  expect(forged.outcome).toEqual({
    answer: { error: { code: 4100, message: 'Unauthorized', data: { reason: 'private' } } },
  });
  expect((await state(electronApp)).log).toEqual([]);
});
