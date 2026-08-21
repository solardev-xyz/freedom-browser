const IPC = require('../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

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

function loadFavicons() {
  const ipcMain = createIpcMainMock();
  const net = makeNetMock();
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
