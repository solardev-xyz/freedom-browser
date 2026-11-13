/**
 * The network policy the profile's freedom-radicled process runs under
 * (freedom-core design 0008, "Network policy", "Modes"; plan B18), modelled
 * on ipfs-network.js: the `--network` argument the serve process is spawned
 * with, which `rad.hello` reports back. A process keeps its policy for its
 * life: a change is a new process (radicled-node.js).
 *
 * - **`direct`**, `{ mode: 'direct' }`, unless the profile routes Radicle
 *   through Tor.
 * - **`socks5`**, `{ mode: 'socks5', ip, port }`, when it does: Tor's SOCKS
 *   endpoint as tor-manager offers it to Radicle (an IP literal and a port,
 *   so reaching the proxy needs no DNS). Until tor-manager offers one (Tor
 *   starting, stopped or in error, or at an endpoint Radicle can't take),
 *   there is no policy: `current()` is null, nothing is spawned, and Radicle
 *   stays `starting`. Nothing falls back to `direct`.
 *
 * The SOCKS5 credentials, one set per remote node, are the service's own
 * (0008, "Modes", stream isolation per remote node): main passes none.
 *
 * Whether the profile routes Radicle through Tor is its "Route Radicle
 * through Tor" setting (`routeRadicleThroughTor`), off by default, and a
 * switch of its own, apart from IPFS's (0008, open question 9, decided): a
 * future "everything through Tor" mode would turn both on. When the setting
 * changes, its owner calls `changed()`.
 *
 * Tor's endpoint is watched only while someone listens and the profile
 * routes Radicle through Tor: a `direct` profile's policy can't change with
 * it, so tor-manager isn't asked (or loaded) for it.
 */

const { samePolicy, supersedes, networkArg, reportsPolicy } = require('../ipfs/ipfs-network');

/** Whether `settings` route Radicle through Tor: the setting, exactly true. */
function routesRadicleThroughTor(settings) {
  return settings?.routeRadicleThroughTor === true;
}

class RadicleNetwork {
  /**
   * @param {object} [options]
   * @param {() => boolean} [options.routesThroughTor] - the profile's
   *   setting; false by default
   * @param {object} [options.tor] - tor-manager's `getRadicleSocksEndpoint`
   *   and `onRadicleSocksEndpointChange`
   * @param {object} [options.log]
   */
  constructor({ routesThroughTor = () => false, tor = null, log = null } = {}) {
    this.routesThroughTor = routesThroughTor;
    this.tor = tor;
    this.log = log;
    this.listeners = new Set();
    this.stopWatchingTor = null;
  }

  /**
   * The policy now: `{ mode: 'direct' }`, `{ mode: 'socks5', ip, port }`,
   * or null while Radicle routes through Tor and Tor offers no endpoint.
   */
  current() {
    if (!this.routesThroughTor()) return { mode: 'direct' };
    const endpoint = this.tor?.getRadicleSocksEndpoint().endpoint;
    return endpoint ? { mode: 'socks5', ip: endpoint.ip, port: endpoint.port } : null;
  }

  /**
   * Calls `listener` with `current()` each time the policy may have
   * changed: the setting, or Tor's endpoint. Each listener is called on
   * its own; one that throws is logged, and the others still hear it.
   * Returns the function that stops it.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    this.watchTor();
    return () => {
      this.listeners.delete(listener);
      this.watchTor();
    };
  }

  /** Watches Tor's endpoint while someone listens and the profile routes
   * Radicle through Tor, and only then. */
  watchTor() {
    const wanted = Boolean(this.tor) && this.listeners.size > 0 && this.routesThroughTor();
    if (wanted && !this.stopWatchingTor) {
      this.stopWatchingTor = this.tor.onRadicleSocksEndpointChange(() => this.changed());
    } else if (!wanted && this.stopWatchingTor) {
      this.stopWatchingTor();
      this.stopWatchingTor = null;
    }
  }

  /** The setting changed, or Tor's endpoint did: every listener hears. */
  changed() {
    this.watchTor();
    const policy = this.current();
    for (const listener of [...this.listeners]) {
      try {
        listener(policy);
      } catch (err) {
        this.log?.error?.('[Radicle] network policy listener failed:', err);
      }
    }
  }
}

/**
 * A source that is always `policy`: what a node is given a fixed policy as
 * (a plain `{ mode, … }`), or `direct` by default. A source, one with
 * `current()` and `subscribe()`, is itself.
 */
function policySource(network) {
  if (typeof network?.current === 'function' && typeof network?.subscribe === 'function') {
    return network;
  }
  const policy = Object.freeze({ ...(network ?? { mode: 'direct' }) });
  return Object.freeze({ current: () => policy, subscribe: () => () => {} });
}

module.exports = {
  RadicleNetwork,
  routesRadicleThroughTor,
  policySource,
  samePolicy,
  supersedes,
  networkArg,
  reportsPolicy,
};
