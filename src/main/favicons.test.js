const IPC = require('../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');
const { createNetMock, emitResponse } = require('../../test/helpers/fake-electron-net');

// Minimal favicons-table fake: enough of the better-sqlite3 surface for
// getStatements() (migration is skipped by reporting user_version = 2).
function makeFakeFaviconsDb() {
  const rows = new Map();
  return {
    rows,
    pragma: (statement, options = {}) => {
      if (statement === 'user_version' && options.simple) return 2;
      return null;
    },
    exec: () => {},
    prepare: (sql) => {
      if (/^\s*SELECT/i.test(sql)) {
        return { get: (domain) => rows.get(domain) };
      }
      if (/^\s*INSERT/i.test(sql)) {
        return {
          run: (domain, iconData, contentType, fetchedAt) => {
            rows.set(domain, {
              domain,
              icon_data: iconData,
              content_type: contentType,
              fetched_at: fetchedAt,
            });
            return { changes: 1 };
          },
        };
      }
      return {
        run: (domain) => {
          rows.delete(domain);
          return { changes: 1 };
        },
      };
    },
  };
}

// net.request stub whose requests immediately error out — asserting on
// whether a network fetch was *attempted* is all these tests need.
function makeNetMock() {
  return {
    request: jest.fn(() => {
      const handlers = {};
      return {
        on: (event, cb) => {
          handlers[event] = cb;
        },
        abort: jest.fn(),
        end: () => {
          setImmediate(() => handlers.error?.(new Error('offline (test stub)')));
        },
      };
    }),
  };
}

function loadFavicons(netMock = null) {
  const ipcMain = createIpcMainMock();
  const net = netMock || makeNetMock();
  const fakeDb = makeFakeFaviconsDb();

  const ctx = loadMainModule(require.resolve('./favicons'), {
    ipcMain,
    electronOverrides: { net },
    extraMocks: {
      [require.resolve('./history')]: () => ({ getDb: () => fakeDb }),
      [require.resolve('./private/private-windows')]: () => ({
        isPrivateWebContents: (wc) => wc?.isPrivate === true,
      }),
    },
  });
  ctx.mod.registerFaviconsIpc();
  return { mod: ctx.mod, ipcMain, net, fakeDb };
}

const PRIVATE_EVENT = { sender: { isPrivate: true } };
const NORMAL_EVENT = { sender: { isPrivate: false } };

describe('favicons private-window guard', () => {
  test('favicon:fetch from a private sender never fetches or caches', async () => {
    const { ipcMain, net, fakeDb } = loadFavicons();
    const handler = ipcMain.handlers.get(IPC.FAVICON_FETCH);

    const result = await handler(PRIVATE_EVENT, 'https://secret.example/page');

    expect(result).toBeNull();
    expect(net.request).not.toHaveBeenCalled();
    expect(fakeDb.rows.size).toBe(0);
  });

  test('favicon:fetch from a private sender may return an already-cached icon', async () => {
    const { ipcMain, net, fakeDb } = loadFavicons();
    fakeDb.rows.set('secret.example', {
      domain: 'secret.example',
      icon_data: 'data:image/png;base64,AAAA',
    });

    const handler = ipcMain.handlers.get(IPC.FAVICON_FETCH);
    const result = await handler(PRIVATE_EVENT, 'https://secret.example/page');

    expect(result).toBe('data:image/png;base64,AAAA');
    expect(net.request).not.toHaveBeenCalled();
  });

  test('favicon:fetch-with-key from a private sender never fetches or caches', async () => {
    const { ipcMain, net, fakeDb } = loadFavicons();
    const handler = ipcMain.handlers.get(IPC.FAVICON_FETCH_WITH_KEY);

    const result = await handler(
      PRIVATE_EVENT,
      'http://127.0.0.1:1633/bzz/abc/',
      'bzz://secret.eth'
    );

    expect(result).toBeNull();
    expect(net.request).not.toHaveBeenCalled();
    expect(fakeDb.rows.size).toBe(0);
  });

  test('favicon:get from a private sender degrades to a cache read', async () => {
    const { ipcMain, net } = loadFavicons();
    const handler = ipcMain.handlers.get(IPC.FAVICON_GET);

    const result = await handler(PRIVATE_EVENT, 'https://secret.example/page');

    expect(result).toBeNull();
    expect(net.request).not.toHaveBeenCalled();
  });

  test('favicon:fetch from a normal sender still attempts the network fetch', async () => {
    const { ipcMain, net } = loadFavicons();
    const handler = ipcMain.handlers.get(IPC.FAVICON_FETCH);

    // The stubbed network errors out, so the fetch resolves null — the
    // point is that the fetch was attempted at all.
    const result = await handler(NORMAL_EVENT, 'https://public.example/page');

    expect(net.request).toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('favicon:get-cached stays available to private senders', async () => {
    const { ipcMain, net, fakeDb } = loadFavicons();
    fakeDb.rows.set('public.example', {
      domain: 'public.example',
      icon_data: 'data:image/png;base64,BBBB',
    });

    const handler = ipcMain.handlers.get(IPC.FAVICON_GET_CACHED);
    const result = handler(PRIVATE_EVENT, 'https://public.example/');

    expect(result).toBe('data:image/png;base64,BBBB');
    expect(net.request).not.toHaveBeenCalled();
  });
});

// #75: the module used to fetch the *page* URL itself — with the default
// session, so cookielessly — purely to regex `<link rel="icon">` out of its
// HTML, on top of the webview's own cookied fetch of the same URL. Every
// external navigation therefore hit the server twice, which on stateful
// sites meant a 402/403/rate-limited second GET (found against an x402 test
// server). Chromium already parses the icon link and reports it via
// `page-favicon-updated`; the renderer now passes that URL down, and the
// only request this module makes is for the icon itself.
describe('favicon fetching makes exactly one request and never re-fetches the page (#75)', () => {
  const PAGE = 'https://shop.example/items/42?session=abc';
  const ICON_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

  // Answers any request with a small PNG, and records every URL dialled.
  // `net.request(url)` is called with a plain string here, unlike the
  // options-object form gateway-transport uses.
  const urlOf = (request) =>
    typeof request.options === 'string' ? request.options : request.options?.url;

  function makeServingNet(status = 200) {
    return createNetMock((request) => {
      emitResponse(request, {
        status,
        headers: { 'content-type': 'image/png' },
        chunks: status === 200 ? [ICON_BYTES] : [],
      });
    });
  }

  const dialled = (net) => net.requests.map(urlOf);

  test('fetches the reported icon URL, once, and never the page', async () => {
    const net = makeServingNet();
    const { mod, fakeDb } = loadFavicons(net);

    const result = await mod.fetchFavicon(PAGE, null, 'https://shop.example/brand/icon.png');

    expect(dialled(net)).toEqual(['https://shop.example/brand/icon.png']);
    expect(dialled(net)).not.toContain(PAGE);
    expect(result).toBe(`data:image/png;base64,${ICON_BYTES.toString('base64')}`);
    expect(fakeDb.rows.get('shop.example').icon_data).toBe(result);
  });

  test('falls back to /favicon.ico when the page reported no icon — still one request, still not the page', async () => {
    const net = makeServingNet();
    const { mod } = loadFavicons(net);

    await mod.fetchFavicon(PAGE);

    expect(dialled(net)).toEqual(['https://shop.example/favicon.ico']);
    expect(dialled(net)).not.toContain(PAGE);
  });

  test('a failing icon fetch does not fall back to fetching the page', async () => {
    const net = makeServingNet(404);
    const { mod } = loadFavicons(net);

    const result = await mod.fetchFavicon(PAGE, null, 'https://shop.example/missing.png');

    expect(result).toBeNull();
    expect(dialled(net)).toEqual(['https://shop.example/missing.png']);
  });

  // A non-200 answer abandons the response unread. An `IncomingMessage` is
  // an EventEmitter, so a socket error emitted on it afterwards — the server
  // resetting the connection once the 404's headers are out — is an
  // unhandled `'error'` in the main process, which is a crash rather than a
  // failed favicon fetch (the shape PR #358 fixed on two abandoned-response
  // paths in `src/main/ipfs/gateway-transport.js`).
  test('a non-200 icon response is aborted, and a later error on it cannot crash main', async () => {
    let response = null;
    const net = createNetMock((request) => {
      response = emitResponse(request, { status: 404 });
    });
    const { mod } = loadFavicons(net);

    const result = await mod.fetchFavicon(PAGE, null, 'https://shop.example/missing.png');

    expect(result).toBeNull();
    // The dial is not left running on a body nobody is reading.
    expect(net.requests[0].aborted).toBe(true);
    expect(() => response.emit('error', new Error('net::ERR_CONNECTION_RESET'))).not.toThrow();
  });

  test('a root-relative icon on a gateway path resolves against the content root', async () => {
    const net = makeServingNet();
    const { mod } = loadFavicons(net);

    // Chromium reports absolute URLs; this is the relative-input path the
    // old in-module parser handled, kept so a gateway page's `/icon.png`
    // stays inside its own CID instead of jumping to the gateway root.
    await mod.fetchFavicon(
      'http://127.0.0.1:8080/ipfs/bafycid/docs/index.html',
      'ipfs://bafycid',
      '/icon.png'
    );

    expect(dialled(net)).toEqual(['http://127.0.0.1:8080/ipfs/bafycid/icon.png']);
  });

  test('a document-relative icon resolves against the page URL', async () => {
    const net = makeServingNet();
    const { mod } = loadFavicons(net);

    await mod.fetchFavicon('https://shop.example/items/42', null, 'icon.png');

    expect(dialled(net)).toEqual(['https://shop.example/items/icon.png']);
  });

  test('a data: icon is cached with no request at all', async () => {
    const net = makeServingNet();
    const { mod, fakeDb } = loadFavicons(net);

    const result = await mod.fetchFavicon(PAGE, null, 'data:image/png;base64,AAAA');

    expect(net.request).not.toHaveBeenCalled();
    expect(result).toBe('data:image/png;base64,AAAA');
    expect(fakeDb.rows.get('shop.example').icon_data).toBe(result);
  });

  test('an icon URL on a scheme net.request cannot dial is skipped, not guessed at', async () => {
    const net = makeServingNet();
    const { mod } = loadFavicons(net);

    const result = await mod.fetchFavicon(PAGE, 'bzz://site.eth', 'bzz://site.eth/icon.png');

    expect(result).toBeNull();
    expect(net.request).not.toHaveBeenCalled();
  });

  test('a content-addressed page with no reported icon probes nothing', async () => {
    const net = makeServingNet();
    const { mod } = loadFavicons(net);

    const result = await mod.fetchFavicon(
      'http://127.0.0.1:8080/ipfs/bafycid/index.html',
      'ipfs://bafycid'
    );

    expect(result).toBeNull();
    expect(net.request).not.toHaveBeenCalled();
  });

  test('the fetch-with-key IPC carries the reported icon URL through', async () => {
    const net = makeServingNet();
    const { ipcMain } = loadFavicons(net);
    const handler = ipcMain.handlers.get(IPC.FAVICON_FETCH_WITH_KEY);

    await handler(NORMAL_EVENT, PAGE, 'https://shop.example/', 'https://shop.example/i.png');

    expect(dialled(net)).toEqual(['https://shop.example/i.png']);
  });

  // The renderer pipeline never sends a raw `href`: what reaches this module
  // is whatever Chromium reported, and Chromium resolves both the declared
  // href and the implicit /favicon.ico candidate against the page *origin*
  // first. On a path-gateway load that origin is the gateway, so the reports
  // below are the only shapes a real http(s) dweb page produces (#376).
  describe('reports resolved against a path gateway origin', () => {
    const GATEWAY_PAGE = 'http://127.0.0.1:8080/ipfs/bafycid/docs/index.html';
    const KEY = 'ipfs://bafycid';

    test("a declared root-relative icon is dialled inside the site's CID, not at the gateway root", async () => {
      const net = makeServingNet();
      const { mod, fakeDb } = loadFavicons(net);

      // `<link rel="icon" href="/icon.png">` as Chromium reports it.
      await mod.fetchFavicon(GATEWAY_PAGE, KEY, 'http://127.0.0.1:8080/icon.png');

      expect(dialled(net)).toEqual(['http://127.0.0.1:8080/ipfs/bafycid/icon.png']);
      expect(fakeDb.rows.get('ipfs://bafycid')).toBeDefined();
    });

    test("the implicit /favicon.ico candidate is not probed, and the gateway's own icon is never cached", async () => {
      const net = makeServingNet();
      const { mod, fakeDb } = loadFavicons(net);

      // What a content-addressed page declaring no icon at all produces.
      const result = await mod.fetchFavicon(GATEWAY_PAGE, KEY, 'http://127.0.0.1:8080/favicon.ico');

      expect(result).toBeNull();
      expect(net.request).not.toHaveBeenCalled();
      expect(fakeDb.rows.get('ipfs://bafycid')).toBeUndefined();
    });

    test('an icon already inside the content root is dialled as reported', async () => {
      const net = makeServingNet();
      const { mod } = loadFavicons(net);

      await mod.fetchFavicon(GATEWAY_PAGE, KEY, 'http://127.0.0.1:8080/ipfs/bafycid/docs/i.png');

      expect(dialled(net)).toEqual(['http://127.0.0.1:8080/ipfs/bafycid/docs/i.png']);
    });

    test('an icon naming a gateway path of its own is not prefixed again', async () => {
      const net = makeServingNet();
      const { mod } = loadFavicons(net);

      await mod.fetchFavicon(GATEWAY_PAGE, KEY, 'http://127.0.0.1:8080/ipfs/othercid/i.png');

      expect(dialled(net)).toEqual(['http://127.0.0.1:8080/ipfs/othercid/i.png']);
    });

    test('a cross-origin icon is dialled untouched', async () => {
      const net = makeServingNet();
      const { mod } = loadFavicons(net);

      await mod.fetchFavicon(GATEWAY_PAGE, KEY, 'https://cdn.example/i.png');

      expect(dialled(net)).toEqual(['https://cdn.example/i.png']);
    });

    test('an ordinary http site still dials its own reported /favicon.ico', async () => {
      const net = makeServingNet();
      const { mod } = loadFavicons(net);

      await mod.fetchFavicon(PAGE, null, 'https://shop.example/favicon.ico');

      expect(dialled(net)).toEqual(['https://shop.example/favicon.ico']);
    });
  });
});
