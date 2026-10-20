var mockMakeContentAddressedChunk = jest.fn();
var mockUploadChunk = jest.fn();
var mockDownloadChunk = jest.fn();
var mockDownloadData = jest.fn();
var mockUnmarshalContentAddressedChunk = jest.fn();
var mockUnmarshalSingleOwnerChunk = jest.fn();
var mockCalculateSingleOwnerChunkAddress = jest.fn();
var mockSelectBestBatch = jest.fn();

class MockBeeResponseError extends Error {
  constructor(status, message = 'Bee response error', responseBody) {
    super(message);
    this.status = status;
    if (responseBody !== undefined) this.responseBody = responseBody;
  }
}

class MockHexValue {
  constructor(hex) { this._hex = hex; }
  toHex() { return this._hex; }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

class MockSpan {
  constructor(value) { this._value = BigInt(value); }
  toBigInt() { return this._value; }
  toUint8Array() {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(this._value);
    return bytes;
  }
}

class MockPayload {
  constructor(bytes) { this._bytes = Buffer.from(bytes); }
  toUint8Array() { return this._bytes; }
}

class MockOwner extends MockHexValue {
  toChecksum() { return `0x${this._hex}`; }
}

class MockPublicKey {
  constructor(owner) { this._owner = owner; }
  address() { return this._owner; }
}

class MockPrivateKey {
  constructor(hex) {
    this._hex = hex;
    this._owner = new MockOwner(hex.replace(/^0x/, '').slice(0, 40));
  }
  publicKey() { return new MockPublicKey(this._owner); }
}

class MockIdentifier {
  constructor(hex) { this._hex = hex; }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

class MockEthAddress {
  constructor(hex) { this._hex = hex.replace(/^0x/, ''); }
  toUint8Array() { return Buffer.from(this._hex, 'hex'); }
}

var mockBee = {
  url: 'http://127.0.0.1:1633',
  makeContentAddressedChunk: mockMakeContentAddressedChunk,
  chunk: {
    upload: mockUploadChunk,
    download: mockDownloadChunk,
  },
  data: {
    download: mockDownloadData,
  },
  unmarshalContentAddressedChunk: mockUnmarshalContentAddressedChunk,
  unmarshalSingleOwnerChunk: mockUnmarshalSingleOwnerChunk,
  calculateSingleOwnerChunkAddress: mockCalculateSingleOwnerChunkAddress,
};

jest.mock('@ethersphere/bee-js', () => ({
  PrivateKey: MockPrivateKey,
  BeeResponseError: MockBeeResponseError,
  Identifier: MockIdentifier,
  EthAddress: MockEthAddress,
}));

jest.mock('./swarm-service', () => ({
  getBee: () => mockBee,
  selectBestBatch: mockSelectBestBatch,
  toHex: (value) => value?.toHex?.() || String(value || ''),
}));

const {
  publishChunk,
  readChunk,
  readDataRoot,
  readData,
  dataSizeFromSpan,
  writeSingleOwnerChunk,
  readSingleOwnerChunk,
  getSignerAddress,
  spanToResult,
  isChunkNotFoundError,
} = require('./chunk-service');

const BATCH_ID = 'aa'.repeat(32);
const CAC_REFERENCE = 'bb'.repeat(32);
const SOC_REFERENCE = 'cc'.repeat(32);
const IDENTIFIER = 'dd'.repeat(32);
const SIGNATURE = 'ee'.repeat(65);
const OWNER = '11'.repeat(20);
const PRIVATE_KEY = `0x${OWNER}${'22'.repeat(12)}`;

global.fetch = jest.fn();

function makeCac(payload = 'hello', span = 5n, reference = CAC_REFERENCE) {
  const spanBytes = new MockSpan(span).toUint8Array();
  return {
    data: Buffer.concat([Buffer.from(spanBytes), Buffer.from(payload)]),
    span: new MockSpan(span),
    payload: new MockPayload(payload),
    address: new MockHexValue(reference),
    toSingleOwnerChunk: jest.fn((identifier, signer) => ({
      data: Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(SIGNATURE, 'hex'), Buffer.from(spanBytes), Buffer.from(payload)]),
      span: new MockSpan(span),
      payload: new MockPayload(payload),
      address: new MockHexValue(SOC_REFERENCE),
      owner: signer.publicKey().address(),
      identifier: new MockHexValue(identifier),
      signature: new MockHexValue(SIGNATURE),
    })),
  };
}

function makeSoc(payload = 'hello', span = 5n) {
  return {
    data: Buffer.from(payload),
    span: new MockSpan(span),
    payload: new MockPayload(payload),
    address: new MockHexValue(SOC_REFERENCE),
    owner: new MockOwner(OWNER),
    identifier: new MockHexValue(IDENTIFIER),
    signature: new MockHexValue(SIGNATURE),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectBestBatch.mockResolvedValue(BATCH_ID);
  mockUploadChunk.mockResolvedValue({ reference: new MockHexValue(CAC_REFERENCE) });
  mockCalculateSingleOwnerChunkAddress.mockReturnValue(new MockHexValue(SOC_REFERENCE));
  global.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ reference: SOC_REFERENCE }),
  });
});

describe('chunk-service', () => {
  test('spanToResult returns number for safe spans and bigint for large spans', () => {
    expect(spanToResult(new MockSpan(10n))).toBe(10);
    expect(spanToResult(new MockSpan(BigInt(Number.MAX_SAFE_INTEGER) + 1n)))
      .toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  });

  test('isChunkNotFoundError matches Bee 404s and chunk-read 500s only', () => {
    expect(isChunkNotFoundError(new MockBeeResponseError(404))).toBe(true);
    expect(isChunkNotFoundError(new MockBeeResponseError(500))).toBe(false);
    expect(isChunkNotFoundError(new MockBeeResponseError(
      500,
      'Request failed with status code 500',
      Buffer.from(JSON.stringify({ code: 500, message: 'read chunk failed' }))
    ))).toBe(true);
    expect(isChunkNotFoundError(new MockBeeResponseError(
      500,
      'Request failed with status code 500',
      Buffer.from(JSON.stringify({ code: 500, message: 'node exploded politely' }))
    ))).toBe(false);
    expect(isChunkNotFoundError(new Error('network'))).toBe(false);
  });

  test('getSignerAddress returns the signer owner', () => {
    expect(getSignerAddress(PRIVATE_KEY)).toBe(`0x${OWNER}`);
  });

  test('publishChunk uploads a CAC and returns its address', async () => {
    const cac = makeCac();
    mockMakeContentAddressedChunk.mockReturnValue(cac);

    const result = await publishChunk(Buffer.from('hello'), { span: 5n });

    expect(mockMakeContentAddressedChunk).toHaveBeenCalledWith(Buffer.from('hello'), 5n);
    expect(mockSelectBestBatch).toHaveBeenCalledWith(4096);
    expect(mockUploadChunk).toHaveBeenCalledWith(BATCH_ID, cac, { pin: true, deferred: false });
    expect(result).toEqual({ reference: CAC_REFERENCE, batchIdUsed: BATCH_ID });
  });

  test('publishChunk fails when no batch is available', async () => {
    mockMakeContentAddressedChunk.mockReturnValue(makeCac());
    mockSelectBestBatch.mockResolvedValue(null);

    await expect(publishChunk(Buffer.from('hello'))).rejects.toThrow('No usable postage batch');
  });

  test('readChunk returns base64 payload and span after CAC validation', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalContentAddressedChunk.mockReturnValue(makeCac('hello', 5n, CAC_REFERENCE));

    const result = await readChunk(CAC_REFERENCE);

    expect(mockDownloadChunk).toHaveBeenCalledWith(CAC_REFERENCE);
    expect(result).toEqual({
      data: Buffer.from('hello').toString('base64'),
      encoding: 'base64',
      span: 5,
    });
  });

  test('readChunk maps a mismatched address to chunk_type_mismatch', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalContentAddressedChunk.mockReturnValue(makeCac('hello', 5n, 'ff'.repeat(32)));

    await expect(readChunk(CAC_REFERENCE)).rejects.toMatchObject({
      reason: 'chunk_type_mismatch',
    });
  });

  test('readChunk maps CAC unmarshal failures to chunk_type_mismatch', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalContentAddressedChunk.mockImplementation(() => {
      throw new Error('unmarshal failed');
    });

    await expect(readChunk(CAC_REFERENCE)).rejects.toMatchObject({
      reason: 'chunk_type_mismatch',
    });
  });

  test('readChunk maps Bee 404 to chunk_not_found', async () => {
    mockDownloadChunk.mockRejectedValue(new MockBeeResponseError(404));

    await expect(readChunk(CAC_REFERENCE)).rejects.toMatchObject({
      reason: 'chunk_not_found',
    });
  });

  test('readChunk maps Bee chunk-read 500 to chunk_not_found', async () => {
    mockDownloadChunk.mockRejectedValue(new MockBeeResponseError(
      500,
      'Request failed with status code 500',
      Buffer.from(JSON.stringify({ code: 500, message: 'read chunk failed' }))
    ));

    await expect(readChunk(CAC_REFERENCE)).rejects.toMatchObject({
      reason: 'chunk_not_found',
    });
  });

  describe('blob reads', () => {
    // Bee's redundancy.EncodeLevel: level | 0x80 in the span's last byte.
    const withLevel = (size, level) => BigInt(size) | (BigInt(0x80 | level) << 56n);
    const span = (value) => new MockSpan(value).toUint8Array();

    test('dataSizeFromSpan reads a plain span as is', () => {
      expect(dataSizeFromSpan(span(5n))).toBe(5n);
      expect(dataSizeFromSpan(span(10_000_000n))).toBe(10_000_000n);
    });

    test('dataSizeFromSpan clears an encoded redundancy level', () => {
      for (const level of [1, 2, 3, 4]) {
        expect(dataSizeFromSpan(span(withLevel(1_234_567, level)))).toBe(1_234_567n);
      }
    });

    test('dataSizeFromSpan keeps a top byte that is not a level as size', () => {
      // 0x80 alone is not an encoded level (Bee: IsLevelEncoded is `> 128`).
      expect(dataSizeFromSpan(span(0x80n << 56n))).toBe(0x80n << 56n);
      expect(dataSizeFromSpan(span(1n << 56n))).toBe(1n << 56n);
    });

    test('readDataRoot verifies the root chunk and returns the size from its span', async () => {
      const payload = Buffer.alloc(64, 0x01);
      mockDownloadChunk.mockResolvedValue(Buffer.alloc(8 + 64));
      mockUnmarshalContentAddressedChunk.mockReturnValue(
        makeCac(payload, withLevel(9000, 1), CAC_REFERENCE)
      );

      const root = await readDataRoot(CAC_REFERENCE);

      expect(mockDownloadChunk).toHaveBeenCalledWith(CAC_REFERENCE);
      // chunkBytes is what came off the wire, so the caller can charge it.
      expect(root).toEqual({ size: 9000n, payload, chunkBytes: 72 });
      expect(mockDownloadData).not.toHaveBeenCalled();
    });

    test('readDataRoot maps a missing root to chunk_not_found', async () => {
      mockDownloadChunk.mockRejectedValue(new MockBeeResponseError(404));

      await expect(readDataRoot(CAC_REFERENCE)).rejects.toMatchObject({ reason: 'chunk_not_found' });
    });

    test('readDataRoot refuses a root that does not hash to the reference', async () => {
      mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
      mockUnmarshalContentAddressedChunk.mockReturnValue(makeCac('hello', 5n, 'ff'.repeat(32)));

      await expect(readDataRoot(CAC_REFERENCE)).rejects.toMatchObject({ reason: 'chunk_type_mismatch' });
    });

    test('readData has the node join a multi-chunk blob', async () => {
      const blob = Buffer.alloc(9000, 0x61);
      mockDownloadData.mockResolvedValue(new MockPayload(blob));

      const result = await readData(CAC_REFERENCE, { size: 9000n, payload: Buffer.alloc(96) });

      expect(mockDownloadData).toHaveBeenCalledWith(CAC_REFERENCE);
      expect(result).toEqual({ data: blob.toString('base64'), encoding: 'base64' });
    });

    test('readData returns a single-chunk blob from its verified root without a second request', async () => {
      const result = await readData(CAC_REFERENCE, { size: 5n, payload: Buffer.from('hello') });

      expect(mockDownloadData).not.toHaveBeenCalled();
      expect(result).toEqual({ data: Buffer.from('hello').toString('base64'), encoding: 'base64' });
    });

    test('readData maps a chunk the node cannot find to chunk_not_found', async () => {
      mockDownloadData.mockRejectedValue(new MockBeeResponseError(404));

      await expect(readData(CAC_REFERENCE, { size: 9000n, payload: Buffer.alloc(96) }))
        .rejects.toMatchObject({ reason: 'chunk_not_found' });
    });

    test('readData preserves transient Bee errors', async () => {
      const err = new MockBeeResponseError(503);
      mockDownloadData.mockRejectedValue(err);

      await expect(readData(CAC_REFERENCE, { size: 9000n, payload: Buffer.alloc(96) })).rejects.toBe(err);
    });

    test('readData refuses a join whose length differs from the root span', async () => {
      mockDownloadData.mockResolvedValue(new MockPayload(Buffer.alloc(9001)));

      await expect(readData(CAC_REFERENCE, { size: 9000n, payload: Buffer.alloc(96) }))
        .rejects.toThrow('Node returned 9001 bytes for a 9000-byte blob');
    });
  });

  test('readChunk preserves transient Bee errors', async () => {
    const err = new MockBeeResponseError(
      500,
      'Request failed with status code 500',
      Buffer.from(JSON.stringify({ code: 500, message: 'node unavailable' }))
    );
    mockDownloadChunk.mockRejectedValue(err);

    await expect(readChunk(CAC_REFERENCE)).rejects.toBe(err);
  });

  test('writeSingleOwnerChunk signs and uploads an SOC', async () => {
    const cac = makeCac();
    mockMakeContentAddressedChunk.mockReturnValue(cac);

    const result = await writeSingleOwnerChunk(PRIVATE_KEY, IDENTIFIER, Buffer.from('hello'), { span: 5n });

    expect(mockMakeContentAddressedChunk).toHaveBeenCalledWith(Buffer.from('hello'), 5n);
    expect(cac.toSingleOwnerChunk).toHaveBeenCalledWith(IDENTIFIER, expect.any(MockPrivateKey));
    expect(mockUploadChunk).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = global.fetch.mock.calls[0];
    expect(String(url)).toBe(`http://127.0.0.1:1633/soc/${OWNER}/${IDENTIFIER}?sig=${SIGNATURE}`);
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({
      'content-type': 'application/octet-stream',
      'swarm-postage-batch-id': BATCH_ID,
      'swarm-pin': 'true',
      'swarm-deferred-upload': 'false',
    });
    expect(Buffer.from(request.body)).toEqual(Buffer.concat([
      Buffer.from(new MockSpan(5n).toUint8Array()),
      Buffer.from('hello'),
    ]));
    expect(result).toEqual({
      reference: SOC_REFERENCE,
      owner: `0x${OWNER}`,
      identifier: IDENTIFIER,
      batchIdUsed: BATCH_ID,
    });
  });

  test('writeSingleOwnerChunk rejects mismatched Bee SOC upload references', async () => {
    const cac = makeCac();
    mockMakeContentAddressedChunk.mockReturnValue(cac);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ reference: 'ff'.repeat(32) }),
    });

    await expect(writeSingleOwnerChunk(PRIVATE_KEY, IDENTIFIER, Buffer.from('hello')))
      .rejects.toThrow('SOC upload returned unexpected reference');
  });

  test('writeSingleOwnerChunk reports Bee SOC upload failures', async () => {
    const cac = makeCac();
    mockMakeContentAddressedChunk.mockReturnValue(cac);
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    });

    await expect(writeSingleOwnerChunk(PRIVATE_KEY, IDENTIFIER, Buffer.from('hello')))
      .rejects.toThrow('SOC upload failed (500): boom');
  });

  test('readSingleOwnerChunk supports address reads', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalSingleOwnerChunk.mockReturnValue(makeSoc());

    const result = await readSingleOwnerChunk({ address: SOC_REFERENCE });

    expect(mockDownloadChunk).toHaveBeenCalledWith(SOC_REFERENCE);
    expect(mockUnmarshalSingleOwnerChunk).toHaveBeenCalledWith(Buffer.from('raw'), SOC_REFERENCE);
    expect(result).toEqual(expect.objectContaining({
      data: Buffer.from('hello').toString('base64'),
      encoding: 'base64',
      reference: SOC_REFERENCE,
      owner: `0x${OWNER}`,
      identifier: IDENTIFIER,
      signature: SIGNATURE,
    }));
  });

  test('readSingleOwnerChunk supports owner plus identifier reads', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalSingleOwnerChunk.mockReturnValue(makeSoc());

    const result = await readSingleOwnerChunk({ owner: `0x${OWNER}`, identifier: IDENTIFIER });

    expect(mockCalculateSingleOwnerChunkAddress).toHaveBeenCalledWith(
      expect.any(MockIdentifier),
      expect.any(MockEthAddress)
    );
    expect(mockDownloadChunk).toHaveBeenCalledWith(SOC_REFERENCE);
    expect(result.reference).toBe(SOC_REFERENCE);
  });

  test('readSingleOwnerChunk maps SOC unmarshal failures to chunk_type_mismatch', async () => {
    mockDownloadChunk.mockResolvedValue(Buffer.from('raw'));
    mockUnmarshalSingleOwnerChunk.mockImplementation(() => {
      throw new Error('unmarshal failed');
    });

    await expect(readSingleOwnerChunk({ address: SOC_REFERENCE })).rejects.toMatchObject({
      reason: 'chunk_type_mismatch',
    });
  });

  test('readSingleOwnerChunk maps Bee chunk-read 500 to chunk_not_found', async () => {
    mockDownloadChunk.mockRejectedValue(new MockBeeResponseError(
      500,
      'Request failed with status code 500',
      Buffer.from(JSON.stringify({ code: 500, message: 'read chunk failed' }))
    ));

    await expect(readSingleOwnerChunk({ address: SOC_REFERENCE })).rejects.toMatchObject({
      reason: 'chunk_not_found',
    });
  });

  test('readSingleOwnerChunk preserves transient Bee errors', async () => {
    const err = new MockBeeResponseError(
      500,
      'Request failed with status code 500',
      Buffer.from(JSON.stringify({ code: 500, message: 'node unavailable' }))
    );
    mockDownloadChunk.mockRejectedValue(err);

    await expect(readSingleOwnerChunk({ address: SOC_REFERENCE })).rejects.toBe(err);
  });
});
