const { buildSiweMessage, authorizationValue } = require('./message');

describe('buildSiweMessage', () => {
  const fields = {
    scheme: 'https',
    domain: 'example.com',
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    statement: 'I accept the ExampleOrg Terms of Service: https://example.com/tos',
    uri: 'https://example.com/login',
    version: '1',
    chainId: 1,
    nonce: '32891756',
    issuedAt: '2021-09-30T16:25:24Z',
  };

  test('lays the message out as ERC-4361 does, with an EIP-55 address', () => {
    expect(buildSiweMessage(fields)).toBe(
      [
        'example.com wants you to sign in with your Ethereum account:',
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        '',
        'I accept the ExampleOrg Terms of Service: https://example.com/tos',
        '',
        'URI: https://example.com/login',
        'Version: 1',
        'Chain ID: 1',
        'Nonce: 32891756',
        'Issued At: 2021-09-30T16:25:24Z',
      ].join('\n')
    );
  });

  test('leaves two blank lines without a statement', () => {
    expect(buildSiweMessage({ ...fields, statement: null })).toContain(
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2\n\n\nURI: https://example.com/login'
    );
  });

  test('prefixes a non-https scheme and appends the optional fields in order', () => {
    const message = buildSiweMessage({
      ...fields,
      scheme: 'http',
      domain: 'localhost:8787',
      expirationTime: '2021-09-30T16:30:24Z',
      notBefore: '2021-09-30T16:20:24Z',
      requestId: 'req-7',
    });
    expect(message.startsWith('http://localhost:8787 wants you to sign in')).toBe(true);
    expect(
      message.endsWith(
        [
          'Issued At: 2021-09-30T16:25:24Z',
          'Expiration Time: 2021-09-30T16:30:24Z',
          'Not Before: 2021-09-30T16:20:24Z',
          'Request ID: req-7',
        ].join('\n')
      )
    ).toBe(true);
  });
});

describe('authorizationValue', () => {
  test('carries the message and signature as base64url JSON', () => {
    const value = authorizationValue('hello\nworld', '0xabc');
    const match = value.match(/^SIWE result="([A-Za-z0-9_-]+)"$/);
    expect(match).not.toBeNull();
    expect(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))).toEqual({
      message: 'hello\nworld',
      signature: '0xabc',
    });
  });
});
