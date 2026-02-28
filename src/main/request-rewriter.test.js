const {
  shouldRewriteRequest,
  buildRewriteTarget,
  convertProtocolUrl,
  shouldBlockInvalidBzzRequest,
  registerRequestRewriter,
} = require('./request-rewriter');
const { activeRadBases } = require('./state');
const { formatRadicleUrl, deriveRadBaseFromUrl, deriveDisplayValue } = require('../renderer/lib/url-utils.js');

// Mock service-registry so convertProtocolUrl can resolve gateway URLs
jest.mock('./service-registry', () => ({
  getBeeApiUrl: () => 'http://127.0.0.1:1633',
  getIpfsGatewayUrl: () => 'http://127.0.0.1:8080',
  getRadicleApiUrl: () => 'http://127.0.0.1:8780',
}));

jest.mock('./settings-store', () => ({
  loadSettings: jest.fn(() => ({ enableRadicleIntegration: true })),
}));
const { loadSettings } = require('./settings-store');

const BASE_URL = 'http://127.0.0.1:1633/bzz/abc123def456/';
const VALID_HASH = 'a'.repeat(64);

describe('request-rewriter', () => {
  afterEach(() => {
    activeRadBases.clear();
    loadSettings.mockReturnValue({ enableRadicleIntegration: true });
  });

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

    test('allows non-bzz URLs', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/api/status')).toBe(false);
      expect(shouldBlockInvalidBzzRequest('https://example.com/page')).toBe(false);
    });

    test('allows non-bzz URLs on the same origin', () => {
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/bytes/abcdef')).toBe(false);
      expect(shouldBlockInvalidBzzRequest('http://127.0.0.1:1633/chunks/abcdef')).toBe(false);
    });
  });

  // =========================================
  // Radicle protocol support
  // =========================================
  describe('convertProtocolUrl – rad: protocol', () => {
    const RADICLE_API = 'http://127.0.0.1:8780';
    const SAMPLE_RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';

    test('converts rad:RID to API URL', () => {
      const result = convertProtocolUrl(`rad:${SAMPLE_RID}`);
      expect(result).toEqual({
        converted: true,
        url: `${RADICLE_API}/api/v1/repos/${SAMPLE_RID}`,
      });
    });

    test('converts rad://RID to API URL', () => {
      const result = convertProtocolUrl(`rad://${SAMPLE_RID}`);
      expect(result).toEqual({
        converted: true,
        url: `${RADICLE_API}/api/v1/repos/${SAMPLE_RID}`,
      });
    });

    test('converts rad:RID with sub-path', () => {
      const result = convertProtocolUrl(`rad:${SAMPLE_RID}/tree/main/README.md`);
      expect(result).toEqual({
        converted: true,
        url: `${RADICLE_API}/api/v1/repos/${SAMPLE_RID}/tree/main/README.md`,
      });
    });

    test('converts rad://RID with sub-path', () => {
      const result = convertProtocolUrl(`rad://${SAMPLE_RID}/tree/main/src`);
      expect(result).toEqual({
        converted: true,
        url: `${RADICLE_API}/api/v1/repos/${SAMPLE_RID}/tree/main/src`,
      });
    });

    test('does not convert non-rad protocols', () => {
      expect(convertProtocolUrl('https://example.com')).toEqual({
        converted: false,
        url: 'https://example.com',
      });
    });

    test('blocks rad: with path traversal attempt', () => {
      const malicious = 'rad://../../etc/passwd';
      const result = convertProtocolUrl(malicious);
      expect(result.converted).toBe(false);
    });

    test('blocks rad: with invalid RID characters', () => {
      expect(convertProtocolUrl('rad:invalid!rid').converted).toBe(false);
      expect(convertProtocolUrl('rad:0000000000000000000000').converted).toBe(false);
    });

    test('blocks rad: with too-short RID', () => {
      expect(convertProtocolUrl('rad:zabc').converted).toBe(false);
    });

    test('does not convert rad: when integration is disabled', () => {
      loadSettings.mockReturnValue({ enableRadicleIntegration: false });
      expect(convertProtocolUrl(`rad:${SAMPLE_RID}`)).toEqual({
        converted: false,
        url: `rad:${SAMPLE_RID}`,
      });
    });
  });

  describe('shouldRewriteRequest – Radicle paths', () => {
    const RAD_BASE = 'http://127.0.0.1:8780/api/v1/repos/z3gqcJUoA1n9HaHKufZs5FCSGazv5/';

    test('does not rewrite requests already on /api/v1/repos/ path', () => {
      const result = shouldRewriteRequest(
        'http://127.0.0.1:8780/api/v1/repos/z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree/main',
        RAD_BASE
      );
      expect(result.shouldRewrite).toBe(false);
      expect(result.reason).toBe('already_rad_path');
    });

    test('rewrites relative resource requests from a Radicle base', () => {
      const result = shouldRewriteRequest(
        'http://127.0.0.1:8780/some-relative-asset.js',
        RAD_BASE
      );
      expect(result.shouldRewrite).toBe(true);
    });

    test('does not rewrite cross-origin requests', () => {
      const result = shouldRewriteRequest(
        'https://cdn.example.com/lib.js',
        RAD_BASE
      );
      expect(result.shouldRewrite).toBe(false);
    });
  });

  describe('integration: rad:// entry -> navigation -> rewrite -> display roundtrip', () => {
    const SAMPLE_RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';
    const RADICLE_BASE = 'http://127.0.0.1:8780';
    const RADICLE_API_PREFIX = `${RADICLE_BASE}/api/v1/repos/`;

    test('roundtrips rad:// URL through target, rewrite, and display value', () => {
      const previousWindow = global.window;
      try {
        global.window = { location: { href: 'file:///app/index.html' } };

        const entryUrl = `rad://${SAMPLE_RID}/tree/main/README.md`;

        // Entry -> navigation target
        const navTarget = formatRadicleUrl(entryUrl, RADICLE_BASE);
        expect(navTarget).not.toBeNull();
        expect(navTarget.displayValue).toBe(entryUrl);

        // Custom protocol conversion used by request interception
        const converted = convertProtocolUrl(entryUrl);
        expect(converted).toEqual({
          converted: true,
          url: `${RADICLE_BASE}/api/v1/repos/${SAMPLE_RID}/tree/main/README.md`,
        });

        // Navigation-derived base enables same-origin relative request rewriting
        const radBase = deriveRadBaseFromUrl(converted.url);
        expect(radBase).toBe(`${RADICLE_API_PREFIX}${SAMPLE_RID}/`);

        const relativeRequest = `${RADICLE_BASE}/assets/code.css`;
        expect(shouldRewriteRequest(relativeRequest, radBase)).toEqual({ shouldRewrite: true });
        expect(buildRewriteTarget(relativeRequest, radBase)).toBe(
          `${RADICLE_API_PREFIX}${SAMPLE_RID}/assets/code.css`
        );

        // Internal API URL -> display value in address bar
        const display = deriveDisplayValue(
          converted.url,
          'http://127.0.0.1:1633/bzz/',
          'file:///app/home.html',
          'http://127.0.0.1:8080/ipfs/',
          'http://127.0.0.1:8080/ipns/',
          RADICLE_API_PREFIX
        );
        expect(display).toBe(entryUrl);
      } finally {
        global.window = previousWindow;
      }
    });

    test('rewrites same-origin Radicle requests via registered session handler', () => {
      const webContentsId = 42;
      const sessionMock = {
        webRequest: {
          onBeforeRequest: jest.fn(),
        },
      };

      activeRadBases.set(webContentsId, `${RADICLE_API_PREFIX}${SAMPLE_RID}/`);
      registerRequestRewriter(sessionMock);

      expect(sessionMock.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
      const [handler] = sessionMock.webRequest.onBeforeRequest.mock.calls[0];
      const callback = jest.fn();

      handler(
        {
          webContentsId,
          url: `${RADICLE_BASE}/blob/main/src/index.js`,
        },
        callback
      );

      expect(callback).toHaveBeenCalledWith({
        redirectURL: `${RADICLE_API_PREFIX}${SAMPLE_RID}/blob/main/src/index.js`,
      });
    });

    test('does not rewrite Radicle requests when integration is disabled', () => {
      loadSettings.mockReturnValue({ enableRadicleIntegration: false });
      const webContentsId = 42;
      const sessionMock = {
        webRequest: {
          onBeforeRequest: jest.fn(),
        },
      };

      activeRadBases.set(webContentsId, `${RADICLE_API_PREFIX}${SAMPLE_RID}/`);
      registerRequestRewriter(sessionMock);

      const [handler] = sessionMock.webRequest.onBeforeRequest.mock.calls[0];
      const callback = jest.fn();

      handler(
        {
          webContentsId,
          url: `${RADICLE_BASE}/blob/main/src/index.js`,
        },
        callback
      );

      expect(callback).toHaveBeenCalledWith({});
    });
  });
});
