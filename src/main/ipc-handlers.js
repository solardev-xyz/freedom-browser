const log = require('./logger');
const { ipcMain, app, dialog, clipboard, nativeImage } = require('electron');
const { URL } = require('url');
const path = require('path');
const { activeBzzBases, activeIpfsBases } = require('./state');
const { fetchBuffer, fetchToFile } = require('./http-fetch');
const IPC = require('../shared/ipc-channels');

// Path to webview preload script (for internal pages)
const webviewPreloadPath = path.join(__dirname, 'webview-preload.js');

// Canonical internal-pages list (shared with preloads via sync IPC)
const internalPages = require('../shared/internal-pages.json');

const isAllowedBaseUrl = (value) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
};

const formatWindowTitle = (title) => {
  return title?.trim() ? `${title.trim()} - Freedom` : 'Freedom';
};

function registerBaseIpcHandlers(callbacks = {}) {
  ipcMain.handle(IPC.BZZ_SET_BASE, (_event, payload = {}) => {
    const { webContentsId, baseUrl } = payload;
    if (!webContentsId || !baseUrl) {
      return;
    }
    if (!isAllowedBaseUrl(baseUrl)) {
      log.warn('[ipc] Rejecting non-local bzz base URL');
      return;
    }
    try {
      const normalized = new URL(baseUrl);
      activeBzzBases.set(webContentsId, normalized);
    } catch (err) {
      log.error('Invalid base URL received from renderer', err);
    }
  });

  ipcMain.handle(IPC.BZZ_CLEAR_BASE, (_event, payload = {}) => {
    const { webContentsId } = payload;
    if (!webContentsId) {
      return;
    }
    activeBzzBases.delete(webContentsId);
  });

  ipcMain.handle(IPC.IPFS_SET_BASE, (_event, payload = {}) => {
    const { webContentsId, baseUrl } = payload;
    if (!webContentsId || !baseUrl) {
      return;
    }
    if (!isAllowedBaseUrl(baseUrl)) {
      log.warn('[ipc] Rejecting non-local ipfs base URL');
      return;
    }
    try {
      const normalized = new URL(baseUrl);
      activeIpfsBases.set(webContentsId, normalized);
    } catch (err) {
      log.error('Invalid IPFS base URL received from renderer', err);
    }
  });

  ipcMain.handle(IPC.IPFS_CLEAR_BASE, (_event, payload = {}) => {
    const { webContentsId } = payload;
    if (!webContentsId) {
      return;
    }
    activeIpfsBases.delete(webContentsId);
  });

  ipcMain.on(IPC.WINDOW_SET_TITLE, (event, title) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (!win) return;
    const formatted = formatWindowTitle(title);
    log.info(`[main] Setting window title to: "${formatted}" (requested: "${title}")`);
    win.setTitle(formatted);
    if (callbacks.onSetTitle) {
      callbacks.onSetTitle(formatted);
    }
  });

  ipcMain.on(IPC.WINDOW_CLOSE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.close();
    }
  });

  ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.minimize();
    }
  });

  ipcMain.on(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle(IPC.WINDOW_GET_PLATFORM, () => {
    return process.platform;
  });

  ipcMain.on(IPC.WINDOW_TOGGLE_FULLSCREEN, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  ipcMain.on(IPC.WINDOW_NEW, () => {
    if (callbacks.onNewWindow) {
      callbacks.onNewWindow();
    }
  });

  ipcMain.on(IPC.WINDOW_NEW_WITH_URL, (_event, url) => {
    if (callbacks.onNewWindow) {
      // Pass URL directly to createMainWindow to avoid home page flash
      callbacks.onNewWindow(url);
    }
  });

  ipcMain.on(IPC.APP_SHOW_ABOUT, () => {
    app.showAboutPanel();
  });

  ipcMain.handle(IPC.GET_WEBVIEW_PRELOAD_PATH, () => {
    return webviewPreloadPath;
  });

  // Sync handler: preloads use sendSync to get internal pages at load time
  ipcMain.on(IPC.GET_INTERNAL_PAGES, (event) => {
    event.returnValue = internalPages;
  });

  ipcMain.handle(IPC.OPEN_URL_IN_NEW_TAB, (event, url) => {
    // Send to the main renderer to open in new tab
    // event.sender is the webview's webContents, hostWebContents is the main renderer
    const hostWebContents = event.sender.hostWebContents;
    if (hostWebContents) {
      hostWebContents.send('tab:new-with-url', url);
    }
  });

  ipcMain.handle(IPC.CONTEXT_MENU_SAVE_IMAGE, async (event, imageUrl) => {
    if (!imageUrl) {
      return { success: false, error: 'No image URL provided' };
    }

    try {
      // Get default filename from URL
      let defaultName = 'image';
      try {
        const urlObj = new URL(imageUrl);
        const pathname = urlObj.pathname;
        const lastSegment = pathname.split('/').pop();
        if (lastSegment && lastSegment.includes('.')) {
          defaultName = lastSegment;
        } else if (lastSegment) {
          defaultName = lastSegment;
        }
      } catch {
        // Use default
      }

      const win = event.sender.getOwnerBrowserWindow();
      const result = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      await fetchToFile(imageUrl, result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (error) {
      log.error('[context-menu] Failed to save image:', error);
      return { success: false, error: error.message };
    }
  });

  // Copy text to clipboard
  ipcMain.handle('clipboard:copy-text', (_event, text) => {
    if (text) {
      clipboard.writeText(text);
      return { success: true };
    }
    return { success: false, error: 'No text provided' };
  });

  // Copy image to clipboard
  ipcMain.handle('clipboard:copy-image', async (_event, imageUrl) => {
    if (!imageUrl) {
      return { success: false, error: 'No image URL provided' };
    }

    try {
      const imageData = await fetchBuffer(imageUrl);
      const image = nativeImage.createFromBuffer(imageData);

      if (image.isEmpty()) {
        return { success: false, error: 'Failed to create image from data' };
      }

      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      log.error('[clipboard] Failed to copy image:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  registerBaseIpcHandlers,
};
