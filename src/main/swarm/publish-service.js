/**
 * Publish Service
 *
 * Upload operations via bee-js: data, files, and directories.
 * All uploads use auto batch selection and return normalized results.
 * Runs in the main process only — renderer interacts via IPC.
 *
 * **freedom://publish on the core's backend** (freedom-core design 0015,
 * "Methods main calls", SWM-8; the SWM-6 to SWM-9 plan's PR 8.3): in a
 * process whose Swarm backend is `core` (swarm-backend-kind.js, read once),
 * the IPC handlers send main's own `swarm.publish` instead of bee-js
 * (core/swarm-own-calls.js): text as one `data` part (inline up to 64 KiB,
 * else main's held bytes), a picked file as one `file` part main streams
 * from the file when the core asks, and a picked folder walked into a
 * `collection` of parts as bee-js finds its files, each streamed from its
 * file, named by its `/`-separated path in the folder. Each carries
 * `history`, so the core keeps the freedom://publish row around the upload
 * itself (`addEntry` before it, `updateEntry` after it, D3), and main
 * writes none of it; a publish that fails before anything is sent (its
 * file or folder can't be read) has its row written through the core's
 * `swarm.history` as js writes it. `swarm:get-upload-status` is
 * `swarm.upload_status`, within the reference's 10 s. The answers are the
 * reference's: the same `{ success, reference, bzzUrl, tagUid }`, and the
 * same failure texts, the core giving the service's messages
 * (`describePublishError`'s "try again shortly", `describePickedPathError`'s
 * `Could not read "<name>" (<code>)`, `needsStorage` for no usable batch).
 * Two differ, as the design records: a picked file that changes size while
 * it is read shows `Internal error` where bee-js gave its transport's text
 * (`picked-read-text`, U13), and a name over 100 UTF-8 bytes in a folder is
 * kept whole in the tar, where bee-js cut it (`tar-paths`, F-3). On `js`
 * nothing changes.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { File } = require('buffer');
const { ipcMain, dialog, BrowserWindow } = require('electron');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');
const { noUsableBatchError, isNoUsableBatchError } = require('./batch-errors');
const publishHistory = require('./publish-history');
const { isPrivateWebContents } = require('../private/private-windows');
const log = require('electron-log');
const { isBatchNotYetKnownError, BATCH_NOT_YET_KNOWN_MESSAGE } = require('./ant-storage-api');
const { createPickTokenStore } = require('./publish-pick-tokens');
const { getAntApiUrl } = require('../service-registry');
const pageUpload = require('./page-upload');
// Main's own calls on the core's backend (core/swarm-own-calls.js), loaded
// with their first call: on `js` nothing of the core's client is.
const coreCalls = () => require('../core/swarm-own-calls');

/** Whether `value` is a promise (any thenable). */
function isThenable(value) {
  return (
    (typeof value === 'object' || typeof value === 'function') && typeof value?.then === 'function'
  );
}

/**
 * The freedom://publish handlers' own history write `name` (`addEntry` or
 * `updateEntry`): publish-history.js's own function, answered in the run,
 * while main writes publish-history.sqlite; once the history is the core's
 * (this process's hello names `swarm_stores`, freedom-core design 0015, D3;
 * the SWM-6 to SWM-9 plan's PR 6.4), its `swarm.history` `add` or `update`,
 * as `shell` (publish-history.js `coreOps`), a promise. Each handler awaits
 * a promise and never a plain answer, so on main's own store it runs as it
 * always has.
 */
function writeHistory(name, ...args) {
  const ops = require('../core/core-client').swarmStoresNamed()
    ? publishHistory.coreOps
    : publishHistory;
  return ops[name](...args);
}

/**
 * Whether freedom://publish runs on the core's backend: the process's
 * Swarm backend (swarm-backend-kind.js), read once and kept.
 */
function publishesOnCore() {
  return require('./swarm-backend-kind').swarmBackendKind() === 'core';
}

/** `swarm:get-upload-status`'s bound on the core, as bee-js's `tag.get` had it. */
const UPLOAD_STATUS_MS = 10_000;

// What the user reads when a publish fails. A batch bought moments ago that
// storer peers have not synced yet gets a "try again shortly" sentence
// instead of the node's raw pushsync error.
function describePublishError(err) {
  return isBatchNotYetKnownError(err?.message) ? BATCH_NOT_YET_KNOWN_MESSAGE : err?.message;
}

// The failed-publish IPC result. `needsStorage` tells freedom://publish to
// offer the publish setup: no batch had room for the upload.
function publishFailure(err, message = describePublishError(err)) {
  const failure = { success: false, error: message };
  if (isNoUsableBatchError(err)) failure.needsStorage = true;
  return failure;
}

// A picked path's absolute location never reaches the renderer (S-7): only
// its basename, which swarm:pick-* already handed back. Node's fs errors
// (ENOENT/EACCES from stat or the read stream, e.g. the file was deleted or
// its permissions changed between pick and publish) carry the full path in
// err.message, so those are reported by basename and error code instead.
function describePickedPathError(err, pickedPath) {
  if (err && typeof err.code === 'string' && typeof err.syscall === 'string') {
    const name = path.basename(err.path || pickedPath);
    return `Could not read "${name}" (${err.code})`;
  }
  const message = describePublishError(err);
  return typeof message === 'string' ? message.split(pickedPath).join(path.basename(pickedPath)) : message;
}

// Sentinel for user-initiated publishes (text/file/directory triggered from
// the freedom://publish UI). dApp-driven publishes pass their actual origin.
const USER_ORIGIN = 'freedom://publish';

/** The IPC answer for a publish the core made: the reference's fields. */
function publishedOnCore(result) {
  return {
    success: true,
    reference: result.reference,
    bzzUrl: `bzz://${result.reference}`,
    tagUid: result.tag_uid,
  };
}

/**
 * The row of a freedom://publish upload that failed on the core's backend
 * before `swarm.publish` was sent (its text not readable as bytes, its
 * file or folder not read): the core's `swarm.history` `add` and `update`,
 * as `shell` (publish-history.js `coreOps`), the row the handler keeps on
 * `js`, where it is written before the upload. `message` is its text.
 */
async function unsentRowOnCore(type, name, message) {
  const row = await publishHistory.coreOps.addEntry({
    type,
    name,
    status: 'uploading',
    origin: USER_ORIGIN,
  });
  await publishHistory.coreOps.updateEntry(row.id, { status: 'failed', errorMessage: message });
}

/**
 * Text for `swarm.publish`'s one `data` part: a string's UTF-8, or the
 * bytes of a buffer, as `publishData`'s `Buffer.byteLength` and bee-js read
 * them; anything else throws what `Buffer.byteLength` throws.
 */
function dataBytes(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  Buffer.byteLength(data);
  throw new TypeError('The data must be a string or bytes');
}

/** `swarm:publish-data` on the core's backend. */
async function publishDataOnCore(data) {
  let bytes;
  try {
    bytes = dataBytes(data);
  } catch (err) {
    log.error('[PublishService] Failed to publish data:', err.message);
    await unsentRowOnCore('data', 'Text', err.message);
    return publishFailure(err);
  }
  try {
    const result = await coreCalls().swarmOwnCalls().publish({
      kind: 'data',
      parts: [{ bytes }],
      deferred: false,
      history: { type: 'data', name: 'Text' },
    });
    return publishedOnCore(result);
  } catch (err) {
    log.error('[PublishService] Failed to publish data:', err.message);
    return publishFailure(err);
  }
}

/** `swarm:publish-file` on the core's backend, for the picked `filePath`. */
async function publishFileOnCore(filePath, name) {
  let size;
  try {
    ({ size } = fs.statSync(filePath));
  } catch (err) {
    log.error('[PublishService] Failed to publish file:', err.message);
    const message = describePickedPathError(err, filePath);
    await unsentRowOnCore('file', name, message);
    return publishFailure(err, message);
  }
  try {
    const result = await coreCalls().swarmOwnCalls().publish({
      kind: 'file',
      parts: [{ file: filePath, size }],
      name,
      deferred: true,
      history: { type: 'file', name },
    });
    return publishedOnCore(result);
  } catch (err) {
    log.error('[PublishService] Failed to publish file:', err.message);
    return publishFailure(err, describePickedPathError(err, filePath));
  }
}

/** `swarm:publish-directory` on the core's backend, for the picked `dirPath`. */
async function publishDirectoryOnCore(dirPath, name) {
  let files;
  try {
    files = await coreCalls().walkDirectory(dirPath);
  } catch (err) {
    log.error('[PublishService] Failed to publish directory:', err.message);
    const message = describePickedPathError(err, dirPath);
    await unsentRowOnCore('directory', name, message);
    return publishFailure(err, message);
  }
  try {
    const result = await coreCalls().swarmOwnCalls().publish({
      kind: 'collection',
      parts: files.map(({ path: entry, file, size }) => ({ path: entry, file, size })),
      deferred: true,
      history: { type: 'directory', name },
    });
    return publishedOnCore(result);
  } catch (err) {
    log.error('[PublishService] Failed to publish directory:', err.message);
    return publishFailure(err, describePickedPathError(err, dirPath));
  }
}

/**
 * Normalize an UploadResult to a Freedom publish result.
 */
function normalizeUploadResult(result, batchIdUsed, bytesSize) {
  const reference = toHex(result.reference);
  return {
    reference,
    bzzUrl: reference ? `bzz://${reference}` : null,
    tagUid: result.tagUid || null,
    batchIdUsed: batchIdUsed || null,
    bytesSize: bytesSize ?? null,
  };
}

/**
 * Normalize a Bee Tag to a Freedom upload status.
 */
function normalizeTag(tag) {
  const split = tag.split || 0;
  const seen = tag.seen || 0;
  const stored = tag.stored || 0;
  const sent = tag.sent || 0;
  const synced = tag.synced || 0;

  // Use sent (chunks dispatched to network) for progress rather than synced
  // (chunks fully replicated). Synced can lag indefinitely on light nodes.
  const progressRatio = split > 0 ? Math.min(1, sent / split) : 0;

  return {
    tagUid: tag.uid,
    // 128 hex is an encrypted reference (a private draft link).
    ...(/^[a-f0-9]{64}(?:[a-f0-9]{64})?$/i.test(tag.address || '') && { reference: tag.address.toLowerCase() }),
    split,
    seen,
    stored,
    sent,
    synced,
    progress: Math.round(progressRatio * 100),
    // Dispatched chunks are not necessarily acknowledged. Already-seen chunks
    // need no new receipt; newly sent chunks must be synced.
    done: split > 0 && synced + seen >= split,
  };
}

// `encrypt: true` sends `Swarm-Encrypt: true`: the node encrypts every chunk
// and returns a 128-hex reference that carries the decryption key. Used only
// for the Agent's private draft links; it is never set implicitly.
function encryptOption(options) {
  return options.encrypt === true ? { encrypt: true } : {};
}

/**
 * Publish raw data (string or Buffer).
 */
async function publishData(data, options = {}) {
  const bee = getBee();
  const sizeEstimate = Buffer.byteLength(data);
  const batchId = options.batchId || (await selectBestBatch(sizeEstimate, { requireCapacity: true }));

  if (!batchId) {
    throw noUsableBatchError();
  }

  // Use file.upload so the content gets a manifest and is browsable via bzz://
  const result = await bee.file.upload(batchId, data, options.name || 'data', {
    pin: true,
    deferred: false,
    contentType: options.contentType || 'text/plain',
    ...options.uploadOptions,
    ...encryptOption(options),
  });

  return normalizeUploadResult(result, batchId, sizeEstimate);
}

// A page upload's batch lookup stops with it, and gives up on a node that
// doesn't answer: bee-js passes its request options' signal to fetch.
const BATCH_LOOKUP_MS = 30_000;
const batchRequest = (signal) => {
  const timeout = AbortSignal.timeout(BATCH_LOOKUP_MS);
  return { requestOptions: { signal: signal ? AbortSignal.any([signal, timeout]) : timeout } };
};

/**
 * A page's raw data (window.swarm's publishData, a string or a Buffer), as
 * publishData uploads it, but sent by page-upload.js, which makes no copy of
 * the body (freedom-core design 0011, "The size and the charge"; PRQ-7c).
 *
 * `guard(send)`, if given, runs the write itself once the batch is chosen:
 * the caller's last check before anything reaches the node (a page's name,
 * custody, its rule). It resolves what `send` resolves, or null to send
 * nothing, and then this resolves null. `onSend` is told just before the
 * body goes to the node. `signal`, the page request's, stops the batch
 * lookup and the upload (page-upload.js), which also gives up on a node
 * that stalls.
 */
async function publishPageData(data, options = {}) {
  const apiUrl = getAntApiUrl();
  if (!apiUrl) throw new Error('Swarm node is not ready');
  const sizeEstimate = Buffer.byteLength(data);
  const batchId = await selectBestBatch(sizeEstimate, { requireCapacity: true, ...batchRequest(options.signal) });

  if (!batchId) {
    throw noUsableBatchError();
  }

  const send = () => {
    options.onSend?.();
    return pageUpload.uploadData(apiUrl, batchId, data, {
      name: options.name,
      contentType: options.contentType,
      signal: options.signal,
    });
  };
  const result = options.guard ? await options.guard(send) : await send();
  if (!result) return null;
  return normalizeUploadResult(result, batchId, sizeEstimate);
}

/**
 * Publish a file from a filesystem path.
 */
async function publishFile(filePath, options = {}) {
  const bee = getBee();
  const stat = fs.statSync(filePath);
  const batchId = options.batchId || (await selectBestBatch(stat.size, { requireCapacity: true }));

  if (!batchId) {
    throw noUsableBatchError();
  }

  const stream = fs.createReadStream(filePath);
  const name = options.name || path.basename(filePath);
  const contentType = options.contentType || undefined;

  const result = await bee.file.upload(batchId, stream, name, {
    pin: true,
    deferred: true,
    contentType,
    size: stat.size,
    ...options.uploadOptions,
  });

  return normalizeUploadResult(result, batchId, stat.size);
}

/**
 * Publish a directory as a Swarm collection.
 * Auto-detects index.html as the default document.
 */
async function publishDirectory(dirPath, options = {}) {
  const bee = getBee();

  // Estimate total size (async to avoid blocking the event loop)
  const totalSize = await estimateDirSize(dirPath);

  const batchId = options.batchId || (await selectBestBatch(totalSize, { requireCapacity: true }));

  if (!batchId) {
    throw noUsableBatchError();
  }

  // Use explicit indexDocument if provided, otherwise auto-detect index.html
  const indexDocument =
    options.indexDocument ||
    (fs.existsSync(path.join(dirPath, 'index.html')) ? 'index.html' : undefined);

  const result = await bee.collection.uploadFromDirectory(batchId, dirPath, {
    pin: true,
    deferred: true,
    indexDocument,
    ...options.uploadOptions,
  });

  return normalizeUploadResult(result, batchId, totalSize);
}

/**
 * Publish an explicitly assembled collection without exposing filesystem paths
 * to bee-js or writing a staging directory.
 *
 * @param {Array<{path: string, bytes: Buffer, contentType?: string}>} files
 * @param {{ indexDocument?: string }} options
 */
async function publishCollection(files, options = {}) {
  const bee = getBee();
  const totalSize = files.reduce((total, item) => total + item.bytes.byteLength, 0);
  const batchId = options.batchId || (await selectBestBatch(totalSize, { requireCapacity: true }));

  if (!batchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  const indexDocument =
    options.indexDocument ||
    (files.some((item) => item.path === 'index.html') ? 'index.html' : undefined);
  const collection = files.map((item) => ({
    path: item.path,
    size: item.bytes.byteLength,
    file: new File([item.bytes], path.posix.basename(item.path), {
      ...(item.contentType && { type: item.contentType }),
    }),
  }));
  const result = await bee.collection.upload(batchId, collection, {
    pin: true,
    deferred: true,
    indexDocument,
    ...options.uploadOptions,
    ...encryptOption(options),
  });

  return normalizeUploadResult(result, batchId, totalSize);
}

/**
 * Publish a collection of in-memory files (window.swarm's publishFiles) as a
 * Swarm directory manifest: each tar entry is named by the page's own
 * `/`-separated path, on every platform, and nothing is written to disk.
 * Written under a temp directory instead, the files were named by bee-js
 * with the platform's path.join, so on Windows a nested `assets/app.js`
 * reached the node as `assets\app.js` and a nested indexDocument matched
 * nothing (#1052).
 *
 * The archive is the one publishCollection uploads through bee-js, sent by
 * page-upload.js instead, in views of the page's bytes: bee-js' tar writer
 * copied each file twice more, and fetch its stream's chunks, past the
 * upload's charge (freedom-core design 0011, "The size and the charge";
 * PRQ-7c). `guard`, `onSend` and `signal` are as for publishPageData.
 *
 * The batch is chosen here, so that having none reads as noUsableBatchError,
 * as for the other page uploads.
 *
 * Note: per-file contentType is accepted in the file objects but not currently
 * applied — the node infers MIME types from extensions.
 * Files with non-standard names should use appropriate extensions.
 *
 * @param {Array<{path: string, bytes: Buffer, contentType?: string}>} files
 * @param {{ indexDocument?: string, guard?: Function, onSend?: () => void, signal?: AbortSignal }} options
 */
async function publishFilesFromContent(files, options = {}) {
  const apiUrl = getAntApiUrl();
  if (!apiUrl) throw new Error('Swarm node is not ready');
  const totalSize = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  const batchId = await selectBestBatch(totalSize, { requireCapacity: true, ...batchRequest(options.signal) });
  if (!batchId) {
    throw noUsableBatchError();
  }

  const indexDocument =
    options.indexDocument ||
    (files.some((item) => item.path === 'index.html') ? 'index.html' : undefined);
  const send = () => {
    options.onSend?.();
    return pageUpload.uploadCollection(apiUrl, batchId, files, { indexDocument, signal: options.signal });
  };
  const result = options.guard ? await options.guard(send) : await send();
  if (!result) return null;
  return normalizeUploadResult(result, batchId, totalSize);
}

/**
 * Estimate total size of a directory tree without blocking the event loop.
 */
async function estimateDirSize(dirPath) {
  let total = 0;
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await estimateDirSize(full);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full);
      total += stat.size;
    }
  }
  return total;
}

/**
 * Get upload progress for a tag.
 */
async function getUploadStatus(tagUid) {
  const bee = getBee();
  const tag = await bee.tag.get(tagUid, { timeout: 10_000 });
  return normalizeTag(tag);
}

/**
 * Register IPC handlers for publish operations.
 *
 * SECURITY INVARIANT — INTERNAL CALLERS ONLY
 * ==========================================
 * These handlers (swarm:publish-data/file/directory, swarm:pick-file/directory,
 * swarm:get-upload-status, swarm:get-stamps, swarm:get-publish-history,
 * swarm:clear-publish-history) publish the user's own files and bypass the
 * per-origin permission model that guards window.swarm.* for arbitrary pages.
 *
 * swarm:publish-file / swarm:publish-directory never take a filesystem path:
 * they take only a pick token minted by swarm:pick-file / swarm:pick-directory
 * for the same sender (see publish-pick-tokens.js), so even a script injected
 * into an internal page can publish nothing the user did not just choose in a
 * native dialog.
 *
 * They MUST only be reachable from trusted internal contexts:
 *
 *   - The shell renderer (Freedom's own UI) via src/main/preload.js, which
 *     is not injected into webviews.
 *   - Internal app pages opened in a webview: webview-preload.js wraps
 *     freedomAPI.swarm.* in guardInternal(), which calls isInternalPage().
 *     That allows only bundled pages loaded as file: URLs whose pathname ends
 *     with /pages/<file> for a whitelisted file from internal-pages.json
 *     (e.g. publish.html for freedom://publish in the address bar). Arbitrary
 *     https://, bzz://, etc. in the webview does not pass the guard.
 *
 * Arbitrary web content MUST NOT be able to reach these handlers — it must
 * go through swarm-provider-ipc.js (window.swarm.*), which enforces origin
 * permissions, size limits, and pre-flight checks.
 *
 * If you add a new handler here, preserve this invariant: never expose it
 * to webview-preload.js without guardInternal(), and never to arbitrary
 * pages at all.
 */
function registerPublishIpc() {
  // PRIVATE MODE GUARD (publish history): publishing is unavailable from
  // private windows — every publish writes a publish-history row (and mints
  // durable network state tied to the profile identity), which contradicts
  // the private-window promise of leaving no local trace.
  const PRIVATE_PUBLISH_ERROR = {
    success: false,
    error: 'Publishing is unavailable in private windows',
  };
  const isPrivateSender = (event) => isPrivateWebContents(event?.sender);

  // One-time, short-lived, sender-bound pick tokens (S-7, #660).
  const pickTokens = createPickTokenStore();
  const trackedSenders = new WeakSet();
  const revokeOnDestroy = (sender) => {
    if (trackedSenders.has(sender) || typeof sender?.once !== 'function') return;
    trackedSenders.add(sender);
    const senderId = sender.id;
    sender.once('destroyed', () => pickTokens.revokeSender(senderId));
  };
  const PICK_EXPIRED_ERROR = 'That selection is no longer valid. Choose the file or folder again.';
  const redeemPick = (event, token, kind) => {
    if (!token || typeof token !== 'string') {
      return { error: kind === 'file' ? 'Choose a file to publish' : 'Choose a folder to publish' };
    }
    const result = pickTokens.redeem(token, { kind, senderId: event?.sender?.id });
    return result.error ? { error: PICK_EXPIRED_ERROR } : result;
  };

  ipcMain.handle('swarm:publish-data', async (event, data) => {
    if (isPrivateSender(event)) return PRIVATE_PUBLISH_ERROR;
    if (!data && data !== '') {
      return { success: false, error: 'Data is required' };
    }
    if (publishesOnCore()) return publishDataOnCore(data);
    const added = writeHistory('addEntry', {
      type: 'data',
      name: 'Text',
      status: 'uploading',
      origin: USER_ORIGIN,
    });
    const historyEntry = isThenable(added) ? await added : added;
    try {
      const result = await publishData(data);
      const completed = writeHistory('updateEntry', historyEntry.id, {
        status: 'completed',
        ...result,
      });
      if (isThenable(completed)) await completed;
      return {
        success: true,
        reference: result.reference,
        bzzUrl: result.bzzUrl,
        tagUid: result.tagUid,
      };
    } catch (err) {
      log.error('[PublishService] Failed to publish data:', err.message);
      const failed = writeHistory('updateEntry', historyEntry.id, {
        status: 'failed',
        errorMessage: err.message,
      });
      if (isThenable(failed)) await failed;
      return publishFailure(err);
    }
  });

  ipcMain.handle('swarm:publish-file', async (event, token) => {
    if (isPrivateSender(event)) return PRIVATE_PUBLISH_ERROR;
    const redeemed = redeemPick(event, token, 'file');
    if (redeemed.error) return { success: false, error: redeemed.error };
    const filePath = redeemed.path;
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${path.basename(filePath)}` };
    }
    const name = path.basename(filePath);
    if (publishesOnCore()) return publishFileOnCore(filePath, name);
    const added = writeHistory('addEntry', {
      type: 'file',
      name,
      status: 'uploading',
      origin: USER_ORIGIN,
    });
    const historyEntry = isThenable(added) ? await added : added;
    try {
      const result = await publishFile(filePath);
      const completed = writeHistory('updateEntry', historyEntry.id, {
        status: 'completed',
        ...result,
      });
      if (isThenable(completed)) await completed;
      return {
        success: true,
        reference: result.reference,
        bzzUrl: result.bzzUrl,
        tagUid: result.tagUid,
      };
    } catch (err) {
      log.error('[PublishService] Failed to publish file:', err.message);
      const message = describePickedPathError(err, filePath);
      const failed = writeHistory('updateEntry', historyEntry.id, {
        status: 'failed',
        errorMessage: message,
      });
      if (isThenable(failed)) await failed;
      return publishFailure(err, message);
    }
  });

  ipcMain.handle('swarm:publish-directory', async (event, token) => {
    if (isPrivateSender(event)) return PRIVATE_PUBLISH_ERROR;
    const redeemed = redeemPick(event, token, 'directory');
    if (redeemed.error) return { success: false, error: redeemed.error };
    const dirPath = redeemed.path;
    // statSync can still throw if the folder vanishes after existsSync; a
    // thrown error would reject the invoke with the absolute path in it.
    let isDir;
    try {
      isDir = fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { success: false, error: `Directory not found: ${path.basename(dirPath)}` };
    }
    const name = path.basename(dirPath);
    if (publishesOnCore()) return publishDirectoryOnCore(dirPath, name);
    const added = writeHistory('addEntry', {
      type: 'directory',
      name,
      status: 'uploading',
      origin: USER_ORIGIN,
    });
    const historyEntry = isThenable(added) ? await added : added;
    try {
      const result = await publishDirectory(dirPath);
      const completed = writeHistory('updateEntry', historyEntry.id, {
        status: 'completed',
        ...result,
      });
      if (isThenable(completed)) await completed;
      return {
        success: true,
        reference: result.reference,
        bzzUrl: result.bzzUrl,
        tagUid: result.tagUid,
      };
    } catch (err) {
      log.error('[PublishService] Failed to publish directory:', err.message);
      const message = describePickedPathError(err, dirPath);
      const failed = writeHistory('updateEntry', historyEntry.id, {
        status: 'failed',
        errorMessage: message,
      });
      if (isThenable(failed)) await failed;
      return publishFailure(err, message);
    }
  });

  ipcMain.handle('swarm:get-upload-status', async (_event, tagUid) => {
    try {
      if (!tagUid || typeof tagUid !== 'number') {
        return { success: false, error: 'Tag UID is required' };
      }
      const status = publishesOnCore()
        ? await coreCalls().swarmOwnCalls().uploadStatus(tagUid, {
            signal: AbortSignal.timeout(UPLOAD_STATUS_MS),
          })
        : await getUploadStatus(tagUid);
      return { success: true, ...status };
    } catch (err) {
      log.error('[PublishService] Failed to get upload status:', err.message);
      return { success: false, error: err.message };
    }
  });

  // The pickers answer with a token, never the chosen path: the path stays
  // here until the same sender spends the token on a publish.
  const pickHandler = (kind) => async (event) => {
    try {
      const senderId = event?.sender?.id;
      if (!Number.isInteger(senderId)) {
        return { success: false, error: 'Unknown sender' };
      }
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win, {
        properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
        title: kind === 'file' ? 'Select a file to publish' : 'Select a folder to publish',
      });
      if (result.canceled || !result.filePaths?.length) {
        return { success: true, token: null };
      }
      const pickedPath = result.filePaths[0];
      revokeOnDestroy(event.sender);
      const token = pickTokens.mint({ path: pickedPath, kind, senderId });
      return { success: true, token, name: path.basename(pickedPath) };
    } catch (err) {
      log.error(`[PublishService] ${kind === 'file' ? 'File' : 'Directory'} picker failed:`, err.message);
      return { success: false, error: err.message };
    }
  };

  ipcMain.handle('swarm:pick-file', pickHandler('file'));
  ipcMain.handle('swarm:pick-directory', pickHandler('directory'));

  log.info('[PublishService] IPC handlers registered');
}

module.exports = {
  normalizeUploadResult,
  normalizeTag,
  publishData,
  publishPageData,
  publishFile,
  publishDirectory,
  publishCollection,
  publishFilesFromContent,
  getUploadStatus,
  registerPublishIpc,
  USER_ORIGIN,
};
