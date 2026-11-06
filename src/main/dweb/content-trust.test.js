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
  labelResponse,
  serveLabelled,
  _resetContentTrust,
} = require('./content-trust');

const HASH = 'ab'.repeat(32);
const PAGE = `bzz://${HASH}/index.html`;

/** A webContents as Electron hands it to a webRequest listener. */
function guest(id) {
  return Object.assign(new EventEmitter(), { id });
}

const details = (overrides = {}) => ({
  url: PAGE,
  resourceType: 'mainFrame',
  webContents: guest(7),
  responseHeaders: {
    'content-type': ['text/html'],
    [CONTENT_TRUST_HEADER]: ['verified'],
  },
  ...overrides,
});

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
    const out = captureContentTrust(details({ webContents: contents }));
    expect(out).toEqual({ responseHeaders: { 'content-type': ['text/html'] } });
    expect(contentTrustFor(7, PAGE)).toBe('verified');
    // The fragment is the page's own: the same document.
    expect(contentTrustFor(7, `${PAGE}#top`)).toBe('verified');
    expect(contentTrustFor(7, `bzz://${HASH}/other.html`)).toBeNull();
    expect(contentTrustFor(8, PAGE)).toBeNull();
  });

  test.each(['subFrame', 'xhr', 'script', 'image', 'other'])(
    "a %s keeps its label to itself: taken off, the tab's unchanged",
    (resourceType) => {
      const contents = guest(7);
      captureContentTrust(details({ webContents: contents }));
      const out = captureContentTrust(
        details({
          url: PAGE,
          resourceType,
          webContents: contents,
          responseHeaders: { 'x-other': ['1'], 'x-freedom-content-trust': ['unverified'] },
        })
      );
      expect(out).toEqual({ responseHeaders: { 'x-other': ['1'] } });
      expect(contentTrustFor(7, PAGE)).toBe('verified');
    }
  );

  test('a request with no webContents (a service worker, main) is only stripped', () => {
    const out = captureContentTrust(details({ webContents: undefined }));
    expect(out.responseHeaders).toEqual({ 'content-type': ['text/html'] });
  });

  test('a main frame with no label, or no valid one, leaves the tab with none', () => {
    const contents = guest(7);
    captureContentTrust(details({ webContents: contents }));
    // The same page reloaded, and answered by main's error page.
    expect(
      captureContentTrust(
        details({ webContents: contents, responseHeaders: { 'content-type': ['text/html'] } })
      )
    ).toBeNull();
    expect(contentTrustFor(7, PAGE)).toBeNull();

    for (const value of [['trusted'], ['verified', 'verified'], 'verified, unverified']) {
      captureContentTrust(details({ webContents: contents }));
      captureContentTrust(
        details({ webContents: contents, responseHeaders: { [CONTENT_TRUST_HEADER]: value } })
      );
      expect(contentTrustFor(7, PAGE)).toBeNull();
    }
    // Two copies under different cases: no label either.
    captureContentTrust(
      details({
        webContents: contents,
        responseHeaders: {
          'X-Freedom-Content-Trust': ['verified'],
          'x-freedom-content-trust': ['verified'],
        },
      })
    );
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });

  test('a plain string value, as some listeners pass it, is read', () => {
    captureContentTrust(details({ responseHeaders: { [CONTENT_TRUST_HEADER]: 'node_asserted' } }));
    expect(contentTrustFor(7, PAGE)).toBe('node_asserted');
  });

  test('ipfs: and ipns: pages too; any other scheme is left alone', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    captureContentTrust(details({ url: `ipfs://${cid}/`, webContents: guest(1) }));
    captureContentTrust(details({ url: 'ipns://example.eth/', webContents: guest(2) }));
    expect(contentTrustFor(1, `ipfs://${cid}/`)).toBe('verified');
    expect(contentTrustFor(2, 'ipns://example.eth/')).toBe('verified');

    for (const url of ['https://example.com/', 'web3://0xabc.eip155-1/', 'rad://z3gq/']) {
      expect(captureContentTrust(details({ url, webContents: guest(3) }))).toBeNull();
      expect(contentTrustFor(3, url)).toBeNull();
    }
  });

  test('a webContents that goes away takes its label with it', () => {
    const contents = guest(7);
    captureContentTrust(details({ webContents: contents }));
    captureContentTrust(details({ webContents: contents }));
    expect(contents.listenerCount('destroyed')).toBe(1);
    contents.emit('destroyed');
    expect(contentTrustFor(7, PAGE)).toBeNull();
  });
});

describe('dweb:get-content-trust', () => {
  function load({ host = 1 } = {}) {
    const guests = new Map([[7, { id: 7, hostWebContents: { id: host } }]]);
    const ctx = loadMainModule(require.resolve('./content-trust'), {
      webContents: { fromId: jest.fn((id) => guests.get(id) || null) },
    });
    ctx.mod.registerContentTrustIpc();
    ctx.mod.captureContentTrust(details({ webContents: guest(7) }));
    const ask = (sender, payload) =>
      ctx.ipcMain.handlers.get(IPC.DWEB_GET_CONTENT_TRUST)({ sender: { id: sender } }, payload);
    return ask;
  }

  test("the chrome that hosts the tab reads the committed page's label", () => {
    const ask = load();
    expect(ask(1, { webContentsId: 7, url: PAGE })).toBe('verified');
    expect(ask(1, { webContentsId: 7, url: `bzz://${HASH}/` })).toBeNull();
  });

  test('anyone else, or a malformed ask, gets nothing', () => {
    const ask = load({ host: 2 });
    expect(ask(1, { webContentsId: 7, url: PAGE })).toBeNull();
    const own = load();
    expect(own(1, { webContentsId: 9, url: PAGE })).toBeNull();
    expect(own(1, { webContentsId: '7x', url: PAGE })).toBeNull();
    expect(own(1, { webContentsId: 7 })).toBeNull();
    expect(own(1, undefined)).toBeNull();
  });
});
