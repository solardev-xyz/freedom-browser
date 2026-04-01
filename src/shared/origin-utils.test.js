const { getPermissionKey, normalizeOrigin } = require('./origin-utils');

describe('origin-utils', () => {
  describe('getPermissionKey', () => {
    test('bare ENS name with path', () => {
      expect(getPermissionKey('1inch.eth/path')).toBe('1inch.eth');
    });

    test('bare ENS name without path', () => {
      expect(getPermissionKey('vitalik.eth')).toBe('vitalik.eth');
    });

    test('bare ENS with .box TLD', () => {
      expect(getPermissionKey('myapp.box/page')).toBe('myapp.box');
    });

    test('bare ENS mixed case is lowercased', () => {
      expect(getPermissionKey('Vitalik.ETH/blog')).toBe('vitalik.eth');
    });

    test('ens:// protocol', () => {
      expect(getPermissionKey('ens://myapp.eth/#/swap')).toBe('myapp.eth');
    });

    test('ens:// with mixed case', () => {
      expect(getPermissionKey('ens://MyApp.ETH/#/page')).toBe('myapp.eth');
    });

    test('bzz:// with path', () => {
      expect(getPermissionKey('bzz://abc123def/page/index.html')).toBe('bzz://abc123def');
    });

    test('bzz:// without path', () => {
      expect(getPermissionKey('bzz://abc123def')).toBe('bzz://abc123def');
    });

    test('ipfs:// with path', () => {
      expect(getPermissionKey('ipfs://QmABC123/docs/index.html')).toBe('ipfs://QmABC123');
    });

    test('ipns:// with path', () => {
      expect(getPermissionKey('ipns://docs.ipfs.tech/guide')).toBe('ipns://docs.ipfs.tech');
    });

    test('rad:// with path', () => {
      expect(getPermissionKey('rad://z123abc/tree/main')).toBe('rad://z123abc');
    });

    test('https:// URL strips path', () => {
      expect(getPermissionKey('https://app.uniswap.org/swap')).toBe('https://app.uniswap.org');
    });

    test('http:// URL preserves port', () => {
      expect(getPermissionKey('http://localhost:3000/app')).toBe('http://localhost:3000');
    });

    test('https:// URL omits default port', () => {
      expect(getPermissionKey('https://example.com:443/page')).toBe('https://example.com');
    });

    test('null input', () => {
      expect(getPermissionKey(null)).toBeNull();
    });

    test('undefined input', () => {
      expect(getPermissionKey(undefined)).toBeNull();
    });

    test('empty string', () => {
      expect(getPermissionKey('')).toBeNull();
    });

    test('whitespace only', () => {
      expect(getPermissionKey('   ')).toBeNull();
    });

    test('unknown protocol falls through to URL parse', () => {
      expect(getPermissionKey('ftp://example.com/file')).toBe('ftp://example.com');
    });

    test('dweb protocols are lowercased', () => {
      expect(getPermissionKey('IPFS://QmABC/docs')).toBe('ipfs://QmABC');
      expect(getPermissionKey('BZZ://abc123/page')).toBe('bzz://abc123');
    });
  });

  describe('normalizeOrigin', () => {
    test('delegates to getPermissionKey', () => {
      expect(normalizeOrigin('bzz://abc123/path')).toBe('bzz://abc123');
      expect(normalizeOrigin('myapp.eth/blog')).toBe('myapp.eth');
    });

    test('returns empty string for null', () => {
      expect(normalizeOrigin(null)).toBe('');
    });

    test('returns empty string for empty string', () => {
      expect(normalizeOrigin('')).toBe('');
    });
  });
});
