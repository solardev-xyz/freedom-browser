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

const { Topic, EthAddress, FeedIndex } = require('@ethersphere/bee-js');
const { FEED_OWNER_ADDRESS, FEED_TOPIC } = require('./feed-config');
const { _defaultReadFeed, MANIFEST_MAX_BYTES } = require('./update-manager');
const { readFeedPayload } = require('../swarm/feed-service');
const { startFakeHttpNode, streamBody } = require('../../../test/helpers/fake-http-node');

const FEED_PATH = `/feeds/${new EthAddress(FEED_OWNER_ADDRESS).toHex()}/${Topic.fromString(FEED_TOPIC).toHex()}`;
const indexHeaders = {
  'swarm-feed-index': FeedIndex.fromBigInt(3n).toHex(),
  'swarm-feed-index-next': FeedIndex.fromBigInt(4n).toHex(),
};

let ant;
let latest;

beforeAll(async () => {
  ant = await startFakeHttpNode({
    prelude(req, res) {
      if (req.url !== '/node') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ beeMode: 'light' }));
      return true;
    },
    handler(req, res, entry) {
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
  latest = null;
  ant.requests.length = 0;
});

test('reads and parses the latest manifest from the feed', async () => {
  const manifest = JSON.stringify({ schema: 1, version: 7 });
  latest = (_req, res) => {
    res.writeHead(200, { 'Content-Length': Buffer.byteLength(manifest), ...indexHeaders });
    res.end(manifest);
  };

  await expect(_defaultReadFeed()).resolves.toEqual({ schema: 1, version: 7 });
  expect(ant.requests.map((r) => r.url)).toEqual([FEED_PATH]);
});

test('an entry past the manifest cap is refused on its declared length, unread', async () => {
  const size = MANIFEST_MAX_BYTES + 1;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  latest = async (_req, res, entry) => {
    res.writeHead(200, { 'Content-Length': size, ...indexHeaders });
    res.flushHeaders();
    await hold;
    await streamBody(entry, { total: size, chunkBytes: 64 * 1024 });
  };

  await expect(_defaultReadFeed()).rejects.toMatchObject({
    reason: 'data_too_large',
    limit: MANIFEST_MAX_BYTES,
    actual: size,
  });
  release();
  const [entry] = ant.requests;
  await entry.done;
  expect(entry.aborted).toBe(true);
});

test('readFeedPayload without a meter is refused before the node is asked', async () => {
  await expect(readFeedPayload(FEED_OWNER_ADDRESS, Topic.fromString(FEED_TOPIC))).rejects.toThrow(
    /needs a read meter/
  );
  expect(ant.requests).toEqual([]);
});
