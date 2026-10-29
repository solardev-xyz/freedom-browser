/**
 * Owner-only directories and files for node keys and the configs that hold
 * their secrets (K-3).
 *
 * Node data directories hold key material: Ant's `keys/swarm.key` and the
 * `config.yaml` with its keystore password, Radicle's `keys/radicle`, the
 * identity vault. Created with the process umask, they come out 0755/0644
 * and any local account can read them. These helpers create them 0700/0600
 * and narrow ones that already exist.
 *
 * POSIX only: on Windows the modes are ignored and the files inherit the
 * user profile directory's ACL, so every helper is a no-op there beyond the
 * plain mkdir/write.
 */

const fs = require('fs');

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const POSIX = process.platform !== 'win32';

/**
 * Narrow `target` to `mode` if group or other have any access. A missing
 * path is fine; a path we may not chmod is logged and left alone.
 * @param {string} target
 * @param {number} mode
 * @returns {boolean} whether the mode was changed
 */
function restrictMode(target, mode) {
  if (!POSIX) return false;
  try {
    if ((fs.statSync(target).mode & 0o077) === 0) return false;
    fs.chmodSync(target, mode);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[PrivateFiles] Could not restrict ${target}:`, err.message);
    }
    return false;
  }
}

/**
 * Create `dir` (and missing parents) owner-only, or narrow it if it exists.
 * @param {string} dir
 * @returns {string} dir
 */
function ensurePrivateDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  restrictMode(dir, PRIVATE_DIR_MODE);
  return dir;
}

/**
 * Write `data` to `file` readable by the owner only. writeFileSync's `mode`
 * applies only when it creates the file, so an existing file is narrowed
 * first, before the new secret lands in it.
 * @param {string} file
 * @param {string|Buffer} data
 */
function writePrivateFileSync(file, data) {
  restrictMode(file, PRIVATE_FILE_MODE);
  fs.writeFileSync(file, data, { mode: PRIVATE_FILE_MODE });
}

module.exports = {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  restrictMode,
  ensurePrivateDir,
  writePrivateFileSync,
};
