/**
 * Prebuilt-addon download for freedom-ipfs.
 *
 * This script had its own copy of the retry loop, with no bound on the
 * response body and a write straight into the destination path: a failed
 * attempt left a partial archive behind, and the *next* thing to touch it was
 * the checksum check. It now goes through scripts/lib/fetch-with-retry.js,
 * which writes to a temp file and renames on success.
 *
 * `https` is mocked rather than served for real (fetch-ant.test.js convention).
 */

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

jest.mock('https');

const {
  download,
  releaseTag,
  releaseManifest,
  packageTargetForPlatformKey,
} = require('./fetch-freedom-ipfs-native');

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
const URL_UNDER_TEST = 'https://github.test/freedom-ipfs-node-electron41-linux-x64.tar.gz';

let dir;
let destination;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-native-test-'));
  destination = path.join(dir, 'archives', 'addon.tar.gz');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  jest.resetAllMocks();
});

describe('pinned release', () => {
  test('ships a sha256 for every target of the pinned tag', () => {
    const manifest = releaseManifest();
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
    for (const [target, asset] of Object.entries(manifest)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.name).toContain(target);
    }
    expect(releaseTag).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test('maps node platform keys onto packaging targets', () => {
    expect(packageTargetForPlatformKey('linux-x64')).toBe('linux-x64');
    expect(packageTargetForPlatformKey('darwin-arm64')).toBe('mac-arm64');
    expect(packageTargetForPlatformKey('win32-x64')).toBe('win-x64');
    expect(packageTargetForPlatformKey('freebsd-x64')).toBeNull();
  });
});

describe('download', () => {
  test('retries a 5xx and writes the archive once an attempt succeeds', async () => {
    const calls = mockResponses([{ statusCode: 502 }, { statusCode: 200, body: 'archive-bytes' }]);
    await download(URL_UNDER_TEST, destination, noWait);
    expect(calls).toHaveLength(2);
    expect(fs.readFileSync(destination, 'utf8')).toBe('archive-bytes');
  });

  // The failure mode the temp-file-then-rename exists for: the checksum step
  // must never be handed the leftovers of an interrupted attempt.
  test('hands the checksum step a complete file or nothing at all', async () => {
    mockResponses([
      { statusCode: 200, body: 'truncated arch', complete: false },
      { statusCode: 200, body: 'archive-bytes' },
    ]);
    await download(URL_UNDER_TEST, destination, noWait);
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['addon.tar.gz']);
    expect(fs.readFileSync(destination, 'utf8')).toBe('archive-bytes');

    jest.resetAllMocks();
    mockResponses(Array.from({ length: 4 }, () => ({ statusCode: 500 })));
    const second = path.join(dir, 'archives', 'other.tar.gz');
    await expect(download(URL_UNDER_TEST, second, noWait)).rejects.toThrow(/HTTP 500/);
    expect(fs.existsSync(second)).toBe(false);
  });

  test('never retries a 404', async () => {
    const calls = mockResponses([{ statusCode: 404 }]);
    await expect(download(URL_UNDER_TEST, destination, noWait)).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
