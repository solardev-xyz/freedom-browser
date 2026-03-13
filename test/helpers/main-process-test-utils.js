/* global jest */

const fs = require('fs');
const os = require('os');
const path = require('path');

function createIpcMainMock() {
  const handlers = new Map();
  const listeners = new Map();

  return {
    handlers,
    listeners,
    handle: jest.fn((channel, handler) => {
      handlers.set(channel, handler);
    }),
    on: jest.fn((channel, listener) => {
      listeners.set(channel, listener);
    }),
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No IPC handler registered for ${channel}`);
      }

      return handler({}, ...args);
    },
    emit(channel, ...args) {
      const listener = listeners.get(channel);
      if (!listener) {
        throw new Error(`No IPC listener registered for ${channel}`);
      }

      return listener(...args);
    },
  };
}

function createIpcRendererMock(options = {}) {
  const listeners = new Map();

  const ipcRenderer = {
    listeners,
    invoke: jest.fn((channel, ...args) => {
      if (typeof options.invokeImplementation === 'function') {
        return options.invokeImplementation(channel, ...args);
      }

      if (options.invokeResponses && channel in options.invokeResponses) {
        return Promise.resolve(options.invokeResponses[channel]);
      }

      return Promise.resolve(undefined);
    }),
    send: jest.fn(),
    sendSync: jest.fn((channel, ...args) => {
      if (typeof options.sendSyncImplementation === 'function') {
        return options.sendSyncImplementation(channel, ...args);
      }

      if (options.syncResponses && channel in options.syncResponses) {
        return options.syncResponses[channel];
      }

      return undefined;
    }),
    on: jest.fn((channel, handler) => {
      if (!listeners.has(channel)) {
        listeners.set(channel, []);
      }
      listeners.get(channel).push(handler);
      return ipcRenderer;
    }),
    removeListener: jest.fn((channel, handler) => {
      const channelListeners = listeners.get(channel) || [];
      listeners.set(
        channel,
        channelListeners.filter((listener) => listener !== handler)
      );
      return ipcRenderer;
    }),
    emit(channel, ...args) {
      const channelListeners = listeners.get(channel) || [];
      channelListeners.forEach((listener) => listener({}, ...args));
    },
  };

  return ipcRenderer;
}

function createContextBridgeMock() {
  const exposedValues = {};

  return {
    exposedValues,
    exposeInMainWorld: jest.fn((key, value) => {
      exposedValues[key] = value;
    }),
  };
}

function createAppMock(options = {}) {
  const handlers = new Map();

  return {
    handlers,
    isPackaged: options.isPackaged ?? false,
    on: jest.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    emit(event, ...args) {
      const handler = handlers.get(event);
      if (!handler) return undefined;
      return handler(...args);
    },
    getPath: jest.fn((name) => {
      if (name === 'userData') {
        return options.userDataDir ?? os.tmpdir();
      }

      if (options.appPaths?.[name]) {
        return options.appPaths[name];
      }

      return path.join(os.tmpdir(), name);
    }),
    showAboutPanel: jest.fn(),
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
  const ipcRenderer = options.ipcRenderer || createIpcRendererMock();
  const contextBridge = options.contextBridge || createContextBridgeMock();
  const app = options.app || createAppMock(options);
  const nativeTheme = options.nativeTheme || { themeSource: 'system' };
  const BrowserWindow = options.BrowserWindow || {
    getAllWindows: jest.fn(() => options.windows ?? []),
  };
  const dialog = options.dialog || { showSaveDialog: jest.fn() };
  const clipboard = options.clipboard || {
    writeText: jest.fn(),
    writeImage: jest.fn(),
  };
  const nativeImage = options.nativeImage || {
    createFromBuffer: jest.fn(() => ({
      isEmpty: () => false,
    })),
  };

  jest.doMock('electron', () => ({
    app,
    ipcMain,
    ipcRenderer,
    nativeTheme,
    BrowserWindow,
    contextBridge,
    dialog,
    clipboard,
    nativeImage,
    ...(options.electronOverrides || {}),
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
    ipcRenderer,
    nativeTheme,
    BrowserWindow,
    contextBridge,
    dialog,
    clipboard,
    nativeImage,
  };
}

module.exports = {
  createAppMock,
  createContextBridgeMock,
  createIpcMainMock,
  createIpcRendererMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
};
