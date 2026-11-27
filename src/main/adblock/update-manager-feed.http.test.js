/**
 * @jest-environment node
 */
'use strict';

/**
 * The adblock updater's own feed read (defaultReadFeed), through the real
 * feed service and bee-js against a fake Ant over loopback HTTP. The other
 * update-manager tests inject io.readFeed, so this is the one place the
 * default reader's call into readFeedPayload is exercised: it must hand over
 * a read meter (#1051 made one required) and get the manifest back.
 *
 * A latest read takes the index from the node's feed lookup (GET /feeds) and
 * reads the entry itself at that index (GET /chunks, then GET /bytes for an
 * entry larger than one chunk), as #989 made it. The fake node holds signed
 * entries, so the feed owner is pointed at a test key through the dev/E2E
 * override in feed-config.
 */

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  verbose: jest.fn(),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../settings-store', () => ({ loadSettings: jest.fn(() => ({})) }));
jest.mock('./service', () => ({
  refreshEngine: jest.fn(() => Promise.resolve()),
  getEnabledFeedCategories: jest.fn(() => []),
}));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));

const { Bee, Bytes, FeedIndex, Identifier, PrivateKey, Topic } = require('@ethersphere/bee-js');

// The publisher's key, for the fake node's entries. Set before feed-config
// is first required: it reads the override once.
const SIGNER = new PrivateKey('22'.repeat(32));
process.env.FREEDOM_ADBLOCK_FEED_OWNER = SIGNER.publicKey().address().toChecksum();

const { FEED_OWNER_ADDRESS, FEED_TOPIC } = require('./feed-config');
const { _defaultReadFeed, MANIFEST_MAX_BYTES } = require('./update-manager');
const { readFeedPayload } = require('../swarm/feed-service');
const { startFakeHttpNode, streamBody } = require('../../../test/helpers/fake-http-node');

const OWNER = SIGNER.publicKey().address().toHex();
const TOPIC = Topic.fromString(FEED_TOPIC);
const FEED_PATH = `/feeds/${OWNER}/${TOPIC.toHex()}`;
const indexHeaders = {
  'swarm-feed-index': FeedIndex.fromBigInt(3n).toHex(),
  'swarm-feed-index-next': FeedIndex.fromBigInt(4n).toHex(),
};

let ant;
// What the fake node holds: SOCs by address, what /bytes and /feeds answer.
let socs;
let joins;
let latest;

function feedIdentifier(index) {
  const feedIndex = FeedIndex.fromBigInt(BigInt(index));
  return new Identifier(
    Bytes.keccak256(
      Buffer.concat([Buffer.from(TOPIC.toUint8Array()), Buffer.from(feedIndex.toUint8Array())])
    ).toUint8Array()
  );
}

/**
 * Put feed entry `index` on the fake node: an SOC, signed by SIGNER, that
 * wraps a chunk with this payload and span. `join` answers `GET /bytes` of
 * the wrapped chunk.
 */
function putEntry(index, { payload, span = payload.length, join } = {}) {
  const bee = new Bee(ant.origin);
  const cac = bee.makeContentAddressedChunk(payload, BigInt(span));
  const soc = cac.toSingleOwnerChunk(feedIdentifier(index), SIGNER);
  socs.set(soc.address.toHex(), Buffer.from(soc.data));
  if (join) joins.set(cac.address.toHex(), join);
}

/**
 * The lookup's answer for index 3. Its body is what a node serves for the
 * entry, which a latest read must not take as the entry (#989).
 */
function lookupAt3(_req, res) {
  const body = 'not the entry';
  res.writeHead(200, { 'Content-Length': Buffer.byteLength(body), ...indexHeaders });
  res.end(body);
}

const urls = () =>
  ant.requests.map((r) => r.url.replace(/^\/(chunks|bytes)\/[0-9a-f]{64}$/, '/$1/<ref>'));

beforeAll(async () => {
  ant = await startFakeHttpNode({
    prelude(req, res) {
      if (req.url !== '/node') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ beeMode: 'light' }));
      return true;
    },
    handler(req, res, entry) {
      const chunk = req.url.match(/^\/chunks\/([0-9a-f]{64})$/);
      if (chunk && socs.has(chunk[1])) {
        res.writeHead(200, { 'Content-Type': 'binary/octet-stream' });
        res.end(socs.get(chunk[1]));
        return;
      }
      const join = req.url.match(/^\/bytes\/([0-9a-f]{64})$/);
      if (join && joins.has(join[1])) {
        joins.get(join[1])(req, res, entry);
        return;
      }
      if (req.url === FEED_PATH && latest) {
        latest(req, res, entry);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
    },
  });
  mockAntUrl = ant.origin;
});

afterAll(() => ant.close());

beforeEach(() => {
  socs = new Map();
  joins = new Map();
  latest = null;
  ant.requests.length = 0;
});

test('the feed owner is the test key', () => {
  expect(FEED_OWNER_ADDRESS.toLowerCase()).toBe(`0x${OWNER}`);
});

test('reads and parses the latest manifest from the feed', async () => {
  putEntry(3, { payload: Buffer.from(JSON.stringify({ schema: 1, version: 7 })) });
  latest = lookupAt3;

  await expect(_defaultReadFeed()).resolves.toEqual({ schema: 1, version: 7 });
  expect(urls()).toEqual([FEED_PATH, '/chunks/<ref>']);
  expect(ant.requests[0].headers['swarm-only-root-chunk']).toBe('true');
});

test('a manifest larger than one chunk is joined by the node', async () => {
  const manifest = JSON.stringify({ schema: 1, version: 8, pad: 'x'.repeat(20 * 1024) });
  const size = Buffer.byteLength(manifest);
  putEntry(3, {
    payload: Buffer.alloc(4096, 0x5a),
    span: size,
    join: (_req, res) => {
      res.writeHead(200, { 'Content-Length': size });
      res.end(manifest);
    },
  });
  latest = lookupAt3;

  await expect(_defaultReadFeed()).resolves.toMatchObject({ schema: 1, version: 8 });
  expect(urls()).toEqual([FEED_PATH, '/chunks/<ref>', '/bytes/<ref>']);
});

test('an entry past the manifest cap is refused on its span, before the node joins it', async () => {
  const size = MANIFEST_MAX_BYTES + 1;
  putEntry(3, {
    payload: Buffer.alloc(4096, 0x5a),
    span: size,
    join: async (_req, res, entry) => {
      res.writeHead(200, { 'Content-Length': size });
      await streamBody(entry, { total: size, chunkBytes: 64 * 1024 });
    },
  });
  latest = lookupAt3;

  await expect(_defaultReadFeed()).rejects.toMatchObject({
    reason: 'data_too_large',
    limit: MANIFEST_MAX_BYTES,
    actual: size,
  });
  expect(urls()).toEqual([FEED_PATH, '/chunks/<ref>']);
});

test('readFeedPayload without a meter is refused before the node is asked', async () => {
  await expect(readFeedPayload(FEED_OWNER_ADDRESS, TOPIC)).rejects.toThrow(/needs a read meter/);
  expect(ant.requests).toEqual([]);
});
