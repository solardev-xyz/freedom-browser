const {
  mapResourceType,
  isInterceptableUrl,
  isLoopbackHost,
  hostnameFromUrl,
  normalizeHost,
  isHostAllowlisted,
} = require('./request-classifier');

describe('mapResourceType', () => {
  test('maps Electron resource types to adblock request types', () => {
    expect(mapResourceType('mainFrame')).toBe('main_frame');
    expect(mapResourceType('subFrame')).toBe('sub_frame');
    expect(mapResourceType('stylesheet')).toBe('stylesheet');
    expect(mapResourceType('script')).toBe('script');
    expect(mapResourceType('image')).toBe('image');
    expect(mapResourceType('font')).toBe('font');
    expect(mapResourceType('media')).toBe('media');
    expect(mapResourceType('xhr')).toBe('xhr');
    expect(mapResourceType('webSocket')).toBe('websocket');
    expect(mapResourceType('ping')).toBe('ping');
    expect(mapResourceType('object')).toBe('object');
  });

  test('maps fetch to xhr', () => {
    expect(mapResourceType('fetch')).toBe('xhr');
  });

  test('falls back to other for unknown types', () => {
    expect(mapResourceType('cspReport')).toBe('csp_report');
    expect(mapResourceType('somethingNew')).toBe('other');
    expect(mapResourceType(undefined)).toBe('other');
  });
});

describe('isInterceptableUrl', () => {
  test('accepts http, https, ws, wss', () => {
    expect(isInterceptableUrl('http://example.com/x')).toBe(true);
    expect(isInterceptableUrl('https://example.com/x')).toBe(true);
    expect(isInterceptableUrl('ws://example.com/socket')).toBe(true);
    expect(isInterceptableUrl('wss://example.com/socket')).toBe(true);
  });

  test('rejects internal and decentralized schemes', () => {
    expect(isInterceptableUrl('file:///etc/passwd')).toBe(false);
    expect(isInterceptableUrl('bzz://abcdef')).toBe(false);
    expect(isInterceptableUrl('ipfs://Qm123')).toBe(false);
    expect(isInterceptableUrl('freedom://settings')).toBe(false);
    expect(isInterceptableUrl('devtools://devtools/bundled')).toBe(false);
    expect(isInterceptableUrl('chrome-extension://abc')).toBe(false);
    expect(isInterceptableUrl(null)).toBe(false);
    expect(isInterceptableUrl(undefined)).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  test('detects loopback hosts (local node APIs must never be blocked)', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  test('returns false for public hosts', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
  });
});

describe('hostnameFromUrl', () => {
  test('extracts the raw hostname (no www-stripping)', () => {
    expect(hostnameFromUrl('https://www.Example.com/page?q=1')).toBe('www.example.com');
    expect(hostnameFromUrl('http://127.0.0.1:1633/bzz/abc/')).toBe('127.0.0.1');
    expect(hostnameFromUrl('http://[::1]:5001/api/v0')).toBe('[::1]');
  });

  test('returns null for invalid URLs', () => {
    expect(hostnameFromUrl('')).toBe(null);
    expect(hostnameFromUrl('not a url')).toBe(null);
    expect(hostnameFromUrl(null)).toBe(null);
  });
});

describe('normalizeHost', () => {
  test('lowercases, trims, strips www. and trailing dot', () => {
    expect(normalizeHost('WWW.Example.COM')).toBe('example.com');
    expect(normalizeHost('example.com.')).toBe('example.com');
    expect(normalizeHost('  bild.de ')).toBe('bild.de');
    expect(normalizeHost('m.bild.de')).toBe('m.bild.de');
  });

  test('returns null for empty or non-string input', () => {
    expect(normalizeHost('')).toBe(null);
    expect(normalizeHost(null)).toBe(null);
    expect(normalizeHost(undefined)).toBe(null);
    expect(normalizeHost('www.')).toBe(null);
  });
});

describe('isHostAllowlisted', () => {
  // Both sides are pre-normalized (entries at store time, host per request).
  const entries = ['bild.de', 'sport.example'];

  test('matches exact hosts and subdomains (iOS semantics)', () => {
    expect(isHostAllowlisted('bild.de', entries)).toBe(true);
    expect(isHostAllowlisted('m.bild.de', entries)).toBe(true);
    expect(isHostAllowlisted('ads.tracking.bild.de', entries)).toBe(true);
    expect(isHostAllowlisted('news.sport.example', entries)).toBe(true);
  });

  test('does not match lookalike or unrelated hosts', () => {
    expect(isHostAllowlisted('evilbild.de', entries)).toBe(false);
    expect(isHostAllowlisted('bild.de.evil.com', entries)).toBe(false);
    expect(isHostAllowlisted('example.com', entries)).toBe(false);
  });

  test('handles empty inputs', () => {
    expect(isHostAllowlisted('bild.de', [])).toBe(false);
    expect(isHostAllowlisted(null, entries)).toBe(false);
    expect(isHostAllowlisted('bild.de', ['', null])).toBe(false);
  });
});
