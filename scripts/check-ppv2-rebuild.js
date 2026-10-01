#!/usr/bin/env node
/** Compare two independent builds and their qualified historical predecessor.
 * Usage: node scripts/check-ppv2-rebuild.js OLD.asar NEW.asar REPEAT.asar [playwright.json]
 * This is a byte/provenance check, not an upstream audit or distribution approval.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const asar = require('@electron/asar');
const { digest, pins, committedRecipe, verifyInventory } = require('./lib/ppv2-build-inputs');
const [historical, candidate, repeated, testReport] = process.argv.slice(2);
assert(historical && candidate && repeated, 'Three archive paths are required');
assert.notEqual(
  fs.realpathSync(candidate),
  fs.realpathSync(repeated),
  'Provide two independently assembled archives'
);
const firstStat = fs.statSync(candidate),
  repeatStat = fs.statSync(repeated);
assert(
  firstStat.dev !== repeatStat.dev || firstStat.ino !== repeatStat.ino,
  'Repeated archive is the same file'
);
assert.equal(
  digest(fs.readFileSync(historical)),
  'ce18c67a40fa0c72593bb1e851a995951afe7371b0ddd88dfee16d1ffa8e2cb7'
);
const hash = digest(fs.readFileSync(candidate));
assert.equal(hash, digest(fs.readFileSync(repeated)), 'Independent archives differ');
const accepted = require('../src/main/wallet/ppv2-runtime-manifest');
assert.equal(hash, accepted.sha256, 'Candidate is not the accepted runtime');
assert.equal(firstStat.size, accepted.size);
const inventory = JSON.parse(asar.extractFile(candidate, 'build-inventory.json'));
assert.equal(inventory.recipe.productionDistributionApproved, false);
assert.deepEqual(inventory.recipe.pins, pins);
assert.equal(inventory.recipe.revision, committedRecipe(path.resolve(__dirname, '..')));
assert.equal(
  inventory.recipe.builderSha256,
  digest(fs.readFileSync(path.join(__dirname, 'spike-ppv2-process.js')))
);
assert.equal(
  inventory.recipe.helperSha256,
  digest(fs.readFileSync(require.resolve('./lib/ppv2-build-inputs')))
);
const closure = { ...inventory };
delete closure.recipe;
verifyInventory(closure, pins.dependencyInventorySha256);
function normalized(bytes) {
  let source = bytes.toString();
  // Only remove complete build-root prefixes identified in esbuild source labels.
  // Source bodies, module paths, directives and generated code stay intact.
  const prefixes = new Map();
  for (const line of source.split('\n')) {
    const sdk = line.match(/^\/\/ (.*?)(?:node_modules\/\.pnpm\/|packages\/sdk\/)/);
    if (sdk) prefixes.set(sdk[1], 'ppv2/');
    const kohaku = line.match(/^\/\/ (.*?)(?:packages\/(?:privacy-pools|plugins)\/)/);
    if (kohaku) prefixes.set(kohaku[1], 'kohaku/');
  }
  for (const [prefix, replacement] of prefixes) {
    assert(prefix, 'Expected a build-root prefix');
    source = source.replaceAll(prefix, replacement);
  }
  return source;
}
const bundles = ['sdk.cjs', 'plugin.cjs', 'serial-prover.cjs', 'abis.cjs', 'http.cjs'];
for (const file of bundles)
  assert.equal(
    normalized(asar.extractFile(historical, file)),
    asar.extractFile(candidate, file).toString(),
    `Changed bundle: ${file}`
  );
let preservedFiles = 0;
const files = (archive) =>
  asar
    .listPackage(archive)
    .map((name) => name.replaceAll('\\', '/').replace(/^\//, ''))
    .filter((name) => !asar.statFile(archive, name).files)
    .sort();
const oldFiles = files(historical);
const licenseFiles = inventory.packages
  .flatMap((pkg) => pkg.licenses)
  .map((item) => ({ ...item, file: 'licenses/' + item.file }));
licenseFiles.push({ file: 'licenses/ppv2/LICENSE', sha256: pins.sdkLicenseSha256 });
assert.deepEqual(
  files(candidate),
  [...oldFiles, 'build-inventory.json', ...licenseFiles.map((item) => item.file)].sort(),
  'Unexpected runtime file set'
);
for (const item of licenseFiles)
  assert.equal(digest(asar.extractFile(candidate, item.file)), item.sha256);
for (const [index, file] of ['job.cjs', 'exit-job.cjs', 'configuration.cjs'].entries())
  assert.equal(
    digest(asar.extractFile(candidate, file)),
    pins.freedomFiles[index].sha256,
    'Changed packed helper'
  );
for (const file of oldFiles) {
  if (!(
    file.startsWith('artifacts/') ||
    file.startsWith('node_modules/') ||
    ['candidate.json', 'manifest.json', 'exit-manifest.json'].includes(file)
  ))
    continue;
  if (asar.statFile(historical, file).files) continue;
  assert(
    asar.extractFile(historical, file).equals(asar.extractFile(candidate, file)),
    `Changed runtime input: ${file}`
  );
  preservedFiles++;
}
assert.equal(preservedFiles, 20, 'Incomplete historical comparison');
let tests = null;
if (testReport) {
  const report = JSON.parse(fs.readFileSync(testReport));
  tests = report.stats;
  assert.equal(tests.expected, 19, 'Run the complete seven-spec PPv2 SDK suite');
  for (const kind of ['skipped', 'unexpected', 'flaky']) assert.equal(tests[kind], 0, kind);
  assert.equal(report.errors.length, 0, 'Runner errors');
  const expectedSpecs = {
    'ppv2-deposit.spec.js': 1,
    'ppv2-exit-circuits.spec.js': 4,
    'ppv2-lifecycle.spec.js': 2,
    'ppv2-process.spec.js': 2,
    'ppv2-relay.spec.js': 1,
    'ppv2-token-deposit.spec.js': 1,
    'ppv2-withdrawal.spec.js': 8,
  };
  const actualSpecs = {},
    attachments = [];
  function inspect(suite) {
    for (const spec of suite.specs || []) {
      const file = path.basename(spec.file);
      actualSpecs[file] = (actualSpecs[file] || 0) + 1;
      assert.equal(spec.tests.length, 1);
      const test = spec.tests[0];
      assert.equal(test.projectName, 'harness');
      assert.equal(test.status, 'expected');
      assert.equal(test.results.length, 1);
      assert.equal(test.results[0].status, 'passed');
      attachments.push(...test.results[0].attachments);
    }
    for (const nested of suite.suites || []) inspect(nested);
  }
  for (const suite of report.suites) inspect(suite);
  assert.deepEqual(actualSpecs, expectedSpecs, 'Wrong SDK spec set');
  const integrity = attachments.filter((item) => item.name === 'ppv2-runtime-integrity-report');
  assert.equal(integrity.length, 1);
  const evidence = JSON.parse(Buffer.from(integrity[0].body, 'base64'));
  assert.equal(evidence.archiveSha256, hash, 'Tests used a different archive');
  assert.equal(evidence.healthy, true);
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      archiveSha256: hash,
      archiveBytes: fs.statSync(candidate).size,
      recipeRevision: inventory.recipe.revision,
      independentArchivesIdentical: true,
      normalizedHistoricalBundlesIdentical: bundles,
      historicalArtifactWorkerMetadataFilesIdentical: preservedFiles,
      inputs: inventory.inputs.length,
      packages: inventory.packages.length,
      unattributedInputs: inventory.unattributedInputs.length,
      packagesMissingLicenseText: inventory.packages
        .filter((pkg) => !pkg.licenses.length)
        .map(({ name, version, declaredLicense }) => ({ name, version, declaredLicense })),
      latentLoads: Object.fromEntries(
        ['sdk.cjs', 'serial-prover.cjs'].map((file) => {
          const code = asar.extractFile(candidate, file).toString();
          return [
            file,
            {
              newWorkerExpressions: (code.match(/new Worker\(/g) || []).length,
              workerThreadsRequires: (
                code.match(/require\(["'](?:node:)?worker_threads["']\)/g) || []
              ).length,
              nativeLoaderReferences: (code.match(/node-gyp-build/g) || []).length,
              exhaustiveEgressQualification: false,
            },
          ];
        })
      ),
      tests,
      productionDistributionApproved: false,
    },
    null,
    2
  )
);
