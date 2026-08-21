'use strict';

const { EventEmitter } = require('events');
const { WebContentsPageAdapter, AUTOMATION_WORLD_ID } = require('./web-contents-page-adapter');
const { ERROR_CODES } = require('../contract/errors');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.url = 'https://example.test/';
    this.title = 'Fixture';
    this.destroyed = false;
    this.loading = false;
    this.executeJavaScriptInIsolatedWorld = jest.fn();
    this.insertText = jest.fn(async () => {});
    this.capturePage = jest.fn(async () => ({ toPNG: () => Buffer.from('png') }));
    this.stop = jest.fn();
  }

  async loadURL(url) {
    this.loading = true;
    this.emit('did-start-navigation', {}, url, false, true);
    this.url = url;
    this.loading = false;
    this.emit('did-navigate', {}, url);
  }

  getURL() {
    return this.url;
  }

  getTitle() {
    return this.title;
  }

  isLoading() {
    return this.loading;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function snapshotResult() {
  return {
    url: 'https://example.test/',
    title: 'Fixture',
    text: 'Submit Name',
    truncated: false,
    elements: [
      {
        selector: 'html > body:nth-child(2) > button:nth-child(1)',
        fingerprint: 'button||button|Submit',
        role: 'button',
        name: 'Submit',
        tag: 'button',
        disabled: false,
        focused: false,
        editable: false,
      },
    ],
  };
}

describe('WebContentsPageAdapter', () => {
  test('creates public references without leaking selectors', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(snapshotResult());
    const adapter = new WebContentsPageAdapter(webContents, {
      kind: 'desktop',
      referenceIdFactory: () => 'ref_test',
    });

    const snapshot = await adapter.snapshot();
    expect(snapshot.elements).toEqual([
      {
        ref: 'ref_test',
        role: 'button',
        name: 'Submit',
        tag: 'button',
        disabled: false,
        focused: false,
        editable: false,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/selector|fingerprint|webContents/);
    expect(webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      AUTOMATION_WORLD_ID,
      [expect.objectContaining({ url: 'freedom://automation' })],
      false
    );
  });

  test('clicks and types only through references from the current navigation', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(snapshotResult())
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.click('ref_test')).resolves.toEqual({ clicked: true, ref: 'ref_test' });
    await expect(adapter.type('ref_test', 'hello')).resolves.toEqual({
      typed: true,
      ref: 'ref_test',
      characters: 5,
    });
    expect(webContents.insertText).toHaveBeenCalledWith('hello');
    const typeCode = webContents.executeJavaScriptInIsolatedWorld.mock.calls[2][1][0].code;
    expect(typeCode).toContain('const inspectReferencedElement');
  });

  test('fails closed when navigation makes a reference stale', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(snapshotResult());
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();
    await adapter.navigate('https://next.example.test/');

    await expect(adapter.click('ref_test')).rejects.toMatchObject({
      code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
      retryable: true,
      suggestedAction: 'Take a new snapshot',
    });
    expect(webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
  });

  test('maps page changes and unavailable elements to typed errors', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(snapshotResult())
      .mockResolvedValueOnce({ ok: false, reason: 'changed' })
      .mockResolvedValueOnce({ ok: false, reason: 'not_interactable' });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.click('ref_test')).rejects.toMatchObject({
      code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
    });
    await expect(adapter.click('ref_test')).rejects.toMatchObject({
      code: ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
    });
  });

  test('captures PNG screenshots and stops page loading', async () => {
    const webContents = new FakeWebContents();
    const adapter = new WebContentsPageAdapter(webContents);
    await expect(adapter.screenshot()).resolves.toEqual({
      mediaType: 'image/png',
      base64: Buffer.from('png').toString('base64'),
    });
    await expect(adapter.stopLoading()).resolves.toEqual({ stopped: true });
    expect(webContents.stop).toHaveBeenCalledTimes(1);
  });
});
