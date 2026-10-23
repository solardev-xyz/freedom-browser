/**
 * Feed Metadata Store
 *
 * Persists per-origin feed identity and feed state. Separate from
 * swarm-permissions.js — this is identity/feed metadata, not
 * connection permission state.
 *
 * Data model:
 *   {
 *     version,
 *     nextPublisherKeyIndex,
 *     origins: {
 *       [origin]: { activeIdentityId, identities, feedGranted, grantedAt, feeds }
 *     }
 *   }
 *
 * A default identity is chosen when an origin first receives feed access:
 *   - 'bee-wallet': uses the Bee node wallet key for signing
 *   - 'app-scoped': uses a dedicated publisher key derived at m/44'/73406'/{index}'/0/0
 *
 * The 'ethereum-wallet' mode (one of the user's wallet accounts) is gone
 * (removed-identity-mode.js, #89). A stored identity in it still loads, so
 * its origin keeps its record and nothing picks another key for it, but it
 * is shown as unavailable and every use of it fails.
 *
 * Survives permission revocation — revoking Swarm connection does not
 * forget publisher identities. Switching identity is an explicit user action.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { withOriginLock } = require('./origin-mutation-lock');
const {
  getBeeWalletAddress,
  getPublisherAddress,
  getDerivedWallets,
} = require('../identity-manager');
const { ETHEREUM_WALLET_MODE, ETHEREUM_WALLET_UNAVAILABLE } = require('./removed-identity-mode');
const log = require('electron-log');

const FEEDS_FILE = 'swarm-feeds.json';
const CURRENT_VERSION = 2;
const MAX_IDENTITY_LABEL_BYTES = 80;

const VALID_IDENTITY_MODES = ['bee-wallet', 'app-scoped'];
const BEE_WALLET_IDENTITY_ID = 'bee-wallet';
// The removed mode loads, and fails on use (#89).
const STORED_IDENTITY_MODES = [...VALID_IDENTITY_MODES, ETHEREUM_WALLET_MODE];

let feedsCache = null;

// Manifest-ownership hook, mirroring swarm-permissions.js. A permission
// manifest can own the feed grant and the publisher identity of an origin;
// when the *user* changes either by hand, that ownership has to be detached
// or the manifest record keeps claiming the flag (Settings still reads
// "feeds · allowed by manifest") and a later projection silently re-asserts
// it. Manifest-sourced calls pass `{ source: 'manifest' }` and notify
// nothing — they are the projection, not a user mutation.
let manifestMutationListener = null;

function onManifestMutation(listener) {
  manifestMutationListener = listener;
}

function notifyManifestMutation(origin, projectionKey) {
  manifestMutationListener?.(normalizeOrigin(origin), projectionKey);
}

class PreserveFeedStoreError extends Error {
  constructor(message, backupSuffix = 'unsupported') {
    super(message);
    this.preserveOriginal = true;
    this.backupSuffix = backupSuffix;
  }
}

/** Throws unless `identityMode` is one a new identity can have. */
function assertAvailableMode(identityMode) {
  if (identityMode === ETHEREUM_WALLET_MODE) {
    throw new Error(ETHEREUM_WALLET_UNAVAILABLE);
  }
  if (!VALID_IDENTITY_MODES.includes(identityMode)) {
    throw new Error(`Invalid identity mode: ${identityMode}`);
  }
}

function getFeedsPath() {
  return path.join(app.getPath('userData'), FEEDS_FILE);
}

function createEmptyStore() {
  return {
    version: CURRENT_VERSION,
    nextPublisherKeyIndex: 0,
    origins: {},
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getIdentityId(identityMode, publisherKeyIndex = null) {
  if (identityMode === 'bee-wallet') {
    return BEE_WALLET_IDENTITY_ID;
  }
  if (identityMode === 'app-scoped') {
    if (typeof publisherKeyIndex !== 'number' || !Number.isInteger(publisherKeyIndex) || publisherKeyIndex < 0) {
      throw new Error('App-scoped identity requires a non-negative publisher key index');
    }
    return `app-scoped:${publisherKeyIndex}`;
  }
  assertAvailableMode(identityMode);
  throw new Error(`Invalid identity mode: ${identityMode}`);
}

function getIdentityLabel(identityMode, publisherKeyIndex = null) {
  if (identityMode === 'bee-wallet') {
    return 'Bee wallet identity';
  }
  return `App-scoped identity ${(publisherKeyIndex ?? 0) + 1}`;
}

function normalizeIdentityLabel(label, fallback) {
  if (label === undefined || label === null) {
    return fallback;
  }
  if (typeof label !== 'string') {
    throw new Error('Publisher identity label must be a string');
  }
  const trimmed = label.trim();
  if (!trimmed) {
    return fallback;
  }
  if (Buffer.byteLength(trimmed, 'utf-8') > MAX_IDENTITY_LABEL_BYTES) {
    throw new Error(`Publisher identity label must be ${MAX_IDENTITY_LABEL_BYTES} bytes or less`);
  }
  return trimmed;
}

function createIdentity(identityMode, publisherKeyIndex = null, createdAt = Date.now(), label = null) {
  assertAvailableMode(identityMode);

  const id = getIdentityId(identityMode, publisherKeyIndex);
  const fallbackLabel = getIdentityLabel(identityMode, publisherKeyIndex);
  return {
    id,
    mode: identityMode,
    publisherKeyIndex: identityMode === 'app-scoped' ? publisherKeyIndex : null,
    walletIndex: null,
    label: normalizeIdentityLabel(label, fallbackLabel),
    createdAt,
    lastUsedAt: null,
  };
}

function getActiveIdentityFromEntry(entry) {
  if (!entry || !entry.activeIdentityId || !isPlainObject(entry.identities)) {
    return null;
  }
  return entry.identities[entry.activeIdentityId] || null;
}

function copyFeeds(feeds) {
  const feedsCopy = {};
  if (!isPlainObject(feeds)) {
    return feedsCopy;
  }
  for (const [name, feed] of Object.entries(feeds)) {
    feedsCopy[name] = { ...feed };
  }
  return feedsCopy;
}

function copyIdentities(identities) {
  const identitiesCopy = {};
  if (!isPlainObject(identities)) {
    return identitiesCopy;
  }
  for (const [id, identity] of Object.entries(identities)) {
    identitiesCopy[id] = { ...identity };
  }
  return identitiesCopy;
}

function decorateOriginEntry(entry) {
  const activeIdentity = getActiveIdentityFromEntry(entry);
  return {
    ...entry,
    identities: copyIdentities(entry.identities),
    feeds: copyFeeds(entry.feeds),
    identityMode: activeIdentity?.mode || null,
    publisherKeyIndex: activeIdentity?.publisherKeyIndex ?? null,
    walletIndex: activeIdentity?.walletIndex ?? null,
  };
}

function migrateV1OriginEntry(entry) {
  if (!isPlainObject(entry) || !VALID_IDENTITY_MODES.includes(entry.identityMode)) {
    throw new Error('Invalid v1 origin entry');
  }

  const grantedAt = entry.grantedAt || Date.now();
  const publisherKeyIndex = entry.identityMode === 'app-scoped' ? entry.publisherKeyIndex : null;
  const identity = createIdentity(entry.identityMode, publisherKeyIndex, grantedAt);
  const feeds = {};

  if (entry.feeds !== undefined && !isPlainObject(entry.feeds)) {
    throw new Error('Invalid v1 feed map');
  }

  for (const [feedName, feed] of Object.entries(entry.feeds || {})) {
    if (!isPlainObject(feed)) {
      throw new Error('Invalid v1 feed entry');
    }
    feeds[feedName] = {
      ...feed,
      identityId: feed.identityId || identity.id,
    };
  }

  return {
    activeIdentityId: identity.id,
    feedGranted: !!entry.feedGranted,
    grantedAt,
    identities: {
      [identity.id]: identity,
    },
    feeds,
  };
}

function migrateV1Store(store) {
  if (!isPlainObject(store.origins)) {
    throw new Error('Invalid v1 feed store: origins must be an object');
  }

  const migrated = {
    version: CURRENT_VERSION,
    nextPublisherKeyIndex: Number.isInteger(store.nextPublisherKeyIndex) && store.nextPublisherKeyIndex >= 0
      ? store.nextPublisherKeyIndex
      : 0,
    origins: {},
  };

  for (const [origin, entry] of Object.entries(store.origins)) {
    let migratedEntry;
    try {
      migratedEntry = migrateV1OriginEntry(entry);
    } catch (err) {
      log.error(`[FeedStore] Skipping invalid v1 origin entry ${origin}:`, err.message);
      continue;
    }
    migrated.origins[origin] = migratedEntry;
    const activeIdentity = getActiveIdentityFromEntry(migratedEntry);
    if (activeIdentity?.mode === 'app-scoped') {
      updateNextPublisherKeyIndex(migrated, activeIdentity.publisherKeyIndex);
    }
  }

  return migrated;
}

function validateV2Store(store) {
  if (!isPlainObject(store.origins)) {
    throw new Error('Invalid v2 feed store: origins must be an object');
  }
  if (!Number.isInteger(store.nextPublisherKeyIndex) || store.nextPublisherKeyIndex < 0) {
    throw new Error('Invalid v2 feed store: nextPublisherKeyIndex must be a non-negative integer');
  }

  const sanitizedOrigins = {};
  let changed = false;
  for (const [origin, entry] of Object.entries(store.origins)) {
    try {
      sanitizedOrigins[origin] = sanitizeV2OriginEntry(origin, entry);
    } catch (err) {
      changed = true;
      log.error(`[FeedStore] Skipping invalid v2 origin entry ${origin}:`, err.message);
    }
  }

  if (changed) {
    store.origins = sanitizedOrigins;
  }
  return store;
}

function sanitizeV2OriginEntry(origin, entry) {
  if (!isPlainObject(entry) || !entry.activeIdentityId || !isPlainObject(entry.identities)) {
    throw new Error(`Invalid v2 origin entry: ${origin}`);
  }
  const activeIdentity = getActiveIdentityFromEntry(entry);
  // A stored ethereum-wallet identity loads (#89): dropping its origin
  // would let the next feed grant pick another key, another feed owner.
  if (!activeIdentity || !STORED_IDENTITY_MODES.includes(activeIdentity.mode)) {
    throw new Error(`Invalid active identity for origin: ${origin}`);
  }

  const feeds = {};
  if (entry.feeds !== undefined && !isPlainObject(entry.feeds)) {
    log.error(`[FeedStore] Replacing invalid feed map for ${origin}`);
  } else {
    for (const [feedName, feed] of Object.entries(entry.feeds || {})) {
      if (!isPlainObject(feed)) {
        log.error(`[FeedStore] Skipping invalid feed entry ${origin}/${feedName}`);
        continue;
      }
      feeds[feedName] = feed;
    }
  }

  return {
    ...entry,
    feeds,
  };
}

function getBackupPath(filePath, suffix) {
  const parsed = path.parse(filePath);
  let index = 0;
  let candidate;
  do {
    const extra = index === 0 ? '' : `-${index}`;
    candidate = path.join(parsed.dir, `${parsed.name}.${suffix}${extra}${parsed.ext}`);
    index += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

function backupFeedsFile(filePath, suffix) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const backupPath = getBackupPath(filePath, suffix);
    fs.copyFileSync(filePath, backupPath);
    log.info(`[FeedStore] Backed up ${FEEDS_FILE} to ${path.basename(backupPath)}`);
    return backupPath;
  } catch (err) {
    log.error('[FeedStore] Failed to back up feeds file:', err.message);
    return null;
  }
}

function loadFeedsFromFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  if (!isPlainObject(parsed)) {
    throw new Error('Feed store root must be an object');
  }

  if (parsed.version === 1) {
    const migrated = migrateV1Store(parsed);
    backupFeedsFile(filePath, 'v1-backup');
    feedsCache = migrated;
    saveFeeds();
    return migrated;
  }

  if (parsed.version === CURRENT_VERSION) {
    return validateV2Store(parsed);
  }

  throw new PreserveFeedStoreError(`Unsupported feed store version: ${parsed.version ?? 'missing'}`);
}

function loadFeeds() {
  if (feedsCache !== null) {
    return feedsCache;
  }

  const filePath = getFeedsPath();
  try {
    if (fs.existsSync(filePath)) {
      feedsCache = loadFeedsFromFile(filePath);
    } else {
      feedsCache = createEmptyStore();
    }
  } catch (err) {
    log.error('[FeedStore] Failed to load feeds:', err.message);
    backupFeedsFile(filePath, err.backupSuffix || 'corrupt');
    feedsCache = createEmptyStore();
  }

  return feedsCache;
}

function saveFeeds() {
  try {
    const filePath = getFeedsPath();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(feedsCache, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    log.error('[FeedStore] Failed to save feeds:', err.message);
    feedsCache = null;
    throw err;
  }
}

/**
 * @param {string} origin
 * @returns {Object|null} Shallow copy of the origin entry, or null
 */
function getOriginEntry(origin) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const entry = store.origins[key];
  if (!entry) return null;
  return decorateOriginEntry(entry);
}

/**
 * Create or update an origin entry with identity mode and key index.
 * Used by the feed approval prompt to establish or re-grant feed access.
 * @param {string} origin
 * @param {{ identityMode: string, publisherKeyIndex?: number }} data
 * @returns {Object} The origin entry
 */
function setOriginEntry(origin, data) {
  assertAvailableMode(data.identityMode);

  const store = loadFeeds();
  const key = normalizeOrigin(origin);

  const existing = store.origins[key] || {};
  let publisherKeyIndex = data.publisherKeyIndex ?? null;
  if (data.identityMode === 'app-scoped' && publisherKeyIndex === null) {
    publisherKeyIndex = allocatePublisherKeyIndexInStore(store);
  }
  if (data.identityMode === 'app-scoped') {
    updateNextPublisherKeyIndex(store, publisherKeyIndex);
  }
  const identity = createIdentity(
    data.identityMode,
    publisherKeyIndex,
    existing.grantedAt || Date.now(),
    null
  );
  const identities = {
    ...(existing.identities || {}),
    [identity.id]: identity,
  };

  store.origins[key] = {
    ...existing,
    activeIdentityId: identity.id,
    identities,
    feedGranted: data.feedGranted ?? existing.feedGranted ?? false,
    grantedAt: existing.grantedAt || Date.now(),
    feeds: existing.feeds || {},
  };

  saveFeeds();

  log.info(`[FeedStore] Set origin entry for ${key}: mode=${data.identityMode}`);
  return getOriginEntry(origin);
}

/**
 * Allocate the next publisher key index. Increments the counter.
 * @returns {number} The allocated index
 */
function allocatePublisherKeyIndex() {
  const store = loadFeeds();
  const index = allocatePublisherKeyIndexInStore(store);
  saveFeeds();
  return index;
}

function allocatePublisherKeyIndexInStore(store) {
  const index = store.nextPublisherKeyIndex;
  store.nextPublisherKeyIndex = index + 1;
  return index;
}

function updateNextPublisherKeyIndex(store, publisherKeyIndex) {
  if (typeof publisherKeyIndex !== 'number') return;
  if (store.nextPublisherKeyIndex <= publisherKeyIndex) {
    store.nextPublisherKeyIndex = publisherKeyIndex + 1;
  }
}

function createOriginShell() {
  return {
    activeIdentityId: null,
    feedGranted: false,
    grantedAt: Date.now(),
    identities: {},
    feeds: {},
  };
}

function getOriginIdentityState(origin) {
  const entry = getOriginEntry(origin);
  if (!entry) return null;
  return {
    origin: normalizeOrigin(origin),
    activeIdentityId: entry.activeIdentityId,
    identityMode: entry.identityMode,
    publisherKeyIndex: entry.publisherKeyIndex,
    walletIndex: entry.walletIndex,
    identities: Object.values(entry.identities || {})
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
    feedGranted: !!entry.feedGranted,
    grantedAt: entry.grantedAt || null,
    feedCount: entry.feeds ? Object.keys(entry.feeds).length : 0,
  };
}

async function enrichIdentityOwner(identity, options = {}) {
  const stored = options.stored !== false;
  if (identity.mode === 'bee-wallet') {
    const owner = await getBeeWalletAddress();
    if (!owner) {
      throw new Error('Vault must be unlocked to inspect publisher identities');
    }
    return {
      ...identity,
      owner,
      stored,
    };
  }

  if (identity.mode === 'app-scoped') {
    if (typeof identity.publisherKeyIndex !== 'number') {
      throw new Error('App-scoped identity is missing a publisher key index');
    }
    return {
      ...identity,
      owner: await getPublisherAddress(identity.publisherKeyIndex),
      stored,
    };
  }

  if (identity.mode === ETHEREUM_WALLET_MODE) {
    // Removed (#89): shown, so the user sees which account the origin
    // used and can switch, but never usable. Its owner is public metadata.
    const wallets = await getDerivedWallets();
    const wallet = wallets.find((candidate) => candidate.index === identity.walletIndex);
    return {
      ...identity,
      label: wallet?.name || identity.label || 'Ethereum wallet',
      owner: wallet?.address || null,
      stored,
      unavailable: true,
    };
  }

  return { ...identity, owner: null, stored };
}

async function getOriginIdentityStateWithOwners(origin) {
  const state = getOriginIdentityState(origin) || {
    origin: normalizeOrigin(origin),
    activeIdentityId: null,
    identityMode: null,
    publisherKeyIndex: null,
    walletIndex: null,
    identities: [],
    feedGranted: false,
    grantedAt: null,
    feedCount: 0,
  };

  const identities = [];
  let hasBeeWallet = false;
  for (const identity of state.identities || []) {
    const enriched = await enrichIdentityOwner(identity);
    identities.push(enriched);
    if (identity.id === BEE_WALLET_IDENTITY_ID) {
      hasBeeWallet = true;
    }
  }

  if (!hasBeeWallet) {
    identities.push(await enrichIdentityOwner(
      createIdentity('bee-wallet', null, 0),
      { stored: false }
    ));
  }

  return {
    ...state,
    identities,
  };
}

async function previewAppScopedIdentity(origin, options = {}) {
  const store = loadFeeds();
  const publisherKeyIndex = store.nextPublisherKeyIndex;
  const identity = createIdentity('app-scoped', publisherKeyIndex, Date.now(), options.label);
  const enriched = await enrichIdentityOwner(identity, { stored: false });
  return {
    ...enriched,
    preview: true,
    origin: normalizeOrigin(origin),
  };
}

// A manifest can own an origin's publisher identity (the `feeds`/`signing`
// capabilities project it). Any user-driven change of the *active* identity
// makes that ownership claim untrue, so it is reported like the other user
// mutations. Only an actual switch counts — re-ensuring the identity that is
// already active changes nothing to detach.
function notifyIdentityChange(key, previousActiveId, source) {
  if (source === 'manifest') return;
  if (loadFeeds().origins[key]?.activeIdentityId === previousActiveId) return;
  notifyManifestMutation(key, 'identity');
}

function createAppScopedIdentity(origin, options = {}) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const entry = store.origins[key] || createOriginShell();
  const previousActiveId = entry.activeIdentityId;
  const publisherKeyIndex = allocatePublisherKeyIndexInStore(store);
  const identity = createIdentity('app-scoped', publisherKeyIndex, Date.now(), options.label);

  entry.identities = {
    ...(entry.identities || {}),
    [identity.id]: identity,
  };
  if (options.activate !== false || !entry.activeIdentityId) {
    entry.activeIdentityId = identity.id;
    entry.identities[identity.id].lastUsedAt = Date.now();
  }
  entry.feeds = entry.feeds || {};
  entry.grantedAt = entry.grantedAt || Date.now();
  entry.feedGranted = !!entry.feedGranted;

  store.origins[key] = entry;
  saveFeeds();
  log.info(`[FeedStore] Created app-scoped identity ${identity.id} for ${key}`);
  notifyIdentityChange(key, previousActiveId, options.source);
  return getOriginEntry(origin);
}

function ensureAntWalletIdentity(origin, options = {}) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const entry = store.origins[key] || createOriginShell();
  const previousActiveId = entry.activeIdentityId;
  const existing = entry.identities?.[BEE_WALLET_IDENTITY_ID];
  const identity = existing || createIdentity('bee-wallet', null, Date.now(), options.label);

  entry.identities = {
    ...(entry.identities || {}),
    [identity.id]: identity,
  };
  if (options.activate === true || !entry.activeIdentityId) {
    entry.activeIdentityId = identity.id;
    entry.identities[identity.id].lastUsedAt = Date.now();
  }
  entry.feeds = entry.feeds || {};
  entry.grantedAt = entry.grantedAt || Date.now();
  entry.feedGranted = !!entry.feedGranted;

  store.origins[key] = entry;
  saveFeeds();
  log.info(`[FeedStore] Ensured Ant wallet identity for ${key}`);
  notifyIdentityChange(key, previousActiveId, options.source);
  return getOriginEntry(origin);
}

function activateIdentity(origin, identityId, { source = 'user' } = {}) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const entry = store.origins[key];
  if (!entry) {
    throw new Error(`No origin entry for ${key}`);
  }
  if (!entry.identities?.[identityId]) {
    throw new Error(`Publisher identity not found: ${identityId}`);
  }
  if (entry.identities[identityId].mode === ETHEREUM_WALLET_MODE) {
    throw new Error(ETHEREUM_WALLET_UNAVAILABLE);
  }

  const previousActiveId = entry.activeIdentityId;
  entry.activeIdentityId = identityId;
  entry.identities[identityId].lastUsedAt = Date.now();
  saveFeeds();
  log.info(`[FeedStore] Activated identity ${identityId} for ${key}`);
  notifyIdentityChange(key, previousActiveId, source);
  return getOriginEntry(origin);
}

/**
 * @param {string} origin
 * @param {string} feedName
 * @returns {Object|null} Shallow copy of the feed entry, or null
 */
function getFeed(origin, feedName) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const feed = store.origins[key]?.feeds?.[feedName];
  if (!feed) return null;
  return { ...feed };
}

/**
 * Create or update a feed entry.
 * @param {string} origin
 * @param {string} feedName
 * @param {{ topic: string, owner: string, manifestReference: string }} feedData
 * @returns {Object} The feed entry
 */
function setFeed(origin, feedName, feedData) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);

  if (!store.origins[key]) {
    throw new Error(`No origin entry for ${key}. Call setOriginEntry first.`);
  }

  if (!store.origins[key].feeds) {
    store.origins[key].feeds = {};
  }

  const existing = store.origins[key].feeds[feedName];
  store.origins[key].feeds[feedName] = {
    topic: feedData.topic,
    owner: feedData.owner,
    manifestReference: feedData.manifestReference,
    identityId: existing?.identityId || feedData.identityId || store.origins[key].activeIdentityId || null,
    createdAt: existing?.createdAt || Date.now(),
    lastUpdated: existing?.lastUpdated || null,
    lastReference: existing?.lastReference || null,
  };

  saveFeeds();

  log.info(`[FeedStore] Set feed ${feedName} for ${key}`);
  return getFeed(origin, feedName);
}

/**
 * Update a feed's last reference after a feed update.
 * @param {string} origin
 * @param {string} feedName
 * @param {string} reference - The content reference the feed now points at
 */
function updateFeedReference(origin, feedName, reference) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);

  const feed = store.origins[key]?.feeds?.[feedName];
  if (!feed) {
    throw new Error(`Feed ${feedName} not found for ${key}`);
  }

  feed.lastReference = reference;
  feed.lastUpdated = Date.now();

  saveFeeds();
}

/**
 * @param {string} origin
 * @returns {Object} Map of feedName → feed entry (shallow copies), or empty object
 */
function getAllFeeds(origin) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const feeds = store.origins[key]?.feeds;
  if (!feeds) return {};
  const result = {};
  for (const [name, feed] of Object.entries(feeds)) {
    result[name] = { ...feed };
  }
  return result;
}

/**
 * Get all origin entries with feed identities.
 * @returns {Array<{ origin, identityMode, publisherKeyIndex, feedGranted, grantedAt, feedCount }>}
 */
function getAllOriginEntries() {
  const store = loadFeeds();
  return Object.entries(store.origins)
    .filter(([, entry]) => entry.activeIdentityId)
    .map(([origin, entry]) => {
      const activeIdentity = getActiveIdentityFromEntry(entry);
      return {
        origin,
        identityMode: activeIdentity?.mode || null,
        publisherKeyIndex: activeIdentity?.publisherKeyIndex ?? null,
        walletIndex: activeIdentity?.walletIndex ?? null,
        activeIdentityId: entry.activeIdentityId,
        identityCount: entry.identities ? Object.keys(entry.identities).length : 0,
        feedGranted: !!entry.feedGranted,
        grantedAt: entry.grantedAt || null,
        feedCount: entry.feeds ? Object.keys(entry.feeds).length : 0,
      };
    })
    .sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
}

function getEthereumWalletIdentityReferences(walletIndex) {
  if (typeof walletIndex !== 'number' || !Number.isInteger(walletIndex) || walletIndex < 0) {
    throw new Error('Wallet index must be a non-negative integer');
  }

  const store = loadFeeds();
  const references = [];
  for (const [origin, entry] of Object.entries(store.origins)) {
    if (!isPlainObject(entry?.identities)) continue;

    const feeds = isPlainObject(entry.feeds) ? entry.feeds : {};
    for (const identity of Object.values(entry.identities)) {
      if (identity?.mode !== ETHEREUM_WALLET_MODE || identity.walletIndex !== walletIndex) {
        continue;
      }

      const feedNames = Object.entries(feeds)
        .filter(([, feed]) => feed?.identityId === identity.id)
        .map(([feedName]) => feedName)
        .sort();
      const active = entry.activeIdentityId === identity.id;
      if (!active && feedNames.length === 0) {
        continue;
      }
      references.push({
        origin,
        identityId: identity.id,
        active,
        feedNames,
        feedCount: feedNames.length,
      });
    }
  }

  return references.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.origin.localeCompare(b.origin);
  });
}

/**
 * Check if an origin has feed identity metadata set.
 * This is NOT the same as "has feed permission" — identity metadata
 * survives permission revocation. The renderer must also check
 * swarm-permissions for active connection.
 * @param {string} origin
 * @returns {boolean}
 */
function hasIdentityMode(origin) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const entry = store.origins[key];
  return !!(entry && entry.activeIdentityId && getActiveIdentityFromEntry(entry));
}

/**
 * Check if an origin has an active feed grant.
 * Unlike hasIdentityMode, this is cleared on disconnect and must be
 * re-granted on reconnect through the feed approval prompt.
 * @param {string} origin
 * @returns {boolean}
 */
function hasFeedGrant(origin) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  const entry = store.origins[key];
  return !!(entry && entry.feedGranted);
}

/**
 * Whether the origin's active publisher identity is in the removed
 * ethereum-wallet mode (#89): stored, kept, and never granted again.
 * @param {string} origin
 * @returns {boolean}
 */
function hasUnavailableIdentity(origin) {
  const store = loadFeeds();
  const entry = store.origins[normalizeOrigin(origin)];
  return getActiveIdentityFromEntry(entry)?.mode === ETHEREUM_WALLET_MODE;
}

/**
 * Throws the removed mode's error when the origin's feed access can't be
 * granted: its active identity is a stored ethereum-wallet one. The user
 * has to switch identity first; nothing picks another owner for them.
 * @param {string} origin
 */
function assertFeedGrantable(origin) {
  if (hasUnavailableIdentity(origin)) {
    throw new Error(ETHEREUM_WALLET_UNAVAILABLE);
  }
}

/**
 * Grant feed access for an origin. Called after the feed approval prompt,
 * and by a permission manifest's projection. Refused, whoever asks, while
 * the active identity is a stored ethereum-wallet one (#89).
 * @param {string} origin
 * @param {{source?: string}} [options]
 */
function grantFeedAccess(origin, { source = 'user' } = {}) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  if (!store.origins[key]) return;
  assertFeedGrantable(key);
  store.origins[key].feedGranted = true;
  saveFeeds();
  if (source === 'user') notifyManifestMutation(key, 'feedGrant');
}

/**
 * Revoke feed access for an origin. Called on disconnect.
 * Identity metadata (identityMode, publisherKeyIndex, feeds) is preserved.
 * @param {string} origin
 * @param {{source?: string}} [options]
 */
function revokeFeedAccess(origin, { source = 'user' } = {}) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  if (!store.origins[key]) return;
  store.origins[key].feedGranted = false;
  saveFeeds();
  if (source === 'user') notifyManifestMutation(key, 'feedGrant');
}

/**
 * Register IPC handlers for feed store.
 */
function registerFeedStoreIpc() {
  ipcMain.handle(IPC.SWARM_GET_ALL_ORIGINS, () => {
    return getAllOriginEntries();
  });

  ipcMain.handle(IPC.SWARM_HAS_FEED_IDENTITY, (_event, origin) => {
    return hasIdentityMode(origin);
  });

  ipcMain.handle(IPC.SWARM_HAS_FEED_GRANT, (_event, origin) => {
    return hasFeedGrant(origin);
  });

  ipcMain.handle(IPC.SWARM_GET_IDENTITY_MODE, (_event, origin) => {
    const entry = getOriginEntry(origin);
    return entry?.identityMode || null;
  });

  ipcMain.handle(IPC.SWARM_GET_ORIGIN_IDENTITIES, async (_event, origin) => {
    return getOriginIdentityStateWithOwners(origin);
  });

  ipcMain.handle(IPC.SWARM_PREVIEW_APP_SCOPED_IDENTITY, async (_event, origin, options = {}) => {
    return previewAppScopedIdentity(origin, options);
  });

  // Everything arriving over IPC is a user action by definition: `source` is
  // forced here so a renderer cannot pass `{ source: 'manifest' }` and mutate
  // an origin's identity without detaching the manifest's claim on it.
  ipcMain.handle(IPC.SWARM_CREATE_APP_SCOPED_IDENTITY, async (_event, origin, options = {}) => {
    return withOriginLock(origin, async () => {
      createAppScopedIdentity(origin, { ...options, source: 'user' });
      return getOriginIdentityStateWithOwners(origin);
    });
  });

  ipcMain.handle(IPC.SWARM_ENSURE_ANT_WALLET_IDENTITY, async (_event, origin, options = {}) => {
    return withOriginLock(origin, async () => {
      ensureAntWalletIdentity(origin, { ...options, source: 'user' });
      return getOriginIdentityStateWithOwners(origin);
    });
  });

  ipcMain.handle(IPC.SWARM_ACTIVATE_FEED_IDENTITY, async (_event, origin, identityId) => {
    return withOriginLock(origin, async () => {
      activateIdentity(origin, identityId);
      return getOriginIdentityStateWithOwners(origin);
    });
  });

  // Idempotent for identity: if the origin already has an identity mode set,
  // return the existing entry without allocating a new key index.
  // Always grants feed access (feedGranted = true).
  ipcMain.handle(IPC.SWARM_SET_FEED_IDENTITY, (_event, origin, identityMode) => {
    return withOriginLock(origin, () => {
      if (identityMode === ETHEREUM_WALLET_MODE) {
        throw new Error(ETHEREUM_WALLET_UNAVAILABLE);
      }
      if (!VALID_IDENTITY_MODES.includes(identityMode)) {
        throw new Error(`Invalid identity mode: ${identityMode}. Must be one of: ${VALID_IDENTITY_MODES.join(', ')}`);
      }

      const existing = getOriginEntry(origin);
      // A stored ethereum-wallet identity is never granted again (#89).
      assertFeedGrantable(origin);
      if (existing && existing.activeIdentityId) {
        // Identity already set — just re-grant feed access
        if (!existing.feedGranted) {
          grantFeedAccess(origin);
        }
        return getOriginEntry(origin);
      }

      return setOriginEntry(origin, { identityMode, feedGranted: true });
    });
  });

  ipcMain.handle(IPC.SWARM_REVOKE_FEED_ACCESS, (_event, origin) => {
    return withOriginLock(origin, () => {
      revokeFeedAccess(origin);
      return true;
    });
  });

  log.info('[FeedStore] IPC handlers registered');
}

function _resetCache() {
  feedsCache = null;
}

module.exports = {
  getOriginEntry,
  setOriginEntry,
  allocatePublisherKeyIndex,
  getOriginIdentityState,
  getOriginIdentityStateWithOwners,
  previewAppScopedIdentity,
  createAppScopedIdentity,
  ensureAntWalletIdentity,
  activateIdentity,
  getFeed,
  setFeed,
  updateFeedReference,
  getAllFeeds,
  getAllOriginEntries,
  getEthereumWalletIdentityReferences,
  hasIdentityMode,
  hasUnavailableIdentity,
  assertFeedGrantable,
  hasFeedGrant,
  grantFeedAccess,
  revokeFeedAccess,
  onManifestMutation,
  registerFeedStoreIpc,
  VALID_IDENTITY_MODES,
  _resetCache,
};
