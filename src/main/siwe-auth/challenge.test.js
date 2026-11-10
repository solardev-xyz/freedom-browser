const { parseChallenges, findSiweChallenge, bindChallenge } = require('./challenge');

const NOW = Date.parse('2026-11-10T12:00:00Z');

describe('parseChallenges', () => {
  test('reads token and quoted auth-params, lowercasing names', () => {
    expect(parseChallenges('SIWE Realm="club.example", nonce=abc12345, Chain-ID=1')).toEqual([
      { scheme: 'SIWE', params: { realm: 'club.example', nonce: 'abc12345', 'chain-id': '1' } },
    ]);
  });

  test('unescapes quoted-pairs and keeps commas inside quotes', () => {
    const [challenge] = parseChallenges('SIWE statement="Hi, \\"you\\"", nonce=abc12345');
    expect(challenge.params.statement).toBe('Hi, "you"');
    expect(challenge.params.nonce).toBe('abc12345');
  });

  test('splits several challenges in one value', () => {
    const challenges = parseChallenges('Basic realm="x", SIWE nonce=abc12345, chain-id=1, Bearer');
    expect(challenges.map((c) => c.scheme)).toEqual(['Basic', 'SIWE', 'Bearer']);
    expect(challenges[1].params).toEqual({ nonce: 'abc12345', 'chain-id': '1' });
  });

  test('drops a challenge that repeats a parameter', () => {
    expect(parseChallenges('SIWE nonce=abc12345, nonce=zzz99999')).toEqual([]);
  });

  test('steps over a token68 challenge before SIWE', () => {
    const challenges = parseChallenges(
      'Negotiate YIIBhwYGKwYBBQUC==, SIWE nonce=abc12345, chain-id=1'
    );
    expect(challenges).toEqual([
      { scheme: 'Negotiate', params: {}, token68: 'YIIBhwYGKwYBBQUC==' },
      { scheme: 'SIWE', params: { nonce: 'abc12345', 'chain-id': '1' } },
    ]);
    expect(parseChallenges('Bearer abc')[0]).toEqual({
      scheme: 'Bearer',
      params: {},
      token68: 'abc',
    });
  });

  test('drops an unterminated quoted string', () => {
    expect(parseChallenges('SIWE statement="open')).toEqual([]);
  });
});

describe('findSiweChallenge', () => {
  test('finds the SIWE challenge in any header-name case and value', () => {
    const found = findSiweChallenge({
      'WWW-Authenticate': ['Basic realm="old"', 'siwe nonce=abc12345, chain-id=100'],
    });
    expect(found.params).toEqual({ nonce: 'abc12345', 'chain-id': '100' });
  });

  test('returns null without one', () => {
    expect(findSiweChallenge({ 'www-authenticate': ['Basic realm="x"'] })).toBeNull();
    expect(findSiweChallenge({})).toBeNull();
    expect(findSiweChallenge(null)).toBeNull();
  });
});

describe('bindChallenge', () => {
  const base = { nonce: 'abc12345', 'chain-id': '1' };

  test('binds the domain and URI to the page loaded', () => {
    const result = bindChallenge(base, 'https://Club.Example/members?x=1', NOW);
    expect(result).toEqual({
      ok: true,
      challenge: {
        scheme: 'https',
        domain: 'club.example',
        uri: 'https://club.example/members?x=1',
        version: '1',
        chainId: 1,
        nonce: 'abc12345',
        statement: null,
        expirationTime: null,
        notBefore: null,
        requestId: null,
      },
    });
  });

  test('keeps the port in the domain', () => {
    const result = bindChallenge(base, 'http://localhost:8787/members', NOW);
    expect(result.ok).toBe(true);
    expect(result.challenge.domain).toBe('localhost:8787');
    expect(result.challenge.scheme).toBe('http');
  });

  test('takes a same-origin uri and the optional fields', () => {
    const result = bindChallenge(
      {
        ...base,
        realm: 'club.example',
        uri: 'https://club.example/login',
        version: '1',
        statement: 'Sign in to Example Club: terms at https://club.example/tos?v=2 (Ok!)',
        'expiration-time': '2026-11-10T12:05:00Z',
        'not-before': '2026-11-10T11:59:00Z',
        'request-id': 'req-7%2F:@',
      },
      'https://club.example/members',
      NOW
    );
    expect(result.ok).toBe(true);
    expect(result.challenge).toMatchObject({
      uri: 'https://club.example/login',
      statement: 'Sign in to Example Club: terms at https://club.example/tos?v=2 (Ok!)',
      expirationTime: '2026-11-10T12:05:00Z',
      notBefore: '2026-11-10T11:59:00Z',
      requestId: 'req-7%2F:@',
    });
  });

  test.each([
    ['plain http to another host', base, 'http://club.example/', 'insecure_origin'],
    ['a dweb page', base, 'bzz://club.eth/', 'insecure_origin'],
    [
      'a realm naming another host',
      { ...base, realm: 'evil.example' },
      'https://club.example/',
      'realm_mismatch',
    ],
    [
      'a realm without the port',
      { ...base, realm: 'localhost' },
      'http://localhost:8787/',
      'realm_mismatch',
    ],
    [
      'a uri on another origin',
      { ...base, uri: 'https://evil.example/login' },
      'https://club.example/',
      'uri_mismatch',
    ],
    [
      'a uri on another scheme',
      { ...base, uri: 'http://club.example/login' },
      'https://club.example/',
      'uri_mismatch',
    ],
    ['a missing nonce', { 'chain-id': '1' }, 'https://club.example/', 'invalid_nonce'],
    ['a short nonce', { ...base, nonce: 'abc' }, 'https://club.example/', 'invalid_nonce'],
    [
      'a nonce with symbols',
      { ...base, nonce: 'abc12345!' },
      'https://club.example/',
      'invalid_nonce',
    ],
    ['another version', { ...base, version: '2' }, 'https://club.example/', 'unsupported_version'],
    ['a missing chain id', { nonce: 'abc12345' }, 'https://club.example/', 'invalid_chain_id'],
    ['a zero chain id', { ...base, 'chain-id': '0' }, 'https://club.example/', 'invalid_chain_id'],
    [
      'a statement with a newline',
      { ...base, statement: 'a\nURI: x' },
      'https://club.example/',
      'invalid_statement',
    ],
    [
      'a statement with a bidi override',
      { ...base, statement: 'a‮b' },
      'https://club.example/',
      'invalid_statement',
    ],
    [
      'an expired challenge',
      { ...base, 'expiration-time': '2026-11-10T11:00:00Z' },
      'https://club.example/',
      'expired',
    ],
    [
      'a malformed time',
      { ...base, 'expiration-time': 'tomorrow' },
      'https://club.example/',
      'invalid_time',
    ],
    [
      'a statement with a character ERC-4361 leaves out',
      { ...base, statement: 'a | b' },
      'https://club.example/',
      'invalid_statement',
    ],
    [
      'a statement in another script',
      { ...base, statement: 'Войти' },
      'https://club.example/',
      'invalid_statement',
    ],
    [
      'a request id with a newline',
      { ...base, 'request-id': 'a\nb' },
      'https://club.example/',
      'invalid_request_id',
    ],
    [
      'a request id with a space',
      { ...base, 'request-id': 'a b' },
      'https://club.example/',
      'invalid_request_id',
    ],
  ])('refuses %s', (_label, params, url, reason) => {
    expect(bindChallenge(params, url, NOW)).toEqual({ ok: false, reason });
  });
});
