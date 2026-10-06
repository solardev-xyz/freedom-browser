const fs = require('fs');
const path = require('path');
const IPC = require('../shared/ipc-channels');
const defaultBookmarks = require('../../config/default-bookmarks.json');
const {
  createIpcMainMock,
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

function loadBookmarksStore(options = {}) {
  return loadMainModule(require.resolve('./bookmarks-store'), options);
}

function getUserBookmarksPath(userDataDir) {
  return path.join(userDataDir, 'user-bookmarks.json');
}

describe('bookmarks-store', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  test('falls back to bundled default bookmarks when the user file is missing', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadBookmarksStore({ userDataDir, ipcMain });

    mod.registerBookmarksIpc();

    await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual(defaultBookmarks);
  });

  test('loads user bookmarks before bundled defaults', async () => {
    const ipcMain = createIpcMainMock();
    const customBookmarks = [{ label: 'Local', target: 'https://example.com' }];

    fs.writeFileSync(
      getUserBookmarksPath(userDataDir),
      JSON.stringify(customBookmarks, null, 2),
      'utf-8'
    );

    const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
    mod.registerBookmarksIpc();

    await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual(customBookmarks);
  });

  test('adds bookmarks and prevents duplicate targets', async () => {
    const ipcMain = createIpcMainMock();
    const bookmark = { label: 'Example', target: 'https://example.com' };

    fs.writeFileSync(getUserBookmarksPath(userDataDir), '[]', 'utf-8');

    const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
    mod.registerBookmarksIpc();

    await expect(ipcMain.invoke(IPC.BOOKMARKS_ADD, bookmark)).resolves.toBe(true);
    await expect(ipcMain.invoke(IPC.BOOKMARKS_ADD, bookmark)).resolves.toBe(false);

    expect(
      JSON.parse(fs.readFileSync(getUserBookmarksPath(userDataDir), 'utf-8'))
    ).toEqual([bookmark]);
  });

  test('updates bookmarks and rejects target conflicts', async () => {
    const ipcMain = createIpcMainMock();
    const initialBookmarks = [
      { label: 'One', target: 'https://one.example' },
      { label: 'Two', target: 'https://two.example' },
    ];

    fs.writeFileSync(
      getUserBookmarksPath(userDataDir),
      JSON.stringify(initialBookmarks, null, 2),
      'utf-8'
    );

    const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
    mod.registerBookmarksIpc();

    await expect(
      ipcMain.invoke(IPC.BOOKMARKS_UPDATE, {
        originalTarget: 'https://one.example',
        bookmark: { label: 'Conflict', target: 'https://two.example' },
      })
    ).resolves.toBe(false);

    await expect(
      ipcMain.invoke(IPC.BOOKMARKS_UPDATE, {
        originalTarget: 'https://one.example',
        bookmark: { label: 'Updated', target: 'https://updated.example' },
      })
    ).resolves.toBe(true);

    expect(
      JSON.parse(fs.readFileSync(getUserBookmarksPath(userDataDir), 'utf-8'))
    ).toEqual([
      { label: 'Updated', target: 'https://updated.example' },
      { label: 'Two', target: 'https://two.example' },
    ]);
  });

  test('removes bookmarks by target', async () => {
    const ipcMain = createIpcMainMock();
    const initialBookmarks = [
      { label: 'One', target: 'https://one.example' },
      { label: 'Two', target: 'https://two.example' },
    ];

    fs.writeFileSync(
      getUserBookmarksPath(userDataDir),
      JSON.stringify(initialBookmarks, null, 2),
      'utf-8'
    );

    const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
    mod.registerBookmarksIpc();

    await expect(ipcMain.invoke(IPC.BOOKMARKS_REMOVE, 'https://one.example')).resolves.toBe(
      true
    );

    expect(
      JSON.parse(fs.readFileSync(getUserBookmarksPath(userDataDir), 'utf-8'))
    ).toEqual([{ label: 'Two', target: 'https://two.example' }]);
  });

  // #503: bookmarks:get runs after every navigation (address-bar suggestions);
  // it answers from memory instead of re-reading the file each time.
  describe('in-memory cache', () => {
    const seed = (bookmarks) =>
      fs.writeFileSync(getUserBookmarksPath(userDataDir), JSON.stringify(bookmarks), 'utf-8');

    test('reads the file once, not on every get', async () => {
      const ipcMain = createIpcMainMock();
      seed([{ label: 'One', target: 'https://one.example' }]);
      const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
      mod.registerBookmarksIpc();
      const readSpy = jest.spyOn(fs, 'readFileSync');
      try {
        for (let i = 0; i < 5; i++) {
          await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual([
            { label: 'One', target: 'https://one.example' },
          ]);
        }
        const bookmarkReads = readSpy.mock.calls.filter(([file]) =>
          String(file).endsWith('user-bookmarks.json')
        );
        expect(bookmarkReads).toHaveLength(1);
      } finally {
        readSpy.mockRestore();
      }
    });

    test('every write updates what get returns', async () => {
      const ipcMain = createIpcMainMock();
      seed([{ label: 'One', target: 'https://one.example' }]);
      const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
      mod.registerBookmarksIpc();
      await ipcMain.invoke(IPC.BOOKMARKS_GET);

      await ipcMain.invoke(IPC.BOOKMARKS_ADD, { label: 'Two', target: 'https://two.example' });
      await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual([
        { label: 'One', target: 'https://one.example' },
        { label: 'Two', target: 'https://two.example' },
      ]);
      await ipcMain.invoke(IPC.BOOKMARKS_UPDATE, {
        originalTarget: 'https://one.example',
        bookmark: { label: 'Uno', target: 'https://one.example' },
      });
      await ipcMain.invoke(IPC.BOOKMARKS_REORDER, ['https://two.example', 'https://one.example']);
      await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual([
        { label: 'Two', target: 'https://two.example' },
        { label: 'Uno', target: 'https://one.example' },
      ]);
      await ipcMain.invoke(IPC.BOOKMARKS_REMOVE, 'https://two.example');
      await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual([
        { label: 'Uno', target: 'https://one.example' },
      ]);
      // And the file agrees with memory.
      expect(JSON.parse(fs.readFileSync(getUserBookmarksPath(userDataDir), 'utf-8'))).toEqual([
        { label: 'Uno', target: 'https://one.example' },
      ]);
    });

    test('a refused update leaves the cached list untouched', async () => {
      const ipcMain = createIpcMainMock();
      seed([
        { label: 'One', target: 'https://one.example' },
        { label: 'Two', target: 'https://two.example' },
      ]);
      const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
      mod.registerBookmarksIpc();
      const first = await ipcMain.invoke(IPC.BOOKMARKS_GET);
      // The handler gets its own copy to modify: mutating it changes nothing.
      first.pop();
      await expect(
        ipcMain.invoke(IPC.BOOKMARKS_UPDATE, {
          originalTarget: 'https://one.example',
          bookmark: { label: 'Clash', target: 'https://two.example' },
        })
      ).resolves.toBe(false);
      await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual([
        { label: 'One', target: 'https://one.example' },
        { label: 'Two', target: 'https://two.example' },
      ]);
    });

    test('a failed write drops the cache so the next get reads the file', async () => {
      const ipcMain = createIpcMainMock();
      seed([{ label: 'One', target: 'https://one.example' }]);
      const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
      mod.registerBookmarksIpc();
      await ipcMain.invoke(IPC.BOOKMARKS_GET);

      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      try {
        await expect(
          ipcMain.invoke(IPC.BOOKMARKS_ADD, { label: 'Two', target: 'https://two.example' })
        ).resolves.toBe(false);
      } finally {
        writeSpy.mockRestore();
      }
      // What is on disk now is unknown to the store; it must look again.
      seed([{ label: 'On disk', target: 'https://disk.example' }]);
      await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual([
        { label: 'On disk', target: 'https://disk.example' },
      ]);
    });
  });

  // #307: the bar reorders by drag, and the store is the order it renders.
  describe('reorder', () => {
    const seed = (userDataDir, bookmarks) =>
      fs.writeFileSync(
        getUserBookmarksPath(userDataDir),
        JSON.stringify(bookmarks, null, 2),
        'utf-8'
      );

    const initialBookmarks = [
      { label: 'One', target: 'https://one.example' },
      { label: 'Two', target: 'https://two.example' },
      { label: 'Three', target: 'https://three.example' },
    ];

    test('writes the bar order the renderer sends', async () => {
      const ipcMain = createIpcMainMock();
      seed(userDataDir, initialBookmarks);

      const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
      mod.registerBookmarksIpc();

      await expect(
        ipcMain.invoke(IPC.BOOKMARKS_REORDER, [
          'https://three.example',
          'https://one.example',
          'https://two.example',
        ])
      ).resolves.toBe(true);

      expect(
        JSON.parse(fs.readFileSync(getUserBookmarksPath(userDataDir), 'utf-8')).map(
          (bookmark) => bookmark.target
        )
      ).toEqual(['https://three.example', 'https://one.example', 'https://two.example']);
      // The entries themselves are untouched — only their order moved.
      await expect(ipcMain.invoke(IPC.BOOKMARKS_GET)).resolves.toEqual([
        { label: 'Three', target: 'https://three.example' },
        { label: 'One', target: 'https://one.example' },
        { label: 'Two', target: 'https://two.example' },
      ]);
    });

    test('keeps an entry the renderer never saw rather than dropping it', async () => {
      const ipcMain = createIpcMainMock();
      seed(userDataDir, initialBookmarks);

      const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
      mod.registerBookmarksIpc();

      // The renderer's list predates "Three" (added from another window).
      await expect(
        ipcMain.invoke(IPC.BOOKMARKS_REORDER, ['https://two.example', 'https://one.example'])
      ).resolves.toBe(true);

      expect(
        JSON.parse(fs.readFileSync(getUserBookmarksPath(userDataDir), 'utf-8')).map(
          (bookmark) => bookmark.target
        )
      ).toEqual(['https://two.example', 'https://one.example', 'https://three.example']);
    });

    test('refuses a payload that is not a list of known targets', async () => {
      const ipcMain = createIpcMainMock();
      seed(userDataDir, initialBookmarks);

      const { mod } = loadBookmarksStore({ userDataDir, ipcMain });
      mod.registerBookmarksIpc();

      await expect(ipcMain.invoke(IPC.BOOKMARKS_REORDER, 'not-a-list')).resolves.toBe(false);
      // A duplicate cannot be used to push a bookmark out of the list.
      await expect(
        ipcMain.invoke(IPC.BOOKMARKS_REORDER, [
          'https://one.example',
          'https://one.example',
          'https://two.example',
        ])
      ).resolves.toBe(true);

      expect(
        JSON.parse(fs.readFileSync(getUserBookmarksPath(userDataDir), 'utf-8')).map(
          (bookmark) => bookmark.target
        )
      ).toEqual(['https://one.example', 'https://two.example', 'https://three.example']);
    });
  });
});
