/**
 * The trust panel's content label on main's side (freedom-core design 0009,
 * Labels): the protocol handlers label each response, the session takes the
 * label off every dweb response and keeps a main frame's for its tab, and
 * the chrome that hosts the tab reads it once the navigation commits.
 */
const { EventEmitter } = require('events');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const IPC = require('../../shared/ipc-channels');

const {
  CONTENT_TRUST_HEADER,
  CONTENT_LABELS,
  captureContentTrust,
  contentTrustFor,
  forgetContentTrustRequest,
  labelResponse,
  serveLabelled,
  trackContentTrustRequest,
  _resetContentTrust,
} = require('./content-trust');

const HASH = 'ab'.repeat(32);
const PAGE = `bzz://${HASH}/index.html`;

/** A webContents as Electron hands it to a webRequest listener. */
function guest(id) {
  return Object.assign(new EventEmitter(), { id });
}

let nextRequestId = 1;

const details = (overrides = {}) => ({
  id: nextRequestId++,
  url: PAGE,
  resourceType: 'mainFrame',
  webContents: guest(7),
  responseHeaders: {
    'content-type': ['text/html'],
    [CONTENT_TRUST_HEADER]: ['verified'],
  },
  ...overrides,
});

/**
 * A main-frame request the tab makes and its response: the session's
 * `onBeforeRequest` sees it, then its headers. Returns what the capture
 * returned.
 */
function load(contents, overrides = {}) {
  const request = details({ webContents: contents, ...overrides });
  expect(trackContentTrustRequest(request)).toBeNull();
  return captureContentTrust(request);
}

/** Electron 45's `did-start-navigation`: the details on the event, and the
 * deprecated positional arguments after it. */
function startNavigation(contents, { isMainFrame = true, isSameDocument = false } = {}) {
  contents.emit(
    'did-start-navigation',
    { url: PAGE, isMainFrame, isSameDocument, frame: null },
    PAGE,
    isSameDocument,
    isMainFrame
  );
}

beforeEach(() => _resetContentTrust());

describe('labelResponse', () => {
  test.each([...CONTENT_LABELS])('labels a response %s', (content) => {
    const res = labelResponse(new Response('x'), { name: null, content });
    expect(res.headers.get(CONTENT_TRUST_HEADER)).toBe(content);
  });

  test("a node's own copy is dropped: no node names its label", async () => {
    const forged = () =>
      new Response('x', { headers: { [CONTENT_TRUST_HEADER]: 'verified', 'content-type': 'a/b' } });
    const relabelled = labelResponse(forged(), { name: null, content: 'unverified' });
    expect(relabelled.headers.get(CONTENT_TRUST_HEADER)).toBe('unverified');
    expect(relabelled.headers.get('content-type')).toBe('a/b');
    // No trust (main's own answer), or a value that is no label: none.
    expect(labelResponse(forged(), null).headers.has(CONTENT_TRUST_HEADER)).toBe(false);
    const odd = labelResponse(forged(), { content: 'trusted' });
    expect(odd.headers.has(CONTENT_TRUST_HEADER)).toBe(false);
    await expect(odd.text()).resolves.toBe('x');
  });

  test('headers that cannot change: the response is rebuilt over its body', async () => {
    const immutable = await fetch('data:text/plain,hello');
    expect(() => immutable.headers.set('x', 'y')).toThrow();
    const res = labelResponse(immutable, { content: 'node_asserted' });
    expect(res).not.toBe(immutable);
    expect(res.status).toBe(200);
    expect(res.headers.get(CONTENT_TRUST_HEADER)).toBe('node_asserted');
    expect(res.headers.get('content-type')).toBe('text/plain');
    await expect(res.text()).resolves.toBe('hello');
  });
});

describe('serveLabelled', () => {
  test("the handler's onTrust labels the response it returns", async () => {
    const res = await serveLabelled(async (onTrust) => {
      onTrust({ name: null, content: 'latest_asserted' });
      return new Response('x');
    });
    expect(res.headers.get(CONTENT_TRUST_HEADER)).toBe('latest_asserted');
  });

  test('a handler that never calls it answers with no label', async () => {
    const res = await serveLabelled(
      async () =>
        new Response('{}', { status: 502, headers: { [CONTENT_TRUST_HEADER]: 'verified' } })
    );
    expect(res.headers.has(CONTENT_TRUST_HEADER)).toBe(false);
  });
});

describe('captureContentTrust', () => {
  test("a main frame's label is kept for its webContents, and the header taken off", () => {
    const contents = guest(7);
    const out = load(contents);
    expect(out).toEqual({ responseHeaders: { 'content-type': ['text/html'] } });
    expect(contentTrustFor(8, PAGE)).toBeNull();
    expect(contentTrustFor(7, PAGE)).toBe('verified');
    // The fragment is the page's own: the same document.
    load(contents);
    expect(contentTrustFor(7, `${PAGE}#top`)).toBe('verified');
    load(contents);
    expect(contentTrustFor(7, `bzz://${HASH}/other.html`)).toBeNull();
  });

  test.each(['subFrame', 'xhr', 'script', 'image', 'other'])(
    "a %s keeps its label to itself: taken off, the tab's unchanged",
    (resourceType) => {
      const contents = guest(7);
      load(contents);
      const out = load(contents, {
        resourceType,
        responseHeaders: { 'x-other': ['1'], 'x-freedom-content-trust': ['unverified'] },
      });
      expect(out).toEqual({ responseHeaders: { 'x-other': ['1'] } });
      expect(contentTrustFor(7, PAGE)).toBe('verified');
    }
  );

  test('a request with no webContents (a service worker, main) is only stripped', () => {
    const out = load(undefined);
    expect(out.responseHeaders).toEqual({ 'content-type': ['text/html'] });
  });

  test('a main frame with no label, or no valid one, leaves the tab with none', () => {
    const contents = guest(7);
    load(contents);
    // The same page reloaded, and answered by main's error page.
    startNavigation(contents);
    expect(load(contents, { responseHeaders: { 'content-type': ['text/html'] } })).toBeNull();
    expect(contentTrustFor(7, PAGE)).toBeNull();

    for (const value of [['trusted'], ['verified', 'verified'], 'verified, unverified']) {
      load(contents);
      load(contents, { responseHeaders: { [CONTENT_TRUST_HEADER]: value } });
      expect(contentTrustFor(7, PAGE)).toBeNull();
    }
    // Two copies under different cases: no label either.
    load(contents, {
      responseHeaders: {
        'X-Freedom-Content-Trust': ['verified'],
        'x-freedom-content-trust': ['verified'],
      },
    });
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });

  test('a plain string value, as some listeners pass it, is read', () => {
    load(guest(7), { responseHeaders: { [CONTENT_TRUST_HEADER]: 'node_asserted' } });
    expect(contentTrustFor(7, PAGE)).toBe('node_asserted');
  });

  test('ipfs: and ipns: pages too; any other scheme is left alone', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    load(guest(1), { url: `ipfs://${cid}/` });
    load(guest(2), { url: 'ipns://example.eth/' });
    expect(contentTrustFor(1, `ipfs://${cid}/`)).toBe('verified');
    expect(contentTrustFor(2, 'ipns://example.eth/')).toBe('verified');

    for (const url of ['https://example.com/', 'web3://0xabc.eip155-1/', 'rad://z3gq/']) {
      expect(load(guest(3), { url })).toBeNull();
      expect(contentTrustFor(3, url)).toBeNull();
    }
  });

  test('a webContents that goes away takes its label with it', () => {
    const contents = guest(7);
    load(contents);
    load(contents);
    expect(contents.listenerCount('destroyed')).toBe(1);
    expect(contents.listenerCount('did-start-navigation')).toBe(1);
    contents.emit('destroyed');
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });
});

// Codex's review of #1010, finding 1: a same-URL document that no dweb
// response answers (a service worker's) read the earlier document's label.
describe('one label per navigation', () => {
  test('the read takes the label: a second same-URL commit with no response reads none', () => {
    const contents = guest(7);
    load(contents);
    expect(contentTrustFor(7, PAGE)).toBe('verified');
    // A service worker answers the same URL again: the navigation starts,
    // and no main-frame response is seen.
    startNavigation(contents);
    expect(contentTrustFor(7, PAGE)).toBeNull();
    // Even with no start seen, a label is read once.
    load(contents);
    expect(contentTrustFor(7, PAGE)).toBe('verified');
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });

  test('a navigation start forgets a label not yet read', () => {
    const contents = guest(7);
    load(contents);
    startNavigation(contents);
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });

  test("a same-document navigation, or a subframe's, keeps it", () => {
    const contents = guest(7);
    load(contents);
    startNavigation(contents, { isSameDocument: true });
    startNavigation(contents, { isMainFrame: false });
    expect(contentTrustFor(7, PAGE)).toBe('verified');
  });

  test("without the event's details, the positional arguments decide", () => {
    const contents = guest(7);
    load(contents);
    // (event, url, isInPlace, isMainFrame)
    contents.emit('did-start-navigation', {}, PAGE, true, true);
    contents.emit('did-start-navigation', {}, PAGE, false, false);
    expect(contentTrustFor(7, PAGE)).toBe('verified');
    load(contents);
    contents.emit('did-start-navigation', {}, PAGE, false, true);
    expect(contentTrustFor(7, PAGE)).toBeNull();
    // Neither: a new document is assumed.
    load(contents);
    contents.emit('did-start-navigation', {});
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });

  test("a response to an earlier navigation's request, landing after a later start, is ignored", () => {
    const contents = guest(7);
    const older = details({ webContents: contents });
    trackContentTrustRequest(older);
    startNavigation(contents);
    // The later navigation is a service worker's: no request of its own.
    expect(captureContentTrust(older)).toEqual({
      responseHeaders: { 'content-type': ['text/html'] },
    });
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });

  test("nor can it replace the later navigation's label, before or after the read", () => {
    const contents = guest(7);
    const older = details({ webContents: contents });
    const late = details({ webContents: contents });
    trackContentTrustRequest(older);
    trackContentTrustRequest(late);
    startNavigation(contents);
    load(contents, { responseHeaders: { [CONTENT_TRUST_HEADER]: 'unverified' } });
    captureContentTrust(older);
    expect(contentTrustFor(7, PAGE)).toBe('unverified');
    captureContentTrust(late);
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });

  test('a redirect keeps its request in the navigation it started in', () => {
    const contents = guest(7);
    const target = `bzz://${HASH}/landing.html`;
    const request = details({ webContents: contents, url: `bzz://${HASH}/` });
    trackContentTrustRequest(request);
    // The next leg, same request: still this navigation's.
    trackContentTrustRequest({ ...request, url: target });
    captureContentTrust({ ...request, url: target });
    expect(contentTrustFor(7, target)).toBe('verified');

    // A leg seen again after a later navigation started stays the earlier
    // one's: it can't replace the later navigation's label.
    const older = details({ webContents: contents });
    trackContentTrustRequest(older);
    startNavigation(contents);
    load(contents, { url: target, responseHeaders: { [CONTENT_TRUST_HEADER]: 'unverified' } });
    trackContentTrustRequest({ ...older, url: target });
    captureContentTrust({ ...older, url: target });
    expect(contentTrustFor(7, target)).toBe('unverified');
  });

  test('a request the session never saw start, or one already over, labels nothing', () => {
    const contents = guest(7);
    load(contents);
    const forged = { [CONTENT_TRUST_HEADER]: ['unverified'] };
    // Headers with no onBeforeRequest before them: stripped, not kept.
    expect(
      captureContentTrust(details({ webContents: contents, responseHeaders: forged }))
    ).toEqual({ responseHeaders: {} });
    const request = details({ webContents: contents, responseHeaders: forged });
    trackContentTrustRequest(request);
    forgetContentTrustRequest(request);
    captureContentTrust(request);
    expect(contentTrustFor(7, PAGE)).toBe('verified');
  });

  test("only a tab's main-frame dweb request is tracked", () => {
    const contents = guest(7);
    for (const overrides of [
      { resourceType: 'subFrame' },
      { url: 'https://example.com/' },
      { webContents: undefined },
      { id: undefined },
    ]) {
      const request = details({ webContents: contents, ...overrides });
      expect(trackContentTrustRequest(request)).toBeNull();
    }
    expect(contents.listenerCount('did-start-navigation')).toBe(0);
    expect(() => forgetContentTrustRequest(details({ webContents: guest(9) }))).not.toThrow();
  });

  test('installs on the four webRequest events, under one name', () => {
    jest.isolateModules(() => {
      const dispatcher = require('../webrequest-dispatcher');
      const register = jest
        .spyOn(dispatcher, 'registerWebRequestHandler')
        .mockImplementation(() => {});
      const mod = require('./content-trust');
      mod.installContentTrustCapture();
      expect(register.mock.calls).toEqual([
        ['onBeforeRequest', 'dweb-content-trust', mod.trackContentTrustRequest],
        ['onHeadersReceived', 'dweb-content-trust', mod.captureContentTrust],
        ['onCompleted', 'dweb-content-trust', mod.forgetContentTrustRequest],
        ['onErrorOccurred', 'dweb-content-trust', mod.forgetContentTrustRequest],
      ]);
      register.mockRestore();
    });
  });
});

describe('dweb:get-content-trust', () => {
  function load({ host = 1 } = {}) {
    const guests = new Map([[7, { id: 7, hostWebContents: { id: host } }]]);
    const ctx = loadMainModule(require.resolve('./content-trust'), {
      webContents: { fromId: jest.fn((id) => guests.get(id) || null) },
    });
    ctx.mod.registerContentTrustIpc();
    const request = details({ webContents: guest(7) });
    ctx.mod.trackContentTrustRequest(request);
    ctx.mod.captureContentTrust(request);
    const ask = (sender, payload) =>
      ctx.ipcMain.handlers.get(IPC.DWEB_GET_CONTENT_TRUST)({ sender: { id: sender } }, payload);
    return ask;
  }

  test("the chrome that hosts the tab reads the committed page's label, once", () => {
    const ask = load();
    expect(ask(1, { webContentsId: 7, url: PAGE })).toBe('verified');
    expect(ask(1, { webContentsId: 7, url: PAGE })).toBeNull();
    expect(load()(1, { webContentsId: 7, url: `bzz://${HASH}/` })).toBeNull();
  });

  test('anyone else, or a malformed ask, gets nothing, and takes nothing', () => {
    const ask = load({ host: 2 });
    expect(ask(1, { webContentsId: 7, url: PAGE })).toBeNull();
    const own = load();
    expect(own(1, { webContentsId: 9, url: PAGE })).toBeNull();
    expect(own(1, { webContentsId: '7x', url: PAGE })).toBeNull();
    expect(own(1, { webContentsId: 7 })).toBeNull();
    expect(own(1, undefined)).toBeNull();
    // The host still reads it.
    expect(ask(2, { webContentsId: 7, url: PAGE })).toBe('verified');
  });
});
