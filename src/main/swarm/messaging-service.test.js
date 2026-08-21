var mockGsocMine = jest.fn();
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

class MockMinedKey {
  constructor(ownerHex) { this._owner = new MockOwner(ownerHex); }
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
  gsocMine: mockGsocMine,
  gsocSend: mockGsocSend,
  pssSend: mockPssSend,
  getNodeAddresses: mockGetNodeAddresses,
  calculateSingleOwnerChunkAddress: mockCalculateSingleOwnerChunkAddress,
};

jest.mock('@ethersphere/bee-js', () => ({
  Topic: MockTopic,
  Identifier: MockIdentifier,
  Bytes: MockBytes,
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
  _resetGsocCache,
} = require('./messaging-service');

const BATCH_ID = 'aa'.repeat(32);
const SOC_ADDRESS = 'cc'.repeat(32);
const MINED_OWNER = 'dd'.repeat(20);

beforeEach(() => {
  jest.clearAllMocks();
  _resetGsocCache();
  mockSelectBestBatch.mockResolvedValue(BATCH_ID);
  mockGsocMine.mockReturnValue(new MockMinedKey(MINED_OWNER));
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
  test('mines with topic-derived identifier and target, returns the SOC address', () => {
    const result = deriveGsoc('room:doc-42');

    expect(mockGsocMine).toHaveBeenCalledTimes(1);
    const [targetOverlay, identifier, proximity] = mockGsocMine.mock.calls[0];
    // targetOverlay derives from the namespaced context string, identifier from the raw topic
    expect(Buffer.from(targetOverlay).toString('utf-8')).toContain('freedom-gsoc-v1:room:doc-42');
    expect(identifier.toHex()).toBe(Buffer.from('keccak:room:doc-42').toString('hex'));
    expect(typeof proximity).toBe('number');
    expect(result.address).toBe(SOC_ADDRESS);
    expect(result.signer).toBeInstanceOf(MockMinedKey);
  });

  test('caches the mined derivation per topic', () => {
    deriveGsoc('room:a');
    deriveGsoc('room:a');
    expect(mockGsocMine).toHaveBeenCalledTimes(1);

    deriveGsoc('room:b');
    expect(mockGsocMine).toHaveBeenCalledTimes(2);
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
    expect(signer).toBeInstanceOf(MockMinedKey);
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
