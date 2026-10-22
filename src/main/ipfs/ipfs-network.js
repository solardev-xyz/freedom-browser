/**
 * The network policy the IPFS instances run under (freedom-core design
 * 0007, "Network policy", "Where the proxy comes from"; step 8, B2):
 * `ipfs.start`'s `network`, the same for the profile's instance and every
 * private window's.
 *
 * - **`direct`**, `{ mode: 'direct' }`, unless the profile routes IPFS
 *   through Tor.
 * - **`socks5`**, `{ mode: 'socks5', ip, port }`, when it does: Tor's SOCKS
 *   endpoint as tor-manager offers it to IPFS (an IP literal and a port,
 *   decision D8). Until tor-manager offers one (Tor starting, stopped or in
 *   error, or at an endpoint IPFS can't take), there is no policy:
 *   `current()` is null, nothing starts, and IPFS stays `STARTING`. Nothing
 *   falls back to `direct`.
 *
 * Each instance's SOCKS5 credentials are the service's own (design 0007,
 * "Stream isolation"): `ipfs.start` carries none.
 *
 * Whether the profile routes IPFS through Tor is the setting B1 adds
 * ("Route IPFS through Tor"); until then `routesThroughTor` is false, and
 * every instance runs `direct`, as before. When the setting changes, its
 * owner calls `changed()`.
 */

class IpfsNetwork {
  /**
   * @param {object} [options]
   * @param {() => boolean} [options.routesThroughTor] - the profile's
   *   setting; false until B1
   * @param {object} [options.tor] - tor-manager's `getIpfsSocksEndpoint`
   *   and `onIpfsSocksEndpointChange`
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
   * or null while IPFS routes through Tor and Tor offers no endpoint.
   */
  current() {
    if (!this.routesThroughTor()) return { mode: 'direct' };
    const endpoint = this.tor?.getIpfsSocksEndpoint().endpoint;
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
    if (!this.stopWatchingTor && this.tor) {
      this.stopWatchingTor = this.tor.onIpfsSocksEndpointChange(() => this.changed());
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.stopWatchingTor) {
        this.stopWatchingTor();
        this.stopWatchingTor = null;
      }
    };
  }

  /** The setting changed, or Tor's endpoint did: every listener hears. */
  changed() {
    const policy = this.current();
    for (const listener of [...this.listeners]) {
      try {
        listener(policy);
      } catch (err) {
        this.log?.error?.('[IPFS] network policy listener failed:', err);
      }
    }
  }
}

/** Whether two policies (or nulls) are the same. */
function samePolicy(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.mode === b.mode && a.ip === b.ip && a.port === b.port;
}

/** A policy that is always `direct`, for nodes built without one. */
const DIRECT = Object.freeze({
  current: () => ({ mode: 'direct' }),
  subscribe: () => () => {},
});

module.exports = { IpfsNetwork, samePolicy, DIRECT };
