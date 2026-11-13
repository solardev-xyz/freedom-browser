const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const PROFILE_LOCK_TARGET = 'profile-open';
const PROFILE_LOCK_DIR = 'profile-open.lock';
const DEFAULT_STALE_MS = 30000;
const DEFAULT_UPDATE_MS = 10000;
const DEV_STALE_MS = 5000;
const DEV_UPDATE_MS = 1000;

let activeLock = null;

function getProfileLockPaths(profile) {
  if (!profile || !profile.userDataDir) {
    throw new Error('Profile userDataDir is required for profile locking');
  }

  return {
    targetPath: path.join(profile.userDataDir, PROFILE_LOCK_TARGET),
    lockDir: path.join(profile.userDataDir, PROFILE_LOCK_DIR),
  };
}

function ensureLockTarget(profile) {
  const paths = getProfileLockPaths(profile);
  fs.mkdirSync(profile.userDataDir, { recursive: true });
  if (!fs.existsSync(paths.targetPath)) {
    fs.writeFileSync(
      paths.targetPath,
      [
        'Freedom profile lock target',
        `profileId=${profile.id || ''}`,
        `createdAt=${new Date().toISOString()}`,
      ].join('\n')
    );
  }
  return paths;
}

function isLockUnavailableError(error) {
  return Boolean(error && error.code === 'ELOCKED');
}

function getProfileLockTiming(profile = {}, options = {}) {
  const isDevProfile = Boolean(profile.isDev || profile.dev);
  return {
    staleMs: options.staleMs ?? (isDevProfile ? DEV_STALE_MS : DEFAULT_STALE_MS),
    updateMs: options.updateMs ?? (isDevProfile ? DEV_UPDATE_MS : DEFAULT_UPDATE_MS),
  };
}

function isProfileLocked(profile, options = {}) {
  const paths = getProfileLockPaths(profile);
  if (!fs.existsSync(paths.targetPath)) {
    return false;
  }
  const timing = getProfileLockTiming(profile, options);

  return lockfile.checkSync(paths.targetPath, {
    lockfilePath: paths.lockDir,
    realpath: false,
    stale: timing.staleMs,
  });
}

// A lock directory whose mtime is past the stale time: a crashed process's,
// an older build's that stalled, or a new build's whose main has stalled
// (freedom-core design 0013, "What 'open' means"), which only the profile
// gate tells apart (profile-gate.js).
function hasStaleProfileLock(profile, options = {}) {
  const paths = getProfileLockPaths(profile);
  if (!fs.existsSync(paths.lockDir)) return false;
  try {
    return !isProfileLocked(profile, options);
  } catch {
    return false;
  }
}

function acquireProfileLock(profile, options = {}) {
  const paths = ensureLockTarget(profile);
  const logger = options.logger || console;
  const timing = getProfileLockTiming(profile, options);
  const release = lockfile.lockSync(paths.targetPath, {
    lockfilePath: paths.lockDir,
    realpath: false,
    retries: options.retries ?? 0,
    stale: timing.staleMs,
    update: timing.updateMs,
    onCompromised: options.onCompromised || ((error) => {
      logger.error('[profile-lock] Profile lock compromised:', error);
      throw error;
    }),
  });

  activeLock = {
    profileId: profile.id,
    displayName: profile.displayName,
    targetPath: paths.targetPath,
    lockDir: paths.lockDir,
    release,
    released: false,
  };

  return activeLock;
}

function releaseProfileLock(lockState = activeLock, options = {}) {
  if (!lockState || lockState.released) {
    return false;
  }

  try {
    lockState.release();
    lockState.released = true;
    if (activeLock === lockState) {
      activeLock = null;
    }
    return true;
  } catch (error) {
    if (error.code === 'ERELEASED' || error.code === 'ENOTACQUIRED') {
      lockState.released = true;
      if (activeLock === lockState) {
        activeLock = null;
      }
      return false;
    }

    const logger = options.logger || console;
    logger.error('[profile-lock] Failed to release profile lock:', error);
    throw error;
  }
}

function getActiveProfileLock() {
  return activeLock;
}

module.exports = {
  DEFAULT_STALE_MS,
  DEFAULT_UPDATE_MS,
  DEV_STALE_MS,
  DEV_UPDATE_MS,
  PROFILE_LOCK_DIR,
  PROFILE_LOCK_TARGET,
  acquireProfileLock,
  getActiveProfileLock,
  getProfileLockTiming,
  getProfileLockPaths,
  hasStaleProfileLock,
  isProfileLocked,
  isLockUnavailableError,
  releaseProfileLock,
};
