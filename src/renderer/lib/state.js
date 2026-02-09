// Shared renderer state
// This module holds state that needs to be accessed across multiple UI modules

export const state = {
  // Service Registry (updated from main process)
  registry: {
    ipfs: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
    bee: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
  },

  // Bee/Swarm Gateway config (defaults from env or hardcoded, updated from registry)
  beeBase: (window.nodeConfig?.beeApi || 'http://127.0.0.1:1633').replace(/\/$/, ''),
  get bzzRoutePrefix() {
    return `${this.beeBase}/bzz/`;
  },

  // IPFS Gateway config (defaults from env or hardcoded, updated from registry)
  ipfsBase: (window.nodeConfig?.ipfsGateway || 'http://127.0.0.1:8080').replace(/\/$/, ''),
  ipfsApiBase: 'http://127.0.0.1:5001',
  get ipfsRoutePrefix() {
    return `${this.ipfsBase}/ipfs/`;
  },
  get ipnsRoutePrefix() {
    return `${this.ipfsBase}/ipns/`;
  },

  // Navigation state
  currentPageUrl: '',
  pendingNavigationUrl: '',
  pendingTitleForUrl: null,
  hasNavigatedDuringCurrentLoad: false,
  isWebviewLoading: false,
  currentBzzBase: null,
  currentIpfsBase: null,
  knownEnsNames: new Map(), // Maps hash/CID -> ENS name
  ensProtocols: new Map(), // Maps ENS name -> resolved protocol (swarm/ipfs/ipns)
  addressBarSnapshot: '',

  // Webview
  cachedWebContentsId: null,
  resolvingWebContentsId: null,

  // UI state
  menuOpen: false,
  beeMenuOpen: false,

  // Bee/Swarm state
  currentBeeStatus: 'stopped',
  beePeersInterval: null,
  beeVisibleInterval: null,
  beeVersionFetched: false,
  beeVersionValue: '',
  suppressRunningStatus: false,

  // IPFS state
  currentIpfsStatus: 'stopped',
  ipfsPeersInterval: null,
  ipfsVersionFetched: false,
  ipfsVersionValue: '',
  suppressIpfsRunningStatus: false,
};

// Build Bee URL using registry or fallback to defaults
export const buildBeeUrl = (endpoint) => {
  const base = state.registry.bee.api || state.beeBase;
  return `${base}${endpoint}`;
};

// Build IPFS API URL using registry or fallback to defaults
export const buildIpfsApiUrl = (endpoint) => {
  const base = state.registry.ipfs.api || state.ipfsApiBase;
  return `${base}${endpoint}`;
};

// Update registry state from main process
export const updateRegistry = (newRegistry) => {
  state.registry = newRegistry;

  // Update base URLs from registry if available
  if (newRegistry.bee.api) {
    state.beeBase = newRegistry.bee.api.replace(/\/$/, '');
  }
  if (newRegistry.ipfs.gateway) {
    state.ipfsBase = newRegistry.ipfs.gateway.replace(/\/$/, '');
  }
  if (newRegistry.ipfs.api) {
    state.ipfsApiBase = newRegistry.ipfs.api.replace(/\/$/, '');
  }
};

// Get display message for a service (temp message takes priority)
export const getDisplayMessage = (service) => {
  const svc = state.registry[service];
  if (!svc) return null;
  return svc.tempMessage || svc.statusMessage;
};
