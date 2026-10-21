const log = require('./logger');
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');
const { getIpfsDataDir } = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const { getLockDir } = require('./service-locks');
const {
  MODE,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');
const { FreedomIpfsNativeNode } = require('./ipfs/freedom-ipfs-native-node');
const { FreedomIpfsdNode } = require('./ipfs/freedom-ipfsd-node');
const {
  IPFS_GATEWAY_PROBE_PATH,
  isIpfsGatewayProbeResponse,
} = require('./ipfs/ipfs-gateway-probe');
// Every dial of the configured gateway goes through this one transport, so a
// remote endpoint follows the session's proxy policy (the Tor PAC) instead of
// undici's own socket stack, which never sees it. See ipfs/gateway-transport.js.
const { gatewayFetch, isLoopbackHostname, isOnionHostname } = require('./ipfs/gateway-transport');
const { normalizeHttpEndpoint } = require('../shared/http-endpoint');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let activeNode = null;
// A freedom-ipfsd node whose start is still pending. Its start waits on the
// service's replies, so a stop takes it over at once rather than queueing
// behind it (freedom-core design 0007, "Startup and shutdown").
let startingNode = null;
// Counts stopIpfs() calls: a service start requested before the latest stop
// is cancelled by it, whether or not its node exists yet.
let stopsRequested = 0;
let healthCheckInterval = null;

// Which backend is currently serving `ipfs://` / `ipns://`. BUNDLED is the
// in-process freedom-ipfs native node; EXTERNAL routes gateway requests to a
// user-provided HTTP gateway (e.g. a local Kubo / IPFS Desktop on :8080). The
// external path is the escape hatch when the native addon cannot load
let currentMode = MODE.BUNDLED;
let externalGatewayUrl = null;

// The explicit "configured but not serving" state of external mode (#356): the
// profile names an external gateway, a start dialled it and it did not answer
// (or the profile names no endpoint at all), so nothing is being served — but
// the manager stays responsible for that endpoint and keeps the same 5s health
// probe armed against it, so the node recovers by itself when the gateway comes
// up. `null` means "not in that state"; `{ url }` carries the endpoint the
// failed start dialled, or `null` when none is configured (nothing to probe, so
// no retry is armed — only a config change can resolve that one).
//
// Deliberately NOT recorded in `currentMode`/`externalGatewayUrl`: those two
// mean "this backend / this endpoint is serving `ipfs://` right now" — the same
// split the registry draws between `gateway` and `externalGateway` (see
// publishExternalIpfsMode) — and `ipfsBackend` and `getNativeDiagnostics`
// read them. A node that never came up must not describe
// itself through either.
let externalStandby = null;

// Bumped on every external-state transition (activate / standby / teardown) so
// a probe still in flight can tell its verdict is about a state that has since
// been replaced — including a replacement that happens to name the same
// endpoint (stop → start onto the same gateway), which the endpoint comparison
// alone cannot see.
let externalStateGeneration = 0;

// `active_native_handles` is the count of in-flight requests (registered at start,
// released when the response stream ends/cancels/errors) and `bytes_read` is the
// running total of bytes actually streamed through, counted as they pass, not from
// Content-Length
let externalActiveRequests = 0;
let externalBytesServed = 0;

// Detected from the node's RPC API when reachable.
// Null until detected / when the gateway exposes no recognizable RPC.
let externalGatewayVersion = null;

// Serializes start/stop transitions. The renderer's optimistic toggle awaits
// start()/stop() and treats the resolved status as the *settled* backend state
// (see reconcileIpfsToggle in renderer/lib/ipfs-ui.js). To honor that contract
// even when the user flips the switch mid-transition, every transition runs to
// completion before the next begins — a start requested during a stop waits for
// the stop, then runs, and only then does its promise resolve.
let opChain = Promise.resolve();

function enqueueOp(op) {
  const result = opChain.then(op, op);
  // A failing op must not poison the chain for the next transition.
  opChain = result.catch(() => {});
  return result;
}

function defaultNativeDiagnostics() {
  return {
    progress: '{"active":[],"events":[]}',
    nativeGatewayStats: '{}',
    nativeVersion: null,
    nativeBuildInfo: null,
  };
}

function readNativeVersion(node) {
  try {
    const version = node?.version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch (err) {
    log.warn('[IPFS] Failed to read native version:', err.message);
    return null;
  }
}

function readNativeBuildInfoJson(node) {
  if (!node || typeof node.buildInfoJson !== 'function') return null;
  try {
    const buildInfo = node.buildInfoJson();
    return typeof buildInfo === 'string' && buildInfo.length > 0 ? buildInfo : null;
  } catch (err) {
    log.warn('[IPFS] Failed to read native build info:', err.message);
    return null;
  }
}

function nativeNodeLabel(node) {
  const version = readNativeVersion(node);
  return version ? `freedom-ipfs ${version}` : 'freedom-ipfs';
}

function getIpfsDataPath() {
  const dataDir = path.join(getIpfsDataDir(), 'freedom-ipfs');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function getProfileIpfsConfig() {
  return getActiveProfile()?.metadata?.nodes?.ipfs || null;
}

function isDisabledIpfsConfig(config = getProfileIpfsConfig()) {
  return config?.mode === 'disabled';
}

function isExternalIpfsConfig(config = getProfileIpfsConfig()) {
  return config?.mode === 'external';
}

// Accept a bare host:port or a full URL and return a canonical http(s) origin
// with no trailing slash, or null when the value is unusable. This is the same
// normalizer the profile IPC boundary validates the stored value with, so what
// Settings accepts is exactly what gets dialled here.
function normalizeExternalGatewayUrl(rawUrl) {
  return normalizeHttpEndpoint(rawUrl);
}

function getEndpointLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

// A stock Kubo serves `localhost` as a *subdomain* gateway: `/ipfs/<cid>` on
// `Host: localhost:<port>` answers 301 to `http://<cid>.ipfs.localhost:<port>/`
// with no `X-Ipfs-*` headers, while the identical node answers the same path
// with a 200 + `X-Ipfs-Path` on `127.0.0.1` (measured against a default-config
// Kubo 0.42.0 on 2026-09-14; also pinned by
// `__tests__/integration/ipfs-subdomain-gateway.test.js`). The probe never
// follows a redirect (see probeExternalGateway), so a working default Kubo
// typed in as `localhost:8080` reads as unreachable with nothing pointing at
// the one-word cause. Say it in the status the nodes menu shows.
const LOCALHOST_GATEWAY_HINT = ' — for Kubo, use 127.0.0.1 instead of localhost';

// A `.onion` gateway is only reachable while Tor's onion routing is on: the
// transport refuses to dial one the session would send DIRECT, rather than
// handing the name to the system resolver (see ipfs/gateway-transport.js). At
// launch that is the normal state for the first seconds-to-minutes, while Arti
// bootstraps — the retry below picks the gateway up on its own, so say what is
// being waited for instead of leaving "unreachable" unexplained.
const ONION_GATEWAY_HINT = ' — .onion gateways need Tor running';

function unreachableEndpointHint(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    if (hostname === 'localhost') return LOCALHOST_GATEWAY_HINT;
    if (isOnionHostname(hostname)) return ONION_GATEWAY_HINT;
    return '';
  } catch {
    return '';
  }
}

// `isLoopbackHostname` lives in ipfs/gateway-transport.js: the same literal
// loopback test decides which transport dials the gateway and whether the
// unsolicited `:5001` RPC POST below is allowed, and the two must not drift.

// The user configures only the gateway (e.g. :8080), but Kubo's RPC API answers
// on the same host: POST /api/v0/version with the running version, and
// /api/v0/swarm/peers + /api/v0/stats/bw with the numbers the nodes menu shows
// for an external node (#417). We derive the host from the configured gateway
// URL and try the RPC there. Any failure just yields null and the UI falls back
// to showing the gateway endpoint / `Unknown`, so this only ever adds information.
function kuboRpcUrl(gatewayUrl, rpcPath) {
  try {
    const parsed = new URL(gatewayUrl);
    // ASSUMPTION: the RPC API is on port 5001 on the same host as the gateway.
    // This is Kubo's conventional default and it is NOT user-configured.
    // If a deployment moves the RPC port, detection simply fails.
    //
    // Only attempted for a loopback gateway. The user configures a gateway, not
    // an RPC API, so on any other host `:5001` belongs to whoever is listening
    // there — a LAN box, or a remote `https://gw.example.com:5001` — and Kubo's
    // own `:5001` is its *admin* RPC. Freedom must not send an unsolicited POST
    // to an address the user never named; remote gateways simply fall back to
    // showing the endpoint instead of a detected version and node stats.
    if (!isLoopbackHostname(parsed.hostname)) return null;
    return `${parsed.protocol}//${parsed.hostname}:5001${rpcPath}`;
  } catch {
    return null;
  }
}

// POST one Kubo RPC call and parse its JSON body; null on any failure.
async function kuboRpcJson(gatewayUrl, rpcPath, { timeoutMs = 2000 } = {}) {
  const url = kuboRpcUrl(gatewayUrl, rpcPath);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await gatewayFetch(url, { method: 'POST', signal: controller.signal });
    if (!res.ok) {
      // Nothing reads an error body: cancel it so the request is closed now
      // rather than left paused behind an unread stream.
      res.body?.cancel?.().catch(() => {});
      return null;
    }
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function detectExternalGatewayVersion(gatewayUrl, options) {
  const data = await kuboRpcJson(gatewayUrl, '/api/v0/version', options);
  const version = typeof data?.Version === 'string' ? data.Version.trim() : '';
  return version ? `Kubo ${version}` : null;
}

const finiteOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// Live numbers for an external Kubo node: connected peer count and current
// bandwidth rates (bytes/s). Kubo answers `{"Peers": null}` when it has no
// peers, which is a real 0, not a missing value. Null when neither call
// answered (no RPC reachable — e.g. a remote gateway, see kuboRpcUrl).
async function fetchExternalNodeStats(gatewayUrl, options) {
  const [peers, bandwidth] = await Promise.all([
    kuboRpcJson(gatewayUrl, '/api/v0/swarm/peers', options),
    kuboRpcJson(gatewayUrl, '/api/v0/stats/bw', options),
  ]);
  if (!peers && !bandwidth) return null;
  let peerCount = null;
  if (peers) {
    if (Array.isArray(peers.Peers)) peerCount = peers.Peers.length;
    else if (peers.Peers === null) peerCount = 0;
  }
  const stats = {
    peers: peerCount,
    rateIn: finiteOrNull(bandwidth?.RateIn),
    rateOut: finiteOrNull(bandwidth?.RateOut),
  };
  // Something answered on :5001 but not in Kubo's shape: no stats either.
  if (Object.values(stats).every((value) => value === null)) return null;
  return stats;
}

// Back-off after a stats read that learned nothing (RPC down, filtered, or not
// Kubo). The menu polls every second while open; without this a loopback
// gateway whose :5001 is something else — or nothing — would get two POSTs a
// second for as long as the menu stays open. Doubles per consecutive miss, up
// to a minute; any answer resets it, and a new activation starts clean.
const EXTERNAL_NODE_STATS_BACKOFF_BASE_MS = 5_000;
const EXTERNAL_NODE_STATS_BACKOFF_MAX_MS = 60_000;
let externalNodeStatsBackoff = null; // { generation, failures, retryAt }

function externalNodeStatsBackingOff(generation) {
  return (
    externalNodeStatsBackoff?.generation === generation &&
    Date.now() < externalNodeStatsBackoff.retryAt
  );
}

function recordExternalNodeStatsResult(generation, stats) {
  // A read from a previous activation says nothing about the current node.
  if (generation !== externalStateGeneration) return;
  if (stats) {
    if (externalNodeStatsBackoff?.generation === generation) externalNodeStatsBackoff = null;
    return;
  }
  const failures =
    externalNodeStatsBackoff?.generation === generation ? externalNodeStatsBackoff.failures + 1 : 1;
  const delay = Math.min(
    EXTERNAL_NODE_STATS_BACKOFF_BASE_MS * 2 ** (failures - 1),
    EXTERNAL_NODE_STATS_BACKOFF_MAX_MS
  );
  externalNodeStatsBackoff = { generation, failures, retryAt: Date.now() + delay };
}

// One in-flight stats read per external activation. The nodes menu polls every
// second while the RPC may take up to its 2s timeout, so polls share the read
// instead of stacking. Keyed by the activation generation (not the endpoint):
// a stop and restart onto the same endpoint must not hand the new activation a
// read started for the old one — the same blind spot the version detect guards.
let externalNodeStatsRead = null;

async function getExternalNodeStats() {
  if (currentMode !== MODE.EXTERNAL || !externalGatewayUrl) return null;
  const generation = externalStateGeneration;
  if (!externalNodeStatsRead || externalNodeStatsRead.generation !== generation) {
    if (externalNodeStatsBackingOff(generation)) return null;
    const read = {
      generation,
      promise: fetchExternalNodeStats(externalGatewayUrl).then((stats) => {
        if (externalNodeStatsRead === read) externalNodeStatsRead = null;
        recordExternalNodeStatsResult(generation, stats);
        return stats;
      }),
    };
    externalNodeStatsRead = read;
  }
  const stats = await externalNodeStatsRead.promise;
  // Landed after the external state moved on: it describes a node that is no
  // longer the one being shown.
  if (externalStateGeneration !== generation || currentMode !== MODE.EXTERNAL) return null;
  return stats;
}

// Probe an external IPFS gateway by requesting the empty-file CID `bafkqaaa`,
// which every gateway resolves locally. Only an IPFS-specific answer counts (an
// `X-Ipfs-*` header, or the exactly-empty 200 body that CID must produce) — a
// plain 200 would also come from the dev server that is far more likely to be
// listening on :8080. Redirects are not followed, so a gateway answering with a
// 3xx (e.g. Kubo's subdomain redirect) reads as unreachable rather than sending
// this probe somewhere else. Uses the same fetch stack that serves real gateway
// requests, so the health probe can't disagree with a working request path.
async function probeExternalGateway(gatewayUrl, { timeoutMs = 2000 } = {}) {
  if (!gatewayUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await gatewayFetch(`${gatewayUrl}${IPFS_GATEWAY_PROBE_PATH}`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    const bodyBytes = await probeBodyBytes(res);
    return isIpfsGatewayProbeResponse({ status: res.status, headers: res.headers, bodyBytes });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Read just enough of the probe body to tell "empty" from "not empty", then
// release the socket. A gateway's answer for `bafkqaaa` is zero bytes; anything
// else is some other server and there is no reason to buffer its page.
async function probeBodyBytes(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return 0;
  try {
    // Skip zero-length chunks: only "the stream ended without bytes" is empty.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return 0;
      if (value?.byteLength) return value.byteLength;
    }
  } catch {
    // A body that failed mid-read proves nothing; null never reads as empty.
    return null;
  } finally {
    reader.cancel?.().catch(() => {});
  }
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.IPFS_STATUS_UPDATE, { status: currentState, error: lastError });
  }
}

function checkHealth() {
  if (!activeNode || currentState !== STATUS.RUNNING) return false;
  if (typeof activeNode.isHealthy === 'function' && !activeNode.isHealthy()) return false;
  try {
    activeNode.nativeGatewayStatsJson();
    return true;
  } catch (err) {
    log.warn('[IPFS] Native health check failed:', err.message);
    return false;
  }
}

function stopHealthCheck() {
  if (!healthCheckInterval) return;
  clearInterval(healthCheckInterval);
  healthCheckInterval = null;
}

// Is this manager on the external backend at all — serving it (RUNNING, or the
// soft ERROR a running node drops into when the gateway stops answering) or
// standing by for it (a start that never reached it)?
function isOnExternalBackend() {
  return currentMode === MODE.EXTERNAL || externalStandby !== null;
}

// The single external endpoint this manager is currently responsible for: the
// one being served, or the one a standby retry is armed against. Null when
// neither applies. The health probe and the profile-sync guard both key on it,
// so the two states cannot drift apart.
function externalProbeTarget() {
  if (currentMode === MODE.EXTERNAL) return externalGatewayUrl;
  return externalStandby ? externalStandby.url : null;
}

// Leave the external backend entirely: drop the serving bookkeeping, the
// standby endpoint, and the retry probe armed for either. Every path that stops
// being responsible for the configured gateway goes through here, so no probe
// can outlive the endpoint it was armed for.
function clearExternalGatewayState() {
  stopHealthCheck();
  externalStandby = null;
  externalStateGeneration += 1;
  currentMode = MODE.BUNDLED;
  externalGatewayUrl = null;
  externalGatewayVersion = null;
}

function handleNativeNodeFailure(reason, node = activeNode) {
  if (node && activeNode && node !== activeNode) return;
  if (![STATUS.STARTING, STATUS.RUNNING].includes(currentState)) return;

  const message = reason || 'Native node unavailable';
  const failedNode = activeNode;
  activeNode = null;
  stopHealthCheck();
  clearService('ipfs');
  setStatusMessage('ipfs', 'Node unavailable');
  setErrorState('ipfs', 'Node unavailable. Restart IPFS from the nodes menu.');
  updateState(STATUS.ERROR, message);

  if (failedNode) {
    failedNode.stop().catch((err) => {
      log.warn('[IPFS] Error while cleaning up failed freedom-ipfs native node:', err.message);
    });
  }
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    if (isOnExternalBackend()) {
      // Soft health: an external gateway (e.g. Kubo) may briefly stop answering
      // while busy, so surface the outage without tearing down external mode and
      // recover automatically when it responds again. The same probe drives the
      // standby state (#356), where the gateway was already down at start: there
      // is nothing to tear down, only the endpoint to keep trying.
      const probedGeneration = externalStateGeneration;
      const probedUrl = externalProbeTarget();
      const wasServing = currentMode === MODE.EXTERNAL;
      const isHealthy = await probeExternalGateway(probedUrl);
      // The probe can hang for its full 2s timeout, and the user can stop the
      // node, switch profiles or restart into the native backend meanwhile. A
      // verdict about an endpoint that is no longer the one being served must
      // not be applied: a stale `false` landing on a healthy native node would
      // set an ERROR the native health path never clears (every ipfs:// load
      // 503s until the user toggles off/on), and a stale `true` would promote a
      // standby the user has since switched away from. Same guard the version
      // probe applies below, plus the generation so a restart onto the *same*
      // endpoint is still recognized as a different state.
      const isServing = currentMode === MODE.EXTERNAL;
      if (externalStateGeneration !== probedGeneration) return;
      if (externalProbeTarget() !== probedUrl || isServing !== wasServing) return;
      if (!wasServing) {
        // Standby: the gateway that was down at start is answering now. Bring it
        // up through the same activation the start path uses.
        if (isHealthy && currentState === STATUS.ERROR) activateExternalGateway(probedUrl);
        return;
      }
      if (!isHealthy && currentState === STATUS.RUNNING) {
        // Same hint as the failed-start branch in startExternalIpfs(): losing
        // the route mid-session (Tor stopped, Kubo's localhost subdomain
        // redirect) reads exactly like never having had it, so the line that
        // names the cause has to travel with this message too.
        const hint = unreachableEndpointHint(probedUrl);
        updateState(STATUS.ERROR, `External IPFS gateway is unreachable${hint}`);
        setErrorState('ipfs', `External node unreachable${hint}. Retrying…`);
      } else if (isHealthy && currentState === STATUS.ERROR) {
        // A node that was serving and went soft-ERROR only has to go back to
        // RUNNING — the registry still describes it. The other shape of
        // "unreachable" (a start that never committed to serving, e.g. an
        // `.onion` gateway whose Tor route came up minutes after launch) is a
        // standby, and the branch above finished its start through
        // activateExternalGateway().
        clearErrorState('ipfs');
        updateState(STATUS.RUNNING);
      }
      return;
    }

    const isHealthy = checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      handleNativeNodeFailure('Native node unavailable');
    }
  }, 5000);
  healthCheckInterval.unref?.();
}

// What runs the bundled node (freedom-core design 0007, step 6): today's
// add-on, or in development builds the freedom-ipfsd service process with
// FREEDOM_IPFS_BACKEND=service. Packaged builds always run the add-on until
// the default switches.
function nativeBackendKind() {
  if (app.isPackaged) return 'addon';
  const kind = process.env.FREEDOM_IPFS_BACKEND || 'addon';
  if (kind === 'service' || kind === 'addon') return kind;
  log.warn(`[IPFS] Unknown FREEDOM_IPFS_BACKEND=${kind}; using the add-on`);
  return 'addon';
}

function nativeNodeClass() {
  return nativeBackendKind() === 'service' ? FreedomIpfsdNode : FreedomIpfsNativeNode;
}

function checkBinary() {
  return nativeNodeClass().isAvailable();
}

function startDisabledIpfs() {
  // Reachable from a soft-ERROR external node or from a standby one, both of
  // which still have their health check running (both deliberately keep probing
  // so they can recover). It must not outlive the endpoint it was armed for.
  clearExternalGatewayState();
  currentMode = MODE.DISABLED;
  clearService('ipfs');
  updateService('ipfs', {
    api: null,
    gateway: null,
    mode: MODE.DISABLED,
    backend: 'freedom-ipfs',
  });
  setStatusMessage('ipfs', 'Node disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[IPFS] Disabled for active profile');
}

// Publish "this profile is on an external gateway" to the registry. The mode is
// what tells the renderer the backend is one Freedom can control without the
// native addon (see updateIpfsToggleState in renderer/lib/ipfs-ui.js), so it has
// to be published on every external path — including the ones that did not reach
// a running node — or the nodes-menu toggle stays disabled with no way to retry.
//
// `gateway` and `externalGateway` are deliberately not the same thing:
//   - `gateway` means "ipfs:// traffic is being served here right now". Its
//     consumers act on it without asking anything else — `ens-prefetch.js`
//     speculatively GETs `<gateway>/ipfs/<cid>` for every resolved ipfs://
//     contenthash, and the renderer's `state.ipfsBase` sends view-source
//     straight at it. Publishing it while the node is stopped/unreachable means
//     "IPFS off" would not stop IPFS-gateway traffic, and a remote gateway would
//     keep learning names the user resolved but never visited.
//   - `externalGateway` is the *configured* endpoint, for display only.
function publishExternalIpfsMode(gateway, { serving = false } = {}) {
  updateService('ipfs', {
    api: null,
    gateway: serving ? gateway || null : null,
    externalGateway: gateway || null,
    mode: MODE.EXTERNAL,
    backend: 'external-gateway',
  });
}

// Enter the standby state: external mode is what the profile asks for, but
// nothing is being served. `url` is the endpoint a start dialled and could not
// reach, or null when the profile names none. The retry probe is armed for the
// former (the gateway can come up on its own) and not for the latter (only a
// config change can resolve it, and that arrives through syncProfileMode).
// Any serving bookkeeping left by an earlier run is dropped first — a soft-ERROR
// external node can be restarted straight into this path.
function enterExternalStandby(url) {
  clearExternalGatewayState();
  externalStandby = { url };
  externalStateGeneration += 1;
  // Publish the profile's external mode before the status update, as every other
  // path does, so the renderer never sees a new status against a stale mode.
  publishExternalIpfsMode(url);
  if (url) startHealthCheck();
}

// The external gateway answered: serve `ipfs://` from it. Shared by the start
// path and by the standby retry, so a gateway that was down at launch comes up
// exactly the way one started against a live gateway does.
function activateExternalGateway(url) {
  externalStandby = null;
  externalStateGeneration += 1;
  const activationGeneration = externalStateGeneration;
  externalGatewayUrl = url;
  currentMode = MODE.EXTERNAL;
  externalActiveRequests = 0;
  externalBytesServed = 0;
  externalGatewayVersion = null;
  clearService('ipfs');
  publishExternalIpfsMode(url, { serving: true });
  clearErrorState('ipfs');
  setStatusMessage('ipfs', `External node: ${getEndpointLabel(url)}`);
  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info('[IPFS] Connected to external gateway at', url);

  // Identify the gateway in the background. The nodes menu picks
  // it up on its next stats poll. Ignored if the mode/endpoint changed meanwhile
  // — including a stop/start back onto the *same* endpoint, which mode and
  // endpoint alone cannot tell apart, so this carries the generation counter the
  // health probe uses for the identical blind spot.
  detectExternalGatewayVersion(url)
    .then((version) => {
      if (
        version &&
        externalStateGeneration === activationGeneration &&
        currentMode === MODE.EXTERNAL &&
        externalGatewayUrl === url
      ) {
        externalGatewayVersion = version;
        log.info('[IPFS] External gateway identified as', version);
      }
    })
    .catch(() => {});
}

// Route `ipfs://` / `ipns://` gateway requests to a user-provided external HTTP
// gateway instead of the in-process native node. This is what lets IPFS work on
// hosts where the native addon cannot load
async function startExternalIpfs(config) {
  const url = normalizeExternalGatewayUrl(config?.externalGateway);
  if (!url) {
    // Nothing to serve and nothing to probe — but this is an external teardown
    // too, so it owns its state instead of trusting that doSyncIpfsProfileMode
    // already ran one (today it always does; a future caller reaching
    // doStartIpfs from an armed-external state would not). enterExternalStandby
    // drops the serving bookkeeping and disarms a probe left armed for a
    // previously-configured endpoint, which this profile no longer names.
    enterExternalStandby(null);
    updateState(STATUS.ERROR, 'External IPFS gateway is not configured');
    // Drop any "…unreachable. Retrying…" error inherited from the endpoint the
    // profile used to name: nothing is being retried any more. setStatusMessage
    // below also clears it today, but this teardown owns its own state rather
    // than riding on another call's side effect — as the serving path does.
    clearErrorState('ipfs');
    setStatusMessage('ipfs', 'External node not configured');
    return;
  }

  const reachable = await probeExternalGateway(url);
  if (!reachable) {
    // The endpoint is configured but not answering (gateway not started yet,
    // still booting, or — for a `.onion` gateway — its Tor route not up yet:
    // startIpfs() runs at launch within ~1s while Arti's SOCKS bootstrap takes
    // seconds to ~120s, and the transport refuses to dial an onion name the
    // session would send DIRECT). Keep the profile's external mode published so
    // the user can start their gateway and hit the toggle again without
    // relaunching Freedom, and keep the health probe armed against it so they do
    // not have to: the standby state recovers on its own within one interval of
    // the gateway answering, exactly as the running→error path already does
    // (#356) — which is also how an `.onion` gateway finishes its start by
    // itself once Tor's PAC lands.
    enterExternalStandby(url);
    const hint = unreachableEndpointHint(url);
    updateState(STATUS.ERROR, `External IPFS gateway is unreachable${hint}`);
    setStatusMessage('ipfs', `External node unreachable${hint}`);
    // The error state overlays the status message (service-registry), so the
    // hint has to travel with it or an unreachable `localhost`/`.onion`
    // endpoint loses the one line that says why.
    setErrorState('ipfs', `External node unreachable${hint}. Retrying…`);
    return;
  }

  activateExternalGateway(url);
}

async function doStartIpfs(requestedAt = stopsRequested) {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[IPFS] Ignoring start request, current state: ${currentState}`);
    return;
  }

  updateState(STATUS.STARTING);

  const profileConfig = getProfileIpfsConfig();

  if (isDisabledIpfsConfig(profileConfig)) {
    startDisabledIpfs();
    return;
  }

  if (isExternalIpfsConfig(profileConfig)) {
    await startExternalIpfs(profileConfig);
    return;
  }

  // Native (bundled) path from here on. A start requested straight out of an
  // external soft-ERROR or standby state (the profile switched to managed while
  // the node sat unreachable) has to disarm that retry here too, or it keeps
  // probing the old gateway behind a managed node.
  clearExternalGatewayState();

  const NodeClass = nativeNodeClass();
  // A stop requested after this start would otherwise wait behind it: the
  // service's start can't be bounded, and that stop has already taken over
  // whatever was starting. Its own op, queued after this one, publishes
  // STOPPED. The add-on's start is bounded, and runs as it always has.
  if (NodeClass === FreedomIpfsdNode && requestedAt !== stopsRequested) {
    log.info('[IPFS] A stop requested meanwhile cancels the freedom-ipfsd start');
    return;
  }
  if (!NodeClass.isAvailable()) {
    updateState(
      STATUS.ERROR,
      NodeClass === FreedomIpfsdNode
        ? 'freedom-ipfsd binary not found'
        : 'freedom-ipfs native addon not built'
    );
    setStatusMessage('ipfs', 'Native node unavailable');
    return;
  }

  const dataDir = getIpfsDataPath();
  const onFailure = (reason, failedNode) => handleNativeNodeFailure(reason, failedNode);
  const node =
    NodeClass === FreedomIpfsdNode
      ? new FreedomIpfsdNode({
          dataDir,
          lockDir: getLockDir(),
          shellVersion: app.getVersion(),
          onFailure,
          onChange: (state, changedNode) => handleServiceNodeChange(state, changedNode),
        })
      : new FreedomIpfsNativeNode({ dataDir, onFailure });

  // start() resolves once the addon has opened the cache and bound the gateway
  // on the libuv thread pool; the main thread keeps serving the UI meanwhile
  // (#503 item 13). The state stays STARTING throughout, and enqueueOp holds
  // any stop/sync requested meanwhile until this settles. The service node's
  // start lasts until its instance's first stats reply, so a stop doesn't
  // wait for it: stopIpfs() stops the node, which settles start() false, and
  // the stop's own op publishes STOPPED.
  const takenOver = () => node.restartsItself && startingNode !== node;
  if (node.restartsItself) startingNode = node;
  try {
    const started = await node.start();
    if (takenOver()) return;
    if (!started) {
      updateState(STATUS.ERROR, 'Failed to start freedom-ipfs native node');
      setStatusMessage('ipfs', 'Node failed to start');
      return;
    }
  } catch (err) {
    if (takenOver()) return;
    log.error('[IPFS] Failed to start freedom-ipfs native node:', err);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ipfs', 'Node failed to start');
    return;
  } finally {
    if (startingNode === node) startingNode = null;
  }

  activeNode = node;
  const nodeLabel = nativeNodeLabel(node);
  updateService('ipfs', {
    api: null,
    gateway: null,
    mode: MODE.BUNDLED,
    backend: 'freedom-ipfs',
  });
  setStatusMessage('ipfs', `Node: ${nodeLabel}`);
  updateState(STATUS.RUNNING);
  // The service node runs its own 5 s check (`ipfs.stats`) and restarts
  // itself; the add-on is checked from here.
  if (!node.restartsItself) startHealthCheck();
  log.info(`[IPFS] ${nodeLabel} native node started at ${dataDir}`);
}

// The service node went down for a restart, or came back (freedom-core
// design 0007, "Crashes, hangs and restarts"): STARTING meanwhile, so plans
// get the 503 of a node that isn't up, as at launch. Giving up is a failure
// (handleNativeNodeFailure).
function handleServiceNodeChange(state, node) {
  if (node !== activeNode) return;
  if (state === 'restarting' && currentState === STATUS.RUNNING) {
    setStatusMessage('ipfs', 'Node restarting');
    updateState(STATUS.STARTING);
  } else if (state === 'running' && currentState === STATUS.STARTING) {
    setStatusMessage('ipfs', `Node: ${nativeNodeLabel(node)}`);
    updateState(STATUS.RUNNING);
  }
}

// After a stop, keep the registry reflecting the profile's configured mode so
// the renderer can still tell an external-capable node (togglable back on) from
// a native one it can't control. Without this the nodes toggle could never be
// switched back on once the external node was stopped.
function publishStoppedIpfsMode() {
  const config = getProfileIpfsConfig();
  if (isExternalIpfsConfig(config)) {
    publishExternalIpfsMode(normalizeExternalGatewayUrl(config.externalGateway));
    setStatusMessage('ipfs', 'External node stopped');
    return;
  }
  clearService('ipfs');
}

// The profile's IPFS node config changed (Settings > Nodes) or the node was
// never started at launch. Nothing is restarted here — Settings' own save hint
// tells the user to restart the node to apply a mode/endpoint change — but the
// registry must still describe the *configured* backend: it is what the renderer
// reads to decide whether the nodes-menu toggle is controllable (external) and
// whether an `ipfs://` navigation lands on the "disabled for this profile"
// panel. Without it, switching a profile to external mode on a host where the
// native addon cannot load left the toggle hard-disabled until the next launch.
async function doSyncIpfsProfileMode() {
  const config = getProfileIpfsConfig();

  if (isDisabledIpfsConfig(config)) {
    if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
      await doStopIpfs();
    }
    startDisabledIpfs();
    return;
  }

  // A live node keeps serving on the backend it actually started with until the
  // user restarts it, so don't publish a mode the running node contradicts.
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) return;

  // Not running, so nothing is being served — but an external node left in soft
  // ERROR still has its health check armed against the *old* endpoint (the soft
  // path keeps probing precisely so an unreachable gateway can recover on its
  // own). Once the profile names a different backend or endpoint that probe is
  // describing something the user no longer asked for: it would keep GETting
  // the old gateway every 5s while the UI says stopped, and could flip the
  // state back to RUNNING behind a managed/disabled config. Tear it down and
  // drop the endpoint with it, the same way doStopIpfs does.
  //
  // R1-F1: "changed" is the operative word. Settings saves node config
  // unconditionally, so a user troubleshooting a downed gateway who opens
  // Settings > Nodes > IPFS and clicks Save without editing anything lands
  // here too — and for an unchanged external endpoint the armed probe is still
  // describing exactly what the profile names. Tearing it down there settles a
  // recovering gateway to STOPPED permanently: nothing re-arms the retry and
  // the user has to notice and toggle the node by hand. Leave that state
  // untouched (the registry already describes it) and only tear down when the
  // config the probe was armed for is genuinely gone.
  //
  // #356: keyed on the endpoint this manager is responsible for, not on the
  // armed interval, so it covers both shapes of "this gateway is unreachable" —
  // the soft ERROR a *running* node drops into, and the standby a *failed start*
  // leaves behind. Keying on `healthCheckInterval !== null` silently skipped the
  // second (which arms no interval when no endpoint is configured at all) and
  // wiped its diagnosis, including the localhost hint only the start path emits.
  const stillOnConfiguredExternalGateway =
    isOnExternalBackend() &&
    isExternalIpfsConfig(config) &&
    normalizeExternalGatewayUrl(config.externalGateway) === externalProbeTarget();
  if (stillOnConfiguredExternalGateway) return;

  clearExternalGatewayState();

  // A failure recorded against the previous config no longer describes this one.
  const hadError = currentState === STATUS.ERROR;
  if (hadError) clearErrorState('ipfs');
  // Publish the profile mode to the registry BEFORE the status update, as the
  // stop path does, so the renderer never sees the new status against a stale mode.
  publishStoppedIpfsMode();
  if (hadError) updateState(STATUS.STOPPED);
}

// `takeover`: the stop of a service node that was still starting (stopIpfs),
// which STOPPED waits for, as for the active node's.
async function doStopIpfs(takeover = null) {
  if (currentState === STATUS.STOPPED && !activeNode && !takeover) {
    publishStoppedIpfsMode();
    return;
  }
  updateState(STATUS.STOPPING);
  stopHealthCheck();

  const node = activeNode;
  activeNode = null;
  if (node) {
    try {
      await node.stop();
    } catch (err) {
      log.warn('[IPFS] Error while stopping freedom-ipfs native node:', err.message);
    }
  }
  await takeover;

  clearExternalGatewayState();
  clearErrorState('ipfs');
  // Publish the profile mode to the registry BEFORE the status update
  publishStoppedIpfsMode();
  updateState(STATUS.STOPPED);
}

// Public entry points. Each returns a promise that resolves once the transition
// has fully settled, so awaiting start()/stop() yields the final node status.
function startIpfs() {
  const requestedAt = stopsRequested;
  return enqueueOp(() => doStartIpfs(requestedAt));
}

function stopIpfs() {
  // A service node still starting is stopped now, not after its start
  // settles (doStartIpfs), and a service start queued before this stop is
  // cancelled: the shutdown is bounded at 5 s, and so quit and a mode change
  // are. A start requested after this stop waits for that shutdown.
  stopsRequested += 1;
  const starting = startingNode;
  startingNode = null;
  const takeover = starting
    ? starting.stop().catch((err) => {
        log.warn('[IPFS] Error while stopping freedom-ipfs native node:', err.message);
      })
    : null;
  return enqueueOp(() => doStopIpfs(takeover));
}

// Serialized with start/stop so a sync can't interleave with a transition and
// publish a mode the op that is still running is about to overwrite.
function syncProfileMode() {
  return enqueueOp(doSyncIpfsProfileMode);
}

// Wrap an upstream body so bytes are tallied as they stream to the caller and
// the in-flight counter is released exactly once when the stream ends, is
// cancelled, or errors.
function countingGatewayStream(upstreamBody, release) {
  const reader = upstreamBody.getReader();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        externalBytesServed += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        finish();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      finish();
    },
  });
}

// The page's signal, and a headers deadline when the plan names one: the
// signal stays linked for the body, which only the page's abort (or a body
// cancel) ends.
function withHeadersDeadline(signal, ms) {
  if (ms === null || ms === undefined) return { signal, headersIn: () => {} };
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, headersIn: () => clearTimeout(timer) };
}

// One request to the external HTTP gateway at `gatewayUrl`, for a plan's
// node-relative path (`/ipfs/<cid>…`, `/ipns/<name>…`). The answer comes back
// as the gateway gave it, its body counted for the diagnostics; the plan's
// response operations (the decoded encoding, page state, the redirect's
// `Location`) are main's executor's to run.
async function requestExternalGateway(
  gatewayUrl,
  { path: gatewayPath, method, headers, signal, headersTimeoutMs }
) {
  externalActiveRequests += 1;
  let handled = false;
  const releaseHandle = () => {
    if (handled) return;
    handled = true;
    externalActiveRequests = Math.max(0, externalActiveRequests - 1);
  };
  const deadline = withHeadersDeadline(signal, headersTimeoutMs);
  try {
    const upstream = await gatewayFetch(`${gatewayUrl}${gatewayPath}`, {
      method: method || 'GET',
      headers,
      signal: deadline.signal,
      // Never follow the gateway's redirects: a hostile or MITM'd gateway
      // answering `302 Location: http://127.0.0.1:1633/…` would otherwise have
      // Freedom fetch the user's own loopback/LAN services and hand the body
      // back under the `ipfs://` origin. The 3xx is passed through to Chromium,
      // which applies the normal cross-origin rules to it. The native path does
      // not follow redirects either.
      redirect: 'manual',
    });
    deadline.headersIn();
    // No body to stream (HEAD, 204/304, a 3xx without one): the request is
    // already complete.
    if (!upstream.body) {
      releaseHandle();
      return upstream;
    }
    return new Response(countingGatewayStream(upstream.body, releaseHandle), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (err) {
    deadline.headersIn();
    releaseHandle();
    throw err;
  }
}

/**
 * The IPFS backend serving `ipfs:` and `ipns:` now (freedom-core design 0006,
 * Binding): captured when a request is admitted and kept for it, so a
 * settings change mid-request can't redirect the fetch. The core learns only
 * its mode and whether it is up, never its URL; a backend that isn't up
 * keeps its mode, so the core's 503 names what isn't running.
 *
 * The external gateway is the mode only while it serves: a gateway that never
 * answered leaves the manager standing by, which answers as the native
 * node's absence, as today.
 *
 * @returns {{ref: {ipfs: 'native'|'gateway', up: boolean}, url: string|null,
 *   request: Function}}
 */
function ipfsBackend() {
  if (currentMode === MODE.EXTERNAL) {
    const url = currentState === STATUS.RUNNING && externalGatewayUrl ? externalGatewayUrl : null;
    return {
      ref: { ipfs: 'gateway', up: Boolean(url) },
      url,
      request: (init) => requestExternalGateway(url, init),
    };
  }
  // The native node pulls with real backpressure, and runs the plan's
  // headers deadline itself; its queue bound is the one it was started with.
  const node = checkHealth() ? activeNode : null;
  if (activeNode?.restartsItself) return serviceBackend(node);
  return {
    ref: { ipfs: 'native', up: Boolean(node) },
    url: null,
    request: ({ path: gatewayPath, method, headers, signal, headersTimeoutMs }) =>
      node.request({ method, path: gatewayPath, headers, signal, headersTimeoutMs }),
  };
}

/**
 * The freedom-ipfsd node's backend (freedom-core design 0007, "Main's side"):
 * the generation and instance serving now, captured at admission, so a
 * request that goes on past a stop, a restart or an instance the service
 * retired fails before anything is sent instead of reaching their
 * replacement. Every partition is served by the profile's instance until
 * private windows get their own (step 7), so its lease holds nothing.
 */
function serviceBackend(node) {
  const captured = node ? node.capture() : null;
  return {
    ref: { ipfs: 'native', up: Boolean(captured) },
    url: null,
    request: (init) =>
      captured
        ? node.request(captured, init)
        : Promise.reject(new Error('freedom-ipfs native node is not running')),
    release() {},
  };
}

function getNativeDiagnostics() {
  if (currentMode === MODE.EXTERNAL) {
    return {
      progress: '{"active":[],"events":[]}',
      nativeGatewayStats: JSON.stringify({
        active_native_handles: externalActiveRequests,
        bytes_read: externalBytesServed,
      }),
      nativeVersion: null,
      nativeBuildInfo: null,
      externalGateway: externalGatewayUrl,
      externalVersion: externalGatewayVersion,
    };
  }

  const diagnostics = defaultNativeDiagnostics();
  if (!activeNode) return diagnostics;

  try {
    diagnostics.progress = activeNode.progressSnapshotJson();
  } catch (err) {
    log.warn('[IPFS] Failed to collect native progress diagnostics:', err.message);
  }

  try {
    diagnostics.nativeGatewayStats = activeNode.nativeGatewayStatsJson();
  } catch (err) {
    log.warn('[IPFS] Failed to collect native gateway diagnostics:', err.message);
  }

  diagnostics.nativeVersion = readNativeVersion(activeNode);
  diagnostics.nativeBuildInfo = readNativeBuildInfoJson(activeNode);
  if (activeNode.restartsItself) {
    // The service's last `ipfs.stats` reply, with its store and budgets
    // (freedom-core design 0007, Stats). Asked again now, so a panel or a
    // load polling these reads them fresh, not at the 5 s check's pace.
    diagnostics.nativeServiceStats = activeNode.serviceStatsJson();
    activeNode.refreshStats();
  }
  return diagnostics;
}

function setUseInjectedIdentity(enabled) {
  log.info(`[IPFS] Ignoring injected identity mode for freedom-ipfs native node: ${enabled}`);
}

function hasInjectedIdentity() {
  return false;
}

function getActivePort() {
  return null;
}

function getActiveGatewayPort() {
  return null;
}

function registerIpfsIpc() {
  ipcMain.handle(IPC.IPFS_START, async () => {
    await startIpfs();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.IPFS_STOP, async () => {
    await stopIpfs();
    return { status: currentState, error: lastError };
  });

  // `{ nodeStats: true }` is the nodes menu's stats poll: on an external node it
  // also reads peers/bandwidth off the Kubo RPC (#417). The plain status checks
  // don't ask for it, so they never dial the RPC.
  ipcMain.handle(IPC.IPFS_GET_STATUS, async (_event, options) => {
    const externalNodeStats =
      options?.nodeStats && currentMode === MODE.EXTERNAL ? await getExternalNodeStats() : null;
    const diagnostics = getNativeDiagnostics();
    if (diagnostics.externalGateway !== undefined) {
      diagnostics.externalNodeStats = externalNodeStats;
    }
    return { status: currentState, error: lastError, diagnostics };
  });

  ipcMain.handle(IPC.IPFS_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });
}

module.exports = {
  registerIpfsIpc,
  startIpfs,
  stopIpfs,
  syncProfileMode,
  getActivePort,
  getActiveGatewayPort,
  getIpfsDataPath,
  setUseInjectedIdentity,
  hasInjectedIdentity,
  ipfsBackend,
  getNativeDiagnostics,
  checkHealth,
  isExternalIpfsConfig,
  normalizeExternalGatewayUrl,
  probeExternalGateway,
  STATUS,
};
