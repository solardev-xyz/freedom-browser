/**
 * Main's side of chain data's configuration (freedom-core design 0005,
 * Configuration): the endpoint references the core knows endpoints by, the
 * snapshot `chain.configure` carries, `chain.availability`, and each
 * chain's generation.
 *
 * The core is never given an endpoint URL. Each (chain, URL) has its own
 * reference, a keyed hash under a key made for each core process: the
 * core's `shell.rpc` and `shell.blockscout` carry no chain ID, so the
 * reference tells main's executors whose generation a request must be
 * current in. A re-added endpoint gets its reference back, and nothing
 * outside this process can map one back.
 */

const crypto = require('crypto');
const { EndpointReferences } = require('./naming-config');
const { IMMEDIATE_WATCHDOG_MS } = require('./core-deadlines');
const { EndpointChecks } = require('./endpoint-checks');

/** A control request's hang watchdog (design 0001): the core answers it at
 * once, so its deadline is just the watchdog's margin. */
const CONTROL_WATCHDOG_MS = IMMEDIATE_WATCHDOG_MS;
/** The core takes at most this many RPC endpoints per chain (design 0005,
 * Configuration): the first ones in registry order. */
const MAX_RPC_ENDPOINTS = 64;
/** The router's orders for a chain whose registry entry names none. */
const DEFAULT_READ_ORDER = ['myotis', 'colibri', 'quorum', 'direct'];
const DEFAULT_NON_MYOTIS_READ_ORDER = ['colibri', 'quorum', 'direct'];
const DEFAULT_BROADCAST_ORDER = ['myotis', 'direct'];
const DEFAULT_NON_MYOTIS_BROADCAST_ORDER = ['direct'];
/** How long a core process's first snapshot waits for the checks of its
 * endpoints' chains (design 0005, "Endpoints serve their chain"). */
const STARTUP_CHECKS_MS = 3000;
/** Check results join the configuration at most this often. */
const CHECKED_CONFIGURE_MS = 60_000;

/** Main's references for chain data: one per (chain, URL). */
class ChainReferences extends EndpointReferences {
  /** The reference for `url` as one of chain `chainId`'s endpoints,
   * remembered for mapping back. */
  endpointRef(chainId, url) {
    const digest = crypto
      .createHmac('sha256', this.key)
      .update(JSON.stringify([chainId, url]), 'utf8')
      .digest('hex');
    const ref = `c${digest.slice(0, 32)}`;
    this.proposal?.add(ref);
    this.touch(ref, { url, chainId });
    return ref;
  }

  /** The `{ url, chainId }` behind `ref`, or null once it is forgotten. A
   * lookup counts as a use. */
  endpoint(ref) {
    return this.url(ref) ?? null;
  }
}

/** The quorum fields the router reads, and their names on the wire. */
const QUORUM_FIELDS = [
  ['k', 'k'],
  ['m', 'm'],
  ['timeoutMs', 'timeout_ms'],
];

/** `network.quorum`'s raw values for the fields the router reads (own
 * properties only): the core applies today's coercions, defaults and
 * clamps. */
function wireQuorum(quorum) {
  if (!quorum || typeof quorum !== 'object') return null;
  const wire = {};
  for (const [field, name] of QUORUM_FIELDS) {
    if (Object.hasOwn(quorum, field)) wire[name] = quorum[field];
  }
  return wire;
}

/** Text the wire carries: a lone surrogate, which no source name or chain
 * name means, would make the whole snapshot unreadable to the core. */
const wellFormed = (text) => text.toWellFormed();

/** An order as the router takes it (`access.readOrder || default`), its
 * names only: the core drops unknown and repeated ones (deviation
 * `order-validation`). */
function wireOrder(order, fallback) {
  const chosen = order || fallback;
  return Array.isArray(chosen)
    ? chosen.filter((name) => typeof name === 'string').map(wellFormed)
    : [];
}

const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);

/** The router's `isUserConfiguredRpc`: Direct's trust is `user-configured`
 * for an endpoint a source the user added covers. */
function isUserConfiguredRpc(registry, chainId, url) {
  const cid = String(chainId);
  const source = registry
    .getEndpointSources(chainId, 'rpc')
    .find((entry) => !entry.keyed && entry.coverage?.[cid] === url);
  if (!source) return false;
  const metadata = registry.getEndpointSourceList().find((entry) => entry.id === source.id);
  return Boolean(metadata && !metadata.builtin && !metadata.removed && !metadata.keyed);
}

/** The chains the registry configures whose IDs can cross the wire, by
 * their IDs. */
function wireChains(registry) {
  const chains = [];
  for (const [key, network] of Object.entries(registry.getAllNetworks() || {})) {
    const chainId = Number(key);
    if (!Number.isSafeInteger(chainId) || chainId < 0 || String(chainId) !== key) continue;
    chains.push([chainId, key, network]);
  }
  return chains;
}

/** A chain's RPC endpoints the snapshot may list: the first ones in
 * registry order. */
const rpcUrls = (registry, chainId) =>
  strings(registry.getEndpoints(chainId, 'rpc')).slice(0, MAX_RPC_ENDPOINTS);

/** Every (chain, URL) whose chain the snapshot's endpoints are checked
 * for. */
function rpcPairs(registry) {
  return wireChains(registry).flatMap(([chainId]) =>
    rpcUrls(registry, chainId).map((url) => ({ chainId, url }))
  );
}

/**
 * The configuration snapshot: one entry for every chain the registry
 * configures, its inputs computed where the router computes them (the read
 * and broadcast orders or their defaults, the raw quorum, the RPC endpoints
 * in registry order, the first prover), whether Myotis serves the chain,
 * and Blockscout's log index for the Ant profile. A chain whose ID can't
 * cross the wire is left out: the router could never be asked for it
 * either. It is a proposal: its references stay pinned until it is
 * settled.
 *
 * Only RPC endpoints `allows` lets in are listed: those whose `eth_chainId`
 * answered the chain (endpoint-checks.js). The prover and Blockscout's
 * index speak other protocols, and aren't asked.
 *
 * @param {ChainReferences} refs
 * @param {object} sources - { registry, myotis, logIndexUrls }
 * @param {object} [options] - allows(chainId, url): whether the endpoint
 *   answered the chain; by default every endpoint is listed
 */
function buildChainSnapshot(refs, { registry, myotis, logIndexUrls = {} }, { allows } = {}) {
  refs.propose();
  const chains = [];
  for (const [chainId, key, network] of wireChains(registry)) {
    const served = myotis.NETWORKS?.has(chainId) === true;
    const ref = (url) => refs.endpointRef(chainId, url);
    const [prover] = strings(registry.getEndpoints(chainId, 'prover'));
    const index = logIndexUrls[chainId];
    const quorum = wireQuorum(network?.quorum);
    const name = myotis.NETWORKS?.get(chainId)?.displayName ?? network?.name;
    chains.push({
      chain_id: chainId,
      // Myotis's own errors name the chain.
      display_name: typeof name === 'string' ? wellFormed(name) : key,
      read_order: wireOrder(
        network?.access?.readOrder,
        served ? DEFAULT_READ_ORDER : DEFAULT_NON_MYOTIS_READ_ORDER
      ),
      broadcast_order: wireOrder(
        network?.access?.broadcastOrder,
        served ? DEFAULT_BROADCAST_ORDER : DEFAULT_NON_MYOTIS_BROADCAST_ORDER
      ),
      ...(quorum ? { quorum } : {}),
      rpc: rpcUrls(registry, chainId)
        .filter((url) => !allows || allows(chainId, url))
        .map((url) => ({
          endpoint: ref(url),
          user_configured: isUserConfiguredRpc(registry, chainId, url),
        })),
      prover: prover ? { endpoint: ref(prover), zk: network?.zkProof !== false } : null,
      myotis: served,
      blockscout: typeof index === 'string' ? { endpoint: ref(index) } : null,
    });
  }
  return { chains };
}

/**
 * Keeps the core's chain data configured: on each handshake (a new core
 * process gets a new reference key), on `configure()` (a registry change,
 * from network-ipc's refreshDownstream) and on `availability()` (a Myotis
 * transition). It tracks the generation the core reports for each chain.
 *
 * Everything is kept per core process, as naming's configuration is: its
 * references, its generations (a new process counts from zero) and its
 * control requests, which go one at a time to that process alone.
 *
 * Chain data is usable only once a core process is initialized
 * (configured, then told each Myotis chain's readiness): `whenServing()` is
 * that barrier, and a failed initialization is retried by the next one.
 *
 * For main's executors, `endpoint(ref)` and `generation(chainId)` answer
 * for the current core process.
 *
 * The snapshot lists only RPC endpoints that answered their chain's
 * `eth_chainId` (`checks`, endpoint-checks.js), each answer kept for the
 * core process's life. A process's first snapshot waits up to
 * STARTUP_CHECKS_MS for its checks; answers that change which endpoints
 * are let in later join the configuration at most once every
 * CHECKED_CONFIGURE_MS.
 */
class ChainConfig {
  /**
   * @param {object} options
   * @param {import('./core-client').CoreClient} options.client
   * @param {object} options.sources - { registry, myotis, logIndexUrls }
   * @param {object} [options.log]
   * @param {EndpointChecks|null} [options.checks] - the endpoints' chain
   *   checks; null lists every endpoint unchecked (tests whose endpoints
   *   are scripted)
   */
  constructor({ client, sources, log, checks }) {
    this.client = client;
    this.sources = sources;
    this.log = log || console;
    this.core = null; // the current core process's state
    // Every process's state by its client generation, while anything (a
    // reply still being judged or published) holds the generation.
    this.processes = new WeakMap();
    this.checks = checks === undefined ? new EndpointChecks({ log: this.log }) : checks;
    if (this.checks) this.checks.onChange = () => this.joinChecks();
    this.lastConfigured = -Infinity; // when the last snapshot was sent
    this.joinTimer = null;
    client.on('ready', () => this.attach());
    client.on('exit', () => {
      this.core = null;
      clearTimeout(this.joinTimer);
      this.joinTimer = null;
    });
    // Built after the handshake: initialize now.
    if (client.hello) this.attach();
  }

  /** The (chain, URL) pairs the registry has now, given to the checks. */
  syncChecks() {
    const pairs = rpcPairs(this.sources.registry);
    this.checks?.sync(pairs);
    return pairs;
  }

  /**
   * Which endpoints answered their chain changed: the configuration takes
   * it, at most once every CHECKED_CONFIGURE_MS after the last snapshot.
   */
  joinChecks() {
    // Before a process's first snapshot is built, it takes every answer so
    // far itself.
    if (!this.core?.snapshotted || this.joinTimer) return;
    const delay = Math.max(0, this.lastConfigured + CHECKED_CONFIGURE_MS - Date.now());
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      this.configure().catch(() => {});
    }, delay);
    this.joinTimer.unref?.();
  }

  /**
   * Asks the endpoint `url` which chain it serves, for chain `chainId`'s
   * configuration (a source added or edited): the chain ID it answered, or
   * null when the check failed. Kept for the snapshot when it is one of the
   * chain's endpoints.
   */
  checkEndpoint(chainId, url) {
    return this.checks ? this.checks.check(chainId, url) : Promise.resolve(chainId);
  }

  /** The `{ url, chainId }` behind one of the current core process's
   * references, or null: what main's executors dial. */
  endpoint(ref) {
    return this.core?.refs.endpoint(ref) ?? null;
  }

  /** Chain `chainId`'s current generation, as the current core process
   * reported it; Infinity for a chain it doesn't configure, where no
   * request is current. */
  generation(chainId) {
    return this.core?.chains.get(chainId) ?? Infinity;
  }

  /** The URL behind one of a core process's references (`gen`'s), or
   * undefined. A reply is mapped by the process that made it. */
  endpointUrl(ref, gen) {
    return this.processes.get(gen)?.refs.endpoint(ref)?.url;
  }

  /**
   * Whether a reply computed under chain `chainId`'s `generation` was
   * overtaken by a configuration main has since moved `gen`'s process to.
   * A chain the process doesn't configure (any more) has none current: a
   * reply made while it was configured is overtaken, and one made without
   * it (generation 0) is not.
   */
  overtaken(gen, chainId, generation) {
    const core = this.processes.get(gen);
    if (!core || !Number.isSafeInteger(generation)) return false;
    const current = core.chains.get(chainId);
    return current === undefined ? generation !== 0 : generation < current;
  }

  /**
   * Whether `gen`'s process is current and no control is in flight on it:
   * none queued, none owed. A chain request is sent only then, so it can't
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
      refs: new ChainReferences(),
      chains: new Map(), // chain ID -> its generation, for the chains configured
      queue: Promise.resolve(), // its control requests, in order
      initialized: null,
      pending: 0, // control requests queued and not yet settled
      // Controls that failed: owed before anything more is served, so no
      // request runs on a configuration main has moved from.
      owed: { configure: false, availability: false },
    };
    this.core = core;
    this.processes.set(core.gen, core);
    // A new process: no endpoint's answer carries over.
    this.checks?.reset();
    core.checked = this.checks?.settled(this.syncChecks(), STARTUP_CHECKS_MS);
    core.initialized = this.initialize(core);
  }

  /** Configures, then sends each Myotis chain's readiness: true once both
   * succeed. The first snapshot waits for the endpoints' checks, up to
   * STARTUP_CHECKS_MS. */
  initialize(core) {
    return this.run(core, async () => {
      if (core.checked) await core.checked;
      await this.sendConfigure(core);
      if (this.core !== core) return false;
      await this.sendAvailability(core);
      return true;
    }).catch(() => false);
  }

  /** As naming's: resolves the initialized process (null without one),
   * once every control queued before this has settled; chain data's
   * requests go to it alone, with `client.requestTo`. */
  async whenServing() {
    const core = this.core;
    if (!core) return null;
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
    return core.owed.configure || core.owed.availability;
  }

  /** Sends what failed before, from the settings of now. */
  async resync(core) {
    const { owed } = core;
    if (owed.configure) {
      await this.sendConfigure(core);
      owed.configure = false;
    }
    if (owed.availability) {
      await this.sendAvailability(core);
      owed.availability = false;
    }
  }

  /** Whether `core` is current and its process still takes requests. */
  serving(core) {
    return this.core === core && this.client.serves(core.gen);
  }

  /** Sends the current snapshot (a registry change). Failed, it is owed:
   * nothing is served until it goes. An endpoint the change adds is asked
   * its chain, and joins once it has answered. */
  async configure() {
    const core = this.core;
    if (!core) return;
    this.syncChecks();
    try {
      await this.run(core, () => this.sendConfigure(core));
    } catch (err) {
      core.owed.configure = true;
      throw err;
    }
  }

  /** Sends each Myotis chain's readiness (a transition). Failed, it is
   * owed likewise. */
  async availability() {
    const core = this.core;
    if (!core) return;
    try {
      await this.run(core, () => this.sendAvailability(core));
    } catch (err) {
      core.owed.availability = true;
      throw err;
    }
  }

  /** Runs `task` once the core's earlier control requests have settled,
   * unless the core has gone by then. */
  run(core, task) {
    const result = core.queue.then(() => (this.core === core ? task() : false));
    // Counted at once, so a request about to be sent sees it; settled
    // before the queue moves on.
    core.pending += 1;
    const settle = () => {
      core.pending -= 1;
    };
    core.queue = result.then(settle, settle);
    return result;
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

  async sendConfigure(core) {
    let result;
    try {
      // Built as it is sent, with the registry and the checks of that
      // moment.
      const checks = this.checks;
      const params = buildChainSnapshot(
        core.refs,
        this.sources,
        checks ? { allows: (chainId, url) => checks.allows(chainId, url) } : {}
      );
      this.lastConfigured = Date.now();
      core.snapshotted = true;
      result = await this.sendControl(core, 'chain.configure', params);
    } catch (err) {
      core.refs.settle(false);
      this.log.warn('[Core] chain.configure failed', { code: err?.code });
      throw err;
    }
    core.refs.settle(true);
    this.adopt(core, result);
  }

  /** `chain.availability` for each chain Myotis serves: the readiness the
   * router sampled live (deviation `myotis-readiness`), sampled as it is
   * sent. */
  async sendAvailability(core) {
    const { myotis } = this.sources;
    for (const chainId of myotis.NETWORKS?.keys() ?? []) {
      const ready = myotis.isReady(chainId) === true;
      try {
        await this.sendControl(core, 'chain.availability', { chain_id: chainId, ready });
      } catch (err) {
        this.log.warn('[Core] chain.availability failed', { code: err?.code });
        throw err;
      }
    }
  }

  /** Takes the generations a configuration reports: the chains it names,
   * and no other. Within a process a chain's only ever increases. */
  adopt(core, result) {
    const chains = new Map();
    const reported = result?.generations;
    if (reported && typeof reported === 'object') {
      for (const [key, value] of Object.entries(reported)) {
        const chainId = Number(key);
        if (!Number.isSafeInteger(chainId) || !Number.isSafeInteger(value)) continue;
        chains.set(chainId, Math.max(value, core.chains.get(chainId) ?? 0));
      }
    }
    core.chains = chains;
  }
}

module.exports = {
  ChainConfig,
  ChainReferences,
  buildChainSnapshot,
  rpcPairs,
  STARTUP_CHECKS_MS,
  CHECKED_CONFIGURE_MS,
  wireQuorum,
  isUserConfiguredRpc,
  MAX_RPC_ENDPOINTS,
  CONTROL_WATCHDOG_MS,
};
