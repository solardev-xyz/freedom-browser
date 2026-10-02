#!/usr/bin/env node
/** Development engine container from the approved scripts-disabled fixture.
 * No install, source transformation, unpacked native file, or product activation.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const asar = require('@electron/asar');
const { assertRailgunFixture } = require('./railgun-fixture-integrity');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const [directory] = process.argv.slice(2);
  assert.ok(path.isAbsolute(directory) && !fs.existsSync(directory));
  const fixture = path.join(__dirname, 'fixtures/railgun-engine'),
    modules = path.join(fixture, 'node_modules');
  const inventory = assertRailgunFixture(modules);
  fs.mkdirSync(directory, { mode: 0o700 });
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  for (const name of ['package.json', 'package-lock.json', 'runtime-integrity.json'])
    fs.copyFileSync(path.join(fixture, name), path.join(source, name), fs.constants.COPYFILE_EXCL);
  function copy(relative = '') {
    const current = path.join(modules, relative),
      target = path.join(source, 'node_modules', relative);
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(current).sort()) {
      if (
        (!relative || path.basename(relative) === 'node_modules') &&
        ['.bin', '.package-lock.json'].includes(name)
      )
        continue;
      const file = path.join(relative, name),
        stat = fs.lstatSync(path.join(modules, file));
      assert.ok(!stat.isSymbolicLink());
      if (stat.isDirectory()) copy(file);
      else {
        assert.ok(stat.isFile());
        fs.copyFileSync(
          path.join(modules, file),
          path.join(source, 'node_modules', file),
          fs.constants.COPYFILE_EXCL
        );
      }
    }
  }
  copy();
  assert.deepEqual(assertRailgunFixture(path.join(source, 'node_modules')), inventory);
  assert.deepEqual(assertRailgunFixture(modules), inventory);
  const candidate = {
    schema: 'railgun-engine-runtime-v1',
    engine: '9.6.0',
    inventory,
    lockSha256: digest(fs.readFileSync(path.join(source, 'package-lock.json'))),
    packageSha256: digest(fs.readFileSync(path.join(source, 'package.json'))),
    builderSha256: digest(fs.readFileSync(__filename)),
    inventoryHelperSha256: digest(fs.readFileSync(require.resolve('./railgun-fixture-integrity'))),
    asar: require('@electron/asar/package.json').version,
    productionDistributionApproved: false,
  };
  fs.writeFileSync(path.join(source, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
  const archive = path.join(directory, 'railgun-engine.asar');
  await asar.createPackage(source, archive);
  const report = {
    ...candidate,
    sha256: digest(fs.readFileSync(archive)),
    size: fs.statSync(archive).size,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ sha256: report.sha256, size: report.size, files: inventory.files }));
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
