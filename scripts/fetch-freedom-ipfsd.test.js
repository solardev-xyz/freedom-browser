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
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const TEST_TAG = 'ipfsd-v0.1.0-test';
const PINNED_TAG = 'ipfsd-v0.1.0';
// The SHA256SUMS ipfsd-v0.1.0 published, byte for byte. Its sha256 is the
// pinned digest, so a bump has to replace it along with the tag and digest.
const PUBLISHED_SUMS = [
  'dc33affddea78a9575e521ee87d672c552dcf44876c8ae8d7e8bec5a399314e9  freedom-ipfsd-v0.1.0-darwin-amd64.tar.gz',
  '99ec0d5082df73b961bd0bd8e8d413dfb52ad36b710b8779e2ee9463b78dee37  freedom-ipfsd-v0.1.0-darwin-arm64.tar.gz',
  '112c7078e2b07615410c215fd700e2e3e168b69d70115e8041910ac25dea602c  freedom-ipfsd-v0.1.0-linux-amd64.tar.gz',
  '95a1cb0ecd9897dd86e71848687ecdd8147b611d90e6dadc9b8996d1021a70d4  freedom-ipfsd-v0.1.0-linux-arm64.tar.gz',
  '38309237f41c08d58d838ca98a906d787ffc96d8f003f8dfe93135095c00776b *freedom-ipfsd-v0.1.0-windows-amd64.zip',
  '',
].join('\n');
const noWait = { sleep: () => Promise.resolve(), log: () => {} };
let fetcher;
let https;
let execFileSync;
let dir;

/** Loads the fetcher with `tag` as the override; `null` loads it unset. */
function load(tag = TEST_TAG) {
  jest.resetModules();
  if (tag === null) delete process.env.FREEDOM_IPFSD_RELEASE_TAG;
  else process.env.FREEDOM_IPFSD_RELEASE_TAG = tag;
  fetcher = require('./fetch-freedom-ipfsd');
  https = require('https');
  ({ execFileSync } = require('child_process'));
  // A reload brings a fresh child_process mock.
  execFileSync.mockImplementation(extractRequested);
}

// The real retry/redirect/streaming helper runs against mocked HTTPS, as in
// fetch-freedom-cored.test.js. No network or repository binary directories
// are used.
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

function installResponses(fixture, bodies = fixture.downloads.map((a) => a.body)) {
  return mockResponses([
    { statusCode: 200, body: JSON.stringify(fixture.release) },
    { statusCode: 200, body: fixture.sums },
    ...bodies.map((body) => ({ statusCode: 200, body })),
  ]);
}

// Extracts the requested members (everything after the archive name).
function extractRequested(_command, args, options) {
  for (const member of args.slice(2)) {
    const body = member.startsWith('freedom-ipfsd') ? 'verified-binary' : `notice ${member}`;
    fs.writeFileSync(path.join(options.cwd, member), body);
  }
}

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  load();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ipfsd-'));
  process.exitCode = undefined;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', originalPlatform);
  process.exitCode = originalExitCode;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  jest.restoreAllMocks();
});

describe('release lookup and downloads', () => {
  test('uses the pinned upstream tag by default', () => {
    load(null);
    expect(fetcher.PINNED_RELEASE_TAG).toBe(PINNED_TAG);
    expect(fetcher.CORE_REPO).toBe('solardev-xyz/freedom-core');
    expect(fetcher.releaseUrl()).toBe(
      `https://api.github.com/repos/solardev-xyz/freedom-core/releases/tags/${PINNED_TAG}`
    );
  });

  test("the core's tag override does not move the service's pin", () => {
    process.env.FREEDOM_CORE_RELEASE_TAG = 'cored-v9.9.9';
    load(null);
    expect(fetcher.releaseUrl()).toMatch(new RegExp(`/releases/tags/${PINNED_TAG}$`));
  });

  test('supports an explicit latest override for local testing', () => {
    load('latest');
    expect(fetcher.releaseUrl()).toMatch(/\/releases\/latest$/);
  });

  test('follows repository redirects and never forwards tokens off the API host', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const release = releaseFixture().release;
    const calls = mockResponses([
      {
        statusCode: 301,
        headers: { location: 'https://api.github.com/repositories/123/releases/latest' },
      },
      { statusCode: 302, headers: { location: 'https://other.example/release' } },
      { statusCode: 200, body: JSON.stringify(release) },
    ]);
    await expect(fetcher.fetchRelease(undefined, noWait)).resolves.toEqual(release);
    expect(calls[0].headers.Authorization).toBe('Bearer test-token');
    expect(calls[1].headers.Authorization).toBe('Bearer test-token');
    expect(calls[2].headers.Authorization).toBeUndefined();
  });

  test('refuses HTTP redirects', async () => {
    mockResponses([{ statusCode: 301, headers: { location: 'http://other.example/release' } }]);
    await expect(fetcher.fetchRelease(undefined, noWait)).rejects.toThrow(/non-HTTPS redirect/);
  });

  test('retries transient release failures but not a missing release', async () => {
    const release = releaseFixture().release;
    const calls = mockResponses([
      { statusCode: 500 },
      { statusCode: 200, body: JSON.stringify(release) },
    ]);
    await expect(fetcher.fetchRelease(undefined, noWait)).resolves.toEqual(release);
    expect(calls).toHaveLength(2);
    const missing = mockResponses([{ statusCode: 404 }]);
    await expect(fetcher.fetchRelease(undefined, noWait)).rejects.toThrow(/HTTP 404/);
    expect(missing).toHaveLength(1);
  });

  test('retries an asset download without leaking the GitHub token', async () => {
    process.env.GH_TOKEN = 'test-token';
    const calls = mockResponses([{ statusCode: 503 }, { statusCode: 200, body: 'archive' }]);
    const dest = path.join(dir, 'archive');
    await fetcher.downloadFile('https://assets.example/archive', dest, noWait);
    expect(fs.readFileSync(dest, 'utf8')).toBe('archive');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.headers.Authorization)).toBe(true);
  });

  test('an install sends the token with the release lookup only', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const calls = installResponses(releaseFixture());
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(calls[0].headers.Authorization).toBe('Bearer test-token');
    expect(calls.slice(1).every((call) => !call.headers.Authorization)).toBe(true);
  });

  test('cleans partial downloads when every attempt fails', async () => {
    mockResponses(Array.from({ length: 4 }, () => ({ statusCode: 503 })));
    await expect(
      fetcher.downloadFile('https://assets.example/archive', path.join(dir, 'archive'), noWait)
    ).rejects.toThrow(/HTTP 503/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('manifest and asset selection', () => {
  test('parses GNU, BSD and Windows checksum lines', () => {
    expect(
      fetcher.parseChecksums(`${'A'.repeat(64)}  unix.tar.gz\r\n${'b'.repeat(64)} *win.zip\n\n`)
    ).toEqual({ 'unix.tar.gz': 'a'.repeat(64), 'win.zip': 'b'.repeat(64) });
  });

  test.each([
    'not a checksum',
    `${'a'.repeat(64)}  ../bin`,
    `${'a'.repeat(64)}  dir\\bin`,
    `${'a'.repeat(64)}  ..`,
  ])('rejects malformed or unsafe checksum entries: %s', (line) => {
    expect(() => fetcher.parseChecksums(line)).toThrow(/Invalid SHA256SUMS/);
  });

  test('rejects duplicate checksum names', () => {
    const line = `${'a'.repeat(64)}  bin\n`;
    expect(() => fetcher.parseChecksums(line.repeat(2))).toThrow(/Duplicate checksum/);
  });

  test('matches exact target archives, excluding sidecars and lookalikes', () => {
    const { release } = releaseFixture();
    for (const target of fetcher.TARGETS) {
      const asset = fetcher.assetFor(release.assets, target, TEST_TAG);
      const distractors = [
        { ...asset, name: `${asset.name}.sha256` },
        { ...asset, name: `other-${asset.name}` },
        // The core's archive for the same version and target.
        { ...asset, name: asset.name.replace('freedom-ipfsd-', 'freedom-cored-') },
      ];
      expect(fetcher.assetFor([...distractors, ...release.assets], target, TEST_TAG)).toBe(asset);
      expect(fetcher.assetFor(distractors, target, TEST_TAG)).toBeUndefined();
      expect(() => fetcher.assetFor([asset, asset], target, TEST_TAG)).toThrow(
        /Duplicate release asset/
      );
    }
  });

  test('an ipfsd-v tag names its archives by the version alone', () => {
    expect(fetcher.archiveVersion(PINNED_TAG)).toBe('v0.1.0');
    // Only the service's prefix is dropped.
    expect(fetcher.archiveVersion('cored-v0.1.0')).toBe('cored-v0.1.0');
    const { release } = releaseFixture(PINNED_TAG);
    for (const target of fetcher.TARGETS) {
      const asset = fetcher.assetFor(release.assets, target, PINNED_TAG);
      expect(asset.name).toMatch(/^freedom-ipfsd-v0\.1\.0-/);
      // The tag's own spelling is never an archive name.
      const prefixed = {
        ...asset,
        name: asset.name.replace('freedom-ipfsd-', `freedom-ipfsd-${PINNED_TAG}-`),
      };
      expect(fetcher.assetFor([prefixed], target, PINNED_TAG)).toBeUndefined();
    }
  });

  test('names exactly the archives the pinned release published', () => {
    const published = Object.keys(fetcher.parseChecksums(PUBLISHED_SUMS)).sort();
    const assets = published.map((name) => ({ name }));
    const named = fetcher.TARGETS.map(
      (target) => fetcher.assetFor(assets, target, PINNED_TAG)?.name
    );
    expect(named.sort()).toEqual(published);
  });
});

describe('verified installation', () => {
  test('installs all five targets and copies verified x64 Windows bytes to ARM64', async () => {
    const calls = installResponses(releaseFixture());
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(calls).toHaveLength(7);
    expect(execFileSync).toHaveBeenCalledTimes(5);
    for (const target of fetcher.TARGETS) {
      const bin = path.join(
        dir,
        `${target.os}-${target.arch}`,
        target.exe ? 'freedom-ipfsd.exe' : 'freedom-ipfsd'
      );
      expect(fs.readFileSync(bin, 'utf8')).toBe('verified-binary');
      if (!target.exe && process.platform !== 'win32')
        expect(fs.statSync(bin).mode & 0o777).toBe(0o755);
    }
    for (const target of [...fetcher.TARGETS, { os: 'win', arch: 'arm64' }]) {
      for (const notice of fetcher.NOTICE_FILES) {
        expect(fs.readFileSync(path.join(dir, `${target.os}-${target.arch}`, notice), 'utf8')).toBe(
          `notice ${notice}`
        );
      }
    }
    expect(fs.readFileSync(path.join(dir, 'win-arm64', 'freedom-ipfsd.exe'))).toEqual(
      fs.readFileSync(path.join(dir, 'win-x64', 'freedom-ipfsd.exe'))
    );
    expect(fs.readdirSync(dir).some((entry) => entry.startsWith('.fetch-'))).toBe(false);
    for (const [_command, args, options] of execFileSync.mock.calls) {
      expect(args[2]).toMatch(/^freedom-ipfsd(?:\.exe)?$/);
      expect(args.slice(3)).toEqual(fetcher.NOTICE_FILES);
      expect(args[1]).not.toMatch(/[/\\]/);
      expect(options.shell).toBeUndefined();
    }
  });

  test('uses System32 bsdtar for Windows ZIPs and tarballs with bare archive filenames', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    installResponses(releaseFixture());
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(
      execFileSync.mock.calls.every(
        ([bin]) => bin === path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      )
    ).toBe(true);
  });

  test('accepts the published SHA256SUMS against the pinned digest', async () => {
    load(null);
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
          /^Checksum mismatch for freedom-ipfsd-v0\.1\.0-darwin-arm64\.tar\.gz: expected 99ec0d50/
        ),
      })
    );
  });

  test('a SHA256SUMS that differs from the pinned digest fails closed before extracting', async () => {
    load(PINNED_TAG);
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
    expect(fs.readdirSync(dir).filter((entry) => entry !== 'SHA256SUMS')).toEqual([]);
  });

  test('an overridden tag skips the pinned digest, and says so', async () => {
    installResponses(releaseFixture());
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^FREEDOM_IPFSD_RELEASE_TAG=ipfsd-v0\.1\.0-test overrides/)
    );
  });

  test('a checksum failure preserves the previous binary and never extracts corrupt bytes', async () => {
    const fixture = releaseFixture();
    const previous = path.join(dir, 'mac-arm64', 'freedom-ipfsd');
    fs.mkdirSync(path.dirname(previous));
    fs.writeFileSync(previous, 'previous-binary');
    const calls = installResponses(fixture, [Buffer.from('tampered')]);
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(3);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(previous, 'utf8')).toBe('previous-binary');
    expect(fs.readdirSync(dir).some((entry) => entry.startsWith('.fetch-'))).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      'Error:',
      expect.objectContaining({ message: expect.stringMatching(/^Checksum mismatch for /) })
    );
  });

  test.each(['missing-archive', 'missing-checksum', 'missing-manifest', 'duplicate-manifest'])(
    'refuses %s without downloading archives',
    async (kind) => {
      const fixture = releaseFixture();
      if (kind === 'missing-archive') fixture.release.assets.pop();
      if (kind === 'missing-checksum') fixture.sums = fixture.sums.split('\n').slice(1).join('\n');
      if (kind === 'missing-manifest') fixture.release.assets.shift();
      if (kind === 'duplicate-manifest') fixture.release.assets.push(fixture.release.assets[0]);
      const calls = installResponses(fixture);
      await fetcher.main({ outputDir: dir });
      expect(process.exitCode).toBe(1);
      expect(calls.length).toBeLessThanOrEqual(2);
      expect(execFileSync).not.toHaveBeenCalled();
    }
  );

  test('installs from an ipfsd-v release that latest names', async () => {
    load('latest');
    const calls = installResponses(releaseFixture(PINNED_TAG));
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBeUndefined();
    expect(calls).toHaveLength(7);
    expect(fs.existsSync(path.join(dir, 'linux-x64', 'freedom-ipfsd'))).toBe(true);
  });

  test.each([
    'cored-v0.6.0',
    'v0.6.0',
    'radicled-v0.1.0',
    'ipfsd-0.1.0',
    'ipfsd-ipfsd-v0.1.0',
    'ipfsd-v0.1',
    'IPFSD-v0.1.0',
  ])('refuses a %s release that latest names', async (tag) => {
    load('latest');
    const fixture = releaseFixture();
    fixture.release.tag_name = tag;
    const calls = installResponses(fixture);
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      'Error:',
      expect.objectContaining({ message: 'Unexpected freedom-ipfsd release tag or draft release' })
    );
  });

  test.each(['wrong-tag', 'unsafe-tag', 'draft'])('refuses %s metadata', async (kind) => {
    const fixture = releaseFixture();
    if (kind === 'wrong-tag') fixture.release.tag_name = 'ipfsd-v9.0.0';
    if (kind === 'unsafe-tag') fixture.release.tag_name = '../bad';
    if (kind === 'draft') fixture.release.draft = true;
    const calls = installResponses(fixture);
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
  });

  // Every requested member is extracted except the one under test, which is
  // missing, a directory, a symlink or a hard link: the binary (args[2]) or a
  // notice file.
  test.each(
    ['missing', 'directory', 'symlink', 'hardlink'].flatMap((kind) => [
      [kind, 'freedom-ipfsd'],
      [kind, 'THIRD-PARTY-NOTICES'],
      [kind, 'THIRD-PARTY-NOTICES-rust-std.html'],
    ])
  )('rejects an archive with a %s %s', async (kind, member) => {
    installResponses(releaseFixture());
    let lstatSpy;
    execFileSync.mockImplementation((_bin, args, options) => {
      expect(args[2]).toMatch(/^freedom-ipfsd(?:\.exe)?$/);
      let target;
      for (const name of args.slice(2)) {
        const file = path.join(options.cwd, name);
        const isTarget = name.replace(/\.exe$/, '') === member;
        if (isTarget) target = file;
        if (isTarget && kind === 'missing') continue;
        if (isTarget && kind === 'directory') fs.mkdirSync(file);
        else fs.writeFileSync(file, 'extracted');
      }
      if (kind === 'symlink' || kind === 'hardlink') {
        // Windows contributors need no symlink privilege to check rejection.
        const lstat = lstatSpy ? lstatSpy.getMockImplementation() : fs.lstatSync;
        lstatSpy = jest
          .spyOn(fs, 'lstatSync')
          .mockImplementation((file) =>
            file === target
              ? { isFile: () => kind !== 'symlink', nlink: kind === 'hardlink' ? 2 : 1 }
              : lstat(file)
          );
      }
    });
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      'Error:',
      expect.objectContaining({ message: expect.stringContaining(`has no regular ${member}`) })
    );
    expect(fs.existsSync(path.join(dir, 'mac-arm64', 'freedom-ipfsd'))).toBe(false);
  });
});
