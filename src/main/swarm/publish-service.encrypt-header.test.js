/**
 * @jest-environment node
 */
'use strict';

// The real bee-js client against a local fake Ant API (no network, no
// postage spent): a private draft link must reach the node as
// `swarm-encrypt: true`, and a public publication must not carry it.
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
jest.mock('../profile-paths', () => ({ createProfileTempDir: jest.fn() }));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));

const ENCRYPTED = 'ab'.repeat(64);
const PLAIN = 'cd'.repeat(32);
const BATCH = 'ef'.repeat(32);

describe('Swarm-Encrypt on the wire', () => {
  let server;
  const requests = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, headers: request.headers, bytes: Buffer.concat(chunks).length });
        const encrypted = request.headers['swarm-encrypt'] === 'true';
        response.writeHead(201, { 'content-type': 'application/json', 'swarm-tag': '7' });
        response.end(JSON.stringify({ reference: encrypted ? ENCRYPTED : PLAIN }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    mockAntUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => { requests.length = 0; });

  test('a draft collection and draft text are uploaded with swarm-encrypt: true', async () => {
    const { publishCollection, publishData } = require('./publish-service');
    const files = [{ path: 'index.html', bytes: Buffer.from('<p>draft</p>') }];
    const collection = await publishCollection(files, { batchId: BATCH, encrypt: true });
    const text = await publishData('draft text', { batchId: BATCH, encrypt: true });
    expect(requests.map(request => [request.method, request.url.split('?')[0], request.headers['swarm-encrypt'], request.headers['swarm-postage-batch-id']]))
      .toEqual([['POST', '/bzz', 'true', BATCH], ['POST', '/bzz', 'true', BATCH]]);
    expect(collection).toMatchObject({ reference: ENCRYPTED, bzzUrl: `bzz://${ENCRYPTED}` });
    expect(text).toMatchObject({ reference: ENCRYPTED });
  });

  test('a public publication carries no swarm-encrypt header', async () => {
    const { publishCollection } = require('./publish-service');
    const result = await publishCollection([{ path: 'index.html', bytes: Buffer.from('<p>public</p>') }], { batchId: BATCH });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers).not.toHaveProperty('swarm-encrypt');
    expect(result.reference).toBe(PLAIN);
  });
});
