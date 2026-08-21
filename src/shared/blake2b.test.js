const { blake2b } = require('./blake2b');

describe('blake2b', () => {
  test('matches the RFC 7693 abc vector', () => {
    expect(Buffer.from(blake2b(Buffer.from('abc'), 64)).toString('hex')).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d' +
        '17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
    );
  });

  // Exercises the multi-block compression loop (inputs > 128 bytes).
  // Expected digest generated with OpenSSL's blake2b512 via node:crypto.
  test('matches OpenSSL for a 300-byte multi-block input', () => {
    const input = Uint8Array.from({ length: 300 }, (_unused, index) => index % 251);
    expect(Buffer.from(blake2b(input, 64)).toString('hex')).toBe(
      '3a482b7748b0bdc43c3d00c080890c10e57a9aa5618f78b86067eb7eaae4942a' +
        'cd96d827accbc16958364ae5b0df6105bbd3b15445092eba1137b5f69c1070f1'
    );
  });

  // Exact block-boundary input (128 bytes): the whole message is a single
  // final block, a classic off-by-one spot in blake2 implementations.
  test('matches OpenSSL for a 128-byte single-full-block input', () => {
    const input = Uint8Array.from({ length: 128 }, (_unused, index) => index);
    expect(Buffer.from(blake2b(input, 64)).toString('hex')).toBe(
      '2319e3789c47e2daa5fe807f61bec2a1a6537fa03f19ff32e87eecbfd64b7e0e' +
        '8ccff439ac333b040f19b0c4ddd11a61e24ac1fe0f10a039806c5dcc0da3d115'
    );
  });
});
