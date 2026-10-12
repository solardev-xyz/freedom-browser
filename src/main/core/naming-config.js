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
  }

  /** The reference for `url`, remembered for mapping back. */
  ref(url) {
    const ref = `e${crypto.createHmac('sha256', this.key).update(url, 'utf8').digest('hex').slice(0, 32)}`;
    this.urls.delete(ref);
    this.urls.set(ref, url);
    if (this.urls.size > MAX_REMEMBERED) this.urls.delete(this.urls.keys().next().value);
    return ref;
  }

  /** The URL behind `ref`, or undefined once it is forgotten. */
  url(ref) {
    return typeof ref === 'string' ? this.urls.get(ref) : undefined;
  }
}

/** `network.quorum`'s raw values, with the wire's names for two keys: the
 * core applies today's coercions and clamps where today's code reads them. */
function wireQuorum(quorum) {
  if (!quorum || typeof quorum !== 'object') return null;
  const names = { timeoutMs: 'timeout_ms', anchorTtlMs: 'anchor_ttl_ms' };
  return Object.fromEntries(
    Object.entries(quorum).map(([key, value]) => [names[key] ?? key, value])
  );
}

/**
 * The configuration snapshot, read where today's resolvers read it:
 * `getEffectiveRpcEndpoints()` (with ETH_RPC), `getDirectRpcCandidate(1)`,
 * the prover endpoint, `resolutionPolicy()`, the raw quorum, whether Myotis
 * is enabled, and the Tezos endpoints (with TEZOS_RPC).
 *
 * @param {EndpointReferences} refs
 * @param {object} sources - { ens, tezos, registry, myotis }
 */
function buildSnapshot(refs, { ens, tezos, registry, myotis }) {
  const network = registry.getNetwork(1) || {};
  const direct = ens.getDirectRpcCandidate(1);
  const [prover] = registry.getEndpoints(1, 'prover');
  const policy = ens.resolutionPolicy(network);
  return {
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
}

/**
 * Keeps the core configured: on each handshake (a new core process gets a
 * new reference key), on `configure()` (a settings change, `reset: true`
 * where today's code calls invalidateCachedProvider) and on `availability()`
 * (a Myotis transition). It tracks the generations the core returns.
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
    this.generations = { ens: 0, tezos: 0, lifecycle: 0 };
    client.on('ready', () => this.onReady());
    client.on('exit', () => {
      this.refs = null;
    });
  }

  onReady() {
    this.refs = new EndpointReferences();
    // The pipe keeps their order, and the core's naming thread handles them
    // in it: configured, then told whether Myotis is ready, before any
    // lookup of this process.
    this.configure().catch(() => {});
    this.availability().catch(() => {});
  }

  /** Sends the current snapshot. */
  async configure({ reset = false } = {}) {
    const refs = this.refs;
    if (!refs) return this.generations;
    const params = { reset: reset ? 'providers' : 'none', ...buildSnapshot(refs, this.sources) };
    try {
      const { ens, tezos } = await this.client.request('naming.configure', params, {
        caller: 'shell',
      });
      if (this.refs === refs) Object.assign(this.generations, { ens, tezos });
    } catch (err) {
      this.log.warn('[Core] naming.configure failed', { code: err?.code });
      throw err;
    }
    return this.generations;
  }

  /** Sends whether Myotis is ready and enabled. */
  async availability() {
    const refs = this.refs;
    if (!refs) return this.generations;
    const { myotis } = this.sources;
    const params = { ready: myotis.isReady() === true, enabled: myotis.isEnabled() === true };
    try {
      const { lifecycle } = await this.client.request('naming.availability', params, {
        caller: 'shell',
      });
      if (this.refs === refs) this.generations.lifecycle = lifecycle;
    } catch (err) {
      this.log.warn('[Core] naming.availability failed', { code: err?.code });
      throw err;
    }
    return this.generations;
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
