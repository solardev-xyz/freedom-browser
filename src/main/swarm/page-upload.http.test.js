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

async function waitFor(condition, ms = 5000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const REFERENCE = 'cd'.repeat(32);

describe('page uploads to the node (0011 PRQ-7c)', () => {
  let server;
  const uploads = [];
  // The uploads a stalling node took.
  const started = [];
  const stalled = [];
  // Every client request the upload made (from the write spy).
  const clientRequests = new Set();
  // What the next upload is answered: status, headers and body.
  let answer = null;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (answer?.stall === 'reading') {
        // Takes the connection and never reads the body. A paused socket
        // doesn't see the client go, so the test ends it.
        request.pause();
        started.push(request.url);
        stalled.push(request);
        return;
      }
      if (answer?.early) {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
        return;
      }
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        uploads.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
        // Reads it all, then never answers, or answers in part.
        if (answer?.stall === 'answering') return;
        if (answer?.stall === 'answer-body') {
          response.writeHead(201, { 'content-type': 'application/json' });
          response.write('{"refer');
          return;
        }
        const out = answer || { status: 201, headers: { 'swarm-tag': '42' }, body: JSON.stringify({ reference: REFERENCE }) };
        response.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers || {}) });
        response.end(out.body);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockAntUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  let writes;
  beforeEach(() => {
    uploads.length = 0;
    started.length = 0;
    clientRequests.clear();
    answer = null;
    mockSelectBestBatch.mockReset().mockResolvedValue(BATCH);
    writes = [];
    const write = http.ClientRequest.prototype.write;
    jest.spyOn(http.ClientRequest.prototype, 'write').mockImplementation(function spy(chunk, ...rest) {
      writes.push(chunk);
      clientRequests.add(this);
      return write.call(this, chunk, ...rest);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const request of stalled.splice(0)) request.socket?.destroy();
  });

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

  // Codex round 2 on #1199: an answer before the whole body went, refusal or
  // success, ends the upload with its request destroyed, and its writer
  // waiting on nothing. A raw socket answers, since Node's own server reads
  // and drops the rest of a body once it has answered.
  test('an answer before the whole body went fails the upload, a success too, and leaves no writer waiting', async () => {
    const net = require('net');
    const sockets = [];
    let reply = '';
    const raw = net.createServer((socket) => {
      sockets.push(socket);
      socket.once('data', () => {
        socket.pause();
        socket.write(reply);
      });
    });
    await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const rawUrl = `http://127.0.0.1:${raw.address().port}`;
    const response = (status, text, body, headers = '') =>
      `HTTP/1.1 ${status} ${text}\r\ncontent-type: application/json\r\n${headers}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    try {
      for (const early of [
        { reply: response(413, 'Payload Too Large', '"too large"'), error: { status: 413 } },
        {
          reply: response(201, 'Created', JSON.stringify({ reference: REFERENCE }), 'swarm-tag: 42\r\n'),
          error: { message: 'The node answered before it had taken the whole upload' },
        },
      ]) {
        reply = early.reply;
        clientRequests.clear();
        const err = await uploadData(rawUrl, BATCH, Buffer.alloc(32 * 1024 * 1024)).catch((e) => e);
        expect({ reply: early.reply.slice(9, 12), err }).toEqual({ reply: early.reply.slice(9, 12), err: expect.objectContaining(early.error) });
        const [request] = [...clientRequests];
        await waitFor(() => request.listenerCount('drain') === 0, 2000).catch(() => {});
        expect({ destroyed: request.destroyed, finished: request.writableFinished, drain: request.listenerCount('drain') }).toEqual({
          destroyed: true,
          finished: false,
          drain: 0,
        });
        // Nothing of the upload's own waits on the request.
        expect(request.listeners('close').some((listener) => listener.name === 'done')).toBe(false);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => raw.close(resolve));
    }
  });

  // Codex round 1 on #1199: an upload ends, with its socket let go, however
  // the node behaves, and stops on the caller's signal.
  test('a node that stops taking the body is given up on after the stall bound, and the connection goes', async () => {
    answer = { stall: 'reading' };
    const err = await uploadData(mockAntUrl, BATCH, Buffer.alloc(32 * 1024 * 1024), { timeouts: { stallMs: 300 } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ETIMEDOUT', message: 'The node stopped taking the upload' });
    expect(started).toEqual(['/bzz?name=data']);
    // The client let its socket go.
    expect(clientRequests.size).toBe(1);
    expect([...clientRequests][0].destroyed).toBe(true);
  });

  test('a node that takes the body and never answers, or answers in part, is given up on after the answer bound', async () => {
    for (const stall of ['answering', 'answer-body']) {
      answer = { stall };
      clientRequests.clear();
      const err = await uploadCollection(mockAntUrl, BATCH, [{ path: 'a', bytes: Buffer.from('x') }], { timeouts: { answerMs: 300 } }).catch((e) => e);
      expect({ stall, err: { code: err.code, message: err.message } }).toEqual({
        stall,
        err: { code: 'ETIMEDOUT', message: 'The node did not answer the upload in time' },
      });
      expect([...clientRequests].map((r) => r.destroyed)).toEqual([true]);
    }
  });

  test('the caller\'s signal stops an upload while its body goes, and one aborted already sends nothing', async () => {
    answer = { stall: 'reading' };
    const controller = new AbortController();
    const pending = uploadData(mockAntUrl, BATCH, Buffer.alloc(32 * 1024 * 1024), { signal: controller.signal }).catch((e) => e);
    await waitFor(() => started.length === 1);
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError', message: 'The upload was cancelled' });
    expect([...clientRequests][0].destroyed).toBe(true);

    started.length = 0;
    answer = null;
    const aborted = new AbortController();
    aborted.abort();
    await expect(uploadData(mockAntUrl, BATCH, Buffer.from('x'), { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads).toEqual([]);
    expect(started).toEqual([]);
  });

  test('a redirect isn\'t followed: the upload goes to the node in the registry and nowhere else', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      answer = { status, headers: { location: `${mockAntUrl}/elsewhere` }, body: '' };
      const err = await uploadData(mockAntUrl, BATCH, Buffer.from('x')).catch((e) => e);
      expect({ status, err: { status: err.status, message: err.message } }).toEqual({
        status,
        err: { status, message: expect.stringContaining('follows no redirect') },
      });
    }
    // Each upload went once, to /bzz, and nothing to the Location.
    expect(uploads.map((u) => u.url)).toEqual(Array(5).fill('/bzz?name=data'));
  });

  test('an error body is read as bee-js read it: JSON in its own form, else the text; bounded', async () => {
    answer = { status: 400, body: '{\n  "code": 400,\n  "message": "invalid content type"\n}' };
    expect(await uploadData(mockAntUrl, BATCH, Buffer.from('x')).catch((e) => e.message)).toBe(
      'Bad Request: {"code":400,"message":"invalid content type"}'
    );
    answer = { status: 500, body: 'node is busy' };
    expect(await uploadData(mockAntUrl, BATCH, Buffer.from('x')).catch((e) => e.message)).toBe('Internal Server Error: node is busy');
    answer = { status: 502, body: '' };
    expect(await uploadData(mockAntUrl, BATCH, Buffer.from('x')).catch((e) => e.message)).toBe('Bad Gateway');
    // Past 64 KiB the body is cut, and read as text.
    answer = { status: 500, body: JSON.stringify({ message: 'x'.repeat(100 * 1024) }) };
    const long = await uploadData(mockAntUrl, BATCH, Buffer.from('x')).catch((e) => e.message);
    expect(long.length).toBe('Internal Server Error: '.length + 64 * 1024);
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
    expect(mockSelectBestBatch).toHaveBeenCalledWith(5, { requireCapacity: true, requestOptions: { signal: expect.any(AbortSignal) } });
    expect(order).toEqual(['guard', 'send']);
    expect(await publishPageData('hello', { guard: async () => null })).toBeNull();
    expect(await publishFilesFromContent([{ path: 'a', bytes: Buffer.from('x') }], { guard: async () => null })).toBeNull();
    expect(uploads).toHaveLength(1);
  });
});
