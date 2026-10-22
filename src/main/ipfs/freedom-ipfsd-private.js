/**
 * Private windows' freedom-ipfs instances (freedom-core design 0007,
 * "Private windows", "Main's side" and "Instance IDs"): one ephemeral
 * freedom-ipfsd process per profile, `serve --ephemeral`, with one memory
 * instance per private partition, so nothing a private window loads reaches
 * the profile's cache, another partition's, or the application's files.
 *
 * - **Leases** (`lease(partition)`): a request's capture pins its
 *   partition's instance until the handler releases it, on every exit. A
 *   partition with an instance, live or still pending, pins it and uses it,
 *   however many are pinned. Only a partition without one needs a new
 *   instance, and only then is capacity checked: a slot of the 8 is free,
 *   or one holds an unpinned instance, which is evicted (the least recently
 *   used). The reservation is a pending instance, pinned by this lease. No
 *   slot, all 8 pinned by other partitions, is `BackendBusy`: capacity, not
 *   readiness.
 * - **Eviction is at the reservation,** synchronously in the capture, the
 *   only point that can answer `BackendBusy` before planning. Its cost: a
 *   lease released without a fetch (an error plan, a redirect) has cost the
 *   evicted instance its warm cache all the same.
 * - **The cold start runs inside `request()`,** one per instance (single
 *   flight): the previous occupant's teardown, if its slot came from an
 *   eviction or a stop; a network policy (`ipfs-network.js`), the
 *   profile's: while it has none (IPFS through Tor, and no endpoint from
 *   Tor yet), the start waits for one, and nothing falls back to `direct`;
 *   the process, spawned on demand with `ipfs.hello`; then `ipfs.start` for
 *   a memory store of 32 MiB, under a new ID, with that policy. Each
 *   waiter has its own signal and its own `headers_ms`, which covers the
 *   start: the request gets what is left. One waiter's abort or deadline
 *   rejects that waiter only. The start is the instance's, and goes when its
 *   last lease is released, or its partition or process goes.
 * - **Fences:** an instance is retired synchronously, before anything is
 *   sent about it (an eviction, a close, its last lease, a crash, the
 *   service retiring it); every continuation checks it before it sends, so
 *   nothing reaches a retired or evicted ID. A start already sent is
 *   stopped with `ipfs.stop`, whose reply proves the teardown: its slot is
 *   drained only then, and a start that takes it waits for that.
 * - **Closing a partition** (`close`, from `closeDwebSession`) retires its
 *   instance, so the leases it still holds pin nothing. A closed partition
 *   is never served again.
 * - **The process** goes when its last instance has: `ipfs.shutdown`, and a
 *   kill 5 s later. The next private request spawns it again.
 * - **Crashes** follow the persistent process's rules, but the process
 *   comes back lazily: an exit main didn't ask for retires every instance,
 *   and the next one that needs the process spawns it after the back-off
 *   (0.5 s, 2 s, 10 s). The service retiring an instance after a request
 *   panic counts as a crash of its process too: the back-off is the
 *   process's, and every `ipfs.start` waits for it, whether the process
 *   restarts or lives on serving other partitions. One timer serves every
 *   start waiting, and goes with the last of them. The record outlives the
 *   process's idle shutdowns, so a crash on first use can't loop: three
 *   within 60 s fail the private instances until the manager starts them
 *   anew, and so do the exits that are never retried (64, 74, 75, a
 *   protocol mismatch). The shared client restarts on its own; this stops
 *   it from within its exit instead ("stopping is sticky"), and starts it
 *   again on demand.
 * - **A start the service refuses** for anything but memory (`storage`: a
 *   store that won't open, or a fault) fails the private instances as the
 *   persistent node gives up (0007: an error, not a crash; no restart until
 *   the user's).
 * - **Requests** are the persistent node's (`freedom-ipfsd-node.js`):
 *   today's texts, `BackendBusy` for the service's `busy`, and the
 *   pull-driven body. A start the service refuses for memory (`busy`) is
 *   `BackendBusy` too, and its instance is retired, so the next request
 *   tries again.
 */

const { spawn: spawnProcess } = require('child_process');
const defaultLog = require('../logger');
const {
  CRASH_WINDOW_MS,
  MAX_CRASHES_IN_WINDOW,
  NO_RESTART_EXIT_CODES,
  RESTART_DELAYS_MS,
} = require('../core/service-client');
const { IpfsdClient, ephemeralArgs, getIpfsdBinaryPath } = require('./ipfsd-client');
const { ATTEMPT_TIMEOUT_MS, REQUEST_QUEUE_TIMEOUT_MS } = require('./freedom-ipfs-native-node');
const {
  BackendBusy,
  instanceParams,
  headResponse,
  requestError,
  failure,
  NOT_RUNNING,
  ABORTED,
  TIMEOUT,
  EXITED,
} = require('./freedom-ipfsd-node');
const { DIRECT } = require('./ipfs-network');

/** The most instances the ephemeral process holds (0007, Bounds). */
const MAX_INSTANCES = 8;
/** A private instance's store: a 32 MiB block target, inside the 36 MiB
 * page cap the service sets (0007, Budgets). */
const MEMORY_STORE_BYTES = 32 * 1024 * 1024;
/** The handler's answer when every instance is pinned (0007, "Main's side"). */
const CAPACITY = 'Too many private windows are loading IPFS content';

/** What an `ipfs.start` may fail with and still be tried again: memory
 * (`busy`), main's own retirement (`stopped`, `fenced`), or the process's
 * end, which the crash rules cover. */
const RETRYABLE_START = new Set(['busy', 'stopped', 'fenced', 'ipfs_unavailable']);

const notRunning = () => failure(NOT_RUNNING, 'stopped');

/** A lease that pins nothing: a closed partition's, or one taken after the
 * instances have failed or stopped. */
const DEAD_LEASE = Object.freeze({
  request: () => Promise.reject(notRunning()),
  release() {},
});

class PrivateInstances {
  /**
   * @param {object} [options]
   * @param {string} [options.shellVersion]
   * @param {number} [options.requestQueueTimeoutMs] - the gateway's queue (15 s)
   * @param {object} [options.network] - the network policy
   *   (`ipfs-network.js`): `current()` and `subscribe(listener)`;
   *   `direct` without one
   * @param {string} [options.command] - the binary (`getIpfsdBinaryPath()`)
   * @param {string[]} [options.args] - its arguments (`ephemeralArgs()`)
   * @param {Function} [options.spawn] - child_process.spawn (injectable)
   * @param {object} [options.log]
   * @param {Function} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    shellVersion,
    requestQueueTimeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
    network = DIRECT,
    command = null,
    args = null,
    spawn = spawnProcess,
    log = defaultLog,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.requestQueueTimeoutMs = requestQueueTimeoutMs;
    this.network = network;
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.client = new IpfsdClient({
      kind: 'ephemeral',
      spawn,
      command: command ?? getIpfsdBinaryPath(),
      args: args ?? ephemeralArgs(),
      log,
      shellVersion,
      now,
      setTimer,
      clearTimer,
    });
    this.client.on('exit', (exit) => this.onExit(exit));
    this.client.on('event', (name, data) => this.onEvent(name, data));
    // Each slot holds at most one instance, and the teardown of the one
    // before it, until that is proven.
    this.slots = Array.from({ length: MAX_INSTANCES }, () => ({ occupant: null, draining: null }));
    this.byPartition = new Map();
    this.byId = new Map();
    this.closed = new Set();
    // The process now: `ready` resolves to its generation once it has
    // answered `ipfs.hello`. `shutdown` is the stop of the one before it.
    this.life = null;
    this.shutdown = null;
    this.stopAsked = false;
    this.counter = { gen: null, next: 1 };
    this.crashTimes = [];
    this.respawnAt = 0;
    // The wait for `respawnAt`: its timer, and the instances waiting on it.
    this.backoffWait = null;
    this.failed = false;
    this.stopped = false;
    this.stopping = null;
  }

  /** Whether private partitions can be served: neither failed nor stopped. */
  get up() {
    return !this.failed && !this.stopped;
  }

  /** How many leases pin `partition`'s instance. */
  pins(partition) {
    return this.byPartition.get(partition)?.leases.size ?? 0;
  }

  /**
   * A lease on `partition`'s instance, reserving one if it has none: `{
   * request(init), release() }`. Throws `BackendBusy` when it needs one and
   * every slot is pinned by another partition.
   */
  lease(partition) {
    if (!this.up || this.closed.has(partition)) return DEAD_LEASE;
    const instance = this.byPartition.get(partition) ?? this.reserve(partition);
    const lease = { released: false };
    instance.leases.add(lease);
    instance.lastUsed = this.now();
    return {
      request: (init) => this.request(instance, lease, init),
      release: () => this.release(instance, lease),
    };
  }

  /** Retires `partition`'s instance, so the leases it still holds pin
   * nothing, and serves the partition no more: the backstop of a closed
   * private session. */
  close(partition) {
    this.closed.add(partition);
    const instance = this.byPartition.get(partition);
    if (instance) this.retire(instance);
  }

  /** Retires every instance and shuts the process down: quit, a mode
   * change, or the node's stop. Idempotent; nothing starts again. */
  stop() {
    if (!this.stopped) {
      this.stopped = true;
      this.retireAll();
      this.stopping = this.stopProcess();
    }
    return this.stopping;
  }

  // ---- instances and their slots ----

  /** A pending instance for `partition` in a free slot, or one taken from
   * the least recently used unpinned instance. */
  reserve(partition) {
    const slot =
      this.slots.find((s) => !s.occupant && !s.draining) ??
      this.slots.find((s) => !s.occupant) ??
      this.evict();
    if (!slot) throw new BackendBusy(CAPACITY);
    const instance = {
      partition,
      slot,
      leases: new Set(),
      lastUsed: this.now(),
      state: 'reserved',
      gen: null,
      id: null,
      flight: null,
      // Rejects when it is retired: its waiters fail at once.
      gone: null,
      leave: null,
    };
    instance.gone = new Promise((_, reject) => {
      instance.leave = reject;
    });
    instance.gone.catch(() => {});
    slot.occupant = instance;
    this.byPartition.set(partition, instance);
    return instance;
  }

  /** Evicts the least recently used live instance no lease pins: its slot. */
  evict() {
    let victim = null;
    for (const { occupant } of this.slots) {
      if (occupant?.state !== 'live' || occupant.leases.size > 0) continue;
      if (!victim || occupant.lastUsed < victim.lastUsed) victim = occupant;
    }
    if (!victim) return null;
    this.log.info('[IPFS] private freedom-ipfs instance evicted', { instance: victim.id });
    this.retire(victim);
    return victim.slot;
  }

  release(instance, lease) {
    if (lease.released) return;
    lease.released = true;
    if (!instance.leases.delete(lease)) return;
    instance.lastUsed = this.now();
    // An idle live instance stays, to serve its partition again; one not
    // yet live has nobody left to start for.
    if (instance.leases.size === 0 && instance.state !== 'live') this.retire(instance);
  }

  /**
   * Retires `instance` at once: no continuation that captured it sends
   * anything more, and a request still waiting for its start fails with
   * `error`. A start already sent is stopped (`stop`), and its slot drains
   * once the service has proven the teardown; one that never reached the
   * service, or whose process has gone, frees it now.
   */
  retire(instance, { stop = true, error = notRunning() } = {}) {
    if (instance.state === 'retired') return;
    instance.state = 'retired';
    instance.leave(error);
    const backoff = this.backoffWait;
    if (backoff?.waiters.delete(instance) && backoff.waiters.size === 0) this.settleBackoff();
    if (this.byPartition.get(instance.partition) === instance) {
      this.byPartition.delete(instance.partition);
    }
    if (instance.id) this.byId.delete(instance.id);
    const { slot } = instance;
    if (slot.occupant === instance) {
      slot.occupant = null;
      if (stop && instance.id && this.client.serves(instance.gen)) {
        const drained = this.client
          .stopInstance(instance.gen, instance.id)
          .catch(() => {})
          .then(() => {
            if (slot.draining === drained) slot.draining = null;
            this.idle();
          });
        slot.draining = drained;
      }
    }
    this.idle();
  }

  retireAll() {
    for (const { occupant } of this.slots) {
      if (occupant) this.retire(occupant, { stop: false });
    }
  }

  // ---- requests and the cold start ----

  /**
   * One request on `instance`, starting it first if it isn't live. The
   * request's `headersTimeoutMs` covers the start; the service gets what is
   * left of it.
   */
  async request(
    instance,
    lease,
    { method = 'GET', path: gatewayPath, headers, signal, headersTimeoutMs = ATTEMPT_TIMEOUT_MS }
  ) {
    if (lease.released || instance.state === 'retired') throw notRunning();
    if (signal?.aborted) throw failure(ABORTED, 'cancelled');
    const begun = this.now();
    if (instance.state !== 'live') {
      const started = Promise.race([this.startOf(instance), instance.gone]);
      await this.waitFor(started, { signal, ms: headersTimeoutMs });
    }
    if (!this.isLive(instance)) throw notRunning();
    const left = Math.floor(headersTimeoutMs - (this.now() - begun));
    if (left < 1) throw failure(TIMEOUT, 'deadline');
    instance.lastUsed = this.now();
    const params = {
      instance: instance.id,
      method,
      path: gatewayPath,
      headers: [...new Headers(headers ?? undefined)],
      headers_ms: left,
    };
    return this.client
      .gatewayRequest(instance.gen, params, { signal, fence: () => this.isLive(instance) })
      .then(
        ({ result, body }) => headResponse(result, body),
        (err) => {
          throw requestError(err);
        }
      );
  }

  isLive(instance) {
    return instance.state === 'live' && this.client.serves(instance.gen);
  }

  /** The instance's one start, shared by every request that waits for it. */
  startOf(instance) {
    if (!instance.flight) {
      instance.flight = this.start(instance);
      // Its waiters have their own outcomes; nobody may be left to see it.
      instance.flight.catch(() => {});
    }
    return instance.flight;
  }

  /**
   * Starts `instance`: the previous occupant's teardown, the process, then
   * `ipfs.start` under a new ID. A start that fails retires the instance
   * with its error, so its partition's next request reserves anew.
   */
  async start(instance) {
    instance.state = 'starting';
    try {
      await this.startInstance(instance);
      // Retired while the service started it (its stop has gone already),
      // or its process ended: checked in the turn that makes it live.
      if (instance.state !== 'starting' || !this.client.serves(instance.gen)) {
        throw notRunning();
      }
    } catch (err) {
      const error = requestError(err);
      if (instance.state === 'starting') this.retire(instance, { stop: false, error });
      throw error;
    }
    instance.state = 'live';
    this.log.info('[IPFS] private freedom-ipfs instance started', { instance: instance.id });
  }

  async startInstance(instance) {
    // A slot that came from an eviction or a stop: that instance's
    // reservations are the service's until its teardown is proven.
    await instance.slot.draining;
    // A crash's back-off, the process's: before it is spawned again, and
    // before a live one gets another start.
    while (instance.state === 'starting' && this.respawnAt > this.now()) {
      await this.backoff(instance);
    }
    if (instance.state !== 'starting') throw notRunning();
    const network = await this.networkFor(instance);
    if (instance.state !== 'starting') throw notRunning();
    const gen = await this.process();
    if (instance.state !== 'starting' || !this.client.serves(gen)) throw notRunning();
    instance.gen = gen;
    instance.id = this.nextInstanceId(gen);
    this.byId.set(instance.id, instance);
    const params = instanceParams(
      instance.id,
      { kind: 'memory', max_bytes: MEMORY_STORE_BYTES },
      this.requestQueueTimeoutMs,
      network
    );
    try {
      await this.client.startInstance(gen, params, {
        fence: () => instance.state === 'starting',
      });
    } catch (err) {
      // Refused for memory, retired by main, or its process gone: the next
      // request tries again. Anything else the service refused or failed is
      // no crash: no restart until the user's.
      if (!RETRYABLE_START.has(err?.code)) {
        this.log.warn('[IPFS] private freedom-ipfs instance failed to start', {
          code: err?.code || 'error',
        });
        // Its waiters hear why, before every instance goes with the rest.
        this.retire(instance, { stop: false, error: requestError(err) });
        this.fail('an instance failed to start');
      }
      throw err;
    }
  }

  /**
   * The network policy `instance` starts under: the policy now, or the
   * first there is (IPFS routes through Tor, and Tor offers no endpoint
   * yet). Each waiter's deadline bounds its wait, and the instance's
   * retirement ends it. Nothing falls back to `direct`.
   */
  async networkFor(instance) {
    let network = this.network.current();
    while (!network) {
      if (instance.state !== 'starting') throw notRunning();
      let stop = () => {};
      try {
        await Promise.race([
          new Promise((resolve) => {
            stop = this.network.subscribe(resolve);
          }),
          instance.gone,
        ]);
      } finally {
        stop();
      }
      network = this.network.current();
    }
    return network;
  }

  /** `promise`, or this waiter's abort or deadline, whichever is first. */
  waitFor(promise, { signal, ms }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (settle) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        signal?.removeEventListener('abort', onAbort);
        settle();
      };
      const onAbort = () => done(() => reject(failure(ABORTED, 'cancelled')));
      const timer = this.setTimer(() => done(() => reject(failure(TIMEOUT, 'deadline'))), ms);
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => done(() => resolve(value)),
        (err) => done(() => reject(err))
      );
    });
  }

  /** Resolves once the back-off's timer has run, or nothing waits on it
   * any more (`settleBackoff`). One timer, shared by every start waiting. */
  backoff(instance) {
    if (!this.backoffWait) {
      let release;
      const settled = new Promise((resolve) => {
        release = resolve;
      });
      const timer = this.setTimer(() => this.settleBackoff(), this.respawnAt - this.now());
      this.backoffWait = { settled, release, timer, waiters: new Set() };
    }
    this.backoffWait.waiters.add(instance);
    return this.backoffWait.settled;
  }

  /** Ends the back-off's wait: its timer is cleared, and its waiters go on,
   * each checking whether it is still wanted and the back-off over. */
  settleBackoff() {
    const backoff = this.backoffWait;
    if (!backoff) return;
    this.backoffWait = null;
    this.clearTimer(backoff.timer);
    backoff.release();
  }

  nextInstanceId(gen) {
    if (this.counter.gen !== gen) this.counter = { gen, next: 1 };
    const id = `e-${this.counter.next}`;
    this.counter.next += 1;
    return id;
  }

  // ---- the process ----

  /** The process's generation once it has answered `ipfs.hello`: spawned
   * now, after the stop of the one before and any back-off. */
  process() {
    if (!this.life) {
      const life = { spawned: false };
      life.ready = this.spawn(life);
      life.ready.catch(() => {});
      this.life = life;
    }
    return this.life.ready;
  }

  async spawn(life) {
    await this.shutdown;
    if (this.life !== life || !this.up) throw notRunning();
    this.stopAsked = false;
    life.spawned = true;
    try {
      await this.client.start();
    } catch (err) {
      if (this.life === life) this.life = null;
      throw err;
    }
    const gen = this.client.current;
    if (this.life !== life || !this.client.serves(gen)) throw notRunning();
    return gen;
  }

  /** No instance left, and no teardown to wait for: the process goes. */
  idle() {
    if (!this.life || this.slots.some((s) => s.occupant || s.draining)) return;
    this.life = null;
    this.shutdown = this.stopProcess();
  }

  stopProcess() {
    this.stopAsked = true;
    return this.client.stop();
  }

  /** The process ended. One main didn't ask for is a crash. */
  onExit({ code, cause }) {
    // Its life, not one waiting for this stop to spawn the next.
    if (this.life?.spawned) this.life = null;
    const asked = this.stopAsked;
    // The shared client would restart it at once: here it comes back only
    // when a request needs it.
    this.stopProcess();
    const exited = failure(EXITED, 'ipfs_unavailable');
    for (const slot of this.slots) {
      // Its teardowns ended with it.
      slot.draining = null;
      // A crash retires every instance, pending ones too, waiting for a
      // teardown it ended or the process it took. An idle shutdown's end
      // leaves the ones reserved since to start in the next process.
      const occupant = slot.occupant;
      if (occupant && (occupant.gen || !asked)) {
        this.retire(occupant, { stop: false, error: exited });
      }
    }
    if (asked || this.stopped) return;
    if (cause === 'mismatch' || NO_RESTART_EXIT_CODES.has(code)) {
      this.fail(cause === 'mismatch' ? 'protocol mismatch' : `exit code ${code}`);
      return;
    }
    this.crashed();
  }

  /** The service retired an instance after a request panic: it is fenced
   * already, and its teardown proven. It counts as a crash. */
  onEvent(name, data) {
    if (name !== 'ipfs.instance_retired') return;
    const instance = this.byId.get(data?.instance);
    if (!instance || !this.client.serves(instance.gen)) return;
    this.log.warn('[IPFS] private freedom-ipfs instance retired', {
      instance: instance.id,
      reason: data.reason === 'panic' ? 'panic' : 'other',
    });
    this.retire(instance, { stop: false });
    this.crashed();
  }

  /** Counts a crash: the next spawn waits its back-off, and the third
   * within 60 s fails the private instances. */
  crashed() {
    const now = this.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (this.crashTimes.length >= MAX_CRASHES_IN_WINDOW) {
      this.fail('three crashes within a minute');
      return;
    }
    const delay =
      RESTART_DELAYS_MS[Math.min(this.crashTimes.length - 1, RESTART_DELAYS_MS.length - 1)];
    this.respawnAt = now + delay;
  }

  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.log.error('[IPFS] private freedom-ipfs instances unavailable', { reason });
    this.retireAll();
    this.life = null;
    this.shutdown = this.stopProcess();
  }
}

module.exports = {
  PrivateInstances,
  MAX_INSTANCES,
  MEMORY_STORE_BYTES,
  CAPACITY,
};
