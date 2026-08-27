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
    this.focus = jest.fn();
    this.sendInputEvent = jest.fn();
    this.capturePage = jest.fn(async () => ({ toPNG: () => Buffer.from('png') }));
    this.stop = jest.fn();
    this.debugger = {
      attach: jest.fn(),
      detach: jest.fn(),
      isAttached: jest.fn(() => false),
      sendCommand: jest.fn(),
    };
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
    frames: [
      {
        frameId: 'frame_main',
        parentFrameId: null,
        depth: 0,
        name: '',
        url: 'https://example.test/',
        accessible: true,
      },
    ],
    elements: [
      {
        ref: 'ref_test_0',
        frameId: 'frame_main',
        role: 'button',
        name: 'Submit',
        tag: 'button',
        disabled: false,
        focused: false,
        editable: false,
        effect: 'form_submission',
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
        ref: 'ref_test_0',
        frameId: 'frame_main',
        role: 'button',
        name: 'Submit',
        tag: 'button',
        disabled: false,
        focused: false,
        editable: false,
        effect: 'form_submission',
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
      .mockResolvedValueOnce({ ok: true, point: { x: 20, y: 30 } })
      .mockResolvedValueOnce({ ok: true, point: { x: 20, y: 30 } })
      .mockResolvedValueOnce({ ok: true });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.click('ref_test_0')).resolves.toEqual({
      clicked: true,
      ref: 'ref_test_0',
    });
    expect(webContents.focus).toHaveBeenCalledTimes(1);
    expect(webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: 'mouseMove', x: 20, y: 30 }],
      [{ type: 'mouseDown', x: 20, y: 30, button: 'left', clickCount: 1 }],
      [{ type: 'mouseUp', x: 20, y: 30, button: 'left', clickCount: 1 }],
    ]);
    await expect(adapter.type('ref_test_0', 'hello')).resolves.toEqual({
      typed: true,
      ref: 'ref_test_0',
      characters: 5,
    });
    expect(webContents.insertText).toHaveBeenCalledWith('hello');
    const typeCode = webContents.executeJavaScriptInIsolatedWorld.mock.calls[3][1][0].code;
    expect(typeCode).toContain('const inspectReferencedElement');
  });

  test('reserves declarative file links for the controlled download action', async () => {
    const webContents = new FakeWebContents();
    const downloadSnapshot = snapshotResult();
    downloadSnapshot.elements[0] = {
      ...downloadSnapshot.elements[0],
      role: 'link',
      tag: 'a',
      effect: 'file_download',
    };
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(downloadSnapshot)
      .mockResolvedValueOnce({ ok: true, effect: 'file_download', label: 'Download report' })
      .mockResolvedValueOnce({ ok: true, point: { x: 20, y: 30 } })
      .mockResolvedValueOnce({ ok: true, point: { x: 20, y: 30 } });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.click('ref_test_0')).rejects.toMatchObject({
      code: ERROR_CODES.CAPABILITY_UNAVAILABLE,
    });
    await expect(adapter.download('ref_test_0')).resolves.toEqual({
      clicked: true,
      ref: 'ref_test_0',
    });
    expect(webContents.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mouseUp', button: 'left' })
    );
  });

  test('attaches one selected file to the exact snapshotted file input through Chromium', async () => {
    const webContents = new FakeWebContents();
    const uploadSnapshot = snapshotResult();
    uploadSnapshot.elements[0] = {
      ...uploadSnapshot.elements[0],
      name: 'Résumé',
      tag: 'input',
      effect: 'file_upload',
      accept: '.pdf',
      multiple: false,
    };
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(uploadSnapshot)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        filename: 'résumé.pdf',
        bytes: 4096,
        mimeType: 'application/pdf',
        fileCount: 1,
      })
      .mockResolvedValueOnce({ ok: true });
    webContents.debugger.sendCommand.mockImplementation(async (command) => {
      if (command === 'DOM.performSearch') return { searchId: 'search_upload', resultCount: 1 };
      if (command === 'DOM.getSearchResults') return { nodeIds: [42] };
      return {};
    });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.click('ref_test_0')).rejects.toMatchObject({
      code: ERROR_CODES.CAPABILITY_UNAVAILABLE,
    });
    await expect(adapter.upload('ref_test_0', '/private/path/résumé.pdf')).resolves.toEqual({
      attached: true,
      ref: 'ref_test_0',
      filename: 'résumé.pdf',
      bytes: 4096,
      mimeType: 'application/pdf',
      fileCount: 1,
    });
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', {
      nodeId: 42,
      files: ['/private/path/résumé.pdf'],
    });
    expect(webContents.debugger.detach).toHaveBeenCalledTimes(1);
  });

  test('revalidates native form-submission semantics without dispatching input', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(snapshotResult())
      .mockResolvedValueOnce({
        ok: true,
        effect: 'form_submission',
        label: 'Submit registration',
        navigationTarget: 'https://example.test/submit',
        formPayloadFingerprint: 'payload_hash',
      });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.inspectAction('ref_test_0')).resolves.toEqual({
      effect: 'form_submission',
      label: 'Submit registration',
      navigationTarget: 'https://example.test/submit',
      formPayloadFingerprint: 'payload_hash',
    });
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(webContents.insertText).not.toHaveBeenCalled();
    expect(webContents.executeJavaScriptInIsolatedWorld.mock.calls[1][2]).toBe(false);
    const inspectionCode = webContents.executeJavaScriptInIsolatedWorld.mock.calls[1][1][0].code;
    expect(inspectionCode).toContain('new formWindow.FormData');
    expect(inspectionCode).toContain('crypto.subtle.digest');
  });

  test('focuses a press target before inspecting its live action semantics', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(snapshotResult())
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        effect: 'form_submission',
        label: 'Submit registration',
        navigationTarget: 'https://example.test/submit',
        formPayloadFingerprint: 'payload_hash',
      });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(
      adapter.inspectAction('ref_test_0', { operation: 'browser_press', key: 'Enter' })
    ).resolves.toEqual({
      effect: 'form_submission',
      label: 'Submit registration',
      navigationTarget: 'https://example.test/submit',
      formPayloadFingerprint: 'payload_hash',
    });
    expect(webContents.executeJavaScriptInIsolatedWorld.mock.calls[1][2]).toBe(true);
    expect(webContents.executeJavaScriptInIsolatedWorld.mock.calls[2][2]).toBe(false);
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  test('describes type and select targets without dispatching their actions', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(snapshotResult())
      .mockResolvedValueOnce({ ok: true, label: 'Contact email' })
      .mockResolvedValueOnce({ ok: true, label: 'Deployment region' });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(
      adapter.inspectAction('ref_test_0', { operation: 'browser_type' })
    ).resolves.toEqual({ label: 'Contact email' });
    await expect(
      adapter.inspectAction('ref_test_0', { operation: 'browser_select' })
    ).resolves.toEqual({ label: 'Deployment region' });
    expect(webContents.insertText).not.toHaveBeenCalled();
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  test('selects a snapshot option and presses bounded keys through trusted input', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(snapshotResult())
      .mockResolvedValueOnce({ ok: true, trusted: false })
      .mockResolvedValueOnce({ ok: true });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.select('ref_test_0', 'eu-west')).resolves.toEqual({
      selected: true,
      ref: 'ref_test_0',
      value: 'eu-west',
      trusted: false,
    });
    await expect(adapter.press('ref_test_0', 'Enter')).resolves.toEqual({
      pressed: true,
      ref: 'ref_test_0',
      key: 'Enter',
    });
    expect(webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Enter' }],
      [{ type: 'char', keyCode: 'Enter' }],
      [{ type: 'keyUp', keyCode: 'Enter' }],
    ]);
  });

  test('revalidates click targets after moving the trusted pointer', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(snapshotResult())
      .mockResolvedValueOnce({ ok: true, point: { x: 20, y: 30 } })
      .mockResolvedValueOnce({ ok: false, reason: 'not_interactable' });
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    await expect(adapter.click('ref_test_0')).rejects.toMatchObject({
      code: ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
    });
    expect(webContents.sendInputEvent.mock.calls).toEqual([[{ type: 'mouseMove', x: 20, y: 30 }]]);
  });

  test('fails closed when navigation makes a reference stale', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(snapshotResult());
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();
    await adapter.navigate('https://next.example.test/');

    await expect(adapter.click('ref_test_0')).rejects.toMatchObject({
      code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
      retryable: true,
      suggestedAction: 'Take a new snapshot',
    });
    expect(webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
  });

  test('invalidates references when a child frame navigates', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(snapshotResult());
    const adapter = new WebContentsPageAdapter(webContents, {
      referenceIdFactory: () => 'ref_test',
    });
    await adapter.snapshot();

    webContents.emit('did-start-navigation', {}, 'https://frame.example.test/', false, false);

    await expect(adapter.click('ref_test_0')).rejects.toMatchObject({
      code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
    });
    expect(adapter.getState()).toMatchObject({ navigationId: 1, loading: false });
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

    await expect(adapter.click('ref_test_0')).rejects.toMatchObject({
      code: ERROR_CODES.STALE_ELEMENT_REFERENCE,
    });
    await expect(adapter.click('ref_test_0')).rejects.toMatchObject({
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
    await expect(adapter.stopLoading()).resolves.toEqual({ stopped: true, cancelledWaits: 0 });
    expect(webContents.stop).toHaveBeenCalledTimes(1);
  });

  test('waits for declarative page conditions and reports timeouts', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const adapter = new WebContentsPageAdapter(webContents);

    await expect(
      adapter.wait({ condition: 'text', text: 'Ready', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ matched: true, condition: 'text' });
    await expect(
      adapter.wait({ condition: 'navigation', sinceNavigationId: 0, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: ERROR_CODES.WAIT_TIMEOUT, retryable: true });
  });

  test('retries text waits when navigation destroys the execution context', async () => {
    const webContents = new FakeWebContents();
    webContents.executeJavaScriptInIsolatedWorld
      .mockImplementationOnce(async () => {
        webContents.loading = true;
        webContents.emit('did-start-navigation', {}, 'https://next.example.test/', false, true);
        webContents.url = 'https://next.example.test/';
        webContents.loading = false;
        webContents.emit('did-navigate', {}, 'https://next.example.test/');
        throw new Error('Execution context was destroyed');
      })
      .mockResolvedValueOnce(true);
    const adapter = new WebContentsPageAdapter(webContents);

    await expect(
      adapter.wait({ condition: 'text', text: 'Ready', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ matched: true, condition: 'text', navigationId: 1 });
  });

  test('stop-loading cancels active waits', async () => {
    const webContents = new FakeWebContents();
    const adapter = new WebContentsPageAdapter(webContents);
    const pending = adapter.wait({
      condition: 'navigation',
      sinceNavigationId: 0,
      timeoutMs: 1_000,
    });

    await expect(adapter.stopLoading()).resolves.toEqual({ stopped: true, cancelledWaits: 1 });
    await expect(pending).rejects.toMatchObject({ code: ERROR_CODES.USER_CANCELLED });
  });
});
