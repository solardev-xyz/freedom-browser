/** Explicit public-fixture quote JOB-only qualification; no account controller. */
const assert = require('assert/strict');
const path = require('path');
async function main(argv = process.argv.slice(2)) {
  assert.equal(
    argv.length,
    2,
    'Usage: electron qualify-railgun-relay-quote-job.js CONFIG_JSON FRESH_OUTPUT'
  );
  assert.ok(process.versions.electron && process.type === 'browser');
  const runner = require('./fixtures/railgun-relay-quote-native-run');
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
    () => require('electron').app.exit(0),
    () => {
      console.error('Public quote job qualification refused');
      require('electron').app.exit(1);
    }
  );
module.exports = { main };
