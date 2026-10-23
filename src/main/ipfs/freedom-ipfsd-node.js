/**
 * The profile's freedom-ipfs node on the freedom-ipfsd service process
 * (freedom-core design 0007, step 6), in place of the add-on's
 * `FreedomIpfsNativeNode`, whose surface it keeps for ipfs-manager.js. It
 * runs the one persistent instance; private windows' instances are step 7.
 *
 * - **Start** (0007, "Startup and shutdown"): the grant check
 *   (`checkGrant`, freedom-core design 0010, "Main's check"), then spawn
 *   under the network policy `network` says now (`ipfs-network.js`), as
 *   `--network`; `ipfs.hello`, which must report that policy and the
 *   confinement the process got; then `ipfs.start` with today's
 *   configuration sent explicitly (0007, Parity): automatic routing over the
 *   two delegated routers (delegated only under `socks5`), a 3 s DHT query
 *   timeout and 32 providers, 8 header permits and the 15 s queue, and the
 *   add-on's store, `<ipfs-data>/freedom-ipfs/freedom-ipfs.sqlite3`, with
 *   its 256 MiB target. The node is running once the instance's first
 *   `ipfs.stats` has answered. While the policy says none (IPFS through
 *   Tor, and no endpoint from Tor yet), nothing is spawned: the node stays
 *   `starting`, and tells the manager it waits (`onChange('waiting')`),
 *   until the policy says one.
 * - **Instance IDs** (0007, "Instance IDs"): `p-1`, `p-2`, … from a counter
 *   per process generation, never reused. `capture()` binds the generation
 *   and the instance serving now; a request on a pair that has been retired
 *   (a stop, an exit, an instance the service retired) fails at once with
 *   `freedom-ipfs native node is not running`, and nothing is sent.
 *   Retirement is synchronous: the pair is marked before anything is sent
 *   about it.
 * - **Requests** (0007, "Main's side"): `ipfs.request` with the plan's
 *   `headers_ms`, its signal sending `cancel`, and a head that resolves a
 *   `Response` whose body is pulled on demand, each read returning its bytes
 *   as credit. Rejections and body errors carry today's texts (0007,
 *   Errors), and the service's `busy` is `BackendBusy`, which the executor
 *   answers 503.
 * - **Health** (0007, Stats): `ipfs.stats` every 5 s, one at a time. The node
 *   is healthy while its generation is live, its instance started and the
 *   last stats reply under 15 s old; the diagnostics are that reply's.
 * - **Crashes, hangs and restarts** (0007): the process's exits and the hang
 *   watchdogs are the client's (`ipfsd-client.js`), which restarts it with
 *   back-off; each new generation gets a new instance. An instance the
 *   service retires after a request panic (`ipfs.instance_retired`) counts
 *   as a crash too, and is replaced in the same process after the back-off.
 *   Three in 60 s stop the process, and so does an `ipfs.start` that fails:
 *   the manager is told (`onFailure`), and shows today's text.
 * - **A change of network policy** (0007, "Changing the policy"; design
 *   0010, "The network policy and the lifecycle"): the profile's setting, or
 *   Tor's endpoint moving. The policy is the process's, so the change is a
 *   new process: the generation is retired at once (every captured pair
 *   fails with today's text, and nothing more is sent to it), the process
 *   is shut down (`ipfs.shutdown`, and a kill 5 s later), and once it has
 *   exited a new one is spawned under the policy then in force, its
 *   instance under a new ID. Nothing admitted under the old policy
 *   outlives it, because its process has exited. The respawn has no
 *   back-off and counts as no crash. The setting turned on while Tor offers
 *   no endpoint yet ends a `direct` process too, and nothing is spawned
 *   until Tor offers one. Tor going down under `socks5` is no change: the
 *   policy stays, and IPFS fails closed.
 * - **Exit 77** (design 0010): the service refused its own confinement. It
 *   isn't restarted, and the node fails with a text that says so.
 * - **Stop** (0007, "Stopping the process"): the instance is retired, then
 *   `ipfs.shutdown`, which tears down every instance and exits 0; the
 *   process is killed 5 s after it if still there.
 */

const fs = require('fs');
const { spawn: spawnProcess } = require('child_process');
const defaultLog = require('../logger');
const { isObject } = require('../core/service-client');
const {
  IpfsdClient,
  confinementLog,
  getIpfsdBinaryPath,
  persistentArgs,
} = require('./ipfsd-client');
const { DIRECT, supersedes } = require('./ipfs-network');
const {
  ATTEMPT_TIMEOUT_MS,
  DELEGATED_ROUTERS,
  REQUEST_QUEUE_TIMEOUT_MS,
} = require('./freedom-ipfs-native-node');

const MIB = 1024 * 1024;
// The add-on's values where it passes 0 (freedom-ipfs v0.4.6's defaults):
// the service takes every member explicitly.
const DHT_QUERY_TIMEOUT_S = 3;
const DHT_MAX_PROVIDERS = 32;
// The DoH endpoint DNSLink and the DoH resolver ask: the add-on's
// (freedom-ipfs's default), sent explicitly, as freedom-ipfsd 0.2.0
// requires (design 0007, decision D9). It is a configured target of the
// instance's network policy.
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const MAX_CONCURRENT_REQUESTS = 8;
const HEALTH_INTERVAL_MS = 5_000;
const STATS_FRESH_MS = 15_000;
// The service proves an instance's teardown within 5 s, or exits 70.
const UNAVAILABLE = 'ipfs_unavailable';
const EMPTY_PROGRESS = '{"active":[],"events":[]}';

// Today's texts (0007, Errors), and the service's own exit (`exit-text`).
const NOT_RUNNING = 'freedom-ipfs native node is not running';
const NOT_STARTED = 'freedom-ipfs native request could not be started';
const TIMEOUT = 'freedom-ipfs native request timeout';
const ABORTED = 'freedom-ipfs native request aborted';
const CANCELLED = 'freedom-ipfs native request cancelled';
const READ_FAILED = 'freedom-ipfs native read failed';
const GATEWAY_ERROR = 'freedom-ipfs native gateway error';
const BUSY = 'freedom-ipfs native node is busy';
const EXITED = 'freedom-ipfs service exited';
const RETIRED = 'freedom-ipfs instance retired repeatedly';
const START_FAILED = 'Failed to start freedom-ipfs native node';
// freedom-core design 0010: exit 77, and main's check before a spawn.
const CONFINEMENT_REFUSED = 'freedom-ipfs service refused its confinement';
const GRANT_REFUSED = "freedom-ipfs data directory overlaps another component's directory";
const GRANT_UNCHECKED = "freedom-ipfs data directory couldn't be checked";

/** The service's `busy` (0007, Errors): the executor answers it 503. */
class BackendBusy extends Error {
  constructor(message = BUSY) {
    super(message);
    this.name = 'BackendBusy';
    this.code = 'busy';
  }
}

function failure(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** A rejected `ipfs.request`, as today's add-on rejects it. */
function requestError(err) {
  switch (err?.code) {
    case 'invalid_argument':
      return failure(NOT_STARTED, err.code);
    case 'stopped':
    case 'fenced':
      return failure(NOT_RUNNING, err.code);
    case 'deadline':
      return failure(TIMEOUT, err.code);
    case 'cancelled':
      return failure(ABORTED, err.code);
    case 'busy':
      return new BackendBusy();
    case UNAVAILABLE:
      return failure(EXITED, err.code);
    default:
      return failure(GATEWAY_ERROR, 'internal');
  }
}

/** A body's error, as today's add-on errors it: a truncation. */
function bodyError(err) {
  if (err?.code === 'cancelled') return failure(CANCELLED, err.code);
  if (err?.code === UNAVAILABLE) return failure(EXITED, err.code);
  return failure(READ_FAILED, err?.code || 'internal');
}

/** The service's body, its errors in today's texts, pulled only on demand.
 * An abort or the process's end reaches it at once, read or not. */
function nativeBody(body) {
  const reader = body.getReader();
  return new ReadableStream(
    {
      start(controller) {
        // The service body's failure, read or not: a no-op once this stream
        // is over. Its normal close needs no watching: ServiceClient closes
        // it only within a pull of this stream, which closes this one too.
        reader.closed.catch((err) => controller.error(bodyError(err)));
      },
      async pull(controller) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          controller.error(bodyError(err));
          return;
        }
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}

/**
 * `ipfs.start`'s params for `instance` on `store` (0007, Methods): today's
 * configuration, sent explicitly (0007, Parity), the same for the profile's
 * instance and a private window's: automatic routing over the two delegated
 * routers, a 3 s DHT query timeout and 32 providers, 8 header permits and
 * the gateway's queue. The network policy is the process's (`--network`),
 * which `ipfs.start` no longer carries (design 0010). Under `socks5`,
 * routing is the delegated routers only: the service takes no other
 * (decision D6), since the light DHT would dial dozens of peers per query,
 * each through Tor.
 */
function instanceParams(
  instance,
  store,
  requestQueueTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
  network = { mode: 'direct' }
) {
  return {
    instance,
    store,
    routing: {
      mode: network.mode === 'socks5' ? 'delegated' : 'auto',
      delegated_routers: DELEGATED_ROUTERS.split(','),
      dht_query_timeout_s: DHT_QUERY_TIMEOUT_S,
      dht_max_providers: DHT_MAX_PROVIDERS,
      doh_endpoint: DOH_ENDPOINT,
    },
    gateway: {
      max_concurrent_requests: MAX_CONCURRENT_REQUESTS,
      request_queue_timeout_ms: requestQueueTimeoutMs,
    },
  };
}

const isHeader = (pair) =>
  Array.isArray(pair) &&
  pair.length === 2 &&
  typeof pair[0] === 'string' &&
  typeof pair[1] === 'string';

/** The head's `Response`: its status and headers, and the body if it has one. */
function headResponse(result, body) {
  let stream = null;
  try {
    if (
      !isObject(result) ||
      !Number.isInteger(result.status) ||
      !Array.isArray(result.headers) ||
      !result.headers.every(isHeader)
    ) {
      throw new Error('malformed head');
    }
    const headers = new Headers();
    for (const [name, value] of result.headers) headers.append(name, value);
    stream = body ? nativeBody(body) : null;
    return new Response(stream, { status: result.status, headers });
  } catch {
    // Once nativeBody() holds the body's reader, only its wrapper can cancel
    // it (a 204 with a body, say, which Response refuses).
    (stream ?? body)?.cancel().catch(() => {});
    throw failure(GATEWAY_ERROR, 'internal');
  }
}

class FreedomIpfsdNode {
  /**
   * @param {object} options
   * @param {string} options.dataDir - `<ipfs-data>/freedom-ipfs`
   * @param {string} options.lockDir - the core's lock directory
   * @param {number} [options.maxCacheBytes] - the store's target (256 MiB)
   * @param {number} [options.requestQueueTimeoutMs] - the gateway's queue (15 s)
   * @param {Function} [options.onFailure] - (reason, node) once it gives up
   *   after it was running
   * @param {Function} [options.onChange] - (state, node) as it goes
   *   `restarting` and back to `running`
   * @param {object} [options.network] - the network policy
   *   (`ipfs-network.js`): `current()` and `subscribe(listener)`;
   *   `direct` without one
   * @param {Function} [options.checkGrant] - () => null if the data
   *   directory may be granted to the process, or why not (design 0010,
   *   "Main's check"; `service-grant.js`)
   * @param {string} [options.command] - the binary (`getIpfsdBinaryPath()`)
   * @param {Function} [options.spawn] - child_process.spawn (injectable)
   * @param {object} [options.log]
   * @param {string} [options.shellVersion]
   * @param {Function} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    dataDir,
    lockDir,
    maxCacheBytes = 256 * MIB,
    requestQueueTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
    onFailure = null,
    onChange = null,
    network = DIRECT,
    checkGrant = null,
    command = null,
    spawn = spawnProcess,
    log = defaultLog,
    shellVersion,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.dataDir = dataDir;
    this.maxCacheBytes = maxCacheBytes;
    this.requestQueueTimeoutMs = requestQueueTimeoutMs;
    this.onFailure = onFailure;
    this.onChange = onChange;
    this.network = network;
    this.checkGrant = checkGrant;
    // Whether nothing is spawned for want of a network policy; the
    // subscription to the policy's changes; and a policy change's stop of
    // the old process, which the next spawn follows.
    this.waitingForNetwork = false;
    this.unsubscribeNetwork = null;
    this.changing = null;
    // Why the node failed, for the manager: one of the fixed texts.
    this.failureReason = null;
    this.command = command ?? getIpfsdBinaryPath();
    this.argsFor = (policy) => persistentArgs({ dataDir, lockDir, network: policy });
    this.spawn = spawn;
    this.log = log;
    this.shellVersion = shellVersion;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.client = null;
    // stopped → starting → running ⇄ restarting; failed, or stopping → stopped.
    this.state = 'stopped';
    this.serviceHello = null;
    // The instance serving now, and one whose `ipfs.start` is in flight:
    // { gen, instance, live }.
    this.pair = null;
    this.starting = null;
    this.counter = { gen: null, next: 1 };
    // The last stats reply, for the pair it was asked of.
    this.stats = null;
    this.statsFlight = null;
    this.pollTimer = null;
    this.restartTimer = null;
    this.started = null;
    this.resolveStart = null;
    this.stopping = null;
  }

  static isAvailable() {
    return fs.existsSync(getIpfsdBinaryPath());
  }

  /** The service supervises the process: the manager only reads its health. */
  get restartsItself() {
    return true;
  }

  get version() {
    return this.serviceHello?.freedom_ipfs.version ?? null;
  }

  buildInfoJson() {
    const hello = this.serviceHello;
    if (!hello) return null;
    return JSON.stringify({
      name: 'freedom-ipfs',
      version: hello.freedom_ipfs.version,
      git_commit: hello.freedom_ipfs.git_commit,
      service: {
        name: 'freedom-ipfsd',
        version: hello.service_version,
        kind: hello.kind,
        network: hello.network,
        confinement: hello.confinement,
      },
    });
  }

  /** The confinement the process got (design 0010, "Reporting"), or null. */
  get confinement() {
    return this.serviceHello?.confinement ?? null;
  }

  /**
   * Checks the grant, spawns the service and starts the instance. Resolves
   * true once it is running, through any restarts and policy changes on the
   * way; false if it gave up (a grant refused, three crashes in 60 s, an
   * exit that isn't retried, a refused handshake or a failed `ipfs.start`;
   * `failureReason` says which) or was stopped first.
   */
  start() {
    if (this.started) return this.started;
    if (this.stopping) return Promise.resolve(false);
    this.state = 'starting';
    this.started = new Promise((resolve) => {
      this.resolveStart = resolve;
    });
    // Nothing is spawned unless the check passes (design 0010, "Main's
    // check"): a check that throws refuses too. The reason is fixed text,
    // never a path.
    let refused;
    let reason = GRANT_REFUSED;
    try {
      refused = this.checkGrant?.() ?? null;
    } catch (err) {
      refused = `the check failed: ${err?.code || err?.name || 'error'}`;
      reason = GRANT_UNCHECKED;
    }
    if (refused) {
      this.log.error('[IPFS] freedom-ipfs data directory refused', { reason: refused });
      this.state = 'failed';
      this.failureReason = reason;
      this.settleStart(false);
      return this.started;
    }
    this.unsubscribeNetwork = this.network.subscribe(() => this.onNetworkChange());
    this.pollTimer = this.setTimer(() => this.poll(), HEALTH_INTERVAL_MS);
    this.pollTimer?.unref?.();
    this.spawnUnder(this.network.current());
    return this.started;
  }

  /**
   * Spawns a process under `network`, a client and generations of its own
   * (design 0010: the policy is the process's). With no policy (IPFS through
   * Tor, and no endpoint from Tor yet), nothing is spawned, and nothing
   * falls back to `direct`: the node waits for one.
   */
  spawnUnder(network) {
    if (!network) {
      this.waitForNetwork();
      return;
    }
    this.waitingForNetwork = false;
    const client = new IpfsdClient({
      spawn: this.spawn,
      command: this.command,
      argsFor: this.argsFor,
      network,
      log: this.log,
      shellVersion: this.shellVersion,
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
    this.client = client;
    client.on('ready', (hello) => this.onReady(client, hello));
    client.on('exit', (exit) => this.onExit(client, exit));
    client.on('failed', (reason) => this.onClientFailed(client, reason));
    client.on('event', (name, data) => this.onEvent(client, name, data));
    // Readiness is the instance's: the handshake's own failures arrive as
    // events.
    client.start().catch(() => {});
  }

  /**
   * Retires the instance and shuts the process down: `ipfs.shutdown` tears
   * every instance down, and the kill 5 s after it bounds the wait.
   * Idempotent; the node doesn't start again.
   */
  stop() {
    if (!this.stopping) this.stopping = this.stopNode();
    return this.stopping;
  }

  async stopNode() {
    this.state = 'stopping';
    const changing = this.changing;
    this.cancelTimers();
    this.retire();
    this.settleStart(false);
    // A policy change's stop of the old process, too: the node is stopped
    // once no process of it is left.
    await Promise.all([this.client?.stop(), changing]);
    this.state = 'stopped';
  }

  /** Whether `pair` is the instance serving now, on its live generation. */
  isLive(pair) {
    return Boolean(pair?.live && this.client?.serves(pair.gen));
  }

  /** Running, its instance live and its last stats reply under 15 s old. */
  isHealthy() {
    const pair = this.pair;
    return (
      this.state === 'running' &&
      this.isLive(pair) &&
      this.stats?.pair === pair &&
      this.now() - this.stats.at < STATS_FRESH_MS
    );
  }

  /** The generation and instance serving now, or null. */
  capture() {
    return this.isLive(this.pair) ? this.pair : null;
  }

  /**
   * One gateway request on a captured pair: the head as a `Response`.
   * `headersTimeoutMs` is the plan's `headers_ms` (the service's deadline).
   */
  request(
    pair,
    { method = 'GET', path: gatewayPath, headers, signal, headersTimeoutMs = ATTEMPT_TIMEOUT_MS }
  ) {
    if (!this.isLive(pair)) return Promise.reject(failure(NOT_RUNNING, 'stopped'));
    // Aborted already (say, while its name resolved): nothing is sent.
    if (signal?.aborted) return Promise.reject(failure(ABORTED, 'cancelled'));
    const params = {
      instance: pair.instance,
      method,
      path: gatewayPath,
      headers: [...new Headers(headers ?? undefined)],
      headers_ms: headersTimeoutMs,
    };
    return this.client
      .gatewayRequest(pair.gen, params, { signal, fence: () => this.isLive(pair) })
      .then(
        ({ result, body }) => headResponse(result, body),
        (err) => {
          throw requestError(err);
        }
      );
  }

  /**
   * Asks the instance for `ipfs.stats`, unless a call is outstanding:
   * resolves once the one outstanding has answered. Its reply is the node's
   * health and diagnostics.
   */
  refreshStats() {
    if (this.statsFlight) return this.statsFlight;
    const pair = this.pair;
    if (!this.isLive(pair)) return Promise.resolve();
    const flight = this.client
      .instanceStats(pair.gen, pair.instance)
      .then(
        (result) => this.onStats(pair, result),
        (err) => {
          // Its process's end, or a reply in its place: health lapses on
          // its own if none comes.
          if (err?.code !== UNAVAILABLE) {
            this.log.warn('[IPFS] freedom-ipfs stats failed', { code: err?.code || 'error' });
          }
        }
      )
      .finally(() => {
        if (this.statsFlight === flight) this.statsFlight = null;
      });
    this.statsFlight = flight;
    return flight;
  }

  /** The last stats reply, if it is the live instance's. */
  liveStats() {
    const pair = this.pair;
    return this.isLive(pair) && this.stats?.pair === pair ? this.stats.result : null;
  }

  nativeGatewayStatsJson() {
    const stats = this.liveStats();
    return isObject(stats?.gateway) ? JSON.stringify(stats.gateway) : '{}';
  }

  /** Its progress, keyed as the service keys it: a request's target is its
   * envelope ID, the native request ID main set before (0007, Stats). */
  progressSnapshotJson() {
    const stats = this.liveStats();
    return isObject(stats?.progress) ? JSON.stringify(stats.progress) : EMPTY_PROGRESS;
  }

  /** The service's store and budgets (0007, Stats), which the add-on had none of. */
  serviceStatsJson() {
    const stats = this.liveStats();
    if (!stats) return '{}';
    return JSON.stringify({ store: stats.store ?? null, budget: stats.budget ?? null });
  }

  // ---- the process and its instance ----

  /** A generation completed its handshake: it gets a new instance. */
  onReady(client, hello) {
    if (client !== this.client || this.stopping || this.state === 'failed') return;
    this.serviceHello = hello;
    // What the process got (design 0010, "Reporting"): logged at each spawn.
    this.log.info('[IPFS] freedom-ipfsd confinement', confinementLog(hello.confinement));
    this.startInstance(client.current);
  }

  nextInstanceId(gen) {
    if (this.counter.gen !== gen) this.counter = { gen, next: 1 };
    const id = `p-${this.counter.next}`;
    this.counter.next += 1;
    return id;
  }

  startParams(instance, network) {
    return instanceParams(
      instance,
      { kind: 'disk', max_bytes: this.maxCacheBytes },
      this.requestQueueTimeoutMs,
      network
    );
  }

  /** `ipfs.start` for a new instance on `gen`, if it still serves, under
   * its process's policy. */
  startInstance(gen) {
    const client = this.client;
    if (this.stopping || this.state === 'failed' || !client?.serves(gen)) return;
    const network = client.network;
    const starting = { gen, instance: this.nextInstanceId(gen), live: false, network };
    this.starting = starting;
    client.startInstance(gen, this.startParams(starting.instance, network)).then(
      () => this.onInstanceStarted(starting),
      (err) => this.onInstanceStartFailed(starting, err)
    );
  }

  /**
   * Nothing is spawned for want of a network policy: IPFS routes through
   * Tor, which offers no endpoint yet. The manager hears it once
   * (`onChange('waiting')`), and nothing falls back to `direct`.
   */
  waitForNetwork() {
    if (this.waitingForNetwork) return;
    this.waitingForNetwork = true;
    this.log.info("[IPFS] freedom-ipfs waits for Tor's SOCKS endpoint");
    this.notify('waiting');
  }

  /**
   * The network policy may have changed: a node waiting for one spawns, and
   * a process the policy now supersedes (`supersedes`) is replaced by one
   * under it, or by none while there is none. Tor going down under `socks5`
   * changes nothing: the policy stays, and IPFS fails closed. A change
   * already replacing the process spawns under the policy in force once the
   * old one has exited.
   */
  onNetworkChange() {
    if (this.stopping || this.state === 'failed' || this.changing) return;
    const next = this.network.current();
    if (!this.client) {
      if (next && this.waitingForNetwork) this.spawnUnder(next);
      return;
    }
    if (supersedes(next, this.client.network)) this.changePolicy();
  }

  /**
   * 0007, "Changing the policy"; design 0010: the generation is retired at
   * once, so every captured pair fails and nothing more is sent to it; the
   * process is shut down (`ipfs.shutdown`, a kill 5 s later); and once it has
   * exited, a new one is spawned under the policy then in force, with no
   * back-off and no crash counted. The old client's events reach nothing
   * from here on.
   */
  changePolicy() {
    const old = this.client;
    this.log.info('[IPFS] the network policy changed: the freedom-ipfs process restarts');
    this.retire();
    this.goDown();
    // A retired instance's back-off restart is the old process's.
    if (this.restartTimer) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.client = null;
    const change = old.stop().then(() => {
      if (this.changing !== change) return;
      this.changing = null;
      if (this.stopping || this.state === 'failed') return;
      this.spawnUnder(this.network.current());
    });
    this.changing = change;
  }

  onInstanceStarted(starting) {
    if (this.starting !== starting) return;
    this.starting = null;
    if (!this.client?.serves(starting.gen)) return;
    starting.live = true;
    this.pair = starting;
    this.log.info('[IPFS] freedom-ipfs instance started', { instance: starting.instance });
    this.refreshStats();
  }

  onInstanceStartFailed(starting, err) {
    if (this.starting !== starting) return;
    this.starting = null;
    // Its process ended under it: the next generation starts another.
    if (err?.code === UNAVAILABLE) return;
    // A start the service refused (`storage`: the store won't open) is an
    // error, not a crash: no restart until the user's (0007).
    this.log.error('[IPFS] freedom-ipfs instance failed to start', { code: err?.code || 'error' });
    this.giveUp(START_FAILED);
  }

  /** The live instance's stats: the first one's makes the node running. */
  onStats(pair, result) {
    if (pair !== this.pair || !this.isLive(pair) || !isObject(result)) return;
    this.stats = { pair, at: this.now(), result };
    if (this.state === 'starting') {
      this.state = 'running';
      this.settleStart(true);
    } else if (this.state === 'restarting') {
      this.state = 'running';
      this.notify('running');
    }
  }

  /** The 5 s health check. */
  poll() {
    this.pollTimer = null;
    if (this.stopping || this.state === 'failed') return;
    this.refreshStats();
    this.pollTimer = this.setTimer(() => this.poll(), HEALTH_INTERVAL_MS);
    this.pollTimer?.unref?.();
  }

  /**
   * The service retired an instance on its own, after a request panic: the
   * pair is fenced now, and it counts as a crash of the process. A new
   * instance starts in the same process after the back-off; the third
   * within 60 s stops the process.
   */
  onEvent(client, name, data) {
    if (client !== this.client || name !== 'ipfs.instance_retired') return;
    const pair = this.pair;
    if (!pair || pair.gen !== client.current || data.instance !== pair.instance) return;
    this.retire();
    this.log.warn('[IPFS] freedom-ipfs instance retired', {
      instance: pair.instance,
      reason: data.reason === 'panic' ? 'panic' : 'other',
    });
    if (this.stopping || this.state === 'failed') return;
    const delay = client.recordCrash();
    if (delay === null) {
      this.giveUp(RETIRED);
      return;
    }
    this.goDown();
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.startInstance(pair.gen);
    }, delay);
  }

  /** The process ended: the client restarts it after its back-off, or
   * gives up. */
  onExit(client, exit) {
    if (client !== this.client) return;
    this.lastExit = exit ?? null;
    this.retire();
    if (this.restartTimer) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stopping || this.state === 'failed') return;
    this.goDown();
  }

  onClientFailed(client, reason) {
    if (client !== this.client || this.stopping) return;
    // Exit 77: the service refused its own confinement (design 0010), which
    // no restart changes.
    this.giveUp(reason === 'exit code 77' ? CONFINEMENT_REFUSED : EXITED);
  }

  /** A running node goes down until a new instance is live. */
  goDown() {
    if (this.state !== 'running') return;
    this.state = 'restarting';
    this.notify('restarting');
  }

  /** Nothing more is started: the process goes, and the manager hears why. */
  giveUp(reason) {
    if (this.state === 'failed' || this.stopping) return;
    const wasStarting = this.state === 'starting';
    this.state = 'failed';
    this.failureReason = reason;
    this.retire();
    this.cancelTimers();
    this.client?.stop();
    if (wasStarting) {
      this.settleStart(false);
      return;
    }
    if (typeof this.onFailure === 'function') {
      try {
        this.onFailure(reason, this);
      } catch (err) {
        this.log.warn('[IPFS] freedom-ipfs failure callback failed:', err.message);
      }
    }
  }

  /** Marks the instance, and any start in flight, retired: synchronous, so
   * every continuation that captured it fails before it sends. */
  retire() {
    for (const pair of [this.pair, this.starting]) {
      if (pair) pair.live = false;
    }
    this.pair = null;
    this.starting = null;
  }

  cancelTimers() {
    for (const name of ['pollTimer', 'restartTimer']) {
      if (this[name]) this.clearTimer(this[name]);
      this[name] = null;
    }
    this.changing = null;
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
  }

  settleStart(value) {
    const resolve = this.resolveStart;
    this.resolveStart = null;
    resolve?.(value);
  }

  notify(state) {
    if (typeof this.onChange !== 'function') return;
    try {
      this.onChange(state, this);
    } catch (err) {
      this.log.warn('[IPFS] freedom-ipfs state callback failed:', err.message);
    }
  }
}

module.exports = {
  FreedomIpfsdNode,
  BackendBusy,
  instanceParams,
  headResponse,
  requestError,
  failure,
  NOT_RUNNING,
  ABORTED,
  TIMEOUT,
  EXITED,
  CONFINEMENT_REFUSED,
  GRANT_REFUSED,
  GRANT_UNCHECKED,
  HEALTH_INTERVAL_MS,
  STATS_FRESH_MS,
};
