/**
 * @jest-environment node
 */
'use strict';

/**
 * `swarm_readFeedEntry` and the permission-free read budget (#1051): the real
 * provider, feed service and bee-js against a fake Ant over loopback HTTP,
 * so what is checked is what main actually asks the node for and how much of
 * each body it lets in. Only the stores around the provider are mocked.
 *
 * Any page can read any feed, and anyone can publish a feed entry that wraps
 * the root chunk of a large file. The entry's size must be paid for before
 * main downloads it, not after.
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
  // No connection: the anonymous budget, 120 requests / 512 KiB a window.
  getPermission: () => null,
  hasMessagingGrant: () => false,
  onRevoke: jest.fn(),
}));
jest.mock('./messaging-service', () => ({
  MAX_MESSAGE_BYTES: 4000,
  MAX_TARGET_DEPTH: 3,
  DEFAULT_TARGET_DEPTH: 2,
}));
jest.mock('./subscription-registry', () => ({ configure: jest.fn(), cancelByOrigin: jest.fn() }));
jest.mock('./publish-setup-service', () => ({ getPublishReadiness: jest.fn() }));
jest.mock('./publish-service', () => ({}));
jest.mock('./publish-history', () => ({ addEntry: jest.fn(), updateEntry: jest.fn() }));
jest.mock('./feed-store', () => ({ getFeed: () => null }));
jest.mock('../identity-manager', () => ({}));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));

const { Bee, PrivateKey, Bytes, Identifier, FeedIndex } = require('@ethersphere/bee-js');
const { executeSwarmMethod, clearPermissionFreeReadBudgets } = require('./swarm-provider-ipc');
const { startFakeHttpNode, streamBody, waitFor } = require('../../../test/helpers/fake-http-node');

const KIB = 1024;
const MIB = 1024 * KIB;
const BUDGET = 512 * KIB;
const ORIGIN = 'https://reader.example';
const SIGNER = new PrivateKey('11'.repeat(32));
const OWNER = SIGNER.publicKey().address().toHex();
const TOPIC = 'ab'.repeat(32);
const NOT_FOUND = JSON.stringify({ code: 404, message: 'Not Found' });

let ant;
// What the fake node holds: SOCs by address, and what /bytes and /feeds answer.
let socs;
let joins;
let latest;

function feedIdentifier(index) {
  const feedIndex = FeedIndex.fromBigInt(BigInt(index));
  return new Identifier(
    Bytes.keccak256(
      Buffer.concat([Buffer.from(TOPIC, 'hex'), Buffer.from(feedIndex.toUint8Array())])
    ).toUint8Array()
  );
}

/**
 * Put feed entry `index` on the fake node: an SOC, signed by SIGNER, that
 * wraps a chunk with this payload and span. `join` answers `GET /bytes` of
 * the wrapped chunk. Returns the SOC's size on the wire.
 */
function putEntry(index, { payload = Buffer.alloc(4096, 0x5a), span = payload.length, join } = {}) {
  const bee = new Bee(ant.origin);
  const cac = bee.makeContentAddressedChunk(payload, BigInt(span));
  const soc = cac.toSingleOwnerChunk(feedIdentifier(index), SIGNER);
  socs.set(soc.address.toHex(), Buffer.from(soc.data));
  if (join) joins.set(cac.address.toHex(), join);
  return soc.data.length;
}

/**
 * A /bytes or /feeds answer that streams `size` bytes: the first `before`
 * bytes at once, the rest once `gate` resolves.
 */
function streamed(size, { headers = {}, gate = null, contentLength = true, before = 0 } = {}) {
  return async (_req, res, entry) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      ...(contentLength && { 'Content-Length': size }),
      ...headers,
    });
    res.flushHeaders();
    if (before) await streamBody(entry, { total: before, chunkBytes: 16 * KIB, end: false });
    if (gate) await gate;
    await streamBody(entry, { total: size, chunkBytes: 16 * KIB });
  };
}

function latestHeaders(index) {
  return {
    'swarm-feed-index': FeedIndex.fromBigInt(BigInt(index)).toHex(),
    'swarm-feed-index-next': FeedIndex.fromBigInt(BigInt(index + 1)).toHex(),
  };
}

function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const read = (params = {}) =>
  executeSwarmMethod('swarm_readFeedEntry', { topic: TOPIC, owner: OWNER, ...params }, ORIGIN);
const requestsTo = (prefix) => ant.requests.filter((entry) => entry.url.startsWith(prefix));
const decoded = (result) => Buffer.from(result.result.data, 'base64');

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
      if (req.url === `/feeds/${OWNER}/${TOPIC}` && latest) {
        latest(req, res, entry);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(NOT_FOUND);
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
  clearPermissionFreeReadBudgets();
});

describe('swarm_readFeedEntry at an explicit index', () => {
  test('an entry that fits in its SOC is read from the SOC alone', async () => {
    putEntry(0, { payload: Buffer.from('hello feed') });

    const result = await read({ index: 0 });

    expect(decoded(result).toString()).toBe('hello feed');
    expect(result.result).toMatchObject({ encoding: 'base64', index: 0, nextIndex: 1 });
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });

  test('a larger entry is joined by the node and returned whole', async () => {
    putEntry(1, { span: 100 * KIB, join: streamed(100 * KIB) });

    const result = await read({ index: 1 });

    expect(decoded(result)).toEqual(Buffer.alloc(100 * KIB, 0x61));
    expect(requestsTo('/bytes/')).toHaveLength(1);
  });

  test('an entry wrapping a root larger than the budget is data_too_large before any /bytes request', async () => {
    putEntry(2, { span: 10 * MIB, join: streamed(10 * MIB) });

    const result = await read({ index: 2 });

    expect(result.error.code).toBe(-32602);
    expect(result.error.data).toEqual({
      reason: 'data_too_large',
      limit: BUDGET,
      actual: 10 * MIB,
    });
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });

  test('the SOC of a refused entry stays charged', async () => {
    const socBytes = putEntry(2, { span: 10 * MIB, join: streamed(10 * MIB) });
    expect((await read({ index: 2 })).error.data.reason).toBe('data_too_large');

    // What the SOC cost is gone from the window: an entry of exactly what is
    // left fits (its own SOC counts towards its size)…
    putEntry(3, { span: BUDGET - socBytes, join: streamed(BUDGET - socBytes) });
    expect(decoded(await read({ index: 3 }))).toHaveLength(BUDGET - socBytes);

    // …and one byte more is refused before it is joined.
    clearPermissionFreeReadBudgets();
    expect((await read({ index: 2 })).error.data.reason).toBe('data_too_large');
    putEntry(4, { span: BUDGET - socBytes + 1, join: streamed(BUDGET - socBytes + 1) });
    ant.requests.length = 0;
    const refused = await read({ index: 4 });
    expect(refused.error.data).toMatchObject({ reason: 'rate_limited', maxBytes: BUDGET });
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });

  test('the size is reserved before the join, so a read that would cross the budget never reaches the node', async () => {
    const hold = gate();
    putEntry(5, { span: 300 * KIB, join: streamed(300 * KIB, { gate: hold.promise }) });

    const first = read({ index: 5 });
    await waitFor(() => requestsTo('/bytes/').length === 1, { what: 'the first join' });
    // The first join has not sent a byte yet, but its size is already spent.
    const second = await read({ index: 5 });
    expect(second.error.data.reason).toBe('rate_limited');

    hold.open();
    expect(decoded(await first)).toHaveLength(300 * KIB);
    expect(requestsTo('/bytes/')).toHaveLength(1);
  });

  test('120 concurrent reads never ask the node for more than the budget', async () => {
    const hold = gate();
    const size = 100 * KIB;
    putEntry(6, { span: size, join: streamed(size, { gate: hold.promise }) });

    // The whole anonymous request budget at once.
    const pending = Array.from({ length: 120 }, () => read({ index: 6 }));
    await waitFor(() => requestsTo('/chunks/').length === 120, { what: '120 SOC reads' });
    hold.open();
    const results = await Promise.all(pending);

    const joined = requestsTo('/bytes/').length;
    expect(joined * size).toBeLessThanOrEqual(BUDGET);
    const ok = results.filter((r) => r.result);
    expect(ok).toHaveLength(joined);
    expect(ok.reduce((sum, r) => sum + decoded(r).length, 0)).toBeLessThanOrEqual(BUDGET);
    for (const r of results.filter((r) => r.error))
      expect(r.error.data.reason).toBe('rate_limited');
  });

  test('a missing entry is entry_not_found, without a join', async () => {
    const result = await read({ index: 9 });

    expect(result.error.data.reason).toBe('entry_not_found');
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });
});

describe('swarm_readFeedEntry for the latest entry', () => {
  // The node's lookup (GET /feeds) names the latest index, and the entry is
  // then read at that index, so the page gets the bytes the entry holds
  // whichever way it asks (#989).
  test('returns the entry the node names, read at its index', async () => {
    putEntry(4, { payload: Buffer.from('latest entry') });
    latest = (_req, res) => {
      res.writeHead(200, { 'Content-Length': 4, ...latestHeaders(4) });
      res.end('body');
    };

    const result = await read();

    expect(decoded(result).toString()).toBe('latest entry');
    expect(result.result).toMatchObject({ encoding: 'base64', index: 4, nextIndex: 5 });
    const [lookup] = requestsTo('/feeds/');
    expect(lookup.headers['swarm-only-root-chunk']).toBe('true');
  });

  test('a legacy entry is its own 40 bytes, as at its index, not the content it points to', async () => {
    const legacy = Buffer.concat([Buffer.alloc(8, 0x01), Buffer.alloc(32, 0xcd)]);
    putEntry(2, { payload: legacy });
    // What Ant and Bee answer for a legacy (ts||ref) entry: the content its
    // reference points to.
    latest = (_req, res) => {
      res.writeHead(200, { 'Content-Length': 12, ...latestHeaders(2) });
      res.end('site content');
    };

    const latestRead = await read();
    const indexedRead = await read({ index: 2 });

    expect(decoded(latestRead)).toEqual(legacy);
    expect(decoded(indexedRead)).toEqual(legacy);
    expect(latestRead.result).toMatchObject({ index: 2, nextIndex: 3 });
  });

  test("the lookup's body is never read", async () => {
    putEntry(0, { payload: Buffer.from('entry') });
    const hold = gate();
    latest = streamed(10 * MIB, { headers: latestHeaders(0), gate: hold.promise });

    const result = await read();
    hold.open();

    expect(decoded(result).toString()).toBe('entry');
    const [lookup] = requestsTo('/feeds/');
    await lookup.done;
    expect(lookup.aborted).toBe(true);
    expect(lookup.bytesSent).toBeLessThan(10 * MIB);
  });

  test('a latest entry wrapping a root larger than the budget is data_too_large before any /bytes request', async () => {
    putEntry(3, { span: 10 * MIB, join: streamed(10 * MIB) });
    latest = (_req, res) => {
      res.writeHead(200, { 'Content-Length': 4, ...latestHeaders(3) });
      res.end('body');
    };

    const result = await read();

    expect(result.error.data).toEqual({
      reason: 'data_too_large',
      limit: BUDGET,
      actual: 10 * MIB,
    });
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });

  test('a live feed whose latest legacy content expired is read from its update chunks', async () => {
    // Ant answers 404 for a feed whose latest legacy entry points at content
    // that is gone; the entries themselves are still there.
    for (const index of [0, 1, 2]) putEntry(index, { payload: Buffer.from(`entry ${index}`) });
    latest = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 404, message: 'wrapped chunk cannot be retrieved' }));
    };

    const result = await read();

    expect(decoded(result).toString()).toBe('entry 2');
    expect(result.result).toMatchObject({ index: 2, nextIndex: 3 });
  });

  test('a feed with a gap reads the entry the node would name', async () => {
    // Entries 0, 1 and 3: the node steps 1, 3, 7 from index 0 and names 3.
    for (const index of [0, 1, 3]) putEntry(index, { payload: Buffer.from(`entry ${index}`) });
    latest = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 404, message: 'wrapped chunk cannot be retrieved' }));
    };

    const result = await read();

    expect(decoded(result).toString()).toBe('entry 3');
    expect(result.result).toMatchObject({ index: 3, nextIndex: 4 });
  });

  test('an index past 2^53 is refused rather than rounded to another entry', async () => {
    latest = (_req, res) => {
      res.writeHead(200, {
        'Content-Length': 4,
        'swarm-feed-index': '003fffffffffffff',
        'swarm-feed-index-next': '0040000000000000',
      });
      res.end('body');
    };

    const result = await read();

    expect(result.error.code).toBe(-32603);
    expect(result.error.message).toBe(
      'Feed index 18014398509481983 is past the largest index a page can read'
    );
    expect(requestsTo('/chunks/')).toHaveLength(0);
  });

  test('the last index a page can read is read, with no next index past it', async () => {
    putEntry(Number.MAX_SAFE_INTEGER, { payload: Buffer.from('last') });
    latest = (_req, res) => {
      res.writeHead(200, {
        'Content-Length': 4,
        'swarm-feed-index': '001fffffffffffff',
        'swarm-feed-index-next': '0020000000000000',
      });
      res.end('body');
    };

    const latestRead = await read();
    const indexedRead = await read({ index: Number.MAX_SAFE_INTEGER });

    expect(decoded(latestRead).toString()).toBe('last');
    expect(latestRead.result).toMatchObject({ index: Number.MAX_SAFE_INTEGER, nextIndex: null });
    expect(indexedRead.result).toMatchObject({ index: Number.MAX_SAFE_INTEGER, nextIndex: null });
  });

  test('the update chunks read to find the head count against the read budget', async () => {
    // Spend all but about 2 KiB of the window on one entry.
    putEntry(9, { span: BUDGET - 2 * KIB, join: streamed(BUDGET - 2 * KIB) });
    expect((await read({ index: 9 })).result).toBeDefined();
    // The head, entry 2, would fit in what is left; the full chunks the
    // probe reads on the way there do not.
    putEntry(0, { payload: Buffer.alloc(4096, 0x5a) });
    putEntry(1, { payload: Buffer.alloc(4096, 0x5a) });
    putEntry(2, { payload: Buffer.from('head') });
    latest = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 404, message: 'wrapped chunk cannot be retrieved' }));
    };

    const result = await read();

    expect(result.error.data.reason).toBe('rate_limited');
  });

  test("a 404 with no update chunks is feed_empty, and a node error keeps bee-js's message", async () => {
    expect((await read()).error.data.reason).toBe('feed_empty');

    latest = (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'node busy' }));
    };
    const failed = await read();
    expect(failed.error.code).toBe(-32603);
    expect(failed.error.message).toBe('Service Unavailable: {"message":"node busy"}');
  });

  test('a response without the feed index headers is refused as bee-js refused it', async () => {
    latest = (_req, res) => {
      res.writeHead(200, { 'Content-Length': 2 });
      res.end('no');
    };

    const result = await read();

    expect(result.error.code).toBe(-32603);
    expect(result.error.message).toBe('Response did not contain expected swarm-feed-index!');
  });
});

describe('a lying or missing span', () => {
  test('a join longer than the wrapped span is cut off at the span', async () => {
    putEntry(7, { span: 5000, join: streamed(10 * MIB, { contentLength: false }) });

    const result = await read({ index: 7 });

    expect(result.error.code).toBe(-32603);
    expect(result.error.message).toBe(
      'Node returned more than 5000 bytes for a 5000-byte feed entry'
    );
    const [entry] = requestsTo('/bytes/');
    await entry.done;
    expect(entry.aborted).toBe(true);
    expect(entry.bytesSent).toBeLessThan(10 * MIB);
  });

  test('a join shorter than the wrapped span is refused', async () => {
    putEntry(8, { span: 5000, join: streamed(100) });

    const result = await read({ index: 8 });

    expect(result.error.message).toBe('Node returned 100 bytes for a 5000-byte feed entry');
  });

  test('an entry held in its SOC is cut to the wrapped span', async () => {
    // A signed SOC whose wrapped chunk says 1 byte but carries 4,096.
    putEntry(11, { payload: Buffer.alloc(4096, 0x5a), span: 1 });

    const result = await read({ index: 11 });

    expect(decoded(result)).toEqual(Buffer.from([0x5a]));
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });

  test('an entry held in its SOC with a span past its payload is refused', async () => {
    putEntry(12, { payload: Buffer.alloc(10, 0x5a), span: 100 });

    const result = await read({ index: 12 });

    expect(result.error.code).toBe(-32603);
    expect(result.error.message).toBe('Node returned 10 bytes for a 100-byte feed entry');
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });

  test('an SOC too short to carry a span is refused before any join', async () => {
    const bee = new Bee(ant.origin);
    socs.set(
      bee
        .calculateSingleOwnerChunkAddress(feedIdentifier(10), SIGNER.publicKey().address())
        .toHex(),
      Buffer.alloc(40)
    );

    const result = await read({ index: 10 });

    expect(result.error).toBeDefined();
    expect(result.result).toBeUndefined();
    expect(requestsTo('/bytes/')).toHaveLength(0);
  });
});
