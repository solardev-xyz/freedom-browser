'use strict';

const vm = require('vm');
const { buildPacScript } = require('./ton-pac');
const { isTonHost, TON_SUFFIXES } = require('../shared/ton-suffixes');

function evalPac(pacDataUri, url, host) {
  const encoded = pacDataUri.slice('data:application/x-ns-proxy-autoconfig,'.length);
  const body = decodeURIComponent(encoded);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);
  return sandbox.FindProxyForURL(url, host);
}

describe('isTonHost', () => {
  test('.ton suffix', () => expect(isTonHost('foo.ton')).toBe(true));
  test('.adnl suffix', () => expect(isTonHost('foo.adnl')).toBe(true));
  test('.bag suffix', () => expect(isTonHost('foo.bag')).toBe(true));
  test('single-label "ton"', () => expect(isTonHost('ton')).toBe(true));
  test('clearnet host', () => expect(isTonHost('example.com')).toBe(false));
  test('loopback', () => expect(isTonHost('127.0.0.1')).toBe(false));
  test('case-insensitive', () => expect(isTonHost('FOO.TON')).toBe(true));
  test('suffix-boundary: .tonic.example', () =>
    expect(isTonHost('foo.tonic.example')).toBe(false));
  test('falsy input', () => expect(isTonHost('')).toBe(false));
  test('null input', () => expect(isTonHost(null)).toBe(false));
  test('.t.me host matches', () => expect(isTonHost('foo.t.me')).toBe(true));
  // Bare t.me is the Telegram root domain (clearnet); only subdomains are TON-proxied.
  test('bare t.me is not a TON host', () => expect(isTonHost('t.me')).toBe(false));
});

test('TON_SUFFIXES contains the expected values', () => {
  expect(TON_SUFFIXES).toEqual(expect.arrayContaining(['.ton', '.adnl', '.bag', '.t.me']));
  expect(TON_SUFFIXES).toHaveLength(4);
});

describe('buildPacScript: validation', () => {
  test('throws when proxyHost is missing', () => {
    expect(() => buildPacScript({ proxyPort: 18085 })).toThrow();
  });

  test('throws when proxyPort is missing', () => {
    expect(() => buildPacScript({ proxyHost: '127.0.0.1' })).toThrow();
  });
});

describe('buildPacScript: data URI', () => {
  const pac = buildPacScript({ proxyHost: '127.0.0.1', proxyPort: 18085 });

  test('returns a data: URI', () => {
    expect(pac).toMatch(/^data:application\/x-ns-proxy-autoconfig,/);
  });

  test('port is interpolated into the PAC body', () => {
    const decoded = decodeURIComponent(
      pac.slice('data:application/x-ns-proxy-autoconfig,'.length)
    );
    expect(decoded).toContain('127.0.0.1:18085');
  });

  test('different ports produce different PAC bodies', () => {
    const pac2 = buildPacScript({ proxyHost: '127.0.0.1', proxyPort: 18086 });
    expect(pac).not.toBe(pac2);
    const decoded2 = decodeURIComponent(
      pac2.slice('data:application/x-ns-proxy-autoconfig,'.length)
    );
    expect(decoded2).toContain('18086');
  });
});

describe('buildPacScript: PAC routing', () => {
  const pac = buildPacScript({ proxyHost: '127.0.0.1', proxyPort: 18085 });

  const cases = [
    // TON → PROXY
    ['http://ton/', 'ton', 'PROXY 127.0.0.1:18085'],
    ['http://foo.ton/', 'foo.ton', 'PROXY 127.0.0.1:18085'],
    ['http://sub.foo.ton/', 'sub.foo.ton', 'PROXY 127.0.0.1:18085'],
    ['http://foo.adnl/', 'foo.adnl', 'PROXY 127.0.0.1:18085'],
    ['http://foo.bag/', 'foo.bag', 'PROXY 127.0.0.1:18085'],
    ['http://FOO.TON/', 'FOO.TON', 'PROXY 127.0.0.1:18085'],
    ['http://foo.t.me/', 'foo.t.me', 'PROXY 127.0.0.1:18085'],
    // DIRECT
    ['https://example.com/', 'example.com', 'DIRECT'],
    // bzz loopback regression: request-rewriter redirects bzz:// → loopback URL,
    // which must NOT be routed through the TON proxy
    ['http://127.0.0.1:1633/bzz/abc', '127.0.0.1', 'DIRECT'],
    // suffix-boundary enforcement: "tonic" is not ".ton"
    ['http://foo.tonic.example/', 'foo.tonic.example', 'DIRECT'],
    // ".ton" as substring of longer TLD
    ['http://example.ton-is-nice.example/', 'example.ton-is-nice.example', 'DIRECT'],
  ];

  test.each(cases)('FindProxyForURL(%s, %s) → %s', (url, host, expected) => {
    expect(evalPac(pac, url, host)).toBe(expected);
  });
});
