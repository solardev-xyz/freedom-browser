'use strict';

// An Agent-created desktop tab starts its first navigation when its guest
// attaches, but creation resolves (and the Agent claims custody) only after
// that navigation commits. Until custody is decided, the guest must not read
// as a user page: an x402 capture stamped then could pay from a cap.

const { EventEmitter } = require('events');

const mockGuests = new Map();
jest.mock('electron', () => ({ webContents: { fromId: (id) => mockGuests.get(id) || null } }));

const { createAutomationRuntime } = require('./runtime');
const IPC = require('../../shared/ipc-channels');
const {
  setAgentPageCustody,
  userPageCustodyVersion,
  autoApproveRefused,
} = require('../wallet/agent-tab-custody');

class FakeWebContents extends EventEmitter {
  constructor(url, id, host) {
    super();
    this.url = url;
    this.id = id;
    this.hostWebContents = host;
    mockGuests.set(id, this);
  }
  loadURL = jest.fn(async (url) => { this.url = url; });
  executeJavaScriptInIsolatedWorld = jest.fn();
  insertText = jest.fn();
  capturePage = jest.fn();
  stop = jest.fn();
  getURL() { return this.url; }
  getTitle() { return 'Fixture'; }
  isLoading() { return false; }
  isDestroyed() { return false; }
}

function setup(options = {}) {
  let nextTab = 1;
  const runtime = createAutomationRuntime({
    ...options,
    isPrivateWebContents: () => false,
    controllerOptions: { tabIdFactory: () => `tab_${nextTab++}` },
  });
  runtime.controller.setPageLifecycle({
    createPage: runtime.createDesktopPage,
    closePage: runtime.closeDesktopPage,
    focusPage: runtime.focusDesktopPage,
  });
  const host = new EventEmitter();
  host.id = 1;
  host.send = jest.fn();
  const ipcMain = new EventEmitter();
  runtime.attachToHostWebContents(host, { ipcMain });
  const startCreation = async (url) => {
    const creation = runtime.createDesktopPageForHost(host, url);
    await new Promise((resolve) => setImmediate(resolve));
    const request = host.send.mock.calls.filter(([channel]) => channel === IPC.AUTOMATION_CREATE_TAB).at(-1)[1];
    return { creation, requestId: request.requestId };
  };
  return { runtime, host, ipcMain, startCreation };
}

afterEach(() => mockGuests.clear());

test('a created tab is out of user custody from attach until the Agent claims it', async () => {
  const { host, ipcMain, startCreation } = setup();
  const { creation, requestId } = await startCreation('https://seller.example/paid');
  const created = new FakeWebContents('https://seller.example/paid', 41, host);
  host.emit('did-attach-webview', {}, created);
  // The first navigation is already in flight here: an x402 capture reads this.
  expect(userPageCustodyVersion(41)).toBeNull();
  expect(autoApproveRefused({ id: 1 }, 41)).toBe(true);

  ipcMain.emit(IPC.AUTOMATION_CREATE_TAB_RESULT, { sender: host }, { requestId, ok: true, rendererTabId: 5 });
  ipcMain.emit(IPC.AUTOMATION_BIND_TAB, { sender: host }, { rendererTabId: 5, guestWebContentsId: 41 });
  await expect(creation).resolves.toBe('tab_1');
  // Creation resolved; the Agent has not claimed it yet.
  expect(userPageCustodyVersion(41)).toBeNull();

  setAgentPageCustody(created, true);
  expect(userPageCustodyVersion(41)).toBeNull();
  setAgentPageCustody(created, false); // User takes control.
  expect(userPageCustodyVersion(41)).toEqual(expect.any(Number));
});

test('a user tab that attached during the creation is released once creation names its guest', async () => {
  const { host, ipcMain, startCreation } = setup();
  const { creation, requestId } = await startCreation('https://seller.example/paid');
  const userTab = new FakeWebContents('https://user.example/', 42, host);
  host.emit('did-attach-webview', {}, userTab);
  const created = new FakeWebContents('https://seller.example/paid', 43, host);
  host.emit('did-attach-webview', {}, created);
  expect(userPageCustodyVersion(42)).toBeNull(); // Unknown yet: fail closed.

  ipcMain.emit(IPC.AUTOMATION_CREATE_TAB_RESULT, { sender: host }, { requestId, ok: true, rendererTabId: 6 });
  ipcMain.emit(IPC.AUTOMATION_BIND_TAB, { sender: host }, { rendererTabId: 6, guestWebContentsId: 43 });
  await creation;
  expect(userPageCustodyVersion(42)).toEqual(expect.any(Number));
  expect(userPageCustodyVersion(43)).toBeNull();
});

test('a failed creation releases every guest it held', async () => {
  const { host, ipcMain, startCreation } = setup();
  const { creation, requestId } = await startCreation('https://seller.example/paid');
  const guest = new FakeWebContents('https://user.example/', 44, host);
  host.emit('did-attach-webview', {}, guest);
  expect(userPageCustodyVersion(44)).toBeNull();
  ipcMain.emit(IPC.AUTOMATION_CREATE_TAB_RESULT, { sender: host }, { requestId, ok: false });
  await expect(creation).rejects.toThrow();
  expect(userPageCustodyVersion(44)).toEqual(expect.any(Number));
});

test('a creation that times out after its tab appeared keeps that tab undecided', async () => {
  const { host, ipcMain, startCreation } = setup({ desktopNavigationTimeoutMs: 20 });
  const { creation, requestId } = await startCreation('https://seller.example/paid');
  const created = new FakeWebContents('about:blank', 46, host); // Never commits.
  host.emit('did-attach-webview', {}, created);
  ipcMain.emit(IPC.AUTOMATION_CREATE_TAB_RESULT, { sender: host }, { requestId, ok: true, rendererTabId: 9 });
  ipcMain.emit(IPC.AUTOMATION_BIND_TAB, { sender: host }, { rendererTabId: 9, guestWebContentsId: 46 });
  await expect(creation).rejects.toThrow(/Timed out/);
  expect(userPageCustodyVersion(46)).toBeNull();
});

test('tabs that attach with no creation pending are ordinary user pages', () => {
  const { host } = setup();
  const guest = new FakeWebContents('https://user.example/', 45, host);
  host.emit('did-attach-webview', {}, guest);
  expect(userPageCustodyVersion(45)).toEqual(expect.any(Number));
  expect(autoApproveRefused({ id: 1 }, 45)).toBe(false);
});
