/** Development fixture inventory; authenticate all installed files before import.
 * npm bookkeeping and executable links are excluded and never invoked by jobs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function inventoryRailgunFixture(directory) {
  const digest = crypto.createHash('sha256');
  let files = 0,
    bytes = 0;
  const nativeFiles = [];
  function walk(relative = '') {
    const current = path.join(directory, relative);
    for (const name of fs.readdirSync(current).sort()) {
      if (
        (!relative || path.basename(relative) === 'node_modules') &&
        (name === '.bin' || name === '.package-lock.json')
      )
        continue;
      const file = path.join(relative, name),
        full = path.join(directory, file),
        stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('Unexpected runtime symlink');
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      if (!stat.isFile()) throw new Error('Unexpected runtime file');
      const data = fs.readFileSync(full),
        portable = file.split(path.sep).join('/');
      digest
        .update(portable + '\0' + data.length + '\0')
        .update(crypto.createHash('sha256').update(data).digest('hex') + '\n');
      files++;
      bytes += data.length;
      if (/\.(node|wasm)$/.test(name)) nativeFiles.push(portable);
    }
  }
  walk();
  return { sha256: digest.digest('hex'), files, bytes, nativeFiles };
}
function assertRailgunFixture(directory) {
  const expected = require('./fixtures/railgun-engine/runtime-integrity.json');
  const actual = inventoryRailgunFixture(directory);
  if (JSON.stringify(actual) !== JSON.stringify(expected.inventory))
    throw new Error('Railgun fixture integrity mismatch');
  const lock = fs.readFileSync(path.join(directory, '..', 'package-lock.json'));
  if (crypto.createHash('sha256').update(lock).digest('hex') !== expected.lockSha256)
    throw new Error('Railgun fixture lock mismatch');
  return actual;
}
module.exports = { inventoryRailgunFixture, assertRailgunFixture };
