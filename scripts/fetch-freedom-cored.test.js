const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');

jest.mock('https');
jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const envKeys = ['FREEDOM_CORE_RELEASE_TAG', 'FREEDOM_CORE_REPO', 'GITHUB_TOKEN', 'GH_TOKEN'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const originalExitCode = process.exitCode;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const TEST_TAG = 'v0.1.0-test';
const PINNED_TAG = 'v0.1.0';
const noWait = { sleep: () => Promise.resolve(), log: () => {} };
let fetcher;
let https;
let execFileSync;
let dir;

function load(tag = TEST_TAG) {
  jest.resetModules();
  if (tag === undefined) delete process.env.FREEDOM_CORE_RELEASE_TAG;
  else process.env.FREEDOM_CORE_RELEASE_TAG = tag;
  fetcher = require('./fetch-freedom-cored');
  https = require('https');
  ({ execFileSync } = require('child_process'));
}

// The real retry/redirect/streaming helper runs against mocked HTTPS, as in
// fetch-ant.test.js. No network or repository binary directories are used.
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
    const name = `freedom-cored-${tag}-${target.keywords.join('-')}.${target.exe ? 'zip' : 'tar.gz'}`;
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

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  load();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-cored-'));
  process.exitCode = undefined;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  execFileSync.mockImplementation((_command, args, options) => {
    fs.writeFileSync(path.join(options.cwd, args.at(-1)), 'verified-binary');
  });
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
    delete process.env.FREEDOM_CORE_RELEASE_TAG;
    jest.resetModules();
    const pinned = require('./fetch-freedom-cored');
    expect(pinned.PINNED_RELEASE_TAG).toBe(PINNED_TAG);
    expect(pinned.CORE_REPO).toBe('solardev-xyz/freedom-core');
    expect(pinned.releaseUrl()).toBe(
      `https://api.github.com/repos/solardev-xyz/freedom-core/releases/tags/${PINNED_TAG}`
    );
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
      ];
      expect(fetcher.assetFor([...distractors, ...release.assets], target, TEST_TAG)).toBe(asset);
      expect(fetcher.assetFor(distractors, target, TEST_TAG)).toBeUndefined();
      expect(() => fetcher.assetFor([asset, asset], target, TEST_TAG)).toThrow(
        /Duplicate release asset/
      );
    }
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
        target.exe ? 'freedom-cored.exe' : 'freedom-cored'
      );
      expect(fs.readFileSync(bin, 'utf8')).toBe('verified-binary');
      if (!target.exe && process.platform !== 'win32')
        expect(fs.statSync(bin).mode & 0o777).toBe(0o755);
    }
    expect(fs.readFileSync(path.join(dir, 'win-arm64', 'freedom-cored.exe'))).toEqual(
      fs.readFileSync(path.join(dir, 'win-x64', 'freedom-cored.exe'))
    );
    expect(fs.readdirSync(dir).some((entry) => entry.startsWith('.fetch-'))).toBe(false);
    for (const [_command, args, options] of execFileSync.mock.calls) {
      expect(args.at(-1)).toMatch(/^freedom-cored(?:\.exe)?$/);
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

  test('the pending pinned digest fails closed before extracting any binary', async () => {
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
  });

  test('a checksum failure preserves the previous binary and never extracts corrupt bytes', async () => {
    const fixture = releaseFixture();
    const previous = path.join(dir, 'mac-arm64', 'freedom-cored');
    fs.mkdirSync(path.dirname(previous));
    fs.writeFileSync(previous, 'previous-binary');
    const calls = installResponses(fixture, [Buffer.from('tampered')]);
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(3);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(previous, 'utf8')).toBe('previous-binary');
    expect(fs.readdirSync(dir).some((entry) => entry.startsWith('.fetch-'))).toBe(false);
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

  test.each(['wrong-tag', 'unsafe-tag', 'draft'])('refuses %s metadata', async (kind) => {
    const fixture = releaseFixture();
    if (kind === 'wrong-tag') fixture.release.tag_name = 'v9.0.0';
    if (kind === 'unsafe-tag') fixture.release.tag_name = '../bad';
    if (kind === 'draft') fixture.release.draft = true;
    const calls = installResponses(fixture);
    await fetcher.main({ outputDir: dir });
    expect(process.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test.each(['missing', 'directory', 'symlink', 'hardlink'])(
    'rejects an archive with a %s executable',
    async (kind) => {
      installResponses(releaseFixture());
      execFileSync.mockImplementation((_bin, args, options) => {
        const bin = path.join(options.cwd, args.at(-1));
        if (kind === 'directory') fs.mkdirSync(bin);
        if (kind === 'symlink' || kind === 'hardlink') {
          // Windows contributors need no symlink privilege to check rejection.
          fs.writeFileSync(bin, 'linked-binary');
          const lstat = fs.lstatSync;
          jest
            .spyOn(fs, 'lstatSync')
            .mockImplementation((file) =>
              file === bin
                ? { isFile: () => kind !== 'symlink', nlink: kind === 'hardlink' ? 2 : 1 }
                : lstat(file)
            );
        }
      });
      await fetcher.main({ outputDir: dir });
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(path.join(dir, 'mac-arm64', 'freedom-cored'))).toBe(false);
    }
  );
});
