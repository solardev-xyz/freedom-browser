/**
 * The network policy the IPFS processes run under (freedom-core design
 * 0007, "Network policy", "Where the proxy comes from"; design 0010, "The
 * network policy and the lifecycle"): the `--network` argument each
 * freedom-ipfsd process is spawned with (`networkArg`), the same for the
 * profile's process and the private windows'. A process keeps its policy for
 * its life: a change is a new process.
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
 *
 * Tor's endpoint is watched only while someone listens and the profile
 * routes IPFS through Tor: a `direct` profile's policy can't change with
 * it, so tor-manager isn't asked (or loaded) for it.
 */

const net = require('net');

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
    this.watchTor();
    return () => {
      this.listeners.delete(listener);
      this.watchTor();
    };
  }

  /** Watches Tor's endpoint while someone listens and the profile routes
   * IPFS through Tor, and only then. */
  watchTor() {
    const wanted = Boolean(this.tor) && this.listeners.size > 0 && this.routesThroughTor();
    if (wanted && !this.stopWatchingTor) {
      this.stopWatchingTor = this.tor.onIpfsSocksEndpointChange(() => this.changed());
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

/**
 * Whether a process under `running` must make way for `next`, the policy
 * now: a different policy, or none while it runs `direct`. No policy means
 * the profile routes IPFS through Tor and Tor offers no endpoint yet, so a
 * `direct` process goes, and nothing runs until Tor offers one. Tor going
 * down under `socks5` is no change: the process stays, and fails closed.
 */
function supersedes(next, running) {
  if (!next) return running?.mode === 'direct';
  return !samePolicy(running, next);
}

/** A policy that is always `direct`, for nodes built without one. */
const DIRECT = Object.freeze({
  current: () => ({ mode: 'direct' }),
  subscribe: () => () => {},
});

/**
 * The policy as `--network` takes it (freedom-core design 0007, "Spawn"):
 * `direct`, or `socks5:<ip>:<port>`, an IPv6 address in brackets.
 */
function networkArg(policy) {
  if (policy?.mode === 'direct') return 'direct';
  if (policy?.mode === 'socks5') {
    const host = policy.ip.includes(':') ? `[${policy.ip}]` : policy.ip;
    return `socks5:${host}:${policy.port}`;
  }
  throw new Error('no network policy');
}

/**
 * An IP literal as freedom-ipfsd writes it back in `ipfs.hello`: IPv4 as it
 * is, IPv6 in its canonical form (RFC 5952, as the URL standard writes it),
 * and an IPv4-mapped IPv6 address as the IPv4 address it maps, as the
 * service reads it. Null for anything else.
 */
function canonicalIp(ip) {
  if (typeof ip !== 'string') return null;
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return null;
  let host;
  try {
    host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Whether `reported`, hello's `network`, is the policy `policy` the process
 * was spawned with (freedom-core design 0010, "Reporting"): the same mode,
 * and under `socks5` the same port and the same address in canonical form.
 */
function reportsPolicy(reported, policy) {
  if (!reported || typeof reported !== 'object' || !policy) return false;
  if (policy.mode === 'direct') {
    return reported.mode === 'direct' && Object.keys(reported).length === 1;
  }
  if (policy.mode !== 'socks5' || reported.mode !== 'socks5') return false;
  const ip = canonicalIp(reported.ip);
  return ip !== null && ip === canonicalIp(policy.ip) && reported.port === policy.port;
}

module.exports = {
  IpfsNetwork,
  samePolicy,
  supersedes,
  networkArg,
  canonicalIp,
  reportsPolicy,
  DIRECT,
};
