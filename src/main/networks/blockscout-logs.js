// Blockscout's Gnosis log index as a second, independent full-history source
// for the bundled Ant node's xBZZ Transfer scans (#529). The router pairs its
// answer with one RPC endpoint's (chain-data-router's requestLogIndex): only
// when the two agree is the scan answered, so this module never decides a
// scan on its own. It only reads, pages and maps Blockscout's answer.
//
// Why Blockscout: the keyless RPCs that serve a wallet's whole xBZZ history in
// one eth_getLogs (rpc.gnosischain.com, gateway.fm, swiftnodes) all run on the
// same Tenderly backend, so two of them agreeing is no independent check, and
// the independent ones stop far short of it (measured 2026-10-05: publicnode
// at 50,000 blocks, dRPC's free plan at 10,000).
// Blockscout indexes the chain from its own archive node.
//
// API: Blockscout's API v2 token-transfer list for one address,
// `/api/v2/addresses/{address}/token-transfers?type=ERC-20&filter=from|to&token=...`.
// It used to be the Etherscan-compatible `module=logs&action=getLogs`, but by
// 2026-10-07 that answered "No logs found" to any filter on the sender or
// recipient topic, even over blocks whose Transfer it lists unfiltered (#596),
// so every pair disagreed and Ant read its scan window by window again.
// Measured against gnosis.blockscout.com on 2026-10-07 (it redirects to
// gnosisscan.io, also Blockscout):
// - a transfer carries its block number and hash, transaction hash, log index
//   (the block-wide index eth_getLogs reports), token, sender, recipient and
//   value, but not the transaction index (so the pair's answer leaves the
//   RPC's out: agreedRpcLogs);
// - transfers come newest first, by (block, log index), 50 to a page.
//   `next_page_params` is null on the last page; a request carrying
//   `block_number` and `index` lists only the transfers before that position.
//   There is no block-range filter, so a read starts at
//   `block_number=toBlock+1&index=0` and stops below fromBlock
//   (fetchBlockscoutTransferLogs);
// - an address with no transfers, or one Blockscout has never seen, is
//   `{"items":[],"next_page_params":null}`;
// - the error texts below avoid Ant's range-limit needles ("limit", "more
//   than", "too large", ...): a Blockscout failure says nothing about Ant's
//   query and must never make it halve its window;
// - keyless use is rate limited (x-ratelimit-limit: 180 for this API, with
//   x-ratelimit-reset in milliseconds), answered with HTTP 429.

const dns = require('node:dns');
const net = require('node:net');

const LOG_INDEX_URLS = Object.freeze({ 100: 'https://gnosis.blockscout.com/api' });
// The token whose Transfer logs Ant scans: xBZZ on Gnosis.
const LOG_INDEX_TOKENS = Object.freeze({ 100: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da' });
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// A wallet with more xBZZ transfers in the span than this many pages hold
// (50 each) is read the slow way: the pages are read one after another, and a
// few dozen of them already fill the scan budget.
const BLOCKSCOUT_MAX_PAGES = 40;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// How long a rate-limited Blockscout is left alone when it names no reset,
// and the bounds on one it names.
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MIN_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

class BlockscoutError extends Error {
  constructor(message, { coolMs = MIN_COOLDOWN_MS } = {}) {
    super(message);
    this.name = 'BlockscoutError';
    this.coolMs = coolMs;
  }
}

function blockNumberOf(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  const number = Number.parseInt(value, 16);
  return Number.isSafeInteger(number) ? number : null;
}

const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/i;

// The Transfer scan an eth_getLogs filter asks for, when it is one Blockscout
// can answer for `chainId`: the chain's token address (one string), topics
// [Transfer, sender] / [Transfer, null, recipient] / [Transfer, sender,
// recipient] with single address topics, and a numeric block range. That is
// exactly what Ant's wallet scan sends ([Transfer, node wallet]). Anything
// else is null and stays with the RPC quorum.
function logIndexFilter(chainId, params) {
  const token = LOG_INDEX_TOKENS[Number(chainId)];
  if (!token || !LOG_INDEX_URLS[Number(chainId)]) return null;
  if (!Array.isArray(params) || params.length !== 1) return null;
  const filter = params[0];
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  if (
    Object.keys(filter).some((key) => !['address', 'fromBlock', 'toBlock', 'topics'].includes(key))
  ) {
    return null;
  }
  if (typeof filter.address !== 'string' || filter.address.toLowerCase() !== token) return null;
  const { topics } = filter;
  if (!Array.isArray(topics) || topics.length < 2 || topics.length > 3) return null;
  if (typeof topics[0] !== 'string' || topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC)
    return null;
  const addressTopic = (topic) => {
    if (topic == null) return null;
    return typeof topic === 'string' && ADDRESS_TOPIC.test(topic) ? topic.toLowerCase() : undefined;
  };
  const sender = addressTopic(topics[1]);
  const recipient = addressTopic(topics[2]);
  if (sender === undefined || recipient === undefined || (!sender && !recipient)) return null;
  const fromBlock = blockNumberOf(filter.fromBlock);
  const toBlock = blockNumberOf(filter.toBlock);
  if (fromBlock === null || toBlock === null || toBlock < fromBlock) return null;
  return { chainId: Number(chainId), token, sender, recipient, fromBlock, toBlock };
}

const hexData = (value) =>
  typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) ? value.toLowerCase() : null;
const hash32 = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
const quantity = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)
    ? `0x${BigInt(value).toString(16)}`
    : null;

// An eth_getLogs entry's fields in one canonical spelling (lower-case hex,
// quantities without leading zeros, no trailing null topics), or null for a
// malformed entry.
function canonicalLog(entry) {
  if (!entry || typeof entry !== 'object' || entry.removed === true) return null;
  const address =
    typeof entry.address === 'string' && /^0x[0-9a-f]{40}$/i.test(entry.address)
      ? entry.address.toLowerCase()
      : null;
  if (!Array.isArray(entry.topics)) return null;
  const topics = entry.topics.slice();
  while (topics.length && topics[topics.length - 1] == null) topics.pop();
  const canonicalTopics = topics.map(hash32);
  const log = {
    address,
    topics: canonicalTopics,
    data: hexData(entry.data),
    blockNumber: quantity(entry.blockNumber),
    transactionHash: hash32(entry.transactionHash),
    transactionIndex: quantity(entry.transactionIndex),
    logIndex: quantity(entry.logIndex),
  };
  if (Object.values(log).some((value) => value === null) || canonicalTopics.includes(null)) {
    return null;
  }
  return log;
}

// A Transfer's value: exactly one 32-byte word, the only encoding Ant decodes.
const VALUE_WORD = /^0x[0-9a-f]{64}$/i;

// Whether one of an RPC's eth_getLogs entries has the exact shape Ant reads,
// as the RPC sent it: these raw entries (cut to the compared fields,
// agreedRpcLogs), not a canonical form of them, are what Ant gets once the
// pair agrees. A 32-byte blockHash, a value that is
// exactly one 32-byte word, and topics that are all 32-byte hashes (no null
// padding), the address ones (topics[1], topics[2]) zero-padded addresses;
// canonicalLog checks the rest (a 32-byte transactionHash, not removed, the
// address and quantities).
function rpcTransferLogWellFormed(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!hash32(entry.blockHash)) return false;
  if (typeof entry.data !== 'string' || !VALUE_WORD.test(entry.data)) return false;
  const { topics } = entry;
  if (!Array.isArray(topics) || !topics.every((topic) => hash32(topic) !== null)) return false;
  if (topics.slice(1, 3).some((topic) => !ADDRESS_TOPIC.test(topic))) return false;
  return canonicalLog(entry) !== null;
}

// Whether an RPC's eth_getLogs answer is a list of well-formed entries.
function rpcTransferLogsWellFormed(result) {
  return Array.isArray(result) && result.every(rpcTransferLogWellFormed);
}

const addressOf = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const indexOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const UINT256_MAX = (1n << 256n) - 1n;

// One of an RPC's eth_getLogs entries as a transfer, the form both providers'
// answers are compared in: lower-case hex, block number and log index as
// numbers, sender and recipient as the zero-padded topics eth_getLogs
// carries, the value in decimal. Null unless the entry is a well-formed
// (rpcTransferLogWellFormed) Transfer log with a sender and a recipient topic.
function rpcTransfer(entry) {
  if (!rpcTransferLogWellFormed(entry)) return null;
  const log = canonicalLog(entry);
  if (log.topics.length !== 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC) return null;
  return {
    address: log.address,
    blockNumber: blockNumberOf(log.blockNumber),
    blockHash: hash32(entry.blockHash),
    transactionHash: log.transactionHash,
    logIndex: blockNumberOf(log.logIndex),
    from: log.topics[1],
    to: log.topics[2],
    value: BigInt(log.data).toString(),
  };
}

// One item of Blockscout's token-transfer list as a transfer (see
// rpcTransfer), or null for a malformed one. Every field comes from
// Blockscout's own answer.
function blockscoutTransfer(item) {
  if (!item || typeof item !== 'object' || item.token_type !== 'ERC-20') return null;
  const topicOf = (party) => {
    const address = addressOf(party?.hash);
    return address ? `0x${'0'.repeat(24)}${address.slice(2)}` : null;
  };
  const rawValue = item.total?.value;
  const value =
    typeof rawValue === 'string' && /^\d{1,78}$/.test(rawValue) && BigInt(rawValue) <= UINT256_MAX
      ? BigInt(rawValue).toString()
      : null;
  const transfer = {
    address: addressOf(item.token?.address_hash),
    blockNumber: indexOf(item.block_number),
    blockHash: hash32(item.block_hash),
    transactionHash: hash32(item.transaction_hash),
    logIndex: indexOf(item.log_index),
    from: topicOf(item.from),
    to: topicOf(item.to),
    value,
  };
  return Object.values(transfer).includes(null) ? null : transfer;
}

// Whether an RPC's eth_getLogs answer and Blockscout's transfers list the
// same transfers, identical in every field both report (rpcTransfer). An RPC
// entry that is not in the exact shape Ant reads (rpcTransferLogWellFormed)
// never agrees.
function logsAgree(indexed, rpcResult) {
  if (!Array.isArray(indexed) || !rpcTransferLogsWellFormed(rpcResult)) return false;
  if (indexed.length !== rpcResult.length) return false;
  const key = (transfer) => `${transfer.blockNumber}:${transfer.logIndex}`;
  const expected = new Map();
  for (const transfer of indexed) {
    if (!transfer || typeof transfer !== 'object' || expected.has(key(transfer))) return false;
    expected.set(key(transfer), JSON.stringify(transfer));
  }
  for (const entry of rpcResult) {
    const transfer = rpcTransfer(entry);
    if (!transfer || expected.get(key(transfer)) !== JSON.stringify(transfer)) return false;
    expected.delete(key(transfer));
  }
  return expected.size === 0;
}

// The fields of an RPC's eth_getLogs entry that logsAgree compares with
// Blockscout's transfer, plus `removed` (always false once well formed).
const AGREED_LOG_FIELDS = Object.freeze([
  'address',
  'topics',
  'data',
  'blockNumber',
  'blockHash',
  'transactionHash',
  'logIndex',
  'removed',
]);

// An RPC's eth_getLogs answer that agreed with Blockscout (logsAgree), cut to
// the fields the two compared, in the RPC's own spelling: what the pair
// verified and nothing else. Blockscout does not report the transaction
// index, so the RPC's is left out rather than delivered unchecked inside an
// answer labelled verified; Ant's wallet scan does not read it (it reads the
// address, topics, data, transaction hash and block number). Any other field
// an RPC adds is left out for the same reason.
function agreedRpcLogs(rpcResult) {
  return rpcResult.map((entry) => {
    const log = {};
    for (const field of AGREED_LOG_FIELDS) {
      if (field === 'removed') log.removed = false;
      else log[field] = field === 'topics' ? entry.topics.slice() : entry[field];
    }
    return log;
  });
}

function cooldownFrom(headers) {
  const resetMs = Number(headers?.get?.('x-ratelimit-reset'));
  const retryAfterS = Number(headers?.get?.('retry-after'));
  const named =
    Number.isFinite(resetMs) && resetMs > 0
      ? resetMs
      : Number.isFinite(retryAfterS) && retryAfterS > 0
        ? retryAfterS * 1000
        : RATE_LIMIT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, named));
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

// One page, within `deadline` (a Date.now() instant shared by every page and
// redirect hop of a read, so the read as a whole stays inside `timeoutMs`).
async function fetchPage(
  url,
  { signal, deadline, timeoutMs, fetchImpl = fetch, lookup = dns.promises.lookup }
) {
  const leftMs = deadline - Date.now();
  if (!(leftMs > 0)) throw new BlockscoutError(`no answer within ${timeoutMs}ms`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, leftMs);
  try {
    let response;
    let current = url;
    const origin = new URL(url).origin;
    for (let hop = 0; ; hop += 1) {
      try {
        response = await fetchImpl(current, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        signal?.throwIfAborted?.();
        throw new BlockscoutError(timedOut ? `no answer within ${timeoutMs}ms` : 'unreachable');
      }
      // A browser-style fetch hides a manual redirect's target; refuse it.
      if (response.type === 'opaqueredirect') {
        throw new BlockscoutError('redirected to a hidden location');
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;
      response.body?.cancel?.().catch?.(() => {});
      const location = response.headers?.get?.('location');
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
        let local;
        try {
          local = await resolvesToLocalAddress(next.hostname, {
            lookup,
            signal: controller.signal,
          });
        } catch {
          signal?.throwIfAborted?.();
          throw new BlockscoutError(
            timedOut
              ? `no answer within ${timeoutMs}ms`
              : 'redirected to a host that does not resolve'
          );
        }
        if (local) throw new BlockscoutError('redirected to a local host');
      }
      if (hop + 1 > MAX_REDIRECTS) throw new BlockscoutError('redirected too often');
      current = next.toString();
    }
    if (response.status === 429) {
      response.body?.cancel?.().catch?.(() => {});
      throw new BlockscoutError('throttled (HTTP 429)', { coolMs: cooldownFrom(response.headers) });
    }
    if (!response.ok) {
      response.body?.cancel?.().catch?.(() => {});
      throw new BlockscoutError(`HTTP ${response.status}`);
    }
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      response.body?.cancel?.().catch?.(() => {});
      throw new BlockscoutError('answer over 8 MiB');
    }
    let text;
    try {
      text = await response.text();
    } catch {
      signal?.throwIfAborted?.();
      throw new BlockscoutError(timedOut ? `no answer within ${timeoutMs}ms` : 'answer cut off');
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new BlockscoutError('answer over 8 MiB');
    try {
      return JSON.parse(text);
    } catch {
      throw new BlockscoutError('answer is not JSON');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

// The page of `filter`'s transfers before `cursor` (a block and log index):
// by sender when the filter names one, else by recipient.
function pageUrl(filter, cursor) {
  const party = filter.sender || filter.recipient;
  const url = new URL(
    `${LOG_INDEX_URLS[filter.chainId]}/v2/addresses/0x${party.slice(26)}/token-transfers`
  );
  url.search = new URLSearchParams({
    type: 'ERC-20',
    filter: filter.sender ? 'from' : 'to',
    token: filter.token,
    block_number: String(cursor.block),
    index: String(cursor.logIndex),
  }).toString();
  return url.toString();
}

// Every transfer `filter` matches in [filter.fromBlock, toBlock] (as
// blockscoutTransfer gives them), oldest first. Blockscout lists the queried
// address's transfers newest first, so the read starts right after toBlock
// and pages back until it passes fromBlock or the list ends. A filter naming
// both a sender and a recipient is read by sender and the recipient is
// matched here. A transfer of another token or party, one at or after the
// position it was asked to list before, a malformed one, more pages than
// BLOCKSCOUT_MAX_PAGES, or any failure throws BlockscoutError; nothing partial
// is returned. `timeoutMs` bounds the whole read, every page and redirect hop
// together, not each page.
async function fetchBlockscoutTransferLogs(
  filter,
  toBlock,
  { signal, timeoutMs, fetchImpl, lookup } = {}
) {
  if (!LOG_INDEX_URLS[filter?.chainId]) throw new BlockscoutError('no log index for this chain');
  const deadline = Date.now() + timeoutMs;
  const [party, side] = filter.sender ? [filter.sender, 'from'] : [filter.recipient, 'to'];
  const transfers = [];
  let cursor = { block: toBlock + 1, logIndex: 0 };
  for (let page = 0; page < BLOCKSCOUT_MAX_PAGES; page += 1) {
    const body = await fetchPage(pageUrl(filter, cursor), {
      signal,
      deadline,
      timeoutMs,
      fetchImpl,
      lookup,
    });
    const next = body?.next_page_params;
    if (
      !Array.isArray(body?.items) ||
      next === undefined ||
      (next !== null && (typeof next !== 'object' || Array.isArray(next)))
    ) {
      const message = typeof body?.message === 'string' ? body.message : '';
      if (/too many requests|rate limit/i.test(message)) {
        throw new BlockscoutError('throttled', { coolMs: RATE_LIMIT_COOLDOWN_MS });
      }
      throw new BlockscoutError('refused the query');
    }
    for (const item of body.items) {
      const transfer = blockscoutTransfer(item);
      if (!transfer || transfer.address !== filter.token || transfer[side] !== party) {
        throw new BlockscoutError('returned a transfer outside the filter');
      }
      if (
        transfer.blockNumber > cursor.block ||
        (transfer.blockNumber === cursor.block && transfer.logIndex >= cursor.logIndex)
      ) {
        throw new BlockscoutError('returned transfers out of order');
      }
      cursor = { block: transfer.blockNumber, logIndex: transfer.logIndex };
      if (transfer.blockNumber < filter.fromBlock) return transfers.reverse();
      if (!filter.recipient || transfer.to === filter.recipient) transfers.push(transfer);
    }
    if (next === null) return transfers.reverse();
    if (!body.items.length) throw new BlockscoutError('an empty page that is not the last');
  }
  throw new BlockscoutError(`over ${BLOCKSCOUT_MAX_PAGES} pages of transfers`);
}

function logIndexHost(chainId) {
  try {
    return new URL(LOG_INDEX_URLS[Number(chainId)]).host;
  } catch {
    return '';
  }
}

module.exports = {
  BlockscoutError,
  BLOCKSCOUT_MAX_PAGES,
  ERC20_TRANSFER_TOPIC,
  LOG_INDEX_TOKENS,
  LOG_INDEX_URLS,
  agreedRpcLogs,
  blockscoutTransfer,
  canonicalLog,
  fetchBlockscoutTransferLogs,
  isLocalHostname,
  resolvesToLocalAddress,
  logIndexFilter,
  logIndexHost,
  logsAgree,
  rpcTransfer,
  rpcTransferLogsWellFormed,
};
