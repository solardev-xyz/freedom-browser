const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('./logger');

const execFileAsync = promisify(execFile);
const { ipcMain, app, dialog, clipboard, nativeImage, webContents } = require('electron');
const { URL } = require('url');
const path = require('path');
const { activeBzzBases, activeRadBases } = require('./state');
const { loadSettings } = require('./settings-store');
const { fetchBuffer, fetchToFile } = require('./http-fetch');
const { success, failure, validateWebContentsId } = require('./ipc-contract');
const IPC = require('../shared/ipc-channels');
const { normalizeSocksEndpoint } = require('../shared/socks-endpoint');
const {
  startProbe: startSwarmProbe,
  cancelProbe: cancelSwarmProbe,
} = require('./swarm/swarm-probe');
const {
  createProfileForActiveApp,
  deleteProfileForActiveApp,
  getActiveProfile,
  getProfileFocusTargetForActiveApp,
  importProfileForActiveApp,
  listProfilesForActiveApp,
  renameProfileForActiveApp,
  updateActiveProfileNodeConfig,
  validateProfileDeletionForActiveApp,
} = require('./profile-resolver');
const { openOrFocusProfile } = require('./profile-launcher');
const { isPrivateWebContents } = require('./private/private-windows');
const { readProfileFocusAck, requestProfileQuitAsync } = require('./profile-focus-handoff');
const { isProfileLocked } = require('./profile-lock');

// Bzz content probes, keyed by probe id. Each entry exposes a promise that
// resolves to the probe outcome. Entries survive until BZZ_AWAIT_PROBE
// consumes them (or a safety TTL elapses so abandoned entries don't leak).
//
// We *must not* drop entries the moment the probe settles: the renderer
// receives the id from BZZ_START_PROBE over IPC, then calls BZZ_AWAIT_PROBE
// in a second round-trip. Probes that resolve quickly (Bee already has the
// content, returns 200 on the first HEAD) would otherwise be deleted before
// the second call arrives, producing a spurious UNKNOWN_PROBE failure and
// dumping the user on the error page.
const bzzProbePromises = new Map();
const BZZ_PROBE_ABANDON_TTL_MS = 5 * 60 * 1000;

// Path to webview preload script (for internal pages)
const webviewPreloadPath = path.join(__dirname, 'webview-preload.js');

// Canonical internal-pages list (shared with preloads via sync IPC)
const internalPages = require('../shared/internal-pages.json');

// Ethereum provider injection source, read once and shared with webview preloads
// over sync IPC. The preload is sandboxed and cannot `require('fs')` itself.
const ethereumInjectSource = fs.readFileSync(
  path.join(__dirname, 'webview-preload-ethereum-inject.js'),
  'utf-8'
);

// EIP-6963 ProviderInfo static fields. Icon is a 96×96 PNG base64-encoded
// (spec recommends square, 96×96 minimum, and requires an RFC-2397 data URI).
// Name and rdns come from src/shared/brand.json. We cannot read them from
// package.json at runtime because electron-builder strips the `build` section
// (which holds productName and appId) from the packaged package.json.
const ethereumProviderIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon-6963.png')
  : path.join(__dirname, '..', '..', 'assets', 'icon-6963.png');
const brand = require('../shared/brand.json');
// Read the icon defensively: a missing/corrupt file must not block main-process
// startup. Fall back to an empty icon and let the 6963 announcement still fire.
let ethereumProviderIconDataUri = '';
try {
  ethereumProviderIconDataUri =
    'data:image/png;base64,' + fs.readFileSync(ethereumProviderIconPath, 'base64');
} catch (err) {
  log.error('[eip6963] Failed to load provider icon:', err.message);
}
const ethereumProviderInfoStatic = Object.freeze({
  name: brand.productName,
  icon: ethereumProviderIconDataUri,
  // rdns is EIP-6963's "reverse-DNS" identifier; brand.appId (baby.freedom.browser)
  // is already valid reverse-DNS of freedom.baby, so we reuse it.
  rdns: brand.appId,
});

const isAllowedBaseUrl = (value) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
};

const formatWindowTitle = (title) => {
  return title?.trim() ? `${title.trim()} - Freedom` : 'Freedom';
};

function getIpcSenderUrl(event) {
  return event?.senderFrame?.url || event?.sender?.getURL?.() || '';
}

function normalizeFileUrlPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return null;
    return decodeURIComponent(parsed.pathname).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

function isTrustedProfileMutationSender(event) {
  const pathname = normalizeFileUrlPath(getIpcSenderUrl(event));
  if (!pathname) return false;

  return (
    pathname.endsWith('/src/renderer/index.html') ||
    pathname.endsWith('/src/renderer/pages/settings.html') ||
    pathname.endsWith('/src/renderer/pages/profiles.html')
  );
}

function withTrustedProfileMutationSender(event, fn) {
  if (!isTrustedProfileMutationSender(event)) {
    return failure(
      'PROFILE_IPC_FORBIDDEN',
      'Profile changes are only available from trusted profile UI'
    );
  }
  return fn();
}

function serializeActiveProfile() {
  const profile = getActiveProfile();
  if (!profile) return null;

  const serialized = {
    id: profile.id,
    displayName: profile.displayName,
    source: profile.source,
    isDev: profile.isDev === true,
  };

  const metadata = profile.metadata || null;
  if (Number.isInteger(metadata?.slot)) {
    serialized.slot = metadata.slot;
  }
  if (metadata?.nodes && typeof metadata.nodes === 'object') {
    serialized.nodes = {
      bee: metadata.nodes.bee ? { ...metadata.nodes.bee } : null,
      ipfs: metadata.nodes.ipfs ? { ...metadata.nodes.ipfs } : null,
      myotis: metadata.nodes.myotis ? { ...metadata.nodes.myotis } : null,
      radicle: metadata.nodes.radicle ? { ...metadata.nodes.radicle } : null,
      tor: metadata.nodes.tor ? { ...metadata.nodes.tor } : null,
    };
  }

  return serialized;
}

function broadcastProfileUpdated(profile = serializeActiveProfile()) {
  if (!webContents?.getAllWebContents) return;

  for (const contents of webContents.getAllWebContents()) {
    try {
      contents.send(IPC.PROFILE_UPDATED, profile);
    } catch {
      // The target may have been destroyed between enumeration and send.
    }
  }
}

function serializeProfileSummary(profile) {
  if (!profile) return null;
  const serialized = {
    id: profile.id,
    displayName: profile.displayName,
    slot: profile.slot,
    createdAt: profile.createdAt,
    lastOpenedAt: profile.lastOpenedAt,
    nodes: profile.nodes,
    isActive: profile.isActive === true,
  };
  if (profile.isUnregistered === true) {
    serialized.isUnregistered = true;
  }
  return serialized;
}

function serializeProfileMutationResult(result) {
  if (!result) return null;
  return serializeProfileSummary({
    id: result.metadata?.id || result.record?.id,
    displayName: result.metadata?.displayName || result.record?.displayName,
    slot: result.metadata?.slot ?? result.record?.slot,
    createdAt: result.metadata?.createdAt || result.record?.createdAt || null,
    lastOpenedAt: result.metadata?.lastOpenedAt || result.record?.lastOpenedAt || null,
    nodes: result.metadata?.nodes || result.record?.nodes || null,
    isActive: result.record?.id === getActiveProfile()?.id,
  });
}

const PROFILE_NODE_MODES = {
  bee: new Set(['managed', 'external', 'disabled']),
  ipfs: new Set(['managed', 'disabled']),
  myotis: new Set(['managed', 'disabled']),
  radicle: new Set(['managed', 'external', 'disabled']),
  tor: new Set(['managed', 'external', 'disabled']),
};
const PROFILE_NODE_FIELDS = {
  bee: ['mode', 'externalApi'],
  ipfs: ['mode'],
  myotis: ['mode'],
  radicle: ['mode', 'externalHttp'],
  tor: ['mode', 'externalSocks'],
};
const EXTERNAL_FIELDS = {
  bee: ['externalApi'],
  radicle: ['externalHttp'],
  tor: ['externalSocks'],
};
const PROFILE_NODE_ENDPOINT_NORMALIZERS = {
  externalApi: normalizeProfileNodeEndpoint,
  externalHttp: normalizeProfileNodeEndpoint,
  externalSocks: normalizeSocksEndpoint,
};

function normalizeProfileNodeEndpoint(rawValue) {
  if (rawValue == null) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function validateProfileNodeConfigUpdate(protocol, patch = {}) {
  if (!Object.prototype.hasOwnProperty.call(PROFILE_NODE_FIELDS, protocol)) {
    return {
      ok: false,
      response: failure('INVALID_PROFILE_PROTOCOL', 'Unsupported profile node protocol', {
        protocol,
      }),
    };
  }

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      ok: false,
      response: failure('INVALID_PROFILE_NODE_CONFIG', 'Profile node config must be an object'),
    };
  }

  const allowedFields = PROFILE_NODE_FIELDS[protocol];
  const sanitized = {};

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;

    if (field === 'mode') {
      if (!PROFILE_NODE_MODES[protocol].has(patch.mode)) {
        return {
          ok: false,
          response: failure('INVALID_PROFILE_NODE_MODE', 'Unsupported profile node mode', {
            mode: patch.mode,
          }),
        };
      }
      sanitized.mode = patch.mode;
      continue;
    }

    const normalizeEndpoint = PROFILE_NODE_ENDPOINT_NORMALIZERS[field] || (() => null);
    const normalized = normalizeEndpoint(patch[field]);
    if (patch[field] && !normalized) {
      return {
        ok: false,
        response: failure('INVALID_PROFILE_NODE_ENDPOINT', 'Invalid profile node endpoint', {
          field,
        }),
      };
    }
    sanitized[field] = normalized;
  }

  if (!Object.keys(sanitized).length) {
    return {
      ok: false,
      response: failure('EMPTY_PROFILE_NODE_CONFIG', 'No supported profile node config fields'),
    };
  }

  if (sanitized.mode === 'external') {
    const missing = (EXTERNAL_FIELDS[protocol] || []).filter((field) => !sanitized[field]);
    if (missing.length) {
      return {
        ok: false,
        response: failure(
          'MISSING_PROFILE_NODE_ENDPOINT',
          'External node mode requires endpoints',
          {
            fields: missing,
          }
        ),
      };
    }
  }

  return { ok: true, sanitized };
}

function updateProfileNodeConfigFromIpc(protocol, patch) {
  const activeProfile = getActiveProfile();
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return failure('PROFILE_NOT_EDITABLE', 'The active profile cannot be edited');
  }

  const validation = validateProfileNodeConfigUpdate(protocol, patch);
  if (!validation.ok) return validation.response;

  try {
    const result = updateActiveProfileNodeConfig(protocol, validation.sanitized);
    if (!result) {
      return failure('PROFILE_UPDATE_FAILED', 'Profile node config was not updated');
    }
    const profile = serializeActiveProfile();
    broadcastProfileUpdated(profile);
    if (protocol === 'myotis') {
      const myotisManager = require('./myotis/myotis-manager');
      if (validation.sanitized.mode === 'disabled') {
        myotisManager.stopAllMyotis();
      } else {
        for (const chainId of myotisManager.NETWORKS.keys()) {
          myotisManager.refreshMyotisStatus(chainId);
        }
      }
    }
    return success({ profile });
  } catch (err) {
    log.error('[profile] Failed to update node config:', err);
    return failure('PROFILE_UPDATE_FAILED', err.message || 'Profile node config update failed');
  }
}

function listProfilesFromIpc() {
  const profiles = listProfilesForActiveApp();
  if (!profiles) {
    return failure(
      'PROFILE_CATALOG_UNAVAILABLE',
      'Profiles are not available for this launch mode'
    );
  }
  return success({ profiles: profiles.map(serializeProfileSummary) });
}

function createProfileFromIpc(payload = {}) {
  try {
    const result = createProfileForActiveApp({
      displayName: payload.displayName,
      id: payload.id,
    });
    if (!result) {
      return failure(
        'PROFILE_CATALOG_UNAVAILABLE',
        'Profiles are not available for this launch mode'
      );
    }
    // No direct broadcast/menu rebuild here: writing the registry trips the
    // profile-registry watcher in *every* process (including this one), and its
    // onChange both rebuilds the native Profiles menu and re-broadcasts. Firing
    // here too would just duplicate that work in the originating process.
    return success({ profile: serializeProfileMutationResult(result) });
  } catch (err) {
    return failure('PROFILE_CREATE_FAILED', err.message || 'Profile could not be created');
  }
}

function importProfileFromIpc(payload = {}) {
  try {
    const result = importProfileForActiveApp(payload.id);
    if (!result) {
      return failure(
        'PROFILE_CATALOG_UNAVAILABLE',
        'Profiles are not available for this launch mode'
      );
    }
    return success({ profile: serializeProfileMutationResult(result) });
  } catch (err) {
    return failure('PROFILE_IMPORT_FAILED', err.message || 'Profile could not be imported');
  }
}

function renameProfileFromIpc(payload = {}) {
  try {
    const result = renameProfileForActiveApp(payload.id, payload.displayName);
    if (!result) {
      return failure(
        'PROFILE_CATALOG_UNAVAILABLE',
        'Profiles are not available for this launch mode'
      );
    }
    const activeProfile = serializeActiveProfile();
    // Unlike create/delete (which let the registry watcher rebuild the menu and
    // re-broadcast), rename keeps a direct broadcast on purpose: renaming the
    // active profile changes its display name in this window's UI, and we want
    // that reflected immediately rather than on the next watcher tick. It's also
    // the only sync path under TEST_MODE, where the watcher is disabled — the
    // E2E rename assertion relies on it. In production this overlaps the
    // watcher's broadcast; the duplicate is harmless.
    broadcastProfileUpdated(activeProfile);
    return success({
      profile: serializeProfileMutationResult(result),
      activeProfile,
    });
  } catch (err) {
    return failure('PROFILE_RENAME_FAILED', err.message || 'Profile could not be renamed');
  }
}

async function openProfileFromIpc(payload = {}) {
  const activeProfile = getActiveProfile();
  const profileId = payload.id;
  if (!profileId || typeof profileId !== 'string') {
    return failure('INVALID_PROFILE_ID', 'Missing profile id');
  }
  if (!activeProfile || activeProfile.source !== 'catalog') {
    return failure(
      'PROFILE_CATALOG_UNAVAILABLE',
      'Profiles are not available for this launch mode'
    );
  }
  if (profileId === activeProfile.id) {
    return failure('PROFILE_ALREADY_OPEN', 'This profile is already open');
  }

  const profiles = listProfilesForActiveApp();
  const target = profiles?.find((profile) => profile.id === profileId);
  if (!target) {
    return failure('PROFILE_NOT_FOUND', 'Profile not found', { id: profileId });
  }

  try {
    // Focuses an already-running profile (fast) or cold-starts it. Shared with
    // the native Profiles menu so both paths behave identically. `openSettings`
    // (from the profile manager's edit button) lands the opened window on its
    // Profile settings page.
    const opened = await openOrFocusProfile(activeProfile, profileId, {
      openSettings: payload.openSettings === true,
    });
    // The profile is running but didn't acknowledge the focus request — report
    // it so the UI can show an error instead of falsely claiming success.
    if (opened.error) {
      return failure('PROFILE_FOCUS_FAILED', opened.error);
    }
    return success({
      profile: serializeProfileSummary(target),
      ...(opened.focused ? { focused: true } : { launch: opened.launch }),
    });
  } catch (err) {
    log.error('[profile] Failed to open profile:', err);
    return failure('PROFILE_OPEN_FAILED', err.message || 'Profile could not be opened');
  }
}

// Liveness probe: signal 0 tests for the process without delivering a signal.
// ESRCH → the process is gone; EPERM → it's alive but owned by another user.
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// Ask a running profile to close and wait until its data is safe to remove, so
// a delete can proceed. Returns true once the profile is closed (or was never
// open).
//
// A released lock alone is NOT a safe signal: the profile lock can read as free
// while the holder is still winding down — its heartbeat lapses during a slow
// shutdown and `isProfileLocked` honours the stale timeout, so we could delete
// node/vault data the process is still touching. When the target acks our quit
// request it includes its pid; we wait for that process to actually exit, which
// (per the will-quit ordering in index.js) only happens after it has finished
// closing databases and stopping its nodes. We fall back to the lock signal
// when no usable ack is available (older build, crash before ack).
async function ensureProfileClosedForDelete(profileId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 200;
  const processAlive = options.isProcessAlive || isProcessAlive;
  const readAck = options.readProfileFocusAck || readProfileFocusAck;

  const target = getProfileFocusTargetForActiveApp(profileId);
  if (!target || !target.isLocked) {
    return true;
  }

  const quit = requestProfileQuitAsync(target);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    // Prefer the definitive signal: the acking process has actually exited.
    let ack;
    try {
      ack = readAck(target);
    } catch {
      ack = null;
    }
    const holderPid =
      ack && ack.nonce === quit?.nonce && Number.isInteger(ack.pid) ? ack.pid : null;
    if (holderPid != null) {
      if (!processAlive(holderPid)) return true;
      continue;
    }

    // No usable ack (older build, crash before ack, unreadable) — fall back to
    // the lock-release signal. Use an effectively-infinite stale window so a
    // still-held lock can't read as "released" merely because its heartbeat
    // lapsed mid-shutdown. This matters for dev profiles, whose stale timeout
    // (5s) is shorter than this wait (15s): without it, a slow dev shutdown
    // could look closed while the process is still touching profile data. An
    // already-dead, genuinely-stale lock from a crash is handled earlier by the
    // target.isLocked gate (and resolves on a retry), so here we only accept a
    // real release — the lock dir actually going away.
    let stillLocked;
    try {
      stillLocked = isProfileLocked(target, { staleMs: Number.MAX_SAFE_INTEGER });
    } catch {
      stillLocked = false;
    }
    if (!stillLocked) {
      return true;
    }
  }
  return false;
}

async function deleteProfileFromIpc(payload = {}, options = {}) {
  try {
    // Test seam (E2E): simulate a delete outcome (e.g. PROFILE_CLOSE_FAILED for
    // a profile open in another window) without a second process, so the
    // manager's failure handling — card restore + error toast — can be
    // exercised end-to-end. Inert in production (global undefined).
    const deleteSim = globalThis.__FREEDOM_TEST_DELETE_SIM__;
    if (typeof deleteSim === 'function') {
      const simulated = deleteSim(payload.id);
      if (simulated) return simulated;
    }

    const activeProfile = getActiveProfile();
    if (payload.id && activeProfile && payload.id === activeProfile.id) {
      return failure('PROFILE_ACTIVE', 'The active profile cannot be deleted');
    }

    // Validate the request (existence, confirmation, path safety) BEFORE closing
    // anything. ensureProfileClosedForDelete asks a running profile to quit; if
    // we ran it first, a stale or mismatched confirmation would quit a live
    // window and only then fail the delete. deleteProfile re-validates under the
    // catalog write lock — this pre-flight just gates the quit request.
    // (Returns null in non-catalog launch modes, where the delete below also
    // no-ops into PROFILE_CATALOG_UNAVAILABLE.)
    validateProfileDeletionForActiveApp(payload.id, payload.confirmDisplayName);

    // If the profile is open in another window, close it first so its data is
    // not in use when we remove it.
    const closed = await ensureProfileClosedForDelete(payload.id, options);
    if (!closed) {
      return failure(
        'PROFILE_CLOSE_FAILED',
        'This profile is open and could not be closed automatically. Close its window and try again.'
      );
    }

    const result = deleteProfileForActiveApp(payload.id, payload.confirmDisplayName);
    if (!result) {
      return failure(
        'PROFILE_CATALOG_UNAVAILABLE',
        'Profiles are not available for this launch mode'
      );
    }
    // The registry write trips the profile-registry watcher (in this and every
    // other process), which rebuilds the native menu and re-broadcasts — no
    // need to duplicate that here. See createProfileFromIpc.
    return success({
      profile: serializeProfileSummary({
        id: result.record.id,
        displayName: result.record.displayName,
        slot: result.record.slot,
        createdAt: result.record.createdAt || null,
        lastOpenedAt: result.record.lastOpenedAt || null,
        nodes: result.record.nodes || null,
        isActive: false,
      }),
    });
  } catch (err) {
    return failure('PROFILE_DELETE_FAILED', err.message || 'Profile could not be deleted');
  }
}

function registerBaseIpcHandlers(callbacks = {}) {
  ipcMain.handle(IPC.BZZ_SET_BASE, (_event, payload = {}) => {
    const { webContentsId, baseUrl } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    if (!baseUrl) {
      return failure('INVALID_BASE_URL', 'Missing baseUrl');
    }
    if (!isAllowedBaseUrl(baseUrl)) {
      log.warn('[ipc] Rejecting non-local bzz base URL');
      return failure('INVALID_BASE_URL', 'Base URL must be localhost or 127.0.0.1', { baseUrl });
    }
    try {
      const normalized = new URL(baseUrl);
      activeBzzBases.set(webContentsId, normalized);
      return success();
    } catch (err) {
      log.error('Invalid base URL received from renderer', err);
      return failure('INVALID_BASE_URL', 'Invalid baseUrl', { baseUrl });
    }
  });

  ipcMain.handle(IPC.BZZ_CLEAR_BASE, (_event, payload = {}) => {
    const { webContentsId } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    activeBzzBases.delete(webContentsId);
    return success();
  });

  // Each probe is split across start/await/cancel so the renderer can
  // obtain the id before the probe settles (enabling mid-flight cancel
  // from the stop button / next navigation).
  ipcMain.handle(IPC.BZZ_START_PROBE, (_event, payload = {}) => {
    const { hash, path } = payload;
    if (typeof hash !== 'string' || !hash) {
      return failure('INVALID_HASH', 'Missing hash');
    }
    const { id, promise } = startSwarmProbe(hash, { path });
    // Keep the entry until await-probe consumes it. A safety TTL drops
    // abandoned entries (e.g. the tab was closed before awaiting) without
    // racing the start→await IPC round-trip for fast-resolving probes.
    const timer = setTimeout(() => {
      bzzProbePromises.delete(id);
    }, BZZ_PROBE_ABANDON_TTL_MS);
    // Avoid keeping the Electron event loop alive solely for this cleanup.
    if (typeof timer.unref === 'function') timer.unref();
    bzzProbePromises.set(id, { promise, timer });
    return success({ id });
  });

  ipcMain.handle(IPC.BZZ_AWAIT_PROBE, async (_event, payload = {}) => {
    const { id } = payload;
    if (typeof id !== 'string' || !id) {
      return failure('INVALID_ID', 'Missing probe id');
    }
    const entry = bzzProbePromises.get(id);
    if (!entry) {
      return failure('UNKNOWN_PROBE', 'Unknown probe id', { id });
    }
    const outcome = await entry.promise;
    clearTimeout(entry.timer);
    bzzProbePromises.delete(id);
    return success({ outcome });
  });

  ipcMain.handle(IPC.BZZ_CANCEL_PROBE, (_event, payload = {}) => {
    const { id } = payload;
    if (typeof id !== 'string' || !id) {
      return failure('INVALID_ID', 'Missing probe id');
    }
    const cancelled = cancelSwarmProbe(id);
    return success({ cancelled });
  });

  ipcMain.handle(IPC.RAD_SET_BASE, (_event, payload = {}) => {
    const settings = loadSettings();
    if (!settings.enableRadicleIntegration) {
      return failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      );
    }
    const { webContentsId, baseUrl } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    if (!baseUrl) {
      return failure('INVALID_BASE_URL', 'Missing baseUrl');
    }
    try {
      const normalized = new URL(baseUrl);
      activeRadBases.set(webContentsId, normalized);
      return success();
    } catch (err) {
      log.error('Invalid Radicle base URL received from renderer', err);
      return failure('INVALID_BASE_URL', 'Invalid baseUrl', { baseUrl });
    }
  });

  ipcMain.handle(IPC.RAD_CLEAR_BASE, (_event, payload = {}) => {
    const { webContentsId } = payload;
    if (!validateWebContentsId(webContentsId)) {
      return failure('INVALID_WEB_CONTENTS_ID', 'Invalid webContentsId', { webContentsId });
    }
    activeRadBases.delete(webContentsId);
    return success();
  });

  ipcMain.on(IPC.WINDOW_SET_TITLE, (event, title) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (!win) return;
    const formatted = formatWindowTitle(title);
    // PRIVATE MODE GUARD (window title): a private page's <title> — and, for
    // view-source/error tabs, its full URL, which the renderer sends as the
    // title — must not reach the persistent on-disk log, nor seed the
    // process-wide `currentWindowTitle` that every later normal window
    // inherits at ready-to-show. The private window's own native title still
    // updates (matching Chrome/Firefox), it just stays out of shared state.
    const isPrivate = isPrivateWebContents(event.sender);
    if (isPrivate) {
      log.info('[main] Setting window title for a private window (title redacted)');
    } else {
      log.info(`[main] Setting window title to: "${formatted}" (requested: "${title}")`);
    }
    win.setTitle(formatted);
    if (!isPrivate && callbacks.onSetTitle) {
      callbacks.onSetTitle(formatted);
    }
  });

  ipcMain.on(IPC.WINDOW_CLOSE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.close();
    }
  });

  ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.minimize();
    }
  });

  ipcMain.on(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle(IPC.WINDOW_GET_PLATFORM, () => {
    return process.platform;
  });

  // Which window-manager buttons the desktop expects (GNOME defaults to
  // close-only). Returns null off-GNOME/non-Linux so the caller shows all three.
  ipcMain.handle(IPC.WINDOW_GET_BUTTON_LAYOUT, async () => {
    if (process.platform !== 'linux') return null;
    try {
      const { stdout } = await execFileAsync(
        'gsettings',
        ['get', 'org.gnome.desktop.wm.preferences', 'button-layout'],
        { timeout: 2000 }
      );
      const tokens = stdout
        .replace(/['"\n]/g, '')
        .replace(':', ',')
        .split(',');
      return {
        minimize: tokens.includes('minimize'),
        maximize: tokens.includes('maximize'),
        close: tokens.includes('close'),
      };
    } catch {
      return null;
    }
  });

  ipcMain.on(IPC.APP_RELAUNCH, () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.on(IPC.WINDOW_TOGGLE_FULLSCREEN, (event) => {
    const win = event.sender.getOwnerBrowserWindow();
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  ipcMain.on(IPC.WINDOW_NEW, () => {
    if (callbacks.onNewWindow) {
      callbacks.onNewWindow();
    }
  });

  // PRIVATE MODE GUARD (windows): "Open Link in New Window" carries a URL out
  // of the window that asked for it. Asked from a private window, the link
  // must land in another PRIVATE window — routing it through createMainWindow
  // would load it on the persistent default session, where history records
  // it, cookies and site data stick, and wallet providers inject. Resolve the
  // sender through the private registry so the guard holds whatever the
  // renderer sends.
  ipcMain.on(IPC.WINDOW_NEW_WITH_URL, (event, url) => {
    if (isPrivateWebContents(event?.sender)) {
      if (callbacks.onNewPrivateWindow) {
        callbacks.onNewPrivateWindow(url);
      } else {
        // Never fall back to a normal window: dropping the request is the
        // safe failure here.
        log.warn('[private] no private-window factory — dropping window:new-with-url');
      }
      return;
    }
    if (callbacks.onNewWindow) {
      // Pass URL directly to createMainWindow to avoid home page flash
      callbacks.onNewWindow(url);
    }
  });

  ipcMain.on(IPC.WINDOW_NEW_PRIVATE, () => {
    if (callbacks.onNewPrivateWindow) {
      callbacks.onNewPrivateWindow();
    }
  });

  // Sync: a webview preload asks (before any page script runs) whether it
  // lives inside a private window, to gate wallet provider injection.
  // PRIVATE MODE GUARD (providers): consumer is src/main/webview-preload.js.
  ipcMain.on(IPC.PRIVATE_IS_PRIVATE, (event) => {
    event.returnValue = isPrivateWebContents(event.sender);
  });

  ipcMain.on(IPC.APP_SHOW_ABOUT, () => {
    app.showAboutPanel();
  });

  ipcMain.handle(IPC.PROFILE_GET_ACTIVE, () => serializeActiveProfile());
  ipcMain.handle(IPC.PROFILE_LIST, () => listProfilesFromIpc());
  ipcMain.handle(IPC.PROFILE_CREATE, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => createProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_IMPORT, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => importProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_RENAME, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => renameProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_OPEN, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => openProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_DELETE, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () => deleteProfileFromIpc(payload))
  );
  ipcMain.handle(IPC.PROFILE_UPDATE_NODE_CONFIG, (event, payload = {}) =>
    withTrustedProfileMutationSender(event, () =>
      updateProfileNodeConfigFromIpc(payload.protocol, payload.config)
    )
  );

  // A manager page (webview) requests the chrome's create-profile modal.
  // Resolve the webview's owning BrowserWindow and tell it to show the modal.
  // Gate on the same trust boundary as the profile-mutation IPC: only the
  // trusted profile UI may pop the create modal, so a hostile page loaded in a
  // webview can't drive the chrome into showing it.
  ipcMain.on(IPC.PROFILE_REQUEST_CREATE_MODAL, (event) => {
    if (!isTrustedProfileMutationSender(event)) return;
    const win = event.sender.getOwnerBrowserWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PROFILE_SHOW_CREATE_MODAL);
    }
  });

  ipcMain.handle(IPC.GET_WEBVIEW_PRELOAD_PATH, () => {
    return webviewPreloadPath;
  });

  // Sync handler: preloads use sendSync to get internal pages at load time
  ipcMain.on(IPC.GET_INTERNAL_PAGES, (event) => {
    event.returnValue = internalPages;
  });

  ipcMain.on(IPC.GET_ETHEREUM_INJECT_SOURCE, (event) => {
    // One UUID per webview-preload load (i.e. per page session), stable
    // across eip6963:requestProvider re-announcements within that session.
    // Each new tab / reload is a fresh session and gets a fresh UUID.
    // Escape '<' as \u003c so a future field value containing '</script>'
    // can't break out of the injected <script> tag (defense in depth;
    // today's fields all come from package.json).
    const info = { ...ethereumProviderInfoStatic, uuid: crypto.randomUUID() };
    const infoJson = JSON.stringify(info).replace(/</g, '\\u003c');
    const preamble = `window.__FREEDOM_PROVIDER_CONFIG__ = ${infoJson};\n`;
    event.returnValue = preamble + ethereumInjectSource;
  });

  ipcMain.handle(IPC.OPEN_URL_IN_NEW_TAB, (event, url) => {
    // Send to the main renderer to open in new tab
    // event.sender is the webview's webContents, hostWebContents is the main renderer
    const hostWebContents = event.sender.hostWebContents;
    if (hostWebContents) {
      hostWebContents.send('tab:new-with-url', url);
    }
  });

  ipcMain.handle(IPC.SIDEBAR_OPEN_PUBLISH_SETUP, (event) => {
    event.sender.hostWebContents?.send(IPC.SIDEBAR_OPEN_PUBLISH_SETUP);
  });

  ipcMain.handle(IPC.CONTEXT_MENU_SAVE_IMAGE, async (event, imageUrl) => {
    if (!imageUrl) {
      return { success: false, error: 'No image URL provided' };
    }

    try {
      // Get default filename from URL
      let defaultName = 'image';
      try {
        const urlObj = new URL(imageUrl);
        const pathname = urlObj.pathname;
        const lastSegment = pathname.split('/').pop();
        if (lastSegment && lastSegment.includes('.')) {
          defaultName = lastSegment;
        } else if (lastSegment) {
          defaultName = lastSegment;
        }
      } catch {
        // Use default
      }

      const win = event.sender.getOwnerBrowserWindow();
      const result = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      await fetchToFile(imageUrl, result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (error) {
      log.error('[context-menu] Failed to save image:', error);
      return { success: false, error: error.message };
    }
  });

  // Copy text to clipboard
  ipcMain.handle('clipboard:copy-text', (_event, text) => {
    if (text) {
      clipboard.writeText(text);
      return { success: true };
    }
    return { success: false, error: 'No text provided' };
  });

  // Address-bar chrome context menu Paste fallback. Restricted to the
  // trusted main renderer: webviews (which expose `hostWebContents`)
  // could otherwise exfiltrate the user's clipboard without a paste
  // gesture by invoking this IPC directly through the exposed
  // electronAPI on a hostile page.
  ipcMain.handle('clipboard:read-text', (event) => {
    if (event?.sender?.hostWebContents) {
      return { success: false, error: 'Untrusted sender' };
    }
    return { success: true, text: clipboard.readText() };
  });

  // Copy image to clipboard
  ipcMain.handle('clipboard:copy-image', async (_event, imageUrl) => {
    if (!imageUrl) {
      return { success: false, error: 'No image URL provided' };
    }

    try {
      const imageData = await fetchBuffer(imageUrl);
      const image = nativeImage.createFromBuffer(imageData);

      if (image.isEmpty()) {
        return { success: false, error: 'Failed to create image from data' };
      }

      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      log.error('[clipboard] Failed to copy image:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  broadcastProfileUpdated,
  createProfileFromIpc,
  deleteProfileFromIpc,
  importProfileFromIpc,
  isTrustedProfileMutationSender,
  listProfilesFromIpc,
  openProfileFromIpc,
  renameProfileFromIpc,
  registerBaseIpcHandlers,
  serializeActiveProfile,
  serializeProfileSummary,
  updateProfileNodeConfigFromIpc,
  validateProfileNodeConfigUpdate,
};
