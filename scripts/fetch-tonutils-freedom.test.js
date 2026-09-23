const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildDownloadUrl,
  installTarget,
  BINARY_NAME,
  PINNED_SOURCE_COMMIT,
  RELEASE_TAG,
  runtimeTarget,
  selectedTargets,
  TARGETS,
} = require('./fetch-tonutils-freedom');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('fetch-tonutils-freedom', () => {
  let outputDir;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ton-fetch-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test('pins every shipped target to a source commit and an asset checksum', () => {
    expect(PINNED_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(RELEASE_TAG).toBe('v0.1.0-freedom');
    expect(TARGETS.map(({ os, arch }) => `${os}-${arch}`)).toEqual([
      'mac-arm64',
      'mac-x64',
      'linux-x64',
      'linux-arm64',
      'win-x64',
    ]);
    for (const target of TARGETS) {
      expect(target.asset).toMatch(new RegExp(`^${BINARY_NAME}-`));
      expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('builds a release URL for the pinned repository and asset', () => {
    expect(buildDownloadUrl(RELEASE_TAG, TARGETS[0].asset)).toBe(
      `https://github.com/TONresistor/Tonutils-Proxy/releases/download/${RELEASE_TAG}/${TARGETS[0].asset}`
    );
  });

  test('selects only the runtime target and uses x64 emulation on Windows ARM64', () => {
    expect(selectedTargets([], 'darwin', 'arm64')).toEqual([
      expect.objectContaining({ os: 'mac', arch: 'arm64' }),
    ]);
    expect(selectedTargets(['--linux', '--x64'], 'darwin', 'arm64')).toEqual([
      expect.objectContaining({ os: 'linux', arch: 'x64' }),
    ]);
    expect(selectedTargets(['--win', '--arm64'], 'darwin', 'arm64')).toEqual([
      expect.objectContaining({ os: 'win', arch: 'x64' }),
    ]);
    expect(runtimeTarget('win32', 'arm64')).toEqual({ os: 'win', arch: 'x64' });
    expect(() => selectedTargets([], 'freebsd', 'x64')).toThrow(/Unsupported TON proxy target/);
    expect(() => selectedTargets(['--mac', '--linux'], 'darwin', 'arm64')).toThrow(
      /Conflicting TON proxy target flags/
    );
  });

  test('verifies the checksum before atomically replacing the installed binary', async () => {
    const payload = Buffer.from('reviewed TON proxy binary');
    const target = {
      os: 'mac',
      arch: 'arm64',
      asset: `${BINARY_NAME}-darwin-arm64`,
      sha256: sha256(payload),
    };
    const targetDir = path.join(outputDir, 'mac-arm64');
    fs.mkdirSync(targetDir, { recursive: true });
    const installedPath = path.join(targetDir, BINARY_NAME);
    fs.writeFileSync(installedPath, 'previous binary');

    await installTarget(target, {
      outputDir,
      download: async (_url, destination) => fs.writeFileSync(destination, payload),
    });

    expect(fs.readFileSync(installedPath)).toEqual(payload);
    expect(fs.existsSync(`${installedPath}.download`)).toBe(false);
    expect(fs.statSync(installedPath).mode & 0o111).not.toBe(0);
  });

  test('rejects a checksum mismatch without replacing the installed binary', async () => {
    const target = {
      os: 'linux',
      arch: 'x64',
      asset: `${BINARY_NAME}-linux-amd64`,
      sha256: '0'.repeat(64),
    };
    const targetDir = path.join(outputDir, 'linux-x64');
    fs.mkdirSync(targetDir, { recursive: true });
    const installedPath = path.join(targetDir, BINARY_NAME);
    fs.writeFileSync(installedPath, 'known-good binary');

    await expect(
      installTarget(target, {
        outputDir,
        download: async (_url, destination) => fs.writeFileSync(destination, 'tampered binary'),
      })
    ).rejects.toThrow(/Checksum mismatch/);

    expect(fs.readFileSync(installedPath, 'utf8')).toBe('known-good binary');
    expect(fs.existsSync(`${installedPath}.download`)).toBe(false);
  });
});
