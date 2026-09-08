/**
 * Addon load/ABI check used by the `radicle-addon-load` CI matrix.
 *
 * libradicle is the only Radicle runtime — there is no executable fallback —
 * so a release asset that loads but is missing an export the app calls, or
 * that cannot execute a native call on the runner's platform/ABI, has to fail
 * in CI rather than inside a packaged build.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const { checkAddon, resolveAddonPath, hostKey } = require('./check-radicle-addon');
const {
  RADICLE_ADDON_REQUIRED_EXPORTS,
} = require('../src/shared/radicle-addon-version');

let tmpDir;

/** Write a fake "addon" (a plain CJS module) and return its path. */
function writeFakeAddon(name, body) {
  const file = path.join(tmpDir, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
}

const completeAddon = (statusBody = 'async () => JSON.stringify({ running: false })') => `
const exportsList = ${JSON.stringify(RADICLE_ADDON_REQUIRED_EXPORTS)};
for (const name of exportsList) module.exports[name] = async () => '{}';
module.exports.status = ${statusBody};
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-addon-check-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('checkAddon', () => {
  test('accepts an addon exposing every export the app calls', async () => {
    const result = await checkAddon(writeFakeAddon('complete', completeAddon()));
    expect(result.exports).toBe(RADICLE_ADDON_REQUIRED_EXPORTS.length);
    expect(JSON.parse(result.status)).toEqual({ running: false });
  });

  // A stopped node answers with a JSON error payload — the point of the smoke
  // call is that native code ran, not that a node is up.
  test('accepts the stopped-node answer a fresh CI runner gets', async () => {
    const result = await checkAddon(
      writeFakeAddon(
        'stopped',
        completeAddon('async () => JSON.stringify({ error: "node not started" })')
      )
    );
    expect(JSON.parse(result.status)).toEqual({ error: 'node not started' });
  });

  test('rejects an addon missing an export the app calls', async () => {
    const partial = writeFakeAddon(
      'partial',
      `${completeAddon()}\ndelete module.exports.cloneRepoWithProgress;`
    );
    await expect(checkAddon(partial)).rejects.toThrow(/missing required exports.*cloneRepoWithProgress/);
  });

  test('rejects an addon whose native call fails on this platform', async () => {
    const throwing = writeFakeAddon(
      'throwing',
      completeAddon('async () => { throw new Error("Symbol not found"); }')
    );
    await expect(checkAddon(throwing)).rejects.toThrow(/status\(\) failed.*Symbol not found/);
  });

  test('rejects an answer that is not the JSON string every export returns', async () => {
    const nonJson = writeFakeAddon('nonjson', completeAddon('async () => ({ running: true })'));
    await expect(checkAddon(nonJson)).rejects.toThrow(/expected a JSON string/);

    const garbage = writeFakeAddon('garbage', completeAddon('async () => "not json"'));
    await expect(checkAddon(garbage)).rejects.toThrow();
  });

  test('reports a missing download instead of a bare require failure', async () => {
    await expect(checkAddon(path.join(tmpDir, 'absent.node'))).rejects.toThrow(
      /run `npm run radicle:download` first/
    );
  });
});

describe('resolveAddonPath', () => {
  test('prefers an explicit argument, then the environment, then the host prebuilt', () => {
    expect(resolveAddonPath(['radicle-bin/win-arm64/libradicle.node'], {})).toBe(
      path.resolve('radicle-bin/win-arm64/libradicle.node')
    );
    expect(resolveAddonPath([], { RADICLE_ADDON: 'a/b.node' })).toBe(path.resolve('a/b.node'));
    expect(resolveAddonPath([], {})).toBe(
      path.join(__dirname, '..', 'radicle-bin', hostKey(), 'libradicle.node')
    );
  });

  // The keys must match the release asset names the fetcher installs under
  // radicle-bin/<key>/ (fetch-radicle-addon.js platformKey).
  test('host key matches the fetcher layout for this runner', () => {
    expect(hostKey()).toMatch(/^(mac|linux|win)-(x64|arm64)$/);
    expect(require('./fetch-radicle-addon').platformKey([])).toBe(hostKey());
  });
});
