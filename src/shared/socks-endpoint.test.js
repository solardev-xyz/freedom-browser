const { normalizeSocksEndpoint, parseSocksEndpoint } = require('./socks-endpoint');

describe('socks endpoint utilities', () => {
  test('normalizes host:port and socks URLs', () => {
    expect(normalizeSocksEndpoint('127.0.0.1:9150')).toBe('127.0.0.1:9150');
    expect(normalizeSocksEndpoint('socks5://localhost:9150')).toBe('localhost:9150');
    expect(normalizeSocksEndpoint('socks5h://[::1]:9150')).toBe('[::1]:9150');
  });

  test('parses normalized endpoint details', () => {
    expect(parseSocksEndpoint('127.0.0.1:9150')).toEqual({
      host: '127.0.0.1',
      port: 9150,
    });
  });

  test('rejects invalid or non-socks endpoints', () => {
    expect(normalizeSocksEndpoint('')).toBeNull();
    expect(normalizeSocksEndpoint('127.0.0.1')).toBeNull();
    expect(normalizeSocksEndpoint('http://127.0.0.1:9150')).toBeNull();
    expect(normalizeSocksEndpoint('socks5://user:pass@127.0.0.1:9150')).toBeNull();
    expect(normalizeSocksEndpoint('127.0.0.1:70000')).toBeNull();
  });
});
