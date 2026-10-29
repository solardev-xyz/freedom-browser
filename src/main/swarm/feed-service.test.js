const mockCreateFeedManifest = jest.fn();
const mockMakeFeedWriter = jest.fn();
const mockMakeFeedReader = jest.fn();
const mockGetPostageBatches = jest.fn();
const mockCalculateSingleOwnerChunkAddress = jest.fn();
const mockDownloadChunk = jest.fn();
const mockUnmarshalSingleOwnerChunk = jest.fn();
const mockMakeContentAddressedChunk = jest.fn();
const mockDownloadData = jest.fn();

// Minimal stand-ins for bee-js typed bytes used in assertions
class MockReference {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
  toUint8Array() { return Buffer.from(this._hex.replace(/^0x/, ''), 'hex'); }
}

let topicCounter = 0;
class MockTopic {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
  static fromString(_s) { return new MockTopic((topicCounter++).toString(16).padStart(64, '0')); }
}

class MockEthAddress {
  constructor(hex) { this._hex = typeof hex === 'string' ? hex.replace(/^0x/, '') : hex; }
  toHex() { return this._hex; }
  toChecksum() { return `0x${this._hex}`; }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

class MockPublicKey {
  constructor(addr) { this._addr = addr; }
  address() { return this._addr; }
}

class MockPrivateKey {
  constructor(hex) {
    this._hex = hex;
    // Derive a deterministic fake address from the key
    this._addr = new MockEthAddress(hex.replace('0x', '').slice(0, 40));
  }
  publicKey() { return new MockPublicKey(this._addr); }
}

class MockFeedIndex {
  constructor(value) { this._value = BigInt(value); }
  static fromBigInt(value) { return new MockFeedIndex(value); }
  toBigInt() { return this._value; }
  next() { return new MockFeedIndex(this._value + 1n); }
  toUint8Array() {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(this._value);
    return bytes;
  }
}

class MockSpan {
  constructor(value) { this._value = BigInt(value); }
  toBigInt() { return this._value; }
}

// Stand-in for bee-js Bytes — an object wrapping a Uint8Array.
// Importantly, it's NOT array-like: numeric indices return undefined.
// Buffer.from(MockBytes) would produce a Buffer of zeros — exposing a bug
// where the service forgets to call .toUint8Array() first.
class MockBytes {
  constructor(data) {
    this._bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(typeof data === 'string' ? Buffer.from(data) : data);
    this.length = this._bytes.length;
  }
  toUint8Array() { return this._bytes; }
  toHex() { return Buffer.from(this._bytes).toString('hex'); }
  // Not a hash: keeps the topic||index input so tests can tell which feed
  // index an update-chunk address was derived for (see mockFeedChunksUpTo).
  static keccak256(bytes) { return new MockBytes(Uint8Array.from(bytes)); }
}

class MockIdentifier extends MockBytes {}

// Stand-in for bee-js BeeResponseError — used for error discrimination
class MockBeeResponseError extends Error {
  constructor(status, message = 'Bee response error') {
    super(message);
    this.status = status;
  }
}

function make404() {
  return new MockBeeResponseError(404, 'Not Found');
}

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation(() => ({
    feed: {
      createManifest: mockCreateFeedManifest,
      makeWriter: mockMakeFeedWriter,
      makeReader: mockMakeFeedReader,
    },
    stamp: {
      getAll: mockGetPostageBatches,
    },
    calculateSingleOwnerChunkAddress: mockCalculateSingleOwnerChunkAddress,
    chunk: {
      download: mockDownloadChunk,
    },
    unmarshalSingleOwnerChunk: mockUnmarshalSingleOwnerChunk,
    makeContentAddressedChunk: mockMakeContentAddressedChunk,
    data: {
      download: mockDownloadData,
    },
  })),
  PrivateKey: MockPrivateKey,
  Topic: MockTopic,
  EthAddress: MockEthAddress,
  Bytes: MockBytes,
  Identifier: MockIdentifier,
  FeedIndex: MockFeedIndex,
  BeeResponseError: MockBeeResponseError,
}));

jest.mock('../service-registry', () => ({
  getAntApiUrl: jest.fn().mockReturnValue('http://127.0.0.1:1633'),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const { buildTopicString, createFeed, updateFeed, writeFeedPayload, readFeedPayload, readFeedState, withWriteLock, feedIndexToNumber, isNotFoundError } = require('./feed-service');

const TEST_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
const MOCK_MANIFEST_REF = 'ff'.repeat(32);
const MOCK_BATCH_ID = 'aa'.repeat(32);
const MOCK_OWNER = '0x' + 'ab'.repeat(20);

function mockBatchForAutoSelect() {
  mockGetPostageBatches.mockResolvedValue([{
    usable: true,
    remainingSize: { toBytes: () => 1_000_000 },
    duration: { toSeconds: () => 86400 },
    batchID: { toHex: () => MOCK_BATCH_ID },
  }]);
}

function createMockWriter({ downloadPayloadResult, uploadPayloadFn, uploadReferenceFn, downloadPayloadFn } = {}) {
  const writer = {
    upload: jest.fn().mockResolvedValue(undefined),
    uploadPayload: uploadPayloadFn || jest.fn().mockResolvedValue(undefined),
    uploadReference: uploadReferenceFn || jest.fn().mockResolvedValue(undefined),
    downloadPayload: downloadPayloadFn || jest.fn(),
  };
  if (downloadPayloadResult !== undefined) {
    writer.downloadPayload.mockResolvedValue(downloadPayloadResult);
  } else {
    // Default: empty feed (BeeResponseError 404)
    writer.downloadPayload.mockRejectedValue(make404());
  }
  return writer;
}

function createMockReader({ downloadPayloadResult, downloadPayloadFn } = {}) {
  const reader = {
    downloadPayload: downloadPayloadFn || jest.fn(),
  };
  if (downloadPayloadResult !== undefined) {
    reader.downloadPayload.mockResolvedValue(downloadPayloadResult);
  } else {
    reader.downloadPayload.mockRejectedValue(make404());
  }
  return reader;
}

// Model a feed whose update chunks exist at indexes 0..lastIndex (GET /chunks),
// independent of what the latest-update lookup (GET /feeds) answers.
// Returns the list of indexes probed.
function mockFeedChunksUpTo(lastIndex) {
  const probed = [];
  mockCalculateSingleOwnerChunkAddress.mockImplementation((identifier) => ({
    index: Number(Buffer.from(identifier.toUint8Array()).readBigUInt64BE(identifier.length - 8)),
  }));
  mockDownloadChunk.mockImplementation(async (ref) => {
    probed.push(ref.index);
    if (ref.index <= lastIndex) return new MockBytes('soc');
    throw make404();
  });
  return probed;
}

function make404WrappedChunk() {
  return new MockBeeResponseError(404, 'wrapped chunk cannot be retrieved');
}

function mockExactFeedPayload(data = 'exact data', span = 1n) {
  const reference = new MockReference('ee'.repeat(32));
  const payload = new MockBytes(data);
  const soc = { payload, span: new MockSpan(span) };
  mockCalculateSingleOwnerChunkAddress.mockReturnValue(reference);
  mockDownloadChunk.mockResolvedValue(new MockBytes('raw soc'));
  mockUnmarshalSingleOwnerChunk.mockReturnValue(soc);
  mockMakeContentAddressedChunk.mockReturnValue({
    payload,
    span: soc.span,
    address: new MockReference('dd'.repeat(32)),
  });
  return { reference, payload, soc };
}

beforeEach(() => {
  jest.clearAllMocks();
  topicCounter = 0;
  mockCalculateSingleOwnerChunkAddress.mockReturnValue(new MockReference('ee'.repeat(32)));
  mockDownloadChunk.mockRejectedValue(make404());
});

describe('feed-service', () => {
  describe('buildTopicString', () => {
    test('concatenates origin and feed name with /', () => {
      expect(buildTopicString('https://example.com', 'blog')).toBe('https://example.com/blog');
    });

    test('works with ENS origins', () => {
      expect(buildTopicString('myapp.eth', 'profile')).toBe('myapp.eth/profile');
    });

    test('works with bzz:// origins', () => {
      expect(buildTopicString('bzz://abc123', 'feed')).toBe('bzz://abc123/feed');
    });
  });

  describe('isNotFoundError', () => {
    test('returns true for BeeResponseError with status 404', () => {
      expect(isNotFoundError(new MockBeeResponseError(404))).toBe(true);
    });

    test('returns true for BeeResponseError with status 500', () => {
      expect(isNotFoundError(new MockBeeResponseError(500))).toBe(true);
    });

    test('returns false for BeeResponseError with other status', () => {
      expect(isNotFoundError(new MockBeeResponseError(503))).toBe(false);
    });

    test('returns false for plain Error', () => {
      expect(isNotFoundError(new Error('network timeout'))).toBe(false);
    });

    test('returns false for TypeError', () => {
      expect(isNotFoundError(new TypeError('cannot read'))).toBe(false);
    });
  });

  describe('feedIndexToNumber', () => {
    test('converts FeedIndex to number', () => {
      expect(feedIndexToNumber(new MockFeedIndex(0))).toBe(0);
      expect(feedIndexToNumber(new MockFeedIndex(42))).toBe(42);
      expect(feedIndexToNumber(new MockFeedIndex(1000))).toBe(1000);
    });
  });

  describe('createFeed', () => {
    test('calls feed.createManifest with correct args', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog');

      expect(mockCreateFeedManifest).toHaveBeenCalledTimes(1);
      const [batchId, topic, owner] = mockCreateFeedManifest.mock.calls[0];
      expect(typeof batchId).toBe('string');
      expect(topic).toBeInstanceOf(MockTopic);
      expect(owner.toHex()).toBeTruthy();
    });

    test('returns normalized result', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      const result = await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog');

      expect(result.topic).toMatch(/^[0-9a-f]+$/);
      expect(result.owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(result.manifestReference).toBe(MOCK_MANIFEST_REF);
      expect(result.bzzUrl).toBe(`bzz://${MOCK_MANIFEST_REF}`);
    });

    test('uses explicit batchId when provided', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));

      await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'explicit_batch');

      const [batchId] = mockCreateFeedManifest.mock.calls[0];
      expect(batchId).toBe('explicit_batch');
      expect(mockGetPostageBatches).not.toHaveBeenCalled();
    });

    test('auto-selects batch when none provided', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog');

      expect(mockGetPostageBatches).toHaveBeenCalled();
    });

    test('throws when no usable batch available', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      await expect(createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog'))
        .rejects.toThrow('No usable postage batch');
    });

    test('same key produces same owner', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      const result1 = await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog');
      const result2 = await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/profile');

      expect(result1.owner).toBe(result2.owner);
    });

    test('propagates bee-js errors', async () => {
      mockCreateFeedManifest.mockRejectedValue(new Error('manifest creation failed'));
      mockBatchForAutoSelect();

      await expect(createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog'))
        .rejects.toThrow('manifest creation failed');
    });

    test('different topics produce different topic hashes', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      const result1 = await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog');
      const result2 = await createFeed(TEST_PRIVATE_KEY, 'myapp.eth/profile');

      expect(result1.topic).not.toBe(result2.topic);
    });
  });

  describe('updateFeed', () => {
    const CONTENT_REF = 'cc'.repeat(32);

    test('calls uploadReference (not deprecated upload)', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);

      expect(writer.uploadReference).toHaveBeenCalledTimes(1);
      expect(writer.upload).not.toHaveBeenCalled();
    });

    test('passes batchId and reference to uploadReference', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);

      const [batchId, ref, options] = writer.uploadReference.mock.calls[0];
      expect(typeof batchId).toBe('string');
      expect(ref).toBe(CONTENT_REF);
      expect(options).toHaveProperty('index', 0);
    });

    test('returns index', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const result = await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);

      expect(typeof result.index).toBe('number');
    });

    test('resolves next index from non-empty feed', async () => {
      const writer = createMockWriter({
        downloadPayloadResult: {
          payload: Buffer.from('data'),
          feedIndex: new MockFeedIndex(5),
          feedIndexNext: new MockFeedIndex(6),
        },
      });
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const result = await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);

      expect(result.index).toBe(6);
      const [, , options] = writer.uploadReference.mock.calls[0];
      expect(options.index).toBe(6);
    });

    test('defaults to index 0 on empty feed', async () => {
      const writer = createMockWriter(); // default: downloadPayload rejects
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const result = await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);

      expect(result.index).toBe(0);
    });

    test('uses explicit batchId when provided', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);

      await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF, 'explicit_batch');

      const [batchId] = writer.uploadReference.mock.calls[0];
      expect(batchId).toBe('explicit_batch');
      expect(mockGetPostageBatches).not.toHaveBeenCalled();
    });

    test('throws when no usable batch available', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF))
        .rejects.toThrow('No usable postage batch');
    });

    test('propagates bee-js errors', async () => {
      const writer = createMockWriter();
      writer.uploadReference.mockRejectedValue(new Error('network error'));
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF))
        .rejects.toThrow('network error');
    });

    test('continues a live feed after its head when the latest lookup 404s on expired content', async () => {
      const writer = createMockWriter();
      writer.downloadPayload.mockRejectedValue(make404WrappedChunk());
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();
      for (const head of [0, 1, 6, 7, 8, 1000]) {
        mockFeedChunksUpTo(head);
        writer.uploadReference.mockClear();
        await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF)).resolves.toEqual({ index: head + 1 });
        expect(writer.uploadReference.mock.calls[0][2]).toEqual({ index: head + 1 });
      }
    });

    test('minIndex keeps a write above an index the caller knows, even when the probe reads the feed as empty', async () => {
      // Index 0 expired with its batch while later updates survive: the
      // probe can't see past it, so only the caller's known index helps.
      const writer = createMockWriter();
      writer.downloadPayload.mockRejectedValue(make404());
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();
      mockFeedChunksUpTo(-1);
      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF, undefined, { minIndex: 6 })).resolves.toEqual({ index: 6 });
      expect(writer.uploadReference.mock.calls[0][2]).toEqual({ index: 6 });
      // A network head past minIndex still wins.
      writer.uploadReference.mockClear();
      mockFeedChunksUpTo(9);
      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF, undefined, { minIndex: 6 })).resolves.toEqual({ index: 10 });
      // An absent or invalid minIndex changes nothing.
      writer.uploadReference.mockClear();
      mockFeedChunksUpTo(-1);
      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF, undefined, { minIndex: -3 })).resolves.toEqual({ index: 0 });
    });

    test('a 500 from an update-chunk probe fails the write instead of reading the chunk as missing', async () => {
      const writer = createMockWriter();
      writer.downloadPayload.mockRejectedValue(make404WrappedChunk());
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();
      mockDownloadChunk.mockRejectedValue(new MockBeeResponseError(500, 'read chunk failed'));
      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF)).rejects.toBeInstanceOf(MockBeeResponseError);
      expect(writer.uploadReference).not.toHaveBeenCalled();
    });

    test('propagates non-404 errors from resolveNextIndex (does not default to 0)', async () => {
      const writer = createMockWriter();
      writer.downloadPayload.mockRejectedValue(new Error('network timeout'));
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF))
        .rejects.toThrow('network timeout');
    });
  });

  describe('writeFeedPayload', () => {
    test('calls uploadPayload with data', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'hello world');

      expect(writer.uploadPayload).toHaveBeenCalledTimes(1);
      const [batchId, data, options] = writer.uploadPayload.mock.calls[0];
      expect(typeof batchId).toBe('string');
      expect(data).toBe('hello world');
      expect(options).toHaveProperty('index', 0);
    });

    test('auto-increments on empty feed (index 0)', async () => {
      const writer = createMockWriter(); // downloadPayload rejects → empty feed
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const result = await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data');

      expect(result.index).toBe(0);
    });

    test('auto-increments on non-empty feed', async () => {
      const writer = createMockWriter({
        downloadPayloadResult: {
          payload: Buffer.from('prev'),
          feedIndex: new MockFeedIndex(3),
          feedIndexNext: new MockFeedIndex(4),
        },
      });
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const result = await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data');

      expect(result.index).toBe(4);
      const [, , options] = writer.uploadPayload.mock.calls[0];
      expect(options.index).toBe(4);
    });

    test('uses explicit index when provided', async () => {
      const writer = createMockWriter();
      mockDownloadChunk.mockRejectedValue(make404());
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const result = await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data', { index: 10 });

      expect(result.index).toBe(10);
      const [, , options] = writer.uploadPayload.mock.calls[0];
      expect(options.index).toBe(10);
      expect(writer.downloadPayload).not.toHaveBeenCalled();
      expect(mockCalculateSingleOwnerChunkAddress).toHaveBeenCalled();
    });

    test('rejects explicit index that already has an entry (overwrite protection)', async () => {
      const writer = createMockWriter();
      mockExactFeedPayload('existing');
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await expect(writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data', { index: 5 }))
        .rejects.toThrow('Feed entry already exists at index 5');

      // uploadPayload should NOT have been called
      expect(writer.uploadPayload).not.toHaveBeenCalled();
      expect(writer.downloadPayload).not.toHaveBeenCalled();
    });

    test('overwrite protection error has reason property', async () => {
      const writer = createMockWriter();
      mockExactFeedPayload('existing');
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      try {
        await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data', { index: 0 });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.reason).toBe('index_already_exists');
      }
    });

    test('auto-selects batch', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data');

      expect(mockGetPostageBatches).toHaveBeenCalled();
    });

    test('uses explicit batchId when provided', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);

      await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data', { batchId: 'my_batch' });

      const [batchId] = writer.uploadPayload.mock.calls[0];
      expect(batchId).toBe('my_batch');
    });

    test('throws when no usable batch available', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      await expect(writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data'))
        .rejects.toThrow('No usable postage batch');
    });

    test('propagates bee-js upload errors', async () => {
      const writer = createMockWriter();
      writer.uploadPayload.mockRejectedValue(new Error('chunk too large'));
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await expect(writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'x'.repeat(10000)))
        .rejects.toThrow('chunk too large');
    });

    test('propagates non-404 errors during overwrite check (does not treat as free index)', async () => {
      const writer = createMockWriter();
      mockDownloadChunk.mockRejectedValue(new Error('network timeout'));
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await expect(writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data', { index: 5 }))
        .rejects.toThrow('network timeout');

      expect(writer.uploadPayload).not.toHaveBeenCalled();
    });

    test('propagates non-404 errors during auto-increment (does not default to 0)', async () => {
      const writer = createMockWriter();
      writer.downloadPayload.mockRejectedValue(new Error('Bee internal error'));
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      await expect(writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', 'data'))
        .rejects.toThrow('Bee internal error');
    });

    test('estimates batch size from actual payload size', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const largePayload = 'x'.repeat(50000);
      await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', largePayload);

      // selectBestBatch should have been called with at least the payload size
      expect(mockGetPostageBatches).toHaveBeenCalled();
    });

    test('accepts Buffer data', async () => {
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const buf = Buffer.from('binary data');
      await writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/blog', buf);

      const [, data] = writer.uploadPayload.mock.calls[0];
      expect(data).toBe(buf);
    });
  });

  describe('readFeedState', () => {
    test('reports the latest index of a feed that has an update', async () => {
      const reader = createMockReader({ downloadPayloadResult: { payload: new MockBytes('x'), feedIndex: new MockFeedIndex(4) } });
      mockMakeFeedReader.mockReturnValue(reader);
      await expect(readFeedState(MOCK_OWNER, 'freedom-agent/stable-address/site')).resolves.toEqual({ exists: true, index: 4 });
      expect(mockMakeFeedReader.mock.calls[0][0]).toBeInstanceOf(MockTopic);
    });

    test('a 404 for a live feed whose latest content expired still reads as existing', async () => {
      // Ant answers GET /feeds with 404 "wrapped chunk cannot be retrieved"
      // when the latest legacy update points at a chunk that is gone.
      mockMakeFeedReader.mockReturnValue({ downloadPayload: jest.fn().mockRejectedValue(make404WrappedChunk()) });
      const probed = mockFeedChunksUpTo(5);
      await expect(readFeedState(MOCK_OWNER, 'topic')).resolves.toEqual({ exists: true, index: 5 });
      expect(probed[0]).toBe(0);
    });

    test('a 404 with no update chunk at index 0 is an empty feed', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      const probed = mockFeedChunksUpTo(-1);
      await expect(readFeedState(MOCK_OWNER, 'topic')).resolves.toEqual({ exists: false });
      expect(probed).toEqual([0]);
    });

    test('an unreachable chunk probe reads as unknown, not empty', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockDownloadChunk.mockRejectedValue(new Error('connect ECONNREFUSED'));
      await expect(readFeedState(MOCK_OWNER, 'topic')).rejects.toThrow('ECONNREFUSED');
    });

    test('a 500 from an update-chunk probe reads as unknown, not as a missing chunk', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockFeedChunksUpTo(5);
      const chunkPresent = mockDownloadChunk.getMockImplementation();
      // After the /feeds 404, index 0 answers 500.
      mockDownloadChunk.mockImplementation(async ref => {
        if (ref.index === 0) throw new MockBeeResponseError(500, 'read chunk failed');
        return chunkPresent(ref);
      });
      await expect(readFeedState(MOCK_OWNER, 'topic')).rejects.toBeInstanceOf(MockBeeResponseError);
      // Mid-bracket too: a 500 at index 4 must not end the probe at 3.
      mockDownloadChunk.mockImplementation(async ref => {
        if (ref.index === 4) throw new MockBeeResponseError(500, 'read chunk failed');
        return chunkPresent(ref);
      });
      await expect(readFeedState(MOCK_OWNER, 'topic')).rejects.toBeInstanceOf(MockBeeResponseError);
    });

    test('the probe assumes contiguous updates: a gap or a missing index 0 reads the head low', async () => {
      // Documented limit (see probeFeedHead): the writer's minIndex and the
      // controller's read-back cover it.
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockFeedChunksUpTo(9);
      const chunkPresent = mockDownloadChunk.getMockImplementation();
      mockDownloadChunk.mockImplementation(async ref => {
        if (ref.index === 2) throw make404();
        return chunkPresent(ref);
      });
      await expect(readFeedState(MOCK_OWNER, 'topic')).resolves.toEqual({ exists: true, index: 1 });
      mockDownloadChunk.mockImplementation(async ref => {
        if (ref.index === 0) throw make404();
        return chunkPresent(ref);
      });
      await expect(readFeedState(MOCK_OWNER, 'topic')).resolves.toEqual({ exists: false });
    });

    test('only a 404 means the feed has no update yet', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      await expect(readFeedState(MOCK_OWNER, 'topic')).resolves.toEqual({ exists: false });
      // A 500 can't tell an empty feed from an unreachable one.
      mockMakeFeedReader.mockReturnValue({ downloadPayload: jest.fn().mockRejectedValue(new MockBeeResponseError(500)) });
      await expect(readFeedState(MOCK_OWNER, 'topic')).rejects.toBeInstanceOf(MockBeeResponseError);
    });
  });

  describe('readFeedPayload', () => {
    test('reads latest entry when no index provided', async () => {
      const reader = createMockReader({
        downloadPayloadResult: {
          payload: new MockBytes('latest data'),
          feedIndex: new MockFeedIndex(3),
          feedIndexNext: new MockFeedIndex(4),
        },
      });
      mockMakeFeedReader.mockReturnValue(reader);

      const result = await readFeedPayload(MOCK_OWNER, new MockTopic('ab'.repeat(32)));

      expect(reader.downloadPayload).toHaveBeenCalledWith();
      expect(result.payload).toEqual(Buffer.from('latest data'));
      expect(result.index).toBe(3);
      expect(result.nextIndex).toBe(4);
    });

    test('reads specific index when provided', async () => {
      const reader = createMockReader();
      mockExactFeedPayload('entry 2');
      mockMakeFeedReader.mockReturnValue(reader);

      const result = await readFeedPayload(MOCK_OWNER, new MockTopic('ab'.repeat(32)), 2);

      expect(reader.downloadPayload).not.toHaveBeenCalled();
      expect(mockDownloadChunk).toHaveBeenCalled();
      expect(result.payload).toEqual(Buffer.from('entry 2'));
      expect(result.index).toBe(2);
      expect(result.nextIndex).toBe(3);
    });

    test('unwraps bee-js Bytes payload via toUint8Array (regression test for zeroing bug)', async () => {
      // MockBytes mirrors bee-js's Bytes class — an object with .length + .toUint8Array(),
      // but NO numeric index properties. If the service does Buffer.from(bytesInstance)
      // directly, Node treats it as array-like and fills with zeros. The fix is to
      // call .toUint8Array() first.
      const reader = createMockReader();
      mockExactFeedPayload('HELLO-WORLD');
      mockMakeFeedReader.mockReturnValue(reader);

      const result = await readFeedPayload(MOCK_OWNER, new MockTopic('ab'.repeat(32)), 0);

      // The actual text must round-trip, not a Buffer of zeros of matching length
      expect(result.payload.toString('utf8')).toBe('HELLO-WORLD');
    });

    test('passes Topic object directly to feed.makeReader', async () => {
      const topic = new MockTopic('cd'.repeat(32));
      const reader = createMockReader({
        downloadPayloadResult: {
          payload: new MockBytes('data'),
          feedIndex: new MockFeedIndex(0),
        },
      });
      mockMakeFeedReader.mockReturnValue(reader);

      await readFeedPayload(MOCK_OWNER, topic);

      expect(mockMakeFeedReader).toHaveBeenCalledWith(topic, expect.any(MockEthAddress));
    });

    test('throws feed_empty on empty feed (latest read)', async () => {
      const reader = createMockReader(); // downloadPayload rejects
      mockMakeFeedReader.mockReturnValue(reader);

      try {
        await readFeedPayload(MOCK_OWNER, new MockTopic('ab'.repeat(32)));
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.reason).toBe('feed_empty');
        expect(err.message).toContain('empty');
      }
    });

    test('throws entry_not_found on missing index (indexed read)', async () => {
      const reader = createMockReader(); // downloadPayload rejects
      mockMakeFeedReader.mockReturnValue(reader);
      mockDownloadChunk.mockRejectedValue(make404());

      try {
        await readFeedPayload(MOCK_OWNER, new MockTopic('ab'.repeat(32)), 99);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err.reason).toBe('entry_not_found');
        expect(err.message).toContain('index 99');
      }
    });

    test('propagates non-404 errors on latest read (does not return feed_empty)', async () => {
      const reader = createMockReader();
      reader.downloadPayload.mockRejectedValue(new Error('network timeout'));
      mockMakeFeedReader.mockReturnValue(reader);

      await expect(readFeedPayload(MOCK_OWNER, new MockTopic('ab'.repeat(32))))
        .rejects.toThrow('network timeout');
    });

    test('propagates non-404 errors on indexed read (does not return entry_not_found)', async () => {
      const reader = createMockReader();
      mockDownloadChunk.mockRejectedValue(new Error('Bee internal error'));
      mockMakeFeedReader.mockReturnValue(reader);

      await expect(readFeedPayload(MOCK_OWNER, new MockTopic('ab'.repeat(32)), 5))
        .rejects.toThrow('Bee internal error');
    });

    test('constructs EthAddress from owner string', async () => {
      const reader = createMockReader({
        downloadPayloadResult: {
          payload: new MockBytes('data'),
          feedIndex: new MockFeedIndex(0),
        },
      });
      mockMakeFeedReader.mockReturnValue(reader);

      await readFeedPayload('0x1234567890abcdef1234567890abcdef12345678', new MockTopic('ab'.repeat(32)));

      const [, ownerArg] = mockMakeFeedReader.mock.calls[0];
      expect(ownerArg).toBeInstanceOf(MockEthAddress);
    });
  });

  describe('withWriteLock', () => {
    test('serializes writes to the same topic', async () => {
      const order = [];

      const p1 = withWriteLock('topic-a', async () => {
        order.push('start-1');
        await new Promise(r => setTimeout(r, 50));
        order.push('end-1');
        return 'result-1';
      });

      const p2 = withWriteLock('topic-a', async () => {
        order.push('start-2');
        return 'result-2';
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe('result-1');
      expect(r2).toBe('result-2');
      // start-2 must come after end-1
      expect(order).toEqual(['start-1', 'end-1', 'start-2']);
    });

    test('allows parallel writes to different topics', async () => {
      const order = [];

      const p1 = withWriteLock('topic-a', async () => {
        order.push('start-a');
        await new Promise(r => setTimeout(r, 50));
        order.push('end-a');
      });

      const p2 = withWriteLock('topic-b', async () => {
        order.push('start-b');
        await new Promise(r => setTimeout(r, 10));
        order.push('end-b');
      });

      await Promise.all([p1, p2]);

      // Both should start before either ends
      expect(order.indexOf('start-a')).toBeLessThan(order.indexOf('end-a'));
      expect(order.indexOf('start-b')).toBeLessThan(order.indexOf('end-b'));
      // b should finish before a (shorter delay)
      expect(order.indexOf('end-b')).toBeLessThan(order.indexOf('end-a'));
    });

    test('failed write does not block subsequent writes', async () => {
      const p1 = withWriteLock('topic-a', async () => {
        throw new Error('write failed');
      });

      // First write fails
      await expect(p1).rejects.toThrow('write failed');

      // Second write should still execute
      const result = await withWriteLock('topic-a', async () => 'recovered');
      expect(result).toBe('recovered');
    });

    test('cleans up lock map when chain is idle', async () => {
      // Access the internal map via module
      await withWriteLock('cleanup-test', async () => 'done');

      // The lock for 'cleanup-test' should have been cleaned up
      // (We can't access writeLocks directly, but we can verify the next
      // call doesn't wait on anything)
      const start = Date.now();
      await withWriteLock('cleanup-test', async () => 'immediate');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(20);
    });

    // K-1: a write queued behind another holds its signer's key until its
    // turn; a vault lock meanwhile (a new epoch) must stop it.
    test('a queued write whose vault epoch has ended never runs', async () => {
      const vaultEpoch = require('../identity/vault-epoch');
      let release;
      const first = withWriteLock('topic-epoch', () => new Promise((resolve) => {
        release = resolve;
      }));
      const signed = jest.fn(async () => 'signed');
      const queued = withWriteLock('topic-epoch', signed);
      queued.catch(() => {});
      // The first write is running (it took its turn in the old epoch).
      for (let i = 0; i < 10 && !release; i += 1) await Promise.resolve();
      expect(release).toEqual(expect.any(Function));

      vaultEpoch.advanceVaultEpoch();
      release('first');
      await expect(first).resolves.toBe('first');
      await expect(queued).rejects.toThrow(/locked/i);
      expect(signed).not.toHaveBeenCalled();
    });

    test('an update whose index lookup outlasts the vault epoch uploads nothing', async () => {
      const vaultEpoch = require('../identity/vault-epoch');
      let answerLookup;
      const writer = createMockWriter();
      writer.downloadPayload = jest.fn(() => new Promise((resolve) => {
        answerLookup = resolve;
      }));
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();

      const updating = updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/epoch', 'cc'.repeat(32), undefined, {
        epoch: vaultEpoch.currentVaultEpoch(),
      });
      updating.catch(() => {});
      for (let i = 0; i < 10 && !answerLookup; i += 1) await Promise.resolve();
      vaultEpoch.advanceVaultEpoch();
      answerLookup({ payload: Buffer.from('x'), feedIndex: new MockFeedIndex(1), feedIndexNext: new MockFeedIndex(2) });

      await expect(updating).rejects.toThrow(/locked/i);
      expect(writer.uploadReference).not.toHaveBeenCalled();
    });

    test('a key read in an earlier epoch is refused at once', async () => {
      const vaultEpoch = require('../identity/vault-epoch');
      const taken = vaultEpoch.currentVaultEpoch();
      vaultEpoch.advanceVaultEpoch();
      const writer = createMockWriter();
      mockMakeFeedWriter.mockReturnValue(writer);
      mockBatchForAutoSelect();
      await expect(
        writeFeedPayload(TEST_PRIVATE_KEY, 'myapp.eth/epoch', 'x', { epoch: taken })
      ).rejects.toThrow(/locked/i);
      expect(writer.uploadPayload).not.toHaveBeenCalled();
    });
  });
});
