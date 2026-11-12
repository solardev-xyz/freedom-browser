// Main sees a new document's commit before that document's first message
// (freedom-core design 0011, "Documents", step PRQ-1), in real Electron.
//
// Main numbers each committed main-frame document of a tab guest
// (`did-frame-navigate`), and binds the nonce the document's preload sends
// with its first message, the hello. That holds only if main sees the commit
// first: a hello that arrived before it would land on the previous number,
// which already has its nonce, and be ignored, so the new document's requests
// would be refused. The probe of 2026-09-28 showed the order to the embedder
// (`guest-main-frame.js`); this spec repeats it in main, for main's own module
// (src/main/page/page-documents.js), across a same-process navigation, a
// cross-process one, a reload, and back and forward. It also records whether a
// back/forward traversal restored a page from the back/forward cache (which
// would keep the old preload and send no hello), that a sub-frame's hello and
// request are refused, from the real `senderFrame`, that a cancelled load
// keeps the document, and that an error page, which Electron commits without a
// `did-frame-navigate`, ends it.
//
// The app's preload sends no hello yet (PRQ-2 adds it), so a test-only session
// preload (page-documents-hello-preload.js) sends one, at the same point a
// preload runs. The spec feeds its messages to the module from the guest's
// `ipc-message` event, which main emits in the same turn as `ipcMain`'s.

const path = require('path');
const { test, expect } = require('./fixtures');

const A = `bzz://${'d'.repeat(64)}`;
const B = `bzz://${'e'.repeat(64)}`;
const FRAME = `bzz://${'f'.repeat(64)}/frame`;
const HELLO_PRELOAD = path.join(__dirname, 'page-documents-hello-preload.js');
const ROOT = path.resolve(__dirname, '..');

const html = (title, extra = '') => ({
  contentType: 'text/html; charset=utf-8',
  body:
    `<!doctype html><title>${title}</title>` +
    "<script>addEventListener('pageshow', (e) => { window.__persisted = e.persisted; });</script>" +
    `<h1>${title}</h1>${extra}`,
});

/** Track the guest with main's module, and log its commits, hellos and requests. */
async function instrument(electronApp, guestId) {
  await electronApp.evaluate(
    ({ webContents }, { root, preload, id }) => {
      const { createPageDocuments } = process.mainModule.require(`${root}/src/main/page/page-documents`);
      const documents = createPageDocuments();
      const log = [];
      globalThis.__pageDocumentsLog = log;
      const guest = webContents.fromId(id);
      documents.track(guest);
      guest.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame, processId) => {
        if (isMainFrame) log.push({ kind: 'commit', url, processId });
      });
      guest.on('did-fail-provisional-load', (_event, code, _description, url, isMainFrame) => {
        if (isMainFrame) log.push({ kind: 'error-page', url, code });
      });
      guest.on('ipc-message', (event, channel, payload) => {
        if (channel === 'page-documents-test:hello') {
          log.push({ kind: 'hello', href: payload.href, top: payload.top, result: documents.hello(event, payload) });
        } else if (channel === 'page-documents-test:request') {
          const entry = { kind: 'request', href: payload.href, top: payload.top, result: null };
          log.push(entry);
          documents.attest(event, payload.nonce).then((result) => {
            entry.result = result.ok
              ? { ok: true, navigation: result.requester.navigation, key: result.requester.key, url: result.requester.url }
              : result;
          });
        }
      });
      guest.session.registerPreloadScript({ type: 'frame', id: 'page-documents-test-hello', filePath: preload });
    },
    { root: ROOT, preload: HELLO_PRELOAD, id: guestId }
  );
}

const readLog = (electronApp) => electronApp.evaluate(() => globalThis.__pageDocumentsLog.slice());

/**
 * Run `navigate({ id, url })` in main and wait for the top document at `href`
 * (`url` by default) to have said hello and had its request answered.
 * Returns the log entries since.
 */
async function step(electronApp, guestId, url, navigate, href = url) {
  const from = (await readLog(electronApp)).length;
  await electronApp.evaluate(navigate, { id: guestId, url });
  let entries = [];
  await expect
    .poll(
      async () => {
        entries = (await readLog(electronApp)).slice(from);
        return entries.some((e) => e.kind === 'request' && e.top && e.href === href && e.result);
      },
      { message: `waiting for ${href} to say hello and send its request`, timeout: 20_000 }
    )
    .toBe(true);
  return entries;
}

/** The commit came first, the hello bound the new number, and the request attested under it. */
function expectBound(entries, url, previous) {
  const commit = entries.findIndex((e) => e.kind === 'commit' && e.url === url);
  const hello = entries.findIndex((e) => e.kind === 'hello' && e.top && e.href === url);
  const request = entries.find((e) => e.kind === 'request' && e.top && e.href === url);
  expect(commit, `the commit of ${url}`).toBeGreaterThanOrEqual(0);
  expect(hello, `the hello of ${url} after its commit`).toBeGreaterThan(commit);
  const { result } = entries[hello];
  expect(result, `the hello of ${url}`).toEqual({ ok: true, navigation: expect.any(Number) });
  if (previous) expect(result.navigation).toBeGreaterThan(previous.navigation);
  expect(request.result).toEqual({ ok: true, navigation: result.navigation, key: expect.any(String), url });
  return { navigation: result.navigation, processId: entries[commit].processId };
}

const inPage = (win, js) =>
  win.evaluate((code) => document.querySelector('webview:not(.hidden)').executeJavaScript(code), js);

test('main sees each new document\'s commit before its hello (0011 PRQ-1)', async ({
  window: win,
  electronApp,
  harness,
}) => {
  test.setTimeout(120_000);
  await harness.setContentFixture(`${A}/one`, html('A one', `<iframe src="${FRAME}"></iframe>`));
  await harness.setContentFixture(`${A}/two`, html('A two'));
  await harness.setContentFixture(`${B}/`, html('B'));
  await harness.setContentFixture(FRAME, html('frame'));

  const guestId = await win.evaluate(() => document.querySelector('webview:not(.hidden)').getWebContentsId());
  await instrument(electronApp, guestId);

  const load = ({ webContents }, { id, url }) => {
    webContents.fromId(id).loadURL(url).catch(() => {});
  };

  // The first document, with a cross-site iframe whose preload says hello too.
  let entries = await step(electronApp, guestId, `${A}/one`, load);
  const one = expectBound(entries, `${A}/one`);
  await expect
    .poll(async () => (await readLog(electronApp)).filter((e) => !e.top && e.href === FRAME && (e.kind === 'hello' || e.result)).length, {
      message: 'the iframe said hello and sent its request',
      timeout: 10_000,
    })
    .toBe(2);
  const frameEntries = (await readLog(electronApp)).filter((e) => !e.top && e.href === FRAME);
  expect(frameEntries.find((e) => e.kind === 'hello').result).toEqual({ ok: false, reason: 'sub-frame' });
  expect(frameEntries.find((e) => e.kind === 'request').result).toEqual({ ok: false, reason: 'sub-frame' });

  // Same process: another page of the same site.
  entries = await step(electronApp, guestId, `${A}/two`, load);
  const two = expectBound(entries, `${A}/two`, one);
  expect(two.processId, 'same-site navigation stays in its process').toBe(one.processId);

  // Cross-process: another site.
  entries = await step(electronApp, guestId, `${B}/`, load);
  const b = expectBound(entries, `${B}/`, two);
  expect(b.processId, 'cross-site navigation changes process').not.toBe(two.processId);

  // A reload.
  entries = await step(electronApp, guestId, `${B}/`, ({ webContents }, { id }) => {
    webContents.fromId(id).reload();
  });
  const reloaded = expectBound(entries, `${B}/`, b);

  // Back, across processes, then forward again.
  entries = await step(electronApp, guestId, `${A}/two`, ({ webContents }, { id }) => {
    webContents.fromId(id).navigationHistory.goBack();
  });
  const back = expectBound(entries, `${A}/two`, reloaded);
  expect(await inPage(win, 'window.__persisted'), 'back was not a back/forward cache restore').toBe(false);

  entries = await step(electronApp, guestId, `${B}/`, ({ webContents }, { id }) => {
    webContents.fromId(id).navigationHistory.goForward();
  });
  const forward = expectBound(entries, `${B}/`, back);
  expect(await inPage(win, 'window.__persisted'), 'forward was not a back/forward cache restore').toBe(false);

  // No top-frame hello in the whole run was refused: none landed before its commit.
  const refused = (await readLog(electronApp)).filter((e) => e.kind === 'hello' && e.top && !e.result.ok);
  expect(refused).toEqual([]);

  // A load cancelled before it commits keeps the document: its next request
  // still attests under the same number.
  await harness.setContentFixture(`${A}/slow`, { ...html('slow'), delayMs: 10_000 });
  const beforeStop = (await readLog(electronApp)).length;
  await electronApp.evaluate(load, { id: guestId, url: `${A}/slow` });
  await win.waitForTimeout(500);
  await electronApp.evaluate(({ webContents }, { id }) => {
    const guest = webContents.fromId(id);
    guest.stop();
    guest.mainFrame.send('page-documents-test:ask');
  }, { id: guestId });
  await expect
    .poll(async () => (await readLog(electronApp)).slice(beforeStop).some((e) => e.kind === 'request' && e.result), {
      message: 'the current document answered after the cancelled load',
      timeout: 10_000,
    })
    .toBe(true);
  entries = (await readLog(electronApp)).slice(beforeStop);
  expect(entries.filter((e) => e.kind === 'commit' || e.kind === 'error-page')).toEqual([]);
  expect(entries.find((e) => e.kind === 'request').result).toEqual({
    ok: true,
    navigation: forward.navigation,
    key: B,
    url: `${B}/`,
  });

  // An error page replaces the document with no `did-frame-navigate`: Electron
  // reports `did-fail-provisional-load` instead, and the error page's own
  // preload says hello too. Main ends the document there, so that hello finds
  // none, and nothing the error page sends is attested. A redirect from a
  // dweb page to a file: URL is refused (ERR_UNSAFE_REDIRECT), which commits
  // the error page.
  const ERROR_PAGE = 'chrome-error://chromewebdata/';
  await harness.setContentFixture(`${B}/gone`, {
    status: 302,
    headers: { Location: 'file:///nonexistent' },
    body: '',
  });
  entries = await step(electronApp, guestId, `${B}/gone`, load, ERROR_PAGE);
  const failed = entries.findIndex((e) => e.kind === 'error-page' && e.url === `${B}/gone`);
  const errorHello = entries.findIndex((e) => e.kind === 'hello' && e.top && e.href === ERROR_PAGE);
  expect(failed, 'the error page commit').toBeGreaterThanOrEqual(0);
  expect(entries.slice(0, failed).some((e) => e.kind === 'commit'), 'no did-frame-navigate for it').toBe(false);
  expect(errorHello, 'the error page\'s hello after its commit').toBeGreaterThan(failed);
  expect(entries[errorHello].result).toEqual({ ok: false, reason: 'no-document' });
  expect(entries.find((e) => e.kind === 'request' && e.top && e.href === ERROR_PAGE).result).toEqual({
    ok: false,
    reason: 'no-document',
  });
});
