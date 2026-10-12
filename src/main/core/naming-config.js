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

/** References main can map back: far more than a configuration holds. */
const MAX_REMEMBERED = 1024;
/** The core takes at most this many RPC endpoints (design 0004). */
const MAX_RPC_ENDPOINTS = 64;

class EndpointReferences {
  constructor(key = crypto.randomBytes(32)) {
    this.key = key;
    this.urls = new Map(); // ref -> URL, least recently used first
    // The current configuration's references: never forgotten while it is.
    this.pinned = new Set();
  }

  /** The reference for `url`, remembered for mapping back. */
  ref(url) {
    const digest = crypto.createHmac('sha256', this.key).update(url, 'utf8').digest('hex');
    const ref = `e${digest.slice(0, 32)}`;
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

  /** Pins `refs`, the configuration being sent, in place of the last one. */
  pin(refs) {
    this.pinned = new Set(refs);
  }

  touch(ref, url) {
    this.urls.delete(ref);
    this.urls.set(ref, url);
    if (this.urls.size <= MAX_REMEMBERED) return;
    for (const old of this.urls.keys()) {
      if (!this.pinned.has(old)) {
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
 * is enabled, and the Tezos endpoints (with TEZOS_RPC). Its references are
 * pinned while it is the current configuration.
 *
 * @param {EndpointReferences} refs
 * @param {object} sources - { ens, tezos, registry, myotis }
 */
function buildSnapshot(refs, { ens, tezos, registry, myotis }) {
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
  refs.pin([
    ...snapshot.rpc.map((e) => e.endpoint),
    ...(snapshot.direct ? [snapshot.direct.endpoint] : []),
    ...(snapshot.prover ? [snapshot.prover.endpoint] : []),
    ...snapshot.tezos,
  ]);
  return snapshot;
}

/**
 * Keeps the core configured: on each handshake (a new core process gets a
 * new reference key), on `configure()` (a settings change, `reset: true`
 * where today's code calls invalidateCachedProvider) and on `availability()`
 * (a Myotis transition). It tracks the generations the core returns.
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
    this.refs = null;
    this.initialized = null; // the current process's initialization
    this.generations = { ens: 0, tezos: 0, lifecycle: 0 };
    client.on('ready', () => this.onReady());
    client.on('exit', () => {
      this.refs = null;
      this.initialized = null;
    });
    // Built after the handshake: initialize now.
    if (client.hello) this.onReady();
  }

  onReady() {
    const refs = new EndpointReferences();
    this.refs = refs;
    this.initialized = this.initialize(refs);
  }

  /** Configures, then sends availability: true once both succeed. */
  async initialize(refs) {
    try {
      await this.sendConfigure(refs, false);
      await this.sendAvailability(refs);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolves true once the current core process is initialized, retrying
   * a failed initialization; false while there is none to use. */
  async whenReady() {
    const refs = this.refs;
    if (!refs || !this.initialized) return false;
    if (await this.initialized) return this.refs === refs;
    if (this.refs !== refs) return false;
    this.initialized = this.initialize(refs);
    return (await this.initialized) && this.refs === refs;
  }

  /** Sends the current snapshot (a settings change). */
  async configure({ reset = false } = {}) {
    const refs = this.refs;
    if (!refs) return this.generations;
    await this.sendConfigure(refs, reset);
    return this.generations;
  }

  /** Sends whether Myotis is ready and enabled (a transition). */
  async availability() {
    const refs = this.refs;
    if (!refs) return this.generations;
    await this.sendAvailability(refs);
    return this.generations;
  }

  async sendConfigure(refs, reset) {
    const params = { reset: reset ? 'providers' : 'none', ...buildSnapshot(refs, this.sources) };
    let result;
    try {
      result = await this.client.request('naming.configure', params, { caller: 'shell' });
    } catch (err) {
      this.log.warn('[Core] naming.configure failed', { code: err?.code });
      throw err;
    }
    // All three: a provider reset advances the lifecycle too.
    if (this.refs === refs) this.adopt(result, ['ens', 'tezos', 'lifecycle']);
  }

  async sendAvailability(refs) {
    const { myotis } = this.sources;
    const params = { ready: myotis.isReady() === true, enabled: myotis.isEnabled() === true };
    let result;
    try {
      result = await this.client.request('naming.availability', params, { caller: 'shell' });
    } catch (err) {
      this.log.warn('[Core] naming.availability failed', { code: err?.code });
      throw err;
    }
    if (this.refs === refs) this.adopt(result, ['lifecycle']);
  }

  /** Takes the generations a reply reports; they only ever increase. */
  adopt(result, scopes) {
    for (const scope of scopes) {
      const value = result?.[scope];
      if (Number.isSafeInteger(value) && value > this.generations[scope]) {
        this.generations[scope] = value;
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
};
