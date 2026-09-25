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
 * The bounding and retrying now come from scripts/lib/fetch-with-retry.js,
 * whose own suite pins the policy (which failures are retried, the backoff,
 * the two timeouts). What stays here is what is specific to this script: the
 * target selection, the trust root, and that neither checksum comparison is
 * ever retried.
 *
 * `https` is mocked rather than served for real (fetch-ant.test.js
 * convention): the code under test hardcodes https:// and refuses to
 * downgrade across a redirect, so a plain local listener can't stand in.
 */

const https = require('https');
const crypto = require('crypto');
const { PassThrough } = require('stream');

jest.mock('https');
jest.mock('fs');

const fs = require('fs');
const {
  platformKey,
  downloadAsset,
  main,
  PINNED_SHA256SUMS,
  MAX_ATTEMPTS,
} = require('./fetch-radicle-addon');
const { TIMEOUTS, IDLE_TIMEOUT_MS } = require('./lib/fetch-with-retry');
const { RADICLE_ADDON_RELEASE_TAG } = require('../src/shared/radicle-addon-version');

// Build a fake `https.get` that replays scripted responses in order and
// records the url and the request objects it handed back.
function mockResponses(responses) {
  const calls = [];
  https.get.mockImplementation((url, options, callback) => {
    const scripted = responses[calls.length];
    const req = new PassThrough();
    req.setTimeout = jest.fn((ms) => {
      req.idleTimeoutMs = ms;
    });
    req.destroy = jest.fn();
    calls.push({ url, req });
    if (!scripted) throw new Error(`Unexpected request #${calls.length} to ${url}`);

    process.nextTick(() => {
      if (scripted.requestError) {
        req.emit('error', scripted.requestError);
        return;
      }
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

const noWait = { sleep: () => Promise.resolve(), log: () => {} };
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
});

describe('platform key', () => {
  test('defaults to the host platform and honours explicit flags', () => {
    expect(platformKey([], 'linux', 'x64')).toBe('linux-x64');
    expect(platformKey(['--win', '--arm64'], 'darwin', 'arm64')).toBe('win-arm64');
    expect(platformKey(['--mac'], 'linux', 'arm64')).toBe('mac-arm64');
  });
});

describe('downloadAsset', () => {
  test('bounds each attempt with an inactivity timeout and an asset-sized deadline', async () => {
    const calls = mockResponses([{ statusCode: 200, body: 'payload' }]);
    await expect(downloadAsset('libradicle-linux-x64.node', noWait)).resolves.toEqual(
      Buffer.from('payload')
    );
    expect(calls[0].url).toBe(
      `https://github.com/solardev-xyz/libradicle/releases/download/${RADICLE_ADDON_RELEASE_TAG}/libradicle-linux-x64.node`
    );
    expect(calls[0].req.idleTimeoutMs).toBe(IDLE_TIMEOUT_MS);
    // A 20 MB addon gets the binary deadline; the sums file gets the short one.
    expect(TIMEOUTS.binary).toBeGreaterThan(TIMEOUTS.metadata);
  });

  test('retries a 5xx and a dropped connection, then succeeds', async () => {
    const calls = mockResponses([
      { statusCode: 503 },
      { requestError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
      { statusCode: 200, body: 'payload' },
    ]);
    await expect(downloadAsset('SHA256SUMS', noWait)).resolves.toEqual(Buffer.from('payload'));
    expect(calls).toHaveLength(3);
  });

  test(`gives up after ${MAX_ATTEMPTS} attempts, naming the URL and the count`, async () => {
    mockResponses(Array.from({ length: MAX_ATTEMPTS }, () => ({ statusCode: 500 })));
    await expect(downloadAsset('SHA256SUMS', noWait)).rejects.toThrow(
      /failed after 4 attempt\(s\) of 4: HTTP 500 for https:\/\/github\.com\/.*SHA256SUMS/
    );
  });

  test('never retries a 404 — a missing asset is an answer, not weather', async () => {
    const calls = mockResponses([{ statusCode: 404 }]);
    await expect(downloadAsset('SHA256SUMS', noWait)).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
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
  // not the real addon, so that is where it stops). Exactly two requests are
  // scripted, so a retry of the mismatch would fail the test with
  // "Unexpected request #3" — the checksum check is outside the retry loop.
  test('accepts the published SHA256SUMS and verifies the asset against it', async () => {
    const calls = mockResponses([
      { statusCode: 200, body: Buffer.from('not-the-real-addon') },
      { statusCode: 200, body: RELEASE_SHA256SUMS },
    ]);
    await expect(main([], 'linux', 'x64')).rejects.toThrow(
      /checksum mismatch for libradicle-linux-x64\.node/
    );
    expect(calls).toHaveLength(2);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  // The attack the pin exists for: whoever re-publishes the release swaps
  // the addon and its checksums together, so a self-consistent pair proves
  // nothing. Without the pin this run would install the addon.
  test('refuses a re-published release whose sums file does not match the pin', async () => {
    const binary = Buffer.from('malicious-addon-bytes');
    const asset = `libradicle-${platformKey([], 'linux', 'x64')}.node`;
    const sums = `${sha256(binary)}  ${asset}\n`;
    const calls = mockResponses([
      { statusCode: 200, body: binary },
      { statusCode: 200, body: sums },
    ]);
    await expect(main([], 'linux', 'x64')).rejects.toThrow(/pinned digest/);
    expect(calls).toHaveLength(2);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
