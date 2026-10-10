const fs = require('fs');
const path = require('path');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const packageJson = require('../package.json');

const root = path.join(__dirname, '..');
const matcher = new FileMatcher(root, root, (value) => value, packageJson.build.files);
const filter = matcher.createFilter();
const included = (relative) => {
  const filename = path.join(root, relative);
  return filter(filename, fs.statSync(filename));
};

// This checks the top-level source allowlist, not the merged platform matcher.
// Actual dependency membership and asar loading have separate installed checks.
test('the source allowlist includes Railgun host composition and excludes its test fixtures', () => {
  expect(included('src/main/wallet/railgun-owner-host.js')).toBe(true);
  expect(included('src/main/wallet/railgun-platform-host.js')).toBe(true);
  expect(included('src/main/identity/railgun-credential-host.js')).toBe(true);
  expect(included('src/main/wallet/railgun-owner-host.test.js')).toBe(false);
  expect(included('test/fixtures/railgun/railgun-journal-histories.json')).toBe(false);
  expect(included('test/fixtures/railgun/railgun-credential-vectors.json')).toBe(false);
  expect(included('test/fixtures/railgun/railgun-credential-conformance.cjs')).toBe(false);
  expect(included('package.json')).toBe(true);
});
