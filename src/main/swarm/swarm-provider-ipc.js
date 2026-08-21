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
 *   (c) The renderer-supplied origin is the *authority* for grant checks;
 *       webContents.getURL() is used only as an independent cross-check that
 *       the subscribing/receiving document still belongs to that origin (see
 *       the delivery guard and the subscribe post-await re-check below). This
 *       works because bzz://, ipfs:// and ipns:// are served by custom
 *       protocol handlers that preserve the dweb URL — getURL() carries the
 *       dweb identity, so normalizeOrigin(getURL()) matches the renderer key.
 *       NOTE: those two guards depend on that invariant. If a future transport
 *       reintroduces gateway-URL loading (http://127.0.0.1:port) for a dweb
 *       scheme, getURL() would stop carrying the identity and the guards would
 *       fail *closed* for it (messaging blocked, not leaked) — update them here
 *       rather than assuming this comment still holds.
 *   The renderer is the only process that can map webview → tab → display URL.
 */

const { ipcMain, webContents } = require('electron');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { getPermission, hasMessagingGrant, onRevoke } = require('./swarm-permissions');
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
const messagingService = require('./messaging-service');
const subscriptionRegistry = require('./subscription-registry');
const { getAntApiUrl } = require('../service-registry');
const { getDerivedKeys, getPublisherKey, getUserWalletKey } = require('../identity-manager');
const { resetVaultAutoLockTimer } = require('../vault-timer');
const log = require('electron-log');

const LIMITS = {
  maxDataBytes: 10 * 1024 * 1024,    // 10 MB
  maxFilesBytes: 50 * 1024 * 1024,   // 50 MB
  maxFileCount: 100,
  maxPathBytes: 100,
  maxChunkPayloadBytes: 4096,
  // Messaging extension — maxMessageBytes/maxTargetDepth mirror the Ant
  // node's own enforcement (see messaging-service.js). minTargetDepth is
  // the SWIP storability floor (2 bytes); defaultTargetDepth is the L=16
  // interop convention we emit as `pssTarget`.
  maxMessageBytes: messagingService.MAX_MESSAGE_BYTES,
  maxTargetDepth: messagingService.MAX_TARGET_DEPTH,
  defaultTargetDepth: messagingService.DEFAULT_TARGET_DEPTH,
  minTargetDepth: messagingService.DEFAULT_TARGET_DEPTH,
  maxSubscriptions: 32,
};

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
  'swarm_getMessagingIdentity',
  'swarm_subscribe',
  'swarm_unsubscribe',
  'swarm_sendPss',
  'swarm_sendGsoc',
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

/**
 * Shared bounded-payload validation for chunk and message writes.
 * Returns { payload } on success or an invalidParams result to return as-is.
 * Empty payloads are rejected by default (bee refuses empty chunks/SOCs);
 * PSS opts out via allowEmpty — its trojan framing carries an explicit
 * length, so a zero-byte message is well-formed (spec: pings/signals).
 */
function validateBoundedPayload(data, maxBytes, label, options = {}) {
  const payload = normalizePayloadParam(data);
  if (!payload) {
    return invalidParams('data must be a string, Uint8Array, or ArrayBuffer');
  }
  if (payload.length === 0 && !options.allowEmpty) {
    return invalidParams('data must not be empty', options.emptyReason || 'invalid_params');
  }
  if (payload.length > maxBytes) {
    return invalidParams(
      `Payload exceeds maximum ${label} size of ${maxBytes} bytes`,
      'payload_too_large',
      { limit: maxBytes, actual: payload.length }
    );
  }
  return { payload };
}

function validateChunkPayload(data) {
  return validateBoundedPayload(data, LIMITS.maxChunkPayloadBytes, 'chunk');
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
 * @param {{ webContentsId?: number }} [meta] - Renderer-supplied routing info
 *   (trusted like origin — the renderer is Freedom's own code). Only
 *   swarm_subscribe uses it, to target message delivery at the webview.
 * @returns {{ result?, error? }}
 */
async function executeSwarmMethod(method, params, origin, meta) {
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

    // Messaging extension — no vault-timer reset: PSS/GSOC use node/mined
    // keys, never vault-derived signing keys.
    if (method === 'swarm_getMessagingIdentity') {
      return handleGetMessagingIdentity(normalizedOrigin);
    }

    if (method === 'swarm_sendPss') {
      return handleSendPss(params, normalizedOrigin);
    }

    if (method === 'swarm_sendGsoc') {
      return handleSendGsoc(params, normalizedOrigin);
    }

    if (method === 'swarm_subscribe') {
      return handleSubscribe(params, normalizedOrigin, meta);
    }

    if (method === 'swarm_unsubscribe') {
      return handleUnsubscribe(params, normalizedOrigin);
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
      features: ['messaging'],
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
        maxMessageBytes: LIMITS.maxMessageBytes,
        maxTargetDepth: LIMITS.maxTargetDepth,
        maxSubscriptions: LIMITS.maxSubscriptions,
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

// ---------------------------------------------------------------------------
// Messaging extension (PSS/GSOC) — see the messaging SWIP
// ---------------------------------------------------------------------------

function messagingNotGranted() {
  return notAuthorized('messaging_not_granted');
}

/**
 * Validate a messaging topic string (PSS topic or GSOC room topic).
 * Topics are hashed before hitting the wire, so the only constraints are
 * sanity ones: non-empty, bounded, no control characters.
 */
function validateMessagingTopic(topic) {
  if (typeof topic !== 'string' || topic.length === 0) {
    return invalidParams('topic must be a non-empty string', 'invalid_topic');
  }
  if (Buffer.byteLength(topic, 'utf-8') > 256) {
    return invalidParams('topic exceeds 256 UTF-8 bytes', 'invalid_topic');
  }
  for (let i = 0; i < topic.length; i++) {
    if (topic.charCodeAt(i) < 32) {
      return invalidParams('topic must not contain control characters', 'invalid_topic');
    }
  }
  return null;
}

/**
 * Handle swarm_getMessagingIdentity: disclose the PSS public key peers
 * encrypt to and the truncated routing target they send toward.
 *
 * The full node overlay MUST NOT cross the page boundary — it is
 * node-global (identical for every origin), so it would be a cross-origin
 * correlation handle and disclose the node's exact network position. Only
 * the first defaultTargetDepth (2) bytes leave as `pssTarget` — the L=16
 * routing convention, and enough neighborhood prefix to route. The PSS key itself
 * is the node key (the Ant lurker decrypts with it), i.e. bee-wallet mode:
 * origins that need unlinkable messaging identities must wait for
 * app-scoped PSS keys (node support required).
 */
async function handleGetMessagingIdentity(origin) {
  if (!hasMessagingGrant(origin)) {
    return messagingNotGranted();
  }

  const reachable = await checkBeeReachable();
  if (!reachable.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${reachable.reason}`, data: { reason: reachable.reason } } };
  }

  try {
    const identity = await messagingService.getMessagingIdentity();
    return {
      result: {
        pssPublicKey: identity.pssPublicKey,
        pssTarget: identity.overlay.slice(0, LIMITS.defaultTargetDepth * 2),
        identityMode: 'bee-wallet',
      },
    };
  } catch (err) {
    log.error(`[SwarmProvider] getMessagingIdentity failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_sendPss: encrypted point-to-point message.
 */
async function handleSendPss(params, origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const optionsError = validateEmptyOptions(params.options);
  if (optionsError) return optionsError;

  const topicError = validateMessagingTopic(params.topic);
  if (topicError) return topicError;

  const recipient = normalizeAddress(params.recipient);
  if (!/^0[23][0-9a-fA-F]{64}$/.test(recipient)) {
    return invalidParams(
      'recipient must be a 66-character hex compressed secp256k1 public key',
      'invalid_recipient'
    );
  }

  const { targets } = params;
  const targetByteLen = typeof targets === 'string' ? targets.length / 2 : NaN;
  const targetBytesValid =
    typeof targets === 'string' &&
    /^([0-9a-fA-F]{2})+$/.test(targets) &&
    targetByteLen >= LIMITS.minTargetDepth &&
    targetByteLen <= LIMITS.maxTargetDepth;
  if (!targetBytesValid) {
    // Floor is the storability depth (a 1-byte target is too shallow to
    // be retained by any storer); cap is the mining-cost ceiling.
    return invalidParams(
      `targets must be hex encoding ${LIMITS.minTargetDepth}-${LIMITS.maxTargetDepth} whole bytes`,
      'invalid_target'
    );
  }

  const { payload, error } = validateBoundedPayload(params.data, LIMITS.maxMessageBytes, 'message', {
    allowEmpty: true,
  });
  if (error) return { error };

  if (!hasMessagingGrant(origin)) {
    return messagingNotGranted();
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  try {
    await messagingService.sendPss({
      topic: params.topic,
      targets: targets.toLowerCase(),
      recipient,
      data: payload,
    });
    return { result: { sent: true } };
  } catch (err) {
    log.error(`[SwarmProvider] sendPss failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_sendGsoc: topic broadcast.
 *
 * Raw-address sends are rejected: a GSOC write is a signed SOC, and the
 * signing key is derived by mining from the topic — an address alone
 * carries no key, so there is nothing to sign with. Cross-provider
 * senders must share the topic (or use the feed/SOC layer).
 */
async function handleSendGsoc(params, origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const optionsError = validateEmptyOptions(params.options);
  if (optionsError) return optionsError;

  if (params.address !== undefined && params.address !== null) {
    return invalidParams(
      'Sending to a raw GSOC address is not supported: the signing key derives from the topic. Provide topic instead.',
      'invalid_address'
    );
  }

  const topicError = validateMessagingTopic(params.topic);
  if (topicError) return topicError;

  // A GSOC update is a SOC; bee's chunk layer rejects an empty SOC
  // payload, so an empty broadcast is inexpressible (spec: invalid_payload).
  const { payload, error } = validateBoundedPayload(params.data, LIMITS.maxMessageBytes, 'message', {
    emptyReason: 'invalid_payload',
  });
  if (error) return { error };

  if (!hasMessagingGrant(origin)) {
    return messagingNotGranted();
  }

  const preFlight = await checkSwarmPreFlight();
  if (!preFlight.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${preFlight.reason}`, data: { reason: preFlight.reason } } };
  }

  try {
    const result = await messagingService.sendGsoc({ topic: params.topic, data: payload });
    return { result: { sent: true, address: result.address } };
  } catch (err) {
    log.error(`[SwarmProvider] sendGsoc failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

// webContents ids that already have teardown listeners attached. A
// webview keeps its webContents across navigations, so subscriptions are
// torn down both on 'destroyed' (tab close) and 'did-navigate' (main-frame
// navigation away — the page that subscribed is gone either way).
// Deliberately not 'did-navigate-in-page': a hash route or pushState
// leaves the same document, with the same grant and the same live
// listeners, so tearing down there would break messaging on a page that
// is very much still there.
const teardownAttached = new Set();

// Per-webContents navigation counter. A webview keeps its webContents across
// navigations, so a same-origin *cross-document* navigation during the
// subscribe awaits (grant prompt + reachability probe) fires did-navigate but
// leaves the origin re-check happy (chat.eth → chat.eth) — binding the new
// document a subscription it never asked for. Snapshot this at request entry
// and compare after the awaits: a cross-document navigation bumps it (in-page
// hash/pushState does not fire did-navigate, so a live page's own routing is
// unaffected). Listener attached once per webContents, cleared on destroy.
const navEpochs = new Map();
const navEpochAttached = new Set();

function navEpoch(webContentsId) {
  if (!navEpochAttached.has(webContentsId)) {
    const contents = webContents.fromId(webContentsId);
    if (contents && !contents.isDestroyed()) {
      navEpochAttached.add(webContentsId);
      contents.on('did-navigate', () => {
        navEpochs.set(webContentsId, (navEpochs.get(webContentsId) || 0) + 1);
      });
      contents.once('destroyed', () => {
        navEpochAttached.delete(webContentsId);
        navEpochs.delete(webContentsId);
      });
    }
  }
  return navEpochs.get(webContentsId) || 0;
}

function attachWebContentsTeardown(webContentsId) {
  if (teardownAttached.has(webContentsId)) return;
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    subscriptionRegistry.cancelByWebContents(webContentsId);
    return;
  }
  teardownAttached.add(webContentsId);
  contents.on('did-navigate', () => {
    subscriptionRegistry.cancelByWebContents(webContentsId);
  });
  contents.once('destroyed', () => {
    teardownAttached.delete(webContentsId);
    subscriptionRegistry.cancelByWebContents(webContentsId);
  });
}

function deliverSubscriptionMessage(subscription, payload) {
  const contents = webContents.fromId(subscription.webContentsId);
  if (!contents || contents.isDestroyed()) return;
  // A webview keeps its webContents across navigations, so the page on
  // screen may no longer belong to the origin that subscribed. Delivering
  // here would hand another origin's page the messages of a subscription
  // it never asked for (and has no grant for). The did-navigate teardown
  // below normally wins this race; this check is what makes it safe when
  // a message and a commit land in the same tick.
  //
  // The comparison is on the permission key, not the exact URL: an
  // in-page navigation (hash route, pushState) fires no did-navigate and
  // leaves the very same document — and the same grant — in place, so
  // keying on the URL would kill a live page's messaging on its first
  // route change.
  const currentOrigin = normalizeOrigin(contents.getURL());
  if (currentOrigin !== subscription.origin) {
    // Only the subscriptions whose origin is gone: a subscription the
    // origin now loaded already opened on this webview is still valid.
    subscriptionRegistry.cancelStaleByWebContents(subscription.webContentsId, currentOrigin);
    return;
  }
  // The webview preload bridges this channel to the page (the preload
  // itself keeps the literal string — sandboxed preloads cannot require
  // shared modules).
  contents.send(IPC.SWARM_PROVIDER_EVENT, {
    event: 'message',
    data: {
      type: 'swarm_subscription',
      subscription: subscription.id,
      result: {
        kind: subscription.kind,
        key: subscription.key,
        data: payload.toString('base64'),
        encoding: 'base64',
        receivedAt: Date.now(),
      },
    },
  });
}

/**
 * Handle swarm_subscribe: open a long-lived GSOC/PSS subscription.
 */
async function handleSubscribe(params, origin, meta) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const optionsError = validateEmptyOptions(params.options);
  if (optionsError) return optionsError;

  const { kind } = params;
  if (kind !== 'gsoc' && kind !== 'pss') {
    return invalidParams('kind must be "gsoc" or "pss"', 'invalid_kind');
  }

  const hasTopic = params.topic !== undefined && params.topic !== null;
  const hasAddress = params.address !== undefined && params.address !== null;

  let key;
  if (kind === 'gsoc') {
    if (hasTopic === hasAddress) {
      return invalidParams('Provide either topic or address, not both', 'invalid_params');
    }
    if (hasAddress) {
      const addressError = validateHexString(params.address, 32, 'invalid_address', 'address');
      if (addressError) return addressError;
      key = params.address.toLowerCase();
    }
  } else {
    if (hasAddress) {
      return invalidParams('address is only valid for gsoc subscriptions', 'invalid_params');
    }
    if (!hasTopic) {
      return invalidParams('topic is required', 'invalid_topic');
    }
  }

  if (hasTopic) {
    const topicError = validateMessagingTopic(params.topic);
    if (topicError) return topicError;
  }

  const webContentsId = meta?.webContentsId;
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    return invalidParams('subscribe requires a webContents target', 'invalid_params');
  }

  // Snapshot before the user-paced grant prompt and the reachability probe, so
  // a cross-document navigation during either is detected below even when it
  // stays on the same origin (which the origin re-check alone cannot catch).
  const entryNavEpoch = navEpoch(webContentsId);

  if (!hasMessagingGrant(origin)) {
    return messagingNotGranted();
  }

  const reachable = await checkBeeReachable();
  if (!reachable.ok) {
    return { error: { ...ERRORS.NODE_UNAVAILABLE, message: `Node not available: ${reachable.reason}`, data: { reason: reachable.reason } } };
  }

  if (!key) {
    // Topic-derived key: GSOC mines the room address, PSS hashes the topic.
    try {
      key = kind === 'gsoc'
        ? messagingService.deriveGsoc(params.topic).address
        : messagingService.resolvePssTopicHex(params.topic);
    } catch (err) {
      log.error(`[SwarmProvider] subscribe derivation failed for ${origin}:`, err.message);
      return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
    }
  }

  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) {
    return invalidParams('subscribe requires a live webContents target', 'invalid_params');
  }

  // Everything above this line can take arbitrarily long — the messaging
  // grant prompt is user-paced and the reachability probe is a network
  // round-trip — and a webview keeps its webContents across navigations.
  // If the user navigated the tab elsewhere while we waited, the registry
  // entry we are about to create would bind `origin`'s subscription to a
  // webContents now hosting someone else, and the delivery check would
  // then happily validate it: every message for this topic would land in
  // the other site. did-navigate cannot save us here — it fired before
  // any entry existed. Re-check the live page instead.
  // Two shapes of "navigated away during the awaits": a different origin now
  // holds the webContents (origin check), or a same-origin cross-document
  // navigation replaced the subscribing document (epoch check — did-navigate
  // fired with no entry yet to cancel). Either way the requesting document is
  // gone; binding now would hand its slot to a page that never subscribed.
  if (normalizeOrigin(contents.getURL()) !== origin || navEpoch(webContentsId) !== entryNavEpoch) {
    log.warn(`[SwarmProvider] subscribe target navigated away from ${origin}: ${kind}:${key}`);
    return {
      error: {
        ...ERRORS.NODE_UNAVAILABLE,
        message: 'Page navigated away before the subscription was established',
        data: { reason: 'subscription_cancelled' },
      },
    };
  }

  // Teardown must be armed *before* the registry can hold a slot on this
  // page's behalf: establishment can take seconds (or, against a node
  // that stopped answering, never settle), and the page can navigate away
  // or be closed in the meantime. Attaching only on success leaked the
  // subscription — and its share of the per-origin cap — forever.
  attachWebContentsTeardown(webContentsId);

  try {
    const { subscriptionId } = await subscriptionRegistry.subscribe({
      origin,
      webContentsId,
      kind,
      key,
    });
    log.info(`[SwarmProvider] subscribe succeeded for ${origin}: ${kind}:${key}`);
    return { result: { subscriptionId, kind, key } };
  } catch (err) {
    if (err.reason === 'establish_timeout' || err.reason === 'subscription_cancelled' || err.reason === 'cancelled') {
      // Never established within the window, or torn down while we waited
      // (navigation, tab close, grant revoke). Retryable, like any other
      // node-availability failure — the slot has already been released.
      log.warn(`[SwarmProvider] subscribe did not establish for ${origin} (${err.reason}): ${kind}:${key}`);
      return {
        error: {
          ...ERRORS.NODE_UNAVAILABLE,
          message: err.message,
          data: { reason: err.reason },
        },
      };
    }
    if (err.reason === 'too_many_subscriptions') {
      return invalidParams(err.message, 'too_many_subscriptions', {
        limit: LIMITS.maxSubscriptions,
      });
    }
    if (err.reason === 'node_subscription_limit') {
      // Node-wide pipeline pool exhausted (possibly by other origins) —
      // per spec this is a retryable 4900, NOT a parameter error: the
      // calling dApp did nothing wrong and capacity frees as other
      // subscriptions close.
      return {
        error: {
          ...ERRORS.NODE_UNAVAILABLE,
          message: `Node subscription capacity exhausted: ${err.message}`,
          data: { reason: 'node_subscription_limit' },
        },
      };
    }
    log.error(`[SwarmProvider] subscribe failed for ${origin}:`, err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Handle swarm_unsubscribe: close a subscription (origin-scoped).
 */
function handleUnsubscribe(params, origin) {
  if (!params || typeof params !== 'object') {
    return invalidParams('params is required');
  }

  const { subscriptionId } = params;
  if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
    return invalidParams('subscriptionId is required', 'invalid_params');
  }

  try {
    subscriptionRegistry.unsubscribe(origin, subscriptionId);
    return { result: { unsubscribed: true } };
  } catch (err) {
    if (err.reason === 'subscription_not_found') {
      return invalidParams(err.message, 'subscription_not_found');
    }
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

/**
 * Read-only pre-flight: is the Bee HTTP API reachable?
 * Intentionally separate from checkSwarmPreFlight — reads don't need
 * mode, readiness, or stamp checks.
 * @returns {{ ok: boolean, reason?: string }}
 */
async function checkBeeReachable() {
  const beeUrl = getAntApiUrl();
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
    const beeUrl = getAntApiUrl();
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
  subscriptionRegistry.configure({
    openSocket: messagingService.openSubscriptionSocket,
    deliver: deliverSubscriptionMessage,
    maxSubscriptionsPerOrigin: LIMITS.maxSubscriptions,
  });

  // Live messaging subscriptions must not outlive the origin's grant.
  onRevoke((origin) => subscriptionRegistry.cancelByOrigin(origin));

  ipcMain.handle(IPC.SWARM_PROVIDER_EXECUTE, async (_event, args) => {
    const { method, params, origin, meta } = args || {};
    return executeSwarmMethod(method, params, origin, meta);
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
