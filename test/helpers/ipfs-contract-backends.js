/* global jest */

/**
 * The backends the IPFS backend contract suite
 * (`src/main/ipfs/ipfs-backend.contract.test.js`, freedom-core design 0007,
 * "Tests first") runs against, chosen by `FREEDOM_IPFS_CONTRACT_BACKEND`:
 *
 * - `addon`: the freedom-ipfs N-API add-on (`npm run ipfs:download`), the
 *   rollback (design 0007, Rollback), driven by the production
 *   `ipfs-manager.js` with `FREEDOM_IPFS_BACKEND=addon` and
 *   `FreedomIpfsNativeNode`, its event worker a real worker thread. With
 *   freedom-ipfsd downloaded too, it runs under the binary's `hold-lock` on
 *   its data directory, as a development build does; without it, ungated,
 *   with the warning such a build logs.
 * - `ipfsd` (design 0007 step 6): the freedom-ipfsd service binary
 *   (`npm run ipfsd:download`), the default, driven by the production
 *   `ipfs-manager.js` with `FREEDOM_IPFS_BACKEND=service` and
 *   `FreedomIpfsdNode`, a real child process on its own temporary data and
 *   lock directories.
 *
 * Every backend serves the suite's local fixture (`ipfs-fixture.js`) and
 * nothing else: its delegated router is the fixture's, in delegated-only
 * routing, so no request leaves the loopback interface. Each one returns:
 *
 * - `manager`: the loaded `ipfs-manager.js`, whose `ipfsBackend()`,
 *   `startIpfs()`, `stopIpfs()` and `getNativeDiagnostics()` the suite
 *   drives;
 * - `handleRequest`: `ipfs-protocol.js`'s, in the same module registry, with
 *   the core's planner stood in for by `fake-dweb-core.js`. It must reach
 *   `ipfsBackend()` through `manager.ipfsBackend` as it is when called, so
 *   the suite can record the handler's captures and releases;
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

/** The add-on's own delegated router, which it uses when given ''. */
const ADDON_DEFAULT_ROUTERS = ['https://delegated-ipfs.dev/routing/v1'];

/** The parity table's configuration ("Parity": today's values). Since #700
 * the node asks two delegated routers, in parallel (`DELEGATED_ROUTERS` in
 * freedom-ipfs-native-node.js). */
const TODAY_CONFIG = {
  routing: 'auto',
  delegatedRouters: ['https://delegated-ipfs.dev/routing/v1', 'https://cid.contact/routing/v1'],
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
  // A development build runs the add-on under freedom-ipfsd's hold-lock
  // where the binary is there (design 0007, Rollback): its gate goes in a
  // lock directory of the run's own.
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfs-contract-locks-'));
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

  const managerPath = path.join(SRC, 'ipfs-manager.js');
  // A backend loaded before this one in the same process (the cost
  // measurement loads both) left its manager registered as ipfs-manager.js
  // (below), and a registration outlives resetModules: this one loads
  // production's own.
  jest.dontMock(managerPath);
  // The manager reads it at each start: kept until close().
  const backendBefore = process.env.FREEDOM_IPFS_BACKEND;
  process.env.FREEDOM_IPFS_BACKEND = 'addon';
  const { mod: manager } = loadMainModule(managerPath, {
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
      [path.join(SRC, 'service-locks.js')]: () => ({ getLockDir: () => lockDir }),
      [path.join(SRC, 'core', 'naming.js')]: () => ({
        namingDriver: () => createFakeDwebDriver(),
      }),
    },
  });
  // ipfs-protocol.js takes `ipfsBackend` from the manager when it loads.
  // Handed one that calls the manager's export when called, the handler
  // reaches whatever the suite puts there (its capture recorder), and still
  // runs production's `ipfsBackend()` underneath.
  jest.doMock(managerPath, () => ({
    ...manager,
    ipfsBackend: (options) => manager.ipfsBackend(options),
  }));
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
      // The add-on takes 0 and '' for its defaults (v0.4.6's are v0.4.5's).
      // '' is its one built-in router, so a start that passed none (as
      // before #700) doesn't read as today's configuration.
      return {
        routing: routingName(constants(), start.mode),
        delegatedRouters: start.routers ? start.routers.split(',') : ADDON_DEFAULT_ROUTERS,
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
      if (backendBefore === undefined) delete process.env.FREEDOM_IPFS_BACKEND;
      else process.env.FREEDOM_IPFS_BACKEND = backendBefore;
      // Windows may hold the cache's files a moment after the node frees them.
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      fs.rmSync(lockDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/** The service's routing modes, in `startConfig()`'s terms. */
const routingModeName = (mode) => String(mode).replace('_', '-');

/** `body`, pulled on demand, its end, error or cancel held until `fresh()`
 * has resolved. */
function afterFreshStats(body, fresh) {
  const reader = body.getReader();
  return new ReadableStream(
    {
      async pull(controller) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          await fresh();
          controller.error(err);
          return;
        }
        if (!chunk.done) {
          controller.enqueue(chunk.value);
          return;
        }
        await fresh();
        controller.close();
      },
      async cancel(reason) {
        await reader.cancel(reason);
        await fresh();
      },
    },
    { highWaterMark: 0 }
  );
}

/**
 * freedom-ipfsd behind `ipfs-manager.js`, with FREEDOM_IPFS_BACKEND=service.
 * As for the add-on, only the start is shimmed: `ipfs.start`'s params are
 * recorded as production sends them, then sent with the fixture's router in
 * delegated-only routing. The process is the real binary, on a data
 * directory and a lock directory of its own.
 *
 * The suite reads the gateway counters synchronously
 * (`getNativeDiagnostics()`), and the service's come in `ipfs.stats`
 * replies, a round trip behind. So they are asked for back to back while
 * the suite runs, and each request's end waits for one asked after it: a
 * read is never older than the suite's last wait, or its last request's end.
 * A timing run (`freshStats: false`, the cost measurement) does without
 * both, so the service is measured as production runs it.
 */
async function loadIpfsdBackend({ router, freshStats = true }) {
  const clientPath = path.join(SRC, 'ipfs', 'ipfsd-client.js');
  const nodePath = path.join(SRC, 'ipfs', 'freedom-ipfsd-node.js');
  const binary = jest.requireActual(clientPath).getIpfsdBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(
      'FREEDOM_IPFS_CONTRACT_BACKEND=ipfsd needs freedom-ipfsd: run npm run ipfsd:download'
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ipfsd-contract-'));
  const dataDir = path.join(root, 'ipfs-data');
  const lockDir = path.join(root, 'locks');
  const nodes = [];
  const starts = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const backendBefore = process.env.FREEDOM_IPFS_BACKEND;
  process.env.FREEDOM_IPFS_BACKEND = 'service';

  const managerPath = path.join(SRC, 'ipfs-manager.js');
  // A backend loaded before this one in the same process (the cost
  // measurement loads both) left its manager registered as ipfs-manager.js
  // (below), and a registration outlives resetModules: this one loads
  // production's own.
  jest.dontMock(managerPath);
  const { mod: manager } = loadMainModule(managerPath, {
    app: { isPackaged: false, getVersion: () => '0.0.0-contract', getPath: () => root },
    extraMocks: {
      [clientPath]: () => {
        const actual = jest.requireActual(clientPath);
        class ShimmedClient extends actual.IpfsdClient {
          startInstance(gen, params) {
            starts.push(params);
            return super.startInstance(gen, {
              ...params,
              routing: { ...params.routing, mode: 'delegated', delegated_routers: [router] },
            });
          }
        }
        return { ...actual, IpfsdClient: ShimmedClient };
      },
      // Every node the manager makes, so a test can end its process as a
      // fault would. A request's end (its rejection, its bodiless head, its
      // body's end, error or cancel) reaches the suite only once a stats
      // reply asked for after it has come: what the suite then reads
      // counts what the service had counted by the end.
      [nodePath]: () => {
        const actual = jest.requireActual(nodePath);
        class RecordedNode extends actual.FreedomIpfsdNode {
          constructor(options) {
            super(options);
            nodes.push(this);
          }

          async freshStats() {
            await this.statsFlight;
            await this.refreshStats();
          }

          request(pair, init) {
            if (!freshStats) return super.request(pair, init);
            return super.request(pair, init).then(
              async (res) => {
                if (!res.body) {
                  await this.freshStats();
                  return res;
                }
                return new Response(
                  afterFreshStats(res.body, () => this.freshStats()),
                  {
                    status: res.status,
                    statusText: res.statusText,
                    headers: res.headers,
                  }
                );
              },
              async (err) => {
                await this.freshStats();
                throw err;
              }
            );
          }
        }
        return { ...actual, FreedomIpfsdNode: RecordedNode };
      },
      [path.join(SRC, 'service-locks.js')]: () => ({ getLockDir: () => lockDir }),
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
  // As for the add-on: the handler reaches the manager's export as it is
  // when called.
  jest.doMock(managerPath, () => ({
    ...manager,
    ipfsBackend: (options) => manager.ipfsBackend(options),
  }));
  const { handleRequest } = require(path.join(SRC, 'ipfs', 'ipfs-protocol.js'));
  const { closeDwebSession } = require(path.join(SRC, 'dweb', 'fetch-admission.js'));

  // Stats, back to back, from whichever node is the manager's now.
  let closed = false;
  const polling = (async () => {
    while (freshStats && !closed) {
      await nodes.at(-1)?.refreshStats();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();

  // A node still going through a restart, or still stopping.
  const unsettled = (node) => ['starting', 'restarting', 'stopping'].includes(node.state);

  return {
    name: 'ipfsd',
    manager,
    handleRequest,
    log,
    closeDwebSession,
    // Leases come with private instances (step 7).
    pins: null,
    // Deviation `read-ahead`: the 128 KiB credit window of a stream.
    readAheadBytes: 128 * 1024,
    // Deviation `exit-text`.
    exitText: 'freedom-ipfs service exited',
    startConfig() {
      const start = starts.at(-1);
      return {
        routing: routingModeName(start.routing.mode),
        delegatedRouters: start.routing.delegated_routers,
        dhtQueryTimeoutS: start.routing.dht_query_timeout_s,
        dhtMaxProviders: start.routing.dht_max_providers,
        maxConcurrentRequests: start.gateway.max_concurrent_requests,
        requestQueueTimeoutMs: start.gateway.request_queue_timeout_ms,
        maxCacheBytes: start.store.max_bytes,
      };
    },
    // The running process killed, as a crash would end it.
    crash() {
      process.kill(nodes.at(-1).client.current.child.pid, 'SIGKILL');
    },
    // The manager's node restarts itself after a crash: wait until it is
    // running again, or gave up, and every earlier node has stopped.
    async settle() {
      const deadline = Date.now() + 20_000;
      while (nodes.some(unsettled) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      await manager.stopIpfs();
      await Promise.all(nodes.map((node) => node.stop()));
      closed = true;
      await polling;
      if (backendBefore === undefined) delete process.env.FREEDOM_IPFS_BACKEND;
      else process.env.FREEDOM_IPFS_BACKEND = backendBefore;
      // Windows may hold the cache's files a moment after the process exits.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/**
 * The backends, each with the features it honours. A feature's pending
 * tests run against a backend that lists it here.
 */
const BACKENDS = {
  addon: { load: loadAddonBackend, honours: [] },
  ipfsd: { load: loadIpfsdBackend, honours: ['auto-restart'] },
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
