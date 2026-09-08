/**
 * Download hardening for the embedded Radicle addon.
 *
 * Two properties this script must hold, both of which it lacked:
 *  - every request is bounded and retried, because `npm run radicle:download`
 *    runs inside the `dist:linux:*:docker` release recipes where a stalled
 *    GitHub connection would otherwise hang until the outer CI timeout;
 *  - SHA256SUMS is only trusted after it matches an in-repo pinned digest —
 *    it ships from the same mutable release as the addon, and the addon is
 *    loaded into the main process and shipped inside signed packages.
 *
 * `https` is mocked rather than served for real (fetch-ant.test.js
 * convention): the code under test hardcodes https:// and refuses to
 * downgrade across a redirect, so a plain local listener can't stand in.
 */

const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

jest.mock('https');
jest.mock('fs');

const fs = require('fs');
const {
  platformKey,
  fetchBuffer,
  withRetries,
  main,
  PINNED_SHA256SUMS,
  REQUEST_TIMEOUT_MS,
  MAX_ATTEMPTS,
} = require('./fetch-radicle-addon');
const { RADICLE_ADDON_RELEASE_TAG } = require('../src/shared/radicle-addon-version');

// Build a fake `https.get` that replays scripted responses in order and
// records the url and the request objects it handed back.
function mockResponses(responses) {
  const calls = [];
  https.get.mockImplementation((url, callback) => {
    calls.push({ url });
    const scripted = responses[calls.length - 1];
    if (!scripted) throw new Error(`Unexpected request #${calls.length} to ${url}`);

    const req = new EventEmitter();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    calls[calls.length - 1].req = req;

    const res = new EventEmitter();
    res.statusCode = scripted.statusCode;
    res.headers = scripted.headers || {};
    res.resume = jest.fn();

    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        if (scripted.error) return res.emit('error', scripted.error);
        if (scripted.body !== undefined) res.emit('data', Buffer.from(scripted.body));
        res.emit('end');
      });
    });
    return req;
  });
  return calls;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// The SHA256SUMS asset published with the pinned libradicle release,
// verbatim. Its digest is what PINNED_SHA256SUMS.digest records.
const RELEASE_SHA256SUMS = [
  '0c9817a029365e8e754aa85b4d19a1584e0951dd02454fb5f7684110fafb95ca  libradicle-linux-arm64.node',
  '439fce8049718484cadb2176102739b6229d81540b01ac56e90aa5d0445aefff  libradicle-linux-x64.node',
  '807ef2c0679ee3cedebf9ef2f9f4c012f921b2f43bdcba52d3715a35e6d4d210  libradicle-mac-arm64.node',
  '9bc1f1746485d4fd1075611f1e71430f5acf1b146aff0f3c62687fb6f10cb65c  libradicle-mac-x64.node',
  '9e0f08c7a2403101efd76a65d23fce8e2407d365a124195250ddb7504ec57041  libradicle-win-arm64.node',
  '710c0b0beae606da80884eec9f87d4995449f67862431da4eb62609ce12eb650  libradicle-win-x64.node',
  '',
].join('\n');

afterEach(() => {
  jest.resetAllMocks();
  jest.useRealTimers();
});

describe('platform key', () => {
  test('defaults to the host platform and honours explicit flags', () => {
    expect(platformKey([], 'linux', 'x64')).toBe('linux-x64');
    expect(platformKey(['--win', '--arm64'], 'darwin', 'arm64')).toBe('win-arm64');
    expect(platformKey(['--mac'], 'linux', 'arm64')).toBe('mac-arm64');
  });
});

describe('fetchBuffer', () => {
  test('bounds every request with a timeout', async () => {
    const calls = mockResponses([{ statusCode: 200, body: 'payload' }]);
    await expect(fetchBuffer('https://example.test/asset')).resolves.toEqual(
      Buffer.from('payload')
    );
    expect(calls[0].req.setTimeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS, expect.any(Function));
  });

  test('destroys the request when the timeout fires', async () => {
    const calls = mockResponses([{ statusCode: 200, body: 'payload' }]);
    const pending = fetchBuffer('https://example.test/asset');
    await pending;
    const [, onTimeout] = calls[0].req.setTimeout.mock.calls[0];
    onTimeout();
    expect(calls[0].req.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('timed out') })
    );
  });

  test.each([301, 302, 303, 307, 308])('follows a %i redirect', async (statusCode) => {
    const calls = mockResponses([
      { statusCode, headers: { location: '/moved/asset' } },
      { statusCode: 200, body: 'payload' },
    ]);
    await expect(fetchBuffer('https://example.test/asset')).resolves.toEqual(
      Buffer.from('payload')
    );
    expect(calls[1].url).toBe('https://example.test/moved/asset');
  });

  test('refuses a redirect that downgrades to plain HTTP', async () => {
    mockResponses([{ statusCode: 302, headers: { location: 'http://example.test/asset' } }]);
    await expect(fetchBuffer('https://example.test/asset')).rejects.toThrow(
      /non-HTTPS redirect/
    );
  });

  test('gives up after too many redirects instead of looping forever', async () => {
    mockResponses(
      Array.from({ length: 8 }, () => ({
        statusCode: 302,
        headers: { location: 'https://example.test/loop' },
      }))
    );
    await expect(fetchBuffer('https://example.test/asset')).rejects.toThrow(/too many redirects/);
  });

  test('surfaces a non-200 status', async () => {
    mockResponses([{ statusCode: 404 }]);
    await expect(fetchBuffer('https://example.test/asset')).rejects.toThrow(/HTTP 404/);
  });
});

describe('withRetries', () => {
  test('retries a transient failure and resolves', async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const run = withRetries('Test', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNRESET');
      return 'ok';
    });
    await jest.advanceTimersByTimeAsync(10000);
    await expect(run).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  test(`gives up after ${MAX_ATTEMPTS} attempts`, async () => {
    jest.useFakeTimers();
    let attempts = 0;
    const run = withRetries('Test', async () => {
      attempts += 1;
      throw new Error('ECONNRESET');
    });
    const assertion = expect(run).rejects.toThrow('ECONNRESET');
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(attempts).toBe(MAX_ATTEMPTS);
  });
});

describe('SHA256SUMS trust root', () => {
  // The digest is only meaningful while it describes the release actually
  // being downloaded — a version bump without a digest bump must be loud.
  test('pins the digest to the release tag the app builds against', () => {
    expect(PINNED_SHA256SUMS.tag).toBe(RADICLE_ADDON_RELEASE_TAG);
    expect(PINNED_SHA256SUMS.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('matches the digest of the published SHA256SUMS asset', () => {
    expect(sha256(Buffer.from(RELEASE_SHA256SUMS))).toBe(PINNED_SHA256SUMS.digest);
  });

  // Acceptance: the real published sums file clears the pin, so the run
  // proceeds to the per-asset checksum comparison (the fixture binary is
  // not the real addon, so that is where it stops).
  test('accepts the published SHA256SUMS and verifies the asset against it', async () => {
    mockResponses([
      { statusCode: 200, body: Buffer.from('not-the-real-addon') },
      { statusCode: 200, body: RELEASE_SHA256SUMS },
    ]);
    await expect(main([], 'linux', 'x64')).rejects.toThrow(
      /checksum mismatch for libradicle-linux-x64\.node/
    );
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  // The attack the pin exists for: whoever re-publishes the release swaps
  // the addon and its checksums together, so a self-consistent pair proves
  // nothing. Without the pin this run would install the addon.
  test('refuses a re-published release whose sums file does not match the pin', async () => {
    const binary = Buffer.from('malicious-addon-bytes');
    const asset = `libradicle-${platformKey([], 'linux', 'x64')}.node`;
    const sums = `${sha256(binary)}  ${asset}\n`;
    mockResponses([
      { statusCode: 200, body: binary },
      { statusCode: 200, body: sums },
    ]);
    await expect(main([], 'linux', 'x64')).rejects.toThrow(/pinned digest/);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
