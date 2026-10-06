/** Explicit retained public-fixture sender recovery; no producer/profile. */
const assert = require('assert/strict');
const path = require('path');
async function main(argv = process.argv.slice(2)) {
  assert.equal(
    argv.length,
    2,
    'Usage: electron qualify-railgun-relay-sender-recovery.js CONFIG_JSON FRESH_OUTPUT'
  );
  assert.ok(process.versions.electron && process.type === 'browser');
  const runner = require('./fixtures/railgun-relay-sender-recovery-run');
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
      console.error('Public sender recovery qualification refused');
      require('electron').app.exit(1);
    }
  );
module.exports = { main };
