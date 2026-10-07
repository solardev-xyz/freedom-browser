/** Explicit isolated PUBLIC test-list entry. No production pin is changed here. */
const assert = require('assert/strict');
const path = require('path');
const fs = process.versions.electron ? require('original-fs') : require('fs');
const { createHash } = require('crypto');
const ORIGINAL_SHA = 'c4511c0ea185835c67bbbc8b8ba74bec6271e4b3a457a2b6a1576b42593fd1ac';
const ISOLATED_SHA = '16a8e5e15621d2da51568319717a43ca51e3517beb59441e44931539d47b45ab';
const ORIGINAL_LITERAL =
  "const REQUIRED_LIST = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88';";
const ISOLATED_LITERAL =
  "const REQUIRED_LIST = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';";
const sha = (v) => createHash('sha256').update(v).digest('hex');
// Pure byte transformation for the reviewed outer copy builder. It never writes.
function deriveIsolatedPoiSource(bytes) {
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(sha(bytes), ORIGINAL_SHA);
  const source = bytes.toString('utf8');
  assert.equal(source.split(ORIGINAL_LITERAL).length, 2);
  const changed = Buffer.from(source.replace(ORIGINAL_LITERAL, ISOLATED_LITERAL));
  assert.equal(sha(changed), ISOLATED_SHA);
  return changed;
}
function assertIsolation() {
  const packageRoot = path.resolve(__dirname, '../node_modules/@freedom/railgun-kohaku-adapter');
  assert.equal(fs.realpathSync(packageRoot), packageRoot);
  assert.equal(
    require.resolve('@freedom/railgun-kohaku-adapter/host/poi', {
      paths: [path.resolve(__dirname, '../src/main/wallet')],
    }),
    path.join(packageRoot, 'host-poi.cjs')
  );
  const filename = path.join(packageRoot, 'src/data/railgun-poi-records.js');
  assert.equal(fs.realpathSync(filename), filename);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(sha(fs.readFileSync(filename)), ISOLATED_SHA);
  return { originalPoiSourceSha256: ORIGINAL_SHA, isolatedPoiSourceSha256: ISOLATED_SHA };
}
async function main(argv = process.argv.slice(2), env = process.env) {
  assert.ok(
    process.versions.electron && process.type === 'browser',
    'Explicit Electron browser entry required'
  );
  // The fixture's select admits only its fixed synthetic-list scenarios.
  assert.equal(typeof env.FREEDOM_RAILGUN_RELAY_POSITIVE, 'string');
  const isolation = assertIsolation();
  const runner = require('./fixtures/railgun-relay-positive-native');
  const config = runner.select(env.FREEDOM_RAILGUN_RELAY_POSITIVE, argv, env);
  assert.ok(config);
  await runner.execute(config);
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
      console.error('Synthetic-list relay qualification refused:', error?.message ?? 'unknown');
      finish(1);
    }
  );
module.exports = { deriveIsolatedPoiSource, assertIsolation, main, ORIGINAL_SHA, ISOLATED_SHA };
