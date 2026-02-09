const log = require('./logger');
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');

// We'll store bookmarks in the userData directory, separate from the
// read-only default-bookmarks.json that ships with the app.
// To preserve existing behavior, I'll look in userData first, then fallback to app root.

const BOOKMARKS_FILE = 'user-bookmarks.json';

function getBookmarksPath() {
  return path.join(app.getPath('userData'), BOOKMARKS_FILE);
}

function loadBookmarks() {
  const filePath = getBookmarksPath();
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    log.error('Failed to load user bookmarks:', err);
  }

  // Fallback to default bundled bookmarks if user has none
  try {
    // In packaged app, default-bookmarks.json is in resources folder
    // In development, it's at project root
    const isPackaged = app.isPackaged;
    const defaultPath = isPackaged
      ? path.join(process.resourcesPath, 'default-bookmarks.json')
      : path.join(__dirname, '..', '..', 'config', 'default-bookmarks.json');
    if (fs.existsSync(defaultPath)) {
      const data = fs.readFileSync(defaultPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    log.warn('No default bookmarks found');
  }

  return [];
}

function saveBookmarks(bookmarks) {
  try {
    const filePath = getBookmarksPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(bookmarks, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log.error('Failed to save bookmarks:', err);
    return false;
  }
}

function registerBookmarksIpc() {
  ipcMain.handle(IPC.BOOKMARKS_GET, () => {
    return loadBookmarks();
  });

  ipcMain.handle(IPC.BOOKMARKS_ADD, (_event, bookmark) => {
    const current = loadBookmarks();
    // Prevent duplicates by target
    if (current.some((b) => b.target === bookmark.target)) {
      return false;
    }
    const updated = [...current, bookmark];
    return saveBookmarks(updated);
  });

  ipcMain.handle(IPC.BOOKMARKS_UPDATE, (_event, { originalTarget, bookmark }) => {
    const current = loadBookmarks();
    const index = current.findIndex((b) => b.target === originalTarget);
    if (index === -1) {
      return false;
    }
    // Check if new target conflicts with another bookmark (excluding the current one)
    if (bookmark.target !== originalTarget && current.some((b) => b.target === bookmark.target)) {
      return false;
    }
    current[index] = bookmark;
    return saveBookmarks(current);
  });

  ipcMain.handle(IPC.BOOKMARKS_REMOVE, (_event, target) => {
    const current = loadBookmarks();
    const updated = current.filter((b) => b.target !== target);
    return saveBookmarks(updated);
  });
}

module.exports = {
  registerBookmarksIpc,
};
