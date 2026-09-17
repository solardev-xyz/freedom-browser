const { normalizeHttpEndpoint } = require('./http-endpoint');

describe('normalizeHttpEndpoint', () => {
  test('accepts bare host:port and canonicalizes to an http origin', () => {
    expect(normalizeHttpEndpoint('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeHttpEndpoint('  127.0.0.1:1633  ')).toBe('http://127.0.0.1:1633');
  });

  test('strips trailing slashes, query and fragment but keeps a path prefix', () => {
    expect(normalizeHttpEndpoint('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(normalizeHttpEndpoint('https://gw.example.test/gateway/?a=1#b')).toBe(
      'https://gw.example.test/gateway'
    );
  });

  test('rejects non-http(s) schemes and empty values', () => {
    expect(normalizeHttpEndpoint('ftp://example.test')).toBeNull();
    expect(normalizeHttpEndpoint('file:///etc/passwd')).toBeNull();
    expect(normalizeHttpEndpoint('   ')).toBeNull();
    expect(normalizeHttpEndpoint(null)).toBeNull();
    expect(normalizeHttpEndpoint(undefined)).toBeNull();
  });

  test('rejects userinfo, which undici refuses to build a Request from', () => {
    // Keeping these would store an endpoint that fails every probe and request
    // with a misleading "unreachable" instead of a validation error.
    expect(normalizeHttpEndpoint('http://user:pass@127.0.0.1:8080')).toBeNull();
    expect(normalizeHttpEndpoint('http://user@127.0.0.1:8080')).toBeNull();
    expect(normalizeHttpEndpoint('https://:pass@gw.example.test')).toBeNull();
    // A bare host:port shape with userinfo is normalized to http:// first, so
    // the check has to survive the scheme being added here.
    expect(normalizeHttpEndpoint('user:pass@127.0.0.1:8080')).toBeNull();
  });
});
