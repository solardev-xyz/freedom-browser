const mockCreateFeedManifest = jest.fn();
const mockMakeFeedWriter = jest.fn();
const mockWriterUpload = jest.fn();
const mockGetPostageBatches = jest.fn();

// Minimal stand-ins for bee-js typed bytes used in assertions
class MockReference {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
}

let topicCounter = 0;
class MockTopic {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
  static fromString(_s) { return new MockTopic((topicCounter++).toString(16).padStart(64, '0')); }
}

class MockEthAddress {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
  toChecksum() { return `0x${this._hex}`; }
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

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation(() => ({
    createFeedManifest: mockCreateFeedManifest,
    makeFeedWriter: mockMakeFeedWriter,
    getPostageBatches: mockGetPostageBatches,
  })),
  PrivateKey: MockPrivateKey,
  Topic: MockTopic,
}));

jest.mock('../service-registry', () => ({
  getBeeApiUrl: jest.fn().mockReturnValue('http://127.0.0.1:1633'),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const { buildTopicString, createFeed, updateFeed } = require('./feed-service');

const TEST_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
const MOCK_MANIFEST_REF = 'ff'.repeat(32);
const MOCK_BATCH_ID = 'aa'.repeat(32);

function mockBatchForAutoSelect() {
  mockGetPostageBatches.mockResolvedValue([{
    usable: true,
    remainingSize: { toBytes: () => 1_000_000 },
    duration: { toSeconds: () => 86400 },
    batchID: { toHex: () => MOCK_BATCH_ID },
  }]);
}

beforeEach(() => {
  jest.clearAllMocks();
  topicCounter = 0;
  mockMakeFeedWriter.mockReturnValue({ upload: mockWriterUpload });
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

  describe('createFeed', () => {
    test('calls createFeedManifest with correct args', async () => {
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

    test('calls makeFeedWriter with correct topic and key', async () => {
      mockWriterUpload.mockResolvedValue(undefined);
      mockBatchForAutoSelect();

      await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);

      expect(mockMakeFeedWriter).toHaveBeenCalledTimes(1);
      const [topic, privateKey] = mockMakeFeedWriter.mock.calls[0];
      expect(topic).toBeInstanceOf(MockTopic);
      expect(privateKey.publicKey().address().toHex()).toBeTruthy();
    });

    test('calls writer.upload with batchId and reference', async () => {
      mockWriterUpload.mockResolvedValue(undefined);
      mockBatchForAutoSelect();

      await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);

      expect(mockWriterUpload).toHaveBeenCalledTimes(1);
      const [batchId, ref] = mockWriterUpload.mock.calls[0];
      expect(typeof batchId).toBe('string');
      expect(ref).toBe(CONTENT_REF);
    });

    test('returns success', async () => {
      mockWriterUpload.mockResolvedValue(undefined);
      mockBatchForAutoSelect();

      const result = await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF);
      expect(result).toEqual({ success: true });
    });

    test('uses explicit batchId when provided', async () => {
      mockWriterUpload.mockResolvedValue(undefined);

      await updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF, 'explicit_batch');

      const [batchId] = mockWriterUpload.mock.calls[0];
      expect(batchId).toBe('explicit_batch');
      expect(mockGetPostageBatches).not.toHaveBeenCalled();
    });

    test('throws when no usable batch available', async () => {
      mockGetPostageBatches.mockResolvedValue([]);

      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF))
        .rejects.toThrow('No usable postage batch');
    });

    test('propagates bee-js errors', async () => {
      mockWriterUpload.mockRejectedValue(new Error('network error'));
      mockBatchForAutoSelect();

      await expect(updateFeed(TEST_PRIVATE_KEY, 'myapp.eth/blog', CONTENT_REF))
        .rejects.toThrow('network error');
    });
  });
});
