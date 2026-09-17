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

const { CATEGORIES, countRules, download, fetchList } = require('./fetch-adblock-lists');

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
      expect(meta.file).toMatch(/\.txt$/);
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
    ).resolves.toBe(LIST);
  });
});
