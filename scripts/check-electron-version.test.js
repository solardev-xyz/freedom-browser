// Issue #346: the crash repro only ever failed on macOS because this tree's
// `node_modules/electron` was 43.4.1 while `package-lock.json` pinned 44.3.0 —
// the Linux runs "passed" against an Electron that never had the bug. This
// suite is the standing guard against that trap: the real-install case below
// fails on any developer machine or CI job whose node_modules has drifted from
// the lockfile, and the pure cases pin the individual rules.

const fs = require('fs');
const path = require('path');

const {
  ELECTRON_DIST_VERSION,
  readLockedElectronVersion,
  readInstalledElectronVersion,
  readInstalledBinaryVersion,
  checkElectronVersion,
  checkInstalledElectronVersion,
} = require('./check-electron-version');

describe('the Electron in node_modules matches the lockfile', () => {
  // The load-bearing assertion: no fixtures, no mocks — the actual install in
  // this checkout. The downloaded binary is only compared when it is there:
  // electron 44 fetches it lazily on first use, and several CI jobs install
  // with `--ignore-scripts` and never launch the app.
  test('the installed package, the downloaded binary and package-lock.json agree', () => {
    expect(checkInstalledElectronVersion()).toEqual([]);
  });

  test('the lockfile pins an exact Electron version', () => {
    expect(readLockedElectronVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('reads the installed package version from node_modules', () => {
    expect(readInstalledElectronVersion()).toBe(readLockedElectronVersion());
  });

  // Only meaningful where the binary was downloaded; see above.
  (fs.existsSync(ELECTRON_DIST_VERSION) ? test : test.skip)(
    'reads the downloaded binary version from node_modules/electron/dist',
    () => {
      expect(readInstalledBinaryVersion()).toBe(readLockedElectronVersion());
    }
  );

  // The lockfile is what installs, but the package.json range is what a
  // `npm install` / `npm update` is allowed to resolve to. Keeping its floor at
  // the pinned version is what stops a resolution from landing back on a
  // release without the #346 fix.
  test('the package.json range floor is the pinned version', () => {
    const range = require('../package.json').devDependencies.electron;
    expect(range).toBe(`^${readLockedElectronVersion()}`);
  });
});

describe('checkElectronVersion rules', () => {
  test('passes when all three agree', () => {
    expect(
      checkElectronVersion({ locked: '44.4.1', installed: '44.4.1', binary: '44.4.1' })
    ).toEqual([]);
  });

  test('catches a stale npm package — the issue #346 trap', () => {
    expect(
      checkElectronVersion({ locked: '44.4.1', installed: '43.4.1', binary: '43.4.1' })
    ).toEqual([
      expect.stringContaining('node_modules/electron is 43.4.1 but package-lock.json pins 44.4.1'),
      expect.stringContaining('the downloaded Electron binary is 43.4.1'),
    ]);
  });

  test('catches a stale binary behind an up-to-date npm package', () => {
    expect(
      checkElectronVersion({ locked: '44.4.1', installed: '44.4.1', binary: '44.3.0' })
    ).toEqual([expect.stringContaining('the downloaded Electron binary is 44.3.0')]);
  });

  test('tolerates a `v`-prefixed dist/version file', () => {
    const tmp = path.join(require('os').tmpdir(), `freedom-electron-version-${process.pid}`);
    fs.writeFileSync(tmp, 'v44.4.1\n', 'utf-8');
    try {
      expect(readInstalledBinaryVersion(tmp)).toBe('44.4.1');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  // electron 44 ships no postinstall: `index.js` downloads the binary on the
  // first `require('electron')`, so a freshly installed tree has no dist/ yet.
  test('accepts a not-yet-downloaded binary', () => {
    expect(checkElectronVersion({ locked: '44.4.1', installed: '44.4.1', binary: null })).toEqual(
      []
    );
    expect(
      checkElectronVersion({ locked: '44.4.1', installed: '44.4.1', binary: undefined })
    ).toEqual([]);
  });

  test('electron still ships no postinstall hook, so the lazy download above holds', () => {
    expect(require('electron/package.json').scripts?.postinstall).toBeUndefined();
  });

  test('catches electron missing from node_modules entirely', () => {
    expect(checkElectronVersion({ locked: '44.4.1', installed: null, binary: null })).toEqual([
      expect.stringContaining('electron is not installed in node_modules'),
    ]);
  });

  test('catches a lockfile with no electron entry', () => {
    expect(checkElectronVersion({ locked: null, installed: '44.4.1', binary: '44.4.1' })).toEqual([
      expect.stringContaining('no node_modules/electron entry'),
    ]);
  });
});
