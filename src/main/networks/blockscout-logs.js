// What main still holds of Blockscout's Gnosis log index, the second source
// of the bundled Ant node's xBZZ Transfer scans (#529): the core pairs its
// pages with an RPC endpoint's answer (freedom-core design 0005, Logs, the
// Ant profile), and main's `shell.blockscout` executor (core/chain-shell.js)
// reads each page for it. That executor needs the index's URL, which main's
// chain configuration gives the core as a reference (LOG_INDEX_URLS), and
// the policy each redirect hop is checked against before it is dialled
// (redirectTarget). The local-address checks and the bounded DNS lookups are
// shared with the RPC executors' redirects (core/naming-shell.js).

const net = require('node:net');
const { isOnionHostname } = require('../ipfs/gateway-transport');

const LOG_INDEX_URLS = Object.freeze({ 100: 'https://gnosis.blockscout.com/api' });

// A redirect hop refused, naming why. main's executor answers the core
// `refused` without the reason (design 0005, Logs).
class BlockscoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockscoutError';
  }
}

// Redirects are followed by hand (redirect: 'manual'), each hop checked
// before it is dialled: an automatic follow would already have sent the
// wallet address in the query over cleartext by the time a final http: URL
// could be refused. gnosis.blockscout.com answers with one https redirect.
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Addresses on this machine or its local networks, which a redirect off the
// configured origin must not name or resolve to: a remote Blockscout must not
// be able to turn the read into a fetch, carrying the wallet address, of a
// service on the user's machine or LAN. Defence in depth (such a service
// would also need a certificate valid for the name), so the list covers the
// common forms rather than every IPv6 transition encoding (Teredo's
// obfuscated client address, for one, is not decoded):
// - IPv4: unspecified/"this network" (0/8), RFC 1918 private, CGNAT
//   (100.64/10), loopback (127/8), link-local (169.254/16), benchmarking
//   (198.18/15), multicast (224/4) and reserved plus broadcast (240/4);
// - each of those embedded in IPv6 as IPv4-mapped (::ffff:a.b.c.d, which
//   BlockList checks against its IPv4 rules itself), IPv4-compatible
//   (::a.b.c.d; ::0.0.0.0/104 also covers :: and ::1), IPv4-translated
//   (::ffff:0:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::);
// - IPv6: ULA (fc00::/7), link-local (fe80::/10), deprecated site-local
//   (fec0::/10), multicast (ff00::/8) and the local-use NAT64 prefix
//   (64:ff9b:1::/48, RFC 8215).
// The WHATWG URL parser has already canonicalised shorthand hosts such as
// 127.1, 0x7f.1, 2130706433 and [::ffff:127.0.0.1] (to [::ffff:7f00:1]).
const LOCAL_IPV4_SUBNETS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const LOCAL_IPV6_SUBNETS = [
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['64:ff9b:1::', 48],
];
// 10.0.0.0 -> '0a00:0000', the two IPv6 groups 6to4 carries it in.
const ipv4Groups = (address) => {
  const hex = address.split('.').map((octet) => Number(octet).toString(16).padStart(2, '0'));
  return `${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`;
};
const LOCAL_ADDRESSES = new net.BlockList();
for (const [address, prefix] of LOCAL_IPV4_SUBNETS) {
  LOCAL_ADDRESSES.addSubnet(address, prefix, 'ipv4');
  LOCAL_ADDRESSES.addSubnet(`::${address}`, 96 + prefix, 'ipv6');
  LOCAL_ADDRESSES.addSubnet(`::ffff:0:${address}`, 96 + prefix, 'ipv6');
  LOCAL_ADDRESSES.addSubnet(`64:ff9b::${address}`, 96 + prefix, 'ipv6');
  LOCAL_ADDRESSES.addSubnet(`2002:${ipv4Groups(address)}::`, 16 + prefix, 'ipv6');
}
for (const [address, prefix] of LOCAL_IPV6_SUBNETS) {
  LOCAL_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

const bareHost = (hostname) =>
  String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');

// Whether a URL's hostname (as `new URL()` gives it: lower case, IPv6 in
// brackets) names this machine or a local network: localhost and
// *.localhost (with or without a trailing dot), or an address above. A DNS
// name is not resolved here; see resolvesToLocalAddress.
function isLocalHostname(hostname) {
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = net.isIP(host);
  if (!version) return false;
  return LOCAL_ADDRESSES.check(host, version === 4 ? 'ipv4' : 'ipv6');
}

// A lookup its caller gave up on still runs: the system resolver can't
// cancel one, and the abort only stops the wait for it. At most this many
// may be outstanding at once, through one boundLookups.
const MAX_LOOKUPS = 64;

// A lookup refused because MAX_LOOKUPS are already outstanding.
class LookupsExhausted extends Error {
  constructor() {
    super('too many DNS lookups outstanding');
    this.name = 'LookupsExhausted';
  }
}

// `lookup`, with at most `max` lookups physically outstanding: each holds
// its slot until it settles, even once its caller has given up on it. Past
// the bound, a new one fails at once with LookupsExhausted.
function boundLookups(lookup, max = MAX_LOOKUPS) {
  let outstanding = 0;
  const bounded = (host, options) => {
    if (outstanding >= max) return Promise.reject(new LookupsExhausted());
    outstanding += 1;
    const running = Promise.resolve().then(() => lookup(host, options));
    const release = () => {
      outstanding -= 1;
    };
    running.then(release, release);
    return running;
  };
  bounded.outstanding = () => outstanding;
  return bounded;
}

// Whether a DNS name resolves (through the same system resolver the fetch
// dials with) to any local address, e.g. 127.0.0.1.nip.io. Asked before an
// off-origin hop is dialled. A name whose answer changes between this lookup
// and the fetch's own (DNS rebinding) is not caught; TLS still stands in the
// way of that. Bounded by `signal`; a lookup that fails throws.
async function resolvesToLocalAddress(hostname, { lookup, signal }) {
  const host = bareHost(hostname);
  if (net.isIP(host)) return isLocalHostname(host);
  const answer = await new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => lookup(host, { all: true, verbatim: true }))
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener?.('abort', onAbort));
  });
  const addresses = (Array.isArray(answer) ? answer : [answer]).map((entry) =>
    typeof entry === 'string' ? entry : entry?.address
  );
  if (!addresses.length) throw new Error('no address');
  return addresses.some((address) => !net.isIP(address) || isLocalHostname(address));
}

// Where a redirect from `current` to `location` (its Location header) goes,
// checked before the hop is dialled: a parseable location, on https, and
// off `origin` never to this machine or its LAN, by name or by what the name
// resolves to. A `.onion` name is refused unresolved: it has no DNS answer,
// and asking the system resolver would leak it. Throws BlockscoutError
// naming the refusal; a lookup cut short by `signal`, or refused by its
// bound (LookupsExhausted), throws its own error.
async function redirectTarget(location, current, origin, { lookup, signal }) {
  if (!location) throw new BlockscoutError('redirected with no location');
  let next;
  try {
    next = new URL(location, current);
  } catch {
    throw new BlockscoutError('redirected to a malformed location');
  }
  // A redirect must stay on https; checked before the hop is dialled.
  if (next.protocol !== 'https:') throw new BlockscoutError('redirected off https');
  // Off the configured origin, never to this machine or its LAN.
  if (next.origin !== origin) {
    if (isLocalHostname(next.hostname)) throw new BlockscoutError('redirected to a local host');
    if (isOnionHostname(next.hostname)) {
      throw new BlockscoutError('redirected to a host that does not resolve');
    }
    let local;
    try {
      local = await resolvesToLocalAddress(next.hostname, { lookup, signal });
    } catch (err) {
      if (signal?.aborted || err instanceof LookupsExhausted) throw err;
      throw new BlockscoutError('redirected to a host that does not resolve');
    }
    if (local) throw new BlockscoutError('redirected to a local host');
  }
  return next;
}

module.exports = {
  BlockscoutError,
  LookupsExhausted,
  MAX_LOOKUPS,
  MAX_REDIRECTS,
  REDIRECT_STATUSES,
  LOG_INDEX_URLS,
  boundLookups,
  isLocalHostname,
  resolvesToLocalAddress,
  redirectTarget,
};
