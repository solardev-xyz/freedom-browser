/**
 * User data migration module
 *
 * One-time startup migrations, run before any other module touches userData:
 *
 * 1. "Freedom Browser" → "Freedom" directory rename (app name change).
 *    Preserves settings, bookmarks, history, favicons, and node data.
 *
 * 2. `bee-data/` → `ant-data/` (Bee → Ant node swap). Carries over the
 *    injected node identity so upgrading users keep their Swarm wallet
 *    (overlay address, postage stamps, chequebook funds).
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsOffload = require('./fs-offload');

const OLD_APP_NAME = 'Freedom Browser';
const MIGRATION_MARKER = '.migrated-from-freedom-browser';

/**
 * Get the old userData path (before app name change)
 */
function getOldUserDataPath() {
  const currentPath = app.getPath('userData');
  const parentDir = path.dirname(currentPath);
  return path.join(parentDir, OLD_APP_NAME);
}

/**
 * Check if directory is empty or only contains the migration marker
 */
function isEffectivelyEmpty(dir) {
  if (!fs.existsSync(dir)) return true;

  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return true;
  if (entries.length === 1 && entries[0] === MIGRATION_MARKER) return true;

  return false;
}

/**
 * Migrate user data from old "Freedom Browser" directory to new "Freedom" directory
 *
 * Uses move (rename) instead of copy for speed and to avoid doubling disk usage.
 * ant-data/ and ipfs-data/ can be gigabytes - moving is instant, copying takes minutes.
 *
 * This function should be called early in app startup, before any modules
 * try to access userData.
 *
 * @returns {boolean} true if migration was performed, false otherwise
 */
function getLogger(logger) {
  return logger || require('./logger');
}

function migrateUserData(options = {}) {
  const log = getLogger(options.logger);
  const newPath = app.getPath('userData');
  const oldPath = getOldUserDataPath();
  const markerPath = path.join(newPath, MIGRATION_MARKER);

  // Skip if we've already migrated
  if (fs.existsSync(markerPath)) {
    return false;
  }

  // Skip if old directory doesn't exist
  if (!fs.existsSync(oldPath)) {
    // Create marker to indicate no migration needed
    try {
      if (!fs.existsSync(newPath)) {
        fs.mkdirSync(newPath, { recursive: true });
      }
      fs.writeFileSync(markerPath, `No migration needed - old directory not found: ${oldPath}`);
    } catch {
      // Ignore marker creation errors
    }
    return false;
  }

  // Skip if new directory already has data (not just marker)
  if (!isEffectivelyEmpty(newPath)) {
    log.info('[Migration] New userData directory already has data, skipping migration');
    try {
      fs.writeFileSync(markerPath, `Migration skipped - new directory already has data`);
    } catch {
      // Ignore marker creation errors
    }
    return false;
  }

  log.info('[Migration] Migrating user data from:', oldPath);
  log.info('[Migration] To:', newPath);

  try {
    // Remove new directory if it exists but is empty (so we can rename old to new)
    if (fs.existsSync(newPath)) {
      const entries = fs.readdirSync(newPath);
      if (entries.length === 0) {
        fs.rmdirSync(newPath);
      }
    }

    // Try to rename the entire directory (instant on same filesystem)
    if (!fs.existsSync(newPath)) {
      try {
        fs.renameSync(oldPath, newPath);
        log.info('[Migration] Renamed directory successfully (fast path)');

        // Create migration marker
        const markerContent = [
          `Migration completed: ${new Date().toISOString()}`,
          `Method: rename (fast)`,
          `From: ${oldPath}`,
          `To: ${newPath}`,
        ].join('\n');
        fs.writeFileSync(markerPath, markerContent);

        return true;
      } catch (renameErr) {
        // Rename failed (possibly cross-filesystem), fall back to move items
        log.info(
          '[Migration] Rename failed, falling back to item-by-item move:',
          renameErr.message
        );
        fs.mkdirSync(newPath, { recursive: true });
      }
    }

    // Fall back: move items one by one
    const entries = fs.readdirSync(oldPath, { withFileTypes: true });
    let migratedItems = [];

    for (const entry of entries) {
      const srcPath = path.join(oldPath, entry.name);
      const destPath = path.join(newPath, entry.name);

      try {
        fs.renameSync(srcPath, destPath);
        log.info(`[Migration] Moved: ${entry.name}`);
        migratedItems.push(entry.name);
      } catch (err) {
        log.error(`[Migration] Failed to move ${entry.name}:`, err.message);
      }
    }

    // Try to remove the now-empty old directory
    try {
      const remaining = fs.readdirSync(oldPath);
      if (remaining.length === 0) {
        fs.rmdirSync(oldPath);
        log.info('[Migration] Removed empty old directory');
      }
    } catch {
      // Ignore - old directory may have items we couldn't move
    }

    // Create migration marker with details
    const markerContent = [
      `Migration completed: ${new Date().toISOString()}`,
      `Method: move (item-by-item)`,
      `From: ${oldPath}`,
      `To: ${newPath}`,
      `Items migrated: ${migratedItems.join(', ')}`,
    ].join('\n');

    fs.writeFileSync(markerPath, markerContent);

    log.info(`[Migration] Successfully migrated ${migratedItems.length} items`);
    return true;
  } catch (err) {
    log.error('[Migration] Migration failed:', err);
    return false;
  }
}

// Bee-only LevelDB state antd cannot read. Dropped during bee-data → ant-data
// migration so users don't carry gigabytes of dead cache. `stamperstore` is
// deliberately KEPT: antd's bee-recover feature reads a carried-over bee
// stamperstore to seed the bucket counters of rediscovered postage batches.
const BEE_ONLY_DIRS = ['statestore', 'localstore', 'kademlia-metrics'];

// Identity-critical items carried over when ant-data already exists and a
// whole-directory rename isn't possible. `keys/` holds the injected Web3 v3
// keystore (swarm.key); `config.yaml` holds the password that decrypts it
// (ant-manager's ensureConfig preserves that password on rewrite).
//
// ORDER MATTERS: `keys` must move LAST. The retry precondition is "bee-data
// still has keys/swarm.key and ant-data doesn't" — if an earlier item's move
// fails (e.g. Windows EPERM on a locked handle), the keystore hasn't moved
// yet, so the next launch retries cleanly. Moving keys first would let a
// later failure strand a keystore in ant-data whose password is still in
// bee-data, with no retry.
const BEE_CARRY_ITEMS = ['config.yaml', 'stamperstore', 'keys'];

// Where Bee-only dirs wait for their off-main-thread delete. Inside the
// profile's userData (so a profile delete takes it along) and next to
// ant-data, so moving a dir here is a plain rename.
const BEE_SET_ASIDE_DIR = '.bee-only-data-pending-delete';

function getBeeSetAsideDir() {
  return path.join(getNodeDataBaseDir(), BEE_SET_ASIDE_DIR);
}

// Move one Bee-only dir out of ant-data. If the rename fails (it shouldn't:
// same parent filesystem), fall back to the synchronous delete this replaced,
// so ant-data never keeps Bee state antd can't read.
function setAsideBeeOnlyDir(stale, dir, log) {
  const setAside = getBeeSetAsideDir();
  try {
    fs.mkdirSync(setAside, { recursive: true });
    // Unique name: an earlier set-aside may still be waiting for its purge.
    fs.renameSync(stale, path.join(setAside, `${dir}-${Date.now()}-${process.pid}`));
    log.info(`[Migration] Set aside Bee-only ${dir}/ for background removal`);
  } catch (renameErr) {
    log.warn(
      `[Migration] Could not set aside Bee-only ${dir}/, removing it in place:`,
      renameErr.message
    );
    fs.rmSync(stale, { recursive: true, force: true });
    log.info(`[Migration] Removed Bee-only ${dir}/`);
  }
}

/**
 * Delete the Bee-only data migrateBeeDataToAntData() set aside, in a worker
 * thread (fs-offload, #513) so the main thread never blocks on it. Call once
 * the first window is up. Also picks up a set-aside dir left by a launch that
 * quit before its purge finished; does nothing (one existsSync) otherwise.
 *
 * @returns {Promise<boolean>} true if a set-aside dir was removed
 */
async function purgeSetAsideBeeData(options = {}) {
  const log = getLogger(options.logger);
  const setAside = getBeeSetAsideDir();
  if (!fs.existsSync(setAside)) {
    return false;
  }
  const startedAt = Date.now();
  try {
    await fsOffload.removePath(setAside, { recursive: true, force: true });
    log.info(`[Migration] Removed set-aside Bee-only data in ${Date.now() - startedAt} ms`);
    return true;
  } catch (err) {
    // Retried on the next launch: the set-aside dir is still there.
    log.warn('[Migration] Could not remove set-aside Bee-only data (will retry):', err.message);
    return false;
  }
}

function getNodeDataBaseDir() {
  // The Bee -> Ant migration must operate on the active profile's userData
  // directory. In profile-aware dev builds that is
  // `Freedom Dev/<checkout>/Profiles/<profile>/`, not the repository root.
  // We intentionally do not revive/migrate legacy repo-root dev node data here.
  return app.getPath('userData');
}

/**
 * Whether a bee-data → ant-data identity migration is still required: bee-data/
 * holds an injected keystore that ant-data/ doesn't have yet. While this is
 * true the Ant node must NOT be started — antd would self-generate a throwaway
 * identity (wrong overlay address, none of the user's postage stamps or
 * chequebook funds) instead of the about-to-be-migrated one.
 *
 * INVARIANT this check depends on: antd must NEVER create `keys/swarm.key`
 * itself — its self-generated identity lives in `identity.json`/`signing.key`,
 * and `keys/swarm.key` only ever appears via Freedom's injection or this
 * migration. If a future antd version wrote that path on self-init, this
 * precondition would become permanently false and a funded bee-era identity
 * would be silently abandoned with no retry. The real-binary integration test
 * (src/main/identity/__tests__/integration/bee-to-ant-migration.test.js)
 * asserts this invariant on a fresh antd start and runs in CI on every
 * platform — re-validate it on every antd version bump.
 *
 * @returns {boolean}
 */
function isBeeDataMigrationPending() {
  // Set only by tests/E2E runs that want a throwaway data dir — those never
  // participate in the migration.
  if (process.env.FREEDOM_ANT_DATA) {
    return false;
  }

  const baseDir = getNodeDataBaseDir();
  return (
    fs.existsSync(path.join(baseDir, 'bee-data', 'keys', 'swarm.key')) &&
    !fs.existsSync(path.join(baseDir, 'ant-data', 'keys', 'swarm.key'))
  );
}

/**
 * Migrate the Bee-era node data directory (`bee-data/`) to the Ant location
 * (`ant-data/`) so an upgrading user's injected Swarm identity survives the
 * Bee → Ant node swap. Without this, antd starts on an empty ant-data/ and
 * self-generates a throwaway identity — a different overlay address with none
 * of the user's postage stamps or chequebook funds — and nothing re-injects
 * the real key outside the onboarding wizard.
 *
 * Idempotent without a marker file: it only acts while isBeeDataMigrationPending()
 * holds. Either path (rename or item-by-item carry) makes the precondition
 * false afterwards.
 *
 * Must run before the Ant node starts.
 *
 * @returns {boolean} true if a migration was performed
 */
function migrateBeeDataToAntData(options = {}) {
  const log = getLogger(options.logger);

  if (!isBeeDataMigrationPending()) {
    return false;
  }

  const baseDir = getNodeDataBaseDir();
  const oldDir = path.join(baseDir, 'bee-data');
  const newDir = path.join(baseDir, 'ant-data');

  log.info('[Migration] Migrating Bee node data from:', oldDir);
  log.info('[Migration] To:', newDir);

  try {
    let renamed = false;
    if (!fs.existsSync(newDir)) {
      // Fast path: same parent directory, so rename the whole thing.
      try {
        fs.renameSync(oldDir, newDir);
        renamed = true;
        log.info('[Migration] Renamed bee-data to ant-data (fast path)');
      } catch (renameErr) {
        // E.g. a stray lock or cross-filesystem userData. Fall through to the
        // item-by-item carry below instead of failing the same way forever.
        log.warn(
          '[Migration] Whole-directory rename failed, falling back to item-by-item carry:',
          renameErr.message
        );
        fs.mkdirSync(newDir, { recursive: true });
      }
    }

    if (!renamed) {
      // ant-data exists (e.g. antd already ran and self-generated a throwaway
      // identity, or the rename above failed). Drop antd's self-generated
      // identity FIRST, then carry over the identity-critical items (keys
      // last, see BEE_CARRY_ITEMS). Moving keys/swarm.key into ant-data is
      // the commit point that clears the retry precondition
      // (isBeeDataMigrationPending), so every step that must succeed has to
      // happen before it — a stale identity.json left behind would otherwise
      // win over the migrated keystore with no retry on next launch.
      for (const idFile of ['identity.json', 'signing.key']) {
        const stale = path.join(newDir, idFile);
        if (fs.existsSync(stale)) {
          fs.rmSync(stale, { force: true });
          log.info(`[Migration] Removed antd self-generated ${idFile}`);
        }
      }
      for (const item of BEE_CARRY_ITEMS) {
        const src = path.join(oldDir, item);
        const dest = path.join(newDir, item);
        if (!fs.existsSync(src)) continue;
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(src, dest);
        log.info(`[Migration] Carried over ${item} from bee-data`);
      }
    }

    // Drop Bee-only LevelDB state antd can't use (can be gigabytes). Deleting
    // it here would hold up the first window for as long as the delete takes
    // (#526), so each dir is only *renamed* out of ant-data into a sibling
    // set-aside dir — instant, same filesystem — and purgeSetAsideBeeData()
    // deletes that off the main thread once the window is up. The rename has
    // to happen now, not later: antd keeps its own `statestore/` in ant-data,
    // so a deferred delete of `ant-data/statestore` could hit the live one.
    // Best-effort: this runs after the keystore landed (the commit point
    // above, or the whole-directory rename), so a stray lock here must not
    // report the already-complete identity migration as failed.
    for (const dir of BEE_ONLY_DIRS) {
      const stale = path.join(newDir, dir);
      try {
        if (fs.existsSync(stale)) {
          setAsideBeeOnlyDir(stale, dir, log);
        }
      } catch (err) {
        log.warn(`[Migration] Could not remove Bee-only ${dir}/ (continuing):`, err.message);
      }
    }

    log.info('[Migration] Bee → Ant node data migration complete');
    return true;
  } catch (err) {
    // Leave whatever state we reached in place; the preconditions above make a
    // retry on next launch safe.
    log.error('[Migration] bee-data → ant-data migration failed:', err);
    return false;
  }
}

module.exports = {
  migrateUserData,
  migrateBeeDataToAntData,
  purgeSetAsideBeeData,
  isBeeDataMigrationPending,
  getOldUserDataPath,
};
