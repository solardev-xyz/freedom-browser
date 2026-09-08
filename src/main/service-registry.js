/**
 * Service Registry - Central tracking of node state
 *
 * This module provides a port-agnostic way for Freedom to access nodes.
 * All URL rewriting resolves through this registry.
 */

const { BrowserWindow, ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');

// Node modes
const MODE = {
  BUNDLED: 'bundled',
  // In-process node via the libradicle napi addon (no spawned binaries).
  EMBEDDED: 'embedded',
  REUSED: 'reused',
  EXTERNAL: 'external',
  DISABLED: 'disabled',
  NONE: 'none',
};

// Registry state
const registry = {
  ipfs: {
    api: null,
    gateway: null,
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
  myotis: {
    api: null,
    gateway: null,
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
  ant: {
    api: null, // e.g., 'http://127.0.0.1:11633'
    gateway: null, // Same as api for Ant/Bee-compatible HTTP
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
  radicle: {
    api: null,        // radapi://local while the in-process node is running
    gateway: null,
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
  tor: {
    socks: null,      // e.g., '127.0.0.1:9150' (Arti SOCKS5 proxy)
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
};

function createEmptyServiceState(service) {
  if (service === 'tor') {
    return {
      socks: null,
      mode: MODE.NONE,
      statusMessage: null,
      tempMessage: null,
      tempMessageTimeout: null,
    };
  }

  return {
    api: null,
    gateway: null,
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  };
}

// Default ports
const DEFAULTS = {
  ant: {
    apiPort: 1633,
    // Note: Newer Bee versions serve debug/gateway endpoints on the main API port
    p2pPort: 1634,
    fallbackRange: 10,
  },
  tor: {
    socksPort: 19150, // Freedom-managed Arti SOCKS5 proxy; 9150 is treated as external
    fallbackRange: 10,
  },
};

/**
 * Get the current registry state for a service
 */
function getService(service) {
  return registry[service] || null;
}

/**
 * Get the full registry state
 */
function getRegistry() {
  return {
    ipfs: { ...registry.ipfs },
    myotis: { ...registry.myotis },
    ant: { ...registry.ant },
    radicle: { ...registry.radicle },
    tor: { ...registry.tor },
  };
}

/**
 * Update registry for a service
 */
function updateService(service, updates) {
  if (!registry[service]) return;

  Object.assign(registry[service], updates);
  broadcastRegistryUpdate();
}

/**
 * Set permanent status message for a service
 */
function setStatusMessage(service, message) {
  if (!registry[service]) return;

  // Clear any temporary message
  if (registry[service].tempMessageTimeout) {
    clearTimeout(registry[service].tempMessageTimeout);
    registry[service].tempMessageTimeout = null;
  }
  registry[service].tempMessage = null;
  registry[service].statusMessage = message;

  broadcastRegistryUpdate();
}

/**
 * Set temporary status message that auto-settles to permanent message
 */
function setTempStatusMessage(service, message, duration = 8000) {
  if (!registry[service]) return;

  // Clear existing timeout
  if (registry[service].tempMessageTimeout) {
    clearTimeout(registry[service].tempMessageTimeout);
  }

  registry[service].tempMessage = message;
  broadcastRegistryUpdate();

  // Auto-settle after duration
  registry[service].tempMessageTimeout = setTimeout(() => {
    registry[service].tempMessage = null;
    registry[service].tempMessageTimeout = null;
    broadcastRegistryUpdate();
  }, duration);
}

/**
 * Set error state message (overlays statusMessage without clearing it)
 * Use clearErrorState() to remove and reveal original statusMessage
 */
function setErrorState(service, message) {
  if (!registry[service]) return;

  // Clear any auto-clear timeout
  if (registry[service].tempMessageTimeout) {
    clearTimeout(registry[service].tempMessageTimeout);
    registry[service].tempMessageTimeout = null;
  }

  registry[service].tempMessage = message;
  broadcastRegistryUpdate();
}

/**
 * Clear error state, revealing original statusMessage
 */
function clearErrorState(service) {
  if (!registry[service]) return;

  if (registry[service].tempMessageTimeout) {
    clearTimeout(registry[service].tempMessageTimeout);
    registry[service].tempMessageTimeout = null;
  }

  registry[service].tempMessage = null;
  broadcastRegistryUpdate();
}

/**
 * Clear service state (when stopped)
 */
function clearService(service) {
  if (!registry[service]) return;

  if (registry[service].tempMessageTimeout) {
    clearTimeout(registry[service].tempMessageTimeout);
  }

  registry[service] = createEmptyServiceState(service);

  broadcastRegistryUpdate();
}

/**
 * Broadcast registry updates to all windows
 */
function broadcastRegistryUpdate() {
  const windows = BrowserWindow.getAllWindows();
  const state = getRegistry();

  for (const win of windows) {
    try {
      win.webContents.send(IPC.SERVICE_REGISTRY_UPDATE, state);
    } catch {
      // Window might be closing
    }
  }
}

/**
 * Get the current display message for a service (temp message takes priority)
 */
function getDisplayMessage(service) {
  const svc = registry[service];
  if (!svc) return null;
  return svc.tempMessage || svc.statusMessage;
}

/**
 * Get URL for IPFS API
 */
function getIpfsApiUrl() {
  return registry.ipfs.api;
}

/**
 * Get URL for IPFS Gateway
 */
function getIpfsGatewayUrl() {
  return registry.ipfs.gateway;
}

/**
 * Get URL for Ant API
 */
function getAntApiUrl() {
  return registry.ant.api;
}

/**
 * Get URL for Ant Gateway (same as API)
 */
function getAntGatewayUrl() {
  return registry.ant.gateway;
}

/**
 * Get the Arti SOCKS proxy host:port (or default)
 */
function getTorSocksUrl() {
  return registry.tor.socks || `127.0.0.1:${DEFAULTS.tor.socksPort}`;
}

/**
 * Register IPC handlers for service registry
 */
function registerServiceRegistryIpc() {
  ipcMain.handle(IPC.SERVICE_REGISTRY_GET, () => {
    return getRegistry();
  });
}

module.exports = {
  MODE,
  DEFAULTS,
  getService,
  getRegistry,
  updateService,
  setStatusMessage,
  setTempStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
  getDisplayMessage,
  getIpfsApiUrl,
  getIpfsGatewayUrl,
  getAntApiUrl,
  getAntGatewayUrl,
  getTorSocksUrl,
  broadcastRegistryUpdate,
  registerServiceRegistryIpc,
};
