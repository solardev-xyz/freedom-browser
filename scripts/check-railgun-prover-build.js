#!/usr/bin/env node
/** Check two independently assembled prover archives and the previous reviewed
 * serial verifier body. Reads bytes only; executes no archive/dependency code.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const asar = require('@electron/asar');
const [first, second, historical, output] = process.argv.slice(2);
for (const filename of [first, second, historical, output]) assert.ok(path.isAbsolute(filename));
assert.notEqual(fs.realpathSync(first), fs.realpathSync(second));
const a = fs.statSync(first),
  b = fs.statSync(second);
assert.ok(a.ino !== b.ino || a.dev !== b.dev);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = require('../src/main/wallet/railgun-prover-manifest.json');
const inputs = require('./fixtures/railgun-prover-inputs.json');
const hashes = [first, second].map((filename) => digest(fs.readFileSync(filename)));
assert.deepEqual(hashes, [manifest.sha256, manifest.sha256]);
assert.equal(a.size, manifest.size);
assert.equal(b.size, manifest.size);
assert.equal(
  digest(fs.readFileSync(historical)),
  'eacc32476b2fc3be0344e1c9b341a9964e405f59703604385b29307350bcca7a'
);
const inventoryBytes = asar.extractFile(first, 'build-inventory.json'),
  inventory = JSON.parse(inventoryBytes);
assert.deepEqual(inventory, inputs);
assert.equal(digest(JSON.stringify(inventory)), manifest.inventorySha256);
const candidate = JSON.parse(asar.extractFile(first, 'candidate.json'));
assert.equal(candidate.builderSha256, manifest.builderSha256);
assert.equal(
  digest(fs.readFileSync(path.join(__dirname, 'build-railgun-prover.js'))),
  manifest.builderSha256
);
assert.equal(candidate.inputsSha256, manifest.inventorySha256);
assert.equal(candidate.productionDistributionApproved, false);
assert.equal(candidate.schema, 'railgun-serial-prover-v1');
const body = (filename) => {
  const source = asar.extractFile(filename, 'serial-prover.cjs').toString();
  const marker = 'async function groth16Verify(',
    start = source.indexOf(marker);
  assert.equal(source.split(marker).length, 2);
  const rest = source.slice(start),
    end = rest.search(/\n\s*function isWellConstructed\$1\(/);
  assert.ok(start >= 0 && end > 0);
  const result = rest.slice(0, end);
  assert.equal(
    result.split('getCurveFromName(vk_verifier.curve, { singleThread: true })').length,
    2
  );
  return result;
};
const previousBody = body(historical),
  currentBody = body(first);
assert.equal(currentBody, previousBody);
const report = {
  observedAt: new Date().toISOString(),
  checkerSha256: digest(fs.readFileSync(__filename)),
  archiveSha256: manifest.sha256,
  size: manifest.size,
  builderSha256: manifest.builderSha256,
  inventorySha256: manifest.inventorySha256,
  repeatedArchiveHashes: hashes,
  separateFiles: true,
  verifierBodyMatchesHistorical: true,
  verifierBodySha256: digest(currentBody),
  historicalArchiveSha256: digest(fs.readFileSync(historical)),
  snarkjs: inventory.snarkjs,
  esbuild: inventory.esbuild,
  asar: inventory.asar,
  directBuildInputs: inventory.files.length,
  directPackageMetadataSets: inventory.packages.length,
  licenseTextAbsent: inventory.packages
    .filter((p) => !p.licenses.length)
    .map(({ name, version, license }) => ({ name, version, license })),
  productionDistributionApproved: false,
};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report));
