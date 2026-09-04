// Packaged smoke — step 2 of the release-process.md §6 checklist:
// "About / freedom://settings shows <version> from package.json".
//
// `app.getVersion()` is that number: Electron reads it from the package.json
// inside the artifact's asar, and `src/main/index.js` passes the same value to
// `app.setAboutPanelOptions({ applicationVersion })`, which is what the About
// panel renders (a native panel Playwright cannot open or read). The release
// workflow passes the tag version in FREEDOM_E2E_EXPECTED_VERSION, so a `v0.8.5`
// tag that somehow packaged 0.8.4 fails this leg instead of shipping.

const { test, expect } = require('../fixtures');

// Trimmed: `FREEDOM_E2E_EXPECTED_VERSION=0.8.5 ` (a trailing space picked up
// from a shell or a YAML env block) must not fail a correct build.
const expectedVersion =
  (process.env.FREEDOM_E2E_EXPECTED_VERSION || '').trim() || require('../../package.json').version;

test('the packaged app reports the expected version', async ({ electronApp }) => {
  const app = await electronApp.evaluate(({ app: electron }) => ({
    version: electron.getVersion(),
    // Where that version was read from: a packaged build serves its app out of
    // the artifact's own resources directory, so this shows the number came
    // from the package under test rather than from a source tree.
    appPath: electron.getAppPath(),
    // `src/main/index.js` renames the app for packaged Linux builds; the same
    // branch decides the log and userData directories.
    name: electron.getName(),
  }));

  expect(app.version).toBe(expectedVersion);
  expect(app.appPath).toContain('resources');
  expect(app.name).toBe(process.platform === 'linux' ? 'freedom' : 'Freedom');
});
