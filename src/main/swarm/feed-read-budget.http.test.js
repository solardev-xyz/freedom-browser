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

/** Start `count` reads; `settled()` says how many have answered so far. */
function concurrentReads(count, params) {
  let settled = 0;
  const pending = Array.from({ length: count }, () =>
    read(params).finally(() => {
      settled += 1;
    })
  );
  return { pending, settled: () => settled };
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
  test('returns the body with the index the node reports', async () => {
    latest = (_req, res) => {
      res.writeHead(200, { 'Content-Length': 6, ...latestHeaders(4) });
      res.end('latest');
    };

    const result = await read();

    expect(decoded(result).toString()).toBe('latest');
    expect(result.result).toMatchObject({ index: 4, nextIndex: 5 });
  });

  // The node holds these bodies back until the read has answered: a refusal
  // that comes back first was decided on the headers alone.
  test('a declared length past the budget is data_too_large, and the body is not read', async () => {
    const hold = gate();
    latest = streamed(10 * MIB, { headers: latestHeaders(0), gate: hold.promise });

    const result = await read();
    hold.open();

    expect(result.error.data).toEqual({
      reason: 'data_too_large',
      limit: BUDGET,
      actual: 10 * MIB,
    });
    const [entry] = requestsTo('/feeds/');
    await entry.done;
    expect(entry.aborted).toBe(true);
  });

  test('a declared length that does not fit what is left is rate_limited before the body is read', async () => {
    latest = streamed(300 * KIB, { headers: latestHeaders(0) });
    expect(decoded(await read())).toHaveLength(300 * KIB);

    const hold = gate();
    latest = streamed(300 * KIB, { headers: latestHeaders(0), gate: hold.promise });
    const refused = await read();
    hold.open();

    expect(refused.error.data.reason).toBe('rate_limited');
  });

  test('a body with no declared length is cut off once it passes the budget', async () => {
    latest = streamed(10 * MIB, { headers: latestHeaders(0), contentLength: false });

    const result = await read();

    // The size is unknown, so only the limit is reported.
    expect(result.error.data).toEqual({ reason: 'data_too_large', limit: BUDGET });
    const [entry] = requestsTo('/feeds/');
    await entry.done;
    // The node never got to send the rest.
    expect(entry.aborted).toBe(true);
    expect(entry.bytesSent).toBeLessThan(10 * MIB);
  });

  test('a body with no declared length is reserved as it streams', async () => {
    latest = streamed(300 * KIB, { headers: latestHeaders(0), contentLength: false });
    expect(decoded(await read())).toHaveLength(300 * KIB);

    // 212 KiB are left; the next body is refused once it passes them.
    latest = streamed(10 * MIB, { headers: latestHeaders(0), contentLength: false });
    const refused = await read();

    expect(refused.error.data.reason).toBe('rate_limited');
    const second = requestsTo('/feeds/')[1];
    await second.done;
    expect(second.aborted).toBe(true);
    expect(second.bytesSent).toBeLessThan(10 * MIB);
  });

  test('120 concurrent reads hold no more than the budget', async () => {
    const hold = gate();
    const size = 100 * KIB;
    latest = streamed(size, { headers: latestHeaders(0), gate: hold.promise });

    const reads = concurrentReads(120);
    // Each body is reserved from its declared length before it is read:
    // five fit in 512 KiB, and the other 115 are refused on their headers,
    // while the node still holds every body back.
    await waitFor(() => reads.settled() === 115, { what: '115 refusals on the headers' });
    hold.open();
    const results = await Promise.all(reads.pending);

    const ok = results.filter((r) => r.result);
    expect(ok).toHaveLength(Math.floor(BUDGET / size));
    for (const r of results.filter((r) => r.error))
      expect(r.error.data.reason).toBe('rate_limited');
  });

  test('120 concurrent reads with no declared length hold no more than the budget', async () => {
    const hold = gate();
    const size = 100 * KIB;
    // Half of each body comes at once, the rest when the gate opens.
    latest = streamed(size, {
      headers: latestHeaders(0),
      contentLength: false,
      gate: hold.promise,
      before: 50 * KIB,
    });

    const reads = concurrentReads(120);
    // Each piece is reserved as it arrives, so the first halves alone use up
    // the budget: no more than ten reads (512 / 50 KiB) are still going when
    // the rest of the bodies are sent.
    await waitFor(() => reads.settled() >= 110, { what: 'reads refused mid-body' });
    hold.open();
    const results = await Promise.all(reads.pending);

    const ok = results.filter((r) => r.result);
    expect(ok.reduce((sum, r) => sum + decoded(r).length, 0)).toBeLessThanOrEqual(BUDGET);
    for (const r of results.filter((r) => r.error))
      expect(r.error.data.reason).toBe('rate_limited');
  });

  test("a 404 is feed_empty, and a node error keeps bee-js's message", async () => {
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

  describe('a latest body that does not match its declared length', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    // Node's fetch itself holds a body to its Content-Length; the provider
    // does not rely on that.
    function answerLatestWith(declared, sent) {
      global.fetch = jest.fn(async (url, init) => {
        if (!String(url).includes('/feeds/')) return realFetch(url, init);
        let left = sent;
        const body = new ReadableStream({
          pull(controller) {
            if (left === 0) return controller.close();
            const n = Math.min(left, 16 * KIB);
            left -= n;
            controller.enqueue(new Uint8Array(n));
          },
        });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-length': String(declared), ...latestHeaders(0) }),
          body,
        };
      });
    }

    test('a body longer than declared is cut off at the declared length', async () => {
      answerLatestWith(10, 10 * MIB);

      const result = await read();

      expect(result.error.message).toBe(
        'Node sent more than the 10 bytes it declared for the feed entry'
      );
    });

    test('a body shorter than declared is refused', async () => {
      answerLatestWith(1000, 10);

      const result = await read();

      expect(result.error.message).toBe(
        'Node sent 10 of the 1000 bytes it declared for the feed entry'
      );
    });
  });
});
