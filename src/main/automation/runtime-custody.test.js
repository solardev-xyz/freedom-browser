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
  loadURL = jest.fn(async (url) => {
    this.url = url;
  });
  executeJavaScriptInIsolatedWorld = jest.fn();
  insertText = jest.fn();
  capturePage = jest.fn();
  stop = jest.fn();
  getURL() {
    return this.url;
  }
  getTitle() {
    return 'Fixture';
  }
  isLoading() {
    return false;
  }
  isDestroyed() {
    return false;
  }
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
    const request = host.send.mock.calls
      .filter(([channel]) => channel === IPC.AUTOMATION_CREATE_TAB)
      .at(-1)[1];
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

  ipcMain.emit(
    IPC.AUTOMATION_CREATE_TAB_RESULT,
    { sender: host },
    { requestId, ok: true, rendererTabId: 5 }
  );
  ipcMain.emit(
    IPC.AUTOMATION_BIND_TAB,
    { sender: host },
    { rendererTabId: 5, guestWebContentsId: 41 }
  );
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

  ipcMain.emit(
    IPC.AUTOMATION_CREATE_TAB_RESULT,
    { sender: host },
    { requestId, ok: true, rendererTabId: 6 }
  );
  ipcMain.emit(
    IPC.AUTOMATION_BIND_TAB,
    { sender: host },
    { rendererTabId: 6, guestWebContentsId: 43 }
  );
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
  ipcMain.emit(
    IPC.AUTOMATION_CREATE_TAB_RESULT,
    { sender: host },
    { requestId, ok: true, rendererTabId: 9 }
  );
  ipcMain.emit(
    IPC.AUTOMATION_BIND_TAB,
    { sender: host },
    { rendererTabId: 9, guestWebContentsId: 46 }
  );
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

const bind = (ipcMain, host, rendererTabId, guestWebContentsId) =>
  ipcMain.emit(IPC.AUTOMATION_BIND_TAB, { sender: host }, { rendererTabId, guestWebContentsId });
const createResult = (ipcMain, host, requestId, rendererTabId) =>
  ipcMain.emit(
    IPC.AUTOMATION_CREATE_TAB_RESULT,
    { sender: host },
    { requestId, ok: true, rendererTabId }
  );
const settledYet = async (promise) => {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
};

// The chrome binds a tab at its first dom-ready, which for the Agent's tab on
// a slow URL is its first commit. A user tab that binds to its own renderer
// tab is provably not the created one and is released then, not when the
// Agent page commits.
test('a user tab is released at its own bind while the created tab is still loading', async () => {
  const { host, ipcMain, startCreation } = setup({
    desktopNavigationTimeoutMs: 500,
    desktopTabControlTimeoutMs: 30, // The failed creation's grace.
  });
  const { creation, requestId } = await startCreation('https://slow.example/');
  const created = new FakeWebContents('', 51, host); // Not committed, not bound.
  host.emit('did-attach-webview', {}, created);
  const userTab = new FakeWebContents('https://user.example/', 52, host);
  host.emit('did-attach-webview', {}, userTab);
  createResult(ipcMain, host, requestId, 11);
  expect(userPageCustodyVersion(52)).toBeNull();

  bind(ipcMain, host, 12, 52);
  expect(await settledYet(creation)).toBe(false);
  expect(userPageCustodyVersion(52)).toEqual(expect.any(Number));
  expect(autoApproveRefused({ id: 1 }, 52)).toBe(false);
  expect(userPageCustodyVersion(51)).toBeNull();

  created.url = 'https://slow.example/';
  bind(ipcMain, host, 11, 51);
  await expect(creation).resolves.toBe('tab_1');
  expect(userPageCustodyVersion(51)).toBeNull();
});

test('a user tab that bound before the chrome named the created tab is released by that answer', async () => {
  const { host, ipcMain, startCreation } = setup({
    desktopNavigationTimeoutMs: 500,
    desktopTabControlTimeoutMs: 30, // The failed creation's grace.
  });
  const { creation, requestId } = await startCreation('https://slow.example/');
  const userTab = new FakeWebContents('https://user.example/', 54, host);
  host.emit('did-attach-webview', {}, userTab);
  bind(ipcMain, host, 14, 54);
  expect(userPageCustodyVersion(54)).toBeNull(); // Which tab is the Agent's is unknown yet.
  createResult(ipcMain, host, requestId, 13);
  expect(userPageCustodyVersion(54)).toEqual(expect.any(Number));
  await expect(creation).rejects.toThrow(/Timed out/);
});

test('overlapping creations do not release each other’s tab', async () => {
  const { host, ipcMain, startCreation } = setup({ desktopNavigationTimeoutMs: 200 });
  const first = await startCreation('https://one.example/');
  const second = await startCreation('https://two.example/');
  const tabOne = new FakeWebContents('about:blank', 61, host);
  host.emit('did-attach-webview', {}, tabOne);
  const tabTwo = new FakeWebContents('about:blank', 62, host);
  host.emit('did-attach-webview', {}, tabTwo);

  // The second creation names its tab first: tabOne may still be the first's.
  ipcMain.emit(
    IPC.AUTOMATION_CREATE_TAB_RESULT,
    { sender: host },
    { requestId: second.requestId, ok: true, rendererTabId: 22 }
  );
  ipcMain.emit(
    IPC.AUTOMATION_BIND_TAB,
    { sender: host },
    { rendererTabId: 22, guestWebContentsId: 62 }
  );
  expect(userPageCustodyVersion(61)).toBeNull();
  expect(userPageCustodyVersion(62)).toBeNull();

  // The first names its tab: it must not release the second's.
  ipcMain.emit(
    IPC.AUTOMATION_CREATE_TAB_RESULT,
    { sender: host },
    { requestId: first.requestId, ok: true, rendererTabId: 21 }
  );
  ipcMain.emit(
    IPC.AUTOMATION_BIND_TAB,
    { sender: host },
    { rendererTabId: 21, guestWebContentsId: 61 }
  );
  expect(userPageCustodyVersion(61)).toBeNull();
  expect(userPageCustodyVersion(62)).toBeNull();
  // Neither tab commits: both creations time out and both tabs stay held.
  await Promise.allSettled([first.creation, second.creation]);
  expect(userPageCustodyVersion(61)).toBeNull();
  expect(userPageCustodyVersion(62)).toBeNull();
});

test('a creation that times out before the chrome answers still keeps its tab once it binds', async () => {
  const { host, ipcMain, startCreation } = setup({
    desktopNavigationTimeoutMs: 20,
    desktopTabControlTimeoutMs: 60_000,
  });
  const { creation, requestId } = await startCreation('https://seller.example/paid');
  const created = new FakeWebContents('', 71, host);
  host.emit('did-attach-webview', {}, created);
  const userTab = new FakeWebContents('https://user.example/', 72, host);
  host.emit('did-attach-webview', {}, userTab);
  await expect(creation).rejects.toThrow(/Timed out/);
  // Still unknown which one the Agent opened: both stay held.
  expect(userPageCustodyVersion(71)).toBeNull();
  expect(userPageCustodyVersion(72)).toBeNull();
  // A tab opened within the grace after the failure may still be the
  // Agent's: it is held too, until its own bind says otherwise.
  const later = new FakeWebContents('https://user.example/later', 73, host);
  host.emit('did-attach-webview', {}, later);
  expect(userPageCustodyVersion(73)).toBeNull();

  // The chrome's answer and the binds arrive late.
  createResult(ipcMain, host, requestId, 31);
  bind(ipcMain, host, 32, 72);
  expect(userPageCustodyVersion(72)).toEqual(expect.any(Number));
  bind(ipcMain, host, 33, 73);
  expect(userPageCustodyVersion(73)).toEqual(expect.any(Number));
  bind(ipcMain, host, 31, 71);
  expect(userPageCustodyVersion(71)).toBeNull();
});

test('a creation that fails after the chrome named its tab still holds a guest that attaches later', async () => {
  const { host, ipcMain, startCreation } = setup({
    desktopNavigationTimeoutMs: 20,
    desktopTabControlTimeoutMs: 60_000,
  });
  const { creation, requestId } = await startCreation('https://seller.example/paid');
  // The chrome names the tab, then the creation times out before any guest
  // attached.
  createResult(ipcMain, host, requestId, 91);
  await expect(creation).rejects.toThrow(/Timed out/);

  const userTab = new FakeWebContents('https://user.example/', 92, host);
  host.emit('did-attach-webview', {}, userTab);
  const created = new FakeWebContents('', 93, host);
  host.emit('did-attach-webview', {}, created);
  expect(userPageCustodyVersion(92)).toBeNull();
  expect(userPageCustodyVersion(93)).toBeNull();

  // The user's tab is released at its own bind; that does not end the hold
  // while the named tab has not bound yet.
  bind(ipcMain, host, 94, 92);
  expect(userPageCustodyVersion(92)).toEqual(expect.any(Number));
  bind(ipcMain, host, 91, 93);
  expect(userPageCustodyVersion(93)).toBeNull();
  expect(autoApproveRefused({ id: 1 }, 93)).toBe(true);

  // The created tab is decided: later tabs are ordinary user pages.
  const after = new FakeWebContents('https://user.example/after', 95, host);
  host.emit('did-attach-webview', {}, after);
  expect(userPageCustodyVersion(95)).toEqual(expect.any(Number));
});

test('a failed creation stops collecting guests once its grace ends', async () => {
  const { host, ipcMain, startCreation } = setup({
    desktopNavigationTimeoutMs: 20,
    desktopTabControlTimeoutMs: 40,
  });
  const { creation, requestId } = await startCreation('https://seller.example/paid');
  createResult(ipcMain, host, requestId, 101);
  await expect(creation).rejects.toThrow(/Timed out/);
  const held = new FakeWebContents('https://user.example/', 102, host);
  host.emit('did-attach-webview', {}, held);
  expect(userPageCustodyVersion(102)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 80));
  // The chrome named the tab, so a guest still held waits for its own bind.
  expect(userPageCustodyVersion(102)).toBeNull();
  const late = new FakeWebContents('https://user.example/late', 103, host);
  host.emit('did-attach-webview', {}, late);
  expect(userPageCustodyVersion(103)).toEqual(expect.any(Number));
  bind(ipcMain, host, 104, 102);
  expect(userPageCustodyVersion(102)).toEqual(expect.any(Number));
});

test('a timed-out creation whose tab never binds releases its guests after a short grace', async () => {
  const { host, startCreation } = setup({
    desktopNavigationTimeoutMs: 20,
    desktopTabControlTimeoutMs: 30,
  });
  const { creation } = await startCreation('https://seller.example/paid');
  const guest = new FakeWebContents('https://user.example/', 81, host);
  host.emit('did-attach-webview', {}, guest);
  await expect(creation).rejects.toThrow(/Timed out/);
  expect(userPageCustodyVersion(81)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(userPageCustodyVersion(81)).toEqual(expect.any(Number));
});
