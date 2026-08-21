'use strict';

const { EventEmitter } = require('events');
const { createHiddenPageManager } = require('./hidden-page-manager');

class FakeWebContents extends EventEmitter {}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  static nextLoadError = null;

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.loadURL = jest.fn(async (url) => {
      if (FakeBrowserWindow.nextLoadError) throw FakeBrowserWindow.nextLoadError;
      this.url = url;
    });
    FakeBrowserWindow.instances.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.emit('destroyed');
    this.emit('closed');
  }
}

describe('hidden automation page manager', () => {
  beforeEach(() => {
    FakeBrowserWindow.instances = [];
    FakeBrowserWindow.nextLoadError = null;
  });

  test('creates non-visible sandboxed pages and closes only owned tabs', async () => {
    const registrations = [];
    const manager = createHiddenPageManager({
      BrowserWindow: FakeBrowserWindow,
      registerWebContents: (webContents, metadata) => {
        registrations.push({ webContents, metadata });
        return `tab_${registrations.length}`;
      },
    });

    await expect(manager.createPage('https://example.test/')).resolves.toBe('tab_1');
    const window = FakeBrowserWindow.instances[0];
    expect(window.options).toEqual({
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(registrations[0]).toEqual({
      webContents: window.webContents,
      metadata: { kind: 'headless' },
    });
    expect(window.loadURL).toHaveBeenCalledWith('https://example.test/');
    expect(manager.size()).toBe(1);

    await expect(manager.closePage('tab_other')).resolves.toBe(false);
    await expect(manager.closePage('tab_1')).resolves.toBe(true);
    expect(window.destroyed).toBe(true);
    expect(manager.size()).toBe(0);
  });

  test('destroys failed pages and returns a typed navigation error', async () => {
    FakeBrowserWindow.nextLoadError = new Error('load failed');
    const manager = createHiddenPageManager({
      BrowserWindow: FakeBrowserWindow,
      registerWebContents: () => 'tab_failed',
    });

    await expect(manager.createPage('https://failed.example/')).rejects.toMatchObject({
      code: 'NAVIGATION_FAILED',
      retryable: true,
    });
    expect(FakeBrowserWindow.instances[0].destroyed).toBe(true);
    expect(manager.size()).toBe(0);
  });

  test('closes every owned page during runtime shutdown', async () => {
    let nextTab = 1;
    const manager = createHiddenPageManager({
      BrowserWindow: FakeBrowserWindow,
      registerWebContents: () => `tab_${nextTab++}`,
    });
    await manager.createPage('https://one.example/');
    await manager.createPage('https://two.example/');

    expect(manager.closeAll()).toBe(2);
    expect(FakeBrowserWindow.instances.every((window) => window.destroyed)).toBe(true);
    expect(manager.size()).toBe(0);
  });
});
