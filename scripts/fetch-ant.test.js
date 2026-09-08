/**
 * Redirect handling for the Ant release lookup.
 *
 * GitHub answers an API request for a renamed repo with a 301 to the new
 * canonical location. Before this was handled, the solardev-xyz/ant →
 * freedom-hq/ant rename turned every `npm run ant:download` into a hard
 * failure and took out the e2e-ant and e2e-onboarding-identity CI jobs on
 * every branch, main included.
 *
 * `https` is mocked rather than served for real: the code under test hardcodes
 * https:// (deliberately — it refuses to downgrade across a redirect), so a
 * plain local listener can't stand in for it.
 */

const https = require('https');
const { EventEmitter } = require('events');

jest.mock('https');

const { fetchReleaseOnce, releaseUrl, ANT_REPO, PINNED_RELEASE_TAG } = require('./fetch-ant');

// Build a fake `https.get` that replays scripted responses in order and
// records the (url, options) each call was made with.
function mockResponses(responses) {
  const calls = [];
  https.get.mockImplementation((url, options, callback) => {
    calls.push({ url, headers: options.headers });
    const scripted = responses[calls.length - 1];
    if (!scripted) throw new Error(`Unexpected request #${calls.length} to ${url}`);

    const req = new EventEmitter();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();

    const res = new EventEmitter();
    res.statusCode = scripted.statusCode;
    res.headers = scripted.headers || {};
    res.resume = jest.fn();

    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        if (scripted.body !== undefined) res.emit('data', scripted.body);
        res.emit('end');
      });
    });
    return req;
  });
  return calls;
}

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
    await expect(fetchReleaseOnce()).resolves.toEqual(RELEASE);
    expect(calls).toHaveLength(1);
  });

  // The regression this PR fixes: a renamed repo must not be fatal.
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
      fetchReleaseOnce('https://api.github.com/repos/solardev-xyz/ant/releases/tags/v0.5.44')
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
    await expect(fetchReleaseOnce()).resolves.toEqual(RELEASE);
  });

  test('resolves a relative Location against the current URL', async () => {
    const calls = mockResponses([
      { statusCode: 301, headers: { location: '/repositories/1220484552/releases/latest' } },
      { statusCode: 200, body: JSON.stringify(RELEASE) },
    ]);
    await expect(fetchReleaseOnce()).resolves.toEqual(RELEASE);
    expect(calls[1].url).toBe('https://api.github.com/repositories/1220484552/releases/latest');
  });

  test('sends the GitHub token to api.github.com', async () => {
    process.env.GITHUB_TOKEN = 'ci-token';
    const calls = mockResponses([{ statusCode: 200, body: JSON.stringify(RELEASE) }]);
    await fetchReleaseOnce();
    expect(calls[0].headers.Authorization).toBe('Bearer ci-token');
  });

  // A redirect can point anywhere; forwarding Authorization off-host would
  // leak CI's GITHUB_TOKEN to a third party.
  test('drops the GitHub token when a redirect leaves api.github.com', async () => {
    process.env.GITHUB_TOKEN = 'ci-token';
    const calls = mockResponses([
      { statusCode: 301, headers: { location: 'https://evil.example.com/releases' } },
      { statusCode: 200, body: JSON.stringify(RELEASE) },
    ]);
    await fetchReleaseOnce();
    expect(calls[0].headers.Authorization).toBe('Bearer ci-token');
    expect(calls[1].url).toBe('https://evil.example.com/releases');
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  // `new URL(undefined, base)` resolves to `<base>/undefined` instead of
  // throwing, so a missing Location must be rejected explicitly or the next
  // hop goes somewhere meaningless.
  test('rejects a redirect with no Location header', async () => {
    const calls = mockResponses([{ statusCode: 301, headers: {} }]);
    await expect(fetchReleaseOnce()).rejects.toThrow(/no Location header/);
    expect(calls).toHaveLength(1);
  });

  test('refuses a redirect that downgrades to plain HTTP', async () => {
    mockResponses([{ statusCode: 301, headers: { location: 'http://api.github.com/x' } }]);
    await expect(fetchReleaseOnce()).rejects.toThrow(/non-HTTPS redirect/);
  });

  test('gives up after too many redirects instead of looping forever', async () => {
    mockResponses(
      Array.from({ length: 7 }, () => ({
        statusCode: 301,
        headers: { location: 'https://api.github.com/loop' },
      }))
    );
    await expect(fetchReleaseOnce()).rejects.toThrow(/Too many redirects/);
  });

  test('still surfaces a non-redirect failure status', async () => {
    mockResponses([{ statusCode: 404, body: '{"message":"Not Found"}' }]);
    await expect(fetchReleaseOnce()).rejects.toThrow(/Failed to fetch release .*: 404/);
  });

  test('rejects rather than throwing on a malformed JSON body', async () => {
    mockResponses([{ statusCode: 200, body: 'not json' }]);
    await expect(fetchReleaseOnce()).rejects.toThrow(/Invalid JSON/);
  });
});
