const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

jest.mock('https');
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

// The previous freedom-cored release (design 0013's "previous core release"
// for PRF-6's rollout tests): its pin, checked as fetch-freedom-cored.test.js
// checks the app's. GITHUB_ACTIONS too: in CI the fetch verifies build
// provenance with gh, which these tests don't run.
const envKeys = [
  'GITHUB_ACTIONS',
  'FREEDOM_CORE_PREVIOUS_RELEASE_TAG',
  'FREEDOM_CORE_RELEASE_TAG',
  'FREEDOM_CORE_REPO',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalExitCode = process.exitCode;
const PINNED_TAG = 'cored-v0.22.0';
const PINNED_DIGEST = '82cb1566adf8b681e7f4009e9a0ebbaf0ff1202f714ca6e99e71f0ece4a807ef';
// The SHA256SUMS cored-v0.22.0 published, byte for byte (the app's pin before
// cored-v0.23.0 carried it). Its sha256 is the pinned digest.
const PUBLISHED_SUMS = [
  '99f852109f23557252b5d5d74f96d703df782fc32657e8b993e108b33df81b49  freedom-cored-v0.22.0-darwin-amd64.tar.gz',
  'c5cc25c78eead8379768fd6ceb75f6bde2a38ac7e55d6d458125239127e972e4  freedom-cored-v0.22.0-darwin-arm64.tar.gz',
  '82f81f908a66d38681d37f55ef901ec3669e32b89a0006cd0c8187c660546d19  freedom-cored-v0.22.0-linux-amd64.tar.gz',
  '80778832e7292c2347f7681708a351ba1bee81adc6b57f28f8cc4dca280912fb  freedom-cored-v0.22.0-linux-arm64.tar.gz',
  '813d5cd6eac96c3ddb6c890e7fb85980ae55cd90ca2391c085ecb5ceac18540c *freedom-cored-v0.22.0-windows-amd64.zip',
  '',
].join('\n');
let fetcher;
let https;
let execFileSync;
let dir;

function load(tag) {
  jest.resetModules();
  if (tag === undefined) delete process.env.FREEDOM_CORE_PREVIOUS_RELEASE_TAG;
  else process.env.FREEDOM_CORE_PREVIOUS_RELEASE_TAG = tag;
  fetcher = require('./fetch-freedom-cored-previous');
  https = require('https');
  ({ execFileSync } = require('child_process'));
}

// The real retry/redirect/streaming helper against mocked HTTPS, as in
// fetch-freedom-cored.test.js. No network or repository binary directories.
function mockResponses(responses) {
  const calls = [];
  https.get.mockImplementation((url, options, callback) => {
    const scripted = responses[calls.length];
    const req = new PassThrough();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    calls.push({ url, headers: options.headers });
    if (!scripted) throw new Error(`Unexpected request to ${url}`);
    process.nextTick(() => {
      const res = new PassThrough();
      res.statusCode = scripted.statusCode;
      res.headers = scripted.headers || {};
      res.complete = true;
      callback(res);
      process.nextTick(() => {
        res.end(scripted.body);
      });
    });
    return req;
  });
  return calls;
}

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function releaseFixture(tag) {
  const downloads = fetcher.TARGETS.map((target) => {
    const version = tag.replace(/^cored-/, '');
    const name = `freedom-cored-${version}-${target.keywords.join('-')}.${target.exe ? 'zip' : 'tar.gz'}`;
    return {
      name,
      browser_download_url: `https://assets.example/${name}`,
      body: Buffer.from(name),
    };
  });
  const sums = downloads
    .map((a) => `${hash(a.body)} ${a.name.endsWith('.zip') ? '*' : ' '}${a.name}\n`)
    .join('');
  const release = {
    tag_name: tag,
    assets: [
      { name: 'SHA256SUMS', browser_download_url: 'https://assets.example/SHA256SUMS' },
      ...downloads.map(({ body: _body, ...asset }) => asset),
    ],
  };
  return { release, downloads, sums };
}

function installResponses(fixture) {
  return mockResponses([
    { statusCode: 200, body: JSON.stringify(fixture.release) },
    { statusCode: 200, body: fixture.sums },
    ...fixture.downloads.map((a) => ({ statusCode: 200, body: a.body })),
  ]);
}

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  load();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-cored-previous-'));
  process.exitCode = undefined;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = originalExitCode;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  jest.restoreAllMocks();
});

describe('the previous release pin', () => {
  test('pins cored-v0.22.0 into its own directory, apart from the app pin', () => {
    expect(fetcher.PINNED_RELEASE_TAG).toBe(PINNED_TAG);
    expect(fetcher.RELEASE_TAG).toBe(PINNED_TAG);
    expect(fetcher.CORE_REPO).toBe('solardev-xyz/freedom-core');
    expect(fetcher.binary).toBe('freedom-cored');
    expect(fetcher.provenanceWorkflow).toBe('release.yml');
    expect(fetcher.releaseUrl()).toBe(
      `https://api.github.com/repos/solardev-xyz/freedom-core/releases/tags/${PINNED_TAG}`
    );
    const app = require('./fetch-freedom-cored');
    expect(app.PINNED_RELEASE_TAG).not.toBe(PINNED_TAG);
    // The app pin's override doesn't move this one.
    process.env.FREEDOM_CORE_RELEASE_TAG = 'cored-v9.9.9';
    load();
    expect(fetcher.RELEASE_TAG).toBe(PINNED_TAG);
  });

  test('takes its own override, and refuses the tags the app pin refuses', async () => {
    load('cored-v0.21.0');
    expect(fetcher.RELEASE_TAG).toBe('cored-v0.21.0');
    for (const tag of ['ipfsd-v0.1.0', 'radicled-v0.1.0', 'cored-0.6.0', 'cored-cored-v0.6.0']) {
      expect(require('./fetch-freedom-cored').TAG_PATTERN.test(tag)).toBe(false);
      load('latest');
      const fixture = releaseFixture('cored-v0.22.0');
      fixture.release.tag_name = tag;
      const calls = installResponses(fixture);
      process.exitCode = undefined;
      await fetcher.main({ outputDir: dir });
      expect(process.exitCode).toBe(1);
      expect(calls).toHaveLength(1);
    }
  });

  test('the published SHA256SUMS is the pinned digest, and names every target', () => {
    expect(hash(Buffer.from(PUBLISHED_SUMS, 'utf8'))).toBe(PINNED_DIGEST);
    const published = Object.keys(fetcher.parseChecksums(PUBLISHED_SUMS)).sort();
    const assets = published.map((name) => ({ name }));
    const named = fetcher.TARGETS.map(
      (target) => fetcher.assetFor(assets, target, PINNED_TAG)?.name
    );
    expect(named.sort()).toEqual(published);
  });

  test('a SHA256SUMS that differs from the pinned digest fails closed before extracting', async () => {
    const calls = installResponses(releaseFixture(PINNED_TAG));
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(2);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Error:',
      expect.objectContaining({
        message: expect.stringMatching(/does not match the pinned digest/),
      })
    );
  });

  test('accepts the published SHA256SUMS against the pinned digest', async () => {
    const fixture = releaseFixture(PINNED_TAG);
    fixture.sums = PUBLISHED_SUMS;
    // The fixture's archives are not the published ones, so the first fails
    // its checksum: past the pinned digest, never extracted.
    const calls = installResponses(fixture);
    await fetcher.main({ outputDir: dir });
    expect(console.log).toHaveBeenCalledWith(
      'Verified SHA256SUMS against the in-repo pinned digest'
    );
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(3);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Error:',
      expect.objectContaining({
        message: expect.stringMatching(
          /^Checksum mismatch for freedom-cored-v0\.22\.0-darwin-arm64\.tar\.gz: expected c5cc25c7/
        ),
      })
    );
  });
});
