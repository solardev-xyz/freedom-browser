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
const { createFeed, updateFeed, writeFeedPayload, readFeedPayload, buildTopicString } = require('./feed-service');
const { Topic } = require('@ethersphere/bee-js');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');
const { getOriginEntry, getFeed, setFeed, updateFeedReference, hasFeedGrant, getAllFeeds } = require('./feed-store');
const {
  publishChunk,
  readChunk,
  writeSingleOwnerChunk,
  readSingleOwnerChunk,
  getSignerAddress,
} = require('./chunk-service');
const { addEntry, updateEntry } = require('./publish-history');
const { getBeeApiUrl } = require('../service-registry');
const { getDerivedKeys, getPublisherKey, getUserWalletKey } = require('../identity-manager');
const { resetVaultAutoLockTimer } = require('../vault-timer');
const log = require('electron-log');

const LIMITS = {
  maxDataBytes: 10 * 1024 * 1024,    // 10 MB
  maxFilesBytes: 50 * 1024 * 1024,   // 50 MB
  maxFileCount: 100,
  maxPathBytes: 100,
  maxChunkPayloadBytes: 4096,
  maxApiBodyBytes: 50 * 1024 * 1024, // 50 MB — swarm_apiRequest req/resp body cap
  maxApiHeaders: 30,
  maxApiHeaderLen: 8192,
};

// swarm_apiRequest: which Bee HTTP API endpoints a connected dApp may reach
// through the passthrough. ALLOW-LIST by first path segment — anything not
// listed is denied. Deliberately EXCLUDES node-wallet / chequebook / staking /
// network-admin endpoints (they move funds or reconfigure the node and must
// never be reachable from web content). Covers the data + postage + pss surface
// a dApp legitimately needs (matches the bee-js client's usage).
const ALLOWED_API_SEGMENTS = new Set([
  'health', 'readiness', 'node', 'addresses',
  'stamps', 'batches',
  'bzz', 'bytes', 'chunks', 'soc', 'feeds',
  'tags', 'pins', 'pss', 'stewardship', 'gsoc',
]);
const ALLOWED_API_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'HEAD']);
// Request headers we never forward (the node/fetch owns these).
const BLOCKED_API_HEADERS = new Set(['host', 'content-length', 'connection', 'origin', 'referer', 'cookie']);
// Response content-types returned as utf8 text (else base64).
const TEXTUAL_CONTENT_TYPE = /^(application\/(json|.*\+json|xml|javascript|x-www-form-urlencoded)|text\/)/i;

const SPEC_VERSION = '1.0';
const MAX_U64 = (1n << 64n) - 1n;

const READ_BUDGETS = {
  connected: {
    windowMs: 60_000,
    maxRequests: 600,
    maxBytes: 5 * 1024 * 1024,
  },
  anonymous: {
    windowMs: 60_000,
    maxRequests: 120,
    maxBytes: 512 * 1024,
  },
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
  'swarm_writeFeedEntry',
  'swarm_readFeedEntry',
  'swarm_listFeeds',
  'swarm_publishChunk',
  'swarm_readChunk',
  'swarm_writeSingleOwnerChunk',
  'swarm_readSingleOwnerChunk',
  'swarm_getSigningIdentity',
  'swarm_apiRequest',
];

// Tag ownership: tagUid → origin. Session-scoped, not persisted.
// Prevents cross-origin tag snooping via getUploadStatus.
const tagOwnership = new Map();
const permissionFreeReadBuckets = new Map();

function clearTagOwnership() {
  tagOwnership.clear();
}

function clearPermissionFreeReadBudgets() {
  permissionFreeReadBuckets.clear();
}

function invalidParams(message, reason = 'invalid_params', extra = {}) {
  return {
    error: {
      ...ERRORS.INVALID_PARAMS,
      message,
      data: { reason, ...extra },
    },
  };
}

function notAuthorized(reason) {
  return {
    error: {
      ...ERRORS.UNAUTHORIZED,
      message: 'The origin is not authorized for this operation',
      data: { reason },
    },
  };
}

function notConnected() {
  return notAuthorized('not_connected');
}

function feedNotGranted() {
  return notAuthorized('feed_not_granted');
}

function validateEmptyOptions(options) {
  if (options === undefined || options === null) return null;
  if (typeof options !== 'object' || Array.isArray(options)) {
    return invalidParams('options must be an object', 'invalid_params');
  }
  const keys = Object.keys(options);
  if (keys.length > 0) {
    return invalidParams(`Unsupported option: ${keys[0]}`, 'unsupported_option', { option: keys[0] });
  }
  return null;
}

function validateHexString(value, bytes, reason, field, options = {}) {
  const chars = bytes * 2;
  if (typeof value !== 'string') {
    return invalidParams(`${field} must be a ${chars}-character hex string`, reason);
  }
  if (!options.allow0xPrefix && value.startsWith('0x')) {
    return invalidParams(`${field} must be a ${chars}-character hex string`, reason);
  }
  const normalized = options.allow0xPrefix ? value.replace(/^0x/, '') : value;
  if (normalized.length !== chars || !/^[0-9a-fA-F]+$/.test(normalized)) {
    return invalidParams(`${field} must be a ${chars}-character hex string`, reason);
  }
  return null;
}

function normalizeAddress(address) {
  // Ethereum owners conventionally include 0x; Swarm refs and identifiers do not.
  return typeof address === 'string' ? address.replace(/^0x/, '') : '';
}

function validateSpan(span) {
  if (span === undefined || span === null) return { ok: true, value: undefined };
  if (typeof span === 'number') {
    if (!Number.isInteger(span) || span < 0 || !Number.isSafeInteger(span)) {
      return { ok: false };
    }
    return { ok: true, value: BigInt(span) };
  }
  if (typeof span === 'bigint') {
    if (span < 0n || span > MAX_U64) return { ok: false };
    return { ok: true, value: span };
  }
  return { ok: false };
}

function normalizePayloadParam(data) {
  if (data === undefined || data === null) return null;
  if (typeof data === 'string') return Buffer.from(data, 'utf-8');
  return normalizeBytes(data);
}

function validateChunkPayload(data) {
  const payload = normalizePayloadParam(data);
  if (!payload) {
    return {
      error: invalidParams('data must be a string, Uint8Array, or ArrayBuffer').error,
      payload: null,
    };
  }
  if (payload.length === 0) {
    // Bee rejects empty chunks; fail before prompting or spending postage.
    return {
      error: invalidParams('data must not be empty', 'invalid_params').error,
      payload: null,
    };
  }
  if (payload.length > LIMITS.maxChunkPayloadBytes) {
    return {
      error: invalidParams(
        `Payload exceeds maximum chunk size of ${LIMITS.maxChunkPayloadBytes} bytes`,
        'payload_too_large',
        { limit: LIMITS.maxChunkPayloadBytes, actual: payload.length }
      ).error,
      payload: null,
    };
  }
  return { payload, error: null };
}

function getReadBudget(origin) {
  return getPermission(origin) ? READ_BUDGETS.connected : READ_BUDGETS.anonymous;
}

function consumePermissionFreeReadBudget(origin, { requests = 0, bytes = 0 } = {}) {
  const budget = getReadBudget(origin);
  const now = Date.now();
  const existing = permissionFreeReadBuckets.get(origin);
  const bucket = existing && now - existing.startedAt < budget.windowMs
    ? existing
    : { startedAt: now, requests: 0, bytes: 0 };

  bucket.requests += requests;
  bucket.bytes += bytes;
  permissionFreeReadBuckets.set(origin, bucket);

  if (bucket.requests > budget.maxRequests || bucket.bytes > budget.maxBytes) {
    return invalidParams('Permission-free read budget exceeded', 'rate_limited', {
      windowMs: budget.windowMs,
      maxRequests: budget.maxRequests,
      maxBytes: budget.maxBytes,
    });
  }
  return null;
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

    if (method === 'swarm_readChunk') {
      return handleReadChunk(params, normalizedOrigin);
    }

    if (method === 'swarm_readSingleOwnerChunk') {
      return handleReadSingleOwnerChunk(params, normalizedOrigin);
    }

    // swarm_readFeedEntry: no permission required. Feeds are public Swarm
    // data — any origin can read them via any Bee gateway without auth.
    // Gating this behind connection permission would force unnecessary
    // prompts for passive use cases (e.g. profile pages displaying other
    // users' activity feeds discovered on-chain).
    if (method === 'swarm_readFeedEntry') {
      return handleReadFeedEntry(params, normalizedOrigin);
    }

    // swarm_listFeeds: no permission required. Returns the feed metadata
    // this origin has accumulated via createFeed. Feed coordinates are
    // deterministic given (origin, name), so listing them isn't a leak;
    // and the metadata is preserved across permission revocation by design
    // (so a re-granted origin sees its prior feeds), so requiring permission
    // here would just be friction without security benefit.
    if (method === 'swarm_listFeeds') {
      return handleListFeeds(normalizedOrigin);
    }

    // All other methods require permission
    const permission = getPermission(normalizedOrigin);
    if (!permission) {
      return notConnected();
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

    if (method === 'swarm_publishChunk') {
      const result = await handlePublishChunk(params, normalizedOrigin);
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

    if (method === 'swarm_writeFeedEntry') {
      const result = await handleWriteFeedEntry(params, normalizedOrigin);
      if (result.result) resetVaultAutoLockTimer();
      return result;
    }

    if (method === 'swarm_writeSingleOwnerChunk') {
      const result = await handleWriteSingleOwnerChunk(params, normalizedOrigin);
      if (result.result) resetVaultAutoLockTimer();
      return result;
    }

    if (method === 'swarm_getSigningIdentity') {
      const result = await handleGetSigningIdentity(normalizedOrigin);
      if (result.result) resetVaultAutoLockTimer();
      return result;
    }

    if (method === 'swarm_apiRequest') {
      return handleApiRequest(params, normalizedOrigin);
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
    return notConnected();
  }
  return { result: { connected: true, origin, capabilities: ['publish'] } };
}

async function handleGetCapabilities(origin) {
  const permission = getPermission(origin);
  const isConnected = !!permission;

  const preFlight = await checkSwarmPreFlight();

  return {
    result: {
      specVersion: SPEC_VERSION,
      canPublish: isConnected && preFlight.ok,
      reason: !isConnected ? 'not-connected' : (preFlight.ok ? null : preFlight.reason),
      publisherIdentityModes: ['app-scoped', 'bee-wallet', 'ethereum-wallet'],
      extensions: {
        ethereumWalletPublisherIdentity: true,
        publisherSigning: true,
      },
      limits: {
        maxDataBytes: LIMITS.maxDataBytes,
        maxFilesBytes: LIMITS.maxFilesBytes,
        maxFileCount: LIMITS.maxFileCount,
        maxPathBytes: LIMITS.maxPathBytes,
        maxChunkPayloadBytes: LIMITS.maxChunkPayloadBytes,
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

  // Record history entry before upload. bytesSize is populated here (not only
  // on the success-path update) so failed rows also carry payload size.
  const historyEntry = addEntry({
    type: 'data',
    name: name || 'Published data',
    status: 'uploading',
    origin,
    bytesSize: size,
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
    updateEntry(historyEntry.id, { status: 'failed', errorMessage: err.message });
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
  const pathBytes = Buffer.byteLength(p, 'utf-8');
  if (pathBytes > LIMITS.maxPathBytes) {
    return { valid: false, message: `Path exceeds ${LIMITS.maxPathBytes} UTF-8 bytes` };
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
    origin,
    bytesSize: totalSize,
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
    updateEntry(historyEntry.id, { status: 'failed', errorMessage: err.message });
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
    return notAuthorized('tag_ownership_mismatch');
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

function mapChunkReadError(err) {
  // Only semantic chunk-read failures become invalid params. Bee 5xx/timeouts
  // must remain internal/transient errors so callers can distinguish them.
  if (err.reason === 'chunk_not_found' || err.reason === 'chunk_type_mismatch') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: err.message, data: { reason: err.reason } } };
  }
  return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
}

/**
 * Handle swarm_publishChunk: validate one CAC payload and publish it.
 */
async function handlePublishChunk(params, origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const optionsError = validateEmptyOptions(params.options);
  if (optionsError) return optionsError;

  const { payload, error } = validateChunkPayload(params.data);
  if (error) return { error };

  const span = validateSpan(params.span);
  if (!span.ok) {
    return invalidParams('span must be a non-negative unsigned 64-bit integer', 'invalid_span');
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  const historyEntry = addEntry({
    type: 'chunk',
    name: 'CAC chunk',
    status: 'uploading',
    origin,
    bytesSize: payload.length,
  });

  try {
    const result = await publishChunk(payload, { span: span.value });
    updateEntry(historyEntry.id, {
      status: 'completed',
      reference: result.reference,
      batchIdUsed: result.batchIdUsed,
    });
    return { result: { reference: result.reference } };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed', errorMessage: err.message });
    log.error(`[SwarmProvider] publishChunk failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_readChunk: permission-free CAC read with type validation.
 */
async function handleReadChunk(params, origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const optionsError = validateEmptyOptions(params.options);
  if (optionsError) return optionsError;

  const referenceError = validateHexString(params.reference, 32, 'invalid_reference', 'reference');
  if (referenceError) return referenceError;

  const budgetError = consumePermissionFreeReadBudget(origin, { requests: 1 });
  if (budgetError) return budgetError;

  const reachable = await checkBeeReachable();
  if (!reachable.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${reachable.reason}`, data: { reason: reachable.reason } } };
  }

  try {
    const result = await readChunk(params.reference);
    const byteBudgetError = consumePermissionFreeReadBudget(origin, {
      bytes: Buffer.byteLength(result.data, 'base64'),
    });
    if (byteBudgetError) return byteBudgetError;
    return { result };
  } catch (err) {
    log.error(`[SwarmProvider] readChunk failed for ${origin}:`, err.message);
    return mapChunkReadError(err);
  }
}

/**
 * Handle swarm_writeSingleOwnerChunk: sign and publish an SOC.
 */
async function handleWriteSingleOwnerChunk(params, origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const optionsError = validateEmptyOptions(params.options);
  if (optionsError) return optionsError;

  const identifierError = validateHexString(params.identifier, 32, 'invalid_identifier', 'identifier');
  if (identifierError) return identifierError;

  const { payload, error } = validateChunkPayload(params.data);
  if (error) return { error };

  const span = validateSpan(params.span);
  if (!span.ok) {
    return invalidParams('span must be a non-negative unsigned 64-bit integer', 'invalid_span');
  }

  if (!hasFeedGrant(origin)) {
    return feedNotGranted();
  }

  const originEntry = getOriginEntry(origin);
  const activeIdentity = getActiveOriginIdentity(originEntry);
  let signerKey;
  try {
    signerKey = await resolveSignerKey(activeIdentity);
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  const historyEntry = addEntry({
    type: 'soc',
    name: 'SOC chunk',
    status: 'uploading',
    origin,
    bytesSize: payload.length,
  });

  try {
    const result = await writeSingleOwnerChunk(signerKey, params.identifier, payload, { span: span.value });
    updateEntry(historyEntry.id, {
      status: 'completed',
      reference: result.reference,
      batchIdUsed: result.batchIdUsed,
    });
    return {
      result: {
        reference: result.reference,
        owner: result.owner,
        identifier: result.identifier,
      },
    };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed', errorMessage: err.message });
    log.error(`[SwarmProvider] writeSingleOwnerChunk failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_readSingleOwnerChunk: permission-free SOC read.
 */
async function handleReadSingleOwnerChunk(params, origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const optionsError = validateEmptyOptions(params.options);
  if (optionsError) return optionsError;

  const hasAddress = params.address !== undefined && params.address !== null;
  const hasOwner = params.owner !== undefined && params.owner !== null;
  const hasIdentifier = params.identifier !== undefined && params.identifier !== null;

  if (hasAddress && (hasOwner || hasIdentifier)) {
    return invalidParams('Provide either address, or owner + identifier, not both');
  }
  if (!hasAddress && (!hasOwner || !hasIdentifier)) {
    return invalidParams('Either address, or owner + identifier, is required');
  }

  if (hasAddress) {
    const addressError = validateHexString(params.address, 32, 'invalid_reference', 'address');
    if (addressError) return addressError;
  } else {
    const owner = normalizeAddress(params.owner);
    if (!/^[0-9a-fA-F]{40}$/.test(owner)) {
      return invalidParams('owner must be a valid 40-character hex address', 'invalid_owner');
    }
    const identifierError = validateHexString(params.identifier, 32, 'invalid_identifier', 'identifier');
    if (identifierError) return identifierError;
  }

  const budgetError = consumePermissionFreeReadBudget(origin, { requests: 1 });
  if (budgetError) return budgetError;

  const reachable = await checkBeeReachable();
  if (!reachable.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${reachable.reason}`, data: { reason: reachable.reason } } };
  }

  try {
    const result = await readSingleOwnerChunk(params);
    const byteBudgetError = consumePermissionFreeReadBudget(origin, {
      bytes: Buffer.byteLength(result.data, 'base64'),
    });
    if (byteBudgetError) return byteBudgetError;
    return { result };
  } catch (err) {
    log.error(`[SwarmProvider] readSingleOwnerChunk failed for ${origin}:`, err.message);
    return mapChunkReadError(err);
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
 * Return the active identity from an origin entry. Falls back to the
 * compatibility fields returned by older tests/mocks.
 * @param {Object} originEntry
 * @returns {Object|null}
 */
function getActiveOriginIdentity(originEntry) {
  if (!originEntry) return null;
  if (originEntry.activeIdentityId && originEntry.identities?.[originEntry.activeIdentityId]) {
    return originEntry.identities[originEntry.activeIdentityId];
  }
  if (originEntry.identityMode) {
    return {
      id: originEntry.activeIdentityId || null,
      mode: originEntry.identityMode,
      publisherKeyIndex: originEntry.publisherKeyIndex ?? null,
    };
  }
  return null;
}

/**
 * Return the identity that owns a stored high-level feed. Existing feeds stay
 * bound to their creation identity even if the origin's active identity later
 * changes.
 * @param {Object} originEntry
 * @param {Object} feed
 * @returns {Object|null}
 */
function getFeedIdentity(originEntry, feed) {
  if (feed?.identityId && originEntry?.identities?.[feed.identityId]) {
    return originEntry.identities[feed.identityId];
  }
  return getActiveOriginIdentity(originEntry);
}

function getIdentityMode(identity) {
  return identity?.mode || identity?.identityMode || null;
}

/**
 * Resolve the signer private key for a feed/SOC identity.
 * @param {Object} identity - Identity record from feed-store
 * @returns {Promise<string>} 0x-prefixed hex private key
 */
async function resolveSignerKey(identity) {
  const identityMode = getIdentityMode(identity);
  if (identityMode === 'bee-wallet') {
    const keys = getDerivedKeys();
    if (!keys) {
      throw new Error(VAULT_LOCKED_MESSAGE);
    }
    return keys.beeWallet.privateKey;
  }

  if (identityMode === 'app-scoped') {
    if (typeof identity.publisherKeyIndex !== 'number') {
      throw new Error('App-scoped identity is missing a publisher key index');
    }
    const publisherKey = await getPublisherKey(identity.publisherKeyIndex);
    return publisherKey.privateKey;
  }

  if (identityMode === 'ethereum-wallet') {
    if (typeof identity.walletIndex !== 'number') {
      throw new Error('Ethereum wallet identity is missing a wallet index');
    }
    const walletKey = await getUserWalletKey(identity.walletIndex);
    return walletKey.privateKey;
  }

  throw new Error(`Unknown identity mode: ${identityMode}`);
}

/**
 * Handle swarm_getSigningIdentity: disclose origin signing address after
 * connection + feed/signing grant. Does not require Bee node readiness.
 */
async function handleGetSigningIdentity(origin) {
  if (!hasFeedGrant(origin)) {
    return feedNotGranted();
  }

  const originEntry = getOriginEntry(origin);
  const activeIdentity = getActiveOriginIdentity(originEntry);
  let signerKey;
  try {
    signerKey = await resolveSignerKey(activeIdentity);
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }

  try {
    return {
      result: {
        owner: getSignerAddress(signerKey),
        identityMode: getIdentityMode(activeIdentity),
      },
    };
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
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
    return feedNotGranted();
  }

  const originEntry = getOriginEntry(origin);

  // Idempotent: if feed already exists, return existing metadata
  const existingFeed = getFeed(origin, name);
  if (existingFeed) {
    const feedIdentity = getFeedIdentity(originEntry, existingFeed);
    return {
      result: {
        feedId: name,
        owner: existingFeed.owner,
        topic: existingFeed.topic,
        manifestReference: existingFeed.manifestReference,
        bzzUrl: `bzz://${existingFeed.manifestReference}`,
        identityMode: getIdentityMode(feedIdentity),
      },
    };
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  const activeIdentity = getActiveOriginIdentity(originEntry);
  let signerKey;
  try {
    signerKey = await resolveSignerKey(activeIdentity);
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }

  const topicString = buildTopicString(origin, name);

  // No bytesSize: feed-create / feed-update are metadata-only operations.
  // Payload bytes are tracked on feed-entry writes (handleWriteFeedEntry).
  const historyEntry = addEntry({
    type: 'feed-create',
    name,
    status: 'uploading',
    origin,
  });

  try {
    const result = await createFeed(signerKey, topicString);

    setFeed(origin, name, {
      topic: result.topic,
      owner: result.owner,
      manifestReference: result.manifestReference,
      identityId: activeIdentity.id,
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
        identityMode: getIdentityMode(activeIdentity),
      },
    };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed', errorMessage: err.message });
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
    return feedNotGranted();
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
  const feedIdentity = getFeedIdentity(originEntry, existingFeed);
  try {
    signerKey = await resolveSignerKey(feedIdentity);
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }

  const topicString = buildTopicString(origin, feedId);

  const historyEntry = addEntry({
    type: 'feed-update',
    name: feedId,
    status: 'uploading',
    origin,
  });

  try {
    const updateResult = await updateFeed(signerKey, topicString, reference);

    updateFeedReference(origin, feedId, reference);
    updateEntry(historyEntry.id, { status: 'completed', ...updateResult, reference });

    log.info(`[SwarmProvider] updateFeed succeeded for ${origin}: feed=${feedId}, ref=${reference}, index=${updateResult.index}`);

    return {
      result: {
        feedId,
        reference,
        bzzUrl: `bzz://${existingFeed.manifestReference}`,
        index: updateResult.index,
      },
    };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed', errorMessage: err.message });
    log.error(`[SwarmProvider] updateFeed failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_writeFeedEntry: validate, check capability, write payload to feed.
 */
async function handleWriteFeedEntry(params, origin) {
  if (!params || typeof params !== 'object') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'params is required', data: { reason: 'invalid_params' } } };
  }

  const { name, data, index } = params;

  const nameResult = validateFeedName(name);
  if (!nameResult.valid) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: nameResult.message, data: { reason: 'invalid_feed_name' } } };
  }

  if (data === undefined || data === null) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'data is required', data: { reason: 'invalid_params' } } };
  }

  // Accept string or binary
  let payload = data;
  if (typeof payload !== 'string') {
    payload = normalizeBytes(payload);
    if (!payload) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'data must be a string, Uint8Array, or ArrayBuffer', data: { reason: 'invalid_params' } } };
    }
  }

  if (index !== undefined && index !== null) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'index must be a non-negative integer', data: { reason: 'invalid_params' } } };
    }
  }

  if (!hasFeedGrant(origin)) {
    return feedNotGranted();
  }

  const originEntry = getOriginEntry(origin);

  const existingFeed = getFeed(origin, name);
  if (!existingFeed) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: `Feed not found: ${name}. Create it with createFeed first.`, data: { reason: 'feed_not_found' } } };
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  let signerKey;
  const feedIdentity = getFeedIdentity(originEntry, existingFeed);
  try {
    signerKey = await resolveSignerKey(feedIdentity);
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }

  const topicString = buildTopicString(origin, name);

  const historyEntry = addEntry({
    type: 'feed-entry',
    name,
    status: 'uploading',
    origin,
    bytesSize: Buffer.byteLength(payload),
  });

  try {
    const result = await writeFeedPayload(signerKey, topicString, payload, { index });

    updateEntry(historyEntry.id, { status: 'completed' });
    log.info(`[SwarmProvider] writeFeedEntry succeeded for ${origin}: feed=${name}, index=${result.index}`);

    return { result: { index: result.index } };
  } catch (err) {
    updateEntry(historyEntry.id, { status: 'failed', errorMessage: err.message });

    // Translate known error reasons to appropriate error codes
    if (err.reason === 'index_already_exists') {
      return { error: { ...ERRORS.INVALID_PARAMS, message: err.message, data: { reason: 'index_already_exists' } } };
    }

    // Translate SOC payload size errors
    if (err.message && (err.message.includes('too large') || err.message.includes('payload size'))) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'Payload exceeds maximum SOC size', data: { reason: 'payload_too_large' } } };
    }

    log.error(`[SwarmProvider] writeFeedEntry failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_readFeedEntry: validate, resolve topic/owner, read feed entry.
 * Does NOT require feed grant or vault — read-only operation.
 */
async function handleReadFeedEntry(params, origin) {
  if (!params || typeof params !== 'object') {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'params is required', data: { reason: 'invalid_params' } } };
  }

  const { topic: topicHex, name, owner, index } = params;

  // Exactly one of topic or name
  const hasTopic = topicHex !== undefined && topicHex !== null;
  const hasName = name !== undefined && name !== null;

  if (hasTopic && hasName) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'Provide either topic or name, not both', data: { reason: 'invalid_params' } } };
  }
  if (!hasTopic && !hasName) {
    return { error: { ...ERRORS.INVALID_PARAMS, message: 'Either topic or name is required', data: { reason: 'invalid_params' } } };
  }

  // Validate index
  if (index !== undefined && index !== null) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'index must be a non-negative integer', data: { reason: 'invalid_params' } } };
    }
  }

  // Resolve topic and owner
  let resolvedTopic;
  let resolvedOwner;

  if (hasTopic) {
    // Raw topic hex — construct Topic directly (no hashing)
    if (typeof topicHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(topicHex)) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'topic must be a 64-character hex string', data: { reason: 'invalid_topic' } } };
    }
    resolvedTopic = new Topic(topicHex);

    // owner is required with topic
    if (!owner || typeof owner !== 'string') {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'owner is required when using topic', data: { reason: 'invalid_owner' } } };
    }
    resolvedOwner = owner.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{40}$/.test(resolvedOwner)) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'owner must be a valid 40-character hex address', data: { reason: 'invalid_owner' } } };
    }
  } else {
    // Feed name — derive topic via hashing
    const nameResult = validateFeedName(name);
    if (!nameResult.valid) {
      return { error: { ...ERRORS.INVALID_PARAMS, message: nameResult.message, data: { reason: 'invalid_feed_name' } } };
    }

    const topicString = buildTopicString(origin, name);
    resolvedTopic = Topic.fromString(topicString);

    if (owner) {
      // Owner explicitly provided with name
      resolvedOwner = typeof owner === 'string' ? owner.replace(/^0x/, '') : '';
      if (!/^[0-9a-fA-F]{40}$/.test(resolvedOwner)) {
        return { error: { ...ERRORS.INVALID_PARAMS, message: 'owner must be a valid 40-character hex address', data: { reason: 'invalid_owner' } } };
      }
    } else {
      // Owner inferred from local feed store
      const existingFeed = getFeed(origin, name);
      if (!existingFeed || !existingFeed.owner) {
        return { error: { ...ERRORS.INVALID_PARAMS, message: `Feed not found: ${name}. Create it first or provide owner explicitly.`, data: { reason: 'feed_not_found' } } };
      }
      resolvedOwner = existingFeed.owner.replace(/^0x/, '');
    }
  }

  const budgetError = consumePermissionFreeReadBudget(origin, { requests: 1 });
  if (budgetError) return budgetError;

  // Read-only pre-flight: just check Bee API is reachable
  const reachable = await checkBeeReachable();
  if (!reachable.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${reachable.reason}`, data: { reason: reachable.reason } } };
  }

  try {
    const result = await readFeedPayload(resolvedOwner, resolvedTopic, index);

    const base64Data = result.payload.toString('base64');
    const byteBudgetError = consumePermissionFreeReadBudget(origin, {
      bytes: result.payload.length,
    });
    if (byteBudgetError) return byteBudgetError;

    return {
      result: {
        data: base64Data,
        encoding: 'base64',
        index: result.index,
        nextIndex: result.nextIndex,
      },
    };
  } catch (err) {
    if (err.reason === 'feed_empty') {
      return { error: { ...ERRORS.INVALID_PARAMS, message: err.message, data: { reason: 'feed_empty' } } };
    }
    if (err.reason === 'entry_not_found') {
      return { error: { ...ERRORS.INVALID_PARAMS, message: err.message, data: { reason: 'entry_not_found' } } };
    }
    log.error(`[SwarmProvider] readFeedEntry failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_listFeeds: return the calling origin's feed records.
 *
 * Scoped to the caller — only feeds created under this origin are returned.
 * No permission required (see dispatcher comment for rationale). Returns
 * an empty array for origins with no feeds, including origins that have
 * never granted permission and origins whose permission was revoked.
 *
 * Takes no params (origin alone determines the result). Any params supplied
 * by the caller are silently ignored — kept lenient because this is
 * introspection-only and adding a strict guard buys nothing.
 */
function handleListFeeds(origin) {
  const feeds = getAllFeeds(origin);
  const result = Object.entries(feeds).map(([name, feed]) => ({
    name,
    topic: feed.topic,
    owner: feed.owner,
    manifestReference: feed.manifestReference,
    bzzUrl: `bzz://${feed.manifestReference}`,
    createdAt: feed.createdAt,
    lastUpdated: feed.lastUpdated,
    lastReference: feed.lastReference,
  }));
  const budgetError = consumePermissionFreeReadBudget(origin, {
    requests: 1,
    bytes: Buffer.byteLength(JSON.stringify(result), 'utf-8'),
  });
  if (budgetError) return budgetError;
  return { result };
}

/**
 * Read-only pre-flight: is the Bee HTTP API reachable?
 * Intentionally separate from checkSwarmPreFlight — reads don't need
 * mode, readiness, or stamp checks.
 * @returns {{ ok: boolean, reason?: string }}
 */
async function checkBeeReachable() {
  const beeUrl = getBeeApiUrl();
  if (!beeUrl) return { ok: false, reason: 'node-stopped' };
  try {
    const res = await fetch(`${beeUrl}/node`);
    if (!res.ok) return { ok: false, reason: 'node-stopped' };
    await res.json(); // consume response body
    return { ok: true };
  } catch {
    return { ok: false, reason: 'node-stopped' };
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
 * swarm_apiRequest — permission-gated passthrough to the local Bee HTTP API.
 *
 * Lets a connected dApp make an arbitrary Bee API call from the MAIN process
 * (which isn't subject to browser CORS), so libraries that use plain `fetch`
 * against the node work without exposing the node API to the open web. The
 * `path` is allow-listed by first segment (data + postage + pss surface only);
 * node-wallet / chequebook / staking / admin endpoints are never reachable.
 *
 * @param {{ method?: string, path?: string, headers?: object, body?: string,
 *   bodyEncoding?: 'utf8'|'base64' }} params
 * @returns {{ result?: { ok, status, statusText, headers, body, bodyEncoding },
 *   error? }}
 */
async function handleApiRequest(params, _origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params object is required');
  }

  const httpMethod = String(params.method || 'GET').toUpperCase();
  if (!ALLOWED_API_METHODS.has(httpMethod)) {
    return invalidParams(`Unsupported method: ${httpMethod}`, 'unsupported_method', { method: httpMethod });
  }

  const path = params.path;
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return invalidParams('path must be a string starting with "/"', 'invalid_path');
  }
  if (path.length > 2048 || path.includes('..')) {
    return invalidParams('path is malformed', 'invalid_path');
  }
  // First path segment (before the next "/" or query/fragment) gates access.
  const segment = path.slice(1).split(/[/?#]/, 1)[0].toLowerCase();
  if (!ALLOWED_API_SEGMENTS.has(segment)) {
    return notAuthorized('endpoint_not_allowed');
  }

  // Request headers: forward a safe subset.
  const headers = {};
  if (params.headers != null) {
    if (typeof params.headers !== 'object' || Array.isArray(params.headers)) {
      return invalidParams('headers must be an object', 'invalid_headers');
    }
    const entries = Object.entries(params.headers);
    if (entries.length > LIMITS.maxApiHeaders) {
      return invalidParams('too many headers', 'too_many_headers');
    }
    for (const [k, v] of entries) {
      const key = String(k).toLowerCase();
      if (BLOCKED_API_HEADERS.has(key)) continue;
      const value = String(v);
      if (key.length > LIMITS.maxApiHeaderLen || value.length > LIMITS.maxApiHeaderLen) {
        return invalidParams('header too large', 'header_too_large');
      }
      headers[key] = value;
    }
  }

  // Request body: utf8 string or base64-encoded bytes.
  let body;
  if (params.body != null) {
    if (typeof params.body !== 'string') {
      return invalidParams('body must be a string', 'invalid_body');
    }
    try {
      body = Buffer.from(params.body, params.bodyEncoding === 'base64' ? 'base64' : 'utf8');
    } catch {
      return invalidParams('body could not be decoded', 'invalid_body');
    }
    if (body.length > LIMITS.maxApiBodyBytes) {
      return invalidParams('body exceeds size limit', 'body_too_large');
    }
  }

  const beeUrl = getBeeApiUrl();
  if (!beeUrl) {
    return { error: ERRORS.NODE_UNAVAILABLE };
  }

  let res;
  try {
    res = await fetch(`${beeUrl}${path}`, {
      method: httpMethod,
      headers,
      body: httpMethod === 'GET' || httpMethod === 'HEAD' ? undefined : body,
    });
  } catch (err) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Bee request failed: ${err.message}` } };
  }

  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { error: { ...ERRORS.INTERNAL_ERROR, message: `Failed reading response: ${err.message}` } };
  }
  if (buf.length > LIMITS.maxApiBodyBytes) {
    return invalidParams('response exceeds size limit', 'response_too_large');
  }

  const contentType = res.headers.get('content-type') || '';
  const textual = TEXTUAL_CONTENT_TYPE.test(contentType);
  const respHeaders = {};
  res.headers.forEach((value, key) => { respHeaders[key] = value; });

  return {
    result: {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: respHeaders,
      body: textual ? buf.toString('utf8') : buf.toString('base64'),
      bodyEncoding: textual ? 'utf8' : 'base64',
    },
  };
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
  checkBeeReachable,
  validateVirtualPath,
  validateFeedName,
  clearTagOwnership,
  clearPermissionFreeReadBudgets,
  LIMITS,
};
