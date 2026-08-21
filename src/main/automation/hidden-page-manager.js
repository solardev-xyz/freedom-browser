'use strict';

const { AutomationError, ERROR_CODES } = require('./contract/errors');
const { OPERATIONS, validateOperationInput } = require('./contract/operations');

function secureHiddenWindowOptions(options = {}) {
  return {
    ...options,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      ...options.webPreferences,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function createHiddenPageManager(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const registerWebContents = options.registerWebContents;
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('Hidden page manager requires Electron BrowserWindow');
  }
  if (typeof registerWebContents !== 'function') {
    throw new TypeError('Hidden page manager requires registerWebContents()');
  }

  const windowsByTabId = new Map();
  const logger = options.logger || console;

  function adoptWindow(window, metadata) {
    let tabId = null;
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        validateOperationInput(OPERATIONS.CREATE_TAB, { url });
      } catch {
        logger.warn?.('[automation-runtime] Blocked unsupported popup URL');
        return { action: 'deny' };
      }

      return {
        action: 'allow',
        overrideBrowserWindowOptions: secureHiddenWindowOptions(),
        createWindow: (childOptions) => {
          const childWindow = new BrowserWindow(secureHiddenWindowOptions(childOptions));
          try {
            adoptWindow(childWindow, { kind: 'popup', openerTabId: tabId });
            return childWindow.webContents;
          } catch (error) {
            if (!childWindow.isDestroyed?.()) childWindow.destroy();
            throw error;
          }
        },
      };
    });

    tabId = registerWebContents(window.webContents, metadata);
    if (!tabId) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The hidden page is not eligible for automation'
      );
    }
    windowsByTabId.set(tabId, window);
    window.once('closed', () => windowsByTabId.delete(tabId));
    return tabId;
  }

  async function createPage(url) {
    const window = new BrowserWindow(secureHiddenWindowOptions());
    let tabId = null;
    try {
      tabId = adoptWindow(window, { kind: 'headless' });
      await window.loadURL(url);
      return tabId;
    } catch (error) {
      if (tabId) windowsByTabId.delete(tabId);
      if (!window.isDestroyed?.()) window.destroy();
      if (error instanceof AutomationError) throw error;
      throw new AutomationError(ERROR_CODES.NAVIGATION_FAILED, `Navigation failed: ${url}`, {
        retryable: true,
        cause: error,
      });
    }
  }

  async function closePage(tabId) {
    const window = windowsByTabId.get(tabId);
    if (!window) return false;
    windowsByTabId.delete(tabId);
    if (!window.isDestroyed?.()) window.destroy();
    return true;
  }

  function closeAll() {
    const count = windowsByTabId.size;
    for (const window of windowsByTabId.values()) {
      if (!window.isDestroyed?.()) window.destroy();
    }
    windowsByTabId.clear();
    return count;
  }

  return {
    createPage,
    closePage,
    closeAll,
    size: () => windowsByTabId.size,
  };
}

module.exports = {
  createHiddenPageManager,
};
