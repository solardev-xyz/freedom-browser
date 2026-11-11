/**
 * @jest-environment node
 */
'use strict';

/**
 * `swarm_writeFeedEntry` at an explicit index (#1054), through the result
 * the page gets: the real provider, feed service and bee-js against a fake
 * Ant over loopback HTTP. Only a 404 for the entry frees the index. Any
 * other answer refuses the write before anything is uploaded, as a node
 * error the page may retry (-32603), whatever the answer's text says.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  webContents: { fromId: jest.fn() },
}));
jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  verbose: jest.fn(),
}));
jest.mock('./swarm-permissions', () => ({
  getPermission: (origin) => ({ origin, connectedAt: 1, lastUsed: 1, autoApprove: {} }),
  hasMessagingGrant: () => false,
  onRevoke: jest.fn(),
}));
jest.mock('./messaging-service', () => ({
  MAX_MESSAGE_BYTES: 4000,
  MAX_TARGET_DEPTH: 3,
  DEFAULT_TARGET_DEPTH: 2,
}));
jest.mock('./subscription-registry', () => ({ configure: jest.fn(), cancelByOrigin: jest.fn() }));
jest.mock('./publish-setup-service', () => ({ getPublishReadiness: async () => ({ ok: true }) }));
jest.mock('./publish-service', () => ({}));
jest.mock('./publish-history', () => ({
  addEntry: () => ({ id: 'history' }),
  updateEntry: jest.fn(),
}));
jest.mock('./feed-store', () => ({
  hasFeedGrant: () => true,
  getOriginEntry: () => ({ identityMode: 'app-scoped', publisherKeyIndex: 0 }),
  getFeed: (_origin, name) => ({ topic: 'stored', owner: 'stored', manifestReference: name }),
}));
jest.mock('../identity-manager', () => ({
  getPublisherKey: async () => ({ privateKey: `0x${'11'.repeat(32)}` }),
}));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));
// Batch choice is swarm-service's; here there is always one.
jest.mock('./swarm-service', () => ({
  ...jest.requireActual('./swarm-service'),
  selectBestBatch: async () => 'ef'.repeat(32),
}));

const { Bee, PrivateKey, Bytes, Identifier, FeedIndex, Topic } = require('@ethersphere/bee-js');
const { executeSwarmMethod } = require('./swarm-provider-ipc');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');

const ORIGIN = 'https://writer.example';
const FEED = 'notes';
const SIGNER = new PrivateKey('11'.repeat(32));
const INDEX = 3;

let ant;
// What the node answers for the entry's chunk.
let answerChunk;

function entryIdentifier(index) {
  const topic = Topic.fromString(`${ORIGIN}/${FEED}`);
  const feedIndex = FeedIndex.fromBigInt(BigInt(index));
  return new Identifier(
    Bytes.keccak256(
      Buffer.concat([Buffer.from(topic.toUint8Array()), Buffer.from(feedIndex.toUint8Array())])
    ).toUint8Array()
  );
}

const write = () =>
  executeSwarmMethod(
    'swarm_writeFeedEntry',
    { name: FEED, data: 'new entry', index: INDEX },
    ORIGIN
  );
const uploads = () => ant.requests.filter((entry) => entry.method !== 'GET');

beforeAll(async () => {
  ant = await startFakeHttpNode({
    handler(req, res) {
      if (req.method === 'GET' && req.url.startsWith('/chunks/')) {
        answerChunk(req, res);
        return;
      }
      // Nothing may be uploaded when the index is not known to be free.
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 500, message: 'unexpected upload' }));
    },
  });
  mockAntUrl = ant.origin;
});

afterAll(() => ant.close());

beforeEach(() => {
  ant.requests.length = 0;
});

describe('swarm_writeFeedEntry at an explicit index', () => {
  test('an oversized chunk that is not the entry is a retryable -32603, not payload_too_large', async () => {
    // 4,202 bytes: bee-js refuses it with "payload size 4097 exceeds…",
    // text about the node's chunk, not the page's payload.
    answerChunk = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'binary/octet-stream' });
      res.end(Buffer.alloc(4202, 0x42));
    };

    const result = await write();

    expect(result.error.code).toBe(-32603);
    expect(result.error.message).toBe('payload size 4097 exceeds maximum chunk payload size 4096');
    expect(result.error.data).toBeUndefined();
    expect(uploads()).toHaveLength(0);
  });

  test('a chunk of the right size that is not the entry is a retryable -32603', async () => {
    answerChunk = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'binary/octet-stream' });
      res.end(Buffer.alloc(4201, 0x42));
    };

    const result = await write();

    expect(result.error.code).toBe(-32603);
    expect(result.error.data).toBeUndefined();
    expect(uploads()).toHaveLength(0);
  });

  test("a 500 is a retryable -32603 with the node's message", async () => {
    answerChunk = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 500, message: 'read chunk failed' }));
    };

    const result = await write();

    expect(result.error.code).toBe(-32603);
    expect(result.error.message).toBe(
      'Internal Server Error: {"code":500,"message":"read chunk failed"}'
    );
    expect(uploads()).toHaveLength(0);
  });

  test('the entry itself is index_already_exists', async () => {
    const bee = new Bee(ant.origin);
    const soc = bee
      .makeContentAddressedChunk(Buffer.from('old entry'))
      .toSingleOwnerChunk(entryIdentifier(INDEX), SIGNER);
    answerChunk = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'binary/octet-stream' });
      res.end(Buffer.from(soc.data));
    };

    const result = await write();

    expect(result.error.code).toBe(-32602);
    expect(result.error.data).toEqual({ reason: 'index_already_exists' });
    expect(uploads()).toHaveLength(0);
    // The chunk the provider asked for is that entry's.
    expect(ant.requests[0].url).toBe(`/chunks/${soc.address.toHex()}`);
  });
});
