const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const log = require('../logger');
const { migrateLegacyConfig } = require('./migration');

// The unified source of chain + endpoint configuration. Three layers:
//   - builtin    — ships in src/shared/ (chains.json, endpoint-sources.json)
//   - user       — per-app customization (custom-chains.json, network-config.json)
//   - secrets    — API keys (rpc-api-keys.json), used to resolve keyed sources
// A network owns policy (verification strategy, quorum params); endpoint
// sources own capability (a role + a chainId->URL coverage map). Features
// name a network + a role and let getEndpoints / getNetwork resolve.

function builtinPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'src', 'shared', name)
    : path.join(__dirname, '..', '..', 'shared', name);
}

function userDataPath(name) {
  return path.join(app.getPath('userData'), name);
}

// An absent file is an expected state — user-layer files don't exist until
// the user customizes something. Only genuine read/parse errors are logged.
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error(`[network-registry] failed to read ${filePath}: ${err.message}`);
    }
    return fallback;
  }
}

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/g, '');
}

function ipv4Parts(hostname) {
  const rawParts = hostname.split('.');
  if (rawParts.length !== 4 || rawParts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }
  const parts = rawParts.map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function isInternalIpv4Parts(parts) {
  if (!parts) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isInternalIpv4(hostname) {
  return isInternalIpv4Parts(ipv4Parts(hostname));
}

function parseIpv6Part(part) {
  if (!part) return [];
  const segments = [];
  const pieces = part.split(':');
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    if (!piece) return null;
    if (piece.includes('.')) {
      if (i !== pieces.length - 1) return null;
      const ipv4 = ipv4Parts(piece);
      if (!ipv4) return null;
      segments.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    segments.push(parseInt(piece, 16));
  }
  return segments;
}

function ipv6Segments(hostname) {
  const doubleColon = hostname.indexOf('::');
  if (doubleColon !== hostname.lastIndexOf('::')) return null;

  if (doubleColon === -1) {
    const segments = parseIpv6Part(hostname);
    return segments && segments.length === 8 ? segments : null;
  }

  const left = parseIpv6Part(hostname.slice(0, doubleColon));
  const right = parseIpv6Part(hostname.slice(doubleColon + 2));
  if (!left || !right) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  return [...left, ...Array(fill).fill(0), ...right];
}

function mappedIpv4Parts(hostname) {
  const segments = ipv6Segments(hostname);
  if (!segments) return null;
  const mappedPrefix = segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff;
  if (!mappedPrefix) return null;
  return [
    segments[6] >> 8,
    segments[6] & 0xff,
    segments[7] >> 8,
    segments[7] & 0xff,
  ];
}

// Several IPv6 forms carry an IPv4 destination that the stack (or a gateway)
// translates back to real IPv4 — so [64:ff9b::a00:1] reaches 10.0.0.1 on any
// NAT64 network. Recover the embedded address so the IPv4 rules apply to it,
// otherwise these are a straight bypass of the internal-host block.
function embeddedIpv4Parts(segments) {
  const low32 = () => [segments[6] >> 8, segments[6] & 0xff, segments[7] >> 8, segments[7] & 0xff];

  // RFC 6052 well-known NAT64 prefix 64:ff9b::/96 — IPv4 in the low 32 bits.
  if (
    segments[0] === 0x0064 && segments[1] === 0xff9b
    && segments.slice(2, 6).every((segment) => segment === 0)
  ) {
    return low32();
  }
  // ::/96 IPv4-compatible (deprecated) — also covers :: and ::1 as 0.0.0.x.
  if (segments.slice(0, 6).every((segment) => segment === 0)) {
    return low32();
  }
  // RFC 3056 6to4 2002::/16 — IPv4 in the second and third segments.
  if (segments[0] === 0x2002) {
    return [segments[1] >> 8, segments[1] & 0xff, segments[2] >> 8, segments[2] & 0xff];
  }
  return null;
}

function isInternalIpv6(hostname) {
  const mapped = mappedIpv4Parts(hostname);
  if (mapped) return isInternalIpv4Parts(mapped);

  const segments = ipv6Segments(hostname);
  if (!segments) return true;
  const embedded = embeddedIpv4Parts(segments);
  if (embedded) return isInternalIpv4Parts(embedded);
  // RFC 8215 local-use NAT64 prefixes 64:ff9b:1::/48 — the embedded IPv4 sits
  // at a position that depends on the operator's prefix length, so the whole
  // range is treated as internal rather than guessed at.
  if (segments[0] === 0x0064 && segments[1] === 0xff9b && segments[2] === 0x0001) return true;
  if (segments[0] === 0x2001 && segments[1] === 0) return true; // Teredo 2001::/32
  if ((segments[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((segments[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((segments[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local (RFC 3879)
  if ((segments[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isLoopbackHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  // RFC 6761: localhost (and *.localhost) is reserved to resolve to loopback.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return ipv4Parts(host)?.[0] === 127; // 127.0.0.0/8
  if (ipVersion === 6) {
    const mapped = mappedIpv4Parts(host);
    if (mapped) return mapped[0] === 127;
    const segments = ipv6Segments(host);
    return !!segments && segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1;
  }
  return false;
}

function isInternalHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return isInternalIpv4(host);
  if (ipVersion === 6) return isInternalIpv6(host);
  return !host.includes('.');
}

function validateRpcUrl(url) {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) return 'RPC URL is required';
  if (trimmed.includes('{') || trimmed.includes('}')) {
    return 'RPC URL must not contain API-key placeholders';
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'RPC URL must be a valid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'RPC URL must use https:// or http://';
  }
  if (parsed.username || parsed.password) {
    return 'RPC URL must not include credentials';
  }
  // Loopback endpoints (e.g. http://localhost:8545 for a self-hosted node) may
  // use plaintext http — the request never leaves the machine. Everything else
  // must use https, and non-loopback internal hosts (RFC1918 LAN, link-local,
  // .local) stay blocked to limit the SSRF surface.
  const loopback = isLoopbackHostname(parsed.hostname);
  if (!loopback && parsed.protocol !== 'https:') {
    return 'RPC URL must use https:// for non-loopback hosts';
  }
  if (!loopback && isInternalHostname(parsed.hostname)) {
    return 'RPC URL must use a public hostname';
  }
  return null;
}

function normalizeRpcUrls(rpcUrls = []) {
  if (!Array.isArray(rpcUrls)) return { error: 'RPC URLs must be an array' };

  const seen = new Set();
  const urls = [];
  for (const raw of rpcUrls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    const error = validateRpcUrl(url);
    if (error) return { error };
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return { urls };
}

// rpc and prover coverage URLs are both fetched by the main process (the RPC
// pool and the Colibri prover client), so both get the same https-or-loopback
// SSRF validation. Other roles carry no network-fetched URL to guard.
const URL_VALIDATED_ROLES = new Set(['rpc', 'prover']);

function validateEndpointSourceForPersist(source) {
  if (!URL_VALIDATED_ROLES.has(source?.role)) return null;
  if (!source.coverage || typeof source.coverage !== 'object') {
    return `${source.role} source coverage is required`;
  }
  for (const url of Object.values(source.coverage)) {
    const error = validateRpcUrl(url);
    if (error) return error;
  }
  return null;
}

let cache = null;

function legacyMainnetResolutionOrder(primary) {
  if (primary === 'direct') return ['myotis', 'direct', 'quorum'];
  if (primary === 'quorum') return ['myotis', 'quorum'];
  return ['myotis', 'colibri', 'quorum'];
}

// The user-layer config. When network-config.json is absent but a legacy
// settings.json exists, run the one-shot migration and persist the result.
// Idempotent: once network-config.json is on disk, later loads just read it;
// a crash before the write simply re-migrates next time.
function resolveUserConfig(builtinSources) {
  const configPath = userDataPath('network-config.json');

  // Distinguish "absent" (a migration candidate) from "present but corrupt".
  // A corrupt file must NOT trigger re-migration — re-deriving from the old
  // legacy settings would clobber a post-migration user's new-model
  // customizations. Corrupt → fall back to defaults, leave the file intact.
  let rawConfig;
  try {
    rawConfig = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error(`[network-registry] cannot read network-config.json: ${err.message}`);
      return {};
    }
    rawConfig = null; // absent
  }
  if (rawConfig !== null) {
    try {
      return JSON.parse(rawConfig);
    } catch (err) {
      log.error(
        `[network-registry] network-config.json is corrupt, using defaults ` +
        `(file left intact for recovery): ${err.message}`
      );
      return {};
    }
  }

  const legacySettings = readJson(userDataPath('settings.json'), null);
  if (!legacySettings) return {}; // fresh install — nothing to migrate

  const migrated = migrateLegacyConfig({ settings: legacySettings, builtinSources });
  try {
    fs.writeFileSync(configPath, JSON.stringify(migrated, null, 2), 'utf-8');
    log.info('[network-registry] migrated legacy config -> network-config.json');
  } catch (err) {
    log.error(`[network-registry] failed to persist migration: ${err.message}`);
  }
  return migrated; // use it in-memory regardless of write success
}

// Merge the layers into the queryable registry. Cached until invalidate().
function load() {
  if (cache) return cache;

  const builtinNetworks = readJson(builtinPath('chains.json'), {});
  const builtinSources = readJson(builtinPath('endpoint-sources.json'), {});
  const customChains = readJson(userDataPath('custom-chains.json'), {});
  const userConfig = resolveUserConfig(builtinSources);
  const apiKeys = readJson(userDataPath('rpc-api-keys.json'), {});

  // Networks: builtin chains, then custom chains, then per-network user
  // overrides. verification/quorum are merged one level deep so a partial
  // override (e.g. just quorum.k) doesn't drop the rest of the block.
  // `primary` defaults to 'direct' — custom-chains.json is user-writable
  // and bypasses migration, so a custom chain added without a verification
  // block still resolves to a usable strategy rather than undefined.
  const networks = {};
  for (const [cid, net] of Object.entries({ ...builtinNetworks, ...customChains })) {
    const override = userConfig.networks?.[cid] || {};
    const verification = { primary: 'direct', ...net.verification, ...override.verification };
    // A network-config.json written by the previous settings UI contains only
    // `verification.primary`. Without this compatibility bridge, mainnet's new
    // builtin order would silently override that explicit older choice.
    if (
      cid === '1' &&
      Object.prototype.hasOwnProperty.call(override.verification || {}, 'primary') &&
      !Object.prototype.hasOwnProperty.call(override.verification || {}, 'order')
    ) {
      verification.order = legacyMainnetResolutionOrder(override.verification.primary);
      if (!Object.prototype.hasOwnProperty.call(override.verification, 'preferVerified')) {
        // A primary-only config came from the old single-method UI. Preserve
        // that method's winning behavior until the user explicitly opts into
        // verified-answer preference in the ordered policy UI.
        verification.preferVerified = false;
      }
    }
    networks[cid] = {
      ...net,
      ...override,
      verification,
      access: { ...net.access, ...override.access },
      quorum: { ...net.quorum, ...override.quorum },
    };
    // rpcUrls (custom chains only) is capability data — it is surfaced as
    // endpoint sources below; the network object itself stays policy-only.
    delete networks[cid].rpcUrls;
  }

  // Endpoint sources: builtin, then user-added (which may override a
  // builtin by id). allSources keeps removed entries — the config view
  // lists them as disabled; endpointSources is the active set queries
  // resolve against (removed entries filtered out).
  const removedSourceIds = new Set(userConfig.removedSources || []);
  const userSourceIds = new Set(Object.keys(userConfig.endpointSources || {}));
  const allSources = { ...builtinSources, ...(userConfig.endpointSources || {}) };
  // A custom chain's catalogue RPCs are stored on its definition. Surface
  // each as a keyless rpc source under a reserved `catalog:` id — not a
  // user-layer id, so it counts as one of the chain's public endpoints
  // rather than a hand-added one.
  for (const [cid, chain] of Object.entries(customChains)) {
    (chain.rpcUrls || []).forEach((url, i) => {
      allSources[`catalog:${cid}:${i + 1}`] = {
        role: 'rpc', keyed: false, coverage: { [cid]: url },
      };
    });
  }
  const endpointSources = {};
  for (const [id, src] of Object.entries(allSources)) {
    if (!removedSourceIds.has(id)) endpointSources[id] = src;
  }

  const customChainIds = new Set(Object.keys(customChains));

  cache = {
    networks, endpointSources, allSources,
    userSourceIds, removedSourceIds, apiKeys, customChainIds,
  };
  return cache;
}

// Drop the cached merge — call after any settings/secret change.
function invalidate() {
  cache = null;
}

// A chain is "custom" when it came from custom-chains.json; every other
// chain is builtin. The flag lets the wallet and settings UI decide what
// a user is allowed to remove.
function withBuiltinFlag(cid, net, customChainIds) {
  return { ...net, builtin: !customChainIds.has(String(cid)) };
}

function getNetwork(chainId) {
  const { networks, customChainIds } = load();
  const net = networks[String(chainId)];
  return net ? withBuiltinFlag(chainId, net, customChainIds) : null;
}

function getAllNetworks() {
  const { networks, customChainIds } = load();
  const out = {};
  for (const [cid, net] of Object.entries(networks)) {
    out[cid] = withBuiltinFlag(cid, net, customChainIds);
  }
  return out;
}

// Whether the registry has at least one usable chain-data source. A Colibri
// prover is sufficient for verified reads even when every direct RPC is
// disabled.
function isChainAvailable(chainId) {
  return (
    getEndpoints(chainId, 'rpc').length > 0 ||
    getEndpoints(chainId, 'prover').length > 0
  );
}

function getAvailableChains() {
  const all = getAllNetworks();
  const out = {};
  for (const [cid, net] of Object.entries(all)) {
    if (isChainAvailable(cid)) out[cid] = net;
  }
  return out;
}

// Endpoint source objects covering (chainId, role), raw — the {API_KEY}
// placeholder is left intact. For settings UIs that list sources.
// Sorted by resolution priority in three tiers: a user-added endpoint
// first (you chose it), then a keyed commercial provider (an opt-in,
// higher-reliability endpoint), then a builtin public RPC (the always-on
// fallback). `direct` resolves to the first; quorum / wallet failover
// walk the order.
function getEndpointSources(chainId, role) {
  const cid = String(chainId);
  const { endpointSources, userSourceIds } = load();
  const out = [];
  for (const [id, src] of Object.entries(endpointSources)) {
    if (src.role === role && src.coverage && src.coverage[cid]) {
      out.push({ id, ...src });
    }
  }
  const tierOf = (entry) => {
    if (userSourceIds.has(entry.id)) return 0;
    if (entry.keyed) return 1;
    return 2;
  };
  out.sort((a, b) => tierOf(a) - tierOf(b));
  return out;
}

// Resolved, ready-to-use URLs for (chainId, role). Keyed sources have
// {API_KEY} substituted from the secrets store; a keyed source with no
// enabled key is dropped (it can't produce a usable URL).
function getEndpoints(chainId, role) {
  const cid = String(chainId);
  const { apiKeys } = load();
  const out = [];
  for (const src of getEndpointSources(cid, role)) {
    const url = src.coverage[cid];
    if (!src.keyed) {
      out.push(url);
      continue;
    }
    const entry = apiKeys[src.id];
    if (entry && entry.apiKey && entry.enabled !== false) {
      out.push(url.replace('{API_KEY}', entry.apiKey));
    }
  }
  return out;
}

// Every endpoint source (builtin + user, including removed ones) flattened
// for the settings UI. Each entry is tagged builtin/removed so the config
// view can render disabled builtins and editable user sources.
function getEndpointSourceList() {
  const { allSources, userSourceIds, removedSourceIds } = load();
  return Object.entries(allSources).map(([id, src]) => ({
    id,
    role: src.role,
    keyed: !!src.keyed,
    name: src.name || null,
    coverage: src.coverage || {},
    builtin: !userSourceIds.has(id),
    removed: removedSourceIds.has(id),
  }));
}

// Keyed endpoint sources of a role, as an { id: source } catalog — the
// provider list (Alchemy/Infura/DRPC) the wallet's RPC settings present.
function getKeyedSources(role) {
  const { endpointSources } = load();
  const out = {};
  for (const [id, src] of Object.entries(endpointSources)) {
    if (src.role === role && src.keyed) out[id] = { id, ...src };
  }
  return out;
}

// --- mutation layer ---------------------------------------------------
// Writes go to the user-config layer (network-config.json). Each mutation
// runs load() first so any pending legacy migration has already produced
// network-config.json, then reads that persisted file, edits it, and
// writes it back — invalidating the cache so the next query reflects it.

// The raw user layer. Absent or corrupt → the empty shape, and the
// mutation that follows writes a fresh file. Unlike the load path (which
// preserves a corrupt file for recovery), a deliberate write may replace
// it — a corrupt config was already not in effect.
function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(userDataPath('network-config.json'), 'utf-8'));
  } catch {
    return { networks: {}, endpointSources: {}, removedSources: [] };
  }
}

function writeUserConfig(config) {
  fs.writeFileSync(
    userDataPath('network-config.json'),
    JSON.stringify(config, null, 2),
    'utf-8'
  );
  invalidate();
}

// The custom-chains layer. Unlike network-config.json (per-chain policy
// overrides), custom-chains.json holds full chain definitions for chains
// the user added — load() merges it into the network set.
function readCustomChains() {
  return readJson(userDataPath('custom-chains.json'), {});
}

function writeCustomChains(customChains) {
  fs.writeFileSync(
    userDataPath('custom-chains.json'),
    JSON.stringify(customChains, null, 2),
    'utf-8'
  );
  invalidate();
}

// Merge a partial override into the user layer's networks[chainId].
// verification/quorum merge one level deep against any existing override;
// the rest of each block fills in from the builtin defaults at load time,
// so the persisted override stays minimal (just the user's deviations).
function updateNetwork(chainId, patch) {
  load();
  const config = readUserConfig();
  const networks = { ...(config.networks || {}) };
  const cid = String(chainId);
  const current = networks[cid] || {};
  networks[cid] = { ...current, ...patch };
  if (patch.verification) {
    networks[cid].verification = { ...current.verification, ...patch.verification };
  }
  if (patch.quorum) {
    networks[cid].quorum = { ...current.quorum, ...patch.quorum };
  }
  if (patch.access) {
    networks[cid].access = { ...current.access, ...patch.access };
  }
  writeUserConfig({ ...config, networks });
}

// Add or replace a user endpoint source. An explicit re-add also un-hides
// a builtin of the same id (the prior removal no longer applies).
function upsertEndpointSource(id, source) {
  const validationError = validateEndpointSourceForPersist(source);
  if (validationError) return { success: false, error: validationError };

  load();
  const config = readUserConfig();
  const endpointSources = { ...(config.endpointSources || {}), [id]: source };
  const removedSources = (config.removedSources || []).filter((x) => x !== id);
  writeUserConfig({ ...config, endpointSources, removedSources });
  return { success: true };
}

// Remove a source: a user-added one is deleted outright; a builtin is
// added to removedSources (it can't be deleted from endpoint-sources.json).
function removeEndpointSource(id) {
  load();
  const config = readUserConfig();
  const endpointSources = { ...(config.endpointSources || {}) };
  let removedSources = config.removedSources || [];
  if (endpointSources[id]) {
    delete endpointSources[id];
  } else if (!removedSources.includes(id)) {
    removedSources = [...removedSources, id];
  }
  writeUserConfig({ ...config, endpointSources, removedSources });
}

// Un-hide a builtin source that was previously removed.
function restoreEndpointSource(id) {
  load();
  const config = readUserConfig();
  const removedSources = (config.removedSources || []).filter((x) => x !== id);
  writeUserConfig({ ...config, removedSources });
}

// Reset one chain in a multi-chain endpoint source without discarding the
// source's other per-chain overrides. Builtin coverage is restored when it
// exists; a user-only chain entry is removed. If the complete override then
// equals the builtin source, drop it so future builtin updates can flow through.
function resetEndpointSourceCoverage(id, chainId) {
  load();
  const cid = String(chainId);
  const builtinSources = readJson(builtinPath('endpoint-sources.json'), {});
  const builtin = builtinSources[id] || null;
  const config = readUserConfig();
  const endpointSources = { ...(config.endpointSources || {}) };
  const current = endpointSources[id];

  if (current) {
    const coverage = { ...(current.coverage || {}) };
    if (builtin?.coverage?.[cid]) coverage[cid] = builtin.coverage[cid];
    else delete coverage[cid];

    if (!Object.keys(coverage).length) {
      delete endpointSources[id];
    } else {
      const next = { ...current, coverage };
      if (builtin && JSON.stringify(next) === JSON.stringify(builtin)) delete endpointSources[id];
      else endpointSources[id] = next;
    }
  }

  const removedSources = (config.removedSources || []).filter((sourceId) => sourceId !== id);
  writeUserConfig({ ...config, endpointSources, removedSources });
  return { success: true };
}

// Register a user-defined chain. rpcUrls are stored on the definition
// (load() surfaces them as the chain's public endpoints); the rest is
// persisted verbatim, chainId coerced to a number. verification defaults
// to `direct` at load time. Re-adding an existing custom chain replaces
// its definition. A chainId that collides with a builtin chain is
// rejected — builtin chains are customized via updateNetwork.
function addCustomChain(def, rpcUrls = []) {
  const { networks, customChainIds } = load();
  const chainId = Number(def?.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { success: false, error: 'A valid chain ID is required' };
  }
  const normalizedRpcUrls = normalizeRpcUrls(rpcUrls);
  if (normalizedRpcUrls.error) {
    return { success: false, error: normalizedRpcUrls.error };
  }
  const cid = String(chainId);
  if (networks[cid] && !customChainIds.has(cid)) {
    return { success: false, error: 'That chain ID is built in already' };
  }
  const customChains = readCustomChains();
  customChains[cid] = { ...def, chainId, rpcUrls: normalizedRpcUrls.urls };
  writeCustomChains(customChains);
  return { success: true, chainId: cid };
}

// Remove a user-defined chain. Its catalogue RPCs are part of the
// definition and go with it; this also drops the chain's network
// override and any hand-added endpoint source that covered only this
// chain (a multi-chain source is left intact).
function removeCustomChain(chainId) {
  const { networks, customChainIds } = load();
  const cid = String(chainId);
  if (networks[cid] && !customChainIds.has(cid)) {
    return { success: false, error: 'Cannot remove a built-in chain' };
  }
  const customChains = readCustomChains();
  if (!customChains[cid]) {
    return { success: false, error: 'Custom chain not found' };
  }
  delete customChains[cid];
  writeCustomChains(customChains);

  const config = readUserConfig();
  const networksOverride = { ...(config.networks || {}) };
  delete networksOverride[cid];
  const endpointSources = {};
  for (const [id, src] of Object.entries(config.endpointSources || {})) {
    const covers = Object.keys(src.coverage || {});
    if (covers.length === 1 && covers[0] === cid) continue;
    endpointSources[id] = src;
  }
  // Drop any disabled-state for this chain's catalogue RPCs — a stale
  // `catalog:<cid>:*` entry would otherwise suppress an endpoint if the
  // chain is re-added later.
  const removedSources = (config.removedSources || []).filter(
    (id) => !id.startsWith(`catalog:${cid}:`)
  );
  writeUserConfig({ ...config, networks: networksOverride, endpointSources, removedSources });
  return { success: true };
}

module.exports = {
  getNetwork,
  getAllNetworks,
  isChainAvailable,
  getAvailableChains,
  getEndpoints,
  getEndpointSources,
  getEndpointSourceList,
  getKeyedSources,
  updateNetwork,
  upsertEndpointSource,
  removeEndpointSource,
  restoreEndpointSource,
  resetEndpointSourceCoverage,
  addCustomChain,
  removeCustomChain,
  invalidate,
};
