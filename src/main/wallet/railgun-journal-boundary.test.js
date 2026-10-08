/** Ordinary EOA module loading must not initialize the Railgun owner domain. */
const path = require('path');
// Avoid Electron's Node-side binary installer; these imports must not use app APIs.
jest.mock('electron', () => Object.freeze({}));

test('shared transaction modules load only the package data closure', () => {
  require('./privacy-journal-retention');
  require('./private-submission-journal');
  require('./private-transaction-intent');
  require('./private-transaction-network');
  require('./transaction-service');
  const entry = require.resolve('@freedom/railgun-kohaku-adapter/host/journal-data');
  const root = path.dirname(entry) + path.sep;
  const loaded = Object.keys(require.cache)
    .filter((name) => name.startsWith(root))
    .map((name) => name.slice(root.length).split(path.sep).join('/'))
    .sort();
  expect(loaded).toEqual([
    'host-journal-data.cjs',
    'src/data/railgun-private-intent.js',
    'src/data/railgun-private-policy.js',
    'src/owners/railgun-shield-intent.js',
    'src/owners/railgun-shield-policy.js',
    'src/owners/railgun-shield-resolution.js',
    'src/owners/railgun-transact-intent.js',
    'src/owners/railgun-transact-receipt-policy.js',
    'src/owners/railgun-transact-resolution.js',
    'src/railgun-shield-pins.json',
  ]);
  expect(Object.hasOwn(globalThis, Symbol.for('@freedom/railgun-kohaku-adapter/owner-host-v1'))).toBe(false);
  expect(Object.hasOwn(globalThis, Symbol.for('@freedom/railgun-kohaku-adapter/execution-host-v1'))).toBe(false);
});
