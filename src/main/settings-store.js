const log = require('./logger');
const { app, ipcMain, nativeTheme, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');

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

// Default public Ethereum RPC endpoints used for ENS quorum resolution when no
// custom RPC is configured. Users can edit this list in settings (add/remove).
// Operator diversity note: URL count != operator count — several of these may
// proxy to the same backend (Alchemy, Infura). Documented in threat model.
const DEFAULT_ENS_PUBLIC_RPC_PROVIDERS = [
  'https://ethereum.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
  'https://eth.merkle.io',
  'https://cloudflare-eth.com',
  'https://rpc.ankr.com/eth',
  'https://rpc.flashbots.net',
  'https://eth.llamarpc.com',
];

const DEFAULT_SETTINGS = {
  theme: 'system',
  enableRadicleIntegration: false,
  enableIdentityWallet: true,
  beeNodeMode: 'ultraLight',
  startBeeAtLaunch: true,
  startIpfsAtLaunch: true,
  startRadicleAtLaunch: false,
  autoUpdate: true,
  showBookmarkBar: false,
  enableEnsCustomRpc: false,
  ensRpcUrl: '',
  // ENS public-RPC quorum resolution (active when enableEnsCustomRpc=false).
  // Detects RPC lying by requiring ensQuorumM of K parallel providers to
  // return byte-identical data at a pinned block. See docs/ens-resolution.md.
  enableEnsQuorum: true,
  ensQuorumK: 3,
  ensQuorumM: 2,
  ensQuorumTimeoutMs: 5000,
  // Block tag all quorum legs query at, so honest-but-unsynced providers
  // don't produce false conflicts. 'latest' is near-real-time; 'finalized'
  // is ~12min behind head but strongest; 'latest-32' is ~3min behind.
  ensBlockAnchor: 'latest',
  ensBlockAnchorTtlMs: 30000,
  ensPublicRpcProviders: DEFAULT_ENS_PUBLIC_RPC_PROVIDERS,
  // When true, navigation to an ENS name that resolved with trust.level =
  // 'unverified' is gated behind an interstitial with a single-use
  // "Continue once" option. Turn off to navigate straight through with
  // only the amber shield for signal.
  blockUnverifiedEns: true,
  sidebarOpen: false,
  sidebarWidth: 320,
};

// Settings keys whose value is an array rather than a primitive. The
// saveSettings validator uses JSON-equality for these instead of ===.
const ARRAY_SETTINGS_KEYS = new Set(['ensPublicRpcProviders']);

let cachedSettings = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function loadSettings() {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const filePath = getSettingsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      cachedSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    } else {
      cachedSettings = { ...DEFAULT_SETTINGS };
    }
  } catch (err) {
    log.error('Failed to load settings:', err);
    cachedSettings = { ...DEFAULT_SETTINGS };
  }

  // Apply theme to nativeTheme
  applyNativeTheme(cachedSettings.theme);

  return cachedSettings;
}

function broadcastSettingsUpdated(merged) {
  if (!webContents?.getAllWebContents) return;
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send(IPC.SETTINGS_UPDATED, merged);
    } catch {
      // webContents may be destroyed
    }
  }
}

// Walks DEFAULT_SETTINGS keys in one pass: drops unknown input keys (defense
// against a buggy or compromised internal page persisting junk to disk) and
// detects no-op saves at the same time. Array-valued keys (see
// ARRAY_SETTINGS_KEYS) compare by JSON-equality; all other keys must be
// primitive and compare by === .
function saveSettings(newSettings) {
  try {
    const previous = loadSettings();
    const merged = { ...previous };
    let changed = false;

    if (newSettings && typeof newSettings === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.prototype.hasOwnProperty.call(newSettings, key)) continue;

        const nextValue = newSettings[key];
        const prevValue = previous[key];

        let differs;
        if (ARRAY_SETTINGS_KEYS.has(key)) {
          // Reject non-arrays for array-typed keys to keep disk state sane.
          if (!Array.isArray(nextValue)) continue;
          differs = JSON.stringify(prevValue) !== JSON.stringify(nextValue);
        } else {
          differs = prevValue !== nextValue;
        }

        if (differs) {
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

    broadcastSettingsUpdated(merged);

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
  DEFAULT_ENS_PUBLIC_RPC_PROVIDERS,
};
