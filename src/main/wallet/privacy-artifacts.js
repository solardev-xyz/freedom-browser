/** Load main-reviewed, local public proving artifacts. No download fallback.
 * Digest checks bind bytes to the supplied manifest, not to an audit or chain.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
let activeLoads = 0;

function createPrivacyArtifactLoader({ handle, directory, manifest }) {
  const context = getPrivacyContext(handle);
  const invalid = () => privacyError('PRIVATE_ARTIFACT_INVALID', 'Proving artifact could not be validated');
  if (context.subject.kind !== 'private-account' || context.subject.role !== 'artifacts' ||
      context.subject.chainId !== 11155111 || typeof directory !== 'string' || !path.isAbsolute(directory) || !Array.isArray(manifest) ||
      !manifest.length || manifest.length > 32) throw invalid();
  let root;
  try { root = fs.realpathSync(directory); } catch { throw invalid(); }
  const entries = new Map();
  for (const entry of manifest) {
    if (!entry || typeof entry.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(entry.name) ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_ARTIFACT_BYTES ||
        typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || entries.has(entry.name)) throw invalid();
    entries.set(entry.name, { size: entry.size, sha256: entry.sha256 });
  }
  async function load(name, { signal } = {}) {
    getPrivacyContext(handle);
    const lifetime = AbortSignal.any([context.signal, ...(signal ? [signal] : [])]);
    const assertActive = () => {
      getPrivacyContext(handle);
      if (lifetime.aborted) throw privacyError('PRIVACY_REQUEST_ABORTED', 'Artifact loading cancelled');
    };
    assertActive();
    const entry = entries.get(name);
    if (!entry) throw invalid();
    if (activeLoads >= 2) throw privacyError('PRIVATE_ARTIFACT_BUSY', 'Artifact loading capacity reached');
    activeLoads += 1;
    let file, bytes, success = false;
    try {
      // O_NOFOLLOW rejects a final-component symlink. Parent directories are
      // main-selected; this is not protection against a hostile local OS user.
      file = await fs.promises.open(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      assertActive();
      const info = await file.stat();
      if (!info.isFile() || info.size !== entry.size) throw invalid();
      assertActive();
      bytes = Buffer.allocUnsafe(entry.size);
      const digest = createHash('sha256');
      let offset = 0;
      while (offset < entry.size) {
        assertActive();
        const { bytesRead } = await file.read(bytes, offset, Math.min(1024 * 1024, entry.size - offset), offset);
        if (!bytesRead) throw invalid();
        digest.update(bytes.subarray(offset, offset + bytesRead)); offset += bytesRead;
      }
      const after = await file.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || digest.digest('hex') !== entry.sha256) throw invalid();
      await file.close(); file = null;
      assertActive(); success = true;
      return bytes;
    } catch (error) {
      if (lifetime.aborted) assertActive();
      if (error?.code?.startsWith('PRIVACY_')) throw error;
      throw invalid();
    } finally {
      if (!success) bytes?.fill(0);
      try { if (file) await file.close(); } catch { /* Preserve the original fixed failure on cleanup errors. */ }
      finally { activeLoads -= 1; }
    }
  }
  return Object.freeze({ load });
}

module.exports = { createPrivacyArtifactLoader };
