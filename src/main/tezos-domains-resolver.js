const log = require('./logger');
const { ipcMain } = require('electron');
const crypto = require('crypto');
const { ethers } = require('ethers');
const IPC = require('../shared/ipc-channels');
const { blake2b } = require('../shared/blake2b');
const { isDwebNameHost } = require('../shared/origin-utils');
const { capCache } = require('./cache-utils');
const {
  runWithPrivateLogContext,
  redactForLog,
} = require('./private/private-log-context');
const { isPrivateWebContents } = require('./private/private-windows');

// PRIVATE MODE GUARD (name logging): same contract as the ENS resolver —
// the .tez name being resolved is the browsing history of the tab that
// asked, and log.warn/error land in the persistent main.log. See
// src/main/private/private-log-context.js.
const nameForLog = (name) => redactForLog(name);

const MAINNET_CHAIN_ID = 'NetXdQprcVkpaWU';
const PROXY_CONTRACT = 'KT1F7JKNqwaoLzRsMio1MQC7zv3jG9dHcDdJ';
const DEFAULT_RPC_ENDPOINTS = [
  'https://tezos-mainnet.octez.io',
  'https://rpc.tzkt.io/mainnet',
  'https://rpc.tzbeta.net',
];
const REQUEST_TIMEOUT_MS = 8_000;
const ANCHOR_DEPTH = 8;
// Providers whose reported head deviates from the median by more than this
// many blocks are excluded from the quorum: a provider reporting a tiny head
// level would otherwise drag the shared anchor to a block that predates the
// registry (failing every leg), and one reporting a far-future level is lying.
const MAX_HEAD_LAG_BLOCKS = 60;
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
// Positive result that only one provider could confirm. Deliberately short —
// distinct from NEGATIVE_TTL_MS so the two policies stay independently tunable.
const UNVERIFIED_TTL_MS = 30_000;
// Registry address and big-map IDs change essentially never; rediscovering
// them means re-downloading two full contract scripts per provider on every
// uncached name. Bounded so a registry migration is picked up within minutes.
const DISCOVERY_TTL_MS = 10 * 60_000;
const MAX_RPC_RESPONSE_BYTES = 5 * 1024 * 1024;
const SCRIPT_EXPR_PREFIX = Uint8Array.from([13, 44, 64, 27]);

const resultCache = new Map();
// endpoint → { discovery: { recordsId, expiryMapId, recordType }, expiresAt }.
// Kept per endpoint so one lying provider can only poison its own leg, never
// the big-map IDs the other legs read from.
const discoveryCache = new Map();
// name → in-flight resolution promise, so N concurrent subresource loads for
// the same uncached name share one quorum round instead of racing N of them.
const inflightResolutions = new Map();

function isTezosDomainName(value) {
  if (!value || typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  if (!lower.endsWith('.tez') || lower.length > 255) return false;
  if (/[\s/?#]/.test(lower)) return false;
  if ([...lower].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) return false;
  return lower.split('.').every((label) => label.length > 0);
}

function getRpcEndpoints() {
  const override = String(process.env.TEZOS_RPC || '').trim();
  const candidates = override ? [override, ...DEFAULT_RPC_ENDPOINTS] : DEFAULT_RPC_ENDPOINTS;
  const seen = new Set();
  const endpoints = [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      // Keep the slash-normalized form, not the raw candidate — request
      // paths are appended directly, so TEZOS_RPC=https://node/ would
      // otherwise produce https://node//chains/… .
      const normalized = parsed.toString().replace(/\/$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      endpoints.push(normalized);
    } catch {
      // Unparseable candidate — skip.
    }
  }
  return endpoints;
}

// Cancel an unread response body. Undici holds the connection out of its
// pool until the body is consumed or cancelled, and the early exits below
// (404 is the common path for unregistered names) never read it.
const discardBody = (response) => response?.body?.cancel?.()?.catch?.(() => {});

// Reads the body while enforcing MAX_RPC_RESPONSE_BYTES incrementally, so a
// hostile endpoint can't buffer an arbitrarily large body into memory before
// the size check runs. Falls back to text() when no stream is exposed.
async function readBodyWithLimit(response) {
  if (typeof response.body?.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RPC_RESPONSE_BYTES) {
      throw new Error('RPC response exceeded the size limit');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('RPC response exceeded the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function rpcRequest(endpoint, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${endpoint}${path}`, {
      method,
      signal: controller.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404) {
      await discardBody(response);
      return null;
    }
    if (!response.ok) {
      await discardBody(response);
      throw new Error(`RPC returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RPC_RESPONSE_BYTES) {
      await discardBody(response);
      throw new Error('RPC response exceeded the size limit');
    }
    return JSON.parse(await readBodyWithLimit(response));
  } finally {
    clearTimeout(timer);
  }
}

function concatBytes(...arrays) {
  const length = arrays.reduce((total, array) => total + array.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}

function u32be(value) {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function base58Check(payload) {
  const first = crypto.createHash('sha256').update(payload).digest();
  const checksum = crypto.createHash('sha256').update(first).digest().subarray(0, 4);
  return ethers.encodeBase58(concatBytes(payload, checksum));
}

function scriptExprHash(keyBytes) {
  const packed = concatBytes(Uint8Array.from([0x05, 0x0a]), u32be(keyBytes.length), keyBytes);
  const digest = blake2b(packed, 32);
  return base58Check(concatBytes(SCRIPT_EXPR_PREFIX, digest));
}

function annotationMatches(node, annotation) {
  return Array.isArray(node?.annots) && node.annots.includes(annotation);
}

function flattenPairLeaves(node) {
  if (node && typeof node === 'object' && String(node.prim || '').toLowerCase() === 'pair') {
    return (node.args || []).flatMap(flattenPairLeaves);
  }
  return [node];
}

function findAnnotatedValue(typeNode, valueNode, annotation) {
  if (!typeNode || valueNode === undefined || valueNode === null) return null;
  const typeLeaves = flattenPairLeaves(typeNode);
  const valueLeaves = flattenPairLeaves(valueNode);
  const index = typeLeaves.findIndex((node) => annotationMatches(node, annotation));
  if (index < 0 || index >= valueLeaves.length) return null;
  return { type: typeLeaves[index], value: valueLeaves[index] };
}

function storageTypeFromScript(script) {
  const storageDeclaration = script?.code?.find((entry) => entry?.prim === 'storage');
  return storageDeclaration?.args?.[0] || null;
}

function bytesFromHex(value) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error('Invalid Micheline bytes value');
  }
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

function decodeJsonBytes(value) {
  const text = Buffer.from(bytesFromHex(value)).toString('utf8');
  return JSON.parse(text);
}

function mapEntries(value) {
  if (!Array.isArray(value)) return new Map();
  return new Map(
    value
      .filter((entry) => entry?.prim === 'Elt' && entry.args?.[0]?.string !== undefined)
      .map((entry) => [entry.args[0].string, entry.args[1]?.bytes])
  );
}

function parsePublishedUri(rawUri, { redirect = false } = {}) {
  if (typeof rawUri !== 'string' || rawUri.length > 8_192) {
    return { type: 'unsupported', reason: 'invalid website URI', system: 'tezos' };
  }

  let parsed;
  try {
    parsed = new URL(rawUri);
  } catch {
    return { type: 'unsupported', reason: 'invalid website URI', system: 'tezos' };
  }

  const protocol = parsed.protocol.slice(0, -1).toLowerCase();
  if (redirect && protocol !== 'http' && protocol !== 'https') {
    return { type: 'unsupported', reason: 'redirect URL must use HTTP(S)', system: 'tezos' };
  }

  if (protocol === 'http' || protocol === 'https') {
    if (!parsed.hostname || parsed.username || parsed.password) {
      return { type: 'unsupported', reason: 'invalid HTTP(S) website URI', system: 'tezos' };
    }
    return { type: 'ok', protocol, uri: parsed.toString(), redirect, system: 'tezos' };
  }

  if (!redirect && (protocol === 'ipfs' || protocol === 'ipns')) {
    if (!parsed.hostname || parsed.username || parsed.password || parsed.port) {
      return { type: 'unsupported', reason: `invalid ${protocol.toUpperCase()} website URI`, system: 'tezos' };
    }
    // A website record must point at content (CID / IPNS key / DNSLink host),
    // never at another dweb *name*. `ipns://self.tez` would be handed back to
    // the renderer, re-parsed as a name, and resolved again — an unbounded
    // resolve→navigate loop the domain owner controls. Normalize before the
    // check: a trailing dot (`self.tez.`) or percent-encoded dot
    // (`self%2Etez`) is the same name to a resolver but slips the pattern.
    let hostForNameCheck = parsed.hostname.replace(/\.+$/, '');
    try {
      hostForNameCheck = decodeURIComponent(hostForNameCheck);
    } catch {
      // Malformed escape — keep the raw form for the check.
    }
    if (isDwebNameHost(hostForNameCheck)) {
      return {
        type: 'unsupported',
        reason: `${protocol.toUpperCase()} website URI must reference content, not a name`,
        system: 'tezos',
      };
    }
    const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return {
      type: 'ok',
      protocol,
      uri: parsed.toString(),
      decoded: parsed.hostname,
      basePath,
      redirect: false,
      system: 'tezos',
    };
  }

  return { type: 'unsupported', reason: `unsupported website protocol: ${protocol}`, system: 'tezos' };
}

async function fetchNormalizedScript(endpoint, blockHash, contract, fetchImpl) {
  return rpcRequest(
    endpoint,
    `/chains/main/blocks/${encodeURIComponent(blockHash)}/context/contracts/${contract}/script/normalized`,
    { method: 'POST', body: { unparsing_mode: 'Readable' }, fetchImpl }
  );
}

async function discoverRegistry(endpoint, blockHash, fetchImpl) {
  const proxyScript = await fetchNormalizedScript(endpoint, blockHash, PROXY_CONTRACT, fetchImpl);
  const proxyContract = findAnnotatedValue(
    storageTypeFromScript(proxyScript),
    proxyScript?.storage,
    '%contract'
  )?.value?.string;
  if (!/^KT1[1-9A-HJ-NP-Za-km-z]{33}$/.test(proxyContract || '')) {
    throw new Error('Tezos Domains proxy returned an invalid registry contract');
  }

  const registryScript = await fetchNormalizedScript(endpoint, blockHash, proxyContract, fetchImpl);
  const registryStorageType = storageTypeFromScript(registryScript);
  const records = findAnnotatedValue(registryStorageType, registryScript?.storage, '%records');
  const expiryMap = findAnnotatedValue(registryStorageType, registryScript?.storage, '%expiry_map');
  const recordsId = records?.value?.int;
  const expiryMapId = expiryMap?.value?.int;
  if (!/^\d+$/.test(recordsId || '') || !/^\d+$/.test(expiryMapId || '')) {
    throw new Error('Tezos Domains registry storage is missing annotated big maps');
  }
  return { recordsId, expiryMapId, recordType: records.type?.args?.[1] || null };
}

async function resolveAtBlock(endpoint, blockHash, name, fetchImpl = fetch) {
  const cached = discoveryCache.get(endpoint);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      return await lookupRecord(endpoint, blockHash, name, cached.discovery, fetchImpl);
    } catch {
      // The cached IDs may be stale (registry migration) or the failure
      // transient — rediscover once below before failing the leg.
      discoveryCache.delete(endpoint);
    }
  }
  const discovery = await discoverRegistry(endpoint, blockHash, fetchImpl);
  discoveryCache.set(endpoint, { discovery, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return lookupRecord(endpoint, blockHash, name, discovery, fetchImpl);
}

async function lookupRecord(endpoint, blockHash, name, discovery, fetchImpl) {
  const { recordsId, expiryMapId, recordType } = discovery;
  const nameBytes = new TextEncoder().encode(name);
  const record = await rpcRequest(
    endpoint,
    `/chains/main/blocks/${encodeURIComponent(blockHash)}/context/big_maps/${recordsId}/${scriptExprHash(nameBytes)}`,
    { fetchImpl }
  );
  if (!record) return { type: 'not_found', reason: 'domain record not found', system: 'tezos' };

  const dataValue = findAnnotatedValue(recordType, record, '%data')?.value;
  const expiryKeyValue = findAnnotatedValue(recordType, record, '%expiry_key')?.value;
  const recordsMap = mapEntries(dataValue);

  let expiry = null;
  const expiryKeyHex = expiryKeyValue?.prim === 'Some' ? expiryKeyValue.args?.[0]?.bytes : null;
  if (expiryKeyHex) {
    const expiryRecord = await rpcRequest(
      endpoint,
      `/chains/main/blocks/${encodeURIComponent(blockHash)}/context/big_maps/${expiryMapId}/${scriptExprHash(bytesFromHex(expiryKeyHex))}`,
      { fetchImpl }
    );
    if (typeof expiryRecord?.string !== 'string') {
      throw new Error('Tezos Domains expiry record is missing');
    }
    expiry = expiryRecord.string;
    const expiresAt = expiry ? Date.parse(expiry) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { type: 'not_found', reason: 'domain record expired', expiry, system: 'tezos' };
    }
  }

  let redirectUrl;
  let contentUrl;
  let ttl;
  try {
    if (recordsMap.has('web:redirect_url')) {
      redirectUrl = decodeJsonBytes(recordsMap.get('web:redirect_url'));
    }
    if (recordsMap.has('web:content_url')) {
      contentUrl = decodeJsonBytes(recordsMap.get('web:content_url'));
    }
    if (recordsMap.has('td:ttl')) ttl = decodeJsonBytes(recordsMap.get('td:ttl'));
  } catch (err) {
    return { type: 'unsupported', reason: `invalid Tezos Domains metadata: ${err.message}`, system: 'tezos' };
  }

  if (redirectUrl !== undefined) {
    return { ...parsePublishedUri(redirectUrl, { redirect: true }), expiry, ttl };
  }
  if (contentUrl !== undefined) {
    return { ...parsePublishedUri(contentUrl), expiry, ttl };
  }
  return { type: 'not_found', reason: 'domain has no website record', expiry, ttl, system: 'tezos' };
}

async function fetchHead(endpoint, fetchImpl = fetch) {
  const [chainId, header] = await Promise.all([
    rpcRequest(endpoint, '/chains/main/chain_id', { fetchImpl }),
    rpcRequest(endpoint, '/chains/main/blocks/head/header', { fetchImpl }),
  ]);
  if (chainId !== MAINNET_CHAIN_ID) throw new Error(`unexpected Tezos chain: ${chainId}`);
  const level = Number(header?.level);
  if (!Number.isSafeInteger(level) || level <= ANCHOR_DEPTH) throw new Error('invalid Tezos head level');
  return { endpoint, level };
}

async function fetchAnchor(endpoint, level, fetchImpl = fetch) {
  const hash = await rpcRequest(endpoint, `/chains/main/blocks/${level}/hash`, { fetchImpl });
  if (typeof hash !== 'string' || !hash.startsWith('B')) throw new Error('invalid Tezos block hash');
  return { endpoint, level, hash };
}

function hostOf(url) {
  try { return new URL(url).host; }
  catch { return url; }
}

// Build one entry of the `groups` payload for a conflict outcome, in the
// shape pages/scripts/ens-conflict.js renders: `urls` (provider hosts) plus
// either a human-readable `value` or a `reason` for a negative answer. The
// ENS side emits raw contenthash bytes as `resolvedData`; a Tezos website
// record is already a URI, so it goes in `value` verbatim (length-capped so
// a hostile 8KB record can't bloat the interstitial URL).
function buildConflictGroup(group) {
  const result = group[0].result;
  const urls = group.map((leg) => hostOf(leg.endpoint));
  if (result.type !== 'ok' || !result.uri) {
    return { resolvedData: null, reason: result.reason || result.type, urls };
  }
  const uri = String(result.uri);
  return { value: uri.length > 300 ? `${uri.slice(0, 300)}…` : uri, urls };
}

// Providers cannot agree on which chain state to read. Rendered by the same
// interstitial as a record conflict — a hard block — because with no
// trustworthy anchor every answer below it is unverifiable, not merely
// unconfirmed.
function headConflict(allHeads, retained) {
  const byLevel = new Map();
  for (const head of allHeads) {
    if (!byLevel.has(head.level)) byLevel.set(head.level, []);
    byLevel.get(head.level).push(hostOf(head.endpoint));
  }
  return {
    type: 'conflict',
    reason: 'Tezos RPC providers disagree about the chain head',
    system: 'tezos',
    groups: [...byLevel.entries()].map(([level, urls]) => ({ value: `chain head #${level}`, urls })),
    trust: {
      level: 'conflict',
      system: 'tezos',
      block: null,
      k: allHeads.length,
      m: retained,
    },
  };
}

// Providers agreed closely enough on the head but returned different hashes
// for the anchor block itself.
function anchorConflict(anchorGroups, retained) {
  return {
    type: 'conflict',
    reason: 'Tezos RPC providers returned conflicting anchor blocks',
    system: 'tezos',
    groups: anchorGroups.map((group) => ({
      value: `block #${group[0].level} ${group[0].hash.slice(0, 10)}…${group[0].hash.slice(-4)}`,
      urls: group.map((anchor) => hostOf(anchor.endpoint)),
    })),
    trust: {
      level: 'conflict',
      system: 'tezos',
      block: null,
      k: anchorGroups.reduce((total, group) => total + group.length, 0),
      m: retained,
    },
  };
}

function semanticResultKey(result) {
  return JSON.stringify({
    type: result.type,
    reason: result.reason || null,
    protocol: result.protocol || null,
    uri: result.uri || null,
    decoded: result.decoded || null,
    basePath: result.basePath || null,
    redirect: Boolean(result.redirect),
    expiry: result.expiry || null,
    // ttl drives cacheDuration for the winning group — leaving it out of
    // the key would let one member's lie about td:ttl steer the cache when
    // it happens to sort first within the group.
    ttl: result.ttl ?? null,
  });
}

function cacheDuration(result) {
  if (result.type !== 'ok') return NEGATIVE_TTL_MS;
  // A result that only one provider could confirm should not be pinned for
  // the full record TTL — short-cache it so trust recovers as soon as the
  // other providers come back.
  if (result.trust?.level !== 'verified') return UNVERIFIED_TTL_MS;
  const recordTtl = Number(result.ttl);
  let duration = Number.isFinite(recordTtl) && recordTtl > 0 ? recordTtl * 1_000 : DEFAULT_TTL_MS;
  duration = Math.min(duration, MAX_TTL_MS);
  const expiryMs = Date.parse(result.expiry || '');
  if (Number.isFinite(expiryMs)) duration = Math.min(duration, Math.max(0, expiryMs - Date.now()));
  return Math.max(1_000, duration);
}

async function resolveTezosDomain(name, { fetchImpl = fetch, endpoints = getRpcEndpoints() } = {}) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!isTezosDomainName(normalized)) {
    return { type: 'not_found', reason: 'invalid .tez domain', system: 'tezos' };
  }

  const cached = resultCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  resultCache.delete(normalized);

  const inflight = inflightResolutions.get(normalized);
  if (inflight) return inflight;
  const resolution = resolveTezosDomainUncached(normalized, fetchImpl, endpoints).finally(() =>
    inflightResolutions.delete(normalized)
  );
  inflightResolutions.set(normalized, resolution);
  return resolution;
}

async function resolveTezosDomainUncached(normalized, fetchImpl, endpoints) {
  const headSettled = await Promise.allSettled(
    endpoints.slice(0, 3).map((endpoint) => fetchHead(endpoint, fetchImpl))
  );
  const allHeads = headSettled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  if (allHeads.length === 0) {
    return { type: 'error', reason: 'all Tezos RPC providers failed', system: 'tezos' };
  }
  // Median-referenced outlier rejection: with the default three providers this
  // tolerates one head that is wildly behind (stale or lying low — which would
  // drag the anchor to a block predating the registry) or wildly ahead (lying
  // high) without letting it distort the shared anchor.
  const sortedLevels = allHeads.map((head) => head.level).sort((a, b) => a - b);
  const referenceLevel = sortedLevels[Math.floor((sortedLevels.length - 1) / 2)];
  const heads = [];
  for (const head of allHeads) {
    if (Math.abs(head.level - referenceLevel) <= MAX_HEAD_LAG_BLOCKS) {
      heads.push(head);
    } else {
      log.warn(
        `[tezos-domains] excluding ${head.endpoint}: head level ${head.level} deviates from median ${referenceLevel}`
      );
    }
  }
  // A median only survives a *minority* of liars. When the retained set is not
  // a strict majority of the responders the reference level may itself be the
  // liar's — always the case when exactly two reachable providers disagree,
  // where the median of two is just the lower one, so a provider claiming a
  // head 600 blocks behind ejects the honest one and inherits the quorum as a
  // merely "unverified" solo answer. Keeping both instead would let the low
  // head drag the shared anchor back in time. Neither side is trustworthy, so
  // refuse rather than pick one.
  if (heads.length * 2 <= allHeads.length) {
    return headConflict(allHeads, heads.length);
  }
  const anchorLevel = Math.min(...heads.map((head) => head.level)) - ANCHOR_DEPTH;
  const anchorSettled = await Promise.allSettled(
    heads.map((head) => fetchAnchor(head.endpoint, anchorLevel, fetchImpl))
  );
  const anchors = anchorSettled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  if (anchors.length === 0) {
    return { type: 'error', reason: 'Tezos RPC providers could not anchor a block', system: 'tezos' };
  }

  const anchorGroups = new Map();
  for (const anchor of anchors) {
    const key = `${anchor.level}:${anchor.hash}`;
    if (!anchorGroups.has(key)) anchorGroups.set(key, []);
    anchorGroups.get(key).push(anchor);
  }
  const bestAnchors = [...anchorGroups.values()].sort((a, b) => b.length - a.length)[0];
  // Same rule one step down: the block hash at a settled depth is not
  // negotiable, so a provider serving a different hash is forking or lying.
  // Taking the largest group when it isn't a strict majority would let a tie
  // (two providers, one honest) be broken by iteration order, again handing an
  // attacker the whole quorum with only an "unverified" mark.
  if (bestAnchors.length * 2 <= anchors.length) {
    return anchorConflict([...anchorGroups.values()], bestAnchors.length);
  }
  const legs = await Promise.allSettled(
    bestAnchors.map(async (anchor) => ({
      endpoint: anchor.endpoint,
      result: await resolveAtBlock(anchor.endpoint, anchor.hash, normalized, fetchImpl),
    }))
  );
  const successful = legs.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  if (successful.length === 0) {
    return { type: 'error', reason: 'Tezos Domains registry lookup failed', system: 'tezos' };
  }

  const resultGroups = new Map();
  for (const leg of successful) {
    const key = semanticResultKey(leg.result);
    if (!resultGroups.has(key)) resultGroups.set(key, []);
    resultGroups.get(key).push(leg);
  }
  const groups = [...resultGroups.values()].sort((a, b) => b.length - a.length);
  const winner = groups[0];
  const block = { number: bestAnchors[0].level, hash: bestAnchors[0].hash };

  // Strict majority again: `winner.length < 2` alone would call an even split
  // (two answers, two providers each) a verified win for whichever group the
  // sort happened to put first.
  if (groups.length > 1 && winner.length * 2 <= successful.length) {
    return {
      type: 'conflict',
      reason: 'Tezos RPC providers returned conflicting results',
      system: 'tezos',
      groups: groups.map((group) => buildConflictGroup(group)),
      trust: { level: 'conflict', system: 'tezos', block, k: successful.length, m: winner.length },
    };
  }

  const trustLevel = winner.length >= 2 ? 'verified' : 'unverified';
  if (winner.length < successful.length) {
    const dissenting = successful
      .filter((leg) => !winner.includes(leg))
      .map((leg) => leg.endpoint)
      .join(', ');
    log.warn(
      `[tezos-domains] ${dissenting} disagreed with the majority for ${nameForLog(normalized)}`
    );
  }
  const result = {
    ...winner[0].result,
    trust: {
      level: trustLevel,
      system: 'tezos',
      block,
      k: successful.length,
      m: winner.length,
      agreed: winner.map((leg) => leg.endpoint),
    },
  };
  resultCache.set(normalized, { result, expiresAt: Date.now() + cacheDuration(result) });
  capCache(resultCache);
  return result;
}

function invalidateTezosDomain(name) {
  if (name) {
    resultCache.delete(String(name).trim().toLowerCase());
    return;
  }
  resultCache.clear();
  discoveryCache.clear();
}

function registerTezosDomainsIpc() {
  ipcMain.handle(IPC.TEZOS_DOMAINS_RESOLVE, async (event, { name } = {}) => {
    return runWithPrivateLogContext(isPrivateWebContents(event?.sender), async () => {
      try {
        return await resolveTezosDomain(name);
      } catch (err) {
        log.error(`[tezos-domains] Resolution failed for ${nameForLog(name)}: ${err.message}`);
        return { type: 'error', reason: err.message, system: 'tezos' };
      }
    });
  });
  ipcMain.handle(IPC.TEZOS_DOMAINS_INVALIDATE, (_event, { name } = {}) => {
    invalidateTezosDomain(name);
    return { ok: true };
  });
}

module.exports = {
  invalidateTezosDomain,
  isTezosDomainName,
  parsePublishedUri,
  registerTezosDomainsIpc,
  resolveAtBlock,
  resolveTezosDomain,
  scriptExprHash,
  _test: { findAnnotatedValue, semanticResultKey },
};
