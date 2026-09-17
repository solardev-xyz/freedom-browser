/**
 * Release lookup and asset download for Ant.
 *
 * Redirects: GitHub answers an API request for a renamed repo with a 301 to
 * the new canonical location. Before this was handled, the solardev-xyz/ant →
 * freedom-hq/ant rename turned every `npm run ant:download` into a hard
 * failure and took out the e2e-ant and e2e-onboarding-identity CI jobs on
 * every branch, main included.
 *
 * Retries: both legs go through scripts/lib/fetch-with-retry.js. A single HTTP
 * 500 on the asset download failed the required `e2e-onboarding-identity
 * (windows-latest)` check on run 35211828052 — the old retry loop here wrapped
 * the request but the status check lived inside it, so a 500 was final.
 *
 * `https` is mocked rather than served for real: the code under test hardcodes
 * https:// (deliberately — it refuses to downgrade across a redirect), so a
 * plain local listener can't stand in for it.
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

jest.mock('https');

const {
  fetchRelease,
  releaseRequestHeaders,
  downloadFile,
  releaseUrl,
  ANT_REPO,
  PINNED_RELEASE_TAG,
} = require('./fetch-ant');
const { TIMEOUTS } = require('./lib/fetch-with-retry');

// Build a fake `https.get` that replays scripted responses in order and
// records the (url, options) each call was made with.
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
      const res = new PassThrough();
      res.statusCode = scripted.statusCode;
      res.headers = scripted.headers || {};
      res.complete = true;
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

// Never actually wait out a backoff in a unit test.
const noWait = { sleep: () => Promise.resolve(), log: () => {} };

// Mirrors the tag pinned in fetch-ant.js; the first test below asserts the two
// still agree, so a pin bump that leaves these fixtures stale fails the suite.
const PINNED_TAG = 'v0.5.44';
const RELEASE = { tag_name: PINNED_TAG, assets: [] };

afterEach(() => {
  jest.resetAllMocks();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

describe('fetch-ant release lookup', () => {
  test('points at the current upstream repo, freedom-hq/ant', () => {
    expect(ANT_REPO).toBe('freedom-hq/ant');
    expect(releaseUrl()).toMatch('https://api.github.com/repos/freedom-hq/ant/releases/');
    expect(PINNED_TAG).toBe(PINNED_RELEASE_TAG);
  });

  test('resolves a 200 without redirecting', async () => {
    const calls = mockResponses([{ statusCode: 200, body: JSON.stringify(RELEASE) }]);
    await expect(fetchRelease(undefined, noWait)).resolves.toEqual(RELEASE);
    expect(calls).toHaveLength(1);
  });

  // The regression the redirect handling fixed: a renamed repo must not be fatal.
  test('follows a 301 from a renamed repo to the new location', async () => {
    const calls = mockResponses([
      {
        statusCode: 301,
        headers: {
          location: 'https://api.github.com/repositories/1220484552/releases/tags/v0.5.44',
        },
      },
      { statusCode: 200, body: JSON.stringify(RELEASE) },
    ]);

    await expect(
      fetchRelease('https://api.github.com/repos/solardev-xyz/ant/releases/tags/v0.5.44', noWait)
    ).resolves.toEqual(RELEASE);

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/solardev-xyz/ant/releases/tags/v0.5.44',
      'https://api.github.com/repositories/1220484552/releases/tags/v0.5.44',
    ]);
  });

  test.each([302, 303, 307, 308])('follows a %i redirect', async (statusCode) => {
    mockResponses([
      { statusCode, headers: { location: '/repos/freedom-hq/ant/releases/tags/v0.5.44' } },
      { statusCode: 200, body: JSON.stringify(RELEASE) },
    ]);
    await expect(fetchRelease(undefined, noWait)).resolves.toEqual(RELEASE);
  });

  test('resolves a relative Location against the current URL', async () => {
    const calls = mockResponses([
      { statusCode: 301, headers: { location: '/repositories/1220484552/releases/latest' } },
      { statusCode: 200, body: JSON.stringify(RELEASE) },
    ]);
    await expect(fetchRelease(undefined, noWait)).resolves.toEqual(RELEASE);
    expect(calls[1].url).toBe('https://api.github.com/repositories/1220484552/releases/latest');
  });

  test('sends the GitHub token to api.github.com', async () => {
    process.env.GITHUB_TOKEN = 'ci-token';
    const calls = mockResponses([{ statusCode: 200, body: JSON.stringify(RELEASE) }]);
    await fetchRelease(undefined, noWait);
    expect(calls[0].headers.Authorization).toBe('Bearer ci-token');
  });

  // A redirect can point anywhere; forwarding Authorization off-host would
  // leak CI's GITHUB_TOKEN to a third party. The headers are recomputed for
  // every hop, which is what makes this hold.
  test('drops the GitHub token when a redirect leaves api.github.com', async () => {
    process.env.GITHUB_TOKEN = 'ci-token';
    const calls = mockResponses([
      { statusCode: 301, headers: { location: 'https://evil.example.com/releases' } },
      { statusCode: 200, body: JSON.stringify(RELEASE) },
    ]);
    await fetchRelease(undefined, noWait);
    expect(calls[0].headers.Authorization).toBe('Bearer ci-token');
    expect(calls[1].url).toBe('https://evil.example.com/releases');
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(
      releaseRequestHeaders('https://evil.example.com/releases').Authorization
    ).toBeUndefined();
  });

  // `new URL(undefined, base)` resolves to `<base>/undefined` instead of
  // throwing, so a missing Location must be rejected explicitly or the next
  // hop goes somewhere meaningless.
  test('rejects a redirect with no Location header, without retrying it', async () => {
    const calls = mockResponses([{ statusCode: 301, headers: {} }]);
    await expect(fetchRelease(undefined, noWait)).rejects.toThrow(/no Location header/);
    expect(calls).toHaveLength(1);
  });

  test('refuses a redirect that downgrades to plain HTTP', async () => {
    mockResponses([{ statusCode: 301, headers: { location: 'http://api.github.com/x' } }]);
    await expect(fetchRelease(undefined, noWait)).rejects.toThrow(/non-HTTPS redirect/);
  });

  test('gives up after too many redirects instead of looping forever', async () => {
    mockResponses(
      Array.from({ length: 7 }, () => ({
        statusCode: 301,
        headers: { location: 'https://api.github.com/loop' },
      }))
    );
    await expect(fetchRelease(undefined, noWait)).rejects.toThrow(/Too many redirects/);
  });

  test('retries a 500 on the release lookup and succeeds', async () => {
    const calls = mockResponses([
      { statusCode: 500 },
      { statusCode: 502 },
      { statusCode: 200, body: JSON.stringify(RELEASE) },
    ]);
    await expect(fetchRelease(undefined, noWait)).resolves.toEqual(RELEASE);
    expect(calls).toHaveLength(3);
  });

  test('still surfaces a non-redirect failure status, and does not retry a 404', async () => {
    const calls = mockResponses([{ statusCode: 404, body: '{"message":"Not Found"}' }]);
    await expect(fetchRelease(undefined, noWait)).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
  });

  test('rejects rather than throwing on a malformed JSON body', async () => {
    mockResponses([{ statusCode: 200, body: 'not json' }]);
    await expect(fetchRelease(undefined, noWait)).rejects.toThrow(/Invalid JSON/);
  });
});

describe('fetch-ant asset download', () => {
  let dir;
  let dest;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ant-'));
    dest = path.join(dir, 'antd-v0.5.44-windows-amd64.zip');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // The exact failure that took out the required check: one 500 on the asset,
  // no retry, red job.
  test('retries an HTTP 500 on the asset and writes the file once it succeeds', async () => {
    const calls = mockResponses([
      { statusCode: 500 },
      { statusCode: 500 },
      { statusCode: 200, body: 'antd-bytes' },
    ]);
    await downloadFile('https://github.test/antd.zip', dest, noWait);
    expect(calls).toHaveLength(3);
    expect(fs.readFileSync(dest, 'utf8')).toBe('antd-bytes');
  });

  test('leaves no partial file behind when the download keeps failing', async () => {
    mockResponses(Array.from({ length: 4 }, () => ({ statusCode: 503 })));
    await expect(downloadFile('https://github.test/antd.zip', dest, noWait)).rejects.toThrow(
      /HTTP 503/
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('gives the archive a per-attempt deadline sized for a binary, not for JSON', () => {
    expect(TIMEOUTS.binary).toBeGreaterThanOrEqual(5 * 60_000);
    expect(TIMEOUTS.metadata).toBe(30_000);
  });
});
