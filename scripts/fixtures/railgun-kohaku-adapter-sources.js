/** Repository-relative files that qualifier source inventories pin for
 * @freedom/railgun-kohaku-adapter. src/main/wallet/railgun-kohaku-*.js only
 * re-export it, so the code that runs is the installed copy; package-lock.json
 * carries the entry integrity `npm ci` checked that copy's tarball against.
 */
const PACKAGE = 'node_modules/@freedom/railgun-kohaku-adapter/';
const SOURCES = Object.freeze([
  'scripts/fixtures/railgun-kohaku-adapter-sources.js',
  'package-lock.json',
  ...[
    'package.json',
    'index.cjs',
    'read.cjs',
    'src/railgun-kohaku-private-adapter.js',
    'src/railgun-kohaku-public-adapter.js',
    'src/railgun-kohaku-read-data.js',
    'src/railgun-kohaku-read-dispatch.js',
    'src/railgun-kohaku-snapshot-plugin.js',
    'src/railgun-shield-pins.json',
  ].map((name) => PACKAGE + name),
]);
module.exports = { SOURCES };
