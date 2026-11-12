/**
 * @jest-environment node
 */
'use strict';

/**
 * A page's uploads to the node (page-upload.js; freedom-core design 0011,
 * PRQ-7c): the requests bee-js made, against a fake Ant, sent in views of
 * the bytes main already holds. No write copies the body: each one shares
 * the caller's memory and is at most 64 KiB.
 */

const http = require('http');

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  dialog: {},
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  app: { getPath: () => '/nonexistent' },
}));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }));
jest.mock('./publish-history', () => ({ addEntry: jest.fn(), updateEntry: jest.fn() }));
jest.mock('../private/private-windows', () => ({ isPrivateWebContents: () => false }));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));
const mockSelectBestBatch = jest.fn();
jest.mock('./swarm-service', () => ({
  ...jest.requireActual('./swarm-service'),
  selectBestBatch: (...args) => mockSelectBestBatch(...args),
}));

const { uploadData, uploadCollection, SLICE_BYTES, SLICE_CHARS } = require('./page-upload');
const { publishPageData, publishFilesFromContent } = require('./publish-service');
const { isBatchNotYetKnownError } = require('./ant-storage-api');

const BATCH = 'ef'.repeat(32);
const REFERENCE = 'cd'.repeat(32);

describe('page uploads to the node (0011 PRQ-7c)', () => {
  let server;
  const uploads = [];
  // What the next upload is answered: status, headers and body.
  let answer = null;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (answer?.early) {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
        return;
      }
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploads.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
        const out = answer || { status: 201, headers: { 'swarm-tag': '42' }, body: JSON.stringify({ reference: REFERENCE }) };
        response.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers || {}) });
        response.end(out.body);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockAntUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  let writes;
  beforeEach(() => {
    uploads.length = 0;
    answer = null;
    mockSelectBestBatch.mockReset().mockResolvedValue(BATCH);
    writes = [];
    const write = http.ClientRequest.prototype.write;
    jest.spyOn(http.ClientRequest.prototype, 'write').mockImplementation(function spy(chunk, ...rest) {
      writes.push(chunk);
      return write.call(this, chunk, ...rest);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('one file: POST /bzz with its name, content type and batch, pinned, not deferred; the body in views of the caller\'s bytes', async () => {
    const bytes = Buffer.alloc(3 * SLICE_BYTES + 5, 7);
    expect(await uploadData(mockAntUrl, BATCH, bytes, { name: 'note.bin', contentType: 'application/x-test' })).toEqual({
      reference: REFERENCE,
      tagUid: 42,
    });
    const [upload] = uploads;
    expect(upload.method).toBe('POST');
    expect(upload.url).toBe('/bzz?name=note.bin');
    expect(upload.headers).toMatchObject({
      'content-type': 'application/x-test',
      'content-length': String(bytes.length),
      'swarm-postage-batch-id': BATCH,
      'swarm-pin': 'true',
      'swarm-deferred-upload': 'false',
    });
    expect(upload.body.equals(bytes)).toBe(true);
    // Every write is a view of the caller's own memory, at most 64 KiB.
    expect(writes).toHaveLength(4);
    for (const chunk of writes) {
      expect(chunk.buffer).toBe(bytes.buffer);
      expect(chunk.byteLength).toBeLessThanOrEqual(SLICE_BYTES);
    }
  });

  test('a string goes as its UTF-8, a slice at a time, a surrogate pair never split; with no name or type, bee-js\' defaults', async () => {
    const text = `${String.fromCharCode(0x100)}héllo`;
    await uploadData(mockAntUrl, BATCH, text);
    expect(uploads[0].url).toBe('/bzz?name=data');
    expect(uploads[0].headers['content-type']).toBe('text/plain');
    expect(uploads[0].headers['content-length']).toBe(String(Buffer.byteLength(text)));
    expect(uploads[0].body.toString('utf8')).toBe(text);
    // A pair across the first slice's end, and a lone surrogate at another's.
    const long = `${'a'.repeat(SLICE_CHARS - 1)}\u{1F600}${'é'.repeat(SLICE_CHARS)}\uD800${'b'.repeat(10)}`;
    writes.length = 0;
    await uploadData(mockAntUrl, BATCH, long);
    expect(uploads[1].headers['content-length']).toBe(String(Buffer.byteLength(long)));
    expect(uploads[1].body.equals(Buffer.from(long))).toBe(true);
    expect(writes.length).toBeGreaterThan(2);
    for (const chunk of writes) expect(chunk.byteLength).toBeLessThanOrEqual(SLICE_BYTES);
  });

  test('a collection: a ustar archive of each file under the page\'s own path, its index document, deferred; files in views', async () => {
    const files = [
      { path: 'index.html', bytes: Buffer.from('<p>home</p>') },
      { path: 'assets/app.js', bytes: Buffer.alloc(SLICE_BYTES + 1, 1) },
    ];
    expect(await uploadCollection(mockAntUrl, BATCH, files, { indexDocument: 'index.html' })).toEqual({ reference: REFERENCE, tagUid: 42 });
    const [upload] = uploads;
    expect(upload.url).toBe('/bzz');
    expect(upload.headers).toMatchObject({
      'content-type': 'application/x-tar',
      'swarm-collection': 'true',
      'swarm-index-document': 'index.html',
      'swarm-postage-batch-id': BATCH,
      'swarm-pin': 'true',
      'swarm-deferred-upload': 'true',
      'content-length': String(upload.body.length),
    });
    // Headers, the files' bytes and padding, and the two end blocks.
    expect(upload.body.length).toBe(512 + 512 + 512 + Math.ceil((SLICE_BYTES + 1) / 512) * 512 + 1024);
    const header = upload.body.subarray(0, 512);
    expect(header.subarray(0, 10).toString()).toBe('index.html');
    expect(header.subarray(257, 263).toString()).toBe('ustar\0');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    expect(parseInt(header.subarray(148, 154).toString(), 8)).toBe(sum);
    expect(upload.body.subarray(512, 523).toString()).toBe('<p>home</p>');
    const views = writes.filter((chunk) => chunk.buffer === files[1].bytes.buffer);
    expect(views.map((v) => v.byteLength)).toEqual([SLICE_BYTES, 1]);
  });

  test('a failed answer throws as bee-js did, `<status text>: <body>` with the status, so the provider\'s error mapping reads it the same', async () => {
    const body = JSON.stringify({ code: 422, message: 'push chunk failed: pushsync: postage batch 0xab rejected by 2 peer(s) as not found on-chain' });
    answer = { status: 422, body };
    const err = await uploadData(mockAntUrl, BATCH, Buffer.from('x')).catch((e) => e);
    expect(err).toMatchObject({ status: 422, message: `Unprocessable Entity: ${body}` });
    expect(isBatchNotYetKnownError(err.message)).toBe(true);
    // An answer with no reference, or an early refusal of the body.
    answer = { status: 201, body: '{}' };
    await expect(uploadData(mockAntUrl, BATCH, Buffer.from('x'))).rejects.toThrow('no reference');
    answer = { early: true, status: 413, body: 'too large' };
    await expect(uploadData(mockAntUrl, BATCH, Buffer.alloc(8 * SLICE_BYTES))).rejects.toMatchObject({ status: 413 });
  });

  test('publish-service: the batch first, then the write under the caller\'s guard, which may send nothing', async () => {
    const order = [];
    const out = await publishPageData('hello', {
      contentType: 'text/plain',
      name: 'n',
      guard: async (send) => {
        order.push('guard');
        return send();
      },
      onSend: () => order.push('send'),
    });
    expect(out).toMatchObject({ reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}`, tagUid: 42, batchIdUsed: BATCH, bytesSize: 5 });
    expect(mockSelectBestBatch).toHaveBeenCalledWith(5, { requireCapacity: true });
    expect(order).toEqual(['guard', 'send']);
    expect(await publishPageData('hello', { guard: async () => null })).toBeNull();
    expect(await publishFilesFromContent([{ path: 'a', bytes: Buffer.from('x') }], { guard: async () => null })).toBeNull();
    expect(uploads).toHaveLength(1);
  });
});
