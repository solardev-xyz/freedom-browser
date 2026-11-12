// dApp prompts in the approvals document, in real Electron (freedom-core
// design 0011, step APS-2), with FREEDOM_APPROVALS_DOCUMENT=1: every page
// prompt shows in the window's panel from its kind's template, the chrome
// shows only the badges and the count, and the page makes room for the
// panel beside the content.
//
// The first test runs main's waiting and switching (PRQ-4) with the prompt
// in the document, on the harness's test kind; the next ones run the real
// dApp kinds through their real dispatchers, and every kind's template with
// hostile data in every field a page chooses.

const {
  test,
  expect,
  PAST_DELAY_MS,
  sleep,
  inGuest,
  approvalsState,
  approvalsTrace,
  promptState,
  chromeWindowId,
  approvalsPage,
  openTab,
  reportCount,
  nextReport,
  clickTooSoon,
} = require('./approvals-fixtures');

const A = `bzz://${'a'.repeat(64)}`;
const B = `bzz://${'b'.repeat(64)}`;

// A page that asks main for the harness's prompt, showing the view it chooses.
const testPage = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__asked = {};
    window.__ask = (tag, view) => {
      window.__asked[tag] = { pending: true };
      window.swarm.request({ method: 'swarm_readChunk', params: { tag, view } }).then(
        (ok) => { window.__asked[tag] = { ok }; },
        (e) => { window.__asked[tag] = { code: e && e.code, message: String((e && e.message) || e) }; }
      );
      return true;
    };
    window.__ready = true;
  </script><h1>${title}</h1>`,
});

const view = (title) => ({ title, message: `About ${title}`, rows: [] });
const outcome = (electronApp, guest, tag) => inGuest(electronApp, guest, `window.__asked[${JSON.stringify(tag)}] || null`);
const tabButton = (win, tabId) => win.locator(`[data-test="tab"][data-tab-id="${tabId}"]`);
const count = (win) => win.locator('[data-test="wallet-prompt-count"]');
const space = (win) => win.locator('[data-test="approvals-space"]');

async function routeTestPrompts(electronApp) {
  await electronApp.evaluate(() => {
    const hooks = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__;
    hooks.setRoutes(['swarm:swarm_readChunk']);
    hooks.setDispatch(async (context) => {
      const { tag, view: shown } = context.params || {};
      const decision = await context.prompt({ kind: 'test.prompt', view: shown });
      if (decision.approve === true) return { result: `approved:${tag}` };
      return { error: { code: 4001, message: decision.closed ? `closed:${decision.closed}` : 'User rejected the request' } };
    });
  });
}

test('a background tab\'s prompt waits, switching hides and shows it in the panel, and the page makes room (0011 APS-2)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await harness.setContentFixture(`${A}/`, testPage('dapp a'));
  await harness.setContentFixture(`${B}/`, testPage('dapp b'));
  await routeTestPrompts(electronApp);
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  // The chrome knows the panel is on, and no room is taken yet.
  expect(await win.evaluate(() => window.pagePrompts.approvalsDocument)).toBe(true);
  await expect(space(win)).not.toHaveClass(/open/);

  const guestA = await openTab(electronApp, win, `${A}/`);
  const guestB = await openTab(electronApp, win, `${B}/`);
  // Tab B is in front (tab 3); A waits in the background (tab 2).
  const widthBefore = await win.evaluate(() => document.querySelector('webview:not(.hidden)').getBoundingClientRect().width);

  // A background tab's request: a badge and the count, no panel, no room.
  await inGuest(electronApp, guestA, `window.__ask('a1', ${JSON.stringify(view('a1'))})`);
  await expect(count(win)).toHaveText('1');
  await expect(tabButton(win, 2)).toHaveClass(/has-wallet-prompt/);
  expect((await approvalsState(electronApp))[windowId]).toMatchObject({ visible: false, shown: null });
  await expect(space(win)).not.toHaveClass(/open/);

  // The tab in front asks: its prompt shows, and the page makes room.
  let after = await reportCount(electronApp, windowId);
  await inGuest(electronApp, guestB, `window.__ask('b1', ${JSON.stringify(view('b1'))})`);
  const b1 = (await nextReport(electronApp, windowId, after)).handle;
  await expect(count(win)).toHaveText('2');
  await expect(space(win)).toHaveClass(/open/);
  await expect
    .poll(() => win.evaluate(() => document.querySelector('webview:not(.hidden)').getBoundingClientRect().width))
    .toBe(widthBefore - 320);
  const [contentWidth] = await electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getContentSize(), windowId);
  const spaceBox = await space(win).boundingBox();
  const bounds = (await approvalsState(electronApp))[windowId].bounds;
  // The room the page made is where main put the panel.
  expect(Math.round(spaceBox.x)).toBe(bounds.x);
  expect(bounds.x + bounds.width).toBe(contentWidth);
  await expect(docPage.locator('#body .field-value').first()).toHaveText('b1');

  // Switching to A: B's prompt is hidden and keeps its place, A's shows,
  // and a decision for B sent late, after the switch, is refused.
  await sleep(PAST_DELAY_MS);
  after = await reportCount(electronApp, windowId);
  await tabButton(win, 2).click();
  await expect.poll(async () => (await approvalsState(electronApp))[windowId].shown).not.toBe(b1);
  expect(await docPage.evaluate((h) => window.approvals.decide(h, true, undefined), b1)).toEqual({ ok: false, reason: 'not-shown' });
  const a1 = await clickTooSoon(electronApp, docPage, windowId, after);
  await expect(docPage.locator('#body .field-value').first()).toHaveText('a1');
  expect((await promptState(electronApp))[windowId].open).toEqual([a1, b1]);
  await expect(space(win)).toHaveClass(/open/);
  await docPage.click('#reject');
  await expect.poll(() => outcome(electronApp, guestA, 'a1')).toEqual({ code: 4001, message: 'User rejected the request' });
  await expect(count(win)).toHaveText('1');
  await expect(tabButton(win, 2)).not.toHaveClass(/has-wallet-prompt/);
  // A has nothing more to show: the panel goes and the page takes its room back.
  await expect.poll(async () => (await approvalsState(electronApp))[windowId]).toMatchObject({ visible: false, shown: null });
  await expect(space(win)).not.toHaveClass(/open/);

  // Back on B: it shows again, and a decision counts only once the delay
  // has started again.
  after = await reportCount(electronApp, windowId);
  await tabButton(win, 3).click();
  expect(await clickTooSoon(electronApp, docPage, windowId, after)).toBe(b1);
  await docPage.click('#approve');
  await expect.poll(() => outcome(electronApp, guestB, 'b1')).toEqual({ ok: 'approved:b1' });
  await expect(count(win)).toBeHidden();
  await expect(space(win)).not.toHaveClass(/open/);
  await expect
    .poll(() => win.evaluate(() => document.querySelector('webview:not(.hidden)').getBoundingClientRect().width))
    .toBe(widthBefore);

  // The chrome never rendered a prompt: its sidebar stayed shut.
  await expect(win.locator('#sidebar')).toHaveClass(/collapsed/);
  expect((await approvalsTrace(electronApp)).filter((e) => e.kind === 'request-refused')).toEqual([]);
});
