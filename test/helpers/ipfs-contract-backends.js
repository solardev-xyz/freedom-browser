/* global jest */

/**
 * The backends the IPFS backend contract suite
 * (`src/main/ipfs/ipfs-backend.contract.test.js`, freedom-core design 0007,
 * "Tests first") runs against, chosen by `FREEDOM_IPFS_CONTRACT_BACKEND`:
 *
 * - `addon`: today's freedom-ipfs N-API add-on (`npm run ipfs:download`),
 *   driven by the production `ipfs-manager.js` and `FreedomIpfsNativeNode`,
 *   its event worker a real worker thread.
 * - `ipfsd` (design 0007 step 6): the freedom-ipfsd service binary. Not
 *   written yet; it gets an entry here, and the suite stays as it is.
 *
 * Every backend serves the suite's local fixture (`ipfs-fixture.js`) and
 * nothing else: its delegated router is the fixture's, in delegated-only
 * routing, so no request leaves the loopback interface. Each one returns:
 *
 * - `manager`: the loaded `ipfs-manager.js`, whose `ipfsBackend()`,
 *   `startIpfs()`, `stopIpfs()` and `getNativeDiagnostics()` the suite
 *   drives;
 * - `handleRequest`: `ipfs-protocol.js`'s, in the same module registry, with
 *   the core's planner stood in for by `fake-dweb-core.js`;
 * - `startConfig()`: the configuration the running node was started with,
 *   in the parity table's terms;
 * - `crash()`: ends the running backend as a fault would, and `settle()`
 *   waits for the manager's cleanup of it;
 * - `pins(partition)`: how many leases hold the partition's instance, once
 *   leases exist (null before), and `closeDwebSession(partition)`, the
 *   handler's backstop;
 * - `exitText`: the message an open body errors with when the backend ends;
 * - `readAheadBytes`: how far the backend may read ahead of a paused
 *   consumer (deviation `read-ahead`).
 *
 * `BACKENDS` lists, beside each loader, the design's features beyond
 * today's contract that the backend honours; the suite's tests for the
 * others are pending.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('./main-process-test-utils');
const { createFakeDwebDriver } = require('./fake-dweb-core');

const SRC = path.join(__dirname, '..', '..', 'src', 'main');
const MIB = 1024 * 1024;

/** The parity table's configuration ("Parity": today's values). */
const TODAY_CONFIG = {
  routing: 'auto',
  delegatedRouters: ['https://delegated-ipfs.dev/routing/v1'],
  dhtQueryTimeoutS: 3,
  dhtMaxProviders: 32,
  maxConcurrentRequests: 8,
  requestQueueTimeoutMs: 15_000,
  maxCacheBytes: 256 * MIB,
};

/**
 * The design's features beyond today's contract (0007), each pending until
 * a backend honours it:
 * - `private-instances`: a private partition gets its own in-memory
 *   instance, sharing no cache with the profile's node or another
 *   partition ("Private windows");
 * - `leases`: `ipfsBackend()` returns `release()`, idempotent ("Main's
 *   side", the lease);
 * - `backend-busy`: a partition that needs a new instance while eight are
 *   pinned gets `BackendBusy`, and `ref.up` stays true ("Private windows",
 *   readiness per partition);
 * - `auto-restart`: a backend that ended is restarted with back-off, and
 *   serves again (deviation `auto-restart`).
 */
const FEATURES = ['private-instances', 'leases', 'backend-busy', 'auto-restart'];

/** The add-on's routing constants, by name, for `startConfig()`. */
function routingName(constants, mode) {
  for (const name of ['AUTO', 'DELEGATED', 'LIGHT_DHT', 'OFFLINE']) {
    if (constants[`ROUTING_MODE_${name}`] === mode) return name.toLowerCase().replace('_', '-');
  }
  return `unknown (${mode})`;
}

/**
 * Today's add-on behind `ipfs-manager.js`. Only the start call is shimmed:
 * it records what production passes, then starts the node on the fixture's
 * router in delegated-only routing (the one change, so nothing reaches the
 * public network). Every other argument, and every other add-on call, is
 * production's.
 */
async function loadAddonBackend({ router }) {
  const bindingPath = path.join(SRC, 'ipfs', 'freedom-ipfs-native-binding.js');
  const nodePath = path.join(SRC, 'ipfs', 'freedom-ipfs-native-node.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-contract-'));
  const nodes = [];
  const starts = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const shimmed = (addon) => {
    const shim = Object.create(addon);
    shim.nodeNewWithDataDirAsync = (dir, maxCacheBytes) => {
      starts.push({ maxCacheBytes });
      return addon.nodeNewWithDataDirAsync(dir, maxCacheBytes);
    };
    shim.nodeStartNativeGatewayOnlineAsync = (handle, routers, mode, ...rest) => {
      Object.assign(starts.at(-1) ?? {}, { routers, mode, rest });
      return addon.nodeStartNativeGatewayOnlineAsync(
        handle,
        router,
        addon.constants.ROUTING_MODE_DELEGATED,
        ...rest
      );
    };
    return shim;
  };

  const { mod: manager } = loadMainModule(path.join(SRC, 'ipfs-manager.js'), {
    extraMocks: {
      [bindingPath]: () => {
        const actual = jest.requireActual(bindingPath);
        if (!actual.isNativeBindingAvailable()) {
          throw new Error(
            'FREEDOM_IPFS_CONTRACT_BACKEND=addon needs the add-on: run npm run ipfs:download'
          );
        }
        const addon = shimmed(actual.loadNativeBinding());
        return { ...actual, loadNativeBinding: () => addon };
      },
      // Every node the manager makes, so a test can end one as a fault would.
      [nodePath]: () => {
        const actual = jest.requireActual(nodePath);
        class RecordedNode extends actual.FreedomIpfsNativeNode {
          constructor(options) {
            super(options);
            nodes.push(this);
          }
        }
        return { ...actual, FreedomIpfsNativeNode: RecordedNode };
      },
      [path.join(SRC, 'logger.js')]: () => log,
      [path.join(SRC, 'service-registry.js')]: () => ({
        MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', DISABLED: 'disabled', NONE: 'none' },
        updateService: jest.fn(),
        setStatusMessage: jest.fn(),
        setErrorState: jest.fn(),
        clearErrorState: jest.fn(),
        clearService: jest.fn(),
      }),
      [path.join(SRC, 'profile-resolver.js')]: () => ({ getActiveProfile: () => null }),
      [path.join(SRC, 'profile-paths.js')]: () => ({ getIpfsDataDir: () => dataDir }),
      [path.join(SRC, 'core', 'naming.js')]: () => ({
        namingDriver: () => createFakeDwebDriver(),
      }),
    },
  });
  const { handleRequest } = require(path.join(SRC, 'ipfs', 'ipfs-protocol.js'));
  const { closeDwebSession } = require(path.join(SRC, 'dweb', 'fetch-admission.js'));
  const constants = () => require(bindingPath).loadNativeBinding().constants;

  return {
    name: 'addon',
    manager,
    handleRequest,
    log,
    closeDwebSession,
    // Today's backend takes no lease.
    pins: null,
    readAheadBytes: 64 * 1024,
    exitText: 'Native event dispatcher exited with code 0',
    startConfig() {
      const start = starts.at(-1);
      const [maxConcurrent, dhtTimeout, dhtProviders, queueMs] = start.rest;
      // The add-on takes 0 and '' for v0.4.5's defaults.
      return {
        routing: routingName(constants(), start.mode),
        delegatedRouters: start.routers ? start.routers.split(',') : TODAY_CONFIG.delegatedRouters,
        dhtQueryTimeoutS: dhtTimeout,
        dhtMaxProviders: dhtProviders || TODAY_CONFIG.dhtMaxProviders,
        maxConcurrentRequests: maxConcurrent || TODAY_CONFIG.maxConcurrentRequests,
        requestQueueTimeoutMs: queueMs,
        maxCacheBytes: start.maxCacheBytes,
      };
    },
    // The event worker told to stop by someone other than its node: it
    // acknowledges and exits on its own, which the node reads as its
    // dispatcher dying (no terminate(), so no race with a native call).
    crash() {
      nodes.at(-1).dispatcher.postMessage({ type: 'stop' });
    },
    // The manager stops a failed node in the background; wait for it, so a
    // restart doesn't reopen the cache while it closes.
    async settle() {
      await Promise.all(nodes.map((node) => node.stop()));
    },
    async close() {
      await manager.stopIpfs();
      await Promise.all(nodes.map((node) => node.stop()));
      // Windows may hold the cache's files a moment after the node frees them.
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/**
 * The backends, each with the features it honours. A feature's pending
 * tests run against a backend that lists it here.
 */
const BACKENDS = {
  addon: { load: loadAddonBackend, honours: [] },
};

/** The backend named by FREEDOM_IPFS_CONTRACT_BACKEND, or null when unset. */
function contractBackendName() {
  const name = process.env.FREEDOM_IPFS_CONTRACT_BACKEND || '';
  if (!name) return null;
  if (!BACKENDS[name]) {
    throw new Error(
      `FREEDOM_IPFS_CONTRACT_BACKEND=${name} is not a backend: ${Object.keys(BACKENDS).join(', ')}`
    );
  }
  return name;
}

/**
 * The pending features a run turns on anyway (FREEDOM_IPFS_CONTRACT_PENDING:
 * `all`, or a comma-separated list), to see what a backend still lacks.
 */
function forcedFeatures() {
  const value = process.env.FREEDOM_IPFS_CONTRACT_PENDING || '';
  if (value === 'all') return new Set(FEATURES);
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!FEATURES.includes(name)) throw new Error(`unknown contract feature: ${name}`);
  }
  return new Set(names);
}

module.exports = {
  BACKENDS,
  FEATURES,
  TODAY_CONFIG,
  contractBackendName,
  forcedFeatures,
};
