// The dispatcher's a singleton — wipe its registry before each test so the
// rewriter-install assertions don't trip over residue from earlier tests.
jest.mock('./webrequest-dispatcher', () => {
  const handlers = [];
  return {
    registerWebRequestHandler: jest.fn((event, name, handler) => {
      handlers.push({ event, name, handler });
    }),
    _getHandlers: () => handlers,
    _reset: () => handlers.splice(0),
  };
});

const {
  shouldRewriteRequest,
  buildRewriteTarget,
  shouldBlockInvalidBzzRequest,
  rewriteRequestForDispatch,
  installRequestRewriter,
} = require('./request-rewriter');
const dispatcherMock = require('./webrequest-dispatcher');
const { activeRadBases } = require('./state');
const {
  formatRadicleUrl,
  deriveRadBaseFromUrl,
  deriveDisplayValue,
} = require('../renderer/lib/url-utils.js');

jest.mock('./settings-store', () => ({
  loadSettings: jest.fn(() => ({ enableRadicleIntegration: true })),
}));
const { loadSettings } = require('./settings-store');

const BASE_URL = 'http://127.0.0.1:1633/bzz/abc123def456/';
const VALID_HASH = 'a'.repeat(64);
const VALID_ENCRYPTED_HASH = 'a'.repeat(128);

describe('request-rewriter', () => {
  afterEach(() => {
    activeRadBases.clear();
    loadSettings.mockReturnValue({ enableRadicleIntegration: true });
  });

  // `bzz://`, `ipfs://`, `ipns://`, and `rad:`/`rad://` are owned by the
  // custom protocol handlers (bzz-protocol.js, ipfs-protocol.js,
  // rad-protocol.js) — requests for these schemes never reach webRequest,
  // and the rewriter must not touch them if one ever leaks through.
  describe('rewriteRequestForDispatch – scheme pass-through', () => {
    const SAMPLE_RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';

    test.each([
      ['bzz', `bzz://${VALID_HASH}/index.html`],
      ['ipfs', 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/file.txt'],
      ['ipns', 'ipns://example.eth/page.html'],
      ['rad slashes', `rad://${SAMPLE_RID}/tree/main`],
      ['rad urn', `rad:${SAMPLE_RID}`],
      ['https', 'https://example.com'],
    ])('passes %s URLs through untouched', (_name, url) => {
      expect(rewriteRequestForDispatch({ webContentsId: 1, url })).toBeNull();
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
      expect(
        shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${VALID_ENCRYPTED_HASH}`)
      ).toBe(false);
    });

    test('allows /bzz/ with valid encrypted hash and sub-path', () => {
      expect(
        shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${VALID_ENCRYPTED_HASH}/index.html`)
      ).toBe(false);
    });

    test('blocks /bzz/ with invalid length hash (65 chars)', () => {
      expect(shouldBlockInvalidBzzRequest(`http://127.0.0.1:1633/bzz/${'a'.repeat(65)}`)).toBe(
        true
      );
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
      const result = shouldRewriteRequest('http://127.0.0.1:8780/some-relative-asset.js', RAD_BASE);
      expect(result.shouldRewrite).toBe(true);
    });

    test('does not rewrite cross-origin requests', () => {
      const result = shouldRewriteRequest('https://cdn.example.com/lib.js', RAD_BASE);
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

        // Scheme conversion is owned by the rad protocol handler
        // (rad-protocol.js); this is the httpd URL shape a rad page's
        // subresources resolve against.
        const gatewayUrl = `${RADICLE_BASE}/api/v1/repos/${SAMPLE_RID}/tree/main/README.md`;

        // Navigation-derived base enables same-origin relative request rewriting
        const radBase = deriveRadBaseFromUrl(gatewayUrl);
        expect(radBase).toBe(`${RADICLE_API_PREFIX}${SAMPLE_RID}/`);

        const relativeRequest = `${RADICLE_BASE}/assets/code.css`;
        expect(shouldRewriteRequest(relativeRequest, radBase)).toEqual({ shouldRewrite: true });
        expect(buildRewriteTarget(relativeRequest, radBase)).toBe(
          `${RADICLE_API_PREFIX}${SAMPLE_RID}/assets/code.css`
        );

        // Internal API URL -> display value in address bar
        const display = deriveDisplayValue(
          gatewayUrl,
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

    test('rewrites same-origin Radicle requests', () => {
      const webContentsId = 42;
      activeRadBases.set(webContentsId, `${RADICLE_API_PREFIX}${SAMPLE_RID}/`);

      const result = rewriteRequestForDispatch({
        webContentsId,
        url: `${RADICLE_BASE}/blob/main/src/index.js`,
      });

      expect(result).toEqual({
        redirectURL: `${RADICLE_API_PREFIX}${SAMPLE_RID}/blob/main/src/index.js`,
      });
    });

    test('does not rewrite Radicle requests when integration is disabled', () => {
      loadSettings.mockReturnValue({ enableRadicleIntegration: false });
      const webContentsId = 42;
      activeRadBases.set(webContentsId, `${RADICLE_API_PREFIX}${SAMPLE_RID}/`);

      const result = rewriteRequestForDispatch({
        webContentsId,
        url: `${RADICLE_BASE}/blob/main/src/index.js`,
      });

      expect(result).toBeNull();
    });

    test('installRequestRewriter registers a single onBeforeRequest handler in the dispatcher', () => {
      dispatcherMock._reset();
      installRequestRewriter();

      const registered = dispatcherMock._getHandlers();
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({
        event: 'onBeforeRequest',
        name: 'request-rewriter',
      });
      expect(registered[0].handler).toBe(rewriteRequestForDispatch);
    });
  });
});
