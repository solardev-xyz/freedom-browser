const fs = require('fs');
const path = require('path');
const {
  DEFAULT_PROFILE_ID,
  createProfile,
  deleteProfile,
  ensureProfile,
  getCheckoutId,
  getReservedManagedPorts,
  hashPath,
  importProfile,
  listProfileSummaries,
  loadCatalog,
  renameProfile,
  sanitizeProfileId,
  updateProfileNodeConfig,
  validateProfileDeletion,
  waitForCatalogWriteLockIdle,
} = require('./profile-catalog');
const { isProfileLocked } = require('./profile-lock');
const { parseProfileSwitchArgv } = require('./profile-switch-scheme');

// A launch carrying an `x-freedom-profile:` switch (profile-switch-scheme.js)
// that names no registered profile. index.js exits quietly on it: whatever
// sent it gets neither a window nor a new profile.
const PROFILE_SWITCH_REJECTED = 'PROFILE_SWITCH_REJECTED';

// Pre-profile dev builds wrote node/identity data directly into the repo
// checkout (`<repoRoot>/bee-data`, `identity-data`, etc.). The profile system
// moved dev data to `Freedom Dev/<checkout>/Profiles/<id>/`. By design we do
// NOT auto-migrate this legacy repo-root data into the new default profile:
// dev data is disposable/regenerable and re-onboarding is cheap, so on upgrade
// the app boots a fresh default profile and only *warns* about the stranded
// dirs (see warnAboutLegacyDevData). Developers who want to keep old dev state
// can point FREEDOM_DEV_HOME (or explicit data-path overrides) at it. This is
// deliberately weaker than the packaged upgrade path, which adopts existing
// userData in place and runs the bee->ant migration.
const LEGACY_DEV_DATA_DIRS = [
  'identity-data',
  'bee-data',
  'ant-data',
  'ipfs-data',
  'radicle-data',
  'tor-data',
];
const LEGACY_DEV_DATA_WARNING_FILE = 'legacy-dev-data-warning.json';
const AUTOMATION_PROFILE_ID = 'automation';

let activeProfile = null;

function getArgValue(argv, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
    if (arg === `--${name}` && index + 1 < argv.length) {
      return argv[index + 1];
    }
  }
  return null;
}

function findRepoRoot(startDir) {
  let current = fs.realpathSync(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to find repository root from ${startDir}`);
    }
    current = parent;
  }
}

function getDefaultRepoRoot() {
  return findRepoRoot(path.join(__dirname, '..', '..'));
}

function resolveDevAppRoot(app, env, repoRoot) {
  if (env.FREEDOM_DEV_HOME) {
    return path.resolve(env.FREEDOM_DEV_HOME);
  }

  return path.join(app.getPath('appData'), 'Freedom Dev', getCheckoutId(repoRoot));
}

// Returns the id of the most recently opened registered profile, so a cold
// start with no explicit profile reopens whatever was last active. Falls back
// to null when the catalog is empty/unreadable or no profile has been opened.
function resolveLastOpenedProfileId(appRoot) {
  let catalog;
  try {
    catalog = loadCatalog(appRoot);
  } catch {
    return null;
  }

  let lastId = null;
  let lastOpenedAt = null;
  for (const profile of catalog.profiles || []) {
    if (!profile?.id || !profile.lastOpenedAt) continue;
    if (lastOpenedAt === null || profile.lastOpenedAt > lastOpenedAt) {
      lastOpenedAt = profile.lastOpenedAt;
      lastId = profile.id;
    }
  }
  return lastId;
}

// The profile a cold start falls back to when nothing (argv, env, last-opened)
// picked one. That is the `default` profile while it is registered; once the
// user has deleted it (#124) it is the first remaining registered profile, so
// a bare launch opens an existing profile instead of silently resurrecting the
// deleted one. Returns null for an empty/unreadable catalog (first run), where
// the caller creates `default`.
function resolveFallbackProfileId(appRoot) {
  let catalog;
  try {
    catalog = loadCatalog(appRoot);
  } catch {
    return null;
  }

  const ids = (catalog.profiles || []).map((profile) => profile?.id).filter(Boolean);
  if (ids.includes(DEFAULT_PROFILE_ID)) return DEFAULT_PROFILE_ID;
  return ids[0] || null;
}

function findRegisteredProfile(appRoot, profileId) {
  try {
    return (loadCatalog(appRoot).profiles || []).find((profile) => profile?.id === profileId) || null;
  } catch {
    return null;
  }
}

function rejectProfileSwitch(reason) {
  const error = new Error(`Refused an x-freedom-profile switch to ${reason}`);
  error.code = PROFILE_SWITCH_REJECTED;
  throw error;
}

function isRunning(isLocked, profile) {
  try {
    return isLocked(profile) === true;
  } catch {
    return false;
  }
}

// The profile an `x-freedom-profile:<id>` launch switches to: `id` only when
// it is a canonical id already registered in the catalog *and* that profile is
// open right now. The scheme exists to raise a running profile; anything that
// can run xdg-open (a page in another browser included) may send it, so it
// must not cold-start one, with its nodes. Anything else is refused rather
// than mapped to some other profile or created.
function resolveProfileSwitchId(appRoot, profileSwitch, { isDev = false, isLocked = isProfileLocked } = {}) {
  const record = profileSwitch.id ? findRegisteredProfile(appRoot, profileSwitch.id) : null;
  if (!record?.dir) rejectProfileSwitch('an unknown profile');
  if (!isRunning(isLocked, { id: record.id, userDataDir: record.dir, isDev })) {
    rejectProfileSwitch(`"${record.id}", which is not open`);
  }
  return record.id;
}

function hasRegisteredProfiles(appRoot) {
  try {
    return (loadCatalog(appRoot).profiles || []).length > 0;
  } catch {
    return false;
  }
}

function resolveProfile(app, options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;

  if (env.FREEDOM_TEST_USER_DATA) {
    const userDataDir = path.resolve(env.FREEDOM_TEST_USER_DATA);
    return {
      id: 'test',
      displayName: 'Test',
      source: 'test-user-data',
      appRoot: userDataDir,
      userDataDir,
      isDev: !app.isPackaged,
      catalogPath: null,
      metadata: null,
    };
  }

  const explicitProfileDir = getArgValue(argv, 'profile-dir');
  if (explicitProfileDir) {
    const userDataDir = path.resolve(explicitProfileDir);
    const id = sanitizeProfileId(path.basename(userDataDir) || DEFAULT_PROFILE_ID);
    return {
      id,
      displayName: id,
      source: 'profile-dir',
      appRoot: userDataDir,
      userDataDir,
      isDev: !app.isPackaged,
      catalogPath: null,
      metadata: null,
    };
  }

  const isDev = !app.isPackaged;
  const repoRoot = options.repoRoot
    ? fs.realpathSync(options.repoRoot)
    : isDev
      ? getDefaultRepoRoot()
      : null;
  const checkoutHash = repoRoot ? hashPath(repoRoot) : null;
  const appRoot = isDev
    ? resolveDevAppRoot(app, env, repoRoot)
    : app.getPath('userData');
  // An explicit --profile wins over an `x-freedom-profile:` switch; xdg-open,
  // the only thing that sends one, never passes both.
  const explicitProfile = getArgValue(argv, 'profile');
  const profileSwitch = explicitProfile
    ? null
    : parseProfileSwitchArgv(argv, { platform: options.platform || process.platform });
  const switchId = profileSwitch
    ? resolveProfileSwitchId(appRoot, profileSwitch, {
        isDev,
        isLocked: options.isProfileLocked || isProfileLocked,
      })
    : null;
  const profileInput =
    explicitProfile ||
    switchId ||
    env.FREEDOM_PROFILE ||
    (argv.includes('--runtime') ? AUTOMATION_PROFILE_ID : resolveLastOpenedProfileId(appRoot)) ||
    resolveFallbackProfileId(appRoot) ||
    DEFAULT_PROFILE_ID;
  const profileId = sanitizeProfileId(profileInput);
  const defaultProfileDir = isDev
    ? path.join(appRoot, 'Profiles', DEFAULT_PROFILE_ID)
    : appRoot;

  // Register `default` (slot 0, and in a packaged build the adopted
  // pre-profiles userData) only on a first run, when the catalog is still
  // empty. Once profiles exist the user may have deleted `default` on purpose
  // (#124), and launching another profile must not bring it back.
  if (profileId !== DEFAULT_PROFILE_ID && !hasRegisteredProfiles(appRoot)) {
    ensureProfile(appRoot, DEFAULT_PROFILE_ID, {
      checkoutHash,
      defaultProfileDir,
      dev: isDev,
      now: options.now,
    });
  }

  const { catalogPath, record, metadata } = ensureProfile(appRoot, profileId, {
    checkoutHash,
    defaultProfileDir,
    dev: isDev,
    // A switch hands over to the open profile and exits: it is not an
    // opening of its own, so it leaves "last opened" (what a plain `freedom`
    // launch picks) alone.
    markOpened: !switchId,
    now: options.now,
  });

  return {
    ...(switchId ? { switchOnly: true } : {}),
    id: metadata.id,
    displayName: metadata.displayName,
    source: 'catalog',
    appRoot,
    userDataDir: record.dir,
    isDev,
    repoRoot,
    checkoutHash,
    catalogPath,
    metadata,
  };
}

function applyProfile(app, profile) {
  if (app.setPath) {
    app.setPath('userData', profile.userDataDir);
    app.setPath('crashDumps', path.join(profile.userDataDir, 'crash-reports'));
  }
}

function getLegacyDevDataDirs(profile) {
  if (!profile?.isDev || !profile.repoRoot) return [];

  return LEGACY_DEV_DATA_DIRS
    .map((dirName) => path.join(profile.repoRoot, dirName))
    .filter((dirPath) => fs.existsSync(dirPath));
}

function warnAboutLegacyDevData(profile, options = {}) {
  const legacyDirs = getLegacyDevDataDirs(profile);
  if (!legacyDirs.length || !profile?.appRoot) {
    return { warned: false, paths: legacyDirs };
  }

  const markerPath = path.join(profile.appRoot, LEGACY_DEV_DATA_WARNING_FILE);
  if (fs.existsSync(markerPath) && options.force !== true) {
    return { warned: false, paths: legacyDirs, markerPath };
  }

  const logger = options.logger || console;
  logger.warn?.(
    '[profile] Legacy repo-root dev data detected. Freedom Dev profiles ignore these directories by default:',
    legacyDirs
  );
  logger.warn?.(
    '[profile] To intentionally reuse old dev data, point FREEDOM_DEV_HOME or explicit data-path overrides at the desired location.'
  );

  try {
    fs.mkdirSync(profile.appRoot, { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          warnedAt: new Date().toISOString(),
          repoRoot: profile.repoRoot,
          paths: legacyDirs,
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (error) {
    logger.warn?.('[profile] Failed to write legacy dev data warning marker:', error.message);
  }

  return { warned: true, paths: legacyDirs, markerPath };
}

function initializeProfile(app, options = {}) {
  activeProfile = resolveProfile(app, options);
  applyProfile(app, activeProfile);
  return activeProfile;
}

function getActiveProfile() {
  return activeProfile;
}

function updateActiveProfileNodeConfig(protocol, updates) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  const result = updateProfileNodeConfig(activeProfile, protocol, updates);
  if (result?.metadata) {
    activeProfile.metadata = result.metadata;
  }
  return result;
}

// Same as updateActiveProfileNodeConfig, but first waits out any in-process
// async catalog write (a profile deletion running its multi-GB rm off the main
// thread) instead of failing fast with ELOCKED. For node managers persisting a
// fallback port during start, where a transient "catalog busy" would otherwise
// leave the node in ERROR.
async function updateActiveProfileNodeConfigWhenIdle(protocol, updates) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }
  await waitForCatalogWriteLockIdle(activeProfile.appRoot);
  return updateActiveProfileNodeConfig(protocol, updates);
}

function getReservedProfilePorts(profile = activeProfile) {
  if (!profile || profile.source !== 'catalog') {
    return new Set();
  }

  return getReservedManagedPorts(profile.appRoot, {
    ...getProfileCatalogOptions(profile),
    excludeProfileId: profile.id,
  });
}

function getProfileCatalogOptions(profile = activeProfile) {
  if (!profile || profile.source !== 'catalog') {
    return null;
  }

  return {
    checkoutHash: profile.checkoutHash,
    dev: profile.isDev === true,
  };
}

function listProfilesForActiveApp() {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  return listProfileSummaries(activeProfile.appRoot, {
    activeProfileId: activeProfile.id,
  });
}

function createProfileForActiveApp(input) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  return createProfile(activeProfile.appRoot, input, getProfileCatalogOptions());
}

function importProfileForActiveApp(profileId) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  return importProfile(activeProfile.appRoot, profileId, getProfileCatalogOptions());
}

function renameProfileForActiveApp(profileId, displayName) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  const result = renameProfile(activeProfile.appRoot, profileId, displayName);
  if (result?.metadata && profileId === activeProfile.id) {
    activeProfile = {
      ...activeProfile,
      displayName: result.metadata.displayName,
      metadata: result.metadata,
    };
  }
  return result;
}

// Resolve a registered profile by id into the descriptor the lock / focus
// helpers need (its userDataDir is its catalog dir), plus whether it is
// currently running (its lock is held). Returns null when there is no active
// catalog or the id isn't registered.
function getProfileFocusTargetForActiveApp(profileId) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  const id = sanitizeProfileId(profileId);
  const catalog = loadCatalog(activeProfile.appRoot);
  const record = catalog?.profiles?.find((profile) => profile.id === id);
  if (!record?.dir) {
    return null;
  }

  const target = {
    id: record.id,
    displayName: record.displayName,
    userDataDir: record.dir,
    isDev: activeProfile.isDev === true,
  };

  let isLocked;
  try {
    isLocked = isProfileLocked(target);
  } catch {
    isLocked = false;
  }

  return { ...target, isLocked };
}

// Pre-flight validation of a delete request (existence + confirmation + path
// safety) against the active catalog, WITHOUT touching the lock or removing
// anything. Returns null when there is no active catalog (mirrors
// deleteProfileForActiveApp), true when the request is valid, and throws on a
// bad request. Callers run this before closing a running profile so an invalid
// delete can never quit a live window only to fail afterwards.
function validateProfileDeletionForActiveApp(profileId, expectedDisplayName) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  if (profileId === activeProfile.id) {
    throw new Error('The active profile cannot be deleted');
  }

  validateProfileDeletion(activeProfile.appRoot, profileId, expectedDisplayName);
  return true;
}

async function deleteProfileForActiveApp(profileId, expectedDisplayName) {
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return null;
  }

  if (profileId === activeProfile.id) {
    throw new Error('The active profile cannot be deleted');
  }

  return deleteProfile(activeProfile.appRoot, profileId, expectedDisplayName, {
    ...getProfileCatalogOptions(),
    isProfileLocked: (record) =>
      isProfileLocked({
        id: record.id,
        displayName: record.displayName,
        userDataDir: record.dir,
        isDev: activeProfile.isDev,
      }),
  });
}

module.exports = {
  AUTOMATION_PROFILE_ID,
  LEGACY_DEV_DATA_DIRS,
  PROFILE_SWITCH_REJECTED,
  LEGACY_DEV_DATA_WARNING_FILE,
  applyProfile,
  createProfileForActiveApp,
  deleteProfileForActiveApp,
  findRepoRoot,
  getActiveProfile,
  getArgValue,
  getDefaultRepoRoot,
  getLegacyDevDataDirs,
  getProfileFocusTargetForActiveApp,
  getReservedProfilePorts,
  importProfileForActiveApp,
  initializeProfile,
  listProfilesForActiveApp,
  renameProfileForActiveApp,
  resolveFallbackProfileId,
  resolveLastOpenedProfileId,
  resolveProfile,
  updateActiveProfileNodeConfig,
  updateActiveProfileNodeConfigWhenIdle,
  validateProfileDeletionForActiveApp,
  warnAboutLegacyDevData,
};
