/** Source-reviewed Electron entry; re-verifies public files only. No producer. */
'use strict';
const assert = require('assert/strict');
const path = require('path');
async function main(argv = process.argv.slice(2)) {
  assert.equal(
    argv.length,
    2,
    'Usage: electron qualify-railgun-relay-retained.js CONFIG_JSON FRESH_OUTPUT'
  );
  assert.ok(
    process.versions.electron && process.type === 'browser',
    'Explicit Electron browser entry required'
  );
  const runner = require('./fixtures/railgun-relay-retained-run');
  return runner.execute(runner.readConfig(argv[0]), argv[1]);
}
if (
  require.main === module ||
  (process.versions.electron &&
    process.type === 'browser' &&
    typeof process.argv[1] === 'string' &&
    path.resolve(process.argv[1]) === path.resolve(__filename))
)
  main().then(
    () => finish(0),
    () => {
      console.error('Retained public verification refused');
      finish(1);
    }
  );
function finish(code) {
  if (process.versions.electron && process.type === 'browser') require('electron').app.exit(code);
  else process.exitCode = code;
}
module.exports = { main };
