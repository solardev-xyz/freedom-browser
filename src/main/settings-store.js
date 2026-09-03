const log = require('./logger');
const { app, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');
const { broadcastToAllWebContents } = require('./lib/broadcast-to-all-webcontents');
const { sanitizeOverrides } = require('../shared/shortcuts');

// Apply theme to nativeTheme so webviews get correct prefers-color-scheme
function applyNativeTheme(theme) {
  if (theme === 'light') {
    nativeTheme.themeSource = 'light';
  } else if (theme === 'dark') {
    nativeTheme.themeSource = 'dark';
  } else {
    nativeTheme.themeSource = 'system';
  }
}

const SETTINGS_FILE = 'settings.json';

// Bee-era settings keys renamed to their ant-named replacements. Migrated on
// load (for users upgrading from a bee-based build): the value is copied to the
// new key and the old key is dropped from the live file.
const RENAMED_KEYS = {
  beeNodeMode: 'antNodeMode',
  startBeeAtLaunch: 'startAntAtLaunch',
};
const REMOVED_KEYS = new Set(['enableRadicleIntegration']);

const DEFAULT_SETTINGS = {
  theme: 'system',
  enableIdentityWallet: true,
  antNodeMode: 'ultraLight',
  startAntAtLaunch: true,
  startIpfsAtLaunch: true,
  startRadicleAtLaunch: false,
  // Experimental: start the Myotis P2P Ethereum light client at launch.
  // Off by default — opt-in while the tier is experimental; requires the
  // addon (npm run myotis:download, or the packaged resource).
  startMyotisAtLaunch: false,
  startMyotisGnosisAtLaunch: false,
  // Tor (.onion) access via the bundled Arti SOCKS proxy. Off by default;
  // when enabled, only *.onion traffic is routed through Tor (clearnet and
  // the decentralized protocols keep connecting directly).
  enableTorIntegration: false,
  startTorAtLaunch: false,
  autoUpdate: true,
  showBookmarkBar: false,
  // When true, every download opens a native save dialog. Off by default:
  // files land in the OS Downloads folder without a prompt.
  askWhereToSave: false,
  // Address-bar search provider id used when typed input is not a URL, hash,
  // or name. Valid ids live in the renderer's search-utils.js SEARCH_PROVIDERS
  // map; unknown ids fall back to DuckDuckGo there.
  searchProvider: 'duckduckgo',
  customSearchProviders: [],
  // When true, navigating to an Ethereum name that resolved with trust.level =
  // 'unverified' is gated behind an interstitial with a single-use
  // "Continue once" option. ENS network config (resolution strategy, RPC
  // endpoints, prover, quorum params) lives in the network registry —
  // this is the one ENS-navigation setting kept here.
  blockUnverifiedEns: true,
  // Experimental: when true, IPFS request progress phases ("Finding
  // providers…", "Searching the DHT…", etc.) are surfaced in the link
  // hover preview bar during ipfs:// / ipns:// loads. Off by default so the
  // preview bar stays a pure hover-URL surface; opt in via Settings →
  // Experimental. A follow-up will generalize this to other protocols.
  showIpfsProgressStatus: false,
  sidebarOpen: false,
  sidebarWidth: 320,
  // Linux only: render the tab strip as the window titlebar (frameless window).
  // Off by default so Linux users get the native OS frame; opt in via Settings.
  tabsInTitlebar: false,
  // Ad blocking (src/main/adblock/). Category defaults mirror Freedom iOS:
  // ads (EasyList) and trackers (EasyPrivacy) on, cookie banners and
  // annoyances opt-in. saveSettings() rebuilds the filter engine when any
  // of these change.
  adblockEnabled: true,
  adblockAds: true,
  adblockPrivacy: true,
  adblockCookies: false,
  adblockAnnoyances: false,
  // Pull refreshed filter lists from Swarm on a schedule (WP5). On by
  // default; dormant anyway until a feed trust anchor is compiled in.
  adblockAutoUpdate: true,
  // Keyboard-shortcut remaps: shortcut id → accelerator string. Only ids
  // from the shared registry (src/shared/shortcuts.js) with valid, non-
  // reserved accelerators survive sanitization. The one non-primitive
  // settings value — saveSettings compares it by JSON, not ===.
  shortcutOverrides: {},
};

let cachedSettings = null;

// Shortcut remaps sanitizeOverrides had to revert because their chord is now
// taken by another shortcut's default or fixed alias. Kept in memory (id →
// { accelerator, conflictId, conflict }) so Settings > Shortcuts can tell
// the user which remap went away instead of it just vanishing.
let revertedShortcutOverrides = {};

const getRevertedShortcutOverrides = () => revertedShortcutOverrides;

// One notice per dropped remap, shared by the load and the save path so
// neither can prune a binding silently: both write the same log line and
// both feed getRevertedShortcutOverrides() → the Settings > Shortcuts row.
function recordRevertedOverrides(target) {
  return ({ id, accelerator, conflict }) => {
    target[id] = { accelerator, conflictId: conflict.id, conflict: conflict.description };
    log.warn(
      `[shortcuts] Reverted remap ${id} → ${accelerator}: that combination is now used by "${conflict.description}".`
    );
  };
}

const SEARCH_TERMS_PLACEHOLDER = '{searchTerms}';
const CUSTOM_SEARCH_PROVIDER_LIMIT = 50;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function normalizeSearchUrlTemplate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  const openSearchCount = trimmed.split(SEARCH_TERMS_PLACEHOLDER).length - 1;
  const percentCount = trimmed.split('%s').length - 1;
  if (openSearchCount + percentCount !== 1) return null;

  const normalized = percentCount === 1 ? trimmed.replace('%s', SEARCH_TERMS_PLACEHOLDER) : trimmed;

  try {
    const parsed = new URL(normalized.replace(SEARCH_TERMS_PLACEHOLDER, 'test'));
    const secure = parsed.protocol === 'https:';
    const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
    if ((!secure && !loopbackHttp) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }

  return normalized;
}

function normalizeCustomSearchProviders(value) {
  if (!Array.isArray(value)) return [];

  const normalized = [];
  const seenIds = new Set();
  for (const candidate of value.slice(0, CUSTOM_SEARCH_PROVIDER_LIMIT)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const searchUrlTemplate = normalizeSearchUrlTemplate(candidate.searchUrlTemplate);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !name || name.length > 64) continue;
    if (!searchUrlTemplate || seenIds.has(id)) continue;

    seenIds.add(id);
    normalized.push({ id, name, searchUrlTemplate });
  }

  return normalized;
}

function structuredSettingEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeStructuredSettings(parsed) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'customSearchProviders')) return false;
  const normalized = normalizeCustomSearchProviders(parsed.customSearchProviders);
  if (structuredSettingEquals(parsed.customSearchProviders, normalized)) return false;
  parsed.customSearchProviders = normalized;
  return true;
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

// Rewrites bee-era keys to their ant-named replacements in place. Returns true
// when at least one key was migrated so the caller can persist the result.
function migrateRenamedKeys(parsed) {
  let migrated = false;
  for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, oldKey)) continue;
    if (!Object.prototype.hasOwnProperty.call(parsed, newKey)) {
      parsed[newKey] = parsed[oldKey];
    }
    delete parsed[oldKey];
    migrated = true;
  }
  return migrated;
}

function migrateRemovedKeys(parsed) {
  let migrated = false;
  for (const key of REMOVED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    delete parsed[key];
    migrated = true;
  }
  return migrated;
}

function loadSettings() {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const filePath = getSettingsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      const keysMigrated = migrateRenamedKeys(parsed);
      const removedKeysMigrated = migrateRemovedKeys(parsed);
      const structuredSettingsChanged = normalizeStructuredSettings(parsed);
      const settingsChanged = keysMigrated || removedKeysMigrated || structuredSettingsChanged;
      if (settingsChanged) {
        try {
          fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
        } catch (err) {
          log.error('Failed to persist migrated settings:', err);
        }
      }
      cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
    } else {
      cachedSettings = { ...DEFAULT_SETTINGS };
    }
  } catch (err) {
    log.error('Failed to load settings:', err);
    cachedSettings = { ...DEFAULT_SETTINGS };
  }

  // Defense against hand-edited or stale files: only registry-known,
  // editable, valid, conflict-free shortcut remaps survive into the live
  // settings. A remap recorded while its chord was free but since claimed
  // by a new default or fixed alias is reverted here (it would otherwise
  // fire alongside the new binding on a single press); the file itself is
  // rewritten without it by the next settings save, which persists this
  // sanitized map.
  const reverted = {};
  cachedSettings.shortcutOverrides = sanitizeOverrides(
    cachedSettings.shortcutOverrides,
    process.platform,
    { onDrop: recordRevertedOverrides(reverted) }
  );
  revertedShortcutOverrides = reverted;

  // Apply theme to nativeTheme
  applyNativeTheme(cachedSettings.theme);

  return cachedSettings;
}

function broadcastSettingsUpdated(merged) {
  broadcastToAllWebContents(IPC.SETTINGS_UPDATED, merged);
}

// Main-process subscribers to committed settings changes (e.g. the
// application menu rebuilding on shortcut remaps). Renderers keep using
// the SETTINGS_UPDATED broadcast instead.
const changeListeners = new Set();

function onSettingsChanged(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifySettingsChanged(merged, previous) {
  for (const listener of changeListeners) {
    try {
      listener(merged, previous);
    } catch (err) {
      log.error('Settings change listener failed:', err);
    }
  }
}

// Walks DEFAULT_SETTINGS keys in one pass: drops unknown input keys (defense
// against a buggy or compromised internal page persisting junk to disk) and
// detects no-op saves at the same time. Two structured settings get special
// handling: customSearchProviders is normalized before it reaches disk or a
// renderer, and shortcutOverrides is sanitized against the shortcut registry;
// both compare by JSON, everything else is primitive-valued and compares
// by === .
function saveSettings(newSettings) {
  try {
    const previous = loadSettings();
    const merged = { ...previous };
    let changed = false;

    if (newSettings && typeof newSettings === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.prototype.hasOwnProperty.call(newSettings, key)) continue;

        if (key === 'shortcutOverrides') {
          // The conflict pass has to run here too, not just at load: this is
          // the generic settings write (any internal page can hand it a whole
          // overrides map), and Reset is the one interactive action that can
          // *create* a conflict — restoring an entry's default may claim a
          // chord a sibling was remapped onto, which setOverride never gets
          // to check. Dropping it live is right; dropping it silently is not,
          // so save-path drops go through the same notice as the load path.
          const dropped = {};
          const sanitized = sanitizeOverrides(newSettings[key], process.platform, {
            onDrop: recordRevertedOverrides(dropped),
          });
          const overridesChanged =
            JSON.stringify(sanitized) !== JSON.stringify(previous[key] || {});
          if (overridesChanged) {
            merged[key] = sanitized;
            changed = true;
          }
          // The user has been in Settings > Shortcuts and rebound something —
          // the older "we reverted your old remap" notices have been seen and
          // acted on, so replace them with whatever this save itself dropped
          // (usually nothing).
          if (overridesChanged || Object.keys(dropped).length > 0) {
            revertedShortcutOverrides = dropped;
          }
          continue;
        }

        const nextValue =
          key === 'customSearchProviders'
            ? normalizeCustomSearchProviders(newSettings[key])
            : newSettings[key];
        const valuesMatch =
          key === 'customSearchProviders'
            ? structuredSettingEquals(previous[key], nextValue)
            : previous[key] === nextValue;

        if (!valuesMatch) {
          merged[key] = nextValue;
          changed = true;
        }
      }
    }

    if (!changed) return true;

    const filePath = getSettingsPath();
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
    cachedSettings = merged;

    if (merged.theme !== previous.theme) {
      applyNativeTheme(merged.theme);
    }

    // Same keyed side-effect shape as theme above: a changed adblock flag
    // rebuilds the filter engine, so toggles take effect without a
    // restart. Lazy require — adblock/service requires this module back.
    const adblockChanged = Object.keys(DEFAULT_SETTINGS).some(
      (key) => key.startsWith('adblock') && merged[key] !== previous[key]
    );
    if (adblockChanged) {
      require('./adblock/service')
        .refreshEngine()
        .catch((err) => log.error('[adblock] engine refresh after settings change failed:', err));
    }

    broadcastSettingsUpdated(merged);
    notifySettingsChanged(merged, previous);

    return true;
  } catch (err) {
    log.error('Failed to save settings:', err);
    return false;
  }
}

function registerSettingsIpc() {
  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return loadSettings();
  });

  ipcMain.handle(IPC.SETTINGS_SAVE, (_event, newSettings) => {
    return saveSettings(newSettings);
  });
}

module.exports = {
  loadSettings,
  saveSettings,
  registerSettingsIpc,
  // Exported for the parity test against the renderer copy in search-utils.js.
  normalizeSearchUrlTemplate,
  onSettingsChanged,
  getRevertedShortcutOverrides,
};
