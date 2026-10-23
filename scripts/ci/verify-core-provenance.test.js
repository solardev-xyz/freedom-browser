/**
 * In CI, every freedom-core fetch verifies the build provenance of what it
 * installs (scripts/lib/freedom-core-release.js), however a workflow runs it:
 * `SHA256SUMS` and each archive go through `gh attestation verify` before
 * anything is extracted, and nothing turns that off in CI. Outside CI the
 * fetch is unchanged. scripts/ci/verify-core-provenance.js runs the same
 * check by hand, for a bump.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

jest.mock('https');
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const envKeys = [
  'GITHUB_ACTIONS',
  'FREEDOM_IPFSD_RELEASE_TAG',
  'FREEDOM_CORE_RELEASE_TAG',
  'FREEDOM_CORE_REPO',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalExitCode = process.exitCode;
const TEST_TAG = 'ipfsd-v0.1.0-test';
let fetcher;
let https;
let execFileSync;
let gh;
let dir;

/** Loads the ipfsd fetcher with `tag` as the override. */
function load(tag = TEST_TAG) {
  jest.resetModules();
  if (tag === null) delete process.env.FREEDOM_IPFSD_RELEASE_TAG;
  else process.env.FREEDOM_IPFSD_RELEASE_TAG = tag;
  fetcher = require('../fetch-freedom-ipfsd');
  https = require('https');
  ({ execFileSync } = require('child_process'));
  // `gh` runs `gh(args)`; tar and unzip extract the requested members.
  gh = jest.fn();
  execFileSync.mockImplementation((command, args, options) => {
    if (command === 'gh') return gh(args);
    for (const member of args.slice(2)) {
      const body = member.startsWith('freedom-ipfsd') ? 'verified-binary' : `notice ${member}`;
      fs.writeFileSync(path.join(options.cwd, member), body);
    }
    return undefined;
  });
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

/** In order: `gh <file>` and `extract <archive>` for each command run. */
function commands() {
  return execFileSync.mock.calls.map(([command, args]) =>
    command === 'gh' ? `gh ${path.basename(args[2])}` : `extract ${args[1]}`
  );
}

function installed() {
  return fetcher.TARGETS.filter((target) =>
    fs.existsSync(path.join(dir, `${target.os}-${target.arch}`))
  );
}

function inCi() {
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_TOKEN = 'test-token';
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

describe('in CI, a fetch verifies the build provenance of what it installs', () => {
  test('each binary names the workflow that attests its releases', () => {
    expect(require('../fetch-freedom-cored').provenanceWorkflow).toBe('release.yml');
    expect(fetcher.provenanceWorkflow).toBe('release-ipfsd.yml');
  });

  test('SHA256SUMS and each archive are verified, each before anything is extracted', async () => {
    inCi();
    const fixture = releaseFixture();
    serve(fixture);
    gh.mockImplementation((args) => {
      // The file is there, with the bytes whose digest was checked.
      expect(fs.existsSync(args[2])).toBe(true);
    });
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(commands()).toEqual([
      'gh SHA256SUMS',
      ...fixture.downloads.flatMap((a) => [`gh ${a.name}`, `extract ${a.name}`]),
    ]);
    for (const [args] of gh.mock.calls) {
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
    expect(installed()).toHaveLength(fetcher.TARGETS.length);
  });

  test('a missing gh fails the fetch, with nothing installed', async () => {
    inCi();
    serve(releaseFixture());
    gh.mockImplementation(() => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/gh is not installed/);
    expect(commands()).toEqual(['gh SHA256SUMS']);
    expect(installed()).toEqual([]);
  });

  test('a missing attestation fails the fetch before any archive is fetched', async () => {
    inCi();
    const requests = serve(releaseFixture());
    gh.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: gh attestation verify'), {
        status: 1,
        message: 'no attestations found for subject',
      });
    });
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(
      /SHA256SUMS .* did not verify: no attestations found/
    );
    // The release and SHA256SUMS only.
    expect(requests).toHaveLength(2);
    expect(installed()).toEqual([]);
  });

  test('a failed verification fails the fetch, and that archive is never extracted', async () => {
    inCi();
    const fixture = releaseFixture();
    serve(fixture);
    const refused = fixture.downloads[2].name;
    gh.mockImplementation((args) => {
      if (path.basename(args[2]) === refused) {
        throw Object.assign(new Error('Command failed: gh attestation verify'), { status: 1 });
      }
    });
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(commands()).not.toContain(`extract ${refused}`);
    expect(commands().at(-1)).toBe(`gh ${refused}`);
    expect(installed()).toEqual(fetcher.TARGETS.slice(0, 2));
  });

  test('a missing token fails the fetch before any download', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    const requests = serve(releaseFixture());
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/needs GH_TOKEN or GITHUB_TOKEN/);
    expect(requests).toHaveLength(0);
  });

  test('a floating release is refused in CI', async () => {
    load('latest');
    inCi();
    const requests = mockResponses([]);
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test('nothing turns it off in CI: not the option, not a repository override', async () => {
    inCi();
    process.env.GH_TOKEN = 'other-token';
    process.env.FREEDOM_CORE_REPO = 'someone/fork';
    load();
    const fixture = releaseFixture();
    const requests = serve(fixture);
    await fetcher.main({ outputDir: dir, verifyProvenance: false });
    expect(process.exitCode).toBeUndefined();
    // The fetch looks where it's told, but only freedom-core's own release
    // workflow is accepted as the builder.
    expect(requests[0].url).toContain('/repos/someone/fork/');
    expect(gh).toHaveBeenCalledTimes(1 + fixture.downloads.length);
    for (const [args] of gh.mock.calls) {
      expect(args).toContain('solardev-xyz/freedom-core');
      expect(args.join(' ')).not.toContain('someone/fork');
    }
  });
});

describe('outside CI, the fetch is unchanged', () => {
  test.each([undefined, 'false', ''])('GITHUB_ACTIONS=%p runs no gh', async (value) => {
    if (value !== undefined) process.env.GITHUB_ACTIONS = value;
    serve(releaseFixture());
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(gh).not.toHaveBeenCalled();
    expect(installed()).toHaveLength(fetcher.TARGETS.length);
  });
});

describe('verify-core-provenance, for a bump', () => {
  test('fetches into a temporary directory with verification on, then removes it', async () => {
    process.env.GH_TOKEN = 'test-token';
    const fixture = releaseFixture();
    serve(fixture);
    const verifier = require('./verify-core-provenance');
    await verifier.main(['ipfsd'], { workDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(gh).toHaveBeenCalledTimes(1 + fixture.downloads.length);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('a failed verification exits 1', async () => {
    process.env.GH_TOKEN = 'test-token';
    serve(releaseFixture());
    gh.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: gh attestation verify'), { status: 1 });
    });
    await require('./verify-core-provenance').main(['ipfsd'], { workDir: dir });
    expect(process.exitCode).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test.each([[[]], [['nope']], [['cored', 'ipfsd']]])('usage %p exits 1', async (argv) => {
    await require('./verify-core-provenance').main(argv, { workDir: dir });
    expect(process.exitCode).toBe(1);
  });
});
