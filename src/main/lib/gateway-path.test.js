const {
  decodeDotsAndSeparators,
  hasEncodedSeparator,
  isContainedPath,
  isContainedTarget,
} = require('./gateway-path');

const GW = 'http://node';

// The cases fc-dweb's `validate.rs` tests pin (`decoding_dots_and_separators`),
// so the handlers here and freedom-core's plan validation agree.
describe('decodeDotsAndSeparators', () => {
  test.each([
    ['/a%2Fb%2f%5C%5c%2E%2e', '/a/b/\\\\..'],
    ['/%252F%2', '/%252F%2'],
    ['/%', '/%'],
    ['/%zz%2F', '/%zz/'],
    ['/caf%C3%A9', '/caf%C3%A9'],
  ])('%s → %s', (path, decoded) => {
    expect(decodeDotsAndSeparators(path)).toBe(decoded);
  });
});

describe('hasEncodedSeparator', () => {
  test.each(['/a%2fb', '/a%2Fb', '/a%5cb', '/a%5Cb'])('%s', (path) => {
    expect(hasEncodedSeparator(path)).toBe(true);
  });
  test.each(['/a/b', '/a%252Fb', '/a%2Eb', '/a%20b'])('not %s', (path) => {
    expect(hasEncodedSeparator(path)).toBe(false);
  });
});

describe('isContainedPath', () => {
  test.each([
    '/..%2f..%2fipns/example.com',
    '/..%2F..%2Fapi/v0/id',
    '/%2e%2e%2f%2e%2e%2fapi/v0/id',
    '/a%5c..%5c..',
    '/a/.%2E%2F.%2e/x',
    '/a/%2E%5Cx',
    '/a/..\\..\\api',
    '/a\\b',
    '/a/../b',
    '/./a',
  ])('refuses %s', (path) => {
    expect(isContainedPath(path)).toBe(false);
  });

  test.each([
    '/',
    '/index.html',
    '/a%2Fb',
    '/a%5Cb',
    '/my%20file%2Etxt',
    '/..foo/bar../%2e%2ebaz',
    '/.well-known/x',
    '/caf%C3%A9/100%25',
    '/%252F..%252F',
  ])('passes %s', (path) => {
    expect(isContainedPath(path)).toBe(true);
  });

  test('refuses any encoded separator when told to (bzz:)', () => {
    expect(isContainedPath('/a%2Fb', { encodedSeparators: false })).toBe(false);
    expect(isContainedPath('/a%5cb', { encodedSeparators: false })).toBe(false);
    expect(isContainedPath('/my%20file%2Etxt', { encodedSeparators: false })).toBe(true);
  });

  test('refuses a non-string', () => {
    expect(isContainedPath(undefined)).toBe(false);
  });
});

describe('isContainedTarget', () => {
  test.each([
    `${GW}/ipfs/c`,
    `${GW}/ipfs/c/`,
    `${GW}/ipfs/c/a%2Fb`,
    `${GW}/ipns/docs.ipfs.tech/x?q=..%2f`,
    // Resolved by the URL parser, as the client sends it, and still beneath.
    `${GW}/ipfs/c/a/../b`,
  ])('passes %s', (url) => {
    expect(isContainedTarget(url, ['ipfs', 'ipns'])).toBe(true);
  });

  test.each([
    `${GW}/ipfs/c/a%2F..%2F..`,
    `${GW}/ipfs/c/%2E%5Cx`,
    `${GW}/ipfs/c/..%2f..%2fipns/x`,
    // The parser resolves these out of the root before the check.
    `${GW}/ipfs/c/../../api/v0/id`,
    `${GW}/ipfs/c/a\\..\\..\\..\\api`,
    `${GW}/ipfs/c%2F..`,
    `${GW}/ipfs/%2e%2e`,
    `${GW}/ipfs/`,
    `${GW}/ipfs`,
    `${GW}/api/v0/id`,
    'not a url',
  ])('refuses %s', (url) => {
    expect(isContainedTarget(url, ['ipfs', 'ipns'])).toBe(false);
  });

  test('bzz: no encoded separator anywhere, and only its own namespace', () => {
    const ref = 'a'.repeat(64);
    expect(isContainedTarget(`${GW}/bzz/${ref}/x`, ['bzz'], { encodedSeparators: false })).toBe(
      true
    );
    expect(isContainedTarget(`${GW}/bzz/${ref}/a%2Fb`, ['bzz'], { encodedSeparators: false })).toBe(
      false
    );
    expect(isContainedTarget(`${GW}/bzz/${ref}/a/..\\..\\..\\stamps`, ['bzz'])).toBe(false);
    expect(isContainedTarget(`${GW}/ipfs/${ref}/x`, ['bzz'])).toBe(false);
  });
});
