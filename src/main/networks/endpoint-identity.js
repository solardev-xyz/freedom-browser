// Which provider an RPC endpoint reaches (#1094).
//
// A quorum counts providers, not URL strings. Two URLs that reach one
// provider would let it agree with itself and have its answer labelled
// verified: a trailing slash, two paths, two API keys, or `localhost` and
// `127.0.0.1`. freedom-core's router merges only equal endpoint references,
// one per (chain, URL), so main lists each provider once before it counts
// or references them (design 0005, Configuration: `endpoint-dedup`).
//
// Two URLs are one provider when:
// - they name the same host, whatever their scheme, port, path, query or
//   key. A host's ports are one operator's;
// - both are on loopback (`localhost`, `*.localhost`, 127.0.0.0/8, `::1`
//   or an IPv4-mapped 127 address) on the same port, the scheme's default
//   when none is given. Each port is one local process, whichever name
//   reaches it;
// - both hosts are under one provider's `providerDomains` in the
//   endpoint-sources catalog: a keyed provider such as Alchemy, Infura or
//   DRPC is one provider whatever its key, path or host.
// A URL that doesn't parse, or has no host, is its own provider, by its
// exact text.

const net = require('node:net');
const catalog = require('../../shared/endpoint-sources.json');

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' };

// [{ id, domains }] from the builtin catalog. Only the builtin catalog
// names provider domains: a user source can't merge other providers.
function catalogProviders(sources) {
  const providers = [];
  for (const [id, source] of Object.entries(sources || {})) {
    const domains = Array.isArray(source?.providerDomains)
      ? source.providerDomains
          .filter((domain) => typeof domain === 'string')
          .map((domain) => domain.trim().toLowerCase().replace(/\.+$/, ''))
          .filter((domain) => domain.includes('.'))
      : [];
    if (domains.length) providers.push({ id, domains });
  }
  return providers;
}

const PROVIDERS = catalogProviders(catalog);

// A URL's hostname without IPv6 brackets or trailing dots. The URL parser
// has already lowercased an http(s) host.
function bareHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

// WHATWG URLs already write every IPv4 form as dotted quads and IPv6 in its
// shortest form, IPv4-mapped addresses as `::ffff:7f00:1`.
function isLoopbackHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = net.isIP(host);
  if (version === 4) return host.split('.')[0] === '127';
  if (version === 6) return host === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
  return false;
}

function providerOf(host, providers) {
  return providers.find(({ domains }) =>
    domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
}

/**
 * The provider `url` reaches, as a key: equal keys are one provider.
 *
 * @param {string} url
 * @param {Array<{id: string, domains: string[]}>} [providers] - the
 *   catalog's providers, for tests
 * @returns {string}
 */
function endpointIdentity(url, providers = PROVIDERS) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `url:${url}`;
  }
  const host = bareHost(parsed.hostname);
  if (!host) return `url:${url}`;
  if (isLoopbackHost(host)) {
    return `loopback:${parsed.port || DEFAULT_PORTS[parsed.protocol] || ''}`;
  }
  const provider = providerOf(host, providers);
  if (provider) return `provider:${provider.id}`;
  return `host:${host}`;
}

/**
 * `urls` with each provider once, at its first place: the first URL listed
 * for a provider is the one used.
 *
 * @param {string[]} urls
 * @param {Array<{id: string, domains: string[]}>} [providers]
 * @returns {string[]}
 */
function distinctEndpoints(urls, providers = PROVIDERS) {
  const seen = new Set();
  const out = [];
  for (const url of urls || []) {
    const identity = endpointIdentity(url, providers);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(url);
  }
  return out;
}

module.exports = { endpointIdentity, distinctEndpoints, catalogProviders };
