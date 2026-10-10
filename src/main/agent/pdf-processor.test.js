'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const {
  MAX_PDF_BYTES,
  MAX_PREVIEW_DIMENSION,
  PdfProcessor,
  RESULT_CHANNEL,
  installSessionLockdown,
  validateInput,
  validateResult,
} = require('./pdf-processor');

describe('PdfProcessor', () => {
  test('bounds PDF bytes, page numbers, and progressive text reads', () => {
    expect(validateInput(Buffer.from('%PDF'), {}, 'extractText')).toEqual({
      page: 1,
      pageCount: 1,
    });
    expect(() => validateInput(Buffer.alloc(MAX_PDF_BYTES + 1), {}, 'extractText')).toThrow(
      'between 1 byte and 20 MB'
    );
    expect(() =>
      validateInput(Buffer.from('%PDF'), { pageCount: 5 }, 'extractText')
    ).toThrow('at most 4 PDF pages');
    expect(() => validateInput(Buffer.from('%PDF'), { page: 0 }, 'renderPage')).toThrow(
      'between 1 and 500'
    );
    expect(
      validateInput(Buffer.from('png'), { mimeType: 'image/png' }, 'renderImagePreview')
    ).toEqual({ mimeType: 'image/png' });
    expect(() =>
      validateInput(Buffer.from('gif'), { mimeType: 'image/gif' }, 'renderImagePreview')
    ).toThrow('supported image type');
  });

  test('validates and converts only bounded processor output', () => {
    expect(
      validateResult(
        {
          ok: true,
          value: {
            kind: 'pdf_text',
            pageCount: 2,
            pages: [{ page: 1, text: 'hello' }],
            truncated: true,
          },
        },
        'extractText'
      )
    ).toMatchObject({ pageCount: 2, pages: [{ page: 1, text: 'hello' }] });
    const rendered = validateResult(
      {
        ok: true,
        value: {
          kind: 'pdf_page',
          page: 1,
          pageCount: 2,
          width: 20,
          height: 30,
          mimeType: 'image/png',
          data: new Uint8Array([1, 2, 3]),
        },
      },
      'renderPage'
    );
    expect(Buffer.isBuffer(rendered.data)).toBe(true);
    expect(() =>
      validateResult(
        {
          ok: true,
          value: {
            kind: 'pdf_page',
            page: 1,
            pageCount: 1,
            width: 3000,
            height: 1,
            mimeType: 'image/png',
            data: new Uint8Array([1]),
          },
        },
        'renderPage'
      )
    ).toThrow('invalid page output');
    const preview = validateResult(
      {
        ok: true,
        value: {
          kind: 'attachment_preview',
          sourceKind: 'pdf',
          width: MAX_PREVIEW_DIMENSION,
          height: 128,
          mimeType: 'image/png',
          data: new Uint8Array([1, 2, 3]),
        },
      },
      'renderPdfPreview'
    );
    expect(Buffer.isBuffer(preview.data)).toBe(true);
  });

  test('locks the parser session to explicit local assets and denies permissions', () => {
    let requestListener;
    let permissionRequest;
    const targetSession = {
      setPermissionRequestHandler: jest.fn((listener) => {
        permissionRequest = listener;
      }),
      setPermissionCheckHandler: jest.fn(),
      webRequest: {
        onBeforeRequest: jest.fn((_filter, listener) => {
          requestListener = listener;
        }),
      },
    };
    const allowedFile = path.join('/app', 'processor.html');
    installSessionLockdown(targetSession, {
      allowedFiles: [allowedFile],
      allowedRoots: [path.join('/app', 'pdfjs')],
    });

    const permissionCallback = jest.fn();
    permissionRequest(null, 'clipboard-read', permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
    const allow = jest.fn();
    requestListener({ url: `file://${allowedFile}` }, allow);
    expect(allow).toHaveBeenLastCalledWith({ cancel: false });
    requestListener({ url: 'file:///Users/private/secrets.txt' }, allow);
    expect(allow).toHaveBeenLastCalledWith({ cancel: true });
    requestListener({ url: 'https://example.com/leak' }, allow);
    expect(allow).toHaveBeenLastCalledWith({ cancel: true });
  });

  test('accepts a result only from the exact parser webContents and destroys the sandbox', async () => {
    const ipcMain = new EventEmitter();
    const windows = [];
    class FakeWindow {
      constructor(options) {
        this.options = options;
        this.destroyed = false;
        this.webContents = new EventEmitter();
        this.webContents.session = {
          setPermissionRequestHandler: jest.fn(),
          setPermissionCheckHandler: jest.fn(),
          webRequest: { onBeforeRequest: jest.fn() },
        };
        this.webContents.setWindowOpenHandler = jest.fn();
        this.webContents.send = jest.fn((_channel, request) => {
          ipcMain.emit(RESULT_CHANNEL, { sender: {} }, {
            jobId: request.jobId,
            ok: true,
            value: { kind: 'pdf_text', pageCount: 1, pages: [{ page: 1, text: 'wrong' }] },
          });
          ipcMain.emit(RESULT_CHANNEL, { sender: this.webContents }, {
            jobId: request.jobId,
            ok: true,
            value: { kind: 'pdf_text', pageCount: 1, pages: [{ page: 1, text: 'right' }] },
          });
        });
        windows.push(this);
      }

      loadURL = jest.fn(async () => {});
      isDestroyed = jest.fn(() => this.destroyed);
      destroy = jest.fn(() => {
        this.destroyed = true;
      });
    }

    const processor = new PdfProcessor({ BrowserWindow: FakeWindow, ipcMain });
    await expect(processor.extractText(Buffer.from('%PDF'))).resolves.toMatchObject({
      pages: [{ text: 'right' }],
    });
    expect(windows[0].options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(windows[0].destroy).toHaveBeenCalledTimes(1);
    expect(ipcMain.listenerCount(RESULT_CHANNEL)).toBe(0);
  });
});
