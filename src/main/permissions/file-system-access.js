/**
 * File System Access grants (#671): `showOpenFilePicker`,
 * `showSaveFilePicker` and `showDirectoryPicker` on a site.
 *
 * Electron decides File System Access in two places, and neither one is
 * the shape the other permissions have (measured in Electron 44.7.0 with a
 * probe page driven through a stub file-chooser portal):
 *
 *   - The CHECK handler is the grant. Once a session has a permission check
 *     handler, Electron's `PermissionGrantImpl::GetStatus()` returns that
 *     handler's answer for `fileSystem` + {filePath, isDirectory,
 *     fileAccessType} and ignores the status the picker itself set. Every
 *     `getFile()`, `createWritable()`, `queryPermission()` and
 *     `requestPermission()` goes through it, with `webContents` null and the
 *     origin only. It is boolean, so it can never say "prompt":
 *     `requestPermission()` reads a false as `denied` without ever reaching
 *     the request handler.
 *   - The REQUEST handler is reached only right after a DIRECTORY picker,
 *     once per access the picker was opened for (`writable` for
 *     `{mode: 'readwrite'}`, then `readable`). File pickers never raise a
 *     request.
 *
 * So the grants live here, one table per scope (the normal profile, or one
 * private window's partition), keyed by origin and path, and the check
 * handler answers from it. What gets into the table is exactly what the
 * user chose in the native picker, following Chrome's picker semantics:
 *
 *   directory picker → the picked folder, for the access the picker asked
 *                      for (the dialog names it: "Select a folder this site
 *                      can view" / "Select where this site can save
 *                      changes"); everything under it is covered, the way
 *                      Chrome extends a folder grant to its children.
 *   open picker      → read on the picked file. A site can only hold a
 *                      handle to a file the user gave it (a picker or a
 *                      drop), so the first check for a file path is that
 *                      choice.
 *   save picker      → read and write on the picked file. Chromium creates
 *                      or truncates the file the user picked in a save
 *                      dialog before the site gets the handle (on every
 *                      platform), and an open dialog never touches the file
 *                      — so an empty file modified in the last minute is
 *                      the save the user just made. Nothing else in
 *                      Electron tells the two pickers apart.
 *
 * That save inference is a heuristic with two known edges, both because
 * Electron gives us no signal at pick time (Chromium runs no check when the
 * save picker returns; the first one comes with the page's first
 * `createWritable()`):
 *
 *   - A save whose first write comes more than SAVE_PICK_WINDOW_MS after
 *     the pick (a page that renders a long export first, or a network file
 *     whose server clock is that far off) is refused with NotAllowedError.
 *     Picking the file again in the save dialog truncates it again and
 *     opens a fresh window.
 *   - An empty file the user created or emptied within that window and
 *     then opened (not saved) with the open picker is indistinguishable
 *     from a save, so it is writable too. There is no content in it for a
 *     site to destroy, and the window is kept short for this reason.
 *
 * Everything else is refused: writing to a file the user only opened
 * (Chrome asks first; Electron's boolean check cannot) unless it is in the
 * just-saved state above, a folder handle the site restored from storage,
 * and paths Electron treats as sensitive (`file-system-access-restricted`:
 * system folders, the home folder itself, the profile — see
 * `onRestrictedPath`).
 *
 * Grants are listed as one `fileSystem` row per origin ("Files and folders
 * you picked"): Settings' site list shows the normal profile's (never a
 * private window's), and the address-bar indicator/popover shows the
 * asking window's own. They are dropped by "Revoke all", by removing the
 * origin (Settings' Remove site) or that row (Settings' or the popover's
 * Remove — the popover's for the asking window's scope only), and when a
 * private window closes.
 *
 * Grants are never persisted. The normal profile's last until the app
 * quits (or are revoked, see above), a private window's until it closes.
 */

const fs = require('fs');
const path = require('path');

// How recent a save picker's truncation has to be for the first write
// check on that file to count as the save the user just made.
const SAVE_PICK_WINDOW_MS = 60 * 1000;

const ACCESS_TYPES = new Set(['readable', 'writable']);

// Map<scopeKey, Map<origin, Map<path, {isDirectory, readable, writable}>>>,
// where the scope key is the private partition or '' for the normal profile.
const grants = new Map();

const scopeKeyFor = (privatePartition) => privatePartition || '';

/**
 * The request's path and access, or null when Electron handed us
 * something we don't recognise (fail closed).
 */
function parseDetails(details) {
  const access = details?.fileAccessType;
  const rawPath = details?.filePath;
  if (!ACCESS_TYPES.has(access)) return null;
  if (typeof rawPath !== 'string' || !rawPath || !path.isAbsolute(rawPath)) return null;
  return { access, filePath: path.resolve(rawPath), isDirectory: details?.isDirectory === true };
}

function originGrants(scopeKey, origin, create = false) {
  let origins = grants.get(scopeKey);
  if (!origins) {
    if (!create) return null;
    origins = new Map();
    grants.set(scopeKey, origins);
  }
  let paths = origins.get(origin);
  if (!paths && create) {
    paths = new Map();
    origins.set(origin, paths);
  }
  return paths || null;
}

// Called when an origin gains its first grant in a scope, so the surfaces
// that list grants (Settings, the address-bar indicator) can refresh.
let originGrantedListener = null;

function setOriginGrantedListener(listener) {
  originGrantedListener = typeof listener === 'function' ? listener : null;
}

function recordGrant(scopeKey, origin, filePath, isDirectory, access) {
  const isNewOrigin = !originGrants(scopeKey, origin);
  const paths = originGrants(scopeKey, origin, true);
  if (isNewOrigin && originGrantedListener) {
    try {
      originGrantedListener();
    } catch {
      // a listing refresh must never break the grant itself
    }
  }
  let entry = paths.get(filePath);
  // A path that turned from a file into a folder (or back) is a different
  // entry; Chromium revokes the old grant in that case too.
  if (!entry || entry.isDirectory !== isDirectory) {
    entry = { isDirectory, readable: false, writable: false };
    paths.set(filePath, entry);
  }
  entry[access] = true;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === '' || path.isAbsolute(rel)) return false;
  // Only a leading `..` SEGMENT climbs out; a child named `..notes` is
  // still inside.
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function isGranted(scopeKey, origin, filePath, isDirectory, access) {
  const paths = originGrants(scopeKey, origin);
  if (!paths) return false;
  const entry = paths.get(filePath);
  if (entry && entry.isDirectory === isDirectory && entry[access]) return true;
  for (const [granted, grantedEntry] of paths) {
    if (grantedEntry.isDirectory && grantedEntry[access] && isInside(granted, filePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `filePath` is in the state Chromium's save picker leaves the file
 * the user picked in: an empty regular file, created or truncated moments
 * ago.
 */
function looksJustSaved(filePath, now) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== 0) return false;
  // Truncating sets mtime even when the file was already empty (checked on
  // Linux; Chromium truncates rather than relying on O_TRUNC).
  return Math.abs(now - stat.mtimeMs) <= SAVE_PICK_WINDOW_MS;
}

/**
 * The session's permission REQUEST for `fileSystem`: in Electron this only
 * follows a directory picker, and grants the folder for the access the
 * picker was opened for. Anything else is refused.
 *
 * @param {Object} request
 * @param {string} request.origin - normalized requesting origin
 * @param {Object} request.details - Electron's FilesystemPermissionRequest
 * @param {string|null} [request.privatePartition]
 * @returns {boolean} whether to grant
 */
function requestFileSystemAccess({ origin, details, privatePartition = null }) {
  const parsed = parseDetails(details);
  if (!origin || !parsed || !parsed.isDirectory) return false;
  recordGrant(
    scopeKeyFor(privatePartition),
    origin,
    parsed.filePath,
    parsed.isDirectory,
    parsed.access
  );
  return true;
}

/**
 * The session's permission CHECK for `fileSystem` — the effective grant
 * behind every File System Access operation (see the module comment).
 *
 * @param {Object} check
 * @param {string} check.origin - normalized requesting origin
 * @param {Object} check.details - {filePath, isDirectory, fileAccessType}
 * @param {string|null} [check.privatePartition]
 * @param {number} [check.now]
 * @returns {boolean}
 */
function checkFileSystemAccess({ origin, details, privatePartition = null, now = Date.now() }) {
  const parsed = parseDetails(details);
  if (!origin || !parsed) return false;
  const scopeKey = scopeKeyFor(privatePartition);
  const { filePath, isDirectory, access } = parsed;

  if (isGranted(scopeKey, origin, filePath, isDirectory, access)) return true;

  // Folders are granted only by their picker's request.
  if (isDirectory) return false;

  if (access === 'readable') {
    // The site holds a handle to this file, which only the user can have
    // given it.
    recordGrant(scopeKey, origin, filePath, false, 'readable');
    return true;
  }

  if (looksJustSaved(filePath, now)) {
    recordGrant(scopeKey, origin, filePath, false, 'readable');
    recordGrant(scopeKey, origin, filePath, false, 'writable');
    return true;
  }
  return false;
}

/**
 * `file-system-access-restricted`: the user picked a path Electron treats
 * as sensitive. Refused, as before #671. A listener is required — with
 * none, Electron never answers and the page's picker promise hangs.
 */
function onRestrictedPath(_event, _details, callback) {
  callback('deny');
}

/** Drop the grants of one private window (it closed). */
function clearPrivateFileSystemGrants(partition) {
  if (!partition) return false;
  return grants.delete(partition);
}

/**
 * Drop one origin's grants (its permissions were removed). With no
 * `scope` the origin is dropped from every scope (Settings, profile-wide);
 * with `{ privatePartition }` only from that scope — the normal profile
 * when the partition is null.
 *
 * @returns {boolean} whether anything was dropped
 */
function clearOriginFileSystemGrants(origin, scope) {
  if (!origin) return false;
  let dropped = false;
  if (scope === undefined) {
    for (const origins of grants.values()) {
      if (origins.delete(origin)) dropped = true;
    }
    return dropped;
  }
  const origins = grants.get(scopeKeyFor(scope?.privatePartition));
  return origins ? origins.delete(origin) : false;
}

/**
 * Whether `origin` holds any grant in one scope (the normal profile when
 * `privatePartition` is null).
 */
function hasFileSystemGrants(origin, privatePartition = null) {
  if (!origin) return false;
  return (originGrants(scopeKeyFor(privatePartition), origin)?.size || 0) > 0;
}

/**
 * The origins holding grants in the normal profile, for Settings' site
 * list. Private windows' grants are deliberately not listed there: they
 * would put a private window's origins on a normal-profile page.
 */
function getNormalProfileGrantOrigins() {
  const origins = grants.get(scopeKeyFor(null));
  if (!origins) return [];
  return [...origins].filter(([, paths]) => paths.size > 0).map(([origin]) => origin);
}

/** Drop every grant, in every scope ("Revoke all"). */
function clearAllFileSystemGrants() {
  grants.clear();
}

module.exports = {
  SAVE_PICK_WINDOW_MS,
  requestFileSystemAccess,
  checkFileSystemAccess,
  onRestrictedPath,
  clearPrivateFileSystemGrants,
  clearOriginFileSystemGrants,
  clearAllFileSystemGrants,
  hasFileSystemGrants,
  getNormalProfileGrantOrigins,
  setOriginGrantedListener,
};
