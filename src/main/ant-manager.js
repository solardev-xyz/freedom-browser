const log = require('./logger');
const { ipcMain, app } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const registry = require('./networks/network-registry');
const { startAntChainBridge } = require('./swarm/ant-chain-bridge');
const { getAntDataDir } = require('./profile-paths');
const {
  getActiveProfile,
  getReservedProfilePorts,
  updateActiveProfileNodeConfig,
} = require('./profile-resolver');
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');
const { noteAntApiUrl } = require('./swarm/ant-api-guard');
const { antApiGet } = require('./swarm/ant-api-chrome');
const { loadSettings } = require('./settings-store');

// States
const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let antProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;
let chainBridge = null;
let startGeneration = 0;
const statusListeners = new Set();

function closeChainBridge(bridge = chainBridge) {
  if (chainBridge === bridge) chainBridge = null;
  return bridge ? bridge.close() : Promise.resolve();
}

const CONFIG_FILE = 'config.yaml';
const ETHEREUM_CHAIN_ID = 1;
const DEFAULT_ANT_RESOLVER_RPC_URL = 'https://ethereum.publicnode.com';

// Identity injection flag - when true, require pre-injected keys before start.
let useInjectedIdentity = false;

// Port configuration (resolved at startup)
// Note: Newer Ant versions serve debug endpoints on the main API port
let currentApiPort = DEFAULTS.ant.apiPort;
let currentApiUrl = `http://127.0.0.1:${DEFAULTS.ant.apiPort}`;
let currentMode = MODE.NONE;

function getAntBinaryPath() {
  const arch = process.arch;

  // Map Node.js platform names to our folder names
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  // In dev, ant-bin is at project root (../../ from src/main)
  let basePath = path.join(__dirname, '..', '..', 'ant-bin');

  if (app.isPackaged) {
    basePath = path.join(process.resourcesPath, 'ant-bin');
    const binName = process.platform === 'win32' ? 'antd.exe' : 'antd';
    return path.join(basePath, binName);
  }

  const binName = process.platform === 'win32' ? 'antd.exe' : 'antd';
  return path.join(basePath, `${platform}-${arch}`, binName);
}

function getAntDataPath() {
  return getAntDataDir();
}

function getProfileAntConfig() {
  // The persisted profile contract still uses `nodes.bee` for the Swarm node
  // slot/mode/port assignment. Ant is the managed Swarm implementation behind
  // that profile setting, so keep reading the existing key during this merge.
  return getActiveProfile()?.metadata?.nodes?.bee || null;
}

function isManagedAntConfig(config = getProfileAntConfig()) {
  return config?.mode === 'managed';
}

function isExternalAntConfig(config = getProfileAntConfig()) {
  return config?.mode === 'external';
}

function isDisabledAntConfig(config = getProfileAntConfig()) {
  return config?.mode === 'disabled';
}

function hasUnknownAntMode(config) {
  return Boolean(config?.mode) && !isManagedAntConfig(config)
    && !isExternalAntConfig(config)
    && !isDisabledAntConfig(config);
}

function getConfiguredAntApiPort(config = getProfileAntConfig()) {
  return Number.isInteger(config?.apiPort) ? config.apiPort : DEFAULTS.ant.apiPort;
}

function getConfiguredAntP2pPort(config = getProfileAntConfig()) {
  return Number.isInteger(config?.p2pPort) ? config.p2pPort : DEFAULTS.ant.p2pPort;
}

function normalizeExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

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

function getPortFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function getEndpointLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function getHttpClient(rawUrl) {
  return rawUrl.startsWith('https:') ? https : http;
}

function persistManagedAntPorts(updates) {
  const result = updateActiveProfileNodeConfig('bee', updates);
  if (result) {
    log.info('[Ant] Persisted managed profile ports:', updates);
  }
}

function getPrimaryKeylessRpcUrl(chainId) {
  // Ant config accepts one RPC URL per setting. A keyed commercial provider
  // can have a valid key while a specific chain is disabled for that app, so
  // prefer explicit/user/public keyless sources when available.
  const sources = registry.getEndpointSources(chainId, 'rpc');
  const keyless = sources.find((src) => !src.keyed);
  const keylessUrl = keyless?.coverage?.[String(chainId)];
  if (typeof keylessUrl === 'string' && keylessUrl.trim()) return keylessUrl.trim();

  const [primaryUrl] = registry.getEndpoints(chainId, 'rpc');
  return typeof primaryUrl === 'string' && primaryUrl.trim() ? primaryUrl.trim() : null;
}

function getPrimaryEthereumRpcUrl() {
  return getPrimaryKeylessRpcUrl(ETHEREUM_CHAIN_ID) || DEFAULT_ANT_RESOLVER_RPC_URL;
}

// No `cors-allowed-origins`: nothing in a browser origin may read the API.
// The chrome reaches the node over IPC (`ant:api-get`) and the main process
// over Node's fetch, neither of which is subject to CORS. The old `"null"`
// entry, there for the chrome's `file:` origin, also let every `data:` frame
// and sandboxed iframe read API responses (security audit O-1, #428).
//
// No `blockchain-rpc-endpoint` either. The node reaches Gnosis Chain only
// through the chain bridge, whose URL startAnt passes as `--gnosis-rpc-url`
// (antd lets the flag win over the YAML key), so no RPC URL, keyed or not,
// lands on disk.
//
// `swap-enable` is bee's node-wide switch for paying peers with cheques from
// the chequebook, downloads and uploads alike (#488; Ant's side is
// freedom-hq/ant#126). It comes from the `antSwapEnable` setting, default on
// as in bee and Ant. Ant releases from before the switch parse the key and
// ignore it, so it is always written; whether the bundled antd honours it is
// what getSwapEnableSupport() probes.
function buildAntConfigContent({
  dataDir,
  apiPort,
  p2pPort,
  password,
  resolverRpcEndpoint,
  swapEnable = true,
}) {
  return `# Ant node configuration (bee-compatible keys)
api-addr: 127.0.0.1:${apiPort}
p2p-addr: :${p2pPort}
mainnet: true
full-node: false
swap-enable: ${swapEnable ? 'true' : 'false'}
skip-postage-snapshot: true
resolver-options: "${resolverRpcEndpoint}"
storage-incentives-enable: false
data-dir: ${dataDir}
password: ${password}
`;
}

function isSwapEnabledSetting() {
  return loadSettings().antSwapEnable !== false;
}

// Whether the bundled antd honours `swap-enable` (#488). Ant has no HTTP
// route or `/node` field that says so, and the pinned release predates the
// switch, so ask the binary itself: a release with the switch lists
// `--swap-enable` in its `--help`. The answer is cached per binary file, so
// a pin bump in a dev checkout is picked up without restarting Freedom.
const SWAP_SUPPORT_PROBE_TIMEOUT_MS = 5000;
let swapSupportCache = null; // { key, promise }

function probeSwapEnableSupport(binPath) {
  return new Promise((resolve) => {
    try {
      execFile(
        binPath,
        ['--help'],
        { timeout: SWAP_SUPPORT_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout = '', stderr = '') => {
          const text = `${stdout}\n${stderr}`;
          if (/(^|\s)--swap-enable(?![\w-])/m.test(text)) {
            resolve('supported');
            return;
          }
          if (err && !stdout) {
            log.warn(`[Ant] Could not read antd --help: ${err.message}`);
            resolve('unknown');
            return;
          }
          resolve('unsupported');
        }
      );
    } catch (err) {
      log.warn(`[Ant] Could not run antd --help: ${err.message}`);
      resolve('unknown');
    }
  });
}

/**
 * `'supported'` / `'unsupported'` when Freedom runs its bundled antd,
 * `'unmanaged'` when the node is reused, external or disabled (its own
 * configuration decides, and Freedom cannot restart it), `'unknown'` when
 * the binary could not be asked.
 */
async function getSwapEnableSupport() {
  if (
    currentMode === MODE.REUSED ||
    currentMode === MODE.EXTERNAL ||
    currentMode === MODE.DISABLED ||
    isExternalAntConfig() ||
    isDisabledAntConfig()
  ) {
    return 'unmanaged';
  }
  const binPath = getAntBinaryPath();
  let stat;
  try {
    stat = fs.statSync(binPath);
  } catch {
    return 'unknown';
  }
  const key = `${binPath}:${stat.size}:${stat.mtimeMs}`;
  if (swapSupportCache?.key !== key) {
    swapSupportCache = { key, promise: probeSwapEnableSupport(binPath) };
  }
  const result = await swapSupportCache.promise;
  if (result === 'unknown' && swapSupportCache?.key === key) swapSupportCache = null;
  return result;
}

function ensureConfig(dataDir, apiPort, p2pPort = DEFAULTS.ant.p2pPort) {
  const configPath = path.join(dataDir, CONFIG_FILE);
  const crypto = require('crypto');

  // Check if config exists and read current password if so
  let password;
  if (fs.existsSync(configPath)) {
    try {
      const existingConfig = fs.readFileSync(configPath, 'utf-8');
      const passwordMatch = existingConfig.match(/^password:\s*(.+)$/m);
      if (passwordMatch) {
        password = passwordMatch[1].trim();
      }
    } catch {
      log.warn('[Ant] Could not read existing password, generating new one');
    }
  }

  // Generate new password if we couldn't read one — but never while a
  // keystore is present whose only decryption password is the one we just
  // failed to recover (e.g. the bee-data migration carried over both
  // config.yaml and keys/swarm.key). Silently minting a fresh password here
  // would leave that keystore permanently undecryptable, so fail loudly and
  // let startAnt surface the error instead.
  if (!password) {
    if (fs.existsSync(path.join(dataDir, 'keys', 'swarm.key'))) {
      throw new Error(
        `A keystore exists at ${path.join(dataDir, 'keys', 'swarm.key')} but its password ` +
          `could not be recovered from ${configPath} — refusing to generate a new password ` +
          'that would make the keystore undecryptable.'
      );
    }
    password = crypto.randomBytes(32).toString('hex');
  }

  const resolverRpcEndpoint = getPrimaryEthereumRpcUrl();

  // Always write config with current port
  // Note: Newer Ant versions don't have separate debug-api-addr, debug endpoints are on main API
  const configContent = buildAntConfigContent({
    dataDir,
    apiPort,
    p2pPort,
    password,
    resolverRpcEndpoint,
    swapEnable: isSwapEnabledSetting(),
  });

  fs.writeFileSync(configPath, configContent);
  log.info(`[Ant] Config written at ${configPath} with API:${apiPort} P2P:${p2pPort}`);

  // Identity handling. Unlike bee, antd has no `init` subcommand: when an
  // injected Web3 v3 keystore exists at `keys/swarm.key` antd loads its
  // identity from it; otherwise antd self-generates a native identity
  // (`identity.json`) on start. So there is no separate init step to run.
  const keysDir = path.join(dataDir, 'keys');
  const swarmKeyPath = path.join(keysDir, 'swarm.key');

  if (fs.existsSync(swarmKeyPath)) {
    log.info('[Ant] Using existing/injected keys from', keysDir);
  } else {
    log.info('[Ant] No injected keystore; antd will self-initialize its node identity on start');
  }

  return configPath;
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  // Broadcast to all windows
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.ANT_STATUS_UPDATE, { status: currentState, error: lastError });
  }
  for (const listener of statusListeners) {
    try {
      listener({ status: currentState, error: lastError });
    } catch (err) {
      log.error('[Ant] Status listener failed:', err);
    }
  }
}

/**
 * Main-process subscribers to node status changes (the publish setup
 * service). Returns an unsubscribe function.
 */
function onStatusChange(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * Check if a port is open (something is listening)
 */
function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Probe Ant health endpoint
 */
function probeAntApiUrl(apiUrl) {
  return new Promise((resolve) => {
    const healthUrl = `${apiUrl}/health`;
    const req = getHttpClient(healthUrl).get(healthUrl, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ valid: true, data: parsed });
          } catch {
            resolve({ valid: false });
          }
        });
      } else {
        resolve({ valid: false });
        res.resume();
      }
    });

    req.on('error', () => resolve({ valid: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false });
    });
    req.end();
  });
}

function probeAntApi(port) {
  return probeAntApiUrl(`http://127.0.0.1:${port}`);
}

/**
 * Find an available port starting from the default
 */
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.ant.fallbackRange, options = {}) {
  const reservedPorts = options.reservedPorts || new Set();
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    if (reservedPorts.has(port)) {
      log.info(`[Ant] Port ${port} is reserved by another profile, trying next...`);
      continue;
    }
    const open = await isPortOpen(port);
    if (!open) {
      return port;
    }
    log.info(`[Ant] Port ${port} is busy, trying next...`);
  }
  return null;
}

/**
 * Detect if an existing Ant daemon is running and reusable
 * Always checks default port first to detect conflicts properly
 */
async function detectExistingDaemon() {
  const defaultPort = DEFAULTS.ant.apiPort;

  // First check if anything is on the default API port
  const portOpen = await isPortOpen(defaultPort);
  if (!portOpen) {
    return { found: false };
  }

  // Probe to see if it's actually Ant
  const probe = await probeAntApi(defaultPort);
  if (probe.valid) {
    log.info('[Ant] Found existing daemon on port', defaultPort);
    return {
      found: true,
      port: defaultPort,
      version: probe.data?.version,
    };
  }

  // Port is open but not Ant - conflict
  log.info('[Ant] Port', defaultPort, 'is busy (not an Ant daemon)');
  return { found: false, conflict: true, port: defaultPort };
}

async function checkHealth() {
  return new Promise((resolve) => {
    const req = getHttpClient(currentApiUrl).get(`${currentApiUrl}/health`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        resolve(false);
      }
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  healthCheckInterval = setInterval(async () => {
    const isHealthy = await checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'Health check failed');
      setErrorState('ant', 'Node unreachable. Retrying…');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      // Recovered - clear error state (reveals original statusMessage)
      clearErrorState('ant');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function startExternalAnt(config) {
  const apiUrl = normalizeExternalUrl(config?.externalApi);
  if (!apiUrl) {
    updateState(STATUS.ERROR, 'External Ant API endpoint is not configured');
    setStatusMessage('ant', 'External node not configured');
    return;
  }

  const probe = await probeAntApiUrl(apiUrl);
  if (!probe.valid) {
    updateState(STATUS.ERROR, 'External Ant API endpoint is unreachable');
    setStatusMessage('ant', 'External node unreachable');
    return;
  }

  currentApiUrl = apiUrl;
  noteAntApiUrl(currentApiUrl);
  currentApiPort = getPortFromUrl(apiUrl);
  currentMode = MODE.EXTERNAL;

  updateService('ant', {
    api: currentApiUrl,
    gateway: currentApiUrl,
    mode: MODE.EXTERNAL,
  });
  setStatusMessage('ant', `External node: ${getEndpointLabel(currentApiUrl)}`);

  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info('[Ant] Connected to external API at', currentApiUrl);
}

function startDisabledAnt() {
  currentApiPort = null;
  currentApiUrl = null;
  currentMode = MODE.DISABLED;
  updateService('ant', {
    api: null,
    gateway: null,
    mode: MODE.DISABLED,
  });
  setStatusMessage('ant', 'Node disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[Ant] Disabled for active profile');
}

async function startAnt() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Ant] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[Ant] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  const generation = ++startGeneration;
  updateState(STATUS.STARTING);

  const profileConfig = getProfileAntConfig();
  const managedProfileNode = isManagedAntConfig(profileConfig);

  if (hasUnknownAntMode(profileConfig)) {
    updateState(STATUS.ERROR, `Unsupported Ant node mode: ${profileConfig.mode}`);
    setStatusMessage('ant', 'Node failed to start');
    return;
  }

  if (isDisabledAntConfig(profileConfig)) {
    startDisabledAnt();
    return;
  }

  if (isExternalAntConfig(profileConfig)) {
    await startExternalAnt(profileConfig);
    return;
  }

  // Step 1: Legacy/profile-dir launches may still opt into a system daemon.
  const existing = managedProfileNode ? { found: false } : await detectExistingDaemon();

  if (generation !== startGeneration) return;

  if (existing.found) {
    // Reuse existing daemon
    currentApiPort = existing.port;
    currentApiUrl = `http://127.0.0.1:${currentApiPort}`;
    noteAntApiUrl(currentApiUrl);
    currentMode = MODE.REUSED;

    updateService('ant', {
      api: currentApiUrl,
      gateway: currentApiUrl,
      mode: MODE.REUSED,
    });
    setStatusMessage('ant', `Node: localhost:${currentApiPort}`);

    updateState(STATUS.RUNNING);
    startHealthCheck();
    log.info('[Ant] Reusing existing daemon on port', currentApiPort);
    return;
  }

  // Step 2: Start bundled node — but never on a data dir whose identity
  // migration hasn't completed. If the bee-data → ant-data migration failed
  // (it retries on next launch), spawning antd now would self-generate a
  // throwaway identity and the user's first post-upgrade session would run
  // under the wrong overlay address. This guards every start path: launch
  // auto-start, the IPC handler, and onboarding. (Reusing an external daemon
  // above is fine — it has its own data dir.)
  const { isBeeDataMigrationPending } = require('./migrate-user-data');
  if (isBeeDataMigrationPending()) {
    const msg =
      'Node start blocked: the Bee → Ant identity migration has not completed. Restart Freedom to retry.';
    log.error(`[Ant] ${msg}`);
    updateState(STATUS.ERROR, msg);
    setStatusMessage('ant', 'Node start deferred (identity migration pending)');
    return;
  }

  const binPath = getAntBinaryPath();
  if (!fs.existsSync(binPath)) {
    const msg = `Ant binary not found at ${binPath}`;
    log.error(`[Ant] ${msg}`);
    updateState(STATUS.ERROR, msg);
    setStatusMessage('ant', 'Node failed to start');
    return;
  }

  const dataDir = getAntDataPath();

  // In injected-identity mode (an identity vault exists) never spawn antd
  // without the injected keystore: antd would self-generate a throwaway
  // native identity — wrong overlay address, none of the user's postage
  // stamps or chequebook funds. IPFS and Radicle defer the same way. The
  // identity lifecycle start hook retries this start after injection, and
  // launch auto-start picks it up once keys/swarm.key exists.
  if (useInjectedIdentity && !fs.existsSync(path.join(dataDir, 'keys', 'swarm.key'))) {
    const msg =
      'Node start deferred: identity vault present but no node key injected yet. Complete identity setup to start the node.';
    log.warn(`[Ant] ${msg}`);
    updateState(STATUS.ERROR, msg);
    setStatusMessage('ant', 'Node start deferred (waiting for identity injection)');
    return;
  }

  // Step 3: Resolve ports (handle conflicts)
  let apiPort = getConfiguredAntApiPort(profileConfig);
  let p2pPort = getConfiguredAntP2pPort(profileConfig);
  const configuredApiPort = apiPort;
  const configuredP2pPort = p2pPort;
  let usingFallbackPort = false;
  const reservedProfilePorts = managedProfileNode ? getReservedProfilePorts() : new Set();

  const managedApiPortBusy = managedProfileNode ? await isPortOpen(apiPort) : false;
  if (existing.conflict || managedApiPortBusy) {
    const newApiPort = await findAvailablePort(apiPort + 1, DEFAULTS.ant.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!newApiPort) {
      updateState(STATUS.ERROR, 'No available ports for Ant API');
      setStatusMessage('ant', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    apiPort = newApiPort;
  }

  const managedP2pPortBusy = managedProfileNode ? await isPortOpen(p2pPort) : false;
  if (managedP2pPortBusy) {
    const newP2pPort = await findAvailablePort(p2pPort + 1, DEFAULTS.ant.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!newP2pPort) {
      updateState(STATUS.ERROR, 'No available ports for Ant P2P');
      setStatusMessage('ant', 'Node failed to start');
      return;
    }
    p2pPort = newP2pPort;
    usingFallbackPort = true;
  }

  if (managedProfileNode && (apiPort !== configuredApiPort || p2pPort !== configuredP2pPort)) {
    try {
      persistManagedAntPorts({ apiPort, p2pPort });
    } catch (err) {
      log.error('[Ant] Failed to persist managed profile ports:', err.message);
      updateState(STATUS.ERROR, 'Failed to save Ant port assignment');
      setStatusMessage('ant', 'Node failed to start');
      return;
    }
  }

  if (generation !== startGeneration) return;

  currentApiPort = apiPort;
  currentApiUrl = `http://127.0.0.1:${currentApiPort}`;
  noteAntApiUrl(currentApiUrl);
  currentMode = MODE.BUNDLED;

  let configPath;
  try {
    configPath = ensureConfig(dataDir, apiPort, p2pPort);
  } catch (err) {
    log.error('[Ant] Failed to prepare config:', err.message);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ant', 'Node failed to start');
    return;
  }

  /*
   * antd is flag-only (no `start` subcommand): it runs the node directly from
   * the bee-compatible YAML config Freedom writes.
   *
   * IMPORTANT: Do not let antd bind its default control socket at
   * `<data-dir>/antd.sock` when Freedom manages it. macOS and Linux impose a
   * hard sockaddr_un path limit, and profile-aware dev paths such as:
   *
   *   ~/Library/Application Support/Freedom Dev/<checkout>/Profiles/default/ant-data/antd.sock
   *
   * can exceed that limit and make antd exit with
   * "control socket: io: path must be shorter than SUN_LEN". Freedom talks to
   * the node through the HTTP API, not antctl, so the managed desktop node does
   * not need a control socket at all. Keeping the socket disabled avoids adding
   * a second profile-owned short-home exception like Radicle's.
   *
   * The node always gets a write-capable chain transport: there is no
   * browse-only mode to switch out of before publishing. The bridge's URL
   * carries a capability path only this spawn knows, and the only
   * transactions it forwards are signed ones for Gnosis Chain (chain 100).
   */
  let bridge;
  try {
    bridge = await startAntChainBridge({ allowBroadcast: true });
    if (generation !== startGeneration) {
      await bridge.close();
      return;
    }
    chainBridge = bridge;
  } catch {
    if (generation !== startGeneration) return;
    updateState(STATUS.ERROR, 'Could not start the local Ant chain transport');
    setStatusMessage('ant', 'Node failed to start');
    return;
  }
  const args = [`--config=${configPath}`, '--no-control-socket'];

  log.info(`[Ant] Starting: ${binPath} ${args.join(' ')} (private chain transport)`);
  args.push(`--gnosis-logs-rpc-url=${bridge.url}`, `--gnosis-rpc-url=${bridge.url}`);

  try {
    antProcess = spawn(binPath, args);
    const child = antProcess;

    bridge.pipeLog(child.stdout, (line) => log.info(`[Ant stdout]: ${line}`));
    bridge.pipeLog(child.stderr, (line) => log.error(`[Ant stderr]: ${line}`));

    antProcess.on('close', (code) => {
      void closeChainBridge(bridge);
      if (antProcess !== child) return;
      log.info(`[Ant] Process exited with code ${code}`);
      antProcess = null;

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, code !== 0 ? `Exited with code ${code}` : null);
      } else {
        updateState(STATUS.STOPPED);
      }
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      clearService('ant');

      if (pendingStart) {
        log.info('[Ant] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startAnt(), 100);
      }
    });

    antProcess.on('error', (err) => {
      void closeChainBridge(bridge);
      if (antProcess !== child) return;
      log.error('[Ant] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('ant', 'Node failed to start');
    });

    // Poll for health until running
    let attempts = 0;
    const maxAttempts = 60;
    const pollInterval = setInterval(async () => {
      if (generation !== startGeneration || antProcess !== child ||
          currentState === STATUS.STOPPED || currentState === STATUS.ERROR) {
        clearInterval(pollInterval);
        return;
      }

      const isHealthy = await checkHealth();
      if (generation !== startGeneration || antProcess !== child) {
        clearInterval(pollInterval);
        return;
      }
      if (isHealthy) {
        clearInterval(pollInterval);

        // Update registry (API and gateway are same port in newer Ant)
        updateService('ant', {
          api: currentApiUrl,
          gateway: currentApiUrl,
          mode: MODE.BUNDLED,
        });

        // Only show status line if using fallback port
        if (usingFallbackPort) {
          setStatusMessage('ant', `Fallback Port: ${currentApiPort}`);
        } else {
          // Clear any previous status for normal healthy state
          setStatusMessage('ant', null);
        }

        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopAnt();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('ant', 'Node failed to start');
        }
      }
    }, 1000);
  } catch (err) {
    await closeChainBridge(bridge);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ant', 'Node failed to start');
  }
}

// Stop Ant and return a Promise that resolves when the process exits
function stopAnt() {
  ++startGeneration;
  const bridgeClosed = closeChainBridge();
  return new Promise((resolve) => {
    pendingStart = false;

    // If this process does not own a daemon, just clear state.
    if (currentMode === MODE.REUSED || currentMode === MODE.EXTERNAL || currentMode === MODE.DISABLED) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ant');
      currentMode = MODE.NONE;
      resolve();
      return;
    }

    if (!antProcess) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ant');
      resolve();
      return;
    }

    // Listen for the process to exit
    const onExit = () => {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      resolve();
    };

    antProcess.once('close', onExit);

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    // Try graceful shutdown via SIGTERM
    antProcess.kill('SIGTERM');

    // Force kill if it doesn't exit within 5 seconds
    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (antProcess) {
        log.warn('[Ant] Force killing process...');
        antProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);

    // Try graceful shutdown via SIGTERM
    antProcess.kill('SIGTERM');
  }).then(() => bridgeClosed);
}

function checkBinary() {
  const binPath = getAntBinaryPath();
  return fs.existsSync(binPath);
}

/**
 * Enable injected identity mode - require pre-injected keys before start.
 * Call this before starting Ant when using the unified identity system
 */
function setUseInjectedIdentity(enabled) {
  useInjectedIdentity = enabled;
  log.info(`[Ant] Injected identity mode: ${enabled}`);
}

/**
 * Check if keys have been injected
 */
function hasInjectedKeys() {
  const dataDir = getAntDataPath();
  const swarmKeyPath = path.join(dataDir, 'keys', 'swarm.key');
  return fs.existsSync(swarmKeyPath);
}

function getActivePort() {
  return currentApiPort;
}

function getStatus() {
  return { status: currentState, error: lastError };
}

function registerAntIpc() {
  ipcMain.handle(IPC.ANT_START, async () => {
    await startAnt();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.ANT_STOP, async () => {
    await stopAnt();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.ANT_GET_STATUS, () => {
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.ANT_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });

  // Chrome-only (no webview tier in ipc-sender-policy.js): read-only node
  // API access for the chrome's status/wallet screens. See ant-api-chrome.js.
  ipcMain.handle(IPC.ANT_API_GET, (_event, endpoint) => antApiGet(endpoint));
}

function hasLiveProcess() {
  return antProcess !== null;
}

// States in which an Ant node may still hold the statestore LevelDB lock even
// without a managed child process we can see: RUNNING also covers a reused
// external daemon (antProcess is null) and ERROR can be set by a failed health
// check without the process being killed.
const LOCK_HOLDING_STATES = new Set([
  STATUS.RUNNING,
  STATUS.STARTING,
  STATUS.STOPPING,
  STATUS.ERROR,
]);

// Lifecycle hooks for identity (re)injection: the injector must stop an Ant
// node that holds the statestore LevelDB lock before wiping it, then restart
// it with the new key. Any live process is treated as active (STARTING grabs
// the lock before health passes; STOPPING is before the close event; ERROR can
// leave the process alive), otherwise the wipe fails with EPERM on Windows
// (issue #90). Dependencies are injectable so the decision can be unit-tested
// without spawning a real node.
function createAntLifecycle(deps = {}) {
  const getStatusFn = deps.getStatus || getStatus;
  const hasLiveProcessFn = deps.hasLiveProcess || hasLiveProcess;
  const stopFn = deps.stopAnt || stopAnt;
  const startFn = deps.startAnt || startAnt;
  const setInjected = deps.setUseInjectedIdentity || setUseInjectedIdentity;
  return {
    stop: async () => {
      const status = getStatusFn().status;
      const active = hasLiveProcessFn() || LOCK_HOLDING_STATES.has(status);
      if (active) await stopFn();
      return active;
    },
    start: async () => {
      setInjected(true);
      await startFn();
    },
  };
}

module.exports = {
  registerAntIpc,
  createAntLifecycle,
  hasLiveProcess,
  startAnt,
  stopAnt,
  getActivePort,
  getStatus,
  onStatusChange,
  getAntDataPath,
  setUseInjectedIdentity,
  hasInjectedKeys,
  getPrimaryEthereumRpcUrl,
  getSwapEnableSupport,
  buildAntConfigContent,
  STATUS,
};
