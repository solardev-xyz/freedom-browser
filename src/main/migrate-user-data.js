/**
 * User data migration module
 *
 * Migrates user data from "Freedom Browser" to "Freedom" directory
 * when the app name changes. This ensures users don't lose their:
 * - Settings
 * - Bookmarks
 * - History
 * - Favicons cache
 * - Bee/IPFS node data
 */

const log = require('./logger');
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

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
 * bee-data/ and ipfs-data/ can be gigabytes - moving is instant, copying takes minutes.
 *
 * This function should be called early in app startup, before any modules
 * try to access userData.
 *
 * @returns {boolean} true if migration was performed, false otherwise
 */
function migrateUserData() {
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

module.exports = {
  migrateUserData,
  getOldUserDataPath,
};
