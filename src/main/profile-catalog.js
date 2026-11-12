const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const fsOffload = require('./fs-offload');
const { UPDATER_LOCK_DIR, UPDATER_LOCK_TARGET } = require('./updater-owner-lock');

const PROFILE_REGISTRY_FILE = 'profile-registry.json';
const PROFILE_META_FILE = 'profile.json';
const RADICLE_SHORT_HOME_DIR = 'R';
const PROFILE_CATALOG_LOCK_TARGET = 'profile-registry.write-lock-target';
const PROFILE_CATALOG_LOCK_DIR = 'profile-registry.write.lock';
const PROFILES_DIR = 'Profiles';
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_CATALOG_LOCK_STALE_MS = 30000;
const DEFAULT_CATALOG_LOCK_UPDATE_MS = 10000;
const DEFAULT_CATALOG_LOCK_RETRIES = {
  retries: 5,
  minTimeout: 50,
  maxTimeout: 250,
};

const PACKAGED_PORT_BASE = {
  beeApi: 11633,
  beeP2p: 12633,
  torSocks: 19150,
};

const DEV_PORT_BASE = {
  beeApi: 21633,
  beeP2p: 22633,
  torSocks: 29150,
};

function sanitizeProfileId(value) {
  const input = String(value || '').trim().toLowerCase();
  if (!input) {
    throw new Error('Profile id is required');
  }

  if (input === '.' || input === '..' || input.includes('/') || input.includes('\\')) {
    throw new Error(`Invalid profile id: ${value}`);
  }

  const id = input.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id || id === '.' || id === '..') {
    throw new Error(`Invalid profile id: ${value}`);
  }

  return id;
}

function displayNameFromId(profileId) {
  if (profileId === DEFAULT_PROFILE_ID) return 'My Profile';
  return profileId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || profileId;
}

function hashPath(targetPath) {
  return crypto.createHash('sha256').update(targetPath).digest('hex').slice(0, 8);
}

function getCheckoutId(repoRoot) {
  return `freedom-browser-${hashPath(repoRoot)}`;
}

function getDevPortOffset(checkoutHash) {
  return (parseInt(checkoutHash, 16) % 100) * 10;
}

function getManagedPorts(slot, options = {}) {
  const dev = options.dev === true;
  const base = dev ? DEV_PORT_BASE : PACKAGED_PORT_BASE;
  const offset = dev ? getDevPortOffset(options.checkoutHash || '00000000') : 0;

  return {
    beeApi: base.beeApi + offset + slot,
    beeP2p: base.beeP2p + offset + slot,
    torSocks: base.torSocks + offset + slot,
  };
}

function buildNodeConfig(ports) {
  return {
    bee: {
      mode: 'managed',
      apiPort: ports.beeApi,
      p2pPort: ports.beeP2p,
      externalApi: null,
    },
    ipfs: {
      mode: 'managed',
      backend: 'freedom-ipfs',
    },
    myotis: {
      mode: 'managed',
      backend: 'myotis-native',
    },
    radicle: {
      mode: 'managed',
    },
    tor: {
      mode: 'managed',
      socksPort: ports.torSocks,
      externalSocks: null,
    },
  };
}

// IPFS is a native node that may also be pointed at an external gateway. Keep a
// persisted `external` (and `disabled`) choice across profile rebases/fills
function normalizeIpfsMode(mode, fallback = 'managed') {
  if (mode === 'disabled') return 'disabled';
  if (mode === 'external') return 'external';
  return fallback;
}

// "Verify content from this node" (freedom-core design 0009), kept with an
// external node's endpoint. Absent means on; a stored choice survives a
// rebase as it was.
function keptVerifySetting(config) {
  return typeof config?.verify === 'boolean' ? { verify: config.verify } : {};
}

function rebaseNodeConfig(nodes = {}, ports) {
  const defaults = buildNodeConfig(ports);
  return {
    bee: {
      ...defaults.bee,
      mode: nodes.bee?.mode || defaults.bee.mode,
      externalApi: nodes.bee?.externalApi || null,
      ...keptVerifySetting(nodes.bee),
    },
    ipfs: {
      ...defaults.ipfs,
      mode: normalizeIpfsMode(nodes.ipfs?.mode, defaults.ipfs.mode),
      externalGateway: nodes.ipfs?.externalGateway || null,
      ...keptVerifySetting(nodes.ipfs),
      backend: 'freedom-ipfs',
    },
    myotis: {
      ...defaults.myotis,
      mode: nodes.myotis?.mode === 'disabled' ? 'disabled' : defaults.myotis.mode,
      backend: 'myotis-native',
    },
    radicle: {
      mode: nodes.radicle?.mode === 'disabled' ? 'disabled' : defaults.radicle.mode,
    },
    tor: {
      ...defaults.tor,
      mode: nodes.tor?.mode || defaults.tor.mode,
      externalSocks: nodes.tor?.externalSocks || null,
    },
  };
}

function fillMissingNodeConfig(nodes = {}, ports) {
  const defaults = buildNodeConfig(ports);
  return {
    bee: {
      ...defaults.bee,
      ...(nodes.bee || {}),
      mode: nodes.bee?.mode || defaults.bee.mode,
      apiPort: Number.isInteger(nodes.bee?.apiPort)
        ? nodes.bee.apiPort
        : defaults.bee.apiPort,
      p2pPort: Number.isInteger(nodes.bee?.p2pPort)
        ? nodes.bee.p2pPort
        : defaults.bee.p2pPort,
      externalApi: nodes.bee?.externalApi || null,
    },
    ipfs: {
      ...defaults.ipfs,
      ...(nodes.ipfs || {}),
      mode: normalizeIpfsMode(nodes.ipfs?.mode, defaults.ipfs.mode),
      externalGateway: nodes.ipfs?.externalGateway || null,
      backend: 'freedom-ipfs',
    },
    myotis: {
      ...defaults.myotis,
      mode: nodes.myotis?.mode === 'disabled' ? 'disabled' : defaults.myotis.mode,
      backend: 'myotis-native',
    },
    radicle: {
      mode: nodes.radicle?.mode === 'disabled' ? 'disabled' : defaults.radicle.mode,
    },
    tor: {
      ...defaults.tor,
      ...(nodes.tor || {}),
      mode: nodes.tor?.mode || defaults.tor.mode,
      socksPort: Number.isInteger(nodes.tor?.socksPort)
        ? nodes.tor.socksPort
        : defaults.tor.socksPort,
      externalSocks: nodes.tor?.externalSocks || null,
    },
  };
}

function getRecordManagedPorts(record, options = {}) {
  const slot = Number.isInteger(record?.slot) ? record.slot : 0;
  return getManagedPorts(slot, {
    dev: options.dev,
    checkoutHash: options.checkoutHash,
  });
}

function addIntegerPort(target, port) {
  if (Number.isInteger(port) && port > 0) {
    target.add(port);
  }
}

function getReservedManagedPorts(appRoot, options = {}) {
  const catalog = loadCatalog(appRoot);
  const reservedPorts = new Set();

  for (const record of catalog.profiles) {
    if (options.excludeProfileId && record.id === options.excludeProfileId) {
      continue;
    }

    const metadata = readProfileMetadata(record.dir) || {};
    const nodes = fillMissingNodeConfig(
      {
        ...(record.nodes || {}),
        ...(metadata.nodes || {}),
      },
      getRecordManagedPorts(record, options)
    );

    addIntegerPort(reservedPorts, nodes.bee?.apiPort);
    addIntegerPort(reservedPorts, nodes.bee?.p2pPort);
    addIntegerPort(reservedPorts, nodes.tor?.socksPort);
  }

  return reservedPorts;
}

function normalizeRecordNodeConfig(record, options = {}) {
  const nodes = fillMissingNodeConfig(record.nodes || {}, getRecordManagedPorts(record, options));
  const changed = JSON.stringify(nodes) !== JSON.stringify(record.nodes || {});
  if (changed) {
    record.nodes = nodes;
  }
  return changed;
}

function getCatalogPath(appRoot) {
  return path.join(appRoot, PROFILE_REGISTRY_FILE);
}

function getProfileMetaPath(profileDir) {
  return path.join(profileDir, PROFILE_META_FILE);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function getCatalogLockPaths(appRoot) {
  return {
    targetPath: path.join(appRoot, PROFILE_CATALOG_LOCK_TARGET),
    lockDir: path.join(appRoot, PROFILE_CATALOG_LOCK_DIR),
  };
}

function ensureCatalogLockTarget(appRoot) {
  ensureDir(appRoot);
  const paths = getCatalogLockPaths(appRoot);
  if (!fs.existsSync(paths.targetPath)) {
    fs.writeFileSync(
      paths.targetPath,
      [
        'Freedom profile catalog write lock target',
        `createdAt=${new Date().toISOString()}`,
      ].join('\n')
    );
  }
  return paths;
}

function normalizeCatalogLockRetries(retries) {
  if (retries === false || retries === null || retries === 0) {
    return { retries: 0, minTimeout: 0, maxTimeout: 0 };
  }

  if (Number.isInteger(retries)) {
    return {
      ...DEFAULT_CATALOG_LOCK_RETRIES,
      retries: Math.max(0, retries),
    };
  }

  const config = retries && typeof retries === 'object'
    ? retries
    : DEFAULT_CATALOG_LOCK_RETRIES;

  return {
    retries: Number.isInteger(config.retries)
      ? Math.max(0, config.retries)
      : DEFAULT_CATALOG_LOCK_RETRIES.retries,
    minTimeout: Number.isFinite(config.minTimeout)
      ? Math.max(0, config.minTimeout)
      : DEFAULT_CATALOG_LOCK_RETRIES.minTimeout,
    maxTimeout: Number.isFinite(config.maxTimeout)
      ? Math.max(0, config.maxTimeout)
      : DEFAULT_CATALOG_LOCK_RETRIES.maxTimeout,
  };
}

function sleepSync(ms) {
  if (!ms) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function getCatalogLockRetryDelay(retryOptions, retryIndex) {
  const minTimeout = retryOptions.minTimeout;
  const maxTimeout = Math.max(minTimeout, retryOptions.maxTimeout);
  return Math.min(maxTimeout, minTimeout * (retryIndex + 1));
}

function acquireCatalogWriteLock(paths, options = {}) {
  const retryOptions = normalizeCatalogLockRetries(options.retries);

  for (let attempt = 0; attempt <= retryOptions.retries; attempt += 1) {
    try {
      return lockfile.lockSync(paths.targetPath, {
        lockfilePath: paths.lockDir,
        realpath: false,
        stale: options.staleMs ?? DEFAULT_CATALOG_LOCK_STALE_MS,
        update: options.updateMs ?? DEFAULT_CATALOG_LOCK_UPDATE_MS,
      });
    } catch (error) {
      if (error?.code !== 'ELOCKED' || attempt >= retryOptions.retries) {
        throw error;
      }
      sleepSync(getCatalogLockRetryDelay(retryOptions, attempt));
    }
  }

  throw new Error('Failed to acquire profile catalog lock');
}

// Lock dirs currently held by an in-process withCatalogWriteLockAsync holder,
// and the tail of each dir's in-process async queue. The catalog lock itself is
// cross-process (proper-lockfile's mkdir lock); these only coordinate callers
// inside *this* process, which would otherwise contend with each other through
// the same on-disk lock.
const asyncCatalogLockHolders = new Set();
const asyncCatalogLockQueues = new Map();

function createCatalogLockBusyError() {
  return Object.assign(
    new Error(
      'The profile catalog is busy with another update (such as a profile deletion). Try again in a moment.'
    ),
    { code: 'ELOCKED' }
  );
}

function withCatalogWriteLock(appRoot, fn, options = {}) {
  const paths = ensureCatalogLockTarget(appRoot);
  // An async holder in this process (a profile deletion awaiting a multi-GB
  // rm) can only make progress while the event loop runs. Retrying here would
  // Atomics.wait the main thread, starving the very holder we are waiting on
  // until the retries run out, so fail fast instead.
  if (asyncCatalogLockHolders.has(paths.lockDir)) {
    throw createCatalogLockBusyError();
  }
  const release = acquireCatalogWriteLock(paths, options);

  try {
    return fn();
  } finally {
    release();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireCatalogWriteLockAsync(paths, options = {}) {
  const retryOptions = normalizeCatalogLockRetries(options.retries);

  for (let attempt = 0; attempt <= retryOptions.retries; attempt += 1) {
    try {
      return await lockfile.lock(paths.targetPath, {
        lockfilePath: paths.lockDir,
        realpath: false,
        stale: options.staleMs ?? DEFAULT_CATALOG_LOCK_STALE_MS,
        update: options.updateMs ?? DEFAULT_CATALOG_LOCK_UPDATE_MS,
      });
    } catch (error) {
      if (error?.code !== 'ELOCKED' || attempt >= retryOptions.retries) {
        throw error;
      }
      const ms = getCatalogLockRetryDelay(retryOptions, attempt);
      if (ms) await delay(ms);
    }
  }

  throw new Error('Failed to acquire profile catalog lock');
}

// Async twin of withCatalogWriteLock for critical sections that do slow I/O
// (recursive deletes of node data) under the lock. Same cross-process lock,
// same retry budget, but every wait yields the event loop instead of blocking
// it. Holding the lock across awaits also lets proper-lockfile's mtime-refresh
// timer run, so a long section no longer looks stale (and stealable) to other
// processes after DEFAULT_CATALOG_LOCK_STALE_MS the way a long synchronous one
// did. In-process async callers queue behind each other; in-process sync
// callers fail fast while an async holder is active (see withCatalogWriteLock).
async function withCatalogWriteLockAsync(appRoot, fn, options = {}) {
  const paths = ensureCatalogLockTarget(appRoot);
  const previous = asyncCatalogLockQueues.get(paths.lockDir) || Promise.resolve();
  let releaseQueue;
  const current = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => current);
  asyncCatalogLockQueues.set(paths.lockDir, tail);

  try {
    await previous;
    const release = await acquireCatalogWriteLockAsync(paths, options);
    asyncCatalogLockHolders.add(paths.lockDir);
    try {
      return await fn();
    } finally {
      asyncCatalogLockHolders.delete(paths.lockDir);
      await release();
    }
  } finally {
    releaseQueue();
    if (asyncCatalogLockQueues.get(paths.lockDir) === tail) {
      asyncCatalogLockQueues.delete(paths.lockDir);
    }
  }
}

// Resolve once no in-process withCatalogWriteLockAsync holder (or queued async
// caller) is left for this catalog. A sync withCatalogWriteLock call made right
// after this resolves — in the same tick, with no await in between — cannot hit
// the in-process fast-fail above. Used by short sync writers that would rather
// wait out a long async section (a profile deletion) than fail, e.g. Ant/Tor
// persisting a fallback port mid-start.
async function waitForCatalogWriteLockIdle(appRoot) {
  const { lockDir } = getCatalogLockPaths(appRoot);
  while (asyncCatalogLockHolders.has(lockDir) || asyncCatalogLockQueues.has(lockDir)) {
    await asyncCatalogLockQueues.get(lockDir);
  }
}

function loadCatalog(appRoot) {
  const catalogPath = getCatalogPath(appRoot);
  if (!fs.existsSync(catalogPath)) {
    return { version: 1, profiles: [] };
  }

  const parsed = readJson(catalogPath);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
    throw new Error(`Unsupported profile catalog: ${catalogPath}`);
  }

  return parsed;
}

function saveCatalog(appRoot, catalog) {
  writeJsonAtomic(getCatalogPath(appRoot), catalog);
}

function findProfile(catalog, profileId) {
  return catalog.profiles.find((profile) => profile.id === profileId) || null;
}

function getProfileDir(appRoot, profileId, options = {}) {
  if (profileId === DEFAULT_PROFILE_ID && options.defaultProfileDir) {
    return options.defaultProfileDir;
  }
  return path.join(appRoot, PROFILES_DIR, profileId);
}

function getProfileRadicleDataDir(appRoot, record, options = {}) {
  if (!Number.isInteger(record?.slot)) {
    return null;
  }

  const slot = String(record.slot);
  if (options.dev) {
    return path.join(
      path.dirname(appRoot),
      RADICLE_SHORT_HOME_DIR,
      options.checkoutHash || 'dev',
      slot
    );
  }

  return path.join(appRoot, RADICLE_SHORT_HOME_DIR, slot);
}

function assertPathInside(parentDir, targetDir, description) {
  const resolvedParent = path.resolve(parentDir);
  const resolvedTarget = path.resolve(targetDir);
  if (
    resolvedTarget === resolvedParent
    || !resolvedTarget.startsWith(`${resolvedParent}${path.sep}`)
  ) {
    throw new Error(`Refusing to delete ${description} outside its root`);
  }
  return resolvedTarget;
}

function getUsedSlots(catalog) {
  return new Set(
    catalog.profiles
      .map((profile) => profile.slot)
      .filter((slot) => Number.isInteger(slot) && slot >= 0)
  );
}

function allocateSlot(catalog, profileId) {
  if (profileId === DEFAULT_PROFILE_ID) return 0;

  const used = getUsedSlots(catalog);
  let slot = 1;
  while (used.has(slot)) {
    slot += 1;
  }
  return slot;
}

function getProfilesRoot(appRoot) {
  return path.join(appRoot, PROFILES_DIR);
}

function listProfileDirs(appRoot) {
  const profilesRoot = getProfilesRoot(appRoot);
  if (!fs.existsSync(profilesRoot)) return [];

  return fs.readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dirName: entry.name,
      dir: path.join(profilesRoot, entry.name),
    }));
}

/**
 * Every profile the app root holds, as `{ dir, slot }`: the catalog's
 * records, and the profile directories it doesn't list, whose slot comes
 * from their metadata, or is null. The grant check's other profiles
 * (freedom-core design 0010, `service-grant.js`).
 */
function listProfileDataDirs(appRoot) {
  const profiles = new Map();
  for (const record of loadCatalog(appRoot).profiles) {
    profiles.set(path.resolve(record.dir), Number.isInteger(record.slot) ? record.slot : null);
  }
  for (const { dir } of listProfileDirs(appRoot)) {
    const resolved = path.resolve(dir);
    if (profiles.has(resolved)) continue;
    let slot = null;
    try {
      const metadata = readProfileMetadata(resolved);
      if (Number.isInteger(metadata?.slot)) slot = metadata.slot;
    } catch {
      // Unreadable metadata: its directory is protected all the same.
    }
    profiles.set(resolved, slot);
  }
  return [...profiles].map(([dir, slot]) => ({ dir, slot }));
}

function isPathInside(parentDir, childPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getCatalogDirSet(catalog) {
  return new Set(catalog.profiles.map((profile) => path.resolve(profile.dir)));
}

function listUnregisteredProfileSummaries(appRoot, catalog, options = {}) {
  const registeredDirs = getCatalogDirSet(catalog);
  const registeredIds = new Set(catalog.profiles.map((profile) => profile.id));

  return listProfileDirs(appRoot)
    .filter(({ dir }) => !registeredDirs.has(path.resolve(dir)))
    .map(({ dirName, dir }) => {
      let id;
      try {
        id = sanitizeProfileId(dirName);
      } catch {
        return null;
      }
      if (id !== dirName) {
        return null;
      }
      if (registeredIds.has(id)) {
        return null;
      }

      const metadata = readProfileMetadata(dir) || {};
      return {
        id,
        displayName: metadata.displayName || displayNameFromId(id),
        slot: Number.isInteger(metadata.slot) ? metadata.slot : null,
        createdAt: metadata.createdAt || null,
        lastOpenedAt: metadata.lastOpenedAt || null,
        nodes: metadata.nodes || null,
        isActive: options.activeProfileId === id,
        isUnregistered: true,
      };
    })
    .filter(Boolean);
}

function createProfileRecord(appRoot, profileId, options = {}) {
  const now = options.now || new Date().toISOString();
  const slot = options.slot ?? allocateSlot(options.catalog, profileId);
  const ports = getManagedPorts(slot, {
    dev: options.dev,
    checkoutHash: options.checkoutHash,
  });
  const displayName = options.displayName || displayNameFromId(profileId);
  const dir = getProfileDir(appRoot, profileId, options);

  return {
    id: profileId,
    displayName,
    dir,
    slot,
    createdAt: now,
    lastOpenedAt: now,
    nodes: buildNodeConfig(ports),
  };
}

function createProfileMetadata(record) {
  return {
    version: 1,
    id: record.id,
    displayName: record.displayName,
    createdAt: record.createdAt,
    lastOpenedAt: record.lastOpenedAt,
    slot: record.slot,
    nodes: record.nodes,
  };
}

function createRecordFromExistingProfile(appRoot, profileId, dir, catalog, options = {}) {
  const existingMetadata = readProfileMetadata(dir) || {};
  const usedSlots = getUsedSlots(catalog);
  const metadataSlot = Number.isInteger(existingMetadata.slot) ? existingMetadata.slot : null;
  const slot = metadataSlot !== null && !usedSlots.has(metadataSlot)
    ? metadataSlot
    : allocateSlot(catalog, profileId);
  const ports = getManagedPorts(slot, {
    dev: options.dev,
    checkoutHash: options.checkoutHash,
  });
  const now = options.now || new Date().toISOString();
  const displayName = existingMetadata.displayName || displayNameFromId(profileId);

  return {
    id: profileId,
    displayName,
    dir,
    slot,
    createdAt: existingMetadata.createdAt || now,
    lastOpenedAt: existingMetadata.lastOpenedAt || now,
    nodes: rebaseNodeConfig(existingMetadata.nodes || {}, ports),
  };
}

function writeProfileMetadata(profileDir, metadata) {
  ensureDir(profileDir);
  writeJsonAtomic(getProfileMetaPath(profileDir), metadata);
}

function readProfileMetadata(profileDir) {
  const metaPath = getProfileMetaPath(profileDir);
  if (!fs.existsSync(metaPath)) return null;
  return readJson(metaPath);
}

function createProfile(appRoot, profileInput = {}, options = {}) {
  const displayName = String(profileInput.displayName || '').trim();
  const profileId = sanitizeProfileId(profileInput.id || displayName);
  if (!displayName) {
    throw new Error('Profile display name is required');
  }

  return withCatalogWriteLock(appRoot, () => {
    const catalog = loadCatalog(appRoot);
    if (findProfile(catalog, profileId)) {
      throw new Error(`Profile already exists: ${profileId}`);
    }

    const record = createProfileRecord(appRoot, profileId, {
      ...options,
      catalog,
      displayName,
    });
    catalog.profiles.push(record);
    saveCatalog(appRoot, catalog);

    const metadata = createProfileMetadata(record);
    writeProfileMetadata(record.dir, metadata);

    return {
      catalog,
      record,
      metadata,
    };
  });
}

function renameProfile(appRoot, profileId, displayName) {
  const id = sanitizeProfileId(profileId);
  const nextDisplayName = String(displayName || '').trim();
  if (!nextDisplayName) {
    throw new Error('Profile display name is required');
  }

  return withCatalogWriteLock(appRoot, () => {
    const catalog = loadCatalog(appRoot);
    const record = findProfile(catalog, id);
    if (!record) {
      throw new Error(`Profile not found: ${id}`);
    }

    record.displayName = nextDisplayName;
    saveCatalog(appRoot, catalog);

    const existingMetadata = readProfileMetadata(record.dir) || createProfileMetadata(record);
    const metadata = {
      ...existingMetadata,
      id: record.id,
      displayName: nextDisplayName,
    };
    writeProfileMetadata(record.dir, metadata);

    return {
      catalog,
      record,
      metadata,
    };
  });
}

// Validate that a delete request is well-formed against the given catalog: the
// profile exists, the supplied display name matches, and its dir is safely
// inside the app data root. Returns the resolved record details for the caller
// to act on. Throws (never returns falsy) on any mismatch. This deliberately
// excludes the lock check and any mutation, so it can run as a pre-flight —
// before a running profile is asked to quit — without side effects.
function assertProfileDeletable(appRoot, catalog, id) {
  const recordIndex = catalog.profiles.findIndex((profile) => profile.id === id);
  if (recordIndex === -1) {
    throw new Error(`Profile not found: ${id}`);
  }

  // The invariant is "never leave the app with zero profiles", not "never
  // delete the profile whose id is `default`" (#124). A caller that also
  // refuses the active profile can never reach this with a single profile, but
  // the catalog enforces it itself so no caller can bypass it.
  if (catalog.profiles.length <= 1) {
    throw new Error('The last remaining profile cannot be deleted');
  }

  const record = catalog.profiles[recordIndex];
  const displayName = record.displayName || displayNameFromId(record.id);

  const resolvedAppRoot = path.resolve(appRoot);
  const resolvedProfileDir = path.resolve(record.dir);
  // Packaged builds keep the default profile in the app data root itself (it
  // adopted the pre-profiles userData in place — see resolveProfile's
  // defaultProfileDir), so that one record legitimately equals the root. It is
  // deleted entry-by-entry instead (removeDefaultProfileDataFromAppRoot); every
  // other record must live strictly inside the root.
  const sharesAppRoot =
    resolvedProfileDir === resolvedAppRoot && record.id === DEFAULT_PROFILE_ID;
  if (
    !sharesAppRoot &&
    (resolvedProfileDir === resolvedAppRoot ||
      !resolvedProfileDir.startsWith(`${resolvedAppRoot}${path.sep}`))
  ) {
    throw new Error('Refusing to delete a profile outside the app data root');
  }

  return { recordIndex, record, displayName, resolvedProfileDir, sharesAppRoot };
}

// The per-user lock directory's name (service-locks.js): `<appData>/Freedom/
// locks`, which on macOS and Windows is inside the packaged app data root.
// Not imported: that module pulls in electron.
const SHARED_LOCK_DIR = 'locks';

// Top-level entries of the app data root that belong to the app as a whole
// rather than to the default profile stored alongside them in a packaged build:
// the catalog and its write lock, every other profile's directory, the short
// Radicle homes, the cross-profile updater ownership lock, electron-log's
// default `logs/` dir (its default path does not follow userData, so every
// profile writes there — see logger.js), and on macOS and Windows the lock
// directory every Freedom build and profile shares, which holds every core's
// and service's gate (freedom-core design 0001: it is never deleted).
// Removing any of these while another profile runs would break it; the
// updater lock and the gates in particular are live.
const APP_ROOT_SHARED_ENTRIES = new Set([
  PROFILE_REGISTRY_FILE,
  PROFILE_CATALOG_LOCK_TARGET,
  PROFILE_CATALOG_LOCK_DIR,
  PROFILES_DIR,
  RADICLE_SHORT_HOME_DIR,
  UPDATER_LOCK_TARGET,
  UPDATER_LOCK_DIR,
  'logs',
  SHARED_LOCK_DIR,
]);

function isAppRootSharedEntry(name) {
  // writeJsonAtomic's in-flight `profile-registry.json.<pid>.tmp`.
  return APP_ROOT_SHARED_ENTRIES.has(name) || name.startsWith(`${PROFILE_REGISTRY_FILE}.`);
}

// Delete a packaged default profile whose data lives directly in the app data
// root: remove every top-level entry except the app-wide ones above. The root
// itself (and so every other profile) survives. `place` (gatedPlace) is the
// gated directories', which the removal spares.
async function removeDefaultProfileDataFromAppRoot(appRoot, { place = null } = {}) {
  const resolvedAppRoot = path.resolve(appRoot);
  if (place) {
    await removeSparing(resolvedAppRoot, place, 0, { skip: isAppRootSharedEntry, keepRoot: true });
    return;
  }
  for (const name of await fs.promises.readdir(resolvedAppRoot)) {
    if (isAppRootSharedEntry(name)) continue;
    const target = assertPathInside(resolvedAppRoot, path.join(resolvedAppRoot, name), 'profile data');
    await fsOffload.removePath(target, { recursive: true, force: true });
  }
}

// A directory's filesystem identity: the same directory under any name.
function identityOf(stat) {
  return `${stat.dev}:${stat.ino}`;
}

// Whether a directory entry has a name the removal must treat as `name`:
// compared without case or Unicode form, so another spelling on a
// case-insensitive filesystem is treated the same. Matching too much only
// spares a directory.
function sameEntryName(entry, name) {
  return entry.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase();
}

// A gated delete's refusal of a gated directory's layout it can't vouch for
// (`what`: "identity data", "IPFS data"), thrown before anything has
// changed.
function layoutRefused(what, detail) {
  return new Error(
    `The profile's ${what} ${detail}, so it can't be deleted safely while its lock is held. ` +
      'Nothing was deleted: replace the link with the directory itself, or remove it, and ' +
      'delete the profile again.'
  );
}

// A gated delete's refusal of Radicle data it would remove through a link,
// thrown before anything has changed.
function radicleLayoutRefused(link) {
  return new Error(
    `The profile's Radicle data is reached through a link (${link}), so the profile can't be ` +
      'deleted safely while its locks are held. Nothing was deleted: replace the link with ' +
      'the directory itself, or remove it, and delete the profile again.'
  );
}

// Every step below `base` down to `target`, as far as it exists, a real
// directory: a link at any step would carry a removal of `target` through
// it, out of the app's tree or into the gated directory.
async function refuseLinksBelow(base, target) {
  let current = base;
  for (const name of path.relative(base, target).split(path.sep)) {
    current = path.join(current, name);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (!stat.isDirectory()) throw radicleLayoutRefused(current);
  }
}

// The identities of `target` and of every directory above it: what it is
// inside, whatever each is called. Missing ones are skipped.
async function identitiesUp(target) {
  const ids = new Set();
  let current = target;
  for (;;) {
    try {
      ids.add(identityOf(await fs.promises.stat(current, { bigint: true })));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) return ids;
    current = parent;
  }
}

// What is at `target`, without following a link there (lstat), or null if
// nothing is.
async function lstatIfThere(target) {
  try {
    return await fs.promises.lstat(target, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Where the gated directories are, for a delete that holds their gates, or a
 * refusal. `gatedDirs` lists them, each `{ dir, what, gate }`, in the order
 * the fence moves them: the core's identity directory (freedom-core design
 * 0001, "Lifetime lock"), then freedom-ipfsd's IPFS directory (design 0007,
 * "Lifetime lock"). Each gate covers its directory's canonical path, and a
 * later owner's data can only be shown safe from a removal that finds that
 * directory where the profile names it. So the layout must be the app's own:
 * - the data root and each step down to a gated directory (`identity`;
 *   `ipfs-data` and `freedom-ipfs`) a real directory, or not there yet: no
 *   link or junction at any step;
 * - each canonical path the one named, not another spelling of it;
 * - nothing else this delete removes (`otherRoots`: the Radicle home and its
 *   staging siblings) inside a gated directory or around it, by identity;
 *   and the Radicle home's path (`radicle`: its app-owned base and the home)
 *   free of links at every step, as the gated paths are, so its removal
 *   can't be carried through one.
 * Anything else is refused before anything changes. Null when the data root
 * isn't there: nothing to remove, and nothing to spare.
 *
 * What it guards against: the writers the gates exclude (the core; the IPFS
 * service and the add-on; `hold-lock`), which write on their own only inside
 * their gated directory, a holder ending mid-delete, and a successor taking
 * the gate. Not another process reshaping the profile's tree while the
 * delete runs (renaming its directories, planting links after this check):
 * the walk checks each entry with lstat and then goes by path, as the
 * ungated `fs.rm` does, and such a process, with the user's own rights,
 * needs no race to remove those files.
 *
 * `fences` are the gated directories, in `gatedDirs`' order, each with its
 * canonical path (`dir`), which the fence moves. `nodes` are the directories
 * from the data root (the first, whose canonical path is `root`) down to
 * each gated one: each one's name, its identity if it exists, and its
 * parent's index, the gated directories themselves marked `gated`.
 */
async function gatedPlace(dataRoot, gatedDirs, { otherRoots = [], radicle = null } = {}) {
  const rootStat = await lstatIfThere(dataRoot);
  if (!rootStat) return null;
  if (!rootStat.isDirectory()) {
    throw layoutRefused(gatedDirs[0].what, `is reached through a link (${dataRoot})`);
  }
  const root = await fs.promises.realpath(dataRoot);
  const nodes = [{ name: null, id: identityOf(rootStat), parent: -1, gated: false }];
  const fences = [];
  for (const { dir, what, gate } of gatedDirs) {
    const names = path.relative(dataRoot, dir).split(path.sep);
    let current = dataRoot;
    let parent = 0;
    let stat = null;
    for (const [i, name] of names.entries()) {
      current = path.join(current, name);
      stat = await lstatIfThere(current);
      if (stat && !stat.isDirectory()) {
        throw layoutRefused(what, `is reached through a link (${current})`);
      }
      let index = nodes.findIndex((node) => node.parent === parent && node.name === name);
      if (index === -1) {
        const id = stat ? identityOf(stat) : null;
        nodes.push({ name, id, parent, gated: i === names.length - 1 });
        index = nodes.length - 1;
      }
      parent = index;
    }
    const gated = path.join(root, ...names);
    if (stat && (await fs.promises.realpath(dir)) !== gated) {
      throw layoutRefused(what, `is reached under another name (${dir})`);
    }
    fences.push({ dir: gated, what, gate, id: stat ? identityOf(stat) : null });
  }
  if (radicle) await refuseLinksBelow(radicle.base, radicle.dir);
  for (const fence of fences) {
    const around = await identitiesUp(fence.dir);
    for (const other of otherRoots) {
      const stat = await lstatIfThere(other);
      // Not there; or a link, which is removed as a link, its target
      // untouched.
      if (!stat?.isDirectory()) continue;
      const within =
        fence.id !== null && (await identitiesUp(await fs.promises.realpath(other))).has(fence.id);
      if (around.has(identityOf(stat)) || within) {
        throw layoutRefused(fence.what, `overlaps other data this delete removes (${other})`);
      }
    }
  }
  return { root, nodes, fences };
}

/**
 * The Radicle home's fence, for a delete that holds its gate (freedom-core
 * design 0008, "Spawn and lock"; 0013, "Deletion"): the catalog profile's
 * home (`radicle.dir`, `R/<slot>`), outside the profile's directory, which
 * the fence moves aside with the gated directories inside it
 * (fenceAndCommit). Its path must be free of links at every step below its
 * app-owned base (`radicle.base`), as gatedPlace requires, so the move and
 * the removal reach the directory its gate covers; anything else is refused
 * before anything changes.
 */
async function radicleHomeFence(radicle, gate) {
  await refuseLinksBelow(radicle.base, radicle.dir);
  return { dir: radicle.dir, what: 'Radicle data', gate };
}

// Which of `place`'s directories on the way to a gated one a directory is,
// by identity (-1 for none): the data root's is 0. A gated directory itself
// is never walked into.
function stepOf(place, stat) {
  const id = identityOf(stat);
  return place.nodes.findIndex((node) => !node.gated && node.id === id);
}

// Removes the directory `dir`, `place`'s directory `index` on the way to the
// gated directories, sparing them: it walks only into the directories on the
// way (by identity, under any name), never through a link, and removes
// everything else as the plain removal would. Inside one, a directory named
// as one of its next steps is never removed whole: the next step's own is
// walked into, and any other (a gated directory, or one created or replaced
// since) is spared.
// Directories on the way are only removed if they end up empty.
async function removeSparing(dir, place, index, { skip = null, keepRoot = false } = {}) {
  const next = place.nodes.filter((node) => node.parent === index);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    if (skip?.(name)) continue;
    const target = path.join(dir, name);
    const stat = await lstatIfThere(target);
    if (!stat) continue;
    const step = stat.isDirectory() ? stepOf(place, stat) : -1;
    if (step > index) {
      await removeSparing(target, place, step);
    } else if (
      step >= 0 ||
      (stat.isDirectory() && next.some((node) => sameEntryName(name, node.name)))
    ) {
      // A directory on the way met again (a mount that loops back), or one
      // named as a next step but not that directory: spared.
    } else {
      await fsOffload.removePath(target, { recursive: true, force: true });
    }
  }
  if (keepRoot) return;
  try {
    await fs.promises.rmdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err;
  }
}

// What a delete's callback gets where no gate is held (a development build
// without freedom-cored, freedom-ipfsd or freedom-radicled, or a profile
// with no Radicle home of its own).
const UNGATED = Object.freeze({ gated: false, held: () => false });

// Whether a gate the delete took has been lost since: its holder ended
// unreleased. Never for no gate.
function gateLost(gate) {
  return gate.gated && !gate.held();
}

// Windows refuses a rename while a scanner or indexer has a file open; those
// clear in a moment.
const FENCE_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const FENCE_ATTEMPTS = 10;
const FENCE_RETRY_MS = 100;

// Where the fence moves a gated directory: `.<name>.deleting-<pid>-<ts>`
// beside it, a name no core or service opens.
function tombstoneOf(dir) {
  return path.join(
    path.dirname(dir),
    `.${path.basename(dir)}.deleting-${process.pid}-${Date.now()}`
  );
}

// Puts back what one attempt of the fence moved, last first, in the same
// step as its gate check: nothing has been awaited since, so no new holder
// can have made a gated directory again meanwhile. One that can't be put
// back is named, with where it is.
function moveBack(moved, cause) {
  const stuck = [];
  for (const move of [...moved].reverse()) {
    try {
      fs.renameSync(move.tombstone, move.dir);
    } catch {
      stuck.push(move);
    }
  }
  if (stuck.length > 0) {
    const where = stuck.map((move) => `its ${move.what} is at ${move.tombstone}`).join(', and ');
    throw new Error(
      `The profile couldn't be deleted, and not all of its data could be put back: ${where}. ` +
        'Move it back to its name without the leading dot and the ".deleting-…" suffix.',
      { cause }
    );
  }
}

/**
 * The delete's first change, made under every gate it holds (freedom-core
 * designs 0001 and 0007, "Lifetime lock"; 0008, "Spawn and lock"): each
 * gated directory (`fences`: gatedPlace's, then the Radicle home's,
 * radicleHomeFence) moves aside to its tombstone (`tombstoneOf`), and
 * `commit` drops the profile from the catalog. Resolves to the moves, each
 * fence with its `tombstone`. The gates are checked first, the core's
 * first, and the moves and `commit` follow with nothing awaited: a
 * gate lost before then fails the delete with nothing changed. A move or
 * `commit` that fails has the moves before it put back in that same step
 * (`moveBack`); a Windows refusal (FENCE_RETRY_CODES) is waited out and the
 * whole step tried again, gates checked first.
 *
 * Once moved, a gated directory is never reached by its old path again, and
 * any directory made again there is spared (removeSparing): if a gate's
 * holder ends mid-delete (killed) and a new holder takes the gate, a core
 * on a new, empty identity directory or a service on a new IPFS one, the
 * removal still running leaves it alone, and the delete reports the loss
 * (reportLostGates). The tombstones go with the rest. What remains is the
 * moment between a holder ending and main hearing of it.
 */
async function fenceAndCommit(fences, { coreGate, ipfsGate, radicleGate = UNGATED }, commit) {
  const moves = fences.map((fence) => ({ ...fence, tombstone: tombstoneOf(fence.dir) }));
  for (let attempt = 1; ; attempt += 1) {
    if (gateLost(coreGate)) {
      throw new Error("The profile's core lock was lost; nothing was deleted");
    }
    if (gateLost(ipfsGate)) {
      throw new Error("The IPFS data directory's lock was lost; nothing was deleted");
    }
    if (gateLost(radicleGate)) {
      throw new Error("The Radicle home's lock was lost; nothing was deleted");
    }
    const moved = [];
    try {
      for (const move of moves) {
        try {
          fs.renameSync(move.dir, move.tombstone);
          moved.push(move);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      commit();
      return moves;
    } catch (err) {
      moveBack(moved, err);
      if (!FENCE_RETRY_CODES.has(err.code) || attempt >= FENCE_ATTEMPTS) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, FENCE_RETRY_MS));
  }
}

// After the removal, a gated directory made again since the fence: a core
// or service that tried to start during the delete makes a missing one
// (`hold-lock` and `serve` do), then waits out the gate. Under its gate,
// still held, it is empty and no one's, so it goes, and so does each
// directory above it that this leaves empty, up to the data root (`root`;
// never the packaged app data root, `keepRoot`). Under a gate lost
// meanwhile, it may be a new holder's, and stays.
function removeEmptyRemade(place, { keepRoot = false } = {}) {
  for (const fence of place.fences) {
    if (!fence.gate.held()) continue;
    for (let dir = fence.dir; !(keepRoot && dir === place.root); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      if (dir === place.root) break;
    }
  }
}

// What a gate lost after the delete's first change leaves: the delete went
// on, sparing anything a new holder could own (fenceAndCommit), and says so.
const LOST_GATES = [
  ['coreGate', 'core lock', 'identity directory'],
  ['ipfsGate', 'IPFS data lock', 'IPFS data directory'],
  ['radicleGate', 'Radicle home lock', 'Radicle home'],
];

// "a", "a and b", "a, b and c".
function listed(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

function reportLostGates(gates) {
  const lost = LOST_GATES.filter(([key]) => gateLost(gates[key]));
  if (lost.length === 0) return;
  const locks = listed(lost.map(([, lock]) => lock));
  const dirs = listed(lost.map(([, , dir]) => dir));
  const [were, them] = lost.length > 1 ? ['were', 'them'] : ['was', 'it'];
  throw new Error(
    `The profile was deleted, but its ${locks} ${were} lost during the delete. A process ` +
      `may have taken ${them} since, so its ${dirs}, if made again, ${were} left alone.`
  );
}

function assertDisplayNameConfirmation(expectedDisplayName, displayName) {
  if (String(expectedDisplayName || '') !== displayName) {
    throw new Error('Profile display name confirmation did not match');
  }
}

// Pre-flight validation for a profile deletion, run WITHOUT touching the lock or
// removing anything. Callers use this before asking a running profile to quit so
// an invalid request (wrong id, mismatched confirmation, unsafe dir) is rejected
// up front instead of after a live window has already been closed. The real
// delete re-validates under the catalog write lock — this only gates the quit.
function validateProfileDeletion(appRoot, profileId, expectedDisplayName) {
  const id = sanitizeProfileId(profileId);
  const catalog = loadCatalog(appRoot);
  const { displayName } = assertProfileDeletable(appRoot, catalog, id);
  assertDisplayNameConfirmation(expectedDisplayName, displayName);
}

// Must match profile-paths.js's RADICLE_STAGING_INFIX (not imported: that
// module pulls in electron).
const RADICLE_STAGING_INFIX = '.migrating-';

// The staging copies an interrupted legacy `radicle-data/` carry-over left
// next to a Radicle home (profile-paths.js, `<slot>.migrating-<pid>-<ts>`).
async function radicleStagingSiblings(radicleDir, radicleRoot) {
  const parent = path.dirname(radicleDir);
  const prefix = `${path.basename(radicleDir)}${RADICLE_STAGING_INFIX}`;
  let names;
  try {
    names = await fs.promises.readdir(parent);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => assertPathInside(radicleRoot, path.join(parent, name), 'Radicle data'));
}

async function removeRadicleStagingSiblings(radicleDir, radicleRoot) {
  for (const target of await radicleStagingSiblings(radicleDir, radicleRoot)) {
    await fsOffload.removePath(target, { recursive: true, force: true });
  }
}

// Async: a profile's node data can be several GB, so the recursive deletes run
// off the main thread (fs-offload) while it keeps serving. Ordering is
// unchanged — catalog entry removed and saved first, then the profile dir, then
// the Radicle short home — and all of it still happens under the cross-process
// catalog write lock, so no other process can allocate the freed slot (and
// inherit a half-deleted Radicle home) until the deletes have finished.
async function deleteProfile(appRoot, profileId, expectedDisplayName, options = {}) {
  const id = sanitizeProfileId(profileId);

  return withCatalogWriteLockAsync(appRoot, async () => {
    const catalog = loadCatalog(appRoot);
    const {
      recordIndex,
      record,
      displayName,
      resolvedProfileDir,
      sharesAppRoot,
    } = assertProfileDeletable(appRoot, catalog, id);
    assertDisplayNameConfirmation(expectedDisplayName, displayName);
    if (options.isProfileLocked?.(record)) {
      throw new Error(`Profile is currently open: ${displayName}`);
    }

    // The whole delete runs under the profile's core gate (freedom-core
    // design 0001, "Lifetime lock"): `withCoreGate(dir, fn)` holds
    // freedom-cored's lock on the profile's identity directory while `fn`
    // runs, so a core still running on it fails the delete before anything
    // is changed, rather than having its vault and journal removed under it,
    // and none can start until the delete is done. It is taken first: the
    // core's lifetime lock, then a node's gate (design 0008, "Lock order").
    //
    // The profile's IPFS data goes under its gate too (freedom-core design
    // 0007, "Lifetime lock"): `withIpfsGate(dir, fn)` holds freedom-ipfsd's
    // lock on it while `fn` runs, so a writer that holds it (the service, or
    // the add-on under hold-lock) fails the delete before anything is
    // changed, rather than having its directory removed under it.
    //
    // A catalog profile's Radicle home (`R/<slot>`, outside its directory)
    // goes under freedom-radicled's gate (design 0008, "Spawn and lock"):
    // `withRadicleGate(dir, fn)` holds it while `fn` runs, so a writer that
    // holds it (the service, the add-on under hold-lock, the core writing
    // an identity there) fails the delete before anything is changed. Taken
    // last: the core's lifetime lock, then the nodes' gates. This is main's
    // interim for design 0013's "Deletion", which holds every gate.
    //
    // A gate is held for the whole delete only while its holder lives. So
    // under all of them, each gated directory moves aside before anything
    // else changes (fenceAndCommit), and a holder lost after that leaves the
    // removal nothing of a new holder's to reach: a core started meanwhile
    // finds a new, empty identity directory, which is spared, and the delete
    // reports the loss.
    const dataRoot = sharesAppRoot ? path.resolve(appRoot) : resolvedProfileDir;
    const identityDir = path.join(dataRoot, 'identity');
    const ipfsDataDir = path.join(dataRoot, 'ipfs-data', 'freedom-ipfs');
    const radicleDir = getProfileRadicleDataDir(appRoot, record, options);
    const radicleRoot = options.dev
      ? path.join(path.dirname(appRoot), RADICLE_SHORT_HOME_DIR)
      : path.join(appRoot, RADICLE_SHORT_HOME_DIR);
    const resolvedRadicleDir = radicleDir
      ? assertPathInside(radicleRoot, radicleDir, 'Radicle data')
      : null;
    const withCoreGate = options.withCoreGate ?? ((_dir, fn) => fn(UNGATED));
    const withIpfsGate = options.withIpfsGate ?? ((_dir, fn) => fn(UNGATED));
    const withRadicleGate = options.withRadicleGate ?? ((_dir, fn) => fn(UNGATED));
    const removeUnderGates = async (coreGate, ipfsGate, radicleGate) => {
      // Held: the layout must be the app's own (gatedPlace and
      // radicleHomeFence refuse anything else, before any change); each
      // gated directory moves aside as the catalog changes, in one step
      // under every gate (fenceAndCommit); and the removal never touches one
      // again under any name, sparing any directory made again in its place
      // (removeSparing). Without a gate, today's removal, unchanged.
      const gatedDirs = [];
      if (coreGate.gated) {
        gatedDirs.push({ dir: identityDir, what: 'identity data', gate: coreGate });
      }
      if (ipfsGate.gated) {
        gatedDirs.push({ dir: ipfsDataDir, what: 'IPFS data', gate: ipfsGate });
      }
      const otherRoots = resolvedRadicleDir
        ? [resolvedRadicleDir, ...(await radicleStagingSiblings(resolvedRadicleDir, radicleRoot))]
        : [];
      const radicle = resolvedRadicleDir
        ? { base: path.dirname(radicleRoot), dir: resolvedRadicleDir }
        : null;
      const place =
        gatedDirs.length > 0
          ? await gatedPlace(dataRoot, gatedDirs, { otherRoots, radicle })
          : null;
      const radicleFence =
        radicleGate.gated && radicle ? await radicleHomeFence(radicle, radicleGate) : null;
      const fences = [...(place?.fences ?? []), ...(radicleFence ? [radicleFence] : [])];
      const gates = { coreGate, ipfsGate, radicleGate };
      const moves = await fenceAndCommit(fences, gates, () => {
        catalog.profiles.splice(recordIndex, 1);
        try {
          saveCatalog(appRoot, catalog);
        } catch (err) {
          catalog.profiles.splice(recordIndex, 0, record);
          throw err;
        }
      });
      if (sharesAppRoot) {
        await removeDefaultProfileDataFromAppRoot(appRoot, { place });
      } else if (place) {
        await removeSparing(resolvedProfileDir, place, 0);
      } else {
        await fsOffload.removePath(resolvedProfileDir, { recursive: true, force: true });
      }

      /*
       * IMPORTANT: Radicle data is the managed-node exception to the normal
       * "everything lives under the profile directory" rule.
       *
       * profile-paths.js stores catalog-managed Radicle homes at app-owned short
       * paths (`R/<slot>` or dev `R/<checkoutHash>/<slot>`) because the embedded
       * runtime creates `$RAD_HOME/node/control.sock` and Unix socket paths have a hard
       * length limit. Deleting a profile must remove this sibling Radicle home too;
       * otherwise a later profile that reuses the freed slot could inherit the old
       * Radicle identity, node database, and seeded repository state.
       *
       * Under freedom-radicled's gate, the fence has moved it aside
       * (radicleHomeFence), and its tombstone goes; a home made again since
       * is spared. Without that gate (a development build without the
       * binary), it goes by its path, as before.
       */
      if (resolvedRadicleDir) {
        const fenced = radicleFence && moves.find((move) => move.gate === radicleGate);
        await fsOffload.removePath(fenced ? fenced.tombstone : resolvedRadicleDir, {
          recursive: true,
          force: true,
        });
        // Also any staging copy an interrupted legacy `radicle-data/` carry-over
        // left next to it (profile-paths.js, `<slot>.migrating-<pid>-<ts>`) —
        // otherwise its GBs outlive the profile.
        await removeRadicleStagingSiblings(resolvedRadicleDir, radicleRoot);
      }

      if (place) removeEmptyRemade(place, { keepRoot: sharesAppRoot });
      // A Radicle home made again since the fence, under its gate still
      // held: a start that waited out the gate made it, empty (hold-lock and
      // serve do). Under a gate lost meanwhile, it may be a new holder's,
      // and stays.
      if (radicleFence?.gate.held()) {
        try {
          fs.rmdirSync(radicleFence.dir);
        } catch {
          // Not there, or not empty.
        }
      }
      reportLostGates(gates);
      return {
        catalog,
        record,
      };
    };
    // Only a catalog profile with a slot has a Radicle home of its own.
    const underRadicleGate = (fn) =>
      resolvedRadicleDir ? withRadicleGate(resolvedRadicleDir, fn) : fn(UNGATED);
    return withCoreGate(identityDir, (coreGate = UNGATED) =>
      withIpfsGate(ipfsDataDir, (ipfsGate = UNGATED) =>
        underRadicleGate((radicleGate = UNGATED) =>
          removeUnderGates(coreGate, ipfsGate, radicleGate)
        )
      )
    );
  });
}

function listProfileSummaries(appRoot, options = {}) {
  const catalog = loadCatalog(appRoot);
  const registeredProfiles = catalog.profiles.map((record) => {
    const metadata = readProfileMetadata(record.dir) || createProfileMetadata(record);
    return {
      id: metadata.id || record.id,
      displayName: metadata.displayName || record.displayName || displayNameFromId(record.id),
      slot: Number.isInteger(metadata.slot) ? metadata.slot : record.slot,
      createdAt: metadata.createdAt || record.createdAt || null,
      lastOpenedAt: metadata.lastOpenedAt || record.lastOpenedAt || null,
      nodes: metadata.nodes || record.nodes || null,
      isActive: options.activeProfileId === record.id,
      isUnregistered: false,
    };
  });

  return [
    ...registeredProfiles,
    ...listUnregisteredProfileSummaries(appRoot, catalog, options),
  ];
}

function importProfile(appRoot, profileId, options = {}) {
  const id = sanitizeProfileId(profileId);
  if (id === DEFAULT_PROFILE_ID) {
    throw new Error('The default profile is already registered');
  }

  return withCatalogWriteLock(appRoot, () => {
    const catalog = loadCatalog(appRoot);
    if (findProfile(catalog, id)) {
      throw new Error(`Profile already exists: ${id}`);
    }

    const dir = path.join(getProfilesRoot(appRoot), id);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Profile directory not found: ${id}`);
    }
    if (!isPathInside(getProfilesRoot(appRoot), dir)) {
      throw new Error('Refusing to import a profile outside the profiles directory');
    }

    const record = createRecordFromExistingProfile(appRoot, id, dir, catalog, options);

    catalog.profiles.push(record);
    saveCatalog(appRoot, catalog);

    const metadata = createProfileMetadata(record);
    writeProfileMetadata(record.dir, metadata);

    return {
      catalog,
      record,
      metadata,
    };
  });
}

function updateProfileNodeConfig(profile, protocol, updates) {
  if (!profile?.appRoot || !profile?.userDataDir || !profile?.id || !profile?.metadata) {
    return null;
  }

  if (!['bee', 'ipfs', 'myotis', 'radicle', 'tor'].includes(protocol)) {
    throw new Error(`Unsupported profile node protocol: ${protocol}`);
  }

  const nativeBackend = {
    ipfs: 'freedom-ipfs',
    myotis: 'myotis-native',
  }[protocol];
  // Myotis is native-only, so its mode is clamped to managed/disabled. IPFS is
  // native too, but may instead be pointed at an external HTTP gateway, so it
  // keeps its full field set (mode, externalGateway, the external-candidate
  // prompt marker) and merges like the non-native nodes.
  // Clamping IPFS here would silently drop `external` and the gateway.
  const forceNativeManaged = Boolean(nativeBackend) && protocol !== 'ipfs';
  const normalizedUpdates = forceNativeManaged
    ? {
        mode: updates?.mode === 'disabled' ? 'disabled' : 'managed',
        backend: nativeBackend,
      }
    : nativeBackend
      ? { ...updates, backend: nativeBackend }
      : updates;

  return withCatalogWriteLock(profile.appRoot, () => {
    const catalog = loadCatalog(profile.appRoot);
    const record = findProfile(catalog, profile.id);

    if (record) {
      record.nodes = record.nodes || {};
      record.nodes[protocol] = forceNativeManaged
        ? normalizedUpdates
        : {
            ...(record.nodes[protocol] || {}),
            ...normalizedUpdates,
          };
      saveCatalog(profile.appRoot, catalog);
    }

    const metaPath = getProfileMetaPath(profile.userDataDir);
    const metadata = fs.existsSync(metaPath)
      ? readJson(metaPath)
      : { ...profile.metadata };

    metadata.nodes = metadata.nodes || {};
    metadata.nodes[protocol] = forceNativeManaged
      ? normalizedUpdates
      : {
          ...(metadata.nodes[protocol] || {}),
          ...normalizedUpdates,
        };
    writeProfileMetadata(profile.userDataDir, metadata);

    return {
      catalog,
      record,
      metadata,
    };
  });
}

function ensureProfile(appRoot, profileId, options = {}) {
  return withCatalogWriteLock(appRoot, () => {
    const catalog = loadCatalog(appRoot);
    let record = findProfile(catalog, profileId);
    let catalogChanged = false;
    let adoptedExistingProfile = false;

    if (!record) {
      const dir = getProfileDir(appRoot, profileId, options);
      const dirExists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      const existingMetadata = dirExists ? readProfileMetadata(dir) : null;

      if (existingMetadata) {
        record = createRecordFromExistingProfile(appRoot, profileId, dir, catalog, options);
        adoptedExistingProfile = true;
      } else if (dirExists && profileId !== DEFAULT_PROFILE_ID) {
        throw new Error(
          `Profile directory exists but is not registered: ${profileId}. ` +
          'Import it from the profile manager before launching it.'
        );
      } else {
        record = createProfileRecord(appRoot, profileId, {
          ...options,
          catalog,
        });
      }
      catalog.profiles.push(record);
      catalogChanged = true;
    } else if (normalizeRecordNodeConfig(record, options)) {
      catalogChanged = true;
    }

    ensureDir(record.dir);

    const metaPath = getProfileMetaPath(record.dir);
    let metadata;
    let metadataChanged = false;
    if (adoptedExistingProfile) {
      metadata = createProfileMetadata(record);
      metadataChanged = true;
    } else if (fs.existsSync(metaPath)) {
      metadata = readJson(metaPath);
      const normalizedNodes = fillMissingNodeConfig(
        {
          ...(record.nodes || {}),
          ...(metadata.nodes || {}),
        },
        getRecordManagedPorts(record, options)
      );
      if (JSON.stringify(normalizedNodes) !== JSON.stringify(metadata.nodes || {})) {
        metadata = {
          ...metadata,
          nodes: normalizedNodes,
        };
        metadataChanged = true;
      }
    } else {
      metadata = createProfileMetadata(record);
      metadataChanged = true;
    }

    if (options.markOpened === true) {
      const openedAt = options.now || new Date().toISOString();
      if (record.lastOpenedAt !== openedAt) {
        record.lastOpenedAt = openedAt;
        catalogChanged = true;
      }
      if (metadata.lastOpenedAt !== openedAt) {
        metadata = {
          ...metadata,
          lastOpenedAt: openedAt,
        };
        metadataChanged = true;
      }
    }

    if (catalogChanged) {
      saveCatalog(appRoot, catalog);
    }
    if (metadataChanged) {
      writeProfileMetadata(record.dir, metadata);
    }

    return {
      catalog,
      catalogPath: getCatalogPath(appRoot),
      record,
      metadata,
    };
  });
}

module.exports = {
  DEFAULT_CATALOG_LOCK_STALE_MS,
  DEFAULT_CATALOG_LOCK_RETRIES,
  DEFAULT_CATALOG_LOCK_UPDATE_MS,
  DEFAULT_PROFILE_ID,
  DEV_PORT_BASE,
  PACKAGED_PORT_BASE,
  PROFILE_CATALOG_LOCK_DIR,
  PROFILE_CATALOG_LOCK_TARGET,
  PROFILE_META_FILE,
  PROFILE_REGISTRY_FILE,
  PROFILES_DIR,
  allocateSlot,
  createProfile,
  createProfileMetadata,
  deleteProfile,
  displayNameFromId,
  ensureProfile,
  getCatalogPath,
  getCatalogLockPaths,
  getCheckoutId,
  getDevPortOffset,
  getManagedPorts,
  getProfileMetaPath,
  getReservedManagedPorts,
  hashPath,
  importProfile,
  listProfileSummaries,
  listProfileDataDirs,
  loadCatalog,
  renameProfile,
  readProfileMetadata,
  sanitizeProfileId,
  saveCatalog,
  updateProfileNodeConfig,
  validateProfileDeletion,
  writeProfileMetadata,
  withCatalogWriteLock,
  withCatalogWriteLockAsync,
  waitForCatalogWriteLockIdle,
};
