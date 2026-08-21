'use strict';

const { EventEmitter } = require('events');
const { createAutomationRuntime } = require('./runtime');
const { OPERATIONS } = require('./contract/operations');

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

  test('removes both sides of a desktop binding when the guest is destroyed', () => {
    const runtime = createAutomationRuntime({
      isPrivateWebContents: () => false,
      controllerOptions: { tabIdFactory: () => 'tab_desktop' },
    });
    const host = new EventEmitter();
    const ipcMain = new EventEmitter();
    const desktop = new FakeWebContents('https://desktop.example/', 21);
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
