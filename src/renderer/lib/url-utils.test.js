import {
  ensureTrailingSlash,
  composeTargetUrl,
  deriveBzzBaseFromUrl,
  parseHashInput,
  formatBzzUrl,
  deriveDisplayValue,
  isValidCid,
  parseIpfsInput,
  deriveIpfsBaseFromUrl,
  formatIpfsUrl,
  applyEnsNamePreservation,
  isValidRadicleId,
  parseRadicleInput,
  deriveRadicleDisplayValue,
} from './url-utils.js';

const BZZ_ROUTE_PREFIX = 'http://127.0.0.1:1633/bzz/';
const IPFS_ROUTE_PREFIX = 'http://127.0.0.1:8080/ipfs/';
const IPNS_ROUTE_PREFIX = 'http://127.0.0.1:8080/ipns/';
const HOME_URL = 'file:///app/home.html';

describe('url-utils', () => {
  describe('ensureTrailingSlash', () => {
    test('adds slash if missing', () => {
      expect(ensureTrailingSlash('http://example.com')).toBe('http://example.com/');
    });

    test('keeps slash if present', () => {
      expect(ensureTrailingSlash('http://example.com/')).toBe('http://example.com/');
    });

    test('handles empty input', () => {
      expect(ensureTrailingSlash('')).toBe('/');
    });

    test('handles undefined input', () => {
      expect(ensureTrailingSlash(undefined)).toBe('/');
    });
  });

  describe('parseHashInput', () => {
    test('returns null for empty input after removing scheme', () => {
      expect(parseHashInput('bzz://', BZZ_ROUTE_PREFIX)).toBeNull();
      expect(parseHashInput('', BZZ_ROUTE_PREFIX)).toBeNull();
    });

    test('parses hash with fragment', () => {
      const result = parseHashInput('abc123#section', BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        hash: 'abc123',
        tail: '#section',
        baseUrl: 'http://127.0.0.1:1633/bzz/abc123/',
        displayValue: 'bzz://abc123#section',
      });
    });

    test('parses hash with query string', () => {
      const result = parseHashInput('abc123?foo=bar', BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        hash: 'abc123',
        tail: '?foo=bar',
        baseUrl: 'http://127.0.0.1:1633/bzz/abc123/',
        displayValue: 'bzz://abc123?foo=bar',
      });
    });

    test('parses hash with path, query and fragment', () => {
      const result = parseHashInput('abc123/page.html?v=1#top', BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        hash: 'abc123',
        tail: '/page.html?v=1#top',
        baseUrl: 'http://127.0.0.1:1633/bzz/abc123/',
        displayValue: 'bzz://abc123/page.html?v=1#top',
      });
    });

    test('returns null when hash becomes empty', () => {
      // Edge case: empty string after processing gives null
      expect(parseHashInput('bzz:///', BZZ_ROUTE_PREFIX)).toBeNull();
    });

    test('strips leading slashes', () => {
      const result = parseHashInput('///abc123', BZZ_ROUTE_PREFIX);
      expect(result.hash).toBe('abc123');
    });
  });

  describe('composeTargetUrl', () => {
    test('joins base and suffix correctly', () => {
      const base = 'http://127.0.0.1:1633/bzz/hash/';
      const suffix = 'path/to/file.html';
      expect(composeTargetUrl(base, suffix)).toBe(
        'http://127.0.0.1:1633/bzz/hash/path/to/file.html'
      );
    });

    test('handles suffix with leading slash', () => {
      const base = 'http://127.0.0.1:1633/bzz/hash/';
      const suffix = '/path/to/file.html';
      // In our app context, we want to append to the base even if it starts with /
      expect(composeTargetUrl(base, suffix)).toBe(
        'http://127.0.0.1:1633/bzz/hash/path/to/file.html'
      );
    });

    test('handles empty suffix', () => {
      const base = 'http://127.0.0.1:1633/bzz/hash/';
      expect(composeTargetUrl(base, '')).toBe('http://127.0.0.1:1633/bzz/hash/');
      expect(composeTargetUrl(base)).toBe('http://127.0.0.1:1633/bzz/hash/');
    });

    test('falls back to concatenation for invalid base URL', () => {
      const base = 'not-a-valid-url';
      const suffix = 'path/file.html';
      expect(composeTargetUrl(base, suffix)).toBe('not-a-valid-urlpath/file.html');
    });
  });

  describe('deriveBzzBaseFromUrl', () => {
    test('extracts base from valid bzz url', () => {
      const url = 'http://127.0.0.1:1633/bzz/1234567890abcdef/path/index.html';
      expect(deriveBzzBaseFromUrl(url)).toBe('http://127.0.0.1:1633/bzz/1234567890abcdef/');
    });

    test('returns null for non-bzz url', () => {
      const url = 'http://example.com/foo/bar';
      expect(deriveBzzBaseFromUrl(url)).toBeNull();
    });

    test('returns null for invalid url', () => {
      expect(deriveBzzBaseFromUrl('not-a-url')).toBeNull();
    });

    test('returns null for null/undefined/empty input', () => {
      expect(deriveBzzBaseFromUrl(null)).toBeNull();
      expect(deriveBzzBaseFromUrl(undefined)).toBeNull();
      expect(deriveBzzBaseFromUrl('')).toBeNull();
    });

    test('accepts URL object as input', () => {
      const url = new URL('http://127.0.0.1:1633/bzz/abc123/index.html');
      expect(deriveBzzBaseFromUrl(url)).toBe('http://127.0.0.1:1633/bzz/abc123/');
    });

    test('handles case-insensitive bzz path', () => {
      const url = 'http://127.0.0.1:1633/BZZ/abc123/file.html';
      expect(deriveBzzBaseFromUrl(url)).toBe('http://127.0.0.1:1633/bzz/abc123/');
    });

    test('returns null for bzz path without hash', () => {
      const url = 'http://127.0.0.1:1633/bzz/';
      expect(deriveBzzBaseFromUrl(url)).toBeNull();
    });
  });

  describe('formatBzzUrl', () => {
    test('formats explicit bzz:// protocol with hash only', () => {
      const input = 'bzz://1234567890abcdef';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: 'http://127.0.0.1:1633/bzz/1234567890abcdef/',
        displayValue: 'bzz://1234567890abcdef',
        baseUrl: 'http://127.0.0.1:1633/bzz/1234567890abcdef/',
      });
    });

    test('formats explicit bzz:// protocol with path', () => {
      const input = 'bzz://1234567890abcdef/index.html';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: 'http://127.0.0.1:1633/bzz/1234567890abcdef/index.html',
        displayValue: 'bzz://1234567890abcdef/index.html',
        baseUrl: 'http://127.0.0.1:1633/bzz/1234567890abcdef/',
      });
    });

    test('formats raw 64-char hex hash as bzz://', () => {
      // Valid Swarm hashes are 64 hex characters
      const input = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl:
          'http://127.0.0.1:1633/bzz/1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef/',
        displayValue: 'bzz://1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        baseUrl:
          'http://127.0.0.1:1633/bzz/1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef/',
      });
    });

    test('formats raw 128-char hex hash as bzz://', () => {
      const input =
        '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: `http://127.0.0.1:1633/bzz/${input}/`,
        displayValue: `bzz://${input}`,
        baseUrl: `http://127.0.0.1:1633/bzz/${input}/`,
      });
    });

    test('returns null for short hex string (not valid Swarm hash)', () => {
      // Short hex strings should not be treated as Swarm hashes
      const input = '1234567890abcdef';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toBeNull();
    });

    test('converts domain without protocol to https://', () => {
      const input = 'spiegel.de';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: 'https://spiegel.de',
        displayValue: 'https://spiegel.de',
        baseUrl: null,
      });
    });

    test('converts domain with path to https://', () => {
      const input = 'example.com/path/to/page';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: 'https://example.com/path/to/page',
        displayValue: 'https://example.com/path/to/page',
        baseUrl: null,
      });
    });

    test('passthrough for normal http urls', () => {
      const input = 'https://google.com';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: 'https://google.com/',
        displayValue: 'https://google.com/',
        baseUrl: null,
      });
    });

    test('returns null for empty/whitespace input', () => {
      expect(formatBzzUrl('', BZZ_ROUTE_PREFIX)).toBeNull();
      expect(formatBzzUrl('   ', BZZ_ROUTE_PREFIX)).toBeNull();
      expect(formatBzzUrl(null, BZZ_ROUTE_PREFIX)).toBeNull();
      expect(formatBzzUrl(undefined, BZZ_ROUTE_PREFIX)).toBeNull();
    });

    test('returns null for invalid bzz:// URL without hash', () => {
      expect(formatBzzUrl('bzz://', BZZ_ROUTE_PREFIX)).toBeNull();
    });

    test('returns null for unparseable non-URL input that also fails hash parsing', () => {
      // Input that's not a valid URL and parseHashInput returns null (empty after processing)
      expect(formatBzzUrl('///', BZZ_ROUTE_PREFIX)).toBeNull();
    });

    test('formats bzz:// with query and fragment', () => {
      const input = 'bzz://abc123/page.html?foo=bar#section';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result.displayValue).toBe('bzz://abc123/page.html?foo=bar#section');
      expect(result.baseUrl).toBe('http://127.0.0.1:1633/bzz/abc123/');
    });

    test('handles gateway URL input', () => {
      const input = 'http://127.0.0.1:1633/bzz/abc123/index.html';
      const result = formatBzzUrl(input, BZZ_ROUTE_PREFIX);
      expect(result.targetUrl).toBe('http://127.0.0.1:1633/bzz/abc123/index.html');
      expect(result.displayValue).toBe('bzz://abc123/index.html');
      expect(result.baseUrl).toBe('http://127.0.0.1:1633/bzz/abc123/');
    });
  });

  describe('deriveDisplayValue', () => {
    test('converts http bzz gateway url to bzz://', () => {
      const url = 'http://127.0.0.1:1633/bzz/1234567890abcdef/index.html';
      expect(deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL)).toBe(
        'bzz://1234567890abcdef/index.html'
      );
    });

    test('returns empty string for home url', () => {
      expect(deriveDisplayValue(HOME_URL, BZZ_ROUTE_PREFIX, HOME_URL)).toBe('');
    });

    test('returns empty string for about:blank', () => {
      expect(deriveDisplayValue('about:blank', BZZ_ROUTE_PREFIX, HOME_URL)).toBe('');
    });

    test('returns original url for non-bzz sites', () => {
      const url = 'https://google.com';
      expect(deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL)).toBe(url);
    });

    test('returns empty string for null/undefined/empty input', () => {
      expect(deriveDisplayValue(null, BZZ_ROUTE_PREFIX, HOME_URL)).toBe('');
      expect(deriveDisplayValue(undefined, BZZ_ROUTE_PREFIX, HOME_URL)).toBe('');
      expect(deriveDisplayValue('', BZZ_ROUTE_PREFIX, HOME_URL)).toBe('');
    });

    test('strips trailing slashes from bzz display value', () => {
      const url = 'http://127.0.0.1:1633/bzz/abc123/';
      expect(deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL)).toBe('bzz://abc123');
    });

    test('returns empty string for bzz prefix with only trailing slashes', () => {
      const url = 'http://127.0.0.1:1633/bzz/';
      expect(deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL)).toBe('');
    });

    test('handles URL-encoded characters in bzz path', () => {
      const url = 'http://127.0.0.1:1633/bzz/abc123/path%20with%20spaces.html';
      expect(deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL)).toBe(
        'bzz://abc123/path with spaces.html'
      );
    });

    test('handles malformed URL encoding gracefully', () => {
      // %ZZ is not valid URL encoding, should fall back to raw string
      const url = 'http://127.0.0.1:1633/bzz/abc123/bad%ZZencoding';
      expect(deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL)).toBe(
        'bzz://abc123/bad%ZZencoding'
      );
    });

    test('converts ipfs gateway url to ipfs://', () => {
      const url =
        'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme';
      expect(
        deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL, IPFS_ROUTE_PREFIX, IPNS_ROUTE_PREFIX)
      ).toBe('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme');
    });

    test('converts ipns gateway url to ipns://', () => {
      const url = 'http://127.0.0.1:8080/ipns/docs.ipfs.tech/index.html';
      expect(
        deriveDisplayValue(url, BZZ_ROUTE_PREFIX, HOME_URL, IPFS_ROUTE_PREFIX, IPNS_ROUTE_PREFIX)
      ).toBe('ipns://docs.ipfs.tech/index.html');
    });
  });

  // ============ IPFS Tests ============

  describe('isValidCid', () => {
    test('validates CIDv0 (Qm...)', () => {
      expect(isValidCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
      expect(isValidCid('QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX')).toBe(true);
    });

    test('validates CIDv1 base32 (bafy...)', () => {
      expect(isValidCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true);
      expect(isValidCid('bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4')).toBe(true);
    });

    test('rejects invalid CIDs', () => {
      expect(isValidCid('')).toBe(false);
      expect(isValidCid(null)).toBe(false);
      expect(isValidCid(undefined)).toBe(false);
      expect(isValidCid('abc123')).toBe(false);
      expect(isValidCid('Qm')).toBe(false); // Too short
      expect(isValidCid('QmInvalidCharacters!@#$')).toBe(false);
    });

    test('rejects Swarm hashes (64 hex chars)', () => {
      expect(isValidCid('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')).toBe(
        false
      );
    });
  });

  describe('parseIpfsInput', () => {
    test('parses raw CID', () => {
      const result = parseIpfsInput(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        IPFS_ROUTE_PREFIX
      );
      expect(result).toEqual({
        cid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        tail: '',
        baseUrl: 'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/',
        protocol: 'ipfs',
        displayValue: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      });
    });

    test('parses CID with path', () => {
      const result = parseIpfsInput(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme',
        IPFS_ROUTE_PREFIX
      );
      expect(result.cid).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
      expect(result.tail).toBe('/readme');
      expect(result.displayValue).toBe(
        'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme'
      );
    });

    test('parses ipfs:// scheme', () => {
      const result = parseIpfsInput(
        'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/path',
        IPFS_ROUTE_PREFIX
      );
      expect(result.cid).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
      expect(result.tail).toBe('/path');
      expect(result.protocol).toBe('ipfs');
    });

    test('parses ipns:// scheme', () => {
      const result = parseIpfsInput('ipns://docs.ipfs.tech/index.html', IPFS_ROUTE_PREFIX);
      expect(result.cid).toBe('docs.ipfs.tech');
      expect(result.tail).toBe('/index.html');
      expect(result.protocol).toBe('ipns');
      expect(result.baseUrl).toBe('http://127.0.0.1:8080/ipns/docs.ipfs.tech/');
    });

    test('parses CID with query and fragment', () => {
      const result = parseIpfsInput(
        'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/page?v=1#section',
        IPFS_ROUTE_PREFIX
      );
      expect(result.tail).toBe('/page?v=1#section');
    });

    test('returns null for empty input', () => {
      expect(parseIpfsInput('', IPFS_ROUTE_PREFIX)).toBeNull();
      expect(parseIpfsInput('ipfs://', IPFS_ROUTE_PREFIX)).toBeNull();
    });
  });

  describe('deriveIpfsBaseFromUrl', () => {
    test('extracts base from ipfs gateway url', () => {
      const url =
        'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme';
      expect(deriveIpfsBaseFromUrl(url)).toBe(
        'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/'
      );
    });

    test('extracts base from ipns gateway url', () => {
      const url = 'http://127.0.0.1:8080/ipns/docs.ipfs.tech/install/index.html';
      expect(deriveIpfsBaseFromUrl(url)).toBe('http://127.0.0.1:8080/ipns/docs.ipfs.tech/');
    });

    test('returns null for non-ipfs url', () => {
      expect(deriveIpfsBaseFromUrl('http://example.com/foo/bar')).toBeNull();
    });

    test('returns null for invalid input', () => {
      expect(deriveIpfsBaseFromUrl(null)).toBeNull();
      expect(deriveIpfsBaseFromUrl('')).toBeNull();
      expect(deriveIpfsBaseFromUrl('not-a-url')).toBeNull();
    });

    test('accepts URL object', () => {
      const url = new URL('http://127.0.0.1:8080/ipfs/QmTest/file.html');
      expect(deriveIpfsBaseFromUrl(url)).toBe('http://127.0.0.1:8080/ipfs/QmTest/');
    });
  });

  describe('formatIpfsUrl', () => {
    test('formats ipfs:// protocol', () => {
      const input = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: 'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/',
        displayValue: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        baseUrl: 'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/',
        protocol: 'ipfs',
      });
    });

    test('formats ipfs:// with path', () => {
      const input = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe(
        'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme'
      );
      expect(result.displayValue).toBe(
        'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme'
      );
    });

    test('formats ipns:// protocol', () => {
      const input = 'ipns://docs.ipfs.tech';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe('http://127.0.0.1:8080/ipns/docs.ipfs.tech/');
      expect(result.displayValue).toBe('ipns://docs.ipfs.tech');
      expect(result.protocol).toBe('ipns');
    });

    test('formats raw CIDv0', () => {
      const input = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe(
        'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/'
      );
      expect(result.displayValue).toBe('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG');
    });

    test('formats raw CIDv1', () => {
      const input = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe(
        'http://127.0.0.1:8080/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/'
      );
      expect(result.displayValue).toBe(
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      );
    });

    test('returns null for empty input', () => {
      expect(formatIpfsUrl('', IPFS_ROUTE_PREFIX)).toBeNull();
      expect(formatIpfsUrl(null, IPFS_ROUTE_PREFIX)).toBeNull();
    });

    test('returns null for non-IPFS input', () => {
      expect(formatIpfsUrl('https://google.com', IPFS_ROUTE_PREFIX)).toBeNull();
      expect(formatIpfsUrl('random-text', IPFS_ROUTE_PREFIX)).toBeNull();
    });

    test('handles gateway URL input', () => {
      const input =
        'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/readme';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe(input);
      expect(result.baseUrl).toBe(
        'http://127.0.0.1:8080/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/'
      );
    });
  });

  // ============ ENS Name Preservation Tests ============
  // These tests verify that back/forward navigation correctly preserves ENS names
  // when the underlying URL is a hash-based protocol (bzz/ipfs/ipns)

  describe('applyEnsNamePreservation', () => {
    describe('with empty or null inputs', () => {
      test('returns original URL when knownEnsNames is null', () => {
        expect(applyEnsNamePreservation('bzz://abc123', null)).toBe('bzz://abc123');
      });

      test('returns original URL when knownEnsNames is empty', () => {
        expect(applyEnsNamePreservation('bzz://abc123', new Map())).toBe('bzz://abc123');
      });

      test('returns null/empty input unchanged', () => {
        const ensNames = new Map([['abc123', 'example.eth']]);
        expect(applyEnsNamePreservation(null, ensNames)).toBe(null);
        expect(applyEnsNamePreservation('', ensNames)).toBe('');
        expect(applyEnsNamePreservation(undefined, ensNames)).toBe(undefined);
      });
    });

    describe('Swarm (bzz://) ENS preservation', () => {
      test('preserves ENS name for known Swarm hash', () => {
        const hash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        const ensNames = new Map([[hash, 'mydapp.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}`, ensNames);
        expect(result).toBe('ens://mydapp.eth');
      });

      test('preserves ENS name with path for Swarm', () => {
        const hash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        const ensNames = new Map([[hash, 'mydapp.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}/page.html`, ensNames);
        expect(result).toBe('ens://mydapp.eth/page.html');
      });

      test('preserves ENS name with path, query and fragment for Swarm', () => {
        const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
        const ensNames = new Map([[hash, 'app.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}/path?foo=bar#section`, ensNames);
        expect(result).toBe('ens://app.eth/path?foo=bar#section');
      });

      test('handles case-insensitive Swarm hash lookup', () => {
        const hashLower = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
        const hashUpper = 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890';
        const ensNames = new Map([[hashLower, 'mysite.eth']]);

        // Hash with uppercase should match lowercase key (hash is lowercased in lookup)
        const result = applyEnsNamePreservation(`bzz://${hashUpper}`, ensNames);
        expect(result).toBe('ens://mysite.eth');
      });

      test('returns original URL for unknown Swarm hash', () => {
        const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const ensNames = new Map([['differenthash', 'known.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}`, ensNames);
        expect(result).toBe(`bzz://${hash}`);
      });
    });

    describe('IPFS ENS preservation', () => {
      test('preserves ENS name for known IPFS CID', () => {
        const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
        const ensNames = new Map([[cid, 'ipfsdapp.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}`, ensNames);
        expect(result).toBe('ens://ipfsdapp.eth');
      });

      test('preserves ENS name with path for IPFS', () => {
        const cid = 'QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX';
        const ensNames = new Map([[cid, 'myipfs.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}/docs/index.html`, ensNames);
        expect(result).toBe('ens://myipfs.eth/docs/index.html');
      });

      test('preserves ENS name for CIDv1', () => {
        const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
        const ensNames = new Map([[cid, 'modern.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}/app`, ensNames);
        expect(result).toBe('ens://modern.eth/app');
      });

      test('returns original URL for unknown IPFS CID', () => {
        const cid = 'QmUnknownCidThatDoesNotExistInOurMap12345678901';
        const ensNames = new Map([['QmDifferentCid', 'other.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}`, ensNames);
        expect(result).toBe(`ipfs://${cid}`);
      });
    });

    describe('IPNS ENS preservation', () => {
      test('preserves ENS name for known IPNS name', () => {
        const ipnsId = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3lg7ekjjnof1ock2yxz7p8q1qf2v9o';
        const ensNames = new Map([[ipnsId, 'dynamic.eth']]);

        const result = applyEnsNamePreservation(`ipns://${ipnsId}`, ensNames);
        expect(result).toBe('ens://dynamic.eth');
      });

      test('preserves ENS name with path for IPNS', () => {
        const ipnsId = 'docs.ipfs.tech';
        const ensNames = new Map([[ipnsId, 'ipfsdocs.eth']]);

        const result = applyEnsNamePreservation(`ipns://${ipnsId}/install/`, ensNames);
        expect(result).toBe('ens://ipfsdocs.eth/install/');
      });

      test('returns original URL for unknown IPNS name', () => {
        const ipnsId = 'unknown.domain.tech';
        const ensNames = new Map([['other.domain', 'known.eth']]);

        const result = applyEnsNamePreservation(`ipns://${ipnsId}`, ensNames);
        expect(result).toBe(`ipns://${ipnsId}`);
      });
    });

    describe('non-ENS URLs pass through unchanged', () => {
      test('HTTPS URLs are unchanged', () => {
        const ensNames = new Map([['somehash', 'example.eth']]);
        expect(applyEnsNamePreservation('https://example.com', ensNames)).toBe(
          'https://example.com'
        );
      });

      test('HTTP URLs are unchanged', () => {
        const ensNames = new Map([['somehash', 'example.eth']]);
        expect(applyEnsNamePreservation('http://localhost:3000', ensNames)).toBe(
          'http://localhost:3000'
        );
      });

      test('freedom:// URLs are unchanged', () => {
        const ensNames = new Map([['somehash', 'example.eth']]);
        expect(applyEnsNamePreservation('freedom://settings', ensNames)).toBe('freedom://settings');
      });

      test('already ENS URLs are unchanged', () => {
        const ensNames = new Map([['somehash', 'example.eth']]);
        expect(applyEnsNamePreservation('ens://existing.eth/path', ensNames)).toBe(
          'ens://existing.eth/path'
        );
      });
    });

    describe('back/forward navigation scenario', () => {
      // This simulates the actual use case: user navigates to ENS name -> hash stored,
      // then navigates elsewhere, then goes back -> should show ENS name again

      test('simulates full navigation cycle with Swarm', () => {
        const hash = 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';
        const ensName = 'coolsite.eth';

        // Step 1: User navigates to coolsite.eth which resolves to bzz://hash
        // The system stores: knownEnsNames.set(hash, 'coolsite.eth')
        const knownEnsNames = new Map([[hash, ensName]]);

        // Step 2: User navigates to another page
        // (knownEnsNames still has the mapping)

        // Step 3: User clicks back - browser navigates to bzz://hash
        // The system should convert this back to ens://coolsite.eth
        const displayUrl = `bzz://${hash}/subpage`;
        const result = applyEnsNamePreservation(displayUrl, knownEnsNames);

        expect(result).toBe('ens://coolsite.eth/subpage');
      });

      test('simulates full navigation cycle with IPFS', () => {
        const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
        const ensName = 'ipfsapp.eth';

        const knownEnsNames = new Map([[cid, ensName]]);

        // User goes back to ipfs://CID/page
        const displayUrl = `ipfs://${cid}/page`;
        const result = applyEnsNamePreservation(displayUrl, knownEnsNames);

        expect(result).toBe('ens://ipfsapp.eth/page');
      });

      test('simulates navigation to same hash via direct URL (should show hash, not ENS)', () => {
        // If user directly navigates to bzz://hash (not via ENS), the hash should NOT
        // be in knownEnsNames, so it should display as hash
        const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
        const knownEnsNames = new Map(); // Empty - direct navigation doesn't add mapping

        const displayUrl = `bzz://${hash}`;
        const result = applyEnsNamePreservation(displayUrl, knownEnsNames);

        expect(result).toBe(`bzz://${hash}`);
      });
    });
  });

  // =========================================
  // Radicle utilities
  // =========================================
  describe('isValidRadicleId', () => {
    test('accepts valid Radicle ID', () => {
      expect(isValidRadicleId('z3gqcJUoA1n9HaHKufZs5FCSGazv5')).toBe(true);
    });

    test('accepts various valid RID lengths', () => {
      // 21 chars minimum (z + 20 base58)
      expect(isValidRadicleId('z' + 'a'.repeat(20))).toBe(true);
      expect(isValidRadicleId('z' + 'A'.repeat(40))).toBe(true);
    });

    test('rejects empty/null/undefined', () => {
      expect(isValidRadicleId('')).toBe(false);
      expect(isValidRadicleId(null)).toBe(false);
      expect(isValidRadicleId(undefined)).toBe(false);
    });

    test('rejects IDs not starting with z', () => {
      expect(isValidRadicleId('a3gqcJUoA1n9HaHKufZs5FCSGazv5')).toBe(false);
    });

    test('rejects IDs with invalid base58 chars (0, O, I, l)', () => {
      expect(isValidRadicleId('z0000000000000000000000')).toBe(false);
      expect(isValidRadicleId('zOOOOOOOOOOOOOOOOOOOOO')).toBe(false);
      expect(isValidRadicleId('zIIIIIIIIIIIIIIIIIIIII')).toBe(false);
      expect(isValidRadicleId('zllllllllllllllllllllll')).toBe(false);
    });

    test('rejects too-short IDs', () => {
      expect(isValidRadicleId('z' + 'a'.repeat(5))).toBe(false);
    });
  });

  describe('parseRadicleInput', () => {
    const RAD_PREFIX = 'http://127.0.0.1:8780/api/v1/repos/';
    const SAMPLE_RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';

    test('parses rad:RID', () => {
      const result = parseRadicleInput(`rad:${SAMPLE_RID}`, RAD_PREFIX);
      expect(result).not.toBeNull();
      expect(result.rid).toBe(SAMPLE_RID);
      expect(result.tail).toBe('');
      expect(result.baseUrl).toBe(`${RAD_PREFIX}${SAMPLE_RID}/`);
    });

    test('parses rad://RID', () => {
      const result = parseRadicleInput(`rad://${SAMPLE_RID}`, RAD_PREFIX);
      expect(result).not.toBeNull();
      expect(result.rid).toBe(SAMPLE_RID);
    });

    test('parses rad://RID with path', () => {
      const result = parseRadicleInput(`rad://${SAMPLE_RID}/tree/main`, RAD_PREFIX);
      expect(result).not.toBeNull();
      expect(result.rid).toBe(SAMPLE_RID);
      expect(result.tail).toBe('/tree/main');
    });

    test('parses rad://RID with query and fragment', () => {
      const result = parseRadicleInput(`rad://${SAMPLE_RID}/tree/main?tab=files#readme`, RAD_PREFIX);
      expect(result).not.toBeNull();
      expect(result.rid).toBe(SAMPLE_RID);
      expect(result.tail).toBe('/tree/main?tab=files#readme');
    });

    test('returns null for empty input after stripping scheme', () => {
      expect(parseRadicleInput('rad://', RAD_PREFIX)).toBeNull();
      expect(parseRadicleInput('rad:', RAD_PREFIX)).toBeNull();
    });
  });

  describe('deriveRadicleDisplayValue', () => {
    const RAD_PREFIX = 'http://127.0.0.1:8780/api/v1/repos/';
    const SAMPLE_RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';

    test('converts API URL to rad:// display', () => {
      const result = deriveRadicleDisplayValue(
        `${RAD_PREFIX}${SAMPLE_RID}/tree/main`,
        RAD_PREFIX
      );
      expect(result).toBe(`rad://${SAMPLE_RID}/tree/main`);
    });

    test('converts API URL without path to rad:// display', () => {
      const result = deriveRadicleDisplayValue(
        `${RAD_PREFIX}${SAMPLE_RID}/`,
        RAD_PREFIX
      );
      expect(result).toBe(`rad://${SAMPLE_RID}`);
    });

    test('returns original URL if not matching prefix', () => {
      const url = 'https://example.com/page';
      expect(deriveRadicleDisplayValue(url, RAD_PREFIX)).toBe(url);
    });

    test('returns input for null/undefined', () => {
      expect(deriveRadicleDisplayValue(null, RAD_PREFIX)).toBe(null);
      expect(deriveRadicleDisplayValue(undefined, RAD_PREFIX)).toBe(undefined);
    });
  });
});
