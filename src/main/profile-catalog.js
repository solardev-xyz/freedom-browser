const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const PROFILE_REGISTRY_FILE = 'profile-registry.json';
const PROFILE_META_FILE = 'profile.json';
const RADICLE_SHORT_HOME_DIR = 'R';
const PROFILE_CATALOG_LOCK_TARGET = 'profile-registry.write-lock-target';
const PROFILE_CATALOG_LOCK_DIR = 'profile-registry.write.lock';
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

function rebaseNodeConfig(nodes = {}, ports) {
  const defaults = buildNodeConfig(ports);
  return {
    bee: {
      ...defaults.bee,
      mode: nodes.bee?.mode || defaults.bee.mode,
      externalApi: nodes.bee?.externalApi || null,
    },
    ipfs: {
      ...defaults.ipfs,
      mode: nodes.ipfs?.mode === 'disabled' ? 'disabled' : defaults.ipfs.mode,
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
      mode: nodes.ipfs?.mode === 'disabled' ? 'disabled' : defaults.ipfs.mode,
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

function withCatalogWriteLock(appRoot, fn, options = {}) {
  const paths = ensureCatalogLockTarget(appRoot);
  const release = acquireCatalogWriteLock(paths, options);

  try {
    return fn();
  } finally {
    release();
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
  return path.join(appRoot, 'Profiles', profileId);
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
  return path.join(appRoot, 'Profiles');
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

  const record = catalog.profiles[recordIndex];
  const displayName = record.displayName || displayNameFromId(record.id);

  const resolvedAppRoot = path.resolve(appRoot);
  const resolvedProfileDir = path.resolve(record.dir);
  if (
    resolvedProfileDir === resolvedAppRoot ||
    !resolvedProfileDir.startsWith(`${resolvedAppRoot}${path.sep}`)
  ) {
    throw new Error('Refusing to delete a profile outside the app data root');
  }

  return { recordIndex, record, displayName, resolvedProfileDir };
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
  if (id === DEFAULT_PROFILE_ID) {
    throw new Error('The default profile cannot be deleted');
  }

  const catalog = loadCatalog(appRoot);
  const { displayName } = assertProfileDeletable(appRoot, catalog, id);
  assertDisplayNameConfirmation(expectedDisplayName, displayName);
}

function deleteProfile(appRoot, profileId, expectedDisplayName, options = {}) {
  const id = sanitizeProfileId(profileId);
  if (id === DEFAULT_PROFILE_ID) {
    throw new Error('The default profile cannot be deleted');
  }

  return withCatalogWriteLock(appRoot, () => {
    const catalog = loadCatalog(appRoot);
    const { recordIndex, record, displayName, resolvedProfileDir } = assertProfileDeletable(
      appRoot,
      catalog,
      id
    );
    assertDisplayNameConfirmation(expectedDisplayName, displayName);
    if (options.isProfileLocked?.(record)) {
      throw new Error(`Profile is currently open: ${displayName}`);
    }

    catalog.profiles.splice(recordIndex, 1);
    saveCatalog(appRoot, catalog);
    fs.rmSync(resolvedProfileDir, { recursive: true, force: true });

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
     */
    const radicleDir = getProfileRadicleDataDir(appRoot, record, options);
    if (radicleDir) {
      const radicleRoot = options.dev
        ? path.join(path.dirname(appRoot), RADICLE_SHORT_HOME_DIR)
        : path.join(appRoot, RADICLE_SHORT_HOME_DIR);
      const resolvedRadicleDir = assertPathInside(radicleRoot, radicleDir, 'Radicle data');
      fs.rmSync(resolvedRadicleDir, { recursive: true, force: true });
    }

    return {
      catalog,
      record,
    };
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
  const normalizedUpdates = nativeBackend
    ? {
        mode: updates?.mode === 'disabled' ? 'disabled' : 'managed',
        backend: nativeBackend,
      }
    : updates;

  return withCatalogWriteLock(profile.appRoot, () => {
    const catalog = loadCatalog(profile.appRoot);
    const record = findProfile(catalog, profile.id);

    if (record) {
      record.nodes = record.nodes || {};
      record.nodes[protocol] = nativeBackend
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
    metadata.nodes[protocol] = nativeBackend
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
  loadCatalog,
  renameProfile,
  readProfileMetadata,
  sanitizeProfileId,
  saveCatalog,
  updateProfileNodeConfig,
  validateProfileDeletion,
  writeProfileMetadata,
  withCatalogWriteLock,
};
