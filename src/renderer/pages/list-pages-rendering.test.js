/**
 * History, Downloads and Payments render strings a website controls: page
 * titles and URLs, download filenames and URLs, payment origins. #432 moved
 * those rows off HTML strings (`innerHTML` + a hand-rolled `escapeHtml`, which
 * never escaped quotes, so an attribute-context value could break out) onto
 * DOM APIs with `textContent`.
 *
 * Each page script runs in a fake DOM that is not an HTML parser and records
 * every `innerHTML` / `insertAdjacentHTML` write. The contract pinned here:
 *   - the hostile value reaches the user verbatim, as text;
 *   - it never reaches an HTML sink at all, escaped or not;
 *   - the row still works (open, delete/remove, filter) off that value.
 */

const { runPageScript, flush } = require('../../../test/helpers/page-script-harness');

// A value that is dangerous in both text and attribute context.
const HOSTILE = `"><img src=x onerror=alert(1) data-xss="1">'<b>&amp;`;
const HOSTILE_URL = `https://evil.test/?q="><img src=x onerror=alert(1)>`;
// Something unique in HOSTILE to look for in the HTML sink log.
const MARKER = 'onerror=alert(1)';

const sinkHits = (page) =>
  page.document.htmlWrites.filter(
    (html) => html.includes('evil.test') || html.includes(MARKER) || html.includes('onerror')
  );

describe('history renders site strings as text (#432)', () => {
  const entry = (overrides = {}) => ({
    id: 7,
    url: HOSTILE_URL,
    title: HOSTILE,
    protocol: 'https',
    visit_count: 2,
    timestamp: Date.now(),
    ...overrides,
  });

  // A stand-in for main's `history:page`: filter, then one page of it.
  const pageOf = (entries, { query = '', offset = 0, limit = 200 } = {}) => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? entries.filter(
          (e) => e.url.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q)
        )
      : entries;
    return {
      entries: matched.slice(offset, offset + limit),
      matched: matched.length,
      total: entries.length,
    };
  };

  const run = (entries) => {
    const freedomAPI = {
      getHistoryPage: jest.fn(async (options) => pageOf(entries, options)),
      removeHistory: jest.fn().mockResolvedValue(true),
      openInNewTab: jest.fn(),
      clearHistory: jest.fn(),
    };
    return runPageScript('history', {
      ids: {
        'history-container': 'div',
        'search-input': 'input',
        'clear-btn': 'button',
        'sort-select': 'select',
        stats: 'p',
      },
      freedomAPI,
    }).then((page) => ({ ...page, freedomAPI }));
  };

  test('title and URL land verbatim in text, never in an HTML write', async () => {
    const page = await run([entry()]);
    const container = page.elements['history-container'];
    const [item] = container.querySelectorAll('.history-item');
    expect(item).toBeDefined();
    expect(item.querySelector('.history-title').textContent).toBe(HOSTILE);
    expect(item.querySelector('.history-url').textContent).toBe(HOSTILE_URL);
    expect(item.dataset.url).toBe(HOSTILE_URL);
    expect(container.querySelectorAll('img')).toEqual([]);
    expect(sinkHits(page)).toEqual([]);
  });

  test('falls back to the URL when the title is empty', async () => {
    const page = await run([entry({ title: '' })]);
    const item = page.elements['history-container'].querySelector('.history-item');
    expect(item.querySelector('.history-title').textContent).toBe(HOSTILE_URL);
  });

  test('a hostile protocol value cannot inject classes', async () => {
    const page = await run([entry({ protocol: 'x onerror=1' })]);
    const icon = page.elements['history-container'].querySelector('.protocol-icon-full');
    expect(icon.className).toBe('protocol-icon-full');
    expect(sinkHits(page)).toEqual([]);
  });

  test('clicking a row opens the exact stored URL; delete removes that id', async () => {
    const page = await run([entry()]);
    const item = page.elements['history-container'].querySelector('.history-item');
    await item.querySelector('.history-title').fire('click');
    expect(page.freedomAPI.openInNewTab).toHaveBeenCalledWith(HOSTILE_URL);

    await item.querySelector('.delete-btn').fire('click');
    await flush();
    expect(page.freedomAPI.removeHistory).toHaveBeenCalledWith(7);
    // The delete click must not also open the row.
    expect(page.freedomAPI.openInNewTab).toHaveBeenCalledTimes(1);
  });

  test('both the grouped and the flat layout render through the DOM', async () => {
    const page = await run([entry(), entry({ id: 8, title: 'Other', url: 'https://ok.test/' })]);
    const container = page.elements['history-container'];
    expect(container.querySelectorAll('.date-group')).toHaveLength(1);
    expect(container.querySelectorAll('.history-item')).toHaveLength(2);

    const sort = page.elements['sort-select'];
    sort.value = 'title';
    await sort.fire('change');
    await flush();
    expect(page.freedomAPI.getHistoryPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'title', offset: 0 })
    );
    expect(container.querySelectorAll('.date-group')).toHaveLength(0);
    expect(container.querySelectorAll('.history-item')).toHaveLength(2);
    expect(sinkHits(page)).toEqual([]);
  });
});

describe('history loads a page at a time (#503)', () => {
  const entries = Array.from({ length: 450 }, (_, i) => ({
    id: i + 1,
    url: `https://site${i}.test/`,
    title: i === 300 ? 'Needle page' : `Page ${i}`,
    protocol: 'https',
    visit_count: 1,
    timestamp: Date.now() - i * 1000,
  }));

  const run = (overrides = {}) => {
    const freedomAPI = {
      getHistoryPage: jest.fn(async ({ query = '', offset = 0, limit = 200 } = {}) => {
        const q = query.trim().toLowerCase();
        const matched = q ? entries.filter((e) => e.title.toLowerCase().includes(q)) : entries;
        return {
          entries: matched.slice(offset, offset + limit),
          matched: matched.length,
          total: entries.length,
        };
      }),
      removeHistory: jest.fn().mockResolvedValue(true),
      openInNewTab: jest.fn(),
      clearHistory: jest.fn(),
      ...overrides,
    };
    return runPageScript('history', {
      ids: {
        'history-container': 'div',
        'search-input': 'input',
        'clear-btn': 'button',
        'sort-select': 'select',
        stats: 'p',
      },
      freedomAPI,
    }).then((page) => ({ ...page, freedomAPI }));
  };

  const items = (page) => page.elements['history-container'].querySelectorAll('.history-item');
  const showMore = (page) =>
    page.elements['history-container']
      .querySelectorAll('button')
      .find((b) => b.id === 'show-more-btn');

  test('asks main for one page, never the whole table', async () => {
    const page = await run();
    expect(page.freedomAPI.getHistoryPage).toHaveBeenCalledTimes(1);
    expect(page.freedomAPI.getHistoryPage).toHaveBeenCalledWith({
      query: '',
      sort: 'recent',
      offset: 0,
      limit: 200,
    });
    expect(items(page)).toHaveLength(200);
    expect(page.elements.stats.textContent).toBe('450 pages');
  });

  test('"Show more" appends the next page until everything is shown', async () => {
    const page = await run();
    expect(showMore(page).textContent).toBe('Show more (250 remaining)');
    await showMore(page).fire('click');
    await flush();
    expect(page.freedomAPI.getHistoryPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 200, limit: 200 })
    );
    expect(items(page)).toHaveLength(400);
    expect(showMore(page).textContent).toBe('Show more (50 remaining)');
    await showMore(page).fire('click');
    await flush();
    expect(items(page)).toHaveLength(450);
    expect(showMore(page)).toBeUndefined();
    // Rows stay unique and in the order main sent them.
    const ids = items(page).map((item) => Number(item.dataset.id));
    expect(ids).toEqual(entries.map((e) => e.id));
  });

  test('search is a query to main, and the counter shows matched of total', async () => {
    const page = await run();
    const input = page.elements['search-input'];
    input.value = 'needle';
    await input.fire('input');
    // Debounced: the last queued timer runs the search.
    page.timers.at(-1)();
    await flush();
    expect(page.freedomAPI.getHistoryPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'needle', offset: 0 })
    );
    expect(items(page)).toHaveLength(1);
    expect(page.elements.stats.textContent).toBe('1 of 450 pages');
    expect(showMore(page)).toBeUndefined();
  });

  test('a slower, older response never replaces a newer one', async () => {
    let releaseFirst;
    const page = await run();
    const input = page.elements['search-input'];
    page.freedomAPI.getHistoryPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ entries: entries.slice(0, 5), matched: 450, total: 450 });
        })
    );
    input.value = 'page';
    await input.fire('input');
    page.timers.at(-1)();
    input.value = 'needle';
    await input.fire('input');
    page.timers.at(-1)();
    await flush();
    expect(items(page)).toHaveLength(1);
    releaseFirst();
    await flush();
    expect(items(page)).toHaveLength(1);
    expect(items(page)[0].querySelector('.history-title').textContent).toBe('Needle page');
  });

  test('delete drops the row in place and moves the counter', async () => {
    const page = await run();
    const first = items(page)[0];
    await first.querySelector('.delete-btn').fire('click');
    await flush();
    expect(page.freedomAPI.removeHistory).toHaveBeenCalledWith(1);
    expect(page.freedomAPI.getHistoryPage).toHaveBeenCalledTimes(1);
    expect(items(page)).toHaveLength(199);
    expect(page.elements.stats.textContent).toBe('449 pages');
    expect(showMore(page).textContent).toBe('Show more (250 remaining)');
  });
});

describe('downloads renders site strings as text (#432)', () => {
  const download = (overrides = {}) => ({
    id: 3,
    filename: HOSTILE,
    url: HOSTILE_URL,
    state: 'completed',
    received_bytes: 2048,
    total_bytes: 2048,
    start_time: Date.now(),
    end_time: Date.now(),
    is_private: false,
    ...overrides,
  });

  const run = (entries) => {
    const freedomAPI = {
      getDownloads: jest.fn().mockResolvedValue(entries),
      removeDownload: jest.fn().mockResolvedValue(true),
      openDownloadedFile: jest.fn().mockResolvedValue({ success: true }),
      showDownloadInFolder: jest.fn().mockResolvedValue({ success: true }),
      pauseDownload: jest.fn(),
      resumeDownload: jest.fn(),
      cancelDownload: jest.fn(),
      clearDownloads: jest.fn(),
      onDownloadsChanged: jest.fn(),
    };
    return runPageScript('downloads', {
      ids: {
        'downloads-container': 'div',
        'search-input': 'input',
        'clear-btn': 'button',
        stats: 'p',
      },
      freedomAPI,
    }).then((page) => ({ ...page, freedomAPI }));
  };

  test('filename and URL land verbatim in text, never in an HTML write', async () => {
    const page = await run([download({ is_private: true })]);
    const item = page.elements['downloads-container'].querySelector('.download-item');
    expect(item.className).toBe('download-item state-completed');
    const name = item.querySelector('.download-name');
    expect(name.childNodes[0].textContent).toBe(HOSTILE);
    expect(name.querySelector('[data-test="download-private-badge"]').textContent).toBe('Private');
    expect(item.querySelector('.download-url').textContent).toBe(HOSTILE_URL);
    expect(page.elements['downloads-container'].querySelectorAll('img')).toEqual([]);
    expect(sinkHits(page)).toEqual([]);
  });

  test('completed rows open, show and remove by id', async () => {
    const page = await run([download()]);
    const item = page.elements['downloads-container'].querySelector('.download-item');
    const actions = item.querySelectorAll('[data-action]').map((btn) => btn.dataset.action);
    expect(actions).toEqual(['open', 'show', 'remove']);

    await item.querySelector('[data-action="open"]').fire('click');
    expect(page.freedomAPI.openDownloadedFile).toHaveBeenCalledWith(3);
    await flush();
    // The click re-rendered the list; act on the fresh row.
    const container = page.elements['downloads-container'];
    await container.querySelector('[data-action="remove"]').fire('click');
    expect(page.freedomAPI.removeDownload).toHaveBeenCalledWith(3);
  });

  test('a failed Open shows its error on the row, as text', async () => {
    const page = await run([download()]);
    page.freedomAPI.openDownloadedFile.mockResolvedValue({ success: false, error: HOSTILE });
    const container = page.elements['downloads-container'];
    await container.querySelector('[data-action="open"]').fire('click');
    const status = container.querySelector('.download-status');
    expect(status.className).toBe('download-status error');
    expect(status.textContent).toBe(HOSTILE);
    expect(sinkHits(page)).toEqual([]);
  });

  test('in-progress rows keep pause/cancel and a progress bar', async () => {
    const page = await run([
      download({ state: 'in_progress', received_bytes: 512, total_bytes: 2048 }),
    ]);
    const item = page.elements['downloads-container'].querySelector('.download-item');
    const actions = item.querySelectorAll('[data-action]').map((btn) => btn.dataset.action);
    expect(actions).toEqual(['pause', 'cancel']);
    expect(item.querySelector('.progress-fill').style.width).toBe('25%');
  });

  test('a stalled row offers Resume only when Chromium can resume it', async () => {
    const stalled = { state: 'in_progress', is_paused: true, received_bytes: 1 };
    const actionsOf = async (entry) => {
      const page = await run([download(entry)]);
      return page.elements['downloads-container']
        .querySelectorAll('[data-action]')
        .map((btn) => btn.dataset.action);
    };
    expect(await actionsOf({ ...stalled, can_resume: true })).toEqual(['resume', 'cancel']);
    expect(await actionsOf({ ...stalled, can_resume: false })).toEqual(['cancel']);
  });
});

describe('payments renders site strings as text (#432)', () => {
  const run = (payments, networks) =>
    runPageScript('payments', {
      ids: {
        results: 'div',
        stats: 'p',
        'search-input': 'input',
        'kind-select': 'select',
        'chain-select': 'select',
        'clear-btn': 'button',
      },
      freedomAPI: {
        getNetworkConfig: jest.fn().mockResolvedValue({
          success: true,
          networks: networks || {
            1: { name: 'Ethereum', shortName: 'eth', blockExplorer: 'https://etherscan.io' },
          },
        }),
        getTokens: jest.fn().mockResolvedValue({ success: true, tokens: {} }),
        getPayments: jest.fn().mockResolvedValue({ success: true, payments }),
        clearPayments: jest.fn(),
        onPaymentRecorded: jest.fn(),
      },
    });

  const payment = (overrides = {}) => ({
    kind: 'x402',
    origin: HOSTILE_URL,
    amount: '1',
    chainId: 1,
    status: 'settled',
    toAddress: HOSTILE,
    txHash: '0xabc',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  test('origin and address land verbatim in text, never in an HTML write', async () => {
    const page = await run([payment()]);
    const row = page.elements.results.querySelector('tbody').querySelector('tr');
    const site = row.querySelector('.site');
    expect(site.textContent).toBe(HOSTILE_URL);
    expect(site.children[0].title).toBe(HOSTILE_URL);
    const to = row.querySelectorAll('td')[4];
    expect(to.title).toBe(HOSTILE);
    expect(page.elements.results.querySelectorAll('img')).toEqual([]);
    expect(sinkHits(page)).toEqual([]);
  });

  test('a hostile status cannot inject classes', async () => {
    const page = await run([payment({ status: 'x onerror=1' })]);
    const pill = page.elements.results.querySelector('.status-pill');
    expect(pill.className).toBe('status-pill');
    expect(pill.textContent).toBe('x onerror=1');
  });

  test('network names reach the chain filter as text', async () => {
    const page = await run([payment()], {
      1: { name: HOSTILE, shortName: 'x', blockExplorer: 'https://etherscan.io' },
    });
    const [option] = page.elements['chain-select'].children;
    expect(option.textContent).toBe(HOSTILE);
    expect(option.value).toBe('1');
    expect(sinkHits(page)).toEqual([]);
  });

  test('only an http(s) block explorer becomes a link', async () => {
    const linked = await run([payment()]);
    expect(linked.elements.results.querySelector('.tx-link').href).toBe(
      'https://etherscan.io/tx/0xabc'
    );

    const unlinked = await run([payment()], {
      1: { name: 'Bad', shortName: 'bad', blockExplorer: 'javascript:alert(1)//' },
    });
    expect(unlinked.elements.results.querySelector('.tx-link')).toBeNull();
    const plain = unlinked.elements.results
      .querySelectorAll('.addr')
      .find((el) => el.title === '0xabc');
    expect(plain.textContent).toBe('0xabc');
  });
});
