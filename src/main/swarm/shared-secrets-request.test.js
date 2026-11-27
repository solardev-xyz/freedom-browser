const { SigningKey } = require('ethers');
const {
  validateSharedSecretsRequest,
  MAX_SHARED_SECRET_KEYS,
} = require('./shared-secrets-request');

const PEER = SigningKey.computePublicKey(`0x${'22'.repeat(32)}`, true);
const PEER_UNCOMPRESSED = SigningKey.computePublicKey(`0x${'22'.repeat(32)}`, false);
// x = 2^256 - 1 is above the field prime: well-formed hex, no such point.
const OFF_CURVE = `02${'ff'.repeat(32)}`;

describe('validateSharedSecretsRequest', () => {
  test('accepts compressed and uncompressed keys, with or without 0x, in canonical form', () => {
    expect(
      validateSharedSecretsRequest({
        publicKeys: [PEER, PEER.slice(2).toUpperCase(), PEER_UNCOMPRESSED],
      })
    ).toEqual({ ok: true, value: { publicKeys: [PEER, PEER, PEER_UNCOMPRESSED] } });
  });

  test('accepts exactly the cap', () => {
    const result = validateSharedSecretsRequest({
      publicKeys: new Array(MAX_SHARED_SECRET_KEYS).fill(PEER),
    });
    expect(result.ok).toBe(true);
    expect(MAX_SHARED_SECRET_KEYS).toBe(256);
  });

  test.each([
    ['no params', undefined, 'invalid_params', {}],
    ['a string for publicKeys', { publicKeys: 'x' }, 'invalid_public_key', {}],
    ['an empty list', { publicKeys: [] }, 'invalid_public_key', {}],
    [
      'one key over the cap',
      { publicKeys: new Array(257).fill(PEER) },
      'payload_too_large',
      { limit: 256, actual: 257 },
    ],
    [
      'a thousand keys',
      { publicKeys: new Array(1000).fill(PEER) },
      'payload_too_large',
      { limit: 256, actual: 1000 },
    ],
    ['a short key', { publicKeys: [PEER, '02'] }, 'invalid_public_key', { index: 1 }],
    ['a non-string key', { publicKeys: [7] }, 'invalid_public_key', { index: 0 }],
    ['an off-curve key', { publicKeys: [PEER, OFF_CURVE] }, 'invalid_public_key', { index: 1 }],
    [
      'an unknown option',
      { publicKeys: [PEER], options: { x: 1 } },
      'unsupported_option',
      { option: 'x' },
    ],
    ['options that are not an object', { publicKeys: [PEER], options: [] }, 'invalid_params', {}],
  ])('refuses %s', (_label, params, reason, data) => {
    const result = validateSharedSecretsRequest(params);
    expect(result).toMatchObject({ ok: false, reason, data });
    expect(typeof result.message).toBe('string');
  });
});
