/**
 * Filter-list download for the bundled adblock catalog.
 *
 * easylist.to and secure.fanboy.co.nz drop connections under load — the
 * v0.8.5-rc.1 release run died on exactly that — so this script has always
 * retried. It now shares one policy with every other fetcher
 * (scripts/lib/fetch-with-retry.js): 5xx/429/connection errors and timeouts
 * are retried, anything else is final.
 *
 * `https` is mocked rather than served for real (fetch-ant.test.js convention).
 */

const https = require('https');
const { PassThrough } = require('stream');

jest.mock('https');

const crypto = require('crypto');
const {
  CATEGORIES,
  RESOURCES,
  ADBLOCKER_VERSION,
  countRules,
  download,
  fetchList,
  fetchResources,
  resolveUblockText,
} = require('./fetch-adblock-lists');

function mockResponses(responses) {
  const calls = [];
  https.get.mockImplementation((url, options, callback) => {
    const scripted = responses[calls.length];
    const req = new PassThrough();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    calls.push({ url, headers: options.headers, req });
    if (!scripted) throw new Error(`Unexpected request #${calls.length} to ${url}`);
    process.nextTick(() => {
      if (scripted.requestError) {
        req.emit('error', scripted.requestError);
        return;
      }
      const res = new PassThrough();
      res.statusCode = scripted.statusCode;
      res.headers = scripted.headers || {};
      res.complete = scripted.complete !== false;
      callback(res);
      process.nextTick(() => {
        if (scripted.body !== undefined) res.write(Buffer.from(scripted.body));
        res.end();
      });
    });
    return req;
  });
  return calls;
}

const noWait = { sleep: () => Promise.resolve(), log: () => {} };
const LIST = '[Adblock Plus 2.0]\n||ads.example.com^\n! a comment\n';

afterEach(() => jest.resetAllMocks());

describe('catalog', () => {
  test('every category names an https source and a file', () => {
    for (const meta of Object.values(CATEGORIES)) {
      expect(meta.sourceUrl).toMatch(/^https:\/\//);
      for (const url of meta.extraSourceUrls || []) expect(url).toMatch(/^https:\/\//);
      expect(meta.file).toMatch(/\.txt$/);
    }
  });

  // The resources file is executable code injected into pages, pinned to the
  // @ghostery/adblocker release actually installed: bumping the library
  // without re-pinning (new tag + new sha256) fails here.
  test('the scriptlet resources pin tracks the installed @ghostery/adblocker', () => {
    expect(RESOURCES.tag).toBe(`v${ADBLOCKER_VERSION}`);
    expect(RESOURCES.sourceUrl).toContain(`/ghostery/adblocker/${RESOURCES.tag}/`);
    expect(RESOURCES.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // GPL-3.0 §6: the manifest and NOTICES name the exact uBlock Origin source
  // the minified scriptlets were built from, as URLs at a tag or commit.
  test('the scriptlet resources record their exact upstream source', () => {
    const { ublockOrigin, ghostery } = RESOURCES.upstream;
    expect(ublockOrigin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ublockOrigin.sourceUrl).toBe(
      `https://github.com/gorhill/uBlock/tree/${ublockOrigin.commit}/src/js/resources`
    );
    expect(ghostery.tag).toBe(RESOURCES.tag);
    expect(ghostery.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ghostery.buildScript).toContain(`/ghostery/adblocker/blob/${RESOURCES.tag}/`);
    const notices = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'NOTICES'),
      'utf8'
    );
    for (const url of [ublockOrigin.sourceUrl, ghostery.commitUrl, ghostery.buildScript]) {
      expect(notices).toContain(url);
    }
  });

  test('counts rules, ignoring comments and section headers', () => {
    expect(countRules(LIST)).toBe(1);
  });
});

describe('download', () => {
  test('retries a dropped connection and a 5xx, then returns the list', async () => {
    const calls = mockResponses([
      { requestError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
      { statusCode: 503 },
      { statusCode: 200, body: LIST },
    ]);
    await expect(download('https://easylist.test/easylist.txt', noWait)).resolves.toBe(LIST);
    expect(calls).toHaveLength(3);
  });

  // The exact shape that killed the v0.8.5-rc.1 release run: the server stops
  // talking part-way through the body.
  test('retries a response that is cut short mid-body', async () => {
    const calls = mockResponses([
      { statusCode: 200, body: '[Adblock Plus 2.0]\n||half', complete: false },
      { statusCode: 200, body: LIST },
    ]);
    await expect(download('https://easylist.test/easylist.txt', noWait)).resolves.toBe(LIST);
    expect(calls).toHaveLength(2);
  });

  test('never retries a 404', async () => {
    const calls = mockResponses([{ statusCode: 404 }]);
    await expect(download('https://easylist.test/gone.txt', noWait)).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
  });
});

// Same reasoning as a checksum: a 200 that is not a filter list is an answer,
// and shipping it would silently disable blocking.
describe('fetchList', () => {
  test('rejects a body that is not an ABP list, without asking again', async () => {
    const calls = mockResponses([{ statusCode: 200, body: '<html>captive portal</html>' }]);
    await expect(
      fetchList(
        'ads',
        { ...CATEGORIES.ads, sourceUrl: 'https://easylist.test/easylist.txt' },
        noWait
      )
    ).rejects.toThrow(/does not look like an ABP filter list/);
    expect(calls).toHaveLength(1);
  });

  test('accepts a real list', async () => {
    mockResponses([{ statusCode: 200, body: LIST }]);
    await expect(
      fetchList(
        'ads',
        { ...CATEGORIES.ads, sourceUrl: 'https://easylist.test/easylist.txt' },
        noWait
      )
    ).resolves.toEqual({ text: LIST, source: null });
  });
});

// uBlock's lists use `!#include` and `!#if`; the engine is built with
// preprocessors off, so both are resolved at build time.
describe('resolveUblockText', () => {
  const base = 'https://ubo.test/filters/filters.txt';

  test('keeps only the live branch of each !#if for a Chromium desktop build', async () => {
    const text = [
      'a##.always',
      '!#if env_chromium',
      'a##.chromium',
      '!#else',
      'a##.not-chromium',
      '!#endif',
      '!#if env_firefox',
      'a##.firefox',
      '!#endif',
      '!#if !ext_ubol',
      'a##.not-ubol',
      '!#if env_mobile',
      'a##.mobile-nested',
      '!#endif',
      '!#endif',
      '!#if cap_html_filtering',
      'a##^script',
      '!#else',
      'a##.no-html-filtering',
      '!#endif',
    ].join('\n');
    const out = await resolveUblockText(text, base, () => {
      throw new Error('no includes expected');
    });
    expect(out.split('\n')).toEqual([
      'a##.always',
      'a##.chromium',
      'a##.not-ubol',
      'a##.no-html-filtering',
    ]);
  });

  test('splices includes from the same directory, skipping ones in dead branches', async () => {
    const fetched = [];
    const files = {
      'https://ubo.test/filters/filters-2024.txt': 'b##.from-2024',
      'https://ubo.test/filters/filters-mobile.txt': 'b##.mobile',
    };
    const out = await resolveUblockText(
      [
        'a##.top',
        '!#include filters-2024.txt',
        '!#if env_mobile',
        '!#include filters-mobile.txt',
        '!#endif',
      ].join('\n'),
      base,
      async (url) => {
        fetched.push(url);
        return files[url];
      }
    );
    expect(out.split('\n')).toEqual(['a##.top', 'b##.from-2024']);
    expect(fetched).toEqual(['https://ubo.test/filters/filters-2024.txt']);
  });

  test.each(['../secrets.txt', 'https://elsewhere.test/filters/x.txt', '/other/x.txt'])(
    'refuses an out-of-tree include (%s)',
    async (name) => {
      await expect(resolveUblockText(`!#include ${name}`, base, async () => 'x')).rejects.toThrow(
        /out-of-tree/
      );
    }
  );

  test('rejects unbalanced directives instead of guessing', async () => {
    await expect(resolveUblockText('!#if env_chromium\na', base, jest.fn())).rejects.toThrow(
      /unterminated/
    );
    await expect(resolveUblockText('!#endif', base, jest.fn())).rejects.toThrow(/without/);
  });
});

describe('fetchResources', () => {
  test('refuses a resources file whose digest is not the in-repo pin', async () => {
    const calls = mockResponses([{ statusCode: 200, body: '{"scriptlets":[],"redirects":[]}' }]);
    await expect(fetchResources(noWait)).rejects.toThrow(/sha256 mismatch/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESOURCES.sourceUrl);
  });

  test('accepts the pinned bytes', async () => {
    // Stand-in for the real file: re-pin RESOURCES to its digest for the test.
    const body = JSON.stringify({
      scriptlets: [{ name: 'a.js', aliases: [], body: 'function a(){}', dependencies: [] }],
      redirects: [],
    });
    const original = RESOURCES.sha256;
    RESOURCES.sha256 = crypto.createHash('sha256').update(body).digest('hex');
    try {
      mockResponses([{ statusCode: 200, body }]);
      await expect(fetchResources(noWait)).resolves.toMatchObject({
        text: body,
        scriptletCount: 1,
      });
    } finally {
      RESOURCES.sha256 = original;
    }
  });
});

describe('fetchList (uBlock format)', () => {
  const SHA = 'b0c10f2fa1c411bfe81ff9f3ceb60aa5c5d02544';
  const RAW = `https://raw.githubusercontent.com/uBlockOrigin/uAssets/${SHA}/filters`;
  const LISTS = [
    { statusCode: 200, body: '! Title: uBlock filters\na##.main\n!#include filters-2024.txt' },
    { statusCode: 200, body: '! SECTION: no title here\nb##.included' },
    { statusCode: 200, body: '! Title: uBlock₀ filters – Quick fixes\nc##.quick' },
  ];
  const origToken = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (origToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = origToken;
  });

  test('rejects a top-level uBlock list without its title header', async () => {
    mockResponses([
      { statusCode: 200, body: SHA },
      { statusCode: 200, body: '<html>captive portal</html>' },
    ]);
    await expect(fetchList('ublock', CATEGORIES.ublock, noWait)).rejects.toThrow(
      /does not look like a uBlock filter list/
    );
  });

  test('pins the lists to the resolved uAssets commit, resolving includes', async () => {
    process.env.GITHUB_TOKEN = 'ci-token';
    const calls = mockResponses([{ statusCode: 200, body: `${SHA}\n` }, ...LISTS]);
    const { text, source } = await fetchList('ublock', CATEGORIES.ublock, noWait);
    // GPL-3.0 §5(a): the shipped file says it was modified, and how.
    expect(text).toMatch(/^! Title: uBlock filters \(Freedom build\)\n/);
    expect(text).toContain('! Modified: `!#if` blocks evaluated');
    expect(text).toContain('! License: GPL-3.0');
    // …and names the exact revision, as permanent GitHub URLs.
    expect(text).toContain(
      `!   https://github.com/uBlockOrigin/uAssets/blob/${SHA}/filters/filters.txt`
    );
    expect(text).toContain(`! (uBlockOrigin/uAssets commit ${SHA})`);
    expect(text.split('\n').filter((l) => l && !l.startsWith('!'))).toEqual([
      'a##.main',
      'b##.included',
      'c##.quick',
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/uBlockOrigin/uAssets/commits/gh-pages',
      `${RAW}/filters.txt`,
      `${RAW}/filters-2024.txt`,
      `${RAW}/quick-fixes.txt`,
    ]);
    expect(calls[0].headers.Authorization).toBe('Bearer ci-token');
    // The token never leaves GitHub's API host.
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(source).toMatchObject({
      repo: 'uBlockOrigin/uAssets',
      branch: 'gh-pages',
      commit: SHA,
      treeUrl: `https://github.com/uBlockOrigin/uAssets/tree/${SHA}`,
      urls: [
        `https://github.com/uBlockOrigin/uAssets/blob/${SHA}/filters/filters.txt`,
        `https://github.com/uBlockOrigin/uAssets/blob/${SHA}/filters/quick-fixes.txt`,
      ],
    });
    expect(source.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('falls back to the Pages URLs and the fetch date when the commit is unknown', async () => {
    const warnings = [];
    const calls = mockResponses([{ statusCode: 404 }, ...LISTS]);
    const { text, source } = await fetchList('ublock', CATEGORIES.ublock, {
      ...noWait,
      log: (m) => warnings.push(m),
    });
    expect(warnings.join('')).toMatch(/Could not resolve uBlockOrigin\/uAssets@gh-pages/);
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      'https://ublockorigin.github.io/uAssets/filters/filters.txt',
      'https://ublockorigin.github.io/uAssets/filters/filters-2024.txt',
      'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
    ]);
    expect(source.commit).toBeNull();
    expect(source.urls[0]).toBe('https://ublockorigin.github.io/uAssets/filters/filters.txt');
    expect(text).toContain('! (commit unresolved: fetched from the live site on ');
  });

  test('refuses an API answer that is not a commit sha', async () => {
    const warnings = [];
    mockResponses([{ statusCode: 200, body: '<html>captive portal</html>' }, ...LISTS]);
    const { source } = await fetchList('ublock', CATEGORIES.ublock, {
      ...noWait,
      log: (m) => warnings.push(m),
    });
    expect(source.commit).toBeNull();
    expect(warnings.join('')).toMatch(/unexpected answer/);
  });
});
