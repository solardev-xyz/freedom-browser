/**
 * Publish Service
 *
 * Upload operations via bee-js: data, files, and directories.
 * All uploads use auto batch selection and return normalized results.
 * Runs in the main process only — renderer interacts via IPC.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { ipcMain, dialog, BrowserWindow } = require('electron');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');
const { addEntry, updateEntry } = require('./publish-history');
const log = require('electron-log');

/**
 * Normalize an UploadResult to a Freedom publish result.
 */
function normalizeUploadResult(result, batchIdUsed) {
  const reference = toHex(result.reference);
  return {
    reference,
    bzzUrl: reference ? `bzz://${reference}` : null,
    tagUid: result.tagUid || null,
    batchIdUsed: batchIdUsed || null,
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
    split,
    seen,
    stored,
    sent,
    synced,
    progress: Math.round(progressRatio * 100),
    done: split > 0 && sent >= split,
  };
}

/**
 * Publish raw data (string or Buffer).
 */
async function publishData(data, options = {}) {
  const bee = getBee();
  const sizeEstimate = Buffer.byteLength(data);
  const batchId = options.batchId || await selectBestBatch(sizeEstimate);

  if (!batchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  // Use uploadFile so the content gets a manifest and is browsable via bzz://
  const result = await bee.uploadFile(batchId, data, options.name || 'data', {
    pin: true,
    deferred: false,
    contentType: options.contentType || 'text/plain',
    ...options.uploadOptions,
  });

  return normalizeUploadResult(result, batchId);
}

/**
 * Publish a file from a filesystem path.
 */
async function publishFile(filePath, options = {}) {
  const bee = getBee();
  const stat = fs.statSync(filePath);
  const batchId = options.batchId || await selectBestBatch(stat.size);

  if (!batchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  const stream = fs.createReadStream(filePath);
  const name = path.basename(filePath);
  const contentType = options.contentType || undefined;

  const result = await bee.uploadFile(batchId, stream, name, {
    pin: true,
    deferred: true,
    contentType,
    size: stat.size,
    ...options.uploadOptions,
  });

  return normalizeUploadResult(result, batchId);
}

/**
 * Publish a directory as a Swarm collection.
 * Auto-detects index.html as the default document.
 */
async function publishDirectory(dirPath, options = {}) {
  const bee = getBee();

  // Estimate total size (async to avoid blocking the event loop)
  const totalSize = await estimateDirSize(dirPath);

  const batchId = options.batchId || await selectBestBatch(totalSize);

  if (!batchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  // Use explicit indexDocument if provided, otherwise auto-detect index.html
  const indexDocument = options.indexDocument ||
    (fs.existsSync(path.join(dirPath, 'index.html')) ? 'index.html' : undefined);

  const result = await bee.uploadFilesFromDirectory(batchId, dirPath, {
    pin: true,
    deferred: true,
    indexDocument,
    ...options.uploadOptions,
  });

  return normalizeUploadResult(result, batchId);
}

/**
 * Publish a collection of in-memory files as a Swarm directory manifest.
 * Writes files to a temp directory, delegates to publishDirectory, cleans up.
 *
 * Note: per-file contentType is accepted in the file objects but not currently
 * applied — bee-js uploadFilesFromDirectory infers MIME types from extensions.
 * Files with non-standard names should use appropriate extensions.
 *
 * @param {Array<{path: string, bytes: Buffer, contentType?: string}>} files
 * @param {{ indexDocument?: string }} options
 */
async function publishFilesFromContent(files, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-swarm-publish-'));

  try {
    for (const file of files) {
      const filePath = path.join(tempDir, file.path);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, file.bytes);
    }

    return await publishDirectory(tempDir, {
      indexDocument: options.indexDocument,
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      log.error('[PublishService] Failed to clean up temp dir:', err.message);
    }
  }
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
  const tag = await bee.retrieveTag(tagUid);
  return normalizeTag(tag);
}

/**
 * Register IPC handlers for publish operations.
 *
 * SECURITY INVARIANT — INTERNAL CALLERS ONLY
 * ==========================================
 * These handlers (swarm:publish-data/file/directory, swarm:pick-file/directory,
 * swarm:get-upload-status, swarm:get-stamps, swarm:get-publish-history,
 * swarm:clear-publish-history) accept raw filesystem paths and bypass the
 * per-origin permission model that guards window.swarm.* for arbitrary pages.
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
  ipcMain.handle('swarm:publish-data', async (_event, data) => {
    if (!data && data !== '') {
      return { success: false, error: 'Data is required' };
    }
    const historyEntry = addEntry({ type: 'data', name: 'Text', status: 'uploading' });
    try {
      const result = await publishData(data);
      updateEntry(historyEntry.id, { status: 'completed', ...result });
      return { success: true, ...result };
    } catch (err) {
      log.error('[PublishService] Failed to publish data:', err.message);
      updateEntry(historyEntry.id, { status: 'failed' });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:publish-file', async (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'File path is required' };
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    const name = path.basename(filePath);
    const historyEntry = addEntry({ type: 'file', name, status: 'uploading' });
    try {
      const result = await publishFile(filePath);
      updateEntry(historyEntry.id, { status: 'completed', ...result });
      return { success: true, ...result };
    } catch (err) {
      log.error('[PublishService] Failed to publish file:', err.message);
      updateEntry(historyEntry.id, { status: 'failed' });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:publish-directory', async (_event, dirPath) => {
    if (!dirPath || typeof dirPath !== 'string') {
      return { success: false, error: 'Directory path is required' };
    }
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { success: false, error: `Directory not found: ${dirPath}` };
    }
    const name = path.basename(dirPath);
    const historyEntry = addEntry({ type: 'directory', name, status: 'uploading' });
    try {
      const result = await publishDirectory(dirPath);
      updateEntry(historyEntry.id, { status: 'completed', ...result });
      return { success: true, ...result };
    } catch (err) {
      log.error('[PublishService] Failed to publish directory:', err.message);
      updateEntry(historyEntry.id, { status: 'failed' });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:get-upload-status', async (_event, tagUid) => {
    try {
      if (!tagUid || typeof tagUid !== 'number') {
        return { success: false, error: 'Tag UID is required' };
      }
      const status = await getUploadStatus(tagUid);
      return { success: true, ...status };
    } catch (err) {
      log.error('[PublishService] Failed to get upload status:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:pick-file', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        title: 'Select a file to publish',
      });
      if (result.canceled || !result.filePaths?.length) {
        return { success: true, path: null };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (err) {
      log.error('[PublishService] File picker failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:pick-directory', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select a folder to publish',
      });
      if (result.canceled || !result.filePaths?.length) {
        return { success: true, path: null };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (err) {
      log.error('[PublishService] Directory picker failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  log.info('[PublishService] IPC handlers registered');
}

module.exports = {
  normalizeUploadResult,
  normalizeTag,
  publishData,
  publishFile,
  publishDirectory,
  publishFilesFromContent,
  getUploadStatus,
  registerPublishIpc,
};
