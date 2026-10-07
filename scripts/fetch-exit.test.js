/**
 * The downloader scripts must end by returning, never by `process.exit()`
 * (#544).
 *
 * On Node 24, `process.exit()` joins V8's background compiler threads without
 * disposing the isolate first; a Maglev/Sparkplug job parked waiting for a
 * main-thread GC at that moment never wakes, and the exit hangs forever at 0%
 * CPU (nodejs/node#64274). The macOS e2e-onboarding-identity leg's
 * `npm run ant:download` printed "All downloads complete." and then hung until
 * the 20-minute job timeout in 6 of 1075 jobs between 2026-09-15 and
 * 2026-10-06, with the script's `process.exit(0)` and npm's own explicit
 * `process.exit()` the only exits in that process tree.
 *
 * Two checks: no `process.exit(` call survives in the scripts' code, and the
 * real fetch-ant.js, run end to end as a child process against a stand-in
 * release, finishes on its own with the right exit status — so the fix did not
 * trade the exit hang for an event loop that never drains.
 */

const { spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = ['fetch-ant.js', 'fetch-arti.js'];

/** Source with comments and string/template literals blanked out. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
}

describe('downloader scripts do not call process.exit()', () => {
  test.each(SCRIPTS)('%s', (name) => {
    const code = codeOnly(fs.readFileSync(path.join(__dirname, name), 'utf8'));
    expect(code).not.toMatch(/\bprocess\s*\.\s*exit\s*\(/);
    expect(code).not.toMatch(/\bprocess\s*\[\s*''\s*\]/);
  });
});

// Serves the script's HTTPS GETs from a directory and makes process.exit()
// itself a failure, so a reintroduced call cannot pass by exiting cleanly.
const SHIM = `
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const dir = process.env.FAKE_RELEASE_DIR;
https.get = (url, opts, cb) => {
  const req = new EventEmitter();
  req.destroy = () => {};
  req.setTimeout = () => req;
  const u = new URL(url);
  const file = u.host === 'api.github.com' ? 'release.json' : path.basename(u.pathname);
  setImmediate(() => {
    const exists = fs.existsSync(path.join(dir, file));
    const res = exists
      ? fs.createReadStream(path.join(dir, file))
      : require('stream').Readable.from([]);
    res.statusCode = exists ? 200 : 404;
    res.headers = {};
    res.complete = false;
    res.on('end', () => { res.complete = true; });
    cb(res);
  });
  return req;
};
process.exit = (code) => {
  process.stderr.write('process.exit(' + code + ') called\\n');
  process.reallyExit(97);
};
`;

const maybe = process.platform === 'win32' ? describe.skip : describe;

maybe('fetch-ant.js end to end', () => {
  let root;
  let releaseDir;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ant-exit-'));
    // The script writes to <its dir>/../ant-bin, so run a copy, not the repo's.
    fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, 'fetch-ant.js'),
      path.join(root, 'scripts', 'fetch-ant.js')
    );
    fs.copyFileSync(
      path.join(__dirname, 'lib', 'fetch-with-retry.js'),
      path.join(root, 'scripts', 'lib', 'fetch-with-retry.js')
    );
    fs.writeFileSync(path.join(root, 'shim.js'), SHIM);

    releaseDir = path.join(root, 'release');
    const staging = path.join(root, 'staging');
    fs.mkdirSync(releaseDir);
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'antd'), '#!/bin/sh\necho fake antd\n');
    const assets = [];
    for (const name of [
      'antd-vtest-darwin-arm64.tar.gz',
      'antd-vtest-darwin-amd64.tar.gz',
      'antd-vtest-linux-amd64.tar.gz',
      'antd-vtest-linux-arm64.tar.gz',
    ]) {
      execFileSync('tar', ['-czf', path.join(releaseDir, name), '-C', staging, 'antd']);
      assets.push(name);
    }
    // A bare (non-archive) asset is installed by rename: no unzip needed.
    fs.writeFileSync(path.join(releaseDir, 'antd-vtest-windows-amd64.exe'), 'MZ fake');
    assets.push('antd-vtest-windows-amd64.exe');

    const sums = assets
      .map((name) => {
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(path.join(releaseDir, name)));
        return `${hash.digest('hex')}  ${name}`;
      })
      .join('\n');
    fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS'), `${sums}\n`);
    const release = {
      tag_name: 'vtest',
      assets: ['SHA256SUMS', ...assets].map((name) => ({
        name,
        browser_download_url: `https://github.com/freedom-hq/ant/releases/download/vtest/${name}`,
      })),
    };
    fs.writeFileSync(path.join(releaseDir, 'release.json'), JSON.stringify(release));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(env = {}) {
    return spawnSync(
      process.execPath,
      ['-r', path.join(root, 'shim.js'), path.join(root, 'scripts', 'fetch-ant.js')],
      {
        env: {
          ...process.env,
          ANT_RELEASE_TAG: 'vtest',
          FAKE_RELEASE_DIR: releaseDir,
          ...env,
        },
        encoding: 'utf8',
        timeout: 20_000,
      }
    );
  }

  test('success: returns on its own with status 0', () => {
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toMatch(/process\.exit/);
    expect(result.stdout).toMatch(/All downloads complete\./);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(root, 'ant-bin', 'mac-arm64', 'antd'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'ant-bin', 'win-arm64', 'antd.exe'))).toBe(true);
  });

  test('failure: returns on its own with status 1', () => {
    fs.renameSync(path.join(releaseDir, 'SHA256SUMS'), path.join(root, 'SHA256SUMS.away'));
    try {
      const result = run();
      expect(result.error).toBeUndefined();
      expect(result.stderr).not.toMatch(/process\.exit/);
      expect(result.stderr).toMatch(/HTTP 404/);
      expect(result.status).toBe(1);
    } finally {
      fs.renameSync(path.join(root, 'SHA256SUMS.away'), path.join(releaseDir, 'SHA256SUMS'));
    }
  });
});
