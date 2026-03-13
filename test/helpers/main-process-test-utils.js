/* global jest */

const fs = require('fs');
const os = require('os');
const path = require('path');

function createIpcMainMock() {
  const handlers = new Map();

  return {
    handlers,
    handle: jest.fn((channel, handler) => {
      handlers.set(channel, handler);
    }),
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No IPC handler registered for ${channel}`);
      }

      return handler({}, ...args);
    },
  };
}

function createTempUserDataDir(prefix = 'freedom-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempUserDataDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function loadMainModule(modulePath, options = {}) {
  jest.resetModules();

  const ipcMain = options.ipcMain || createIpcMainMock();
  const app = {
    isPackaged: options.isPackaged ?? false,
    getPath: jest.fn((name) => {
      if (name === 'userData') {
        return options.userDataDir ?? os.tmpdir();
      }

      if (options.appPaths?.[name]) {
        return options.appPaths[name];
      }

      return path.join(os.tmpdir(), name);
    }),
  };
  const nativeTheme = options.nativeTheme || { themeSource: 'system' };
  const BrowserWindow = options.BrowserWindow || {
    getAllWindows: jest.fn(() => options.windows ?? []),
  };

  jest.doMock('electron', () => ({
    app,
    ipcMain,
    nativeTheme,
    BrowserWindow,
  }));

  if (options.extraMocks) {
    for (const [request, mockFactory] of Object.entries(options.extraMocks)) {
      jest.doMock(request, mockFactory);
    }
  }

  const mod = require(modulePath);

  return {
    mod,
    app,
    ipcMain,
    nativeTheme,
    BrowserWindow,
  };
}

module.exports = {
  createIpcMainMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
};
