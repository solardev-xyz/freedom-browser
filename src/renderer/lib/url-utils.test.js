import {
  ensureTrailingSlash,
  composeTargetUrl,
  deriveBzzBaseFromUrl,
  parseHashInput,
  formatBzzUrl,
  looksLikeBzzInput,
  deriveDisplayValue,
  isValidCid,
  parseIpfsInput,
  deriveIpfsBaseFromUrl,
  formatIpfsUrl,
  applyEnsNamePreservation,
  buildEnsDisplayUri,
  isEnsBackedDisplay,
  normalizeLegacyEnsBookmarkUrl,
  isValidRadicleId,
  parseRadicleInput,
  formatRadicleUrl,
  deriveRadBaseFromUrl,
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

    test('returns null when the bzz route prefix is not ready', () => {
      expect(parseHashInput('bzz://abc123', null)).toBeNull();
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

  describe('looksLikeBzzInput', () => {
    const HASH = 'a'.repeat(64);

    test('detects bzz:// and bzz: scheme inputs', () => {
      expect(looksLikeBzzInput(`bzz://${HASH}`)).toBe(true);
      expect(looksLikeBzzInput(`bzz://${HASH}/index.html`)).toBe(true);
      expect(looksLikeBzzInput(`bzz:${HASH}`)).toBe(true);
      expect(looksLikeBzzInput('  BZZ://name.eth  ')).toBe(true);
    });

    test('detects bare Swarm hashes (with or without a path)', () => {
      expect(looksLikeBzzInput(HASH)).toBe(true);
      expect(looksLikeBzzInput(`${HASH}/page.html`)).toBe(true);
      expect(looksLikeBzzInput('a'.repeat(128))).toBe(true);
    });

    test('rejects non-Swarm inputs', () => {
      expect(looksLikeBzzInput('')).toBe(false);
      expect(looksLikeBzzInput(null)).toBe(false);
      expect(looksLikeBzzInput('example.com')).toBe(false);
      expect(looksLikeBzzInput('ipfs://QmTest')).toBe(false);
      expect(looksLikeBzzInput('https://example.com')).toBe(false);
      expect(looksLikeBzzInput('a'.repeat(63))).toBe(false);
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

    test('defaults bare .onion hosts to http:// (most are http-only)', () => {
      expect(formatBzzUrl('abcdefghijklmnop.onion', BZZ_ROUTE_PREFIX)).toEqual({
        targetUrl: 'http://abcdefghijklmnop.onion',
        displayValue: 'http://abcdefghijklmnop.onion',
        baseUrl: null,
      });
      // …and with a path
      expect(formatBzzUrl('abcdefghijklmnop.onion/wiki', BZZ_ROUTE_PREFIX)).toEqual({
        targetUrl: 'http://abcdefghijklmnop.onion/wiki',
        displayValue: 'http://abcdefghijklmnop.onion/wiki',
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

    // The Kubo subdomain-gateway form (`<cid>.ipfs.localhost`,
    // `<key>.ipns.localhost`, including inline-DNSLink dash encoding) is no
    // longer recognised by `deriveDisplayValue`. Chromium never sees those
    // URLs since `ipfs:`/`ipns:` are standard schemes and the protocol
    // handler in `src/main/ipfs/ipfs-protocol.js` follows Kubo's redirect
    // internally — so the display-recovery branch had no live caller.
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

    test('validates CIDv1 base32 with non-baf codec prefixes (bag.../bafz...)', () => {
      // dag-json → `bagu…`. Cross-checked with `multiformats`:
      // `CID.createV1(0x0129, sha256.digest('hello world')).toString()`.
      // Earlier `^baf...` regex false-rejected these; the relaxed
      // `^ba...` form covers all CIDv1 base32 codec prefixes.
      expect(
        isValidCid('baguqeeraxfgspomtju7arjjokll5u7nl7lcij37dpjjyb3uqrd32zyxpzxuq')
      ).toBe(true);
      // libp2p-key codec via base32: `bafzbei…` is also `baf` so still
      // works, but `bafk2bzace…` (blake2b-256 multihash) is a real
      // shape too. Cross-checked with `multiformats`:
      // `CID.createV1(0x55, blake2b256.digest(bytes)).toString()`.
      expect(
        isValidCid('bafk2bzacec4u2j5zsngt4cfffzjnpwt5vp5mjbhp4n5fhahoscepplhc57g6s')
      ).toBe(true);
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
    // Canonical CIDv1 base32 corresponding to the CIDv0 below — kept inline so
    // the assertions are obviously self-consistent. Cross-checked with
    // multiformats: CID.parse(CIDV0).toV1().toString().
    const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const CIDV1 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';

    test('returns null when the IPFS route prefix is not ready', () => {
      expect(parseIpfsInput(CIDV0, null)).toBeNull();
    });

    test('canonicalises raw CIDv0 to CIDv1 base32', () => {
      const result = parseIpfsInput(CIDV0, IPFS_ROUTE_PREFIX);
      expect(result).toEqual({
        cid: CIDV1,
        tail: '',
        baseUrl: `http://127.0.0.1:8080/ipfs/${CIDV1}/`,
        protocol: 'ipfs',
        displayValue: `ipfs://${CIDV1}`,
      });
    });

    test('passes CIDv1 base32 through unchanged', () => {
      const result = parseIpfsInput(CIDV1, IPFS_ROUTE_PREFIX);
      expect(result.cid).toBe(CIDV1);
      expect(result.displayValue).toBe(`ipfs://${CIDV1}`);
    });

    test('canonicalises CIDv0 with path', () => {
      const result = parseIpfsInput(`${CIDV0}/readme`, IPFS_ROUTE_PREFIX);
      expect(result.cid).toBe(CIDV1);
      expect(result.tail).toBe('/readme');
      expect(result.displayValue).toBe(`ipfs://${CIDV1}/readme`);
    });

    test('canonicalises CIDv0 carried over from ipfs:// scheme input', () => {
      const result = parseIpfsInput(`ipfs://${CIDV0}/path`, IPFS_ROUTE_PREFIX);
      expect(result.cid).toBe(CIDV1);
      expect(result.tail).toBe('/path');
      expect(result.protocol).toBe('ipfs');
    });

    test('parses ipns:// scheme with DNSLink name (preserved as-is)', () => {
      const result = parseIpfsInput('ipns://docs.ipfs.tech/index.html', IPFS_ROUTE_PREFIX);
      expect(result.cid).toBe('docs.ipfs.tech');
      expect(result.tail).toBe('/index.html');
      expect(result.protocol).toBe('ipns');
      expect(result.baseUrl).toBe('http://127.0.0.1:8080/ipns/docs.ipfs.tech/');
    });

    test('canonicalises base58 IPNS peer IDs to libp2p-key base36', () => {
      // Ed25519 peer ID — the canonical CIDv1 libp2p-key form is lowercase
      // base36, which round-trips through the standard-scheme URL parser
      // without being mangled by hostname lowercasing.
      const peerId = '12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX';
      const expected = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
      const result = parseIpfsInput(`ipns://${peerId}/foo`, IPFS_ROUTE_PREFIX);
      expect(result.cid).toBe(expected);
      expect(result.displayValue).toBe(`ipns://${expected}/foo`);
    });

    test('canonicalises CIDv0 with query and fragment intact', () => {
      const result = parseIpfsInput(`${CIDV0}/page?v=1#section`, IPFS_ROUTE_PREFIX);
      expect(result.cid).toBe(CIDV1);
      expect(result.tail).toBe('/page?v=1#section');
    });

    test('returns null for empty input', () => {
      expect(parseIpfsInput('', IPFS_ROUTE_PREFIX)).toBeNull();
      expect(parseIpfsInput('ipfs://', IPFS_ROUTE_PREFIX)).toBeNull();
    });

    describe('gateway-form rewrite', () => {
      // Kubo's directory listings emit links like
      //   <a href="//localhost:8080/ipfs/<cid>">CID</a>
      // which Chromium resolves against the page origin `ipfs://<cid>/` to
      //   ipfs://localhost/ipfs/<cid>
      // (port stripped because Chromium doesn't treat 8080 as default for
      // `ipfs:`). Without rewriting, the protocol handler would try to
      // load CID `localhost` from Kubo and 400. The fix: when host is
      // *not* a real reference and path starts with /ipfs|/ipns, take
      // the embedded ref as the actual content.

      test('rewrites ipfs://localhost/ipfs/<cidv1> to ipfs://<cidv1>', () => {
        const result = parseIpfsInput(
          `ipfs://localhost/ipfs/${CIDV1}/sub/page.html`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(CIDV1);
        expect(result.tail).toBe('/sub/page.html');
        expect(result.protocol).toBe('ipfs');
        expect(result.displayValue).toBe(`ipfs://${CIDV1}/sub/page.html`);
      });

      test('rewrites ipfs://<gateway>/ipfs/<cidv0> AND canonicalises to base32', () => {
        const result = parseIpfsInput(
          `ipfs://127.0.0.1/ipfs/${CIDV0}/readme`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(CIDV1);
        expect(result.tail).toBe('/readme');
      });

      test.each([
        ['dweb.link', 'dweb.link'],
        ['ipfs.io', 'ipfs.io'],
        ['cf-ipfs.com', 'cf-ipfs.com'],
        ['gateway.pinata.cloud', 'gateway.pinata.cloud'],
      ])(
        'rewrites ipfs://<%s>/ipfs/<cid> public-gateway URLs to canonical ipfs://<cid>',
        (_label, gatewayHost) => {
          const result = parseIpfsInput(
            `ipfs://${gatewayHost}/ipfs/${CIDV1}/img.png`,
            IPFS_ROUTE_PREFIX
          );
          expect(result.cid).toBe(CIDV1);
          expect(result.tail).toBe('/img.png');
          expect(result.protocol).toBe('ipfs');
          expect(result.displayValue).toBe(`ipfs://${CIDV1}/img.png`);
        }
      );

      test('rewrites cross-namespace ipfs://localhost/ipns/<key> to ipns://<key>', () => {
        const ipnsKey = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
        const result = parseIpfsInput(
          `ipfs://localhost/ipns/${ipnsKey}/install`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(ipnsKey);
        expect(result.protocol).toBe('ipns');
        expect(result.tail).toBe('/install');
        expect(result.baseUrl).toBe(`http://127.0.0.1:8080/ipns/${ipnsKey}/`);
      });

      test('preserves host when host IS a valid CID (legitimate /ipfs/ subdir)', () => {
        // `ipfs://<cid>/ipfs/<sub>` could be a real subdirectory named
        // `ipfs`. Don't silently redirect — load from the host CID.
        const result = parseIpfsInput(
          `ipfs://${CIDV1}/ipfs/somefile.txt`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(CIDV1);
        expect(result.tail).toBe('/ipfs/somefile.txt');
      });

      test('preserves host when host is a base58 IPNS peer ID', () => {
        const peerId = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
        const result = parseIpfsInput(
          `ipns://${peerId}/ipfs/somefile`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(peerId);
        expect(result.tail).toBe('/ipfs/somefile');
        expect(result.protocol).toBe('ipns');
      });

      test('preserves host when outer host is a DNSLink target (not a known gateway)', () => {
        // `docs.ipfs.tech` isn't in the gateway allowlist — it's a
        // DNSLink content host that genuinely serves a `/ipfs/coverage`
        // path. Rewrites must not fire here even though the embedded
        // `coverage` is a non-CID-shaped string. See the matching gate
        // in `isKnownGatewayHost`.
        const result = parseIpfsInput(
          'ipns://docs.ipfs.tech/ipfs/coverage',
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe('docs.ipfs.tech');
        expect(result.tail).toBe('/ipfs/coverage');
      });

      test('rewrites ipfs://dweb.link/ipns/<dnslink-name>/path to ipns://<dnslink-name>/path', () => {
        // P3 from the round-3 review: with the outer host being a
        // recognised public gateway, the `/ipns/<dnslink-name>` shape
        // is unambiguously the gateway-form for a DNSLink target.
        const result = parseIpfsInput(
          'ipfs://dweb.link/ipns/docs.ipfs.tech/install',
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe('docs.ipfs.tech');
        expect(result.protocol).toBe('ipns');
        expect(result.tail).toBe('/install');
        expect(result.displayValue).toBe('ipns://docs.ipfs.tech/install');
      });

      test('rewrites ipfs://localhost:<port>/ipfs/<cidv1> (port stripped before gateway check)', () => {
        // P2 from the round-4 review: Kubo's directory listings emit
        // `<a href="//localhost:8080/ipfs/<cid>">` which Chromium
        // resolves against the page's `ipfs://` origin to
        // `ipfs://localhost:8080/ipfs/<cid>` (port preserved because
        // `ipfs:` doesn't have a default port). Without port stripping
        // before the allowlist check, the embedded CID never gets
        // hoisted out and the address bar permanently shows the
        // gateway-origin form. parseIpfsInput is byte-level on purpose
        // (preserves base58btc case), so a dedicated `stripPort` does
        // the work `new URL().hostname` would do for `new URL`-friendly
        // inputs.
        const result = parseIpfsInput(
          `ipfs://localhost:8080/ipfs/${CIDV1}/img.png`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(CIDV1);
        expect(result.tail).toBe('/img.png');
        expect(result.protocol).toBe('ipfs');
        expect(result.displayValue).toBe(`ipfs://${CIDV1}/img.png`);
      });

      test('rewrites ipfs://localhost:<port>/ipns/<key> (port stripped, cross-namespace)', () => {
        const ipnsKey = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
        const result = parseIpfsInput(
          `ipfs://localhost:8080/ipns/${ipnsKey}/install`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(ipnsKey);
        expect(result.protocol).toBe('ipns');
        expect(result.tail).toBe('/install');
      });

      test('rewrites ipfs://127.0.0.1:<port>/ipfs/<cidv1> (loopback IP with port)', () => {
        const result = parseIpfsInput(
          `ipfs://127.0.0.1:8080/ipfs/${CIDV1}/page`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(CIDV1);
        expect(result.tail).toBe('/page');
      });

      test('does NOT rewrite for unknown self-hosted gateways', () => {
        // Conservative allowlist — a private gateway hostname can't be
        // distinguished from a DNSLink content host by URL shape alone.
        // Authors of self-hosted gateways can publish canonical
        // `ipfs://<cid>/...` URLs directly. This test pins that the
        // gate isn't reverted to the over-permissive
        // "any-non-content-host" heuristic.
        const result = parseIpfsInput(
          `ipfs://my-gateway.example/ipfs/${CIDV1}/page`,
          IPFS_ROUTE_PREFIX
        );
        // The outer host stays as the (invalid) "cid", which the main-
        // process protocol handler then 400s when Kubo rejects it.
        expect(result.cid).toBe('my-gateway.example');
      });
    });

    describe('CIDv1 base58btc (z…) canonicalisation', () => {
      // `z…` CIDs use base58btc encoding which, like CIDv0, is case-
      // sensitive. Convert to base32 (lowercase) so Chromium's standard-
      // scheme URL parser doesn't corrupt the bytes during host
      // normalisation.
      const Z_CID_DAGPB = 'zdj7Wm8AnNCTyaUbqz1afY6jSGdNi2DKwowmcwMFvbz3vL2Ce';
      const Z_CID_DAGPB_AS_B32 =
        'bafybeihjgbfpb6h5y66ampe35j6wrvogbykwbpfqnyittz42v46btbt2r4';

      test('canonicalises z… (base58btc) to base32 lowercase', () => {
        const result = parseIpfsInput(`ipfs://${Z_CID_DAGPB}/img.png`, IPFS_ROUTE_PREFIX);
        expect(result.cid).toBe(Z_CID_DAGPB_AS_B32);
        expect(result.tail).toBe('/img.png');
        expect(result.displayValue).toBe(`ipfs://${Z_CID_DAGPB_AS_B32}/img.png`);
      });

      test('canonicalises z… inside gateway-form path too', () => {
        const result = parseIpfsInput(
          `ipfs://localhost/ipfs/${Z_CID_DAGPB}/file`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(Z_CID_DAGPB_AS_B32);
        expect(result.tail).toBe('/file');
      });

      test('lowercased z… is not silently re-encoded (caller surfaces 400)', () => {
        // The renderer-side canonicaliser returns null for already-
        // lowercased input rather than producing wrong content. The cid
        // stays as the lowercased form; the main-process handler then
        // 400s with an actionable message.
        const result = parseIpfsInput(
          `ipfs://${Z_CID_DAGPB.toLowerCase()}/img.png`,
          IPFS_ROUTE_PREFIX
        );
        expect(result.cid).toBe(Z_CID_DAGPB.toLowerCase());
      });
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

    test('returns null for the legacy Kubo subdomain-gateway form', () => {
      // Chromium no longer encounters `<cid>.ipfs.localhost` URLs because
      // the ipfs protocol handler follows Kubo's redirect internally.
      expect(
        deriveIpfsBaseFromUrl(
          'http://bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm.ipfs.localhost:8080/readme'
        )
      ).toBeNull();
      expect(deriveIpfsBaseFromUrl('http://k51qzi5uqu5dlvj.ipns.localhost:8080/install')).toBeNull();
    });
  });

  describe('formatIpfsUrl', () => {
    const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const CIDV1 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';

    test('formats ipfs:// protocol — CIDv0 input is canonicalised to CIDv1 base32', () => {
      // Regression: when `ipfs:` is registered as a standard scheme,
      // `new URL('ipfs://Qm.../')` lowercases the host and destroys the
      // base58btc-encoded bytes, so Kubo returns
      //   `400 invalid cid: selected encoding not supported`.
      // formatIpfsUrl must therefore avoid `new URL` for the ipfs:/ipns:
      // branches and canonicalise CIDv0 -> CIDv1 base32 before handing
      // the URL to Chromium.
      const result = formatIpfsUrl(`ipfs://${CIDV0}`, IPFS_ROUTE_PREFIX);
      expect(result).toEqual({
        targetUrl: `http://127.0.0.1:8080/ipfs/${CIDV1}/`,
        displayValue: `ipfs://${CIDV1}`,
        baseUrl: `http://127.0.0.1:8080/ipfs/${CIDV1}/`,
        protocol: 'ipfs',
      });
    });

    test('formats ipfs:// with path — CIDv0 host canonicalised, path preserved', () => {
      const result = formatIpfsUrl(`ipfs://${CIDV0}/frontend/index.html`, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe(
        `http://127.0.0.1:8080/ipfs/${CIDV1}/frontend/index.html`
      );
      expect(result.displayValue).toBe(`ipfs://${CIDV1}/frontend/index.html`);
    });

    test('formats ipns:// DNSLink name (preserved verbatim)', () => {
      const input = 'ipns://docs.ipfs.tech';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe('http://127.0.0.1:8080/ipns/docs.ipfs.tech/');
      expect(result.displayValue).toBe('ipns://docs.ipfs.tech');
      expect(result.protocol).toBe('ipns');
    });

    test('formats ipns:// ENS name (preserved verbatim — resolver lives in main proc)', () => {
      const result = formatIpfsUrl('ipns://vitalik.eth/blog', IPFS_ROUTE_PREFIX);
      expect(result.displayValue).toBe('ipns://vitalik.eth/blog');
      expect(result.protocol).toBe('ipns');
    });

    test('formats ipns:// base58 peer ID — canonicalised to libp2p-key base36', () => {
      const peerId = '12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX';
      const base36 = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
      const result = formatIpfsUrl(`ipns://${peerId}/`, IPFS_ROUTE_PREFIX);
      expect(result.displayValue).toBe(`ipns://${base36}/`);
      expect(result.targetUrl).toBe(`http://127.0.0.1:8080/ipns/${base36}/`);
      expect(result.protocol).toBe('ipns');
    });

    test('formats raw CIDv0 (no scheme) — also canonicalised', () => {
      const result = formatIpfsUrl(CIDV0, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe(`http://127.0.0.1:8080/ipfs/${CIDV1}/`);
      expect(result.displayValue).toBe(`ipfs://${CIDV1}`);
    });

    test('formats raw CIDv1 base32 — passed through unchanged', () => {
      const input = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      const result = formatIpfsUrl(input, IPFS_ROUTE_PREFIX);
      expect(result.targetUrl).toBe(`http://127.0.0.1:8080/ipfs/${input}/`);
      expect(result.displayValue).toBe(`ipfs://${input}`);
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
      test('substitutes ENS name into bzz:// host for known Swarm hash', () => {
        const hash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        const ensNames = new Map([[hash, 'mydapp.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}`, ensNames);
        expect(result).toBe('bzz://mydapp.eth');
      });

      test('preserves transport scheme + path for Swarm', () => {
        const hash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        const ensNames = new Map([[hash, 'mydapp.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}/page.html`, ensNames);
        expect(result).toBe('bzz://mydapp.eth/page.html');
      });

      test('preserves transport scheme + path/query/fragment for Swarm', () => {
        const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
        const ensNames = new Map([[hash, 'app.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}/path?foo=bar#section`, ensNames);
        expect(result).toBe('bzz://app.eth/path?foo=bar#section');
      });

      test('handles case-insensitive Swarm hash lookup', () => {
        const hashLower = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
        const hashUpper = 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890';
        const ensNames = new Map([[hashLower, 'mysite.eth']]);

        // Hash with uppercase should match lowercase key (hash is lowercased in lookup)
        const result = applyEnsNamePreservation(`bzz://${hashUpper}`, ensNames);
        expect(result).toBe('bzz://mysite.eth');
      });

      test('returns original URL for unknown Swarm hash', () => {
        const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const ensNames = new Map([['differenthash', 'known.eth']]);

        const result = applyEnsNamePreservation(`bzz://${hash}`, ensNames);
        expect(result).toBe(`bzz://${hash}`);
      });
    });

    describe('IPFS ENS preservation', () => {
      test('substitutes ENS name into ipfs:// host for known IPFS CID', () => {
        const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
        const ensNames = new Map([[cid, 'ipfsdapp.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}`, ensNames);
        expect(result).toBe('ipfs://ipfsdapp.eth');
      });

      test('preserves transport scheme + path for IPFS', () => {
        const cid = 'QmT5NvUtoM5nWFfrQdVrFtvGfKFmG7AHE8P34isapyhCxX';
        const ensNames = new Map([[cid, 'myipfs.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}/docs/index.html`, ensNames);
        expect(result).toBe('ipfs://myipfs.eth/docs/index.html');
      });

      test('preserves transport scheme for CIDv1', () => {
        const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
        const ensNames = new Map([[cid, 'modern.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}/app`, ensNames);
        expect(result).toBe('ipfs://modern.eth/app');
      });

      test('returns original URL for unknown IPFS CID', () => {
        const cid = 'QmUnknownCidThatDoesNotExistInOurMap12345678901';
        const ensNames = new Map([['QmDifferentCid', 'other.eth']]);

        const result = applyEnsNamePreservation(`ipfs://${cid}`, ensNames);
        expect(result).toBe(`ipfs://${cid}`);
      });
    });

    describe('IPNS ENS preservation', () => {
      test('substitutes ENS name into ipns:// host for known IPNS name', () => {
        const ipnsId = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3lg7ekjjnof1ock2yxz7p8q1qf2v9o';
        const ensNames = new Map([[ipnsId, 'dynamic.eth']]);

        const result = applyEnsNamePreservation(`ipns://${ipnsId}`, ensNames);
        expect(result).toBe('ipns://dynamic.eth');
      });

      test('preserves transport scheme + path for IPNS', () => {
        const ipnsId = 'docs.ipfs.tech';
        const ensNames = new Map([[ipnsId, 'ipfsdocs.eth']]);

        const result = applyEnsNamePreservation(`ipns://${ipnsId}/install/`, ensNames);
        expect(result).toBe('ipns://ipfsdocs.eth/install/');
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
      // then navigates elsewhere, then goes back -> should show ENS name again under
      // the resolved transport scheme.

      test('full navigation cycle with Swarm preserves bzz:// transport', () => {
        const hash = 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';
        const ensName = 'coolsite.eth';

        // Step 1: User navigates to coolsite.eth which resolves to bzz://hash
        // The system stores: knownEnsNames.set(hash, 'coolsite.eth')
        const knownEnsNames = new Map([[hash, ensName]]);

        // Step 3: User clicks back — webview reports bzz://hash; preservation
        // should swap the host for the ENS name while keeping the transport.
        const displayUrl = `bzz://${hash}/subpage`;
        const result = applyEnsNamePreservation(displayUrl, knownEnsNames);

        expect(result).toBe('bzz://coolsite.eth/subpage');
      });

      test('full navigation cycle with IPFS preserves ipfs:// transport', () => {
        const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
        const ensName = 'ipfsapp.eth';

        const knownEnsNames = new Map([[cid, ensName]]);

        const displayUrl = `ipfs://${cid}/page`;
        const result = applyEnsNamePreservation(displayUrl, knownEnsNames);

        expect(result).toBe('ipfs://ipfsapp.eth/page');
      });

      test('direct hash navigation (no ENS mapping) shows hash unchanged', () => {
        const hash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
        const knownEnsNames = new Map(); // Empty - direct navigation doesn't add mapping

        const displayUrl = `bzz://${hash}`;
        const result = applyEnsNamePreservation(displayUrl, knownEnsNames);

        expect(result).toBe(`bzz://${hash}`);
      });
    });
  });

  describe('buildEnsDisplayUri', () => {
    test('builds bzz transport display for Swarm-backed ENS', () => {
      expect(buildEnsDisplayUri('bzz', 'meinhard.eth')).toBe('bzz://meinhard.eth');
      expect(buildEnsDisplayUri('bzz', 'meinhard.eth', '/docs?q=1')).toBe(
        'bzz://meinhard.eth/docs?q=1'
      );
    });

    test('builds ipfs transport display for IPFS-backed ENS', () => {
      expect(buildEnsDisplayUri('ipfs', 'vitalik.eth')).toBe('ipfs://vitalik.eth');
      expect(buildEnsDisplayUri('ipfs', 'vitalik.eth', '#/swap')).toBe('ipfs://vitalik.eth#/swap');
    });

    test('builds ipns transport display for IPNS-backed ENS', () => {
      expect(buildEnsDisplayUri('ipns', 'app.eth', '/index.html')).toBe(
        'ipns://app.eth/index.html'
      );
    });

    test('returns null for unsupported protocols and missing names', () => {
      expect(buildEnsDisplayUri('http', 'name.eth')).toBeNull();
      expect(buildEnsDisplayUri('rad', 'name.eth')).toBeNull();
      expect(buildEnsDisplayUri('bzz', '')).toBeNull();
      expect(buildEnsDisplayUri('bzz', null)).toBeNull();
    });
  });

  describe('isEnsBackedDisplay', () => {
    test('recognises bare Ethereum names with .eth, .box, .wei, or .gwei', () => {
      expect(isEnsBackedDisplay('vitalik.eth')).toBe(true);
      expect(isEnsBackedDisplay('vitalik.eth/docs')).toBe(true);
      expect(isEnsBackedDisplay('myapp.box')).toBe(true);
      expect(isEnsBackedDisplay('alice.wei')).toBe(true);
      expect(isEnsBackedDisplay('apoorv.gwei')).toBe(true);
    });

    test('recognises legacy ens:// form', () => {
      expect(isEnsBackedDisplay('ens://vitalik.eth')).toBe(true);
      expect(isEnsBackedDisplay('ens://Vitalik.ETH/path')).toBe(true);
    });

    test('recognises transport ENS forms (bzz/ipfs/ipns)', () => {
      expect(isEnsBackedDisplay('bzz://meinhard.eth')).toBe(true);
      expect(isEnsBackedDisplay('ipfs://vitalik.eth/docs')).toBe(true);
      expect(isEnsBackedDisplay('ipns://app.box/page')).toBe(true);
      expect(isEnsBackedDisplay('ipfs://alice.wei/page')).toBe(true);
      expect(isEnsBackedDisplay('ipfs://apoorv.gwei/page')).toBe(true);
      expect(isEnsBackedDisplay('ipfs://docs.example.tez/page')).toBe(true);
      expect(isEnsBackedDisplay('docs.example.tez/page')).toBe(true);
    });

    test('rejects raw transport URLs (hash/CID hosts) and other schemes', () => {
      expect(isEnsBackedDisplay('bzz://abcdef1234')).toBe(false);
      expect(isEnsBackedDisplay('ipfs://QmHash')).toBe(false);
      expect(isEnsBackedDisplay('https://example.com')).toBe(false);
      expect(isEnsBackedDisplay('rad://z123')).toBe(false);
      expect(isEnsBackedDisplay('')).toBe(false);
      expect(isEnsBackedDisplay(null)).toBe(false);
    });
  });

  describe('normalizeLegacyEnsBookmarkUrl', () => {
    test('rewrites ens://name.eth to bare-name form', () => {
      expect(normalizeLegacyEnsBookmarkUrl('ens://vitalik.eth')).toBe('vitalik.eth');
      expect(normalizeLegacyEnsBookmarkUrl('ens://vitalik.eth/docs')).toBe('vitalik.eth/docs');
      expect(normalizeLegacyEnsBookmarkUrl('ens://app.eth/#/swap')).toBe('app.eth/#/swap');
      expect(normalizeLegacyEnsBookmarkUrl('ens://Vitalik.ETH/Path')).toBe('vitalik.eth/Path');
    });

    test('passes through non-ENS bookmark targets unchanged', () => {
      expect(normalizeLegacyEnsBookmarkUrl('bzz://abc123')).toBe('bzz://abc123');
      expect(normalizeLegacyEnsBookmarkUrl('ipfs://QmHash/x')).toBe('ipfs://QmHash/x');
      expect(normalizeLegacyEnsBookmarkUrl('https://example.com')).toBe('https://example.com');
      expect(normalizeLegacyEnsBookmarkUrl('vitalik.eth')).toBe('vitalik.eth');
    });

    test('leaves non-ENS ens:// strings alone (defensive)', () => {
      // Hypothetical malformed input — host is not an ENS name. Pass through
      // so the navigation pipeline can reject it via its normal path.
      expect(normalizeLegacyEnsBookmarkUrl('ens://example.com')).toBe('ens://example.com');
    });

    test('accepts non-string input without throwing', () => {
      expect(normalizeLegacyEnsBookmarkUrl(null)).toBeNull();
      expect(normalizeLegacyEnsBookmarkUrl(undefined)).toBeUndefined();
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

    test('returns null when the Radicle route prefix is not ready', () => {
      expect(parseRadicleInput(`rad://${SAMPLE_RID}`, null)).toBeNull();
    });
  });

  describe('formatRadicleUrl', () => {
    test('returns null when the Radicle base is not ready', () => {
      expect(formatRadicleUrl('rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5', null)).toBeNull();
    });
  });

  describe('deriveRadBaseFromUrl', () => {
    const RAD_BASE = 'http://127.0.0.1:8780/api/v1/repos/';
    const SAMPLE_RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';

    test('extracts base from Radicle API URL', () => {
      const url = `${RAD_BASE}${SAMPLE_RID}/tree/main/README.md`;
      expect(deriveRadBaseFromUrl(url)).toBe(`${RAD_BASE}${SAMPLE_RID}/`);
    });

    test('extracts base from URL object input', () => {
      const url = new URL(`${RAD_BASE}${SAMPLE_RID}/commits`);
      expect(deriveRadBaseFromUrl(url)).toBe(`${RAD_BASE}${SAMPLE_RID}/`);
    });

    test('returns null for legacy /projects/ path', () => {
      const url = `http://127.0.0.1:8780/api/v1/projects/${SAMPLE_RID}/tree/main`;
      expect(deriveRadBaseFromUrl(url)).toBeNull();
    });

    test('returns null for non-Radicle API paths', () => {
      expect(deriveRadBaseFromUrl('http://127.0.0.1:8780/api/v1/')).toBeNull();
      expect(deriveRadBaseFromUrl('http://127.0.0.1:8780/')).toBeNull();
    });

    test('returns null for invalid RID segment', () => {
      const url = 'http://127.0.0.1:8780/api/v1/repos/not-a-rid/tree/main';
      expect(deriveRadBaseFromUrl(url)).toBeNull();
    });

    test('returns null for invalid input values', () => {
      expect(deriveRadBaseFromUrl(null)).toBeNull();
      expect(deriveRadBaseFromUrl(undefined)).toBeNull();
      expect(deriveRadBaseFromUrl('not-a-url')).toBeNull();
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
