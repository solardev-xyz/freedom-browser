// Integration-only provenance gate. Loading native code is still child-only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pin = require('../../../config/myotis-integration.json');
const MAX_BYTES = 1024 * 1024 * 1024;
const targetName = () => `${process.platform}-${process.arch}`;
function configuredTarget(target = targetName()) { return Object.hasOwn(pin.artifacts, target); }
function expectedArtifact(target) {
  const artifact = pin.artifacts[target];
  if (!artifact) throw new Error(`Myotis ABI 25 integration artifact unconfigured for ${target}; provision an exact source/lock/hash pin and local Node addon`);
  return { schema: pin.schema, sourceCommit: pin.sourceCommit, cargoLockSha256: pin.cargoLockSha256,
    abi: pin.abi, target, ...artifact };
}
function readRegular(file, maximum, consume, exactSize) {
  if (!path.isAbsolute(file)) throw new Error('Myotis artifact must be an absolute local file');
  // Nonblocking open cannot hang on a replaced FIFO. All bounds and reads use
  // the same descriptor; no lstat/readFile replacement window or giant buffer.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maximum ||
      (exactSize !== undefined && before.size !== exactSize)) throw new Error('Invalid Myotis artifact size or file type');
    const buffer = Buffer.alloc(Math.min(64 * 1024, before.size));
    let offset = 0;
    while (offset < before.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new Error('Truncated Myotis artifact');
      consume(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Myotis artifact changed during verification');
  } finally { fs.closeSync(fd); }
}
function readPinnedBytes(file, target, consume = () => {}) {
  const expected = expectedArtifact(target);
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 || expected.sizeBytes > MAX_BYTES) {
    throw new Error('Invalid pinned Myotis artifact size');
  }
  const hash = crypto.createHash('sha256');
  readRegular(file, MAX_BYTES, (chunk) => { hash.update(chunk); consume(chunk); }, expected.sizeBytes);
  if (hash.digest('hex') !== expected.sha256) throw new Error('Myotis artifact does not match the pinned hash');
}
function verifyArtifact(file, target = targetName()) {
  const expected = expectedArtifact(target);
  const manifest = path.join(path.dirname(file), 'myotis-artifact.json');
  const chunks = [];
  readRegular(manifest, 4096, (chunk) => chunks.push(Buffer.from(chunk)));
  const actual = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (Object.keys(actual).length !== Object.keys(expected).length ||
    Object.keys(expected).some((key) => actual[key] !== expected[key])) throw new Error('Myotis artifact provenance mismatch');
  readPinnedBytes(file, target);
  return expected;
}
module.exports = { pin, configuredTarget, expectedArtifact, readPinnedBytes, verifyArtifact };
