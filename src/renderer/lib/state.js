// Shared renderer state
// This module holds state that needs to be accessed across multiple UI modules

const normalizeBaseUrl = (value) =>
  typeof value === 'string' && value ? value.replace(/\/$/, '') : null;

// Internal canonical base used by the renderer's URL parser and by tests that
// expect a gateway-shaped intermediate. Freedom does not expose a desktop
// Kubo-compatible loopback gateway; real loads go through ipfs:// / ipns://
// and the main-process native freedom-ipfs request API.
const NATIVE_IPFS_BASE = 'http://freedom-ipfs.localhost';
// The embedded Radicle protocol is registered for the app lifetime. Node
// readiness affects responses, not whether renderer navigation has a route.
const NATIVE_RADICLE_BASE = 'radapi://local';
const envAntApi = normalizeBaseUrl(window.nodeConfig?.antApi);

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
    myotis: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
    ant: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
    radicle: {
      api: null,
      gateway: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
    tor: {
      socks: null,
      mode: 'none',
      statusMessage: null,
      tempMessage: null,
    },
  },

  // Swarm Gateway config (from env override or registry)
  antBase: envAntApi,
  get bzzRoutePrefix() {
    return this.antBase ? `${this.antBase}/bzz/` : null;
  },

  // IPFS native gateway-shaped canonical base. This is not an external Kubo endpoint.
  ipfsBase: NATIVE_IPFS_BASE,
  ipfsApiBase: null,
  get ipfsRoutePrefix() {
    return this.ipfsBase ? `${this.ipfsBase}/ipfs/` : null;
  },
  get ipnsRoutePrefix() {
    return this.ipfsBase ? `${this.ipfsBase}/ipns/` : null;
  },

  // Navigation state
  currentPageUrl: '',
  pendingNavigationUrl: '',
  pendingTitleForUrl: null,
  hasNavigatedDuringCurrentLoad: false,
  isWebviewLoading: false,
  currentBzzBase: null,
  knownEnsNames: new Map(), // Maps hash/CID -> ENS name
  ensProtocols: new Map(), // Maps ENS name -> resolved protocol (swarm/ipfs/ipns)
  ensTrustByName: new Map(), // Maps ENS name -> trust object from last resolution
  ensUriByName: new Map(), // Maps ENS name -> full resolved content URI (bzz://HASH, ipfs://CID, ipns://NAME)
  // Transient draft/restoration state — overwritten with the live address
  // bar value on focusin and tab-switched. Do not key reload or other
  // commit-sensitive decisions on this field; use `committedDisplayUrl`.
  addressBarSnapshot: '',
  // User-facing identity of the last committed navigation. Written only by
  // tabs.js' per-webview did-navigate handler, so it stays stable when the
  // user is mid-typing or while a navigation is still in flight. Usually it
  // equals `webview.getURL()`; synthetic onchain origins are reverse-mapped to
  // their standard `web3://` form. The actual URL remains in per-tab state.
  committedDisplayUrl: '',

  // Webview
  cachedWebContentsId: null,
  resolvingWebContentsId: null,

  // UI state
  menuOpen: false,
  antMenuOpen: false,

  // Bee/Swarm state
  currentAntStatus: 'stopped',
  antPeersInterval: null,
  antVisibleInterval: null,
  antVersionFetched: false,
  antVersionValue: '',
  suppressRunningStatus: false,

  // IPFS state
  currentIpfsStatus: 'stopped',
  ipfsInfoInterval: null,
  ipfsVersionFetched: false,
  ipfsVersionValue: '',
  // null = no toggle in flight; true/false = the running state the user just
  // requested but which the backend hasn't confirmed yet. Lets the switch hold
  // the user's intent through transient backend states (see ipfs-ui.js).
  ipfsDesiredRunning: null,

  // Radicle state
  currentRadicleStatus: 'stopped',
  radicleVersionFetched: false,
  radicleVersionValue: '',
  suppressRadicleRunningStatus: false,

  // Canonical in-process Radicle API route. Keep this available while the
  // node starts or is offline so valid RIDs never become validation errors.
  radicleBase: NATIVE_RADICLE_BASE,
  get radicleApiPrefix() {
    return this.radicleBase ? `${this.radicleBase}/api/v1/repos/` : null;
  },

  // Tor (.onion) state
  currentTorStatus: 'stopped',
  suppressTorRunningStatus: false,

  // Feature flags
  enableTorIntegration: false,
  blockUnverifiedEns: true, // When true, unverified ENS resolutions route through an interstitial

  // Address-bar search provider id, synced from settings. buildSearchUrl in
  // search-utils.js owns the fallback: null or unknown ids map to the default.
  searchProvider: null,
  customSearchProviders: [],
};

const buildServiceUrl = (base, endpoint, serviceName) => {
  if (!base) {
    throw new Error(`${serviceName} endpoint is not ready`);
  }
  return `${base}${endpoint}`;
};

// Build Ant URL using registry or explicit env override
export const buildAntUrl = (endpoint) => {
  const base = state.registry.ant.api || state.antBase;
  return buildServiceUrl(base, endpoint, 'Ant');
};

// Build IPFS API URL using registry
export const buildIpfsApiUrl = (endpoint) => {
  const base = state.registry.ipfs.api || state.ipfsApiBase;
  return buildServiceUrl(base, endpoint, 'IPFS API');
};

// Build Radicle API URL using registry
export const buildRadicleUrl = (endpoint) => {
  const base = state.registry.radicle.api || state.radicleBase;
  return buildServiceUrl(base, endpoint, 'Radicle');
};

// True when the active profile has Radicle switched off entirely (Settings →
// Nodes → Radicle → Disabled). The main process publishes the mode into the
// service registry, so this stays a synchronous read for navigation.
export const isRadicleDisabledForProfile = () => state.registry?.radicle?.mode === 'disabled';

// Update registry state from main process
export const updateRegistry = (newRegistry) => {
  state.registry = newRegistry;

  state.antBase = normalizeBaseUrl(newRegistry.ant?.api) || envAntApi;
  state.ipfsBase = normalizeBaseUrl(newRegistry.ipfs?.gateway) || NATIVE_IPFS_BASE;
  state.ipfsApiBase = normalizeBaseUrl(newRegistry.ipfs?.api);
  state.radicleBase = normalizeBaseUrl(newRegistry.radicle?.api) || NATIVE_RADICLE_BASE;
};

export const setTorIntegrationEnabled = (enabled) => {
  state.enableTorIntegration = enabled === true;
};

export const setBlockUnverifiedEns = (enabled) => {
  state.blockUnverifiedEns = enabled !== false;
};

export const setSearchProvider = (providerId, customProviders = []) => {
  state.searchProvider = providerId ?? null;
  state.customSearchProviders = Array.isArray(customProviders) ? customProviders : [];
};

// Sync renderer feature flags from a settings payload. Passing null (settings
// unavailable) resets every flag to its default.
export const applySettingsToState = (settings) => {
  setTorIntegrationEnabled(settings?.enableTorIntegration === true);
  setBlockUnverifiedEns(settings?.blockUnverifiedEns !== false);
  setSearchProvider(settings?.searchProvider, settings?.customSearchProviders);
};

// Get display message for a service (temp message takes priority)
export const getDisplayMessage = (service) => {
  const svc = state.registry[service];
  if (!svc) return null;
  return svc.tempMessage || svc.statusMessage;
};
