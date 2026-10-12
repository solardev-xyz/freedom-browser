const mockCreateFeedManifest = jest.fn();
const mockMakeFeedReader = jest.fn();
const mockGetPostageBatches = jest.fn();
const mockCalculateSingleOwnerChunkAddress = jest.fn();
const mockDownloadChunk = jest.fn();
const mockUnmarshalSingleOwnerChunk = jest.fn();
const mockMakeContentAddressedChunk = jest.fn();
const mockDownloadData = jest.fn();
const mockUploadData = jest.fn();
const mockUnmarshalContentAddressedChunk = jest.fn();
const mockUploadSingleOwnerChunk = jest.fn();

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
  static keccak256(_bytes) { return new MockBytes(new Uint8Array(32).fill(7)); }
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
    unmarshalContentAddressedChunk: mockUnmarshalContentAddressedChunk,
    data: {
      download: mockDownloadData,
      upload: mockUploadData,
    },
  })),
  Reference: MockReference,
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

// The SOC upload (chunk-service); feed-service hands it the signed chunk.
jest.mock('./chunk-service', () => ({
  uploadSingleOwnerChunk: (...args) => mockUploadSingleOwnerChunk(...args),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const { buildTopicString, createFeed, updateFeed, writeFeedPayload, readFeedPayload, withWriteLock, feedIndexToNumber, isNotFoundError } = require('./feed-service');

// A Swarm signer (swarm-signer.js): the identity core signs; the test
// stands in for its checked result.
const SIGNER_OWNER = '0x' + 'ab'.repeat(20);
function makeSigner() {
  return {
    owner: SIGNER_OWNER,
    signSoc: jest.fn(async ({ payload, span }) => ({
      span: span ?? BigInt(payload.length),
      chunkAddress: '0x' + 'cd'.repeat(32),
      signature: '0x' + 'ef'.repeat(65),
      owner: SIGNER_OWNER,
      socAddress: '0x' + '12'.repeat(32),
    })),
  };
}
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
    test('creates the manifest for the signer owner', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      await createFeed(makeSigner(), 'myapp.eth/blog');

      expect(mockCreateFeedManifest).toHaveBeenCalledTimes(1);
      const [batchId, topic, owner] = mockCreateFeedManifest.mock.calls[0];
      expect(typeof batchId).toBe('string');
      expect(topic).toBeInstanceOf(MockTopic);
      expect(owner.toHex()).toBe(SIGNER_OWNER.slice(2));
    });

    test('returns normalized result', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      const result = await createFeed(makeSigner(), 'myapp.eth/blog');

      expect(result.topic).toMatch(/^[0-9a-f]+$/);
      expect(result.owner).toBe(SIGNER_OWNER);
      expect(result.manifestReference).toBe(MOCK_MANIFEST_REF);
      expect(result.bzzUrl).toBe(`bzz://${MOCK_MANIFEST_REF}`);
    });

    test('signs nothing', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();
      const signer = makeSigner();

      await createFeed(signer, 'myapp.eth/blog');

      expect(signer.signSoc).not.toHaveBeenCalled();
    });

    test('uses explicit batchId when provided', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));

      await createFeed(makeSigner(), 'myapp.eth/blog', 'explicit_batch');

      const [batchId] = mockCreateFeedManifest.mock.calls[0];
      expect(batchId).toBe('explicit_batch');
      expect(mockGetPostageBatches).not.toHaveBeenCalled();
    });

    test('throws when no usable batch available', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      await expect(createFeed(makeSigner(), 'myapp.eth/blog')).rejects.toThrow('No usable postage batch');
    });

    test('propagates bee-js errors', async () => {
      mockCreateFeedManifest.mockRejectedValue(new Error('manifest creation failed'));
      mockBatchForAutoSelect();

      await expect(createFeed(makeSigner(), 'myapp.eth/blog')).rejects.toThrow('manifest creation failed');
    });

    test('different topics produce different topic hashes', async () => {
      mockCreateFeedManifest.mockResolvedValue(new MockReference(MOCK_MANIFEST_REF));
      mockBatchForAutoSelect();

      const result1 = await createFeed(makeSigner(), 'myapp.eth/blog');
      const result2 = await createFeed(makeSigner(), 'myapp.eth/profile');

      expect(result1.topic).not.toBe(result2.topic);
    });
  });

  describe('updateFeed', () => {
    const CONTENT_REF = 'cc'.repeat(32);

    beforeEach(() => {
      mockUploadSingleOwnerChunk.mockResolvedValue('12'.repeat(32));
    });

    test('signs the update in the core and uploads it as bee-js did', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockBatchForAutoSelect();
      const signer = makeSigner();
      const before = Math.floor(Date.now() / 1000);

      await updateFeed(signer, 'myapp.eth/blog', CONTENT_REF);

      // The index comes from a reader for the signer's owner.
      const [, owner] = mockMakeFeedReader.mock.calls[0];
      expect(owner.toHex()).toBe(SIGNER_OWNER.slice(2));
      // Payload: unix seconds (uint64 BE) ‖ reference; the span is its length.
      const [{ identifier, payload, span }] = signer.signSoc.mock.calls[0];
      expect(identifier).toHaveLength(32);
      expect(span).toBeUndefined();
      expect(payload).toHaveLength(40);
      const seconds = Number(Buffer.from(payload).readBigUInt64BE(0));
      expect(seconds).toBeGreaterThanOrEqual(before);
      expect(Buffer.from(payload.subarray(8)).toString('hex')).toBe(CONTENT_REF);
      // Uploaded with only the batch header (no pin/deferred options).
      const [, batchId, chunk, options] = mockUploadSingleOwnerChunk.mock.calls[0];
      expect(batchId).toBe(MOCK_BATCH_ID);
      expect(chunk).toMatchObject({ owner: SIGNER_OWNER, identifier, payload });
      expect(options).toBeUndefined();
    });

    test('returns index 0 on an empty feed', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockBatchForAutoSelect();

      await expect(updateFeed(makeSigner(), 'myapp.eth/blog', CONTENT_REF)).resolves.toEqual({ index: 0 });
    });

    test('resolves next index from non-empty feed', async () => {
      mockMakeFeedReader.mockReturnValue(
        createMockReader({
          downloadPayloadResult: {
            payload: Buffer.from('data'),
            feedIndex: new MockFeedIndex(5),
            feedIndexNext: new MockFeedIndex(6),
          },
        })
      );
      mockBatchForAutoSelect();

      const result = await updateFeed(makeSigner(), 'myapp.eth/blog', CONTENT_REF);

      expect(result.index).toBe(6);
    });

    test('uses explicit batchId when provided', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());

      await updateFeed(makeSigner(), 'myapp.eth/blog', CONTENT_REF, 'explicit_batch');

      const [, batchId] = mockUploadSingleOwnerChunk.mock.calls[0];
      expect(batchId).toBe('explicit_batch');
      expect(mockGetPostageBatches).not.toHaveBeenCalled();
    });

    test('throws when no usable batch available', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      await expect(updateFeed(makeSigner(), 'myapp.eth/blog', CONTENT_REF)).rejects.toThrow(
        'No usable postage batch'
      );
    });

    test('propagates upload errors', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockUploadSingleOwnerChunk.mockRejectedValue(new Error('network error'));
      mockBatchForAutoSelect();

      await expect(updateFeed(makeSigner(), 'myapp.eth/blog', CONTENT_REF)).rejects.toThrow('network error');
    });

    test('propagates signing errors (a locked vault) without uploading', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockBatchForAutoSelect();
      const signer = makeSigner();
      signer.signSoc.mockRejectedValue(new Error('Vault is locked'));

      await expect(updateFeed(signer, 'myapp.eth/blog', CONTENT_REF)).rejects.toThrow('Vault is locked');
      expect(mockUploadSingleOwnerChunk).not.toHaveBeenCalled();
    });

    test('propagates non-404 errors from resolveNextIndex (does not default to 0)', async () => {
      const reader = createMockReader();
      reader.downloadPayload.mockRejectedValue(new Error('network timeout'));
      mockMakeFeedReader.mockReturnValue(reader);
      mockBatchForAutoSelect();

      await expect(updateFeed(makeSigner(), 'myapp.eth/blog', CONTENT_REF)).rejects.toThrow('network timeout');
    });
  });

  describe('writeFeedPayload', () => {
    beforeEach(() => {
      mockUploadSingleOwnerChunk.mockResolvedValue('12'.repeat(32));
    });

    test('signs and uploads a small payload (strings as UTF-8)', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockBatchForAutoSelect();
      const signer = makeSigner();

      const result = await writeFeedPayload(signer, 'myapp.eth/blog', 'hello wörld');

      expect(result.index).toBe(0);
      const [{ payload, span }] = signer.signSoc.mock.calls[0];
      expect(Buffer.from(payload)).toEqual(Buffer.from('hello wörld', 'utf-8'));
      expect(span).toBeUndefined();
      const [, , , options] = mockUploadSingleOwnerChunk.mock.calls[0];
      expect(options).toBeUndefined();
    });

    test('accepts Buffer data as is', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockBatchForAutoSelect();
      const signer = makeSigner();

      const buf = Buffer.from('binary data');
      await writeFeedPayload(signer, 'myapp.eth/blog', buf);

      expect(signer.signSoc.mock.calls[0][0].payload).toBe(buf);
    });

    test('auto-increments on non-empty feed', async () => {
      mockMakeFeedReader.mockReturnValue(
        createMockReader({
          downloadPayloadResult: {
            payload: Buffer.from('prev'),
            feedIndex: new MockFeedIndex(3),
            feedIndexNext: new MockFeedIndex(4),
          },
        })
      );
      mockBatchForAutoSelect();

      const result = await writeFeedPayload(makeSigner(), 'myapp.eth/blog', 'data');

      expect(result.index).toBe(4);
    });

    test('uses explicit index when provided', async () => {
      const reader = createMockReader();
      mockMakeFeedReader.mockReturnValue(reader);
      mockDownloadChunk.mockRejectedValue(make404());
      mockBatchForAutoSelect();

      const result = await writeFeedPayload(makeSigner(), 'myapp.eth/blog', 'data', { index: 10 });

      expect(result.index).toBe(10);
      expect(reader.downloadPayload).not.toHaveBeenCalled();
      expect(mockCalculateSingleOwnerChunkAddress).toHaveBeenCalled();
    });

    test('rejects explicit index that already has an entry (overwrite protection)', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockExactFeedPayload('existing');
      mockBatchForAutoSelect();
      const signer = makeSigner();

      const error = await writeFeedPayload(signer, 'myapp.eth/blog', 'data', { index: 5 }).catch((e) => e);

      expect(error.message).toBe('Feed entry already exists at index 5');
      expect(error.reason).toBe('index_already_exists');
      expect(signer.signSoc).not.toHaveBeenCalled();
      expect(mockUploadSingleOwnerChunk).not.toHaveBeenCalled();
    });

    test('propagates non-404 errors during overwrite check (does not treat as free index)', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockDownloadChunk.mockRejectedValue(new Error('network timeout'));
      mockBatchForAutoSelect();

      await expect(writeFeedPayload(makeSigner(), 'myapp.eth/blog', 'data', { index: 5 })).rejects.toThrow(
        'network timeout'
      );
      expect(mockUploadSingleOwnerChunk).not.toHaveBeenCalled();
    });

    test('a payload over one chunk goes up through /bytes; the SOC wraps its root chunk', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockBatchForAutoSelect();
      const root = { payload: new MockBytes(Buffer.alloc(64, 9)), span: new MockSpan(50000) };
      mockUploadData.mockResolvedValue({ reference: new MockReference('ab'.repeat(32)) });
      mockDownloadChunk.mockResolvedValue(new MockBytes('raw root'));
      mockUnmarshalContentAddressedChunk.mockReturnValue(root);
      const signer = makeSigner();

      await writeFeedPayload(signer, 'myapp.eth/blog', 'x'.repeat(50000));

      const [batchId, data] = mockUploadData.mock.calls[0];
      expect(batchId).toBe(MOCK_BATCH_ID);
      expect(Buffer.from(data)).toEqual(Buffer.from('x'.repeat(50000)));
      expect(mockDownloadChunk).toHaveBeenCalledWith('ab'.repeat(32));
      const [{ payload, span }] = signer.signSoc.mock.calls[0];
      expect(Buffer.from(payload)).toEqual(Buffer.alloc(64, 9));
      expect(span).toBe(50000n);
    });

    test('uses explicit batchId when provided', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());

      await writeFeedPayload(makeSigner(), 'myapp.eth/blog', 'data', { batchId: 'my_batch' });

      const [, batchId] = mockUploadSingleOwnerChunk.mock.calls[0];
      expect(batchId).toBe('my_batch');
    });

    test('throws when no usable batch available', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      await expect(writeFeedPayload(makeSigner(), 'myapp.eth/blog', 'data')).rejects.toThrow(
        'No usable postage batch'
      );
    });

    test('propagates upload errors', async () => {
      mockMakeFeedReader.mockReturnValue(createMockReader());
      mockUploadSingleOwnerChunk.mockRejectedValue(new Error('chunk too large'));
      mockBatchForAutoSelect();

      await expect(writeFeedPayload(makeSigner(), 'myapp.eth/blog', 'data')).rejects.toThrow('chunk too large');
    });

    test('propagates non-404 errors during auto-increment (does not default to 0)', async () => {
      const reader = createMockReader();
      reader.downloadPayload.mockRejectedValue(new Error('Bee internal error'));
      mockMakeFeedReader.mockReturnValue(reader);
      mockBatchForAutoSelect();

      await expect(writeFeedPayload(makeSigner(), 'myapp.eth/blog', 'data')).rejects.toThrow('Bee internal error');
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
  });
});
