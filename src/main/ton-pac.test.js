'use strict';

const { buildTonHostCondition } = require('./ton-pac');
const { isTonHost, TON_SUFFIXES } = require('../shared/ton-suffixes');

describe('isTonHost', () => {
  test('.ton suffix', () => expect(isTonHost('foo.ton')).toBe(true));
  test('.adnl suffix', () => expect(isTonHost('foo.adnl')).toBe(true));
  test('.bag suffix', () => expect(isTonHost('foo.bag')).toBe(true));
  test('clearnet host', () => expect(isTonHost('example.com')).toBe(false));
  test('loopback', () => expect(isTonHost('127.0.0.1')).toBe(false));
  test('case-insensitive', () => expect(isTonHost('FOO.TON')).toBe(true));
  test('suffix-boundary: .tonic.example', () => expect(isTonHost('foo.tonic.example')).toBe(false));
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

test('buildTonHostCondition uses the shared suffix list and no bare host alias', () => {
  const condition = buildTonHostCondition('candidate');
  for (const suffix of TON_SUFFIXES) {
    expect(condition).toContain(`dnsDomainIs(candidate, "${suffix}")`);
  }
  expect(condition).not.toContain('candidate === "ton"');
});
