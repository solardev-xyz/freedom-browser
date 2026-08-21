'use strict';

const { EventEmitter } = require('events');
const { createAutomationRuntime } = require('./runtime');
const { OPERATIONS } = require('./contract/operations');

class FakeWebContents extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
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
      controllerOptions: {
        runtimeId: 'runtime_test',
        contextId: 'context_test',
        tabIdFactory: () => `tab_${nextTab++}`,
      },
    });
    const host = new EventEmitter();
    const desktop = new FakeWebContents('https://desktop.example/');
    const hidden = new FakeWebContents('https://hidden.example/');
    const detach = runtime.attachToHostWebContents(host);

    host.emit('did-attach-webview', {}, desktop);
    const hiddenTabId = runtime.registerWebContents(hidden, { kind: 'headless' });
    const duplicateTabId = runtime.registerWebContents(hidden, { kind: 'headless' });
    const listed = await runtime.controller.execute(OPERATIONS.LIST_TABS);

    expect(duplicateTabId).toBe(hiddenTabId);
    expect(listed.result.tabs).toEqual([
      expect.objectContaining({ tabId: 'tab_1', kind: 'desktop' }),
      expect.objectContaining({ tabId: 'tab_2', kind: 'headless' }),
    ]);

    detach();
    host.emit('did-attach-webview', {}, new FakeWebContents('https://ignored.example/'));
    const afterDetach = await runtime.controller.execute(OPERATIONS.LIST_TABS);
    expect(afterDetach.result.tabs).toHaveLength(2);
  });
});
