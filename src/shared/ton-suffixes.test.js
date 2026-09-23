const { TON_SUFFIXES, isTonHost } = require('./ton-suffixes');

describe('TON hostname policy', () => {
  test.each(['foundation.ton', 'foundation.ton.', 'site.adnl', 'archive.bag', 'name.t.me'])(
    'accepts %s',
    (host) => expect(isTonHost(host)).toBe(true)
  );

  test.each(['example.com', 't.me', 'ton', 'example.tonic', '', null])('rejects %p', (host) => {
    expect(isTonHost(host)).toBe(false);
  });

  test('keeps the main-process and renderer suffix lists in sync', async () => {
    const renderer = await import('../renderer/lib/url-utils.js');
    expect(renderer.TON_SUFFIXES).toEqual(TON_SUFFIXES);
  });
});
