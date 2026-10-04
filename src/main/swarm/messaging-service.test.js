var mockMineSigner = jest.fn();
var mockJoinJob = jest.fn();
var mockGsocSend = jest.fn();
var mockPssSend = jest.fn();
var mockGetNodeAddresses = jest.fn();
var mockCalculateSingleOwnerChunkAddress = jest.fn();
var mockSelectBestBatch = jest.fn();

class MockHexValue {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

class MockOwner extends MockHexValue {
  toChecksum() { return `0x${this._hex}`; }
}

class MockPublicKey {
  constructor(owner, compressedHex) {
    this._owner = owner;
    this._compressedHex = compressedHex;
  }
  address() { return this._owner; }
  toCompressedHex() { return this._compressedHex; }
}

// Stands in for bee-js PrivateKey: the derivation rebuilds the mined signer
// from the worker's hex. The owner is derived from the key so distinct keys
// stay distinguishable.
class MockPrivateKey {
  constructor(hex) {
    this._hex = hex;
    this._owner = new MockOwner(hex.slice(0, 40));
  }
  toHex() { return this._hex; }
  publicKey() { return new MockPublicKey(this._owner); }
}

class MockTopic extends MockHexValue {
  static fromString(value) {
    // Not the real keccak — just a deterministic, distinguishable stand-in.
    return new MockTopic(Buffer.from(`topic:${value}`).toString('hex').padEnd(64, '0').slice(0, 64));
  }
}

class MockIdentifier extends MockHexValue {
  constructor(bytes) { super(Buffer.from(bytes).toString('hex')); }
}

const MockBytes = {
  keccak256: (buffer) => new MockHexValue(Buffer.from(`keccak:${buffer.toString('utf-8')}`).toString('hex')),
};

var mockBee = {
  url: 'http://127.0.0.1:1633',
  messaging: {
    gsocSend: mockGsocSend,
    pssSend: mockPssSend,
  },
  connectivity: {
    getNodeAddresses: mockGetNodeAddresses,
  },
  calculateSingleOwnerChunkAddress: mockCalculateSingleOwnerChunkAddress,
};

jest.mock('@ethersphere/bee-js', () => ({
  Topic: MockTopic,
  Identifier: MockIdentifier,
  Bytes: MockBytes,
  PrivateKey: MockPrivateKey,
}));

jest.mock('./gsoc-miner', () => ({
  mineSigner: mockMineSigner,
  joinJob: mockJoinJob,
}));

jest.mock('./swarm-service', () => ({
  getBee: () => mockBee,
  selectBestBatch: mockSelectBestBatch,
  toHex: (value) => value?.toHex?.() || String(value || ''),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  getMessagingIdentity,
  deriveGsoc,
  resolvePssTopicHex,
  sendPss,
  sendGsoc,
  openSubscriptionSocket,
  MAX_MESSAGE_BYTES,
  MAX_TARGET_DEPTH,
  DEFAULT_TARGET_DEPTH,
  NEW_TOPIC_WINDOW_MS,
  NEW_TOPICS_PER_WINDOW,
  _resetGsocCache,
} = require('./messaging-service');

const BATCH_ID = 'aa'.repeat(32);
const SOC_ADDRESS = 'cc'.repeat(32);
const MINED_KEY = 'dd'.repeat(32);

beforeEach(() => {
  jest.clearAllMocks();
  _resetGsocCache();
  mockSelectBestBatch.mockResolvedValue(BATCH_ID);
  mockMineSigner.mockResolvedValue(MINED_KEY);
  mockCalculateSingleOwnerChunkAddress.mockReturnValue(new MockHexValue(SOC_ADDRESS));
});

describe('limits', () => {
  test('match the Ant node constants', () => {
    expect(MAX_MESSAGE_BYTES).toBe(4000); // 4096 - 3*32
    expect(MAX_TARGET_DEPTH).toBe(3);
    expect(DEFAULT_TARGET_DEPTH).toBe(2); // L=16 convention, ≥ storability floor
  });
});

describe('getMessagingIdentity', () => {
  test('returns the compressed PSS key and overlay hex', async () => {
    mockGetNodeAddresses.mockResolvedValue({
      pssPublicKey: new MockPublicKey(null, '02' + 'ab'.repeat(32)),
      overlay: new MockHexValue('ee'.repeat(32)),
    });

    const identity = await getMessagingIdentity();
    expect(identity.pssPublicKey).toBe('02' + 'ab'.repeat(32));
    expect(identity.overlay).toBe('ee'.repeat(32));
  });

  test('strips a 0x prefix from the compressed key', async () => {
    mockGetNodeAddresses.mockResolvedValue({
      pssPublicKey: new MockPublicKey(null, '0x03' + 'cd'.repeat(32)),
      overlay: new MockHexValue('ee'.repeat(32)),
    });

    const identity = await getMessagingIdentity();
    expect(identity.pssPublicKey).toBe('03' + 'cd'.repeat(32));
  });
});

describe('deriveGsoc', () => {
  test('mines with topic-derived identifier and target, returns the SOC address', async () => {
    const result = await deriveGsoc('room:doc-42', { origin: 'https://a.example' });

    expect(mockMineSigner).toHaveBeenCalledTimes(1);
    const [targetOverlay, identifier, proximity, options] = mockMineSigner.mock.calls[0];
    // The origin is passed through so the miner can queue fairly per origin.
    expect(options).toEqual({ owner: 'https://a.example', key: 'gsoc-topic:room:doc-42' });
    // targetOverlay derives from the namespaced context string, identifier from the raw topic
    expect(Buffer.from(targetOverlay).toString('utf-8')).toContain('freedom-gsoc-v1:room:doc-42');
    expect(Buffer.from(identifier).toString('hex')).toBe(Buffer.from('keccak:room:doc-42').toString('hex'));
    expect(proximity).toBe(12);
    expect(result.address).toBe(SOC_ADDRESS);
    expect(result.identifier.toHex()).toBe(Buffer.from('keccak:room:doc-42').toString('hex'));
    // The worker's hex comes back as a signer object, and the SOC address is
    // computed from that signer's owner.
    expect(result.signer).toBeInstanceOf(MockPrivateKey);
    expect(result.signer.toHex()).toBe(MINED_KEY);
    const [, owner] = mockCalculateSingleOwnerChunkAddress.mock.calls[0];
    expect(owner.toHex()).toBe(MINED_KEY.slice(0, 40));
  });

  test('caches the mined derivation per topic', async () => {
    await deriveGsoc('room:a');
    await deriveGsoc('room:a');
    expect(mockMineSigner).toHaveBeenCalledTimes(1);

    await deriveGsoc('room:b');
    expect(mockMineSigner).toHaveBeenCalledTimes(2);
  });

  test('concurrent derivations of one topic share a single mining job', async () => {
    let release;
    mockMineSigner.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    const first = deriveGsoc('room:a', { origin: 'https://a.example' });
    const second = deriveGsoc('room:a', { origin: 'https://b.example' });
    await Promise.resolve();
    expect(mockMineSigner).toHaveBeenCalledTimes(1);
    // The job is keyed by topic, and the joining origin is added as an owner of
    // it, so it runs at B's round-robin turn too — not only behind A's backlog.
    expect(mockMineSigner.mock.calls[0][3]).toEqual({
      owner: 'https://a.example',
      key: 'gsoc-topic:room:a',
    });
    expect(mockJoinJob).toHaveBeenCalledTimes(1);
    expect(mockJoinJob).toHaveBeenCalledWith('gsoc-topic:room:a', { owner: 'https://b.example' });
    release(MINED_KEY);

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(mockMineSigner).toHaveBeenCalledTimes(1);
  });

  test('a failed derivation is not cached and the next call mines again', async () => {
    const err = new Error('GSOC mining failed: timed out');
    err.reason = 'gsoc_mining_timeout';
    mockMineSigner.mockRejectedValueOnce(err);

    const first = deriveGsoc('room:a');
    const joined = deriveGsoc('room:a');
    await expect(first).rejects.toBe(err);
    await expect(joined).rejects.toBe(err);

    await expect(deriveGsoc('room:a')).resolves.toMatchObject({ address: SOC_ADDRESS });
    expect(mockMineSigner).toHaveBeenCalledTimes(2);
  });

  test('evicts the oldest topic once 128 are cached', async () => {
    // One origin per topic, so the per-origin budget stays out of the way.
    const derive = (topic, i) => deriveGsoc(topic, { origin: `https://o${i}.example` });
    for (let i = 0; i < 128; i++) await derive(`room:${i}`, i);
    expect(mockMineSigner).toHaveBeenCalledTimes(128);
    await derive('room:127', 1000);
    expect(mockMineSigner).toHaveBeenCalledTimes(128);

    await derive('room:128', 128); // evicts room:0
    await derive('room:1', 1001); // still cached
    expect(mockMineSigner).toHaveBeenCalledTimes(129);
    await derive('room:0', 1002);
    expect(mockMineSigner).toHaveBeenCalledTimes(130);
  });

  describe('per-origin new-topic budget', () => {
    afterEach(() => jest.useRealTimers());

    test('refuses an origin past its budget with a clear, retryable error', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      const origin = 'https://cycler.example';
      for (let i = 0; i < NEW_TOPICS_PER_WINDOW; i++) {
        await deriveGsoc(`room:${i}`, { origin });
      }
      jest.setSystemTime(1_000_000 + 10_000);

      const refused = deriveGsoc('room:one-too-many', { origin });
      await expect(refused).rejects.toMatchObject({
        reason: 'topic_rate_limited',
        limit: NEW_TOPICS_PER_WINDOW,
        windowMs: NEW_TOPIC_WINDOW_MS,
        retryAfterMs: NEW_TOPIC_WINDOW_MS - 10_000,
      });
      await expect(refused).rejects.toThrow(/Too many new messaging topics.*Retry in 50 s/);
      expect(mockMineSigner).toHaveBeenCalledTimes(NEW_TOPICS_PER_WINDOW);
    });

    test('cache hits and joins of an in-flight derivation are free', async () => {
      const origin = 'https://chat.example';
      for (let i = 0; i < NEW_TOPICS_PER_WINDOW; i++) {
        await deriveGsoc(`room:${i}`, { origin });
      }
      // Already-derived rooms keep working for the origin at its budget.
      await expect(deriveGsoc('room:0', { origin })).resolves.toMatchObject({ address: SOC_ADDRESS });

      // A topic another origin is mining right now can be joined at no cost.
      let release;
      mockMineSigner.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
      const other = deriveGsoc('room:shared', { origin: 'https://other.example' });
      const joined = deriveGsoc('room:shared', { origin });
      release(MINED_KEY);
      await expect(Promise.all([other, joined])).resolves.toHaveLength(2);
    });

    test('budgets are per origin', async () => {
      for (let i = 0; i < NEW_TOPICS_PER_WINDOW; i++) {
        await deriveGsoc(`room:${i}`, { origin: 'https://a.example' });
      }
      await expect(deriveGsoc('room:a-extra', { origin: 'https://a.example' }))
        .rejects.toMatchObject({ reason: 'topic_rate_limited' });
      await expect(deriveGsoc('room:b-1', { origin: 'https://b.example' }))
        .resolves.toMatchObject({ address: SOC_ADDRESS });
    });

    test('the budget frees up as the window slides', async () => {
      jest.useFakeTimers({ now: 2_000_000 });
      const origin = 'https://chat.example';
      for (let i = 0; i < NEW_TOPICS_PER_WINDOW; i++) {
        await deriveGsoc(`room:${i}`, { origin });
      }
      await expect(deriveGsoc('room:late', { origin })).rejects.toMatchObject({ reason: 'topic_rate_limited' });

      jest.setSystemTime(2_000_000 + NEW_TOPIC_WINDOW_MS);
      await expect(deriveGsoc('room:late', { origin })).resolves.toMatchObject({ address: SOC_ADDRESS });
    });
  });
});

describe('resolvePssTopicHex', () => {
  test('resolves via Topic.fromString', () => {
    expect(resolvePssTopicHex('dm:alice')).toBe(MockTopic.fromString('dm:alice').toHex());
  });
});

describe('sendPss', () => {
  test('sends with an auto-selected batch, topic, target, and recipient', async () => {
    await sendPss({ topic: 'dm:alice', targets: 'aabb', recipient: '02' + 'ab'.repeat(32), data: 'hello' });

    expect(mockPssSend).toHaveBeenCalledTimes(1);
    // Messaging opts into the full-mutable-batch fallback (ephemeral traffic).
    expect(mockSelectBestBatch).toHaveBeenCalledWith(4096, { allowFullMutable: true });
    const [batchId, topic, target, data, recipient] = mockPssSend.mock.calls[0];
    expect(batchId).toBe(BATCH_ID);
    expect(topic.toHex()).toBe(MockTopic.fromString('dm:alice').toHex());
    expect(target).toBe('aabb');
    expect(data).toBe('hello');
    expect(recipient).toBe('02' + 'ab'.repeat(32));
  });

  test('fails without a usable batch', async () => {
    mockSelectBestBatch.mockResolvedValue(null);
    await expect(
      sendPss({ topic: 't', targets: 'aa', recipient: '02' + 'ab'.repeat(32), data: 'x' })
    ).rejects.toThrow(/postage batch/);
    expect(mockPssSend).not.toHaveBeenCalled();
  });
});

describe('sendGsoc', () => {
  test('derives the topic coordinates, sends, and returns the address', async () => {
    const result = await sendGsoc({ topic: 'room:doc-42', data: 'hello room' });

    expect(mockGsocSend).toHaveBeenCalledTimes(1);
    const [batchId, signer, identifier, data] = mockGsocSend.mock.calls[0];
    expect(batchId).toBe(BATCH_ID);
    expect(signer).toBeInstanceOf(MockPrivateKey);
    expect(identifier.toHex()).toBe(Buffer.from('keccak:room:doc-42').toString('hex'));
    expect(data).toBe('hello room');
    expect(result.address).toBe(SOC_ADDRESS);
  });

  test('fails without a usable batch', async () => {
    mockSelectBestBatch.mockResolvedValue(null);
    await expect(sendGsoc({ topic: 't', data: 'x' })).rejects.toThrow(/postage batch/);
    expect(mockGsocSend).not.toHaveBeenCalled();
  });
});

describe('openSubscriptionSocket', () => {
  let sockets;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closeCalls = [];
      sockets.push(this);
    }
    close(code) {
      this.closeCalls.push(code);
      this.readyState = 3;
    }
    emitOpen() {
      this.readyState = 1;
      this.onopen?.();
    }
    emitMessage(payload) {
      const bytes = Buffer.from(payload);
      this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
    emitClose(code, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }

  beforeEach(() => {
    jest.useFakeTimers();
    sockets = [];
    global.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.WebSocket;
  });

  test('builds the gsoc and pss subscribe URLs', () => {
    openSubscriptionSocket({ kind: 'gsoc', key: 'ab'.repeat(32) }, { onMessage: jest.fn() }).cancel();
    openSubscriptionSocket({ kind: 'pss', key: 'cd'.repeat(32) }, { onMessage: jest.fn() }).cancel();

    expect(sockets[0].url).toBe(`ws://127.0.0.1:1633/gsoc/subscribe/${'ab'.repeat(32)}`);
    expect(sockets[1].url).toBe(`ws://127.0.0.1:1633/pss/subscribe/${'cd'.repeat(32)}`);
  });

  test('establishes after the socket stays open through the grace window', async () => {
    const handle = openSubscriptionSocket({ kind: 'gsoc', key: 'ab'.repeat(32) }, { onMessage: jest.fn() });

    sockets[0].emitOpen();
    jest.advanceTimersByTime(600);
    await expect(handle.established).resolves.toBeUndefined();
    handle.cancel();
  });

  test('rejects with node_subscription_limit on a 1013 refusal close', async () => {
    const handle = openSubscriptionSocket({ kind: 'gsoc', key: 'ab'.repeat(32) }, { onMessage: jest.fn() });

    sockets[0].emitOpen();
    sockets[0].emitClose(1013, 'no lurker slot available');

    await expect(handle.established).rejects.toMatchObject({ reason: 'node_subscription_limit' });
    // Refusal is terminal — no reconnect attempt
    jest.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
  });

  test('delivers every frame, including byte-identical repeats', async () => {
    const onMessage = jest.fn();
    const handle = openSubscriptionSocket({ kind: 'pss', key: 'cd'.repeat(32) }, { onMessage });

    sockets[0].emitOpen();
    jest.advanceTimersByTime(600);
    // A repeated 'ok' in a chat and an empty presence ping are legitimate
    // messages: on the wire they are indistinguishable from a redelivery,
    // so suppressing them would silently swallow real traffic.
    sockets[0].emitMessage('hello');
    sockets[0].emitMessage('hello');
    sockets[0].emitMessage('');
    sockets[0].emitMessage('');
    sockets[0].emitMessage('world');

    expect(onMessage).toHaveBeenCalledTimes(5);
    expect(onMessage.mock.calls.map(([payload]) => payload.toString('utf-8'))).toEqual([
      'hello',
      'hello',
      '',
      '',
      'world',
    ]);
    handle.cancel();
  });

  test('reconnects with backoff after an abnormal close, once established', async () => {
    const handle = openSubscriptionSocket({ kind: 'gsoc', key: 'ab'.repeat(32) }, { onMessage: jest.fn() });

    sockets[0].emitOpen();
    jest.advanceTimersByTime(600);
    await handle.established;

    sockets[0].emitClose(1006);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);

    // Second failure backs off longer
    sockets[1].emitClose(1006);
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
    handle.cancel();
  });

  test('cancel closes the socket and stops reconnecting', async () => {
    const handle = openSubscriptionSocket({ kind: 'gsoc', key: 'ab'.repeat(32) }, { onMessage: jest.fn() });

    sockets[0].emitOpen();
    jest.advanceTimersByTime(600);
    await handle.established;

    handle.cancel();
    expect(sockets[0].closeCalls).toEqual([1000]);
    sockets[0].emitClose(1000);
    jest.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
  });

  test('cancel before establishment rejects the established promise', async () => {
    const handle = openSubscriptionSocket({ kind: 'gsoc', key: 'ab'.repeat(32) }, { onMessage: jest.fn() });
    handle.cancel();
    await expect(handle.established).rejects.toMatchObject({ reason: 'cancelled' });
  });
});
