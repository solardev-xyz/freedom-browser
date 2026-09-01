'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const REQUEST_CHANNEL = 'agent:pdf-processor:request';
const RESULT_CHANNEL = 'agent:pdf-processor:result';
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_PAGES = 4;
const TEXT_TIMEOUT_MS = 15_000;
const RENDER_TIMEOUT_MS = 30_000;

function insidePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateInput(data, options, operation) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw new TypeError('PDF processing requires PDF bytes');
  }
  if (data.byteLength === 0 || data.byteLength > MAX_PDF_BYTES) {
    throw new Error('PDF files must be between 1 byte and 20 MB');
  }
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 500) {
    throw new Error('PDF page must be between 1 and 500');
  }
  const pageCount = operation === 'extractText' ? options.pageCount ?? 1 : 1;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_TEXT_PAGES) {
    throw new Error(`Read at most ${MAX_TEXT_PAGES} PDF pages at once`);
  }
  return { page, pageCount };
}

function processorWindowOptions(BrowserWindow, partition) {
  return {
    show: false,
    paintWhenInitiallyHidden: true,
    width: 64,
    height: 64,
    webPreferences: {
      preload: path.join(__dirname, 'pdf-processor-preload.js'),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    },
  };
}

function installSessionLockdown(targetSession, { allowedFiles = [], allowedRoots = [] } = {}) {
  const files = new Set(allowedFiles.map((file) => path.resolve(file)));
  const roots = allowedRoots.map((root) => path.resolve(root));
  targetSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler?.(() => false);
  targetSession.webRequest.onBeforeRequest(
    { urls: ['*://*/*', 'file:///*', 'blob:*', 'data:*'] },
    (details, callback) => {
      try {
        const url = new URL(details.url);
        if (url.protocol === 'blob:' || url.protocol === 'data:') return callback({ cancel: false });
        if (url.protocol !== 'file:') return callback({ cancel: true });
        const candidate = fileURLToPath(url);
        const resolved = path.resolve(candidate);
        const allowed = files.has(resolved) || roots.some((root) => insidePath(root, resolved));
        callback({ cancel: !allowed });
      } catch {
        callback({ cancel: true });
      }
    }
  );
}

function validateResult(result, operation) {
  if (!result || typeof result !== 'object') throw new Error('PDF processor returned no result');
  if (result.ok !== true) {
    const error = new Error(result.error?.message || 'The PDF could not be processed safely');
    error.code = result.error?.code || 'PDF_PROCESSING_FAILED';
    throw error;
  }
  const value = result.value;
  if (operation === 'extractText') {
    if (
      value?.kind !== 'pdf_text' ||
      !Number.isSafeInteger(value.pageCount) ||
      !Array.isArray(value.pages) ||
      value.pages.length > MAX_TEXT_PAGES ||
      value.pages.some(
        (item) => !Number.isSafeInteger(item?.page) || typeof item?.text !== 'string'
      )
    ) {
      throw new Error('PDF processor returned invalid text output');
    }
    const characterCount = value.pages.reduce((total, item) => total + item.text.length, 0);
    if (characterCount > 128 * 1024) throw new Error('PDF processor exceeded the text limit');
    return value;
  }
  if (
    value?.kind !== 'pdf_page' ||
    value.mimeType !== 'image/png' ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.pageCount) ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    !(value.data instanceof Uint8Array) ||
    value.data.byteLength > 8 * 1024 * 1024 ||
    value.width > 2048 ||
    value.height > 2048 ||
    value.width * value.height > 4_000_000
  ) {
    throw new Error('PDF processor returned invalid page output');
  }
  return { ...value, data: Buffer.from(value.data) };
}

class PdfProcessor {
  constructor(options = {}) {
    if (typeof options.BrowserWindow !== 'function') {
      throw new TypeError('PDF processor requires Electron BrowserWindow');
    }
    if (!options.ipcMain || typeof options.ipcMain.on !== 'function') {
      throw new TypeError('PDF processor requires Electron ipcMain');
    }
    this.BrowserWindow = options.BrowserWindow;
    this.ipcMain = options.ipcMain;
    this.timeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.windows = new Set();
  }

  extractText(data, options = {}) {
    return this.#process('extractText', data, options);
  }

  renderPage(data, options = {}) {
    return this.#process('renderPage', data, options);
  }

  dispose() {
    for (const window of this.windows) {
      if (!window.isDestroyed?.()) window.destroy();
    }
    this.windows.clear();
  }

  async #process(operation, data, options) {
    const validated = validateInput(data, options, operation);
    if (options.signal?.aborted) throw Object.assign(new Error('PDF processing was cancelled'), { code: 'ABORT_ERR' });
    const jobId = `pdf_${crypto.randomUUID()}`;
    const partition = `pdf-processor-${crypto.randomUUID()}`;
    const window = new this.BrowserWindow(processorWindowOptions(this.BrowserWindow, partition));
    this.windows.add(window);
    const rendererRoot = path.resolve(__dirname, '..', '..', 'renderer');
    const pdfRoot = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'pdfjs-dist');
    installSessionLockdown(window.webContents.session, {
      allowedFiles: [
        path.join(rendererRoot, 'pages', 'pdf-processor.html'),
        path.join(rendererRoot, 'lib', 'pdf-processor.js'),
      ],
      allowedRoots: [pdfRoot],
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('will-navigate', (event) => event.preventDefault());

    const timeoutMs = operation === 'extractText' ? TEXT_TIMEOUT_MS : RENDER_TIMEOUT_MS;
    let timer;
    let abortListener;
    let resultListener;
    const cleanup = () => {
      if (timer) this.clearTimeout(timer);
      if (abortListener) options.signal?.removeEventListener('abort', abortListener);
      if (resultListener) this.ipcMain.removeListener(RESULT_CHANNEL, resultListener);
      this.windows.delete(window);
      if (!window.isDestroyed?.()) window.destroy();
    };

    try {
      await window.loadURL(pathToFileURL(path.join(rendererRoot, 'pages', 'pdf-processor.html')).href);
      const result = await new Promise((resolve, reject) => {
        resultListener = (event, payload) => {
          if (event.sender !== window.webContents || payload?.jobId !== jobId) return;
          resolve(payload);
        };
        this.ipcMain.on(RESULT_CHANNEL, resultListener);
        timer = this.timeout(() => {
          const error = new Error('PDF processing timed out');
          error.code = 'PDF_PROCESSING_TIMEOUT';
          reject(error);
        }, timeoutMs);
        abortListener = () => {
          const error = new Error('PDF processing was cancelled');
          error.code = 'ABORT_ERR';
          reject(error);
        };
        options.signal?.addEventListener('abort', abortListener, { once: true });
        window.webContents.send(REQUEST_CHANNEL, {
          jobId,
          operation,
          data: new Uint8Array(data),
          ...validated,
        });
      });
      return validateResult(result, operation);
    } finally {
      cleanup();
    }
  }
}

module.exports = {
  MAX_PDF_BYTES,
  MAX_TEXT_PAGES,
  PdfProcessor,
  RENDER_TIMEOUT_MS,
  REQUEST_CHANNEL,
  RESULT_CHANNEL,
  TEXT_TIMEOUT_MS,
  insidePath,
  installSessionLockdown,
  validateInput,
  validateResult,
};
