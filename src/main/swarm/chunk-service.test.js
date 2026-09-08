var mockMakeContentAddressedChunk = jest.fn();
var mockUploadChunk = jest.fn();
var mockDownloadChunk = jest.fn();
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
