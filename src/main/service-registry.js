/**
 * Service Registry - Central tracking of IPFS and Swarm node state
 *
 * This module provides a port-agnostic way for Freedom to access nodes.
 * All URL rewriting resolves through this registry.
 */

const { BrowserWindow, ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');

// Node modes
const MODE = {
  BUNDLED: 'bundled',
  REUSED: 'reused',
  EXTERNAL: 'external',
  NONE: 'none',
};

// Registry state
const registry = {
  ipfs: {
    api: null, // e.g., 'http://127.0.0.1:5001'
    gateway: null, // e.g., 'http://127.0.0.1:8080'
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
  bee: {
    api: null, // e.g., 'http://127.0.0.1:1633'
    gateway: null, // e.g., 'http://127.0.0.1:1635' (debug API serves as gateway)
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
  radicle: {
    api: null,        // e.g., 'http://127.0.0.1:8780'
    gateway: null,    // Same as api for radicle-httpd
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
  radicle: {
    api: null,        // e.g., 'http://127.0.0.1:8780'
    gateway: null,    // Same as api for radicle-httpd
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  },
};

// Default ports
const DEFAULTS = {
  ipfs: {
    apiPort: 5001,
    gatewayPort: 8080,
    p2pPort: 4001,
    fallbackRange: 10, // Try up to 10 ports above default
  },
  bee: {
    apiPort: 1633,
    // Note: Newer Bee versions serve debug/gateway endpoints on the main API port
    p2pPort: 1634,
    fallbackRange: 10,
  },
  radicle: {
    httpPort: 8780,   // radicle-httpd port (avoids 8080 conflicts)
    p2pPort: 8776,    // radicle-node P2P port
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
    bee: { ...registry.bee },
    radicle: { ...registry.radicle },
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

  registry[service] = {
    api: null,
    gateway: null,
    mode: MODE.NONE,
    statusMessage: null,
    tempMessage: null,
    tempMessageTimeout: null,
  };

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
  return registry.ipfs.api || `http://127.0.0.1:${DEFAULTS.ipfs.apiPort}`;
}

/**
 * Get URL for IPFS Gateway
 */
function getIpfsGatewayUrl() {
  return registry.ipfs.gateway || `http://127.0.0.1:${DEFAULTS.ipfs.gatewayPort}`;
}

/**
 * Get URL for Bee API
 */
function getBeeApiUrl() {
  return registry.bee.api || `http://127.0.0.1:${DEFAULTS.bee.apiPort}`;
}

/**
 * Get URL for Bee Gateway (same as API in newer Bee versions)
 */
function getBeeGatewayUrl() {
  return registry.bee.gateway || `http://127.0.0.1:${DEFAULTS.bee.apiPort}`;
}

/**
 * Get URL for Radicle API (radicle-httpd)
 */
function getRadicleApiUrl() {
  return registry.radicle.api || `http://127.0.0.1:${DEFAULTS.radicle.httpPort}`;
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
  getBeeApiUrl,
  getBeeGatewayUrl,
  getRadicleApiUrl,
  broadcastRegistryUpdate,
  registerServiceRegistryIpc,
};
