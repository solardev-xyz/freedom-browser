// Private-window mode for the chrome renderer.
//
// The main process opens a private window by loading index.html with a
// `privatePartition=private-<uuid>` query parameter (see
// src/main/private/private-windows.js and windows/mainWindow.js). This
// module is the renderer's single source of truth for "am I a private
// window?" and hosts the renderer-side PRIVATE MODE GUARDs the browsing
// code keys off:
//
//   shouldRecordHistory()     — navigation.js: no history writes
//   shouldCacheFavicons()     — navigation.js: no favicon-cache writes
//   shouldLearnAutocomplete() — navigation.js: address-bar autocomplete
//                               never learns from private navigation
//
// Each guard is also enforced main-process-side (history.js, favicons.js)
// so a renderer bug can't undo the promise.

const PRIVATE_PARTITION_PREFIX = 'private-';

let privatePartition = null;
let torWindow = false;

/**
 * Parse the private partition out of a window.location.search string.
 * Exported for tests; returns null for normal windows or malformed values.
 */
export const parsePrivatePartition = (search) => {
  try {
    const value = new URLSearchParams(search || '').get('privatePartition');
    if (typeof value === 'string' && value.startsWith(PRIVATE_PARTITION_PREFIX)) {
      return value;
    }
  } catch {
    // fall through
  }
  return null;
};

/**
 * Whether the query string marks a Tor window (#473). Only a private window
 * can be one: main sends `torWindow=1` alongside the private partition.
 */
export const parseTorWindow = (search) => {
  try {
    const params = new URLSearchParams(search || '');
    return params.get('torWindow') === '1' && parsePrivatePartition(search) !== null;
  } catch {
    return false;
  }
};

/** Initialize from the window's query string. Called once at import time. */
export const initPrivateMode = (search) => {
  const query =
    search !== undefined ? search : typeof window !== 'undefined' ? window.location?.search : '';
  privatePartition = parsePrivatePartition(query);
  torWindow = parseTorWindow(query);
  return privatePartition;
};

/** The window's `private-<uuid>` partition, or null in normal windows. */
export const getPrivatePartition = () => privatePartition;

export const isPrivateWindow = () => privatePartition !== null;

// A Tor window: a private window whose session goes through Arti. Every
// private-window guard holds in it too.
export const isTorWindow = () => torWindow;

// PRIVATE MODE GUARD (history): no navigation from a private window is
// ever written to the history database.
export const shouldRecordHistory = () => !isPrivateWindow();

// PRIVATE MODE GUARD (favicons): private navigation never writes to the
// favicon cache (reading already-cached icons is allowed).
export const shouldCacheFavicons = () => !isPrivateWindow();

// PRIVATE MODE GUARD (autocomplete): the address-bar autocomplete never
// learns from private navigation — its history-backed cache is only
// refreshed on non-private history writes.
export const shouldLearnAutocomplete = () => !isPrivateWindow();

// Auto-init for the real renderer; tests re-init explicitly.
if (typeof window !== 'undefined' && window.location) {
  initPrivateMode();
}
