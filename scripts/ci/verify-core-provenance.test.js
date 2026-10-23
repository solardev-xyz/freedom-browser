const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

jest.mock('https');
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const envKeys = [
  'FREEDOM_IPFSD_RELEASE_TAG',
  'FREEDOM_CORE_RELEASE_TAG',
  'FREEDOM_CORE_REPO',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalExitCode = process.exitCode;
const TEST_TAG = 'ipfsd-v0.1.0-test';
let verifier;
let fetcher;
let https;
let execFileSync;
let dir;

/** Loads the verifier and the ipfsd fetcher, with `tag` as the override. */
function load(tag = TEST_TAG) {
  jest.resetModules();
  if (tag === null) delete process.env.FREEDOM_IPFSD_RELEASE_TAG;
  else process.env.FREEDOM_IPFSD_RELEASE_TAG = tag;
  verifier = require('./verify-core-provenance');
  fetcher = require('../fetch-freedom-ipfsd');
  https = require('https');
  ({ execFileSync } = require('child_process'));
}

// The real download helper runs against mocked HTTPS, as in
// fetch-freedom-ipfsd.test.js. No network is used.
function mockResponses(responses) {
  const calls = [];
  https.get.mockImplementation((url, options, callback) => {
    const scripted = responses[calls.length];
    const req = new PassThrough();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    calls.push({ url });
    if (!scripted) throw new Error(`Unexpected request to ${url}`);
    process.nextTick(() => {
      const res = new PassThrough();
      res.statusCode = scripted.statusCode;
      res.headers = scripted.headers || {};
      res.complete = true;
      callback(res);
      process.nextTick(() => res.end(scripted.body));
    });
    return req;
  });
  return calls;
}

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function releaseFixture(tag = TEST_TAG) {
  const downloads = fetcher.TARGETS.map((target) => {
    const version = tag.replace(/^ipfsd-/, '');
    const name = `freedom-ipfsd-${version}-${target.keywords.join('-')}.${target.exe ? 'zip' : 'tar.gz'}`;
    return {
      name,
      browser_download_url: `https://assets.example/${name}`,
      body: Buffer.from(name),
    };
  });
  const sums = downloads.map((a) => `${hash(a.body)}  ${a.name}\n`).join('');
  const release = {
    tag_name: tag,
    assets: [
      { name: 'SHA256SUMS', browser_download_url: 'https://assets.example/SHA256SUMS' },
      ...downloads.map(({ body: _body, ...asset }) => asset),
    ],
  };
  return { release, downloads, sums };
}

function serve(fixture, bodies = fixture.downloads.map((a) => a.body)) {
  return mockResponses([
    { statusCode: 200, body: JSON.stringify(fixture.release) },
    { statusCode: 200, body: fixture.sums },
    ...bodies.map((body) => ({ statusCode: 200, body })),
  ]);
}

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  load();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-provenance-'));
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

describe('verify-core-provenance', () => {
  test('each binary names the workflow that attests its releases', () => {
    expect(require('../fetch-freedom-cored').provenanceWorkflow).toBe('release.yml');
    expect(fetcher.provenanceWorkflow).toBe('release-ipfsd.yml');
  });

  test('verifies SHA256SUMS and every archive against the workflow at the tag', async () => {
    const fixture = releaseFixture();
    serve(fixture);
    const verified = [];
    execFileSync.mockImplementation((command, args) => {
      expect(command).toBe('gh');
      // The file exists, with the bytes whose digest was checked, while gh runs.
      verified.push(path.basename(args[2]));
      expect(fs.existsSync(args[2])).toBe(true);
    });
    await verifier.verify(fetcher, { workDir: dir });
    expect(verified).toEqual(['SHA256SUMS', ...fixture.downloads.map((a) => a.name)]);
    for (const [, args] of execFileSync.mock.calls) {
      expect(args).toEqual([
        'attestation',
        'verify',
        args[2],
        '--repo',
        'solardev-xyz/freedom-core',
        '--signer-workflow',
        'solardev-xyz/freedom-core/.github/workflows/release-ipfsd.yml',
        '--source-ref',
        `refs/tags/${TEST_TAG}`,
        '--deny-self-hosted-runners',
      ]);
    }
    // Nothing is left behind.
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('a SHA256SUMS without the pinned digest is refused before anything is verified', async () => {
    load(null);
    serve(releaseFixture(fetcher.PINNED_RELEASE_TAG));
    await expect(verifier.verify(fetcher, { workDir: dir })).rejects.toThrow(
      /does not match the pinned digest/
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('an archive whose digest SHA256SUMS does not name is refused', async () => {
    const fixture = releaseFixture();
    const bodies = fixture.downloads.map((a) => a.body);
    bodies[2] = Buffer.from('swapped');
    serve(fixture, bodies);
    await expect(verifier.verify(fetcher, { workDir: dir })).rejects.toThrow(/Checksum mismatch/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('a release that is not the tag asked for, or a draft, is refused', async () => {
    const fixture = releaseFixture();
    mockResponses([
      { statusCode: 200, body: JSON.stringify({ ...fixture.release, tag_name: 'ipfsd-v9.9.9' }) },
    ]);
    await expect(verifier.verify(fetcher, { workDir: dir })).rejects.toThrow(/Unexpected/);
    mockResponses([{ statusCode: 200, body: JSON.stringify({ ...fixture.release, draft: true }) }]);
    await expect(verifier.verify(fetcher, { workDir: dir })).rejects.toThrow(/Unexpected/);
  });

  test('a floating release is refused: provenance names a tag', async () => {
    load('latest');
    await expect(verifier.verify(fetcher, { workDir: dir })).rejects.toThrow(/floating release/);
  });

  test('a failed verification fails the run', async () => {
    serve(releaseFixture());
    execFileSync.mockImplementation(() => {
      throw new Error('gh: verification failed');
    });
    await verifier.main(['ipfsd']);
    expect(process.exitCode).toBe(1);
  });

  test('only cored and ipfsd are verified', async () => {
    for (const argv of [[], ['ant'], ['toString'], ['cored', 'ipfsd']]) {
      process.exitCode = undefined;
      await verifier.main(argv);
      expect(process.exitCode).toBe(1);
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
