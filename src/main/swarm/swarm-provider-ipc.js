/**
 * Swarm Provider IPC — Main-Process Enforcement Layer
 *
 * The authority for all page-facing Swarm provider requests.
 * The renderer shows prompts and provides fast UX feedback, but this
 * module re-validates everything before executing.
 *
 * Single IPC handler: swarm:provider-execute
 *   Receives { method, params, origin } from renderer.
 *   Checks permissions, validates params, runs pre-flight, dispatches.
 *
 * Trust model for origin:
 *   The main process trusts the origin string from the renderer because:
 *   (a) The renderer is Freedom's own code, not arbitrary web content.
 *   (b) The renderer derives origin from the per-webview display URL
 *       (via getDisplayUrlForWebview), not from the page's window.location
 *       which is http://127.0.0.1:port for all dweb pages.
 *   (c) webContents.getURL() cannot be used because dweb pages resolve
 *       through the request-rewriter — the internal URL doesn't carry
 *       the dweb protocol identity (bzz://, ens://, ipfs://).
 *   The renderer is the only process that can map webview → tab → display URL.
 */

const { ipcMain } = require('electron');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { getPermission } = require('./swarm-permissions');
const { publishData, publishFilesFromContent, getUploadStatus } = require('./publish-service');
const { createFeed, updateFeed, buildTopicString } = require('./feed-service');
const { getOriginEntry, getFeed, setFeed, updateFeedReference, hasFeedGrant } = require('./feed-store');
const { addEntry, updateEntry } = require('./publish-history');
const { getBeeApiUrl } = require('../service-registry');
const { getDerivedKeys, getPublisherKey } = require('../identity-manager');
const { resetVaultAutoLockTimer } = require('../vault-timer');
const log = require('electron-log');

const LIMITS = {
  maxDataBytes: 10 * 1024 * 1024,    // 10 MB
  maxFilesBytes: 50 * 1024 * 1024,   // 50 MB
  maxFileCount: 100,
};

const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Origin not authorized' },
  UNSUPPORTED_METHOD: { code: 4200, message: 'Method not supported' },
  NODE_UNAVAILABLE: { code: 4900, message: 'Swarm node is not available' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid parameters' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

const KNOWN_METHODS = [
  'swarm_requestAccess',
  'swarm_getCapabilities',
  'swarm_publishData',
  'swarm_publishFiles',
  'swarm_getUploadStatus',
  'swarm_createFeed',
  'swarm_updateFeed',
];

// Tag ownership: tagUid → origin. Session-scoped, not persisted.
// Prevents cross-origin tag snooping via getUploadStatus.
const tagOwnership = new Map();

function clearTagOwnership() {
  tagOwnership.clear();
}

/**
 * Execute a Swarm provider method.
 * @param {string} method
 * @param {*} params
 * @param {string} origin - Normalized origin from renderer
 * @returns {{ result?, error? }}
 */
async function executeSwarmMethod(method, params, origin) {
  try {
    if (!method || typeof method !== 'string') {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'Method is required' } };
    }

    if (!KNOWN_METHODS.includes(method)) {
      return { error: { ...ERRORS.UNSUPPORTED_METHOD, message: `Unknown method: ${method}` } };
    }

    const normalizedOrigin = normalizeOrigin(origin);

    // swarm_requestAccess: verify the renderer already granted permission
    if (method === 'swarm_requestAccess') {
      return handleRequestAccess(normalizedOrigin);
    }

    // swarm_getCapabilities: no permission required (returns coarse info)
    if (method === 'swarm_getCapabilities') {
      return handleGetCapabilities(normalizedOrigin);
    }

    // All other methods require permission
    const permission = getPermission(normalizedOrigin);
    if (!permission) {
      return { error: { ...ERRORS.UNAUTHORIZED, message: 'Origin not authorized. Call swarm_requestAccess first.' } };
    }

    if (method === 'swarm_publishData') {
      const result = await handlePublishData(params, normalizedOrigin);
      if (result.result) resetVaultAutoLockTimer();
      return result;
    }

    if (method === 'swarm_publishFiles') {
      const result = await handlePublishFiles(params, normalizedOrigin);
      if (result.result) resetVaultAutoLockTimer();
      return result;
    }

    if (method === 'swarm_getUploadStatus') {
      return handleGetUploadStatus(params, normalizedOrigin);
    }

    if (method === 'swarm_createFeed') {
      const result = await handleCreateFeed(params, normalizedOrigin);
      if (result.result) resetVaultAutoLockTimer();
      return result;
    }

    if (method === 'swarm_updateFeed') {
      const result = await handleUpdateFeed(params, normalizedOrigin);
      if (result.result) resetVaultAutoLockTimer();
      return result;
    }

    return { error: ERRORS.INTERNAL_ERROR };
  } catch (err) {
    log.error('[SwarmProvider] executeSwarmMethod failed:', err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

function handleRequestAccess(origin) {
  const permission = getPermission(origin);
  if (!permission) {
    return { error: { ...ERRORS.UNAUTHORIZED, message: 'Permission not granted. Renderer should show prompt first.' } };
  }
  return { result: { connected: true, origin, capabilities: ['publish'] } };
}

async function handleGetCapabilities(origin) {
  const permission = getPermission(origin);
  const isConnected = !!permission;

  const preFlight = await checkSwarmPreFlight();

  return {
    result: {
      canPublish: isConnected && preFlight.ok,
      reason: !isConnected ? 'not-connected' : (preFlight.ok ? null : preFlight.reason),
      limits: {
        maxDataBytes: LIMITS.maxDataBytes,
        maxFilesBytes: LIMITS.maxFilesBytes,
        maxFileCount: LIMITS.maxFileCount,
      },
    },
  };
}

/**
 * Handle swarm_publishData: validate, enforce limits, publish via publish-service.
 */
async function handlePublishData(params, origin) {
  if (!params || typeof params !== 'object') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'params is required', data: { reason: 'invalid_params' } } };
  }

  const { data, contentType, name } = params;

  if (data === undefined || data === null) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'data is required', data: { reason: 'invalid_params' } } };
  }

  if (!contentType || typeof contentType !== 'string') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'contentType is required', data: { reason: 'missing_content_type' } } };
  }

  // Accept string or binary (Buffer, Uint8Array, ArrayBuffer, JSON-serialized Buffer).
  let payload = data;
  const isString = typeof payload === 'string';
  if (!isString) {
    payload = normalizeBytes(payload);
    if (!payload) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'data must be a string, Uint8Array, or ArrayBuffer', data: { reason: 'invalid_params' } } };
    }
  }

  // Enforce size limit on decoded content
  const size = isString ? Buffer.byteLength(payload, 'utf-8') : payload.length;
  if (size > LIMITS.maxDataBytes) {
    return {
      error: {
        ...ERRORS.INVALID_PARAMS,
        message: `Payload exceeds maximum size of ${LIMITS.maxDataBytes} bytes`,
        data: { reason: 'payload_too_large', limit: LIMITS.maxDataBytes, actual: size },
      },
    };
  }

  // Pre-flight check
  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  // Record history entry before upload
  const historyEntry = addEntry({
    type: 'data',
    name: name || 'Published data',
    status: 'uploading',
  });

  try {
    const result = await publishData(payload, {
      contentType,
      name: name || undefined,
    });

    updateEntry(historyEntry.id, { status: 'completed', ...result });
    log.info(`[SwarmProvider] publishData succeeded for ${origin}: ${result.bzzUrl}`);

    return { result: { reference: result.reference, bzzUrl: result.bzzUrl } };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed' });
    log.error(`[SwarmProvider] publishData failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Validate a virtual path for manifest inclusion.
 * @returns {{ valid: boolean, message?: string }}
 */
function validateVirtualPath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    return { valid: false, message: 'Path must be a non-empty string' };
  }
  if (p.length > 256) {
    return { valid: false, message: 'Path exceeds 256 characters' };
  }
  if (p.includes('\\')) {
    return { valid: false, message: 'Backslashes are not allowed' };
  }
  if (p.startsWith('/')) {
    return { valid: false, message: 'Leading slash is not allowed' };
  }
  // Check for control characters and null bytes
  for (let i = 0; i < p.length; i++) {
    if (p.charCodeAt(i) < 32) {
      return { valid: false, message: 'Control characters are not allowed' };
    }
  }
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '') {
      return { valid: false, message: 'Empty path segments are not allowed' };
    }
    if (seg === '.' || seg === '..') {
      return { valid: false, message: '"." and ".." segments are not allowed' };
    }
  }
  return { valid: true };
}

/**
 * Normalize bytes from IPC — handles Buffer, Uint8Array, ArrayBuffer,
 * and the JSON-serialized { type: 'Buffer', data: [...] } form.
 * Returns Buffer or null if invalid.
 */
function normalizeBytes(bytes) {
  if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }
  if (bytes instanceof ArrayBuffer) {
    return Buffer.from(bytes);
  }
  // IPC sometimes serializes Buffer as { type: 'Buffer', data: [...] }
  if (bytes && typeof bytes === 'object' && bytes.type === 'Buffer' && Array.isArray(bytes.data)) {
    return Buffer.from(bytes.data);
  }
  return null;
}

/**
 * Handle swarm_publishFiles: validate, enforce limits, write to temp dir, publish.
 */
async function handlePublishFiles(params, origin) {
  if (!params || typeof params !== 'object') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'params is required', data: { reason: 'invalid_params' } } };
  }

  const { files, indexDocument } = params;

  if (!Array.isArray(files) || files.length === 0) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'files must be a non-empty array', data: { reason: 'empty_files' } } };
  }

  if (files.length > LIMITS.maxFileCount) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: `File count exceeds maximum of ${LIMITS.maxFileCount}`, data: { reason: 'too_many_files', limit: LIMITS.maxFileCount, actual: files.length } } };
  }

  const seenPaths = new Set();
  let totalSize = 0;
  const normalizedFiles = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file || typeof file !== 'object') {
      return { error: { ...ERRORS.INVALID_PARAMS, message: `files[${i}] is not a valid file object`, data: { reason: 'invalid_params' } } };
    }

    const pathResult = validateVirtualPath(file.path);
    if (!pathResult.valid) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: `files[${i}].path: ${pathResult.message}`, data: { reason: 'invalid_path' } } };
    }

    if (seenPaths.has(file.path)) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: `Duplicate path: ${file.path}`, data: { reason: 'duplicate_path', path: file.path } } };
    }
    seenPaths.add(file.path);

    const bytes = normalizeBytes(file.bytes);
    if (!bytes) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: `files[${i}].bytes must be a Buffer, Uint8Array, or ArrayBuffer`, data: { reason: 'invalid_params' } } };
    }

    totalSize += bytes.length;
    normalizedFiles.push({
      path: file.path,
      bytes,
      contentType: typeof file.contentType === 'string' ? file.contentType : undefined,
    });
  }

  if (totalSize > LIMITS.maxFilesBytes) {
    return {
      error: {
        ...ERRORS.INVALID_PARAMS,
        message: `Total size exceeds maximum of ${LIMITS.maxFilesBytes} bytes`,
        data: { reason: 'payload_too_large', limit: LIMITS.maxFilesBytes, actual: totalSize },
      },
    };
  }

  if (indexDocument !== undefined && indexDocument !== null) {
    if (typeof indexDocument !== 'string' || !seenPaths.has(indexDocument)) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'indexDocument must match an existing file path', data: { reason: 'invalid_index_document' } } };
    }
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  const historyEntry = addEntry({
    type: 'directory',
    name: indexDocument || `${normalizedFiles.length} files`,
    status: 'uploading',
  });

  try {
    const result = await publishFilesFromContent(normalizedFiles, { indexDocument });

    if (result.tagUid) {
      tagOwnership.set(result.tagUid, origin);
    }

    updateEntry(historyEntry.id, { status: 'completed', ...result });
    log.info(`[SwarmProvider] publishFiles succeeded for ${origin}: ${result.bzzUrl} (${normalizedFiles.length} files)`);

    return { result: { reference: result.reference, bzzUrl: result.bzzUrl, tagUid: result.tagUid } };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed' });
    log.error(`[SwarmProvider] publishFiles failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_getUploadStatus: origin-scoped tag progress query.
 */
async function handleGetUploadStatus(params, origin) {
  if (!params || typeof params !== 'object') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'params is required', data: { reason: 'invalid_params' } } };
  }

  const { tagUid } = params;

  if (typeof tagUid !== 'number' || !Number.isInteger(tagUid) || tagUid <= 0) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'tagUid must be a positive integer', data: { reason: 'invalid_params' } } };
  }

  const owner = tagOwnership.get(tagUid);
  if (!owner || owner !== origin) {
    return { error: { ...ERRORS.UNAUTHORIZED, message: 'Tag not found or not owned by this origin' } };
  }

  try {
    const status = await getUploadStatus(tagUid);
    // Clean up completed tags to prevent unbounded map growth
    if (status.done) {
      tagOwnership.delete(tagUid);
    }
    return { result: status };
  } catch (err) {
    log.error(`[SwarmProvider] getUploadStatus failed for tag ${tagUid}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Validate a feed name.
 * @returns {{ valid: boolean, message?: string }}
 */
function validateFeedName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { valid: false, message: 'Feed name must be a non-empty string' };
  }
  if (name.length > 64) {
    return { valid: false, message: 'Feed name exceeds 64 characters' };
  }
  if (name.includes('/')) {
    return { valid: false, message: 'Feed name must not contain "/"' };
  }
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 32) {
      return { valid: false, message: 'Feed name must not contain control characters' };
    }
  }
  return { valid: true };
}

/**
 * Resolve the signer private key for an origin based on its identity mode.
 * @param {Object} originEntry - Origin entry from feed-store (must have identityMode set)
 * @returns {Promise<string>} 0x-prefixed hex private key
 */
async function resolveSignerKey(originEntry) {
  if (originEntry.identityMode === 'bee-wallet') {
    const keys = getDerivedKeys();
    if (!keys) {
      throw new Error('Vault is locked');
    }
    return keys.beeWallet.privateKey;
  }

  if (originEntry.identityMode === 'app-scoped') {
    const publisherKey = await getPublisherKey(originEntry.publisherKeyIndex);
    return publisherKey.privateKey;
  }

  throw new Error(`Unknown identity mode: ${originEntry.identityMode}`);
}

/**
 * Handle swarm_createFeed: validate, check capability, create feed + manifest.
 */
async function handleCreateFeed(params, origin) {
  if (!params || typeof params !== 'object') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'params is required', data: { reason: 'invalid_params' } } };
  }

  const { name } = params;
  const nameResult = validateFeedName(name);
  if (!nameResult.valid) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: nameResult.message, data: { reason: 'invalid_feed_name' } } };
  }

  // Feed capability = connection permission (already checked by caller) + active feed grant
  if (!hasFeedGrant(origin)) {
    return { error: { ...ERRORS.UNAUTHORIZED, message: 'Feed access not granted. Renderer should show feed prompt first.', data: { reason: 'feed_not_granted' } } };
  }

  const originEntry = getOriginEntry(origin);

  // Idempotent: if feed already exists, return existing metadata
  const existingFeed = getFeed(origin, name);
  if (existingFeed) {
    return {
      result: {
        feedId: name,
        owner: existingFeed.owner,
        topic: existingFeed.topic,
        manifestReference: existingFeed.manifestReference,
        bzzUrl: `bzz://${existingFeed.manifestReference}`,
        identityMode: originEntry.identityMode,
      },
    };
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  let signerKey;
  try {
    signerKey = await resolveSignerKey(originEntry);
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }

  const topicString = buildTopicString(origin, name);

  const historyEntry = addEntry({
    type: 'feed-create',
    name,
    status: 'uploading',
  });

  try {
    const result = await createFeed(signerKey, topicString);

    setFeed(origin, name, {
      topic: result.topic,
      owner: result.owner,
      manifestReference: result.manifestReference,
    });

    updateEntry(historyEntry.id, { status: 'completed', ...result });

    log.info(`[SwarmProvider] createFeed succeeded for ${origin}: feed=${name}, bzzUrl=${result.bzzUrl}`);

    return {
      result: {
        feedId: name,
        owner: result.owner,
        topic: result.topic,
        manifestReference: result.manifestReference,
        bzzUrl: result.bzzUrl,
        identityMode: originEntry.identityMode,
      },
    };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed' });
    log.error(`[SwarmProvider] createFeed failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_updateFeed: validate, check capability, update feed reference.
 */
async function handleUpdateFeed(params, origin) {
  if (!params || typeof params !== 'object') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'params is required', data: { reason: 'invalid_params' } } };
  }

  const { feedId, reference } = params;

  if (!feedId || typeof feedId !== 'string') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'feedId is required', data: { reason: 'invalid_params' } } };
  }

  if (!reference || typeof reference !== 'string' || !/^[0-9a-fA-F]{64}$/.test(reference)) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'reference must be a 64-character hex string', data: { reason: 'invalid_reference' } } };
  }

  if (!hasFeedGrant(origin)) {
    return { error: { ...ERRORS.UNAUTHORIZED, message: 'Feed access not granted.', data: { reason: 'feed_not_granted' } } };
  }

  const originEntry = getOriginEntry(origin);

  const existingFeed = getFeed(origin, feedId);
  if (!existingFeed) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: `Feed not found: ${feedId}`, data: { reason: 'feed_not_found' } } };
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  let signerKey;
  try {
    signerKey = await resolveSignerKey(originEntry);
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }

  const topicString = buildTopicString(origin, feedId);

  const historyEntry = addEntry({
    type: 'feed-update',
    name: feedId,
    status: 'uploading',
  });

  try {
    await updateFeed(signerKey, topicString, reference);

    updateFeedReference(origin, feedId, reference);
    updateEntry(historyEntry.id, { status: 'completed', reference });

    log.info(`[SwarmProvider] updateFeed succeeded for ${origin}: feed=${feedId}, ref=${reference}`);

    return {
      result: {
        feedId,
        reference,
        bzzUrl: `bzz://${existingFeed.manifestReference}`,
      },
    };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed' });
    log.error(`[SwarmProvider] updateFeed failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Pre-flight check: is Bee running, in light mode, with usable stamps?
 * @returns {{ ok: boolean, reason?: string }}
 */
async function checkSwarmPreFlight() {
  try {
    const beeUrl = getBeeApiUrl();
    if (!beeUrl) {
      return { ok: false, reason: 'node-stopped' };
    }

    // Check node mode
    const nodeRes = await fetch(`${beeUrl}/node`);
    if (!nodeRes.ok) {
      return { ok: false, reason: 'node-stopped' };
    }
    const nodeData = await nodeRes.json();
    const beeMode = nodeData.beeMode || '';
    if (beeMode === 'ultra-light' || beeMode === 'ultralight') {
      return { ok: false, reason: 'ultra-light-mode' };
    }

    // Check readiness
    const readinessRes = await fetch(`${beeUrl}/readiness`);
    if (!readinessRes.ok) {
      return { ok: false, reason: 'node-not-ready' };
    }

    // Check for usable stamps
    const stampsRes = await fetch(`${beeUrl}/stamps`);
    if (!stampsRes.ok) {
      return { ok: false, reason: 'no-usable-stamps' };
    }
    const stampsData = await stampsRes.json();
    const stamps = Array.isArray(stampsData.stamps) ? stampsData.stamps : [];
    const usable = stamps.filter((s) => s.usable === true);
    if (usable.length === 0) {
      return { ok: false, reason: 'no-usable-stamps' };
    }

    return { ok: true };
  } catch (err) {
    log.error('[SwarmProvider] Pre-flight check failed:', err.message);
    return { ok: false, reason: 'node-stopped' };
  }
}

/**
 * Register the swarm:provider-execute IPC handler.
 */
function registerSwarmProviderIpc() {
  ipcMain.handle(IPC.SWARM_PROVIDER_EXECUTE, async (_event, args) => {
    const { method, params, origin } = args || {};
    return executeSwarmMethod(method, params, origin);
  });

  log.info('[SwarmProvider] IPC handler registered');
}

module.exports = {
  registerSwarmProviderIpc,
  executeSwarmMethod,
  checkSwarmPreFlight,
  validateVirtualPath,
  validateFeedName,
  clearTagOwnership,
  LIMITS,
};
