/**
 * Feed Metadata Store
 *
 * Persists per-origin feed identity and feed state. Separate from
 * swarm-permissions.js — this is identity/feed metadata, not
 * connection permission state.
 *
 * Data model:
 *   { version, nextPublisherKeyIndex, origins: { [origin]: { identityMode, publisherKeyIndex, feeds } } }
 *
 * Identity mode is chosen once per origin at first feed grant:
 *   - 'bee-wallet': uses the Bee node wallet key for signing
 *   - 'app-scoped': uses a dedicated publisher key derived at m/44'/73406'/{index}'/0/0
 *
 * Survives permission revocation — revoking Swarm connection does not
 * forget the publisher identity. Only an explicit reset changes it.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const log = require('electron-log');

const FEEDS_FILE = 'swarm-feeds.json';
const CURRENT_VERSION = 1;

const VALID_IDENTITY_MODES = ['bee-wallet', 'app-scoped'];

let feedsCache = null;

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

function loadFeeds() {
  if (feedsCache !== null) {
    return feedsCache;
  }

  try {
    const filePath = getFeedsPath();
    if (fs.existsSync(filePath)) {
      feedsCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      feedsCache = createEmptyStore();
    }
  } catch (err) {
    log.error('[FeedStore] Failed to load feeds:', err.message);
    feedsCache = createEmptyStore();
  }

  return feedsCache;
}

function saveFeeds() {
  try {
    const filePath = getFeedsPath();
    fs.writeFileSync(filePath, JSON.stringify(feedsCache, null, 2), 'utf-8');
  } catch (err) {
    log.error('[FeedStore] Failed to save feeds:', err.message);
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
  const feedsCopy = {};
  if (entry.feeds) {
    for (const [name, feed] of Object.entries(entry.feeds)) {
      feedsCopy[name] = { ...feed };
    }
  }
  return { ...entry, feeds: feedsCopy };
}

/**
 * Create or update an origin entry with identity mode and key index.
 * Called once when the user first grants feed access to an origin.
 * @param {string} origin
 * @param {{ identityMode: string, publisherKeyIndex?: number }} data
 * @returns {Object} The origin entry
 */
function setOriginEntry(origin, data) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);

  const existing = store.origins[key] || {};
  store.origins[key] = {
    ...existing,
    identityMode: data.identityMode,
    publisherKeyIndex: data.publisherKeyIndex ?? existing.publisherKeyIndex ?? null,
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
  const index = store.nextPublisherKeyIndex;
  store.nextPublisherKeyIndex = index + 1;
  saveFeeds();
  return index;
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
    .filter(([, entry]) => entry.identityMode)
    .map(([origin, entry]) => ({
      origin,
      identityMode: entry.identityMode,
      publisherKeyIndex: entry.publisherKeyIndex ?? null,
      feedGranted: !!entry.feedGranted,
      grantedAt: entry.grantedAt || null,
      feedCount: entry.feeds ? Object.keys(entry.feeds).length : 0,
    }))
    .sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
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
  return !!(entry && entry.identityMode);
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
 * Grant feed access for an origin. Called after the feed approval prompt.
 * @param {string} origin
 */
function grantFeedAccess(origin) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  if (!store.origins[key]) return;
  store.origins[key].feedGranted = true;
  saveFeeds();
}

/**
 * Revoke feed access for an origin. Called on disconnect.
 * Identity metadata (identityMode, publisherKeyIndex, feeds) is preserved.
 * @param {string} origin
 */
function revokeFeedAccess(origin) {
  const store = loadFeeds();
  const key = normalizeOrigin(origin);
  if (!store.origins[key]) return;
  store.origins[key].feedGranted = false;
  saveFeeds();
}

/**
 * Register IPC handlers for feed store.
 */
function registerFeedStoreIpc() {
  ipcMain.handle(IPC.SWARM_GET_ORIGIN_FEEDS, (_event, origin) => {
    return getAllFeeds(origin);
  });

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

  // Idempotent for identity: if the origin already has an identity mode set,
  // return the existing entry without allocating a new key index.
  // Always grants feed access (feedGranted = true).
  ipcMain.handle(IPC.SWARM_SET_FEED_IDENTITY, (_event, origin, identityMode) => {
    if (!VALID_IDENTITY_MODES.includes(identityMode)) {
      throw new Error(`Invalid identity mode: ${identityMode}. Must be one of: ${VALID_IDENTITY_MODES.join(', ')}`);
    }

    const existing = getOriginEntry(origin);
    if (existing && existing.identityMode) {
      // Identity already set — just re-grant feed access
      if (!existing.feedGranted) {
        grantFeedAccess(origin);
      }
      return getOriginEntry(origin);
    }

    let publisherKeyIndex = null;
    if (identityMode === 'app-scoped') {
      publisherKeyIndex = allocatePublisherKeyIndex();
    }
    return setOriginEntry(origin, { identityMode, publisherKeyIndex, feedGranted: true });
  });

  ipcMain.handle(IPC.SWARM_REVOKE_FEED_ACCESS, (_event, origin) => {
    revokeFeedAccess(origin);
    return true;
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
  getFeed,
  setFeed,
  updateFeedReference,
  getAllFeeds,
  getAllOriginEntries,
  hasIdentityMode,
  hasFeedGrant,
  grantFeedAccess,
  revokeFeedAccess,
  registerFeedStoreIpc,
  VALID_IDENTITY_MODES,
  _resetCache,
};
