/**
 * scripts/fetch-bee-dev.js: the pinned `bee dev` for the window.swarm e2e,
 * fetched for the host only and kept only with its pinned digest.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ASSETS,
  PINNED_RELEASE_TAG,
  binaryPath,
  fetchBeeDev,
  targetOf,
} = require('./fetch-bee-dev');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

describe('fetch-bee-dev.js', () => {
  let dir;
  let logs;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-bee-dev-'));
    logs = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logs.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('pins v2.8.0, the last release with dev mode, with a digest for each CI runner', () => {
    expect(PINNED_RELEASE_TAG).toBe('v2.8.0');
    for (const target of ['linux-x64', 'mac-arm64', 'win-x64']) {
      expect(ASSETS[target].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(targetOf('linux', 'x64')).toBe('linux-x64');
    expect(targetOf('darwin', 'arm64')).toBe('mac-arm64');
    expect(targetOf('win32', 'x64')).toBe('win-x64');
    expect(targetOf('freebsd', 'x64')).toBeNull();
    expect(path.basename(binaryPath('win-x64', dir))).toBe('bee.exe');
    expect(path.basename(binaryPath('mac-arm64', dir))).toBe('bee');
  });

  test("downloads the target's asset from the pinned release and keeps it under its digest", async () => {
    const urls = [];
    const download = async (url, dest) => {
      urls.push(url);
      fs.writeFileSync(dest, 'bee');
    };
    const assets = { 'linux-x64': { asset: 'bee-linux-amd64', sha256: sha256('bee') } };
    const dest = await fetchBeeDev({ target: 'linux-x64', outputDir: dir, download, assets });
    expect(urls).toEqual([
      'https://github.com/ethersphere/bee/releases/download/v2.8.0/bee-linux-amd64',
    ]);
    expect(dest).toBe(binaryPath('linux-x64', dir));
    expect(fs.readFileSync(dest, 'utf8')).toBe('bee');
    if (process.platform !== 'win32') expect(fs.statSync(dest).mode & 0o111).toBe(0o111);
    // Already there with its digest: not fetched again.
    await fetchBeeDev({ target: 'linux-x64', outputDir: dir, download, assets });
    expect(urls).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['bee']);
  });

  test('refuses a binary whose digest is not the pinned one, and leaves nothing to run', async () => {
    const download = async (_url, dest) => fs.writeFileSync(dest, 'swapped');
    const assets = { 'win-x64': { asset: 'bee-windows-amd64.exe', sha256: sha256('bee') } };
    await expect(
      fetchBeeDev({ target: 'win-x64', outputDir: dir, download, assets })
    ).rejects.toThrow(
      `bee-windows-amd64.exe: SHA-256 ${sha256('swapped')}, pinned ${sha256('bee')}`
    );
    expect(fs.readdirSync(path.join(dir, 'win-x64'))).toEqual([]);
  });

  test('refuses a target the release has no binary for', async () => {
    const download = jest.fn();
    await expect(fetchBeeDev({ target: 'win-arm64', outputDir: dir, download })).rejects.toThrow(
      'Bee v2.8.0 has no dev-mode binary for win-arm64 here'
    );
    expect(download).not.toHaveBeenCalled();
  });
});
