/**
 * swarm_publishSingleOwnerChunk's verification (#647), against real bee-js
 * crypto: a chunk signed outside Freedom (bee-js's own signer, and an
 * Ethereum wallet's `personal_sign` of the 32-byte SOC digest) is uploaded as
 * it was signed; anything that does not recover to the named owner for this
 * identifier and chunk is refused before a batch is chosen.
 */
const { Bee, PrivateKey } = require('@ethersphere/bee-js');
const { Wallet, keccak256, concat, getBytes } = require('ethers');

const mockSelectBestBatch = jest.fn();
jest.mock('./swarm-service', () => {
  const { Bee: RealBee } = jest.requireActual('@ethersphere/bee-js');
  const bee = new RealBee('http://127.0.0.1:1633');
  return {
    getBee: () => bee,
    selectBestBatch: (...args) => mockSelectBestBatch(...args),
    toHex: (value) => (value && typeof value.toHex === 'function' ? value.toHex() : String(value || '')),
  };
});

const { publishSignedSingleOwnerChunk } = require('./chunk-service');

const BATCH = 'aa'.repeat(32);
const KEY = '0x' + '42'.repeat(32);
const IDENTIFIER = '07'.repeat(32);
const bee = new Bee('http://127.0.0.1:1633');

function signWithBeeJs(data, identifier = IDENTIFIER, span) {
  const chunk = bee.makeContentAddressedChunk(data, span);
  const soc = chunk.toSingleOwnerChunk(identifier, new PrivateKey(KEY));
  return {
    owner: soc.owner.toChecksum(),
    identifier,
    signature: soc.signature.toHex(),
    reference: soc.address.toHex(),
  };
}

function signWithWallet(data, identifier = IDENTIFIER) {
  const wallet = new Wallet(KEY);
  const chunk = bee.makeContentAddressedChunk(data);
  const digest = keccak256(concat(['0x' + identifier, chunk.address.toUint8Array()]));
  return {
    owner: wallet.address,
    identifier,
    // EIP-191 personal_sign over the 32 digest bytes: the SOC signature.
    signature: wallet.signMessageSync(getBytes(digest)),
  };
}

function mockUploadOk(reference) {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ reference }) });
}

describe('publishSignedSingleOwnerChunk', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    mockSelectBestBatch.mockReset().mockResolvedValue(BATCH);
  });

  test('uploads a chunk signed by bee-js as signed, to /soc/<owner>/<id>?sig=', async () => {
    const data = Buffer.from('hello swarm');
    const signed = signWithBeeJs(data);
    mockUploadOk(signed.reference);
    const onVerified = jest.fn();

    const result = await publishSignedSingleOwnerChunk({ ...signed, data, onVerified });

    expect(result).toEqual({
      reference: signed.reference,
      owner: signed.owner,
      identifier: IDENTIFIER,
      batchIdUsed: BATCH,
    });
    expect(onVerified).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url.pathname).toBe(`/soc/${signed.owner.slice(2).toLowerCase()}/${IDENTIFIER}`);
    expect(url.searchParams.get('sig')).toBe(signed.signature);
    expect(init.headers['swarm-postage-batch-id']).toBe(BATCH);
    const span = Buffer.alloc(8);
    span.writeBigUInt64LE(BigInt(data.length));
    expect(Buffer.from(init.body)).toEqual(Buffer.concat([span, data]));
  });

  test('accepts an Ethereum personal_sign of the SOC digest, and its address as owner', async () => {
    const data = Buffer.from('from a wallet');
    const signed = signWithWallet(data);
    const expected = signWithBeeJs(data);
    expect(signed.signature.replace(/^0x/, '')).toBe(expected.signature);
    mockUploadOk(expected.reference);

    const result = await publishSignedSingleOwnerChunk({ ...signed, data });

    expect(result.reference).toBe(expected.reference);
    expect(result.owner).toBe(signed.owner);
  });

  test('accepts a lower-case owner without 0x', async () => {
    const data = Buffer.from('x');
    const signed = signWithBeeJs(data);
    mockUploadOk(signed.reference);
    const result = await publishSignedSingleOwnerChunk({
      ...signed,
      owner: signed.owner.slice(2).toLowerCase(),
      data,
    });
    expect(result.reference).toBe(signed.reference);
  });

  const data = Buffer.from('payload');
  test.each([
    ['another owner', (s) => ({ ...s, owner: new Wallet('0x' + '43'.repeat(32)).address })],
    ['another identifier', (s) => ({ ...s, identifier: '08'.repeat(32) })],
    ['other data', (s) => ({ ...s, data: Buffer.from('payloaD') })],
    ['another span', (s) => ({ ...s, span: BigInt(data.length + 1) })],
    ['a flipped signature byte', (s) => ({
      ...s,
      signature: (s.signature[0] === '0' ? '1' : '0') + s.signature.slice(1),
    })],
    ['a recovery byte of 0', (s) => ({ ...s, signature: s.signature.slice(0, 128) + '00' })],
    ['a recovery byte of 29', (s) => ({ ...s, signature: s.signature.slice(0, 128) + '1d' })],
    ['a short signature', (s) => ({ ...s, signature: s.signature.slice(0, 128) })],
  ])('refuses %s before choosing a batch or uploading', async (_label, tamper) => {
    const signed = { ...signWithBeeJs(data), data };
    const onVerified = jest.fn();

    await expect(publishSignedSingleOwnerChunk({ ...tamper(signed), onVerified }))
      .rejects.toMatchObject({ reason: 'invalid_signature' });
    expect(onVerified).not.toHaveBeenCalled();
    expect(mockSelectBestBatch).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a node answering another reference is an error', async () => {
    const signed = signWithBeeJs(data);
    mockUploadOk('ff'.repeat(32));
    await expect(publishSignedSingleOwnerChunk({ ...signed, data }))
      .rejects.toThrow('SOC upload returned unexpected reference');
  });
});
