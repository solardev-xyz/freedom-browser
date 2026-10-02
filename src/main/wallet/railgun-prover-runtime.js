/** Independently packed serial prover, verified before utility-process import.
 * Local OS/application code is trusted. As with the PPv2 loader this does not
 * defend against a privileged writer racing a subsequent require or preloaded
 * module caches; production use requires immutable authenticated resources.
 */
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const { createHash } = require('crypto');
const manifest = require('./railgun-prover-manifest.json');
const fail = () =>
  Object.assign(new Error('Railgun prover runtime could not be authenticated'), {
    code: 'RAILGUN_PROVER_RUNTIME_INVALID',
  });
function verifyRailgunProverRuntime(archive) {
  if (typeof archive !== 'string' || !path.isAbsolute(archive) || path.extname(archive) !== '.asar')
    throw fail();
  let fd;
  try {
    // Electron's patched fs treats ASAR paths as directories. Hash the actual
    // container using original-fs, including every transitive module/worker.
    const info = fs.lstatSync(archive, { bigint: true });
    if (!info.isFile() || info.size !== BigInt(manifest.size)) throw fail();
    try {
      fs.lstatSync(`${archive}.unpacked`);
      throw fail();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const canonical = fs.realpathSync(archive);
    fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size !== BigInt(manifest.size) ||
      before.ino !== info.ino ||
      before.dev !== info.dev
    )
      throw fail();
    const digest = createHash('sha256'),
      buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < manifest.size) {
      const read = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, manifest.size - offset),
        offset
      );
      if (!read) throw fail();
      digest.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true }),
      current = fs.lstatSync(archive, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      !current.isFile() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      digest.digest('hex') !== manifest.sha256 ||
      fs.realpathSync(archive) !== canonical
    )
      throw fail();
    return canonical;
  } catch {
    throw fail();
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* A read-only descriptor close does not alter verified bytes. */
      }
    }
  }
}

module.exports = { verifyRailgunProverRuntime };
