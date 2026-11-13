/**
 * The profile manager's and the node settings' catalog operations (freedom-core
 * design 0013, 5.1, "The catalog's other operations"; step PRF-4), for the
 * active profile's app: through freedom-cored's subcommands, each one short run
 * on main's arguments with an asynchronous spawn (profile-subcommands.js), so
 * main's own lock keeps refreshing while it runs. Where profileCatalogBackend
 * says `js` (a development build without freedom-cored), the JS reference
 * (profile-resolver.js's `*ForActiveApp`, profile-catalog.js) runs instead.
 *
 * - **Writes** (`create`, `rename`, `import`, `delete`, `update-nodes`) and the
 *   manager's list and the reserved ports go through the subcommands. The
 *   catalog keeps one writer per build: older builds and the subcommands
 *   exclude each other through its write lock's format.
 * - **"Open", for another profile:** its lock fresh, or, for a lock that
 *   reads stale, its profile gate held, asked with `profile status` (0013,
 *   "What 'open' means"). A new build's main holds its gate from before its
 *   lock to after it (profile-gate.js), so a live profile whose main has
 *   stalled still reads open.
 * - **Deletion** (`profile delete`) holds the target's every gate (its
 *   profile gate, the core's, freedom-ipfsd's and freedom-radicled's), and
 *   any one held refuses it before anything changes.
 * - **Reads that must answer at once** stay JS reads of the catalog file,
 *   which change nothing: the native Profiles menu, a profile's directory for
 *   the focus hand-off, and the delete's check before a running profile is
 *   asked to quit (the core has no `delete --check` yet).
 */

const log = require('./logger');
const resolver = require('./profile-resolver');
const { hasStaleProfileLock } = require('./profile-lock');
const subcommands = require('./profile-subcommands');

/** How long a node manager's write waits out a delete holding the catalog. */
const WHEN_IDLE_MS = 120_000;
const WHEN_IDLE_RETRY_MS = 250;

// What a delete refused for a held gate says, by gate, as the gates' own
// modules say it (core/core-gate.js, ipfs/ipfsd-gate.js, radicle/radicled-gate.js).
const LOCK_HELD_MESSAGES = {
  core: "The profile's identity data is in use by another process. Close the profile and try again.",
  ipfs: 'The IPFS data is in use by another process. Close it and try again.',
  radicle: 'The Radicle data is in use by another process. Close it and try again.',
};

function activeCatalogProfile() {
  const profile = resolver.getActiveProfile();
  return profile?.source === 'catalog' ? profile : null;
}

function usesCore() {
  return resolver.profileCatalogBackend(require('electron').app) === 'core';
}

function coredBinary() {
  return require('./core/cored-binary').getCoredBinaryPath();
}

function lockDir() {
  return require('./service-locks').getLockDir();
}

/** `--dev --checkout-hash <hex8>` for a development build's catalog. */
function buildArgs(profile) {
  if (!profile.isDev) return [];
  return profile.checkoutHash ? ['--dev', '--checkout-hash', profile.checkoutHash] : ['--dev'];
}

async function profileSubcommand(sub, args, options) {
  const { result } = await subcommands.run(coredBinary(), ['profile', sub, ...args], options);
  return result;
}

/** The manager's list: every registered profile and the unregistered
 * directories, as listProfileSummaries gives them; null without a catalog. */
async function listProfiles() {
  const profile = activeCatalogProfile();
  if (!profile) return null;
  if (!usesCore()) return resolver.listProfilesForActiveApp();
  const result = await profileSubcommand('list', ['--app-root', profile.appRoot, '--active', profile.id]);
  return Array.isArray(result) ? result : [];
}

/** `{ catalog, record, metadata }` for a new profile; null without a catalog. */
async function createProfile(input = {}) {
  const profile = activeCatalogProfile();
  if (!profile) return null;
  if (!usesCore()) return resolver.createProfileForActiveApp(input);
  const args = [
    '--app-root',
    profile.appRoot,
    ...buildArgs(profile),
    '--display-name',
    String(input.displayName ?? ''),
  ];
  if (input.id) args.push('--id', String(input.id));
  return profileSubcommand('create', args);
}

/** Registers an unregistered profile directory: `{ catalog, record,
 * metadata }`; null without a catalog. */
async function importProfile(profileId) {
  const profile = activeCatalogProfile();
  if (!profile) return null;
  if (!usesCore()) return resolver.importProfileForActiveApp(profileId);
  return profileSubcommand('import', [
    '--app-root',
    profile.appRoot,
    ...buildArgs(profile),
    '--id',
    String(profileId ?? ''),
  ]);
}

/** `{ catalog, record, metadata }`; the active profile's own rename updates
 * its display name here too. Null without a catalog. */
async function renameProfile(profileId, displayName) {
  const profile = activeCatalogProfile();
  if (!profile) return null;
  if (!usesCore()) return resolver.renameProfileForActiveApp(profileId, displayName);
  const result = await profileSubcommand('rename', [
    '--app-root',
    profile.appRoot,
    '--id',
    String(profileId ?? ''),
    '--display-name',
    String(displayName ?? ''),
  ]);
  if (result?.metadata && result.record?.id === resolver.getActiveProfile()?.id) {
    resolver.updateActiveProfileMetadata(result.metadata);
  }
  return result;
}

/** The active profile's node settings for `protocol`, merged as
 * updateProfileNodeConfig merges them: `{ catalog, record, metadata }`, the
 * active profile's metadata updated; null without a catalog. */
async function updateNodeConfig(protocol, updates) {
  const profile = activeCatalogProfile();
  if (!profile) return null;
  if (!usesCore()) return resolver.updateActiveProfileNodeConfig(protocol, updates);
  const result = await profileSubcommand('update-nodes', [
    '--app-root',
    profile.appRoot,
    '--id',
    profile.id,
    '--user-data-dir',
    profile.userDataDir,
    '--protocol',
    String(protocol),
    '--updates',
    JSON.stringify(updates ?? {}),
    '--metadata',
    JSON.stringify(profile.metadata ?? {}),
  ]);
  if (result?.metadata) resolver.updateActiveProfileMetadata(result.metadata);
  return result;
}

/**
 * updateNodeConfig for a node manager persisting a fallback port during its
 * start: a delete holds the catalog's write lock for the whole removal, so a
 * busy catalog is waited out (2 min at most) instead of leaving the node in
 * ERROR, as the reference waits out its in-process delete.
 */
async function updateNodeConfigWhenIdle(
  protocol,
  updates,
  { timeoutMs = WHEN_IDLE_MS, retryMs = WHEN_IDLE_RETRY_MS } = {}
) {
  if (!activeCatalogProfile()) return null;
  if (!usesCore()) return resolver.updateActiveProfileNodeConfigWhenIdle(protocol, updates);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await updateNodeConfig(protocol, updates);
    } catch (error) {
      if (error?.code !== 'busy' || Date.now() + retryMs > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

/** The managed ports the app's other profiles keep, as a Set. */
async function getReservedPorts() {
  const profile = activeCatalogProfile();
  if (!profile) return new Set();
  if (!usesCore()) return resolver.getReservedProfilePorts(profile);
  const result = await profileSubcommand('reserved-ports', [
    '--app-root',
    profile.appRoot,
    ...buildArgs(profile),
    '--exclude',
    profile.id,
  ]);
  return new Set(Array.isArray(result) ? result.filter(Number.isInteger) : []);
}

/**
 * `profile status` for `target` (`{ userDataDir, isDev }`): `{ open,
 * lock_fresh, gate_held }`. Null without the core's subcommands.
 */
async function profileStatus(target) {
  if (!usesCore()) return null;
  const args = ['--lock-dir', lockDir()];
  if (target.isDev) args.push('--dev');
  args.push('--user-data-dir', target.userDataDir);
  const result = await profileSubcommand('status', args);
  return Array.isArray(result) ? result[0] || null : null;
}

/**
 * Whether a profile whose lock reads free is open all the same: its lock
 * stale and its profile gate held. A lock that's gone holds nothing to ask
 * about, and a status that fails reads as open: nothing is taken over on a
 * guess.
 */
async function isOpenBehindStaleLock(target) {
  if (!usesCore() || !hasStaleProfileLock(target)) return false;
  try {
    return (await profileStatus(target))?.gate_held === true;
  } catch (error) {
    log.warn('[profile] Could not ask a profile gate; it reads as open', { code: error.code });
    return true;
  }
}

/**
 * The focus hand-off's target for a registered profile (its directory, read
 * from the catalog), with `isLocked`: its lock fresh, or stale with its gate
 * held. Null without a catalog or for an id that isn't registered.
 */
async function getProfileFocusTarget(profileId) {
  const target = resolver.getProfileFocusTargetForActiveApp(profileId);
  if (!target || target.isLocked) return target;
  return { ...target, isLocked: await isOpenBehindStaleLock(target) };
}

/**
 * Waits, until `deadline`, for `target`'s profile gate to be free: a profile
 * that has quit lets its gate go a moment after its lock. True once it is
 * (or without the core, which keeps no gate).
 */
async function waitForProfileGateFree(target, { deadline, intervalMs = 200 } = {}) {
  if (!usesCore()) return true;
  for (;;) {
    try {
      const status = await profileStatus(target);
      if (status && status.gate_held !== true) return true;
    } catch (error) {
      log.warn('[profile] Could not ask a profile gate', { code: error.code });
    }
    if (Date.now() + intervalMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Deletes a registered profile under every gate it has: `{ catalog, record,
 * forget, forget_unknown? }` from the core (`forget`, the key-store items it
 * recorded for main to forget), the reference's result without it. Null
 * without a catalog. `gates` are the JS reference's (withCoreGate, …), for
 * a development build without the core.
 */
async function deleteProfile(profileId, expectedDisplayName, gates = {}) {
  const profile = activeCatalogProfile();
  if (!profile) return null;
  if (profileId === profile.id) {
    throw new Error('The active profile cannot be deleted');
  }
  if (!usesCore()) {
    return resolver.deleteProfileForActiveApp(profileId, expectedDisplayName, gates);
  }
  let result;
  try {
    result = await profileSubcommand(
      'delete',
      [
        '--app-root',
        profile.appRoot,
        '--lock-dir',
        lockDir(),
        '--id',
        String(profileId ?? ''),
        '--confirm-display-name',
        String(expectedDisplayName ?? ''),
        ...buildArgs(profile),
      ],
      // A delete removes the profile's data: no bound of its own.
      { timeoutMs: 0 }
    );
  } catch (error) {
    if (error?.code === 'lock_held') {
      const message =
        LOCK_HELD_MESSAGES[error.gate] ||
        `Profile is currently open: ${expectedDisplayName || profileId}`;
      throw Object.assign(new Error(message), { code: 'lock_held', gate: error.gate });
    }
    throw error;
  }
  const forget = Array.isArray(result?.forget) ? result.forget : [];
  if (forget.length || result?.forget_unknown) {
    // Forgetting them is main's key-store executor's (PRF-2): logged until then.
    log.warn('[profile] The deleted profile named key-store items to forget', {
      items: forget.length,
      unknown: result?.forget_unknown === true,
    });
  }
  return result;
}

module.exports = {
  WHEN_IDLE_MS,
  createProfile,
  deleteProfile,
  getProfileFocusTarget,
  getReservedPorts,
  importProfile,
  isOpenBehindStaleLock,
  listProfiles,
  profileStatus,
  renameProfile,
  updateNodeConfig,
  updateNodeConfigWhenIdle,
  waitForProfileGateFree,
};
