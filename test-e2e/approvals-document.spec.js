// The approvals document in real Electron (freedom-core design 0011, step
// APS-1), with FREEDOM_APPROVALS_DOCUMENT=1: one per window, a view above
// the chrome's, hidden until main has a prompt for it, in its own in-memory
// partition, sandboxed, with the CSP and Trusted Types on its response.
// Main sends it the prompt the window shows and refuses the chrome's
// decisions; its `approvals:*` handlers take only that window's own view on
// the packaged file; and its input does nothing for 500 ms after a prompt
// appears, changes, is shown again or moves, with main refusing an approval
// sooner than that, and Enter never approving.
//
// The prompt is the harness's own kind (`test.prompt`): the test hooks
// route `swarm_readChunk` through main for tabs opened after `setRoutes`,
// and serve it with a dispatcher that opens a prompt with the view the page
// sent, so every field it shows is the page's choice.

const path = require('path');
const { pathToFileURL } = require('url');
const {
  test,
  expect,
  repoRoot,
  APPROVALS_URL,
  DELAY_MS,
  PAST_DELAY_MS,
  sleep,
  activeGuestId,
  inGuest,
  approvalsState,
  approvalsTrace,
  promptState,
  openTab,
  reportCount,
  nextReport,
  since,
  clickTooSoon,
} = require('./approvals-fixtures');

const A = `bzz://${'d'.repeat(64)}`;
const B = `bzz://${'e'.repeat(64)}`;
const FORGED_PRELOAD = path.join(__dirname, 'approvals-document-forged-preload.js');
// The design's policy, word for word ("Rendering a page's data").
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; " +
  "frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

// A page that asks main for a test prompt showing the view it chooses.
const page = (title) => ({
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

const view = (title, extra = {}) => ({ title, message: `About ${title}`, rows: [{ label: 'Row', value: title }], ...extra });

const inDoc = inGuest;
const decisions = (electronApp) => electronApp.evaluate(() => globalThis.__aps.decisions.slice());
const outcome = (electronApp, guest, tag) => inGuest(electronApp, guest, `window.__asked[${JSON.stringify(tag)}] || null`);

async function routeTestPrompts(electronApp) {
  await electronApp.evaluate(() => {
    const hooks = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__;
    const aps = { contexts: {}, decisions: [] };
    globalThis.__aps = aps;
    hooks.setRoutes(['swarm:swarm_readChunk']);
    hooks.setDispatch(async (context) => {
      const { tag, view: shown } = context.params || {};
      aps.contexts[tag] = context;
      const decision = await context.prompt({ kind: 'test.prompt', view: shown });
      aps.decisions.push({ tag, decision });
      if (decision.approve === true) return { result: `approved:${tag}` };
      return { error: { code: 4001, message: decision.closed ? `closed:${decision.closed}` : 'User rejected the request' } };
    });
  });
}

/** The page asks for a prompt showing `shown`; returns at once. */
const ask = (electronApp, guest, tag, shown) =>
  inGuest(electronApp, guest, `window.__ask(${JSON.stringify(tag)}, ${JSON.stringify(shown)})`);

test('the approvals document: its surface, sender checks, rendering and input rules (0011 APS-1)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(240_000);
  await harness.setContentFixture(`${A}/`, page('dapp a'));
  await harness.setContentFixture(`${B}/`, page('dapp b'));

  // One document for the window, created with it and hidden.
  const windowId = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/renderer/index.html')).id
  );
  let state = await approvalsState(electronApp);
  expect(Object.keys(state)).toEqual([String(windowId)]);
  expect(state[windowId]).toMatchObject({ visible: false, shown: null });
  const docId = state[windowId].contents;
  await expect.poll(async () => (await approvalsState(electronApp))[windowId].ready).toBe(true);

  // Sandboxed, isolated, no Node, no <webview>, in its own in-memory
  // partition, on the packaged file.
  const { partition } = await electronApp.evaluate(() => ({ partition: globalThis.__FREEDOM_TEST_APPROVALS__.partition }));
  const surface = await electronApp.evaluate(({ webContents, session }, args) => {
    const wc = webContents.fromId(args.id);
    const prefs = wc.getLastWebPreferences();
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
      nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
      webviewTag: prefs.webviewTag,
      ownSession: wc.session === session.fromPartition(args.partition) && wc.session !== session.defaultSession,
      persistent: wc.session.isPersistent(),
      url: wc.getURL(),
    };
  }, { id: docId, partition });
  expect(surface).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    ownSession: true,
    persistent: false,
    url: APPROVALS_URL,
  });
  let docPage = null;
  await expect
    .poll(() => {
      docPage = electronApp.windows().find((p) => p.url() === APPROVALS_URL) || null;
      return Boolean(docPage);
    })
    .toBe(true);

  // The CSP comes with the document's response, and the partition serves
  // nothing but the document's own files.
  const served = await electronApp.evaluate(async ({ session }, args) => {
    const ses = session.fromPartition(args.partition);
    const doc = await ses.fetch(args.url);
    const status = (url) => ses.fetch(url).then((r) => r.status, (e) => `error: ${e.message}`);
    return {
      status: doc.status,
      csp: doc.headers.get('content-security-policy'),
      nosniff: doc.headers.get('x-content-type-options'),
      otherFile: await status(args.other),
      web: await status('https://example.com/'),
    };
  }, { partition, url: APPROVALS_URL, other: pathToFileURL(path.join(repoRoot, 'package.json')).href });
  // The partition's request filter refuses the rest before anything serves it.
  expect(served).toEqual({
    status: 200,
    csp: CSP,
    nosniff: 'nosniff',
    otherFile: 'error: net::ERR_BLOCKED_BY_CLIENT',
    web: 'error: net::ERR_BLOCKED_BY_CLIENT',
  });

  // Under Trusted Types every markup sink throws, eval is refused, and
  // nothing loads from anywhere else.
  const sinks = await inDoc(
    electronApp,
    docId,
    `(async () => {
      const out = {};
      const attempt = (name, fn) => { try { fn(); out[name] = 'allowed'; } catch (e) { out[name] = e.name; } };
      const scratch = document.createElement('div');
      attempt('innerHTML', () => { scratch.innerHTML = '<b>x</b>'; });
      attempt('insertAdjacentHTML', () => scratch.insertAdjacentHTML('beforeend', '<b>x</b>'));
      attempt('scriptText', () => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; });
      attempt('documentWrite', () => document.write('<b>x</b>'));
      attempt('eval', () => eval('1'));
      out.fetch = await fetch('https://example.com/').then(() => 'loaded', (e) => e.name);
      out.bold = document.querySelectorAll('b').length;
      return out;
    })()`
  );
  expect(sinks).toEqual({
    innerHTML: 'TypeError',
    insertAdjacentHTML: 'TypeError',
    scriptText: 'TypeError',
    documentWrite: 'TypeError',
    eval: 'EvalError',
    fetch: 'TypeError',
    bold: 0,
  });

  // Another webContents, a page with its own preload, can't reach the
  // approvals channels (the sender policy, then main's own check).
  let firstGuest = null;
  await expect
    .poll(async () => {
      firstGuest = await activeGuestId(win).catch(() => null);
      return firstGuest !== null;
    }, { timeout: 20_000 })
    .toBe(true);
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id: firstGuest, url: `${B}/` });
  await expect.poll(() => inGuest(electronApp, firstGuest, 'window.__ready === true').catch(() => false)).toBe(true);
  await electronApp.evaluate(({ webContents }, args) => {
    globalThis.__forged = [];
    const guest = webContents.fromId(args.guest);
    guest.on('ipc-message', (_event, channel, payload) => {
      if (channel === 'approvals-test:forged') globalThis.__forged.push(payload);
    });
    guest.session.registerPreloadScript({ type: 'frame', id: 'approvals-test-forged', filePath: args.preload });
    guest.reload();
  }, { guest: firstGuest, preload: FORGED_PRELOAD });
  await expect.poll(() => inGuest(electronApp, firstGuest, 'window.__ready === true').catch(() => false)).toBe(true);

  // The page in front of a new tab asks: main shows its prompt in the
  // approvals panel, at the side of the content area below the toolbar.
  await routeTestPrompts(electronApp);
  const guest = await openTab(electronApp, win, `${A}/`);
  // A click the moment it shows does nothing.
  let after = await reportCount(electronApp, windowId);
  await ask(electronApp, guest, 'one', view('one'));
  const one = await clickTooSoon(electronApp, docPage, windowId, after);
  expect((await promptState(electronApp))[windowId].shown).toBe(one);
  state = (await approvalsState(electronApp))[windowId];
  expect(state.visible).toBe(true);
  const layout = await win.evaluate(() => ({
    top: Math.round(document.querySelector('.app-body').getBoundingClientRect().top),
  }));
  const [contentWidth, contentHeight] = await electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getContentSize(), windowId);
  await expect
    .poll(async () => (await approvalsState(electronApp))[windowId].bounds)
    .toEqual({ x: contentWidth - 320, y: layout.top, width: 320, height: contentHeight - layout.top });
  await expect(docPage.locator('#site')).toHaveText(A);
  await expect(docPage.locator('#heading')).toHaveText('Test request');
  // Focus starts on Reject.
  expect(await docPage.evaluate(() => document.activeElement && document.activeElement.id)).toBe('reject');
  await docPage.screenshot({ path: test.info().outputPath('approvals-panel.png') });

  // The chrome rendered nothing and counts the request on its badge; its
  // decision is refused.
  await expect(win.locator('[data-test="wallet-prompt-count"]')).toHaveText('1');
  await expect(win.locator('#sidebar')).toHaveClass(/collapsed/);
  expect(await win.evaluate((h) => window.pagePrompts.decide(h, true, undefined), one)).toEqual({
    ok: false,
    reason: 'approvals-document',
  });

  // The forged page's decision for the shown handle: refused.
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).mainFrame.send('approvals-test:forge', { handle: args.handle });
  }, { id: firstGuest, handle: one });
  await expect.poll(() => electronApp.evaluate(() => globalThis.__forged.length)).toBe(1);
  const [forged] = await electronApp.evaluate(() => globalThis.__forged);
  expect(forged.rejected).toContain('not available to this sender');
  await electronApp.evaluate(({ webContents }, id) => {
    webContents.fromId(id).session.unregisterPreloadScript('approvals-test-forged');
  }, firstGuest);
  expect(await decisions(electronApp)).toEqual([]);
  expect(await outcome(electronApp, guest, 'one')).toEqual({ pending: true });

  // After the delay, a click counts.
  await docPage.click('#approve');
  await expect.poll(() => outcome(electronApp, guest, 'one')).toEqual({ ok: 'approved:one' });
  await expect.poll(async () => (await approvalsState(electronApp))[windowId]).toMatchObject({ visible: false, shown: null });
  await expect(win.locator('[data-test="wallet-prompt-count"]')).toBeHidden();

  // A new prompt, with hostile text in every field: shown as literal text,
  // invisible characters as escapes, a long value cut with its full text
  // below. The delay starts again; Enter on any control never approves;
  // Space on a focused Approve does.
  const BACKSLASH = String.fromCharCode(92);
  const hostile = {
    title: '<img src=x onerror="window.__xss=1">',
    message: `first${String.fromCharCode(10)}second ${String.fromCodePoint(0x202e)}evil${String.fromCodePoint(0x200b)}`,
    rows: [{ label: '<b>to</b>', value: 'x'.repeat(300) }],
  };
  after = await reportCount(electronApp, windowId);
  await ask(electronApp, guest, 'two', hostile);
  const two = await clickTooSoon(electronApp, docPage, windowId, after);
  await expect(docPage.locator('#body .field-value').first()).toHaveText(hostile.title);
  expect(await docPage.locator('#body img, #body b, #body script').count()).toBe(0);
  await expect(docPage.locator('#body .field-label').nth(2)).toHaveText('<b>to</b>');
  await expect(docPage.locator('#body .field-value.multiline')).toHaveText(
    `first${String.fromCharCode(10)}second ${BACKSLASH}u{202E}evil${BACKSLASH}u{200B}`
  );
  await expect(docPage.locator('#body .field-full')).toHaveText('x'.repeat(300));
  expect(await docPage.evaluate(() => window.__xss)).toBeUndefined();
  expect(await docPage.evaluate(() => document.activeElement && document.activeElement.id)).toBe('reject');
  for (const control of ['#reject', '#approve', '#body .field-full']) {
    await docPage.focus(control);
    await docPage.keyboard.press('Enter');
  }
  await docPage.focus('#approve');
  await docPage.keyboard.press('NumpadEnter');
  await sleep(300);
  expect(await outcome(electronApp, guest, 'two')).toEqual({ pending: true });
  expect((await approvalsState(electronApp))[windowId].shown).toBe(two);
  expect((await decisions(electronApp)).map((d) => d.tag)).toEqual(['one']);
  await docPage.focus('#approve');
  await docPage.keyboard.press(' ');
  await expect.poll(() => outcome(electronApp, guest, 'two')).toEqual({ ok: 'approved:two' });

  // A changed prompt: its content changes while it shows, and the delay
  // starts again.
  after = await reportCount(electronApp, windowId);
  await ask(electronApp, guest, 'three', view('three'));
  const three = (await nextReport(electronApp, windowId, after)).handle;
  await sleep(PAST_DELAY_MS);
  after = await reportCount(electronApp, windowId);
  expect(
    await electronApp.evaluate((_electron, next) => globalThis.__aps.contexts.three.updatePrompt(next), view('three, changed'))
  ).toBe(true);
  expect(await clickTooSoon(electronApp, docPage, windowId, after)).toBe(three);
  await expect(docPage.locator('#body .field-value').first()).toHaveText('three, changed');
  await docPage.click('#approve');
  await expect.poll(() => outcome(electronApp, guest, 'three')).toEqual({ ok: 'approved:three' });

  // Shown again: another tab in front hides it; back in front, it shows
  // again and the delay starts again.
  after = await reportCount(electronApp, windowId);
  await ask(electronApp, guest, 'four', view('four'));
  const four = (await nextReport(electronApp, windowId, after)).handle;
  await sleep(PAST_DELAY_MS);
  await win.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect.poll(async () => (await approvalsState(electronApp))[windowId]).toMatchObject({ visible: false, shown: null });
  expect((await promptState(electronApp))[windowId].open).toEqual([four]);
  after = await reportCount(electronApp, windowId);
  await win.locator('[data-test="tab"][data-tab-id="2"]').click();
  expect(await clickTooSoon(electronApp, docPage, windowId, after)).toBe(four);
  await docPage.click('#approve');
  await expect.poll(() => outcome(electronApp, guest, 'four')).toEqual({ ok: 'approved:four' });

  // Moved: the window's size changes, the panel moves with it, and the
  // delay starts again.
  after = await reportCount(electronApp, windowId);
  await ask(electronApp, guest, 'five', view('five'));
  const five = (await nextReport(electronApp, windowId, after)).handle;
  await sleep(PAST_DELAY_MS);
  const size = await electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getSize(), windowId);
  const moves = (await approvalsTrace(electronApp)).filter((e) => e.kind === 'moved').length;
  after = await reportCount(electronApp, windowId);
  await electronApp.evaluate(({ BrowserWindow }, args) => BrowserWindow.fromId(args.id).setSize(args.w - 120, args.h), {
    id: windowId,
    w: size[0],
    h: size[1],
  });
  expect(await clickTooSoon(electronApp, docPage, windowId, after)).toBe(five);
  expect((await approvalsTrace(electronApp)).filter((e) => e.kind === 'moved').length).toBeGreaterThan(moves);
  await docPage.click('#approve');
  await expect.poll(() => outcome(electronApp, guest, 'five')).toEqual({ ok: 'approved:five' });
  await electronApp.evaluate(({ BrowserWindow }, args) => BrowserWindow.fromId(args.id).setSize(args.w, args.h), {
    id: windowId,
    w: size[0],
    h: size[1],
  });

  // Main's own refusal: an approval sent straight from the document sooner
  // than 500 ms after its report is refused; after it, it counts.
  after = await reportCount(electronApp, windowId);
  await ask(electronApp, guest, 'six', view('six'));
  const sixReport = await nextReport(electronApp, windowId, after);
  expect(await docPage.evaluate((h) => window.approvals.decide(h, true, undefined), sixReport.handle)).toEqual({
    ok: false,
    reason: 'too-soon',
  });
  expect(await since(electronApp, sixReport.at)).toBeLessThan(DELAY_MS);
  await sleep(PAST_DELAY_MS);
  expect(await docPage.evaluate((h) => window.approvals.decide(h, true, undefined), sixReport.handle)).toEqual({ ok: true });
  await expect.poll(() => outcome(electronApp, guest, 'six')).toEqual({ ok: 'approved:six' });

  // Sender checks on a live prompt: the view after a same-document
  // navigation, and another window's own document, are refused.
  after = await reportCount(electronApp, windowId);
  await ask(electronApp, guest, 'seven', view('seven'));
  const seven = (await nextReport(electronApp, windowId, after)).handle;
  await sleep(PAST_DELAY_MS);
  expect(
    await docPage.evaluate(async (h) => {
      history.replaceState(null, '', '?moved');
      const answer = await window.approvals.decide(h, true, undefined);
      history.replaceState(null, '', location.pathname);
      return answer;
    }, seven)
  ).toEqual({ ok: false, reason: 'navigated' });
  await win.evaluate(() => window.electronAPI.newWindow());
  let secondId = null;
  await expect
    .poll(async () => {
      const all = await approvalsState(electronApp);
      secondId = Object.keys(all).map(Number).find((id) => id !== windowId) ?? null;
      return secondId !== null && all[secondId].ready === true;
    }, { timeout: 20_000 })
    .toBe(true);
  const secondDoc = (await approvalsState(electronApp))[secondId].contents;
  expect(await inDoc(electronApp, secondDoc, `window.approvals.decide(${JSON.stringify(seven)}, true, undefined)`)).toEqual({
    ok: false,
    reason: 'not-shown',
  });
  await electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), secondId);
  await expect.poll(async () => Object.keys(await approvalsState(electronApp))).toEqual([String(windowId)]);
  expect((await promptState(electronApp))[windowId].open).toEqual([seven]);
  expect(await outcome(electronApp, guest, 'seven')).toEqual({ pending: true });

  // Navigation and popups refused: the document stays, and no window opens.
  // (Last but one: Playwright waits on a navigation that never commits
  // until the next one does.)
  const opened = () =>
    electronApp.evaluate(({ webContents, BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().length,
      elsewhere: webContents.getAllWebContents().filter((wc) => wc.getURL().includes('example.com')).length,
    }));
  const openedBefore = await opened();
  expect(
    await inDoc(electronApp, docId, `(() => { const w = window.open('https://example.com/'); location.href = 'https://example.com/'; return w === null; })()`)
  ).toBe(true);
  await expect
    .poll(async () => (await approvalsTrace(electronApp)).map((e) => e.kind))
    .toEqual(expect.arrayContaining(['popup-refused', 'navigation-refused']));
  await sleep(300);
  expect(await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), docId)).toBe(APPROVALS_URL);
  expect(await opened()).toEqual({ ...openedBefore, elsewhere: 0 });

  // A view that navigated to another document: its preload's call is
  // refused. Even main can't load anything but the document's own files in
  // its partition, so the other document is one of them (its stylesheet).
  // Loaded again, the document gets the prompt again, and the user rejects
  // it.
  const sevenReports = await reportCount(electronApp, windowId);
  expect(
    await electronApp.evaluate(({ webContents }, id) =>
      webContents.fromId(id).loadURL('data:text/html,<p>elsewhere</p>').then(() => 'loaded', (e) => e.code), docId)
  ).toBe('ERR_BLOCKED_BY_CLIENT');
  await electronApp.evaluate(({ webContents }, args) => webContents.fromId(args.id).loadURL(args.url), {
    id: docId,
    url: APPROVALS_URL.replace(/approvals\.html$/, 'approvals.css'),
  });
  expect(
    await inDoc(electronApp, docId, `window.approvals.decide(${JSON.stringify(seven)}, true, undefined).then((a) => a, (e) => 'refused: ' + e.message)`)
  ).toContain('not available to this sender');
  await electronApp.evaluate(({ webContents }, args) => webContents.fromId(args.id).loadURL(args.url), { id: docId, url: APPROVALS_URL });
  await expect.poll(async () => (await approvalsState(electronApp))[windowId].ready).toBe(true);
  await expect
    .poll(() => {
      docPage = electronApp.windows().find((p) => p.url() === APPROVALS_URL) || null;
      return Boolean(docPage);
    })
    .toBe(true);
  await expect(docPage.locator('#body .field-value').first()).toHaveText('seven');
  expect((await nextReport(electronApp, windowId, sevenReports)).handle).toBe(seven);
  await sleep(PAST_DELAY_MS);
  await docPage.click('#reject');
  await expect.poll(() => outcome(electronApp, guest, 'seven')).toEqual({ code: 4001, message: 'User rejected the request' });
  expect((await decisions(electronApp)).map((d) => [d.tag, d.decision.approve])).toEqual([
    ['one', true],
    ['two', true],
    ['three', true],
    ['four', true],
    ['five', true],
    ['six', true],
    ['seven', false],
  ]);
});
