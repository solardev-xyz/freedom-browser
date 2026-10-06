/** Explicit second-main entry for the approved first PUBLIC synthetic account. */
const assert = require('assert/strict');
const path = require('path');
async function main(argv = process.argv.slice(2), env = process.env) {
  assert.ok(process.versions.electron && process.type === 'browser');
  assert.equal(env.FREEDOM_RAILGUN_RELAY_COLD_READY, '1');
  for (const name of Object.keys(env))
    if (name.startsWith('FREEDOM_RAILGUN_')) assert.equal(name, 'FREEDOM_RAILGUN_RELAY_COLD_READY');
  assert.equal(argv.length, 1);
  assert.ok(path.isAbsolute(argv[0]));
  const { assertIsolation } = require('./qualify-railgun-relay-positive');
  const isolation = assertIsolation();
  const fixture = require('./fixtures/railgun-relay-cold-ready-native');
  await fixture.execute(fixture.readAdmission(argv[0]));
  assert.deepEqual(assertIsolation(), isolation);
}
function finish(code) {
  if (process.versions.electron && process.type === 'browser') require('electron').app.exit(code);
  else process.exitCode = code;
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
    (error) => {
      console.error('Cold ready-local qualification refused:', error?.message ?? 'unknown');
      finish(1);
    }
  );
module.exports = { main };
