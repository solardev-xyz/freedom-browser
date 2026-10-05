const {
  indexedHeight,
  tokenTransfersFrom,
  IndexUnavailableError,
  MAX_PAGES,
  MAX_REDIRECTS,
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

// What gnosisscan.io answers (2026-10-04).
const FINISHED = {
  finished_indexing: true,
  finished_indexing_blocks: true,
  indexed_blocks_ratio: '1.00',
  indexed_internal_transactions_ratio: '1.00',
};
const indexAnswers =
  ({ status = FINISHED, blocks = [{ height: 48588282 }, { height: 48588281 }] } = {}) =>
  (url) =>
    String(url).endsWith('/main-page/indexing-status') ? status() : blocks();

describe('indexedHeight', () => {
  test('is the newest block Blockscout lists, once it has indexed every block', async () => {
    global.fetch = jest.fn(
      indexAnswers({ status: () => reply(FINISHED), blocks: () => reply([{ height: 48588282 }]) })
    );
    await expect(indexedHeight(BASE)).resolves.toBe(48588282);
    expect(global.fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      `${BASE}/main-page/blocks`,
      `${BASE}/main-page/indexing-status`,
    ]);
  });

  test.each([
    [
      'still catching up on blocks',
      { ...FINISHED, finished_indexing_blocks: false, indexed_blocks_ratio: '0.98' },
    ],
    ['no block status', { finished_indexing: true }],
  ])('cannot vouch for a range while %s', async (_name, status) => {
    global.fetch = jest.fn(
      indexAnswers({ status: () => reply(status), blocks: () => reply([{ height: 48588282 }]) })
    );
    await expect(indexedHeight(BASE)).rejects.toThrow('has not finished indexing blocks');
  });

  test.each([
    ['an empty list', () => reply([])],
    ['no height', () => reply([{}])],
    ['HTTP 503', () => reply({}, 503)],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('fails as unavailable on %s', async (_name, answer) => {
    global.fetch = jest.fn(indexAnswers({ status: () => reply(FINISHED), blocks: answer }));
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

describe('redirects', () => {
  const redirect = (location, status = 301) =>
    Promise.resolve({
      ok: false,
      status,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
      body: null,
    });
  const page = { items: [{ block_number: 1 }], next_page_params: null };

  test('are followed to another https host, without fetch following them itself', async () => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(() => redirect('https://gnosisscan.io/api/v2/elsewhere'))
      .mockImplementationOnce(() => reply(page));
    await expect(tokenTransfersFrom(BASE, { from: FROM, token: TOKEN })).resolves.toEqual(
      page.items
    );
    expect(global.fetch.mock.calls[1][0]).toBe('https://gnosisscan.io/api/v2/elsewhere');
    expect(global.fetch.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true);
  });

  test.each([
    ['plaintext http', 'http://gnosisscan.io/api/v2/x'],
    ['a LAN host, by the caller-supplied check', 'https://192.168.1.50/api/v2/x'],
  ])('to %s are refused before the wallet address is sent there', async (_name, location) => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(() => redirect(location))
      .mockImplementation(() => reply(page));
    const validateUrl = (url) =>
      new URL(url).protocol !== 'https:' || new URL(url).hostname.startsWith('192.168.')
        ? 'refused'
        : null;
    await expect(
      tokenTransfersFrom(BASE, { from: FROM, token: TOKEN, validateUrl })
    ).rejects.toThrow('Blockscout URL refused');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('without a caller check, only https is fetched', async () => {
    global.fetch = jest.fn(() => reply(page));
    await expect(
      tokenTransfersFrom('http://gnosisscan.io/api/v2', { from: FROM, token: TOKEN })
    ).rejects.toBeInstanceOf(IndexUnavailableError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test(`stop after ${MAX_REDIRECTS} hops`, async () => {
    global.fetch = jest.fn(() => redirect('https://gnosisscan.io/api/v2/loop'));
    await expect(tokenTransfersFrom(BASE, { from: FROM, token: TOKEN })).rejects.toThrow(
      'redirected too often'
    );
    expect(global.fetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});
