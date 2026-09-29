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
  // app.getVersion(), app.getAppPath() and app.getName(), read in the main
  // process by the harness's app-facts op:
  //   - appPath is where that version was read from: a packaged build serves
  //     its app out of the artifact's own resources directory, so this shows
  //     the number came from the package under test rather than a source tree;
  //   - `src/main/index.js` renames the app for packaged Linux builds; the same
  //     branch decides the log and userData directories.
  const app = await electronApp.appFacts();

  expect(app.version).toBe(expectedVersion);
  // Case-insensitive: the directory is `resources` on Linux and Windows but
  // `Freedom.app/Contents/Resources` on macOS.
  expect(app.appPath.toLowerCase()).toContain('resources');
  expect(app.name).toBe(process.platform === 'linux' ? 'freedom' : 'Freedom');
});
