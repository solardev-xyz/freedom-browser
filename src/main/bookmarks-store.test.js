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
});
