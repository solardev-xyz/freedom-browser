const {
  shouldRewriteRequest,
  buildRewriteTarget,
  convertProtocolUrl,
  shouldBlockInvalidBzzRequest,
} = require('./request-rewriter');

// Mock service-registry so convertProtocolUrl can resolve gateway URLs
jest.mock('./service-registry', () => ({
  getBeeApiUrl: () => 'http://127.0.0.1:1633',
  getIpfsGatewayUrl: () => 'http://127.0.0.1:8080',
}));

const BASE_URL = 'http://127.0.0.1:1633/bzz/abc123def456/';
const VALID_HASH = 'a'.repeat(64);
const VALID_ENCRYPTED_HASH = 'a'.repeat(128);

describe('request-rewriter', () => {
  describe('convertProtocolUrl', () => {
    test('returns converted: false for null/undefined/empty', () => {
      expect(convertProtocolUrl(null)).toEqual({ converted: false, url: null });
      expect(convertProtocolUrl(undefined)).toEqual({ converted: false, url: undefined });
      expect(convertProtocolUrl('')).toEqual({ converted: false, url: '' });
    });

    test('returns converted: false for non-protocol URLs', () => {
      expect(convertProtocolUrl('https://example.com')).toEqual({
        converted: false,
        url: 'https://example.com',
      });
      expect(convertProtocolUrl('http://127.0.0.1:1633/bzz/hash')).toEqual({
        converted: false,
        url: 'http://127.0.0.1:1633/bzz/hash',
      });
    });

    // bzz:// tests
    test('converts valid bzz:// URL with 64-char hex hash', () => {
      const result = convertProtocolUrl(`bzz://${VALID_HASH}`);
      expect(result).toEqual({ converted: true, url: `http://127.0.0.1:1633/bzz/${VALID_HASH}` });
    });

    test('converts valid bzz:// URL with hash and path', () => {
      const result = convertProtocolUrl(`bzz://${VALID_HASH}/index.html`);
      expect(result).toEqual({
        converted: true,
        url: `http://127.0.0.1:1633/bzz/${VALID_HASH}/index.html`,
      });
    });

    test('converts valid bzz:// URL with hash, path, query and fragment', () => {
      const result = convertProtocolUrl(`bzz://${VALID_HASH}/page?v=1#top`);
      expect(result).toEqual({
        converted: true,
        url: `http://127.0.0.1:1633/bzz/${VALID_HASH}/page?v=1#top`,
      });
    });

    test('rejects bzz:// with empty hash', () => {
      expect(convertProtocolUrl('bzz://')).toEqual({ converted: false, url: 'bzz://' });
    });

    test('rejects bzz:/// with no hash (only slashes)', () => {
      expect(convertProtocolUrl('bzz:///')).toEqual({ converted: false, url: 'bzz:///' });
    });

    test('rejects bzz:///favicon.ico (no hash, just path)', () => {
      expect(convertProtocolUrl('bzz:///favicon.ico')).toEqual({
        converted: false,
        url: 'bzz:///favicon.ico',
      });
    });

    test('rejects bzz:// with non-hex hash', () => {
      expect(convertProtocolUrl('bzz://not-a-valid-hash')).toEqual({
        converted: false,
        url: 'bzz://not-a-valid-hash',
      });
    });

    test('rejects bzz:// with too-short hash', () => {
      expect(convertProtocolUrl('bzz://abcdef1234')).toEqual({
        converted: false,
        url: 'bzz://abcdef1234',
      });
    });

    // ipfs:// tests
    test('converts valid ipfs:// URL with CIDv0', () => {
      const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      const result = convertProtocolUrl(`ipfs://${cid}`);
      expect(result).toEqual({ converted: true, url: `http://127.0.0.1:8080/ipfs/${cid}` });
    });

    test('converts valid ipfs:// URL with path', () => {
      const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      const result = convertProtocolUrl(`ipfs://${cid}/file.txt`);
      expect(result).toEqual({
        converted: true,
        url: `http://127.0.0.1:8080/ipfs/${cid}/file.txt`,
      });
    });

    test('rejects ipfs:// with invalid CID', () => {
      expect(convertProtocolUrl('ipfs://notacid')).toEqual({
        converted: false,
        url: 'ipfs://notacid',
      });
    });

    test('rejects ipfs:// with empty CID', () => {
      expect(convertProtocolUrl('ipfs://')).toEqual({ converted: false, url: 'ipfs://' });
    });

    test('rejects ipfs:/// with no CID', () => {
      expect(convertProtocolUrl('ipfs:///')).toEqual({ converted: false, url: 'ipfs:///' });
    });

    // ipns:// tests
    test('converts valid ipns:// URL', () => {
      const result = convertProtocolUrl('ipns://example.eth');
      expect(result).toEqual({ converted: true, url: 'http://127.0.0.1:8080/ipns/example.eth' });
    });

    test('converts valid ipns:// URL with path', () => {
      const result = convertProtocolUrl('ipns://example.eth/page.html');
      expect(result).toEqual({
        converted: true,
        url: 'http://127.0.0.1:8080/ipns/example.eth/page.html',
      });
    });

    test('rejects ipns:// with empty name', () => {
      expect(convertProtocolUrl('ipns://')).toEqual({ converted: false, url: 'ipns://' });
    });

    test('rejects ipns:/// with no name', () => {
      expect(convertProtocolUrl('ipns:///')).toEqual({ converted: false, url: 'ipns:///' });
    });
  });

  describe('shouldRewriteRequest', () => {
    test('returns false with reason when no base URL provided', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/images/logo.png', null);
      expect(result).toEqual({ shouldRewrite: false, reason: 'no_base_url' });
    });

    test('returns false with reason when base URL is empty', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/images/logo.png', '');
      expect(result).toEqual({ shouldRewrite: false, reason: 'no_base_url' });
    });

    test('returns false with reason for invalid request URL', () => {
      const result = shouldRewriteRequest('not-a-valid-url', BASE_URL);
      expect(result).toEqual({ shouldRewrite: false, reason: 'invalid_url' });
    });

    test('returns false with reason for invalid base URL', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/images/logo.png', 'not-valid');
      expect(result).toEqual({ shouldRewrite: false, reason: 'invalid_url' });
    });

    test('returns false with reason for requests already on /bzz/ path', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/bzz/other-hash/file.js', BASE_URL);
      expect(result).toEqual({ shouldRewrite: false, reason: 'already_bzz_path' });
    });

    test('handles case-insensitive /BZZ/ path', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/BZZ/other-hash/file.js', BASE_URL);
      expect(result).toEqual({ shouldRewrite: false, reason: 'already_bzz_path' });
    });

    test('returns false with reason for cross-origin requests', () => {
      const result = shouldRewriteRequest('https://cdn.example.com/images/logo.png', BASE_URL);
      expect(result).toEqual({ shouldRewrite: false, reason: 'cross_origin' });
    });

    test('returns false for different port (cross-origin)', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:8080/images/logo.png', BASE_URL);
      expect(result).toEqual({ shouldRewrite: false, reason: 'cross_origin' });
    });

    test('returns true for same-origin absolute path requests', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/images/logo.png', BASE_URL);
      expect(result).toEqual({ shouldRewrite: true });
    });

    test('returns true for root path requests', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/', BASE_URL);
      expect(result).toEqual({ shouldRewrite: true });
    });

    test('returns true for requests with query strings', () => {
      const result = shouldRewriteRequest('http://127.0.0.1:1633/api/data?format=json', BASE_URL);
      expect(result).toEqual({ shouldRewrite: true });
    });
  });

  describe('buildRewriteTarget', () => {
    test('rewrites absolute path to bzz hash path', () => {
      const result = buildRewriteTarget('http://127.0.0.1:1633/images/logo.png', BASE_URL);
      expect(result).toBe('http://127.0.0.1:1633/bzz/abc123def456/images/logo.png');
    });

    test('rewrites root path correctly', () => {
      const result = buildRewriteTarget('http://127.0.0.1:1633/', BASE_URL);
      expect(result).toBe('http://127.0.0.1:1633/bzz/abc123def456/');
    });

    test('preserves query strings', () => {
      const result = buildRewriteTarget(
        'http://127.0.0.1:1633/api/data?format=json&page=1',
        BASE_URL
      );
      expect(result).toBe('http://127.0.0.1:1633/bzz/abc123def456/api/data?format=json&page=1');
    });

    test('preserves fragments', () => {
      const result = buildRewriteTarget('http://127.0.0.1:1633/page.html#section', BASE_URL);
      expect(result).toBe('http://127.0.0.1:1633/bzz/abc123def456/page.html#section');
    });

    test('preserves query strings and fragments together', () => {
      const result = buildRewriteTarget('http://127.0.0.1:1633/page.html?v=1#top', BASE_URL);
      expect(result).toBe('http://127.0.0.1:1633/bzz/abc123def456/page.html?v=1#top');
    });

    test('handles deeply nested paths', () => {
      const result = buildRewriteTarget(
        'http://127.0.0.1:1633/assets/js/vendor/lodash.min.js',
        BASE_URL
      );
      expect(result).toBe('http://127.0.0.1:1633/bzz/abc123def456/assets/js/vendor/lodash.min.js');
    });

    test('returns null for invalid request URL', () => {
      const result = buildRewriteTarget('not-a-url', BASE_URL);
      expect(result).toBeNull();
    });

    test('returns null for invalid base URL', () => {
      const result = buildRewriteTarget('http://127.0.0.1:1633/images/logo.png', 'not-a-url');
      expect(result).toBeNull();
    });

    test('handles base URL without trailing slash', () => {
      const baseWithoutSlash = 'http://127.0.0.1:1633/bzz/abc123def456';
      const result = buildRewriteTarget('http://127.0.0.1:1633/images/logo.png', baseWithoutSlash);
      // URL parsing normalizes this
      expect(result).toBe('http://127.0.0.1:1633/bzz/abc123def456images/logo.png');
    });
  });

  describe('shouldBlockInvalidBzzRequest', () => {
    test('blocks /bzz/ with no hash', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/bzz/')).toBe(true);
    });

    test('blocks /bzz with no hash', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/bzz')).toBe(true);
    });

    test('blocks /bzz/ with short hash', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/bzz/abcdef1234')).toBe(true);
    });

    test('blocks /bzz/ with non-hex hash', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/bzz/not-a-valid-hash')).toBe(true);
    });

    test('blocks /bzz/ with path but no valid hash (e.g. favicon.ico)', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/bzz/favicon.ico')).toBe(true);
    });

    test('allows /bzz/ with valid 64-char hex hash', () => {
      expect(shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${VALID_HASH}`)).toBe(false);
    });

    test('allows /bzz/ with valid hash and sub-path', () => {
      expect(
        shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${VALID_HASH}/index.html`)
      ).toBe(false);
    });

    test('allows /bzz/ with valid hash, path, query and fragment', () => {
      expect(
        shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${VALID_HASH}/page?v=1#top`)
      ).toBe(false);
    });

    test('allows /bzz/ with valid 128-char hex hash (encrypted reference)', () => {
      expect(shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${VALID_ENCRYPTED_HASH}`)).toBe(
        false
      );
    });

    test('allows /bzz/ with valid encrypted hash and sub-path', () => {
      expect(
        shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${VALID_ENCRYPTED_HASH}/index.html`)
      ).toBe(false);
    });

    test('blocks /bzz/ with invalid length hash (65 chars)', () => {
      expect(shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${'a'.repeat(65)}`)).toBe(true);
    });

    test('allows non-bzz URLs', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/api/status')).toBe(false);
      expect(shouldBlockInvalidBzzRequest('https://example.com/page')).toBe(false);
    });

    test('allows non-bzz URLs on the same origin', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/bytes/abcdef')).toBe(false);
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/chunks/abcdef')).toBe(false);
    });
  });
});
