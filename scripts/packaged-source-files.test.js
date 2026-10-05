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

test('packaging excludes the pinned obsolete reader and its tests while retaining the current store', () => {
  expect(included('src/main/wallet/railgun-poi-intent-store-old-reader.fixture.js')).toBe(false);
  expect(included('src/main/wallet/railgun-poi-intent-store.test.js')).toBe(false);
  expect(included('src/main/wallet/railgun-poi-intent-store.js')).toBe(true);
  expect(included('src/main/wallet/railgun-own-poi-shape-data.js')).toBe(true);
  expect(included('package.json')).toBe(true);
});
