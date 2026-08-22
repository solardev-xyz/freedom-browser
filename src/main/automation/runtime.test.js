'use strict';

const { EventEmitter } = require('events');
const { createAutomationRuntime } = require('./runtime');
const { OPERATIONS } = require('./contract/operations');
const IPC = require('../../shared/ipc-channels');

class FakeWebContents extends EventEmitter {
  constructor(url, id) {
    super();
    this.url = url;
    this.id = id;
  }

  loadURL = jest.fn(async (url) => {
    this.url = url;
  });

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

  executeJavaScriptInIsolatedWorld = jest.fn();
  insertText = jest.fn();
  capturePage = jest.fn();
  stop = jest.fn();
}

describe('automation runtime registration', () => {
  test('uses the same controller for desktop guests and direct hidden WebContents', async () => {
    let nextTab = 1;
    const runtime = createAutomationRuntime({
      isPrivateWebContents: (webContents) => webContents.private === true,
      controllerOptions: {
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        tabIdFactory: () => `tab_${nextTab++}`,
      },
    });
    const host = new EventEmitter();
    const ipcMain = new EventEmitter();
    const desktop = new FakeWebContents('https://desktop.example/', 11);
    const hidden = new FakeWebContents('https://hidden.example/', 12);
    const popup = new FakeWebContents('https://popup.example/', 13);
    const privatePage = new FakeWebContents('https://private.example/', 15);
    privatePage.private = true;
    desktop.hostWebContents = host;
    const detach = runtime.attachToHostWebContents(host, { ipcMain });

    host.emit('did-attach-webview', {}, desktop);
    ipcMain.emit('automation:bind-tab', { sender: host }, null);
    expect(runtime.automationTabIdForRenderer(host, 7)).toBeNull();
    ipcMain.emit(
      'automation:bind-tab',
      { sender: new EventEmitter() },
      { rendererTabId: 8, guestWebContentsId: 11 }
    );
    expect(runtime.automationTabIdForRenderer(host, 8)).toBeNull();
    ipcMain.emit(
      'automation:bind-tab',
      { sender: host },
      { rendererTabId: 7, guestWebContentsId: 11 }
    );
    const hiddenTabId = runtime.registerWebContents(hidden, { kind: 'headless' });
    const duplicateTabId = runtime.registerWebContents(hidden, { kind: 'headless' });
    const privateTabId = runtime.registerWebContents(privatePage, { kind: 'desktop' });
    const listed = await runtime.controller.execute(OPERATIONS.LIST_TABS);

    expect(duplicateTabId).toBe(hiddenTabId);
    expect(privateTabId).toBeNull();
    expect(runtime.automationTabIdForRenderer(host, 7)).toBe('tab_1');
    expect(runtime.desktopBindingForAutomationTab('tab_1')).toEqual({
      hostWebContents: host,
      rendererTabId: 7,
    });
    expect(listed.result.tabs).toEqual([
      expect.objectContaining({ tabId: 'tab_1', kind: 'desktop' }),
      expect.objectContaining({ tabId: 'tab_2', kind: 'headless' }),
    ]);

    hidden.emit('did-create-window', { webContents: popup });
    const withPopup = await runtime.controller.execute(OPERATIONS.LIST_TABS);
    expect(withPopup.result.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ tabId: 'tab_3', kind: 'popup' })])
    );

    detach();
    expect(runtime.automationTabIdForRenderer(host, 7)).toBeNull();
    host.emit('did-attach-webview', {}, new FakeWebContents('https://ignored.example/', 14));
    const afterDetach = await runtime.controller.execute(OPERATIONS.LIST_TABS);
    expect(afterDetach.result.tabs).toHaveLength(3);
  });

  test('creates, focuses, and closes visible desktop tabs through acknowledged chrome requests', async () => {
    let nextTab = 1;
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      controllerOptions: { tabIdFactory: () => `tab_${nextTab++}` },
    });
    runtime.controller.setPageLifecycle({
      createPage: runtime.createDesktopPage,
      closePage: runtime.closeDesktopPage,
      focusPage: runtime.focusDesktopPage,
    });
    const host = new EventEmitter();
    host.send = jest.fn();
    const ipcMain = new EventEmitter();
    const opener = new FakeWebContents('https://desktop.example/', 21);
    opener.hostWebContents = host;
    runtime.attachToHostWebContents(host, { ipcMain });
    host.emit('did-attach-webview', {}, opener);
    ipcMain.emit(
      IPC.AUTOMATION_BIND_TAB,
      { sender: host },
      { rendererTabId: 7, guestWebContentsId: 21 }
    );

    const creation = runtime.controller.execute(OPERATIONS.CREATE_TAB, {
      url: 'https://desktop.example/research',
      openerTabId: 'tab_1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const createRequest = host.send.mock.calls.find(
      ([channel]) => channel === IPC.AUTOMATION_CREATE_TAB
    )[1];
    ipcMain.emit(
      IPC.AUTOMATION_CREATE_TAB_RESULT,
      { sender: host },
      { requestId: createRequest.requestId, ok: true, rendererTabId: 8 }
    );
    const created = new FakeWebContents('https://desktop.example/research', 22);
    created.hostWebContents = host;
    host.emit('did-attach-webview', {}, created);
    ipcMain.emit(
      IPC.AUTOMATION_BIND_TAB,
      { sender: host },
      { rendererTabId: 8, guestWebContentsId: 22 }
    );
    await expect(creation).resolves.toMatchObject({
      ok: true,
      result: { tab: { tabId: 'tab_2', kind: 'desktop' } },
    });

    const focus = runtime.controller.execute(OPERATIONS.FOCUS_TAB, { tabId: 'tab_1' });
    await new Promise((resolve) => setImmediate(resolve));
    const focusRequest = host.send.mock.calls.find(
      ([channel]) => channel === IPC.AUTOMATION_FOCUS_TAB
    )[1];
    ipcMain.emit(
      IPC.AUTOMATION_FOCUS_TAB_RESULT,
      { sender: host },
      { requestId: focusRequest.requestId, ok: true }
    );
    await expect(focus).resolves.toMatchObject({ ok: true, result: { focused: true } });

    const close = runtime.controller.execute(OPERATIONS.CLOSE_TAB, { tabId: 'tab_2' });
    await new Promise((resolve) => setImmediate(resolve));
    const closeRequest = host.send.mock.calls.find(
      ([channel]) => channel === IPC.AUTOMATION_CLOSE_TAB
    )[1];
    ipcMain.emit(
      IPC.AUTOMATION_CLOSE_TAB_RESULT,
      { sender: host },
      { requestId: closeRequest.requestId, ok: true }
    );
    await expect(close).resolves.toMatchObject({ ok: true, result: { closed: true } });
  });

  test('waits for a routed dweb tab to leave about:blank before completing creation', async () => {
    let nextTab = 1;
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      controllerOptions: { tabIdFactory: () => `tab_${nextTab++}` },
    });
    runtime.controller.setPageLifecycle({
      createPage: runtime.createDesktopPage,
      closePage: runtime.closeDesktopPage,
      focusPage: runtime.focusDesktopPage,
    });
    const host = new EventEmitter();
    host.send = jest.fn();
    const ipcMain = new EventEmitter();
    const opener = new FakeWebContents('https://desktop.example/', 31);
    opener.hostWebContents = host;
    runtime.attachToHostWebContents(host, { ipcMain });
    host.emit('did-attach-webview', {}, opener);
    ipcMain.emit(
      IPC.AUTOMATION_BIND_TAB,
      { sender: host },
      { rendererTabId: 10, guestWebContentsId: 31 }
    );

    const targetUrl = 'ipfs://bafybeirouted/source';
    const creation = runtime.controller.execute(OPERATIONS.CREATE_TAB, {
      url: targetUrl,
      openerTabId: 'tab_1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const createRequest = host.send.mock.calls.find(
      ([channel]) => channel === IPC.AUTOMATION_CREATE_TAB
    )[1];
    ipcMain.emit(
      IPC.AUTOMATION_CREATE_TAB_RESULT,
      { sender: host },
      { requestId: createRequest.requestId, ok: true, rendererTabId: 11 }
    );
    const created = new FakeWebContents('about:blank', 32);
    created.hostWebContents = host;
    host.emit('did-attach-webview', {}, created);
    ipcMain.emit(
      IPC.AUTOMATION_BIND_TAB,
      { sender: host },
      { rendererTabId: 11, guestWebContentsId: 32 }
    );
    let completed = false;
    void creation.then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);

    created.url = targetUrl;
    created.emit('did-navigate', {}, targetUrl);

    await expect(creation).resolves.toMatchObject({
      ok: true,
      result: { tab: { tabId: 'tab_2', url: targetUrl } },
    });
  });

  test('desktop lifecycle refuses to close a bound tab it did not create', async () => {
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      controllerOptions: { tabIdFactory: () => 'tab_desktop' },
    });
    runtime.controller.setPageLifecycle({
      createPage: runtime.createDesktopPage,
      closePage: runtime.closeDesktopPage,
      focusPage: runtime.focusDesktopPage,
    });
    const host = new EventEmitter();
    host.send = jest.fn();
    const ipcMain = new EventEmitter();
    const desktop = new FakeWebContents('https://desktop.example/', 33);
    desktop.hostWebContents = host;
    runtime.attachToHostWebContents(host, { ipcMain });
    host.emit('did-attach-webview', {}, desktop);
    ipcMain.emit(
      IPC.AUTOMATION_BIND_TAB,
      { sender: host },
      { rendererTabId: 12, guestWebContentsId: 33 }
    );

    await expect(
      runtime.controller.execute(OPERATIONS.CLOSE_TAB, { tabId: 'tab_desktop' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE' },
    });
    expect(host.send).not.toHaveBeenCalledWith(IPC.AUTOMATION_CLOSE_TAB, expect.anything());
  });

  test('removes both sides of a desktop binding when the guest is destroyed', () => {
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      controllerOptions: { tabIdFactory: () => 'tab_desktop' },
    });
    const host = new EventEmitter();
    const ipcMain = new EventEmitter();
    const desktop = new FakeWebContents('https://desktop.example/', 21);
    const lifecycleEvents = [];
    const unsubscribe = runtime.subscribeTabLifecycle((event) => lifecycleEvents.push(event));
    desktop.hostWebContents = host;
    runtime.attachToHostWebContents(host, { ipcMain });
    host.emit('did-attach-webview', {}, desktop);
    ipcMain.emit(
      'automation:bind-tab',
      { sender: host },
      { rendererTabId: 9, guestWebContentsId: 21 }
    );

    desktop.emit('destroyed');

    expect(runtime.automationTabIdForRenderer(host, 9)).toBeNull();
    expect(runtime.desktopBindingForAutomationTab('tab_desktop')).toBeNull();
    expect(lifecycleEvents).toEqual([
      { type: 'tab_closed', tabId: 'tab_desktop', kind: 'desktop' },
    ]);
    unsubscribe();
  });

  test('routes bound desktop navigation through its trusted renderer tab', async () => {
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      navigationRequestIdFactory: () => 'nav_test',
      controllerOptions: { tabIdFactory: () => 'tab_desktop' },
    });
    const host = new EventEmitter();
    host.send = jest.fn();
    const ipcMain = new EventEmitter();
    const desktop = new FakeWebContents('https://desktop.example/', 41);
    desktop.hostWebContents = host;
    runtime.attachToHostWebContents(host, { ipcMain });
    host.emit('did-attach-webview', {}, desktop);
    ipcMain.emit(
      IPC.AUTOMATION_BIND_TAB,
      { sender: host },
      { rendererTabId: 12, guestWebContentsId: 41 }
    );

    const navigation = runtime.controller.execute(OPERATIONS.NAVIGATE, {
      tabId: 'tab_desktop',
      url: 'https://next.example/',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.send).toHaveBeenCalledWith(IPC.AUTOMATION_NAVIGATE, {
      requestId: 'nav_test',
      rendererTabId: 12,
      url: 'https://next.example/',
    });
    expect(desktop.loadURL).not.toHaveBeenCalled();

    ipcMain.emit(
      IPC.AUTOMATION_NAVIGATE_RESULT,
      { sender: new EventEmitter() },
      { requestId: 'nav_test', ok: true }
    );
    desktop.loading = true;
    desktop.emit('did-start-navigation', {}, 'https://next.example/', false, true);
    desktop.url = 'https://next.example/';
    desktop.loading = false;
    desktop.emit('did-navigate', {}, 'https://next.example/');
    desktop.emit('did-stop-loading');
    ipcMain.emit(
      IPC.AUTOMATION_NAVIGATE_RESULT,
      { sender: host },
      { requestId: 'nav_test', ok: true }
    );

    await expect(navigation).resolves.toMatchObject({
      ok: true,
      tabId: 'tab_desktop',
      result: { url: 'https://next.example/' },
    });
  });

  test('fails closed when a desktop tab has not completed renderer binding', async () => {
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      controllerOptions: { tabIdFactory: () => 'tab_desktop' },
    });
    const host = new EventEmitter();
    host.send = jest.fn();
    const desktop = new FakeWebContents('https://desktop.example/', 51);
    desktop.hostWebContents = host;
    runtime.attachToHostWebContents(host, { ipcMain: new EventEmitter() });
    host.emit('did-attach-webview', {}, desktop);

    await expect(
      runtime.controller.execute(OPERATIONS.NAVIGATE, {
        tabId: 'tab_desktop',
        url: 'https://next.example/',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE', retryable: true },
    });
    expect(host.send).not.toHaveBeenCalled();
  });

  test('cancels pending renderer navigation through the bound desktop tab', async () => {
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      navigationRequestIdFactory: () => 'nav_cancel',
      controllerOptions: { tabIdFactory: () => 'tab_desktop' },
    });
    const host = new EventEmitter();
    host.send = jest.fn();
    const ipcMain = new EventEmitter();
    const desktop = new FakeWebContents('bzz://fixture.test/', 61);
    desktop.hostWebContents = host;
    runtime.attachToHostWebContents(host, { ipcMain });
    host.emit('did-attach-webview', {}, desktop);
    ipcMain.emit(
      IPC.AUTOMATION_BIND_TAB,
      { sender: host },
      { rendererTabId: 14, guestWebContentsId: 61 }
    );

    const navigation = runtime.controller.execute(OPERATIONS.NAVIGATE, {
      tabId: 'tab_desktop',
      url: 'bzz://fixture.test/next',
    });
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      runtime.controller.execute(OPERATIONS.STOP_LOADING, { tabId: 'tab_desktop' })
    ).resolves.toMatchObject({ ok: true, result: { stopped: true } });
    expect(host.send).toHaveBeenLastCalledWith(IPC.AUTOMATION_STOP_LOADING, {
      rendererTabId: 14,
    });
    await expect(navigation).resolves.toMatchObject({
      ok: false,
      error: { code: 'USER_CANCELLED', retryable: true },
    });
  });

  test('fails closed when privacy eligibility cannot be determined', async () => {
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => {
        throw new Error('privacy registry unavailable');
      },
    });

    expect(
      runtime.registerWebContents(new FakeWebContents('https://unknown.example/', 31), {
        kind: 'desktop',
      })
    ).toBeNull();
    await expect(runtime.controller.execute(OPERATIONS.LIST_TABS)).resolves.toMatchObject({
      ok: true,
      result: { tabs: [] },
    });
  });
});
