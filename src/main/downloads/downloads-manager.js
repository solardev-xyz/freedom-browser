/**
 * Downloads manager. Hooks `will-download` on a session (the app runs all
 * webviews on the default session — see src/main/index.js) and owns the
 * DownloadItem lifecycle: save-path selection, progress, pause / resume /
 * cancel, and the completed / cancelled / interrupted terminal states.
 *
 * `protocol.handle`-served custom schemes (bzz:, ipfs:, ipns:) route their
 * downloads through the Chromium download manager too, so decentralized
 * downloads land here alongside http(s) ones — verified against Electron 43
 * for attachment dispositions, `download`-attribute clicks, data: URIs, and
 * non-renderable main-frame navigations.
 *
 * Persistence lives in downloads-store.js (per-profile downloads.sqlite)
 * for normal windows only. PRIVATE MODE GUARD (downloads): downloads from
 * private windows never touch SQLite — their rows live in the in-memory
 * private-downloads-store, scoped to the window's partition, merged into
 * query results served to that window's renderers alone, and dropped when
 * the window closes. Ids route by sign: SQLite rowids are positive, private
 * in-memory ids are negative.
 *
 * Completed files are never opened automatically; open / show-in-folder are
 * explicit user actions arriving over IPC and resolved against the stored
 * row, never against a renderer-supplied path.
 */

const log = require('../logger');
const { app, ipcMain, shell, BrowserWindow, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const store = require('./downloads-store');
const privateStore = require('./private-downloads-store');
const { getPartitionForWebContents } = require('../private/private-windows');
const { loadSettings } = require('../settings-store');
const { broadcastToAllWebContents } = require('../lib/broadcast-to-all-webcontents');

// Live DownloadItems by store row id — pause/resume/cancel IPC resolves
// through this map; settled items are removed.
const activeItems = new Map();

// Per-item bookkeeping for the live items above: the owning private
// partition (null for normal windows) and the save path the item claimed.
// Lets a closing private window cancel and unwind its own transfers without
// waiting for Chromium's asynchronous 'done'.
const activeItemMeta = new Map();

// Store row ids whose live DownloadItem is in Chromium's 'interrupted'
// updated-state: still live (not `done`), usually resumable, but not
// transferring. Kept out of activeItems so pause/resume/cancel stay simple.
const interruptedItems = new Set();

// Save paths claimed by in-flight downloads. Chromium creates the file
// lazily, so an existsSync check alone misses a sibling download that picked
// the same path moments earlier — two same-name downloads would then write
// the same file and silently clobber each other.
const reservedSavePaths = new Set();

// Reservation keys are case-folded where the default filesystem is
// case-insensitive (Windows, macOS): Report.PDF and report.pdf resolve to
// the same file there, so they must contend for the same claim.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const savePathKey = (savePath) => (CASE_INSENSITIVE_FS ? savePath.toLowerCase() : savePath);

// Progress writes/broadcasts are throttled per item so a fast download
// doesn't flood SQLite and IPC. Terminal transitions always flush.
const PROGRESS_THROTTLE_MS = 250;

/**
 * Sanitize a server/URL-suggested filename: strip directory components
 * (path traversal), control characters, and leading dots, and cap the
 * length. Falls back to 'download' when nothing usable remains.
 * @param {string} name - Suggested filename
 * @returns {string} Safe basename
 */
function sanitizeFilename(name) {
  let base = String(name || '');
  // Directory components — take the final segment of either separator.
  base = base.split(/[/\\]/).pop() || '';
  // Control characters and characters that break paths on some platforms.
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/[<>:"|?*]/g, '_');
  // Leading dots (hidden files / '..' remnants), trailing dots (dropped or
  // path-breaking on Windows), and surrounding whitespace.
  base = base.replace(/^\.+/, '').trim().replace(/[. ]+$/, '');
  // Windows reserved device names (bare or with any extension) would target
  // a device path or die as an unexplained interrupted download — defang by
  // prefixing rather than rejecting.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(base)) {
    base = '_' + base;
  }
  if (base.length > 255) {
    const ext = path.extname(base).slice(0, 32);
    base = base.slice(0, 255 - ext.length) + ext;
  }
  return base || 'download';
}

/**
 * Pick a collision-free path in `dir` for `filename` by appending " (n)"
 * before the extension, matching Chromium's behavior, and claim it for the
 * caller. The claim covers the window between choosing a path and Chromium
 * actually creating the file, during which `existsSync` still reports the
 * path as free; release it with `releaseSavePath` once the item settles.
 * @param {string} dir - Target directory
 * @param {string} filename - Sanitized filename
 * @returns {string} Absolute path that neither exists nor is claimed yet
 */
function uniqueSavePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let counter = 1;
  while (reservedSavePaths.has(savePathKey(candidate)) || fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${counter})${ext}`);
    counter++;
  }
  reservedSavePaths.add(savePathKey(candidate));
  return candidate;
}

/**
 * Drop an in-flight claim made by `uniqueSavePath`. A completed download's
 * file is on disk by then, so `existsSync` takes over the dedupe duty; a
 * cancelled / interrupted one frees the name outright.
 * @param {string|null} savePath
 */
function releaseSavePath(savePath) {
  if (savePath) reservedSavePaths.delete(savePathKey(savePath));
}

/**
 * Map a live DownloadItem to the renderer-facing payload. Shape matches the
 * store rows (snake_case columns) so the downloads page renders both the
 * same way, plus live-only flags for pause/resume affordances.
 */
function serializeDownload(id, item, { isPrivate = false } = {}) {
  return {
    id,
    url: item.getURL(),
    filename: path.basename(item.getSavePath() || '') || sanitizeFilename(item.getFilename()),
    save_path: item.getSavePath() || null,
    mime_type: item.getMimeType() || null,
    total_bytes: item.getTotalBytes(),
    received_bytes: item.getReceivedBytes(),
    state: store.STATES.IN_PROGRESS,
    is_paused: item.isPaused(),
    can_resume: item.canResume(),
    // Live-but-stalled: the transfer broke mid-session and Chromium has not
    // given up on the item yet. The UI must offer Resume, not Pause.
    is_interrupted: interruptedItems.has(id),
    is_private: isPrivate ? 1 : 0,
  };
}

function ownerWindowOf(webContents) {
  if (!webContents) return null;
  // Webview-initiated downloads: the shelf lives in the hosting chrome
  // renderer, so resolve through hostWebContents when present.
  const host = webContents.hostWebContents || webContents;
  return BrowserWindow.fromWebContents(host);
}

function sendToOwner(ownerWindow, payload, privatePartition = null) {
  if (ownerWindow && !ownerWindow.isDestroyed()) {
    ownerWindow.webContents.send(IPC.DOWNLOADS_UPDATED, payload);
  }
  if (privatePartition) {
    // PRIVATE MODE GUARD (downloads): change hints for private downloads
    // carry URL and save-path metadata — deliver them only to renderers of
    // the owning private window, never to normal windows.
    if (!webContents?.getAllWebContents) return;
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (getPartitionForWebContents(wc) === privatePartition) {
          wc.send(IPC.DOWNLOADS_CHANGED, payload);
        }
      } catch {
        // webContents may be destroyed mid-iteration
      }
    }
    return;
  }
  // The freedom://downloads page may be open in any window; it re-queries
  // the store on this signal.
  broadcastToAllWebContents(IPC.DOWNLOADS_CHANGED, payload);
}

function handleWillDownload(item, webContents, { privatePartition = null } = {}) {
  const filename = sanitizeFilename(item.getFilename());
  const settings = loadSettings();
  const downloadsDir = app.getPath('downloads');
  let reservedPath = null;
  const isPrivate = !!privatePartition;

  if (settings.askWhereToSave === true) {
    // No savePath set → Electron shows its native save dialog; we only seed
    // the suggested location. Cancelling the dialog cancels the item.
    item.setSaveDialogOptions({ defaultPath: path.join(downloadsDir, filename) });
  } else {
    try {
      fs.mkdirSync(downloadsDir, { recursive: true });
    } catch (err) {
      log.warn('[Downloads] Could not ensure downloads dir:', err.message);
    }
    reservedPath = uniqueSavePath(downloadsDir, filename);
    item.setSavePath(reservedPath);
  }

  // PRIVATE MODE GUARD (downloads): downloads from private windows are
  // allowed, but their metadata (URL, save path) must never be written to
  // the profile database — a crash would strand the rows, and SQLite
  // DELETE/WAL does not scrub previously written pages. Private rows live
  // in the in-memory partition-scoped store instead and evaporate with the
  // window (src/main/index.js registers the dropPartition close hook).
  const rowStore = isPrivate ? privateStore : store;
  const row = rowStore.insertDownload({
    url: item.getURL(),
    filename,
    savePath: item.getSavePath() || null,
    mimeType: item.getMimeType() || null,
    totalBytes: item.getTotalBytes(),
    startTime: Date.now(),
    partition: privatePartition,
  });
  const id = row.id;
  activeItems.set(id, item);
  activeItemMeta.set(id, { privatePartition, reservedPath });

  const ownerWindow = ownerWindowOf(webContents);
  // PRIVATE MODE GUARD (download logging): the row lives in the in-memory
  // private store precisely so nothing durable records what was fetched —
  // logging the filename to the persistent main.log would reinstate exactly
  // that trace, and outlive the window. Log the id only.
  const logName = isPrivate ? '<private>' : filename;
  log.info('[Downloads] Download started:', logName, `(id ${id})`);
  sendToOwner(ownerWindow, serializeDownload(id, item, { isPrivate }), privatePartition);

  let lastProgressAt = 0;
  let lastUpdatedState = 'progressing';
  item.on('updated', (_updatedEvent, updatedState) => {
    // Electron reports 'progressing' | 'interrupted' here. An 'interrupted'
    // item is NOT done — Chromium keeps it around and `canResume()` is often
    // true — so it must stop rendering as a live transfer (whose Pause button
    // Chromium ignores) and start offering Resume instead. State flips are
    // rare and user-visible, so they flush past the progress throttle.
    const nextState = updatedState === 'interrupted' ? 'interrupted' : 'progressing';
    const stateChanged = nextState !== lastUpdatedState;
    lastUpdatedState = nextState;
    if (nextState === 'interrupted') interruptedItems.add(id);
    else interruptedItems.delete(id);

    const now = Date.now();
    if (!stateChanged && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;

    rowStore.updateDownload(id, {
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      // The save dialog resolves the path after insert; keep the row current.
      savePath: item.getSavePath() || null,
    });
    sendToOwner(ownerWindow, serializeDownload(id, item, { isPrivate }), privatePartition);
  });

  item.once('done', (_doneEvent, doneState) => {
    // `cancelPartitionDownloads` (private-window close) force-unwinds items
    // synchronously and releases their path claim there; Chromium's 'done'
    // then arrives afterwards for the very same item. `reservedSavePaths` is
    // a plain Set, not refcounted, so a second release would free whatever
    // *new* download had meanwhile reserved the same path — and a third
    // same-named download would be handed that identical path, leaving two
    // transfers writing one file. The unwind clears `activeItemMeta`, so its
    // membership is the "do we still own the claim?" flag.
    const ownsReservation = activeItemMeta.has(id);
    activeItems.delete(id);
    activeItemMeta.delete(id);
    interruptedItems.delete(id);
    if (ownsReservation) releaseSavePath(reservedPath);

    // Electron reports 'completed' | 'cancelled' | 'interrupted'; the store
    // uses the same vocabulary (snake-cased in_progress aside).
    const state =
      doneState === 'completed'
        ? store.STATES.COMPLETED
        : doneState === 'cancelled'
          ? store.STATES.CANCELLED
          : store.STATES.INTERRUPTED;

    rowStore.updateDownload(id, {
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      savePath: item.getSavePath() || null,
      state,
      endTime: Date.now(),
    });

    log.info('[Downloads] Download', doneState + ':', logName, `(id ${id})`);
    sendToOwner(
      ownerWindow,
      {
        ...serializeDownload(id, item, { isPrivate }),
        state,
        is_paused: false,
        can_resume: false,
        is_interrupted: false,
      },
      privatePartition
    );
  });
}

/**
 * Hook `will-download` on the given session. Call once per session that
 * hosts downloadable content: the default session at startup, and every
 * private window's `private-<uuid>` session when it is created (see
 * src/main/index.js) — private partitions must be covered too, or their
 * downloads would silently bypass the manager.
 * @param {Electron.Session} targetSession
 * @param {{ privatePartition?: string|null }} [options] - set for private
 *   sessions so their rows stay in the in-memory partition store and never
 *   reach the profile database
 */
function attachDownloadsManager(targetSession, { privatePartition = null } = {}) {
  if (!targetSession || typeof targetSession.on !== 'function') {
    log.warn('[Downloads] session unavailable — skipping will-download hook');
    return;
  }
  targetSession.on('will-download', (_event, item, webContents) =>
    handleWillDownload(item, webContents, { privatePartition })
  );
  log.info(
    '[Downloads] will-download hook attached' + (privatePartition ? ' (private session)' : '')
  );
}

/**
 * PRIVATE MODE GUARD (downloads): cancel every in-flight download owned by a
 * private partition. Runs from the private-window close hook (registered in
 * src/main/index.js, before the in-memory rows are dropped).
 *
 * Without this a transfer started in a private window outlives the window
 * that owned it: its row disappears with the partition, so no renderer can
 * see it and pause/cancel refuse it (they authorize against that row), yet
 * Chromium keeps writing bytes to disk and a completed file would appear
 * with no record anywhere. Cancelling also discards the partial file and
 * frees the save-path reservation.
 * @param {string} partition
 * @returns {number} Number of items cancelled
 */
function cancelPartitionDownloads(partition) {
  if (!partition) return 0;
  let cancelled = 0;
  for (const [id, meta] of [...activeItemMeta]) {
    if (meta.privatePartition !== partition) continue;
    const item = activeItems.get(id);
    activeItems.delete(id);
    activeItemMeta.delete(id);
    interruptedItems.delete(id);
    releaseSavePath(meta.reservedPath);
    try {
      item?.cancel();
      cancelled++;
    } catch (err) {
      log.warn('[Downloads] Could not cancel private download', id + ':', err?.message || err);
    }
  }
  if (cancelled > 0) {
    log.info(`[Downloads] Cancelled ${cancelled} in-flight private download(s) on ${partition}`);
  }
  return cancelled;
}

/**
 * Merge live pause/resume flags onto stored rows so the downloads page can
 * offer the right controls without a second live-state channel.
 */
function withLiveFlags(rows) {
  return rows.map((dbRow) => {
    const item = activeItems.get(dbRow.id);
    if (!item) return dbRow;
    return {
      ...dbRow,
      received_bytes: item.getReceivedBytes(),
      total_bytes: item.getTotalBytes(),
      is_paused: item.isPaused(),
      can_resume: item.canResume(),
      is_interrupted: interruptedItems.has(dbRow.id),
    };
  });
}

/**
 * Resolve a row for an id-based IPC request. Negative ids are in-memory
 * private rows; only renderers of the owning private window may act on
 * them — any other sender resolves to null. Positive ids are SQLite rows.
 */
function resolveRowForSender(event, id) {
  if (typeof id === 'number' && id < 0) {
    const row = privateStore.getDownloadById(id);
    if (!row || getPartitionForWebContents(event?.sender) !== row.session_partition) {
      return null;
    }
    return row;
  }
  return store.getDownloadById(id);
}

/**
 * Resolve a live DownloadItem for an id-based IPC request, enforcing the
 * same ownership rule as resolveRowForSender: private ids are predictable
 * negative integers, so pause / resume / cancel must refuse senders outside
 * the owning private window's partition just like open / show / remove do.
 */
function resolveActiveItemForSender(event, id) {
  if (!resolveRowForSender(event, id)) return null;
  return activeItems.get(id) || null;
}

/**
 * Register IPC handlers for download operations
 */
function registerDownloadsIpc() {
  // Crash recovery: rows a previous run left in_progress are dead.
  store.markStaleInProgressAsInterrupted();
  // Legacy sweep: builds before the in-memory private store wrote private
  // rows into SQLite; drop any still lingering. Current code never inserts
  // them (see handleWillDownload), so this only cleans up old profiles.
  store.removeAllPrivateDownloads();

  ipcMain.handle(IPC.DOWNLOADS_GET, (event, options = {}) => {
    const { query, limit } = options;
    const max = limit || 100;
    let rows = query ? store.searchDownloads(query, max) : store.getAllDownloads();
    // PRIVATE MODE GUARD (downloads): in-memory private rows are merged in
    // only for renderers of the owning private window; normal windows (and
    // other private windows) never see them.
    const partition = getPartitionForWebContents(event?.sender);
    if (partition) {
      const privateRows = query
        ? privateStore.searchDownloads(partition, query, max)
        : privateStore.getDownloads(partition);
      if (privateRows.length > 0) {
        rows = [...privateRows, ...rows].sort((a, b) => b.start_time - a.start_time);
        if (query) rows = rows.slice(0, max);
      }
    }
    return withLiveFlags(rows);
  });

  // Live controls authorize through the stored row too: a private row's
  // item is only reachable from renderers of the owning private window.
  ipcMain.handle(IPC.DOWNLOADS_PAUSE, (event, id) => {
    const item = resolveActiveItemForSender(event, id);
    // Chromium ignores pause() on an interrupted item — refuse rather than
    // pretend it worked.
    if (!item || interruptedItems.has(id)) return false;
    item.pause();
    return true;
  });

  ipcMain.handle(IPC.DOWNLOADS_RESUME, (event, id) => {
    const item = resolveActiveItemForSender(event, id);
    if (!item || !item.canResume()) return false;
    item.resume();
    return true;
  });

  ipcMain.handle(IPC.DOWNLOADS_CANCEL, (event, id) => {
    const item = resolveActiveItemForSender(event, id);
    if (!item) return false;
    item.cancel();
    return true;
  });

  // Open and show-in-folder resolve the path from the stored row — a
  // renderer can only ever act on files this manager wrote, never on an
  // arbitrary path. Files are never opened without this explicit request.
  ipcMain.handle(IPC.DOWNLOADS_OPEN_FILE, async (event, id) => {
    const row = resolveRowForSender(event, id);
    if (!row || row.state !== store.STATES.COMPLETED || !row.save_path) {
      return { success: false, error: 'Download is not completed' };
    }
    if (!fs.existsSync(row.save_path)) {
      return { success: false, error: 'File no longer exists' };
    }
    const openError = await shell.openPath(row.save_path);
    if (openError) {
      return { success: false, error: openError };
    }
    return { success: true };
  });

  ipcMain.handle(IPC.DOWNLOADS_SHOW_IN_FOLDER, (event, id) => {
    const row = resolveRowForSender(event, id);
    if (!row || !row.save_path || !fs.existsSync(row.save_path)) {
      return { success: false, error: 'File no longer exists' };
    }
    shell.showItemInFolder(row.save_path);
    return { success: true };
  });

  ipcMain.handle(IPC.DOWNLOADS_REMOVE, (event, id) => {
    // Removing from the list never deletes the file, and an in-flight
    // download must be cancelled first so its row can't be orphaned.
    if (activeItems.has(id)) return false;
    if (typeof id === 'number' && id < 0) {
      return resolveRowForSender(event, id) ? privateStore.removeDownload(id) : false;
    }
    return store.removeDownload(id);
  });

  ipcMain.handle(IPC.DOWNLOADS_CLEAR, (event) => {
    let cleared = store.clearDownloads();
    // A private window's "Clear All" also drops its own settled in-memory
    // rows (they are part of the merged view it sees).
    const partition = getPartitionForWebContents(event?.sender);
    if (partition) {
      cleared += privateStore.clearSettled(partition);
    }
    return cleared;
  });

  log.info('[Downloads] IPC handlers registered');
}

module.exports = {
  attachDownloadsManager,
  cancelPartitionDownloads,
  registerDownloadsIpc,
  sanitizeFilename,
  uniqueSavePath,
};
