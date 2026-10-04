const {
  indexedHeight,
  tokenTransfersFrom,
  IndexUnavailableError,
  MAX_PAGES,
} = require('./blockscout-index');

const BASE = 'https://gnosisscan.io/api/v2';
const FROM = '0x2b7c998ae67905de2335d438e003dc5459b352e0';
const TOKEN = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const originalFetch = global.fetch;
const reply = (body, status = 200) =>
  Promise.resolve({ ok: status === 200, status, json: async () => body, body: null });

afterEach(() => {
  global.fetch = originalFetch;
});

describe('indexedHeight', () => {
  test('is the newest block Blockscout lists', async () => {
    global.fetch = jest.fn(() => reply([{ height: 48588282 }, { height: 48588281 }]));
    await expect(indexedHeight(BASE)).resolves.toBe(48588282);
    expect(global.fetch.mock.calls[0][0]).toBe(`${BASE}/main-page/blocks`);
  });

  test.each([
    ['an empty list', () => reply([])],
    ['no height', () => reply([{}])],
    ['HTTP 503', () => reply({}, 503)],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('fails as unavailable on %s', async (_name, answer) => {
    global.fetch = jest.fn(answer);
    await expect(indexedHeight(BASE)).rejects.toBeInstanceOf(IndexUnavailableError);
  });
});

describe('tokenTransfersFrom', () => {
  test('follows next_page_params until the last page', async () => {
    const pages = [
      { items: [{ block_number: 3 }], next_page_params: { block_number: 3, index: 0 } },
      { items: [{ block_number: 2 }], next_page_params: { block_number: 2, index: 1 } },
      { items: [{ block_number: 1 }], next_page_params: null },
    ];
    global.fetch = jest.fn(() => reply(pages.shift()));
    await expect(tokenTransfersFrom(BASE, { from: FROM, token: TOKEN })).resolves.toEqual([
      { block_number: 3 },
      { block_number: 2 },
      { block_number: 1 },
    ]);
    const urls = global.fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.pathname)).toEqual(
      Array(3).fill(`/api/v2/addresses/${FROM}/token-transfers`)
    );
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({
      type: 'ERC-20',
      filter: 'from',
      token: TOKEN,
    });
    expect(Object.fromEntries(urls[2].searchParams)).toEqual({
      type: 'ERC-20',
      filter: 'from',
      token: TOKEN,
      block_number: '2',
      index: '1',
    });
  });

  test(`reads at most ${MAX_PAGES} pages`, async () => {
    global.fetch = jest.fn(() => reply({ items: [{}], next_page_params: { index: 1 } }));
    await expect(tokenTransfersFrom(BASE, { from: FROM, token: TOKEN })).rejects.toThrow(
      `More than ${MAX_PAGES} pages`
    );
    expect(global.fetch).toHaveBeenCalledTimes(MAX_PAGES);
  });

  test.each([
    ['a page without items', () => reply({ next_page_params: null })],
    ['HTTP 429', () => reply({}, 429)],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('fails as unavailable on %s', async (_name, answer) => {
    global.fetch = jest.fn(answer);
    await expect(tokenTransfersFrom(BASE, { from: FROM, token: TOKEN })).rejects.toBeInstanceOf(
      IndexUnavailableError
    );
  });

  test("stops when the caller's signal aborts", async () => {
    const controller = new AbortController();
    global.fetch = jest.fn((_url, { signal }) => {
      controller.abort();
      return signal.aborted
        ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        : reply({ items: [], next_page_params: null });
    });
    await expect(
      tokenTransfersFrom(BASE, { from: FROM, token: TOKEN, signal: controller.signal })
    ).rejects.toBeInstanceOf(IndexUnavailableError);
  });
});
