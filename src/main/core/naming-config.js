/**
 * Main's side of the naming core's configuration (freedom-core design 0004,
 * Configuration): the endpoint references the core knows endpoints by, the
 * snapshot `naming.configure` carries, and `naming.availability`.
 *
 * The core is never given an endpoint URL. A reference is a keyed hash of
 * the URL under a key made for each core process, so a re-added URL gets
 * its reference back (quarantine is keyed by it, as today's map is keyed by
 * URL) and nothing outside this process can map one back.
 */

const crypto = require('crypto');
const { IMMEDIATE_WATCHDOG_MS } = require('./core-deadlines');

/** References main can map back: far more than a configuration holds. */
const MAX_REMEMBERED = 1024;
/** A control request's hang watchdog (design 0001): the core answers it at
 * once, so its deadline is just the watchdog's margin. */
const CONTROL_WATCHDOG_MS = IMMEDIATE_WATCHDOG_MS;
/** The core takes at most this many RPC endpoints (design 0004). */
const MAX_RPC_ENDPOINTS = 64;

class EndpointReferences {
  constructor(key = crypto.randomBytes(32)) {
    this.key = key;
    this.urls = new Map(); // ref -> URL, least recently used first
    // Never forgotten: the references of the configuration the core runs,
    // and of the one proposed to it, until it accepts or refuses.
    this.pinned = new Set();
    this.proposal = null;
  }

  /** The reference for `url`, remembered for mapping back. */
  ref(url) {
    const digest = crypto.createHmac('sha256', this.key).update(url, 'utf8').digest('hex');
    const ref = `e${digest.slice(0, 32)}`;
    this.proposal?.add(ref);
    this.touch(ref, url);
    return ref;
  }

  /** The URL behind `ref`, or undefined once it is forgotten. A lookup
   * counts as a use. */
  url(ref) {
    if (typeof ref !== 'string' || !this.urls.has(ref)) return undefined;
    const url = this.urls.get(ref);
    this.touch(ref, url);
    return url;
  }

  /** Opens a proposal: references made until it settles are pinned, along
   * with the accepted configuration's. */
  propose() {
    this.proposal = new Set();
  }

  /** Settles the open proposal: accepted, its references replace the pinned
   * ones; refused, they're left to be forgotten. */
  settle(accepted) {
    if (accepted && this.proposal) this.pinned = this.proposal;
    this.proposal = null;
  }

  touch(ref, url) {
    this.urls.delete(ref);
    this.urls.set(ref, url);
    if (this.urls.size <= MAX_REMEMBERED) return;
    for (const old of this.urls.keys()) {
      if (!this.pinned.has(old) && !this.proposal?.has(old)) {
        this.urls.delete(old);
        return;
      }
    }
  }
}

/** The quorum fields today's resolver reads, and their names on the wire. */
const QUORUM_FIELDS = [
  ['k', 'k'],
  ['m', 'm'],
  ['timeoutMs', 'timeout_ms'],
  ['anchor', 'anchor'],
  ['anchorTtlMs', 'anchor_ttl_ms'],
];

/** `network.quorum`'s raw values for the fields today's resolver reads (own
 * properties only): the core applies today's coercions and clamps where
 * today's code reads them. */
function wireQuorum(quorum) {
  if (!quorum || typeof quorum !== 'object') return null;
  const wire = {};
  for (const [field, name] of QUORUM_FIELDS) {
    if (Object.hasOwn(quorum, field)) wire[name] = quorum[field];
  }
  return wire;
}

/**
 * The configuration snapshot, read where today's resolvers read it:
 * `getEffectiveRpcEndpoints()` (with ETH_RPC), `getDirectRpcCandidate(1)`,
 * the prover endpoint, `resolutionPolicy()`, the raw quorum, whether Myotis
 * is enabled, and the Tezos endpoints (with TEZOS_RPC). It is a proposal:
 * its references stay pinned until it is settled.
 *
 * @param {EndpointReferences} refs
 * @param {object} sources - { ens, tezos, registry, myotis }
 */
function buildSnapshot(refs, { ens, tezos, registry, myotis }) {
  refs.propose();
  const network = registry.getNetwork(1) || {};
  const direct = ens.getDirectRpcCandidate(1);
  const [prover] = registry.getEndpoints(1, 'prover');
  const policy = ens.resolutionPolicy(network);
  const snapshot = {
    rpc: ens
      .getEffectiveRpcEndpoints()
      .slice(0, MAX_RPC_ENDPOINTS)
      .map((url) => ({ endpoint: refs.ref(url) })),
    direct: direct?.url
      ? { endpoint: refs.ref(direct.url), user_configured: direct.userConfigured === true }
      : null,
    prover: prover ? { endpoint: refs.ref(prover), zk: network.zkProof !== false } : null,
    policy: { order: policy.order, prefer_verified: policy.preferVerified === true },
    quorum: wireQuorum(network.quorum),
    myotis_enabled: myotis.isEnabled() === true,
    tezos: tezos.getRpcEndpoints().map((url) => refs.ref(url)),
  };
  return snapshot;
}

/**
 * Keeps the core configured: on each handshake (a new core process gets a
 * new reference key), on `configure()` (a settings change, `reset: true`
 * where today's code calls invalidateCachedProvider) and on `availability()`
 * (a Myotis transition). It tracks the generations the core returns.
 *
 * Everything is kept per core process: its references, its generations (a
 * new process counts from zero) and its control requests, which go one at
 * a time to that process alone, so nothing meant for one reaches another.
 *
 * Naming is usable only once a core process is initialized (configured,
 * then told Myotis' availability): `whenReady()` is that barrier, and a
 * failed initialization is retried by the next `whenReady()`.
 */
class NamingConfig {
  /**
   * @param {object} options
   * @param {import('./core-client').CoreClient} options.client
   * @param {object} options.sources - { ens, tezos, registry, myotis }
   * @param {object} [options.log]
   */
  constructor({ client, sources, log }) {
    this.client = client;
    this.sources = sources;
    this.log = log || console;
    this.core = null; // the current core process's state
    // Every process's state by its client generation, while anything (a
    // reply still being published) holds the generation.
    this.processes = new WeakMap();
    client.on('ready', () => this.attach());
    client.on('exit', () => {
      this.core = null;
    });
    // Built after the handshake: initialize now.
    if (client.hello) this.attach();
  }

  /** The URL behind one of a core process's references (`gen`'s, or the
   * current one's), or undefined. A reply is mapped by the process that
   * made it, even after that process has gone. */
  endpointUrl(ref, gen) {
    const core = gen ? this.processes.get(gen) : this.core;
    return core?.refs.url(ref);
  }

  /** The generations the current core process has reported. */
  get generations() {
    return this.core ? { ...this.core.generations } : { ens: 0, tezos: 0, lifecycle: 0 };
  }

  /** The generations a core process (`gen`'s) has reported. */
  generationsOf(gen) {
    const core = this.processes.get(gen);
    return core ? { ...core.generations } : { ens: 0, tezos: 0, lifecycle: 0 };
  }

  /**
   * Whether `gen`'s process is current and no control is in flight on it:
   * none queued, none owed. A lookup is sent only then, so it can't
   * overtake a control main has asked for, and its reply is judged only
   * then, once the generations of every control it may have crossed are
   * known.
   */
  idle(gen) {
    const core = this.processes.get(gen);
    return Boolean(core) && this.core === core && core.pending === 0 && !this.owes(core);
  }

  attach() {
    const core = {
      gen: this.client.current,
      refs: new EndpointReferences(),
      generations: { ens: 0, tezos: 0, lifecycle: 0 },
      queue: Promise.resolve(), // its control requests, in order
      initialized: null,
      ready: false, // initialized
      pending: 0, // control requests queued and not yet settled
      // Controls that failed: owed before anything more is served, so no
      // lookup runs on a snapshot main has moved from.
      owed: { configure: false, reset: false, availability: false, tezosCache: false },
    };
    this.core = core;
    this.processes.set(core.gen, core);
    core.initialized = this.initialize(core);
  }

  /** Configures, then sends availability: true once both succeed. */
  initialize(core) {
    return this.run(core, async () => {
      await this.sendConfigure(core, false);
      if (this.core !== core) return false;
      await this.sendAvailability(core);
      core.ready = true;
      return true;
    }).catch(() => false);
  }

  /** Resolves true once the current core process is initialized, retrying
   * a failed initialization (one retry, however many wait on it); false
   * while there is none to use. */
  async whenReady() {
    return (await this.whenServing()) !== null;
  }

  /** As whenReady(), but resolves the initialized process itself (null
   * without one): naming's requests go to it alone, with
   * `client.requestTo`, so none reaches a replacement not yet
   * initialized. */
  async whenServing() {
    const core = this.core;
    if (!core) return null;
    // Every control queued before this (a settings change, an
    // invalidation) goes first: a lookup must not reach the core before a
    // configuration main has already moved to.
    const queued = core.queue;
    const attempt = core.initialized;
    if ((await attempt) !== true) {
      if (!this.serving(core)) return null;
      if (core.initialized === attempt) core.initialized = this.initialize(core);
      if ((await core.initialized) !== true) return null;
    }
    // The queue never rejects: run() keeps failures to their caller.
    await queued;
    if (this.owes(core)) {
      const settled = await this.run(core, () => this.resync(core)).then(
        () => true,
        () => false
      );
      if (!settled) return null;
    }
    return this.serving(core) ? core.gen : null;
  }

  owes(core) {
    const { owed } = core;
    return owed.configure || owed.availability || owed.tezosCache;
  }

  /** Sends what failed before, from the settings of now. */
  async resync(core) {
    const { owed } = core;
    if (owed.configure) {
      await this.sendConfigure(core, owed.reset);
      owed.configure = false;
      owed.reset = false;
    }
    if (owed.availability) {
      await this.sendAvailability(core);
      owed.availability = false;
    }
    if (owed.tezosCache) {
      await this.sendControl(core, 'naming.invalidate_tezos', {});
      owed.tezosCache = false;
    }
  }

  /**
   * Queues an invalidation behind the core's earlier control requests, so it
   * keeps its order with them and with the lookups after it. Resolves its
   * result, or undefined without a core. One that fails is owed as a
   * clearing of its whole cache (a provider reset for ENS content, every
   * Tezos result), which covers it.
   */
  invalidate(method, params) {
    const core = this.core;
    if (!core) return Promise.resolve(undefined);
    return this.run(core, () => this.sendControl(core, method, params)).catch((err) => {
      if (method === 'naming.invalidate_tezos') {
        core.owed.tezosCache = true;
      } else {
        core.owed.configure = true;
        core.owed.reset = true;
      }
      throw err;
    });
  }

  sendControl(core, method, params) {
    return this.client.requestTo(
      core.gen,
      method,
      params,
      { caller: 'shell' },
      { watchdogMs: CONTROL_WATCHDOG_MS }
    );
  }

  /** Whether `core` is current and its process still takes requests (its
   * child can exit well before the client's 'exit'). */
  serving(core) {
    return this.core === core && this.client.serves(core.gen);
  }

  /** Sends the current snapshot (a settings change). Failed, it is owed:
   * nothing is served until it goes. */
  async configure({ reset = false } = {}) {
    const core = this.core;
    if (!core) return this.generations;
    try {
      await this.run(core, () => this.sendConfigure(core, reset));
    } catch (err) {
      core.owed.configure = true;
      core.owed.reset ||= reset;
      throw err;
    }
    return this.generations;
  }

  /** Sends whether Myotis is ready and enabled (a transition). Failed, it
   * is owed likewise. */
  async availability() {
    const core = this.core;
    if (!core) return this.generations;
    try {
      await this.run(core, () => this.sendAvailability(core));
    } catch (err) {
      core.owed.availability = true;
      throw err;
    }
    return this.generations;
  }

  /** Runs `task` once the core's earlier control requests have settled,
   * unless the core has gone by then. */
  run(core, task) {
    const result = core.queue.then(() => (this.core === core ? task() : false));
    // Counted at once, so a lookup about to be sent sees it; settled
    // before the queue moves on.
    core.pending += 1;
    const settle = () => {
      core.pending -= 1;
    };
    core.queue = result.then(settle, settle);
    return result;
  }

  async sendConfigure(core, reset) {
    // Built as it is sent, with the settings of that moment.
    const params = {
      reset: reset ? 'providers' : 'none',
      ...buildSnapshot(core.refs, this.sources),
    };
    let result;
    try {
      result = await this.client.requestTo(
        core.gen,
        'naming.configure',
        params,
        { caller: 'shell' },
        { watchdogMs: CONTROL_WATCHDOG_MS }
      );
    } catch (err) {
      core.refs.settle(false);
      this.log.warn('[Core] naming.configure failed', { code: err?.code });
      throw err;
    }
    core.refs.settle(true);
    // All three: a provider reset advances the lifecycle too.
    this.adopt(core, result, ['ens', 'tezos', 'lifecycle']);
  }

  async sendAvailability(core) {
    const { myotis } = this.sources;
    const params = { ready: myotis.isReady() === true, enabled: myotis.isEnabled() === true };
    let result;
    try {
      result = await this.client.requestTo(
        core.gen,
        'naming.availability',
        params,
        { caller: 'shell' },
        { watchdogMs: CONTROL_WATCHDOG_MS }
      );
    } catch (err) {
      this.log.warn('[Core] naming.availability failed', { code: err?.code });
      throw err;
    }
    this.adopt(core, result, ['lifecycle']);
  }

  /** Takes the generations a core process reports; within it, they only
   * ever increase. */
  adopt(core, result, scopes) {
    for (const scope of scopes) {
      const value = result?.[scope];
      if (Number.isSafeInteger(value) && value > core.generations[scope]) {
        core.generations[scope] = value;
      }
    }
  }
}

module.exports = {
  EndpointReferences,
  NamingConfig,
  buildSnapshot,
  wireQuorum,
  MAX_REMEMBERED,
  MAX_RPC_ENDPOINTS,
  CONTROL_WATCHDOG_MS,
};
