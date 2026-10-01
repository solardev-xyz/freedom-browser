/** Main-selected, completely packed SDK closure. Verify before executing code.
 * The application and local OS are trusted: this is not a filesystem sandbox
 * or protection against a privileged writer racing Node's subsequent require.
 * Node/Electron may cache modules and archive handles: callers must not preload
 * archive code. Production distribution still needs immutable signed resources.
 */
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const { createHash } = require('crypto');
const manifest = require('./ppv2-runtime-manifest');
const { privacyError } = require('../networks/privacy-context');
const candidates = new WeakMap();
const fail = () => privacyError('PRIVATE_PPV2_RUNTIME_INVALID', 'PPv2 runtime could not be authenticated');

function verifyPPv2Runtime(archive) {
  if (typeof archive !== 'string' || !path.isAbsolute(archive) || path.extname(archive) !== '.asar') throw fail();
  let fd;
  try {
    // Electron's patched fs treats ASAR paths as directories. Hash the actual
    // container using original-fs, including every transitive module/worker.
    const info = fs.lstatSync(archive, { bigint: true });
    if (!info.isFile() || info.size !== BigInt(manifest.size)) throw fail();
    try { fs.lstatSync(`${archive}.unpacked`); throw fail(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const canonical = fs.realpathSync(archive);
    fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(manifest.size) || before.ino !== info.ino || before.dev !== info.dev) throw fail();
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < manifest.size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, manifest.size - offset), offset);
      if (!read) throw fail();
      digest.update(buffer.subarray(0, read)); offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(archive, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        !current.isFile() || current.ino !== before.ino || current.dev !== before.dev ||
        digest.digest('hex') !== manifest.sha256 || fs.realpathSync(archive) !== canonical) throw fail();
    return canonical;
  } catch { throw fail(); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* A read-only descriptor close does not alter verified bytes. */ } } }
}

function assertPPv2RuntimeEntries({ sdkEntry, proverEntry }) {
  if (typeof sdkEntry !== 'string' || path.basename(sdkEntry) !== 'sdk.cjs') throw fail();
  const archive = verifyPPv2Runtime(path.dirname(sdkEntry));
  if (sdkEntry !== path.join(archive, 'sdk.cjs') ||
      (proverEntry !== undefined && proverEntry !== path.join(archive, 'serial-prover.cjs'))) throw fail();
  return archive;
}

function loadPPv2Runtime(filename) {
  const archive = verifyPPv2Runtime(filename);
  const { PPV2_CANDIDATE } = require('./ppv2-session');
  const source = JSON.parse(require('fs').readFileSync(path.join(archive, 'candidate.json'), 'utf8'));
  if (source.sdk !== PPV2_CANDIDATE.sdk || source.kohaku !== PPV2_CANDIDATE.kohaku ||
      source.patchSha256 !== manifest.compatibilityPatchSha256) throw fail();
  const adapter = require(path.join(archive, 'plugin.cjs'));
  const candidate = Object.freeze({ ...PPV2_CANDIDATE,
    createPlugin: adapter.createPPv2Plugin, createBroadcaster: adapter.createPPv2Broadcaster,
    inspectRegistration: adapter.inspectRegistration, inspectChange: adapter.inspectChange });
  if (['createPlugin', 'createBroadcaster', 'inspectRegistration', 'inspectChange'].some((key) => typeof candidate[key] !== 'function')) throw fail();
  candidates.set(candidate, archive);
  return Object.freeze({ candidate, archive, sdkEntry: path.join(archive, 'sdk.cjs'),
    proverEntry: path.join(archive, 'serial-prover.cjs') });
}

function assertPPv2Candidate(candidate, proving) {
  const archive = candidates.get(candidate);
  if (!archive || verifyPPv2Runtime(archive) !== archive) throw fail();
  if (proving && (proving.sdkEntry !== path.join(archive, 'sdk.cjs') ||
      [proving.ragequitProverEntry, proving.transactProverEntry].some((entry) =>
        entry !== undefined && entry !== path.join(archive, 'serial-prover.cjs')))) throw fail();
}

function readPPv2RuntimeMetadata(filename) {
  const archive = verifyPPv2Runtime(filename);
  return { manifest: require(path.join(archive, 'sdk.cjs')).DEFAULT_CIRCUIT_MANIFEST,
    abis: require(path.join(archive, 'abis.cjs')) };
}

module.exports = Object.freeze({ readPPv2RuntimeMetadata, verifyPPv2Runtime, loadPPv2Runtime, assertPPv2Candidate, assertPPv2RuntimeEntries });
