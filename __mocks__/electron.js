/**
 * Jest manual mock for the 'electron' module.
 *
 * Main-process tests that transitively require('electron') (e.g. via
 * chain-registry.js) will get these stubs instead of the real Electron
 * APIs, which are unavailable in a plain Node/Jest environment.
 */

const app = {
  getPath: () => '/tmp/freedom-test',
  isPackaged: false,
  getName: () => 'freedom-browser-test',
  getVersion: () => '0.0.0-test',
};

const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
};

const ipcRenderer = {
  invoke: () => Promise.resolve(),
  on: () => {},
  send: () => {},
};

module.exports = {
  app,
  ipcMain,
  ipcRenderer,
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: () => {}, readText: () => '' },
  contextBridge: { exposeInMainWorld: () => {} },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: { shouldUseDarkColors: true, on: () => {} },
  net: { request: () => ({}) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: () => {} } } },
  shell: { openExternal: () => Promise.resolve() },
  systemPreferences: { canPromptTouchID: () => Promise.resolve(false), promptTouchID: () => Promise.resolve() },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
};
