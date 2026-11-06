/**
 * @jest-environment node
 */
'use strict';

/**
 * `window.swarm.publishFiles` and nested paths (#1052): the real publish
 * service and bee-js against a fake Ant, reading the tar the node receives.
 *
 * The files used to be written under a temp directory and uploaded from
 * there, and bee-js names a directory's tar entries with the platform's
 * `path.join`: on Windows a nested `assets/app.js` reached the node as
 * `assets\app.js`, and a nested indexDocument matched no entry. They now go
 * up through publishCollection under the page's own paths. CI runs this
 * suite on Linux only, so the last test loads the upload path under
 * Windows' path rules (`path.win32`) to show no platform path code is left
 * in it.
 */

const http = require('http');

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  dialog: {},
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  app: { getPath: () => '/nonexistent' },
}));
jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  verbose: jest.fn(),
}));
jest.mock('./publish-history', () => ({ addEntry: jest.fn(), updateEntry: jest.fn() }));
jest.mock('../private/private-windows', () => ({ isPrivateWebContents: () => false }));
// Nothing may be staged on disk.
const mockCreateProfileTempDir = jest.fn(() => {
  throw new Error('publishFiles must not stage files on disk');
});
jest.mock('../profile-paths', () => ({
  createProfileTempDir: (...args) => mockCreateProfileTempDir(...args),
}));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));
// Batch choice is swarm-service's (and its own tests'); here it answers
// with one batch, or none.
const mockSelectBestBatch = jest.fn();
jest.mock('./swarm-service', () => ({
  ...jest.requireActual('./swarm-service'),
  selectBestBatch: (...args) => mockSelectBestBatch(...args),
}));

const { NO_USABLE_BATCH_MESSAGE } = require('./batch-errors');

const BATCH = 'ef'.repeat(32);
const REFERENCE = 'cd'.repeat(32);

/** The entries of a ustar archive as bee-js writes it: name and bytes. */
function readTar(buffer) {
  const entries = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim(), 8);
    const start = offset + 512;
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      bytes: buffer.subarray(start, start + size).toString('utf8'),
    });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const FILES = [
  { path: 'index.html', bytes: Buffer.from('<p>home</p>') },
  { path: 'assets/app.js', bytes: Buffer.from('console.log(1)'), contentType: 'text/javascript' },
  { path: 'docs/guide/index.html', bytes: Buffer.from('<p>guide</p>') },
];

describe('publishFilesFromContent', () => {
  let server;
  const uploads = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploads.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        response.writeHead(201, { 'content-type': 'application/json', 'swarm-tag': '42' });
        response.end(JSON.stringify({ reference: REFERENCE }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockAntUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    uploads.length = 0;
    mockSelectBestBatch.mockReset().mockResolvedValue(BATCH);
    mockCreateProfileTempDir.mockClear();
  });

  async function expectPagePaths(service) {
    const result = await service.publishFilesFromContent(FILES, {
      indexDocument: 'docs/guide/index.html',
    });

    expect(result).toMatchObject({
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: 42,
    });
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload.method).toBe('POST');
    expect(upload.url.split('?')[0]).toBe('/bzz');
    expect(upload.headers).toMatchObject({
      'content-type': 'application/x-tar',
      'swarm-collection': 'true',
      'swarm-index-document': 'docs/guide/index.html',
      'swarm-postage-batch-id': BATCH,
      'swarm-pin': 'true',
      'swarm-deferred-upload': 'true',
    });
    // Each entry under the page's own path, `/`-separated, with its bytes.
    expect(readTar(upload.body)).toEqual(
      FILES.map((file) => ({ path: file.path, bytes: file.bytes.toString('utf8') }))
    );
    expect(mockCreateProfileTempDir).not.toHaveBeenCalled();
  }

  test('nested paths and a nested indexDocument reach the node as the page gave them', async () => {
    await expectPagePaths(require('./publish-service'));
    // The batch is chosen for the files' total size, as before.
    const total = FILES.reduce((sum, file) => sum + file.bytes.length, 0);
    expect(mockSelectBestBatch).toHaveBeenCalledWith(total, { requireCapacity: true });
  });

  test('without an indexDocument, a top-level index.html is the index document', async () => {
    const { publishFilesFromContent } = require('./publish-service');

    await publishFilesFromContent(FILES);
    expect(uploads[0].headers['swarm-index-document']).toBe('index.html');

    await publishFilesFromContent(FILES.slice(1));
    expect(uploads[1].headers['swarm-index-document']).toBeUndefined();
  });

  test('no usable batch is the error the page has always seen', async () => {
    const { publishFilesFromContent } = require('./publish-service');
    mockSelectBestBatch.mockResolvedValue(null);

    await expect(publishFilesFromContent(FILES)).rejects.toMatchObject({
      code: 'no-usable-stamps',
      message: NO_USABLE_BATCH_MESSAGE,
    });
    expect(uploads).toHaveLength(0);
  });

  test("under Windows' path rules, the entries keep the page's paths", async () => {
    let service;
    jest.isolateModules(() => {
      jest.doMock('path', () => jest.requireActual('path').win32);
      service = require('./publish-service');
    });
    try {
      // The swap reaches every module loaded that way.
      let joined;
      jest.isolateModules(() => {
        joined = require('path').join('assets', 'app.js');
      });
      expect(joined).toBe('assets\\app.js');

      await expectPagePaths(service);
    } finally {
      jest.dontMock('path');
    }
  });
});
