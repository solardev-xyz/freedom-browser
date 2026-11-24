/**
 * The fetch contract (freedom-core design 0014, "Main's fetches" → "The fetch
 * contract"): which `shell.colibri_fetch` requests main makes for the Colibri
 * service, and exactly how. Pure: no I/O, no clock.
 *
 * Today the worker fetches whatever request the WASM instance returns. With
 * the service, main checks each data request against the variants its
 * operation allows and refuses anything else. The grammar is the source-level
 * table of 3.0.3's verifier-only build, which freedom-core's COL-1 recording
 * (`vectors/colibri.json`) checks from both sides:
 * - sync, admitted for every operation the service serves: `lc_updates`,
 *   `lc_bootstrap` (`beacon_api`), `finality`, `block_root` (`checkpointz`);
 * - account reads at `latest`: the PAP rewrite, `pap_account` and
 *   `pap_storage` (prover POST `eth_getProof`), and `code` for `eth_getCode`;
 * - block reads, `eth_blockNumber` and `eth_maxPriorityFeePerGas`: `block`
 *   (prover POST `{ method: M, params: P }`);
 * - transaction lookups, `P` = `[h]`: `tx_cache`, `tx_cache_incremental`
 *   (prover GET, `max_age` 2 on Gnosis chains and 6 elsewhere),
 *   `tx_fallback` (prover POST `{ method: M, params: [h] }`), and the cached
 *   GET of the block (`tx_block`) or its receipts (`tx_receipts`). The
 *   binding is strict: `P` must be an array of exactly one 32-byte hash, as
 *   main always sends it. A bare-string `h`, which the client would wrap,
 *   admits nothing;
 * - `colibri.checkpoint`: `checkpoint_proof` once, which main makes itself
 *   from the chain's prover with nothing taken from the service, and
 *   `checkpoint_root` (`eth/v1/beacon/blocks/<n>/root`) at most 8 times,
 *   which main answers from its quorum. Nothing else, the sync variants
 *   included: today's checkpoint worker intercepts only that root path
 *   (`checkpoint-verifier-worker.js`), and that interception is the
 *   reference.
 *
 * Every prover POST ends with the props enrichment adds, and nothing else:
 * `version` 196611, an optional `c4` (the client state, at most 41 bytes), an
 * optional `zk_proof: true` (a ZK client only), an optional
 * `last_block_hash` (32 bytes), in that order. Fields the process chooses
 * (block numbers, periods, slots, roots) are bounded; every other field is
 * derived here from the operation, and compared as parsed JSON, hex without
 * regard to case. A form the service doesn't serve admits nothing, the sync
 * variants included. No variant has type `eth_rpc`.
 *
 * `admit(op, fetch)` answers the admitted request, or `{ refused: rule }`
 * with the first rule the fetch breaks (`COLIBRI_FETCH_RULES`), which main
 * logs with the chain and the type, never the path or the payload.
 */

const { colibriServiceRefusal, isBlockNumber } = require('./colibri-served');
const { colibriServers } = require('./colibri-servers');

/** `c4_get_current_version_number()` of the pinned Colibri (3.0.3). */
const COLIBRI_CLIENT_VERSION = 196611;

const KIB = 1024;
const MIB = 1024 * KIB;

/** The largest payload main sends: `JSON.stringify` of it, in bytes. */
const MAX_PAYLOAD_BYTES = 64 * KIB;

/** The largest client state (`MAX_STATES_SIZE`, `sync_committee.h`). */
const MAX_CLIENT_STATE_BYTES = 41;

/** `is_gnosis_chain`: the chains whose tx cache is fresh for 2 s, not 6. */
const GNOSIS_CHAINS = Object.freeze([100, 10200]);

/**
 * Each variant's type, the C core's verb, its encoding, the largest body
 * main reads for it (provisional, design 0014 "Body maximums"), and how many
 * one operation may have.
 */
const COLIBRI_FETCH_VARIANTS = Object.freeze({
  lc_updates: variant('beacon_api', 'get', 'ssz', 16 * MIB),
  lc_bootstrap: variant('beacon_api', 'get', 'ssz', 1 * MIB),
  finality: variant('checkpointz', 'get', 'json', 64 * KIB),
  block_root: variant('checkpointz', 'get', 'json', 64 * KIB),
  pap_account: variant('prover', 'post', 'ssz', 16 * MIB),
  pap_storage: variant('prover', 'post', 'ssz', 16 * MIB),
  code: variant('prover', 'post', 'ssz', 16 * MIB),
  block: variant('prover', 'post', 'ssz', 16 * MIB),
  tx_cache: variant('prover', 'get', 'ssz', 16 * MIB),
  tx_cache_incremental: variant('prover', 'get', 'ssz', 16 * MIB),
  tx_fallback: variant('prover', 'post', 'ssz', 16 * MIB),
  tx_receipts: variant('prover', 'get', 'ssz', 16 * MIB),
  tx_block: variant('prover', 'get', 'ssz', 16 * MIB),
  checkpoint_proof: variant('checkpoint_proof', 'post', 'ssz', 4 * MIB, 1),
  checkpoint_root: variant('checkpointz', 'get', 'json', 64 * KIB, 8),
});

function variant(type, verb, encoding, maxBody, limit) {
  return Object.freeze({ type, verb, encoding, maxBody, limit });
}

const SYNC_VARIANTS = Object.freeze(['lc_updates', 'lc_bootstrap', 'finality', 'block_root']);

/**
 * The rules a fetch can break, in the order `admit` checks them:
 * - `request`: no open operation of this process, an ended one, or a
 *   `request` that isn't its id (zero, unknown, another operation's);
 * - `fetch`: params that aren't `shell.colibri_fetch`'s;
 * - `operation`: an operation in a form the service doesn't serve;
 * - `eth_rpc`: any `eth_rpc` fetch;
 * - `type`: a type the process doesn't fetch, or a path of another type's;
 * - `verb`: not exactly `get` or `post`, or not the variant's;
 * - `path-*`: an absolute or scheme-relative path, a leading `/`, a `\`, a
 *   `%`, a `//`, a dot segment, a control character;
 * - `payload`: over 64 KiB, or present where the variant has none, or not an
 *   object where it has one;
 * - `query`: a query that isn't the variant's own, in its order;
 * - `variant`: no variant of this operation has this shape;
 * - `accept`: not the variant's encoding;
 * - `field`: a field the process chooses, out of bounds;
 * - `derived`: a field main derives, different (method, params, version,
 *   `max_blocks`, `std`/`zk`);
 * - `props`: the prover props wrong or out of order, or an option the
 *   configuration doesn't set (`include_code`, `signers`, `zk_proof` on a
 *   client without ZK, …);
 * - `max_age`: present where the variant has none, or not its derived age;
 * - `servers`: the type has no server;
 * - `exclude_mask`: a bit past the server list;
 * - `count`: past the variant's count for one operation.
 */
const COLIBRI_FETCH_RULES = Object.freeze([
  'request',
  'fetch',
  'operation',
  'eth_rpc',
  'type',
  'verb',
  'path-control',
  'path-absolute',
  'path-leading-slash',
  'path-backslash',
  'path-percent',
  'path-double-slash',
  'path-dot-segment',
  'payload',
  'query',
  'variant',
  'accept',
  'field',
  'derived',
  'props',
  'max_age',
  'servers',
  'exclude_mask',
  'count',
]);

/** The types each kind of process fetches (`eth_rpc` aside). */
const PROCESS_TYPES = Object.freeze({
  request: Object.freeze(['prover', 'beacon_api', 'checkpointz']),
  checkpoint: Object.freeze(['checkpoint_proof', 'checkpointz', 'beacon_api']),
});

/** The keys `shell.colibri_fetch` carries (`request.rs`, `FetchParams`). */
const FETCH_KEYS = Object.freeze([
  'request',
  'type',
  'method',
  'path',
  'payload',
  'accept',
  'exclude_mask',
  'max_age',
]);

/** A prover POST's keys, in the order the C core writes them. */
const PROVER_KEYS = Object.freeze([
  'method',
  'params',
  'version',
  'c4',
  'zk_proof',
  'last_block_hash',
]);

/**
 * The checkpoint's proof request, as `checkpoint-verifier-worker.js` makes
 * it today: main's own, nothing taken from the service.
 */
const CHECKPOINT_PROOF_PAYLOAD = JSON.stringify({
  method: 'eth_getBlockByNumber',
  params: ['latest', false],
  version: COLIBRI_CLIENT_VERSION,
  zk_proof: true,
});

const ACCEPT = Object.freeze({ json: 'application/json', ssz: 'application/octet-stream' });

/**
 * The cached GETs a transaction lookup makes, by method: the receipts of the
 * block the tx cache named, or the block itself (`verify_pap_tx.c:241`,
 * `:294`). The C core also rewrites `eth_getBlockHeader`, but only a call's
 * header sub-proof asks for it.
 */
const CACHED_GETS = Object.freeze({
  eth_getBlockReceipts: 'tx_receipts',
  eth_getBlockByNumber: 'tx_block',
});

/**
 * The paths each type's variants take, as `{ family, types, pathname,
 * query }`: `query` lists the query keys in order (`tx_cache`'s are per
 * variant).
 */
const PATHS = Object.freeze([
  { family: 'post', types: ['prover', 'checkpoint_proof'], pathname: /^$/, query: [] },
  {
    family: 'tx_cache',
    types: ['prover'],
    pathname: /^tx_cache$/,
    query: { tx_cache: ['max_blocks'], tx_cache_incremental: ['from_block', 'max_blocks'] },
  },
  {
    family: 'cached',
    types: ['prover'],
    pathname: /^proof\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
    query: [],
  },
  {
    family: 'lc_updates',
    types: ['beacon_api'],
    pathname: /^eth\/v1\/beacon\/light_client\/updates$/,
    query: ['start_period', 'count'],
  },
  {
    family: 'lc_bootstrap',
    types: ['beacon_api'],
    pathname: /^eth\/v1\/beacon\/light_client\/bootstrap\/([^/]+)$/,
    query: [],
  },
  {
    family: 'finality',
    types: ['checkpointz'],
    pathname: /^eth\/v1\/beacon\/states\/head\/finality_checkpoints$/,
    query: [],
  },
  {
    family: 'block_root',
    types: ['checkpointz'],
    pathname: /^eth\/v1\/beacon\/blocks\/([^/]+)\/root$/,
    query: [],
  },
]);

function refuse(rule) {
  return Object.freeze({ refused: rule });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHex(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

/** `0x` and 32 bytes. */
function isHash32(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** `0x` and `min` to 41 bytes: a client state. */
function isClientState(value, min) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return false;
  const bytes = (value.length - 2) / 2;
  return bytes >= min && bytes <= MAX_CLIENT_STATE_BYTES;
}

/** A decimal within `bits` bits, with no sign and no leading zero. */
function isDecimal(value, bits) {
  return (
    typeof value === 'string' &&
    value.length <= 20 &&
    /^(?:0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) < 1n << BigInt(bits)
  );
}

/** Equal as parsed JSON, hex strings without regard to case. */
function sameJson(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b || (isHex(a) && isHex(b) && a.toLowerCase() === b.toLowerCase());
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    );
  }
  return a === b;
}

/**
 * The params the client hands the C core: `request()`'s
 * `Array.isArray(params) ? params : (params ? [params] : [])`.
 */
function clientParams(params) {
  if (Array.isArray(params)) return params;
  return params ? [params] : [];
}

/** `joinPath(server, path)`, as `cjs/http.js:6–14` joins them. */
function joinPath(base, path) {
  if (!path) return base;
  if (base.endsWith('/')) return base + path;
  return base + (path.startsWith('/') ? path : '/' + path);
}

function checkOperation(op) {
  if (!Number.isSafeInteger(op.id) || op.id <= 0) {
    throw new TypeError('Colibri operation id must be a positive integer');
  }
  if (op.kind !== 'request' && op.kind !== 'checkpoint') {
    throw new TypeError(`Colibri operation kind ${String(op.kind)} is not request or checkpoint`);
  }
  if (!Number.isSafeInteger(op.chain) || op.chain <= 0) {
    throw new TypeError('Colibri operation chain must be a positive integer');
  }
  if (op.kind === 'checkpoint') return;
  if (typeof op.method !== 'string' || typeof op.params !== 'string') {
    throw new TypeError('Colibri request operation needs its method and its params as JSON text');
  }
  if (typeof op.zk !== 'boolean') throw new TypeError('Colibri request operation needs zk');
  if (typeof op.prover !== 'string' || !op.prover) {
    throw new TypeError("Colibri request operation needs its client's prover");
  }
}

/**
 * What an operation allows: `{ variants, post }`, `post` being the prover
 * POST main derives (its variant, method and params), or `null` for a form
 * the service doesn't serve.
 */
function allowedBy(op) {
  if (op.kind === 'checkpoint') {
    return { variants: new Set(['checkpoint_proof', 'checkpoint_root']), post: null };
  }
  const method = op.method;
  if (colibriServiceRefusal(method, op.params) !== null) return null;
  let parsed;
  try {
    parsed = JSON.parse(op.params);
  } catch {
    return null;
  }
  const args = clientParams(parsed);
  const allow = (post, gets = []) => ({
    variants: new Set([...SYNC_VARIANTS, post.variant, ...gets]),
    post,
  });
  switch (method) {
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
      // The PAP rewrite (`eth_verify.c:271–274`).
      return allow({
        variant: 'pap_account',
        method: 'eth_getProof',
        params: [args[0], [], args[1]],
      });
    case 'eth_getStorageAt':
      return allow({
        variant: 'pap_storage',
        method: 'eth_getProof',
        params: [args[0], [args[1]], args[2]],
      });
    case 'eth_getCode':
      return allow({ variant: 'code', method, params: args });
    case 'eth_blockNumber':
    case 'eth_maxPriorityFeePerGas':
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return allow({ variant: 'block', method, params: args });
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt': {
      // The contract binds `P` = `[h]`, a 32-byte hash (`verify_pap_tx.c`
      // reads `args[0]` alone, and fails any other length before a fetch).
      if (!Array.isArray(parsed) || parsed.length !== 1 || !isHash32(parsed[0])) return null;
      const whole = method === 'eth_getTransactionReceipt' ? 'tx_receipts' : 'tx_block';
      return allow({ variant: 'tx_fallback', method, params: [args[0]] }, [
        'tx_cache',
        'tx_cache_incremental',
        whole,
      ]);
    }
    default:
      return null;
  }
}

/** Whether `text` holds a C0 control character or DEL. */
function hasControl(text) {
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** The path's syntax rule it breaks, or `null`. */
function pathRule(path) {
  if (hasControl(path)) return 'path-control';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('//')) return 'path-absolute';
  if (path.startsWith('/')) return 'path-leading-slash';
  if (path.includes('\\')) return 'path-backslash';
  if (path.includes('%')) return 'path-percent';
  if (path.includes('//')) return 'path-double-slash';
  const at = path.indexOf('?');
  const segments = (at < 0 ? path : path.slice(0, at)).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'path-dot-segment';
  return null;
}

/** `k=v&…` as `[[k, v], …]`, or `null` for a query that isn't one. */
function queryPairs(query) {
  if (query === null) return [];
  const pairs = [];
  for (const part of query.split('&')) {
    const at = part.indexOf('=');
    if (at < 0) return null;
    pairs.push([part.slice(0, at), part.slice(at + 1)]);
  }
  return pairs;
}

function sameKeys(pairs, keys) {
  return pairs.length === keys.length && pairs.every(([key], index) => key === keys[index]);
}

/**
 * The variant a path names for `type`, with its fields:
 * `{ variant, fields }` or a refusal.
 */
function classify(op, allowed, type, path) {
  const at = path.indexOf('?');
  const pathname = at < 0 ? path : path.slice(0, at);
  const pairs = queryPairs(at < 0 ? null : path.slice(at + 1));
  let otherType = false;
  for (const entry of PATHS) {
    const match = entry.pathname.exec(pathname);
    if (!match) continue;
    if (!entry.types.includes(type)) {
      otherType = true;
      continue;
    }
    if (pairs === null) return refuse('query');
    const values = Object.fromEntries(pairs);
    if (entry.family === 'tx_cache') {
      const name = Object.keys(entry.query).find((key) => sameKeys(pairs, entry.query[key]));
      return name ? { variant: name, fields: values } : refuse('query');
    }
    if (!sameKeys(pairs, entry.query)) return refuse('query');
    switch (entry.family) {
      case 'post': {
        const name = type === 'checkpoint_proof' ? 'checkpoint_proof' : allowed.post?.variant;
        return name ? { variant: name, fields: {} } : refuse('variant');
      }
      case 'cached': {
        const [, method, block, version, proof, state] = match;
        if (!Object.hasOwn(CACHED_GETS, method)) return refuse('variant');
        return { variant: CACHED_GETS[method], fields: { method, block, version, proof, state } };
      }
      case 'lc_bootstrap':
        return { variant: 'lc_bootstrap', fields: { root: match[1] } };
      case 'block_root':
        return {
          variant: op.kind === 'checkpoint' ? 'checkpoint_root' : 'block_root',
          fields: { slot: match[1] },
        };
      default:
        return { variant: entry.family, fields: values };
    }
  }
  return refuse(otherType ? 'type' : 'variant');
}

/** The rule a variant's path fields break, or `null`. */
function fieldRule(name, fields, op) {
  switch (name) {
    case 'tx_cache':
      return fields.max_blocks === '256' ? null : 'derived';
    case 'tx_cache_incremental':
      if (!isDecimal(fields.from_block, 64)) return 'field';
      return fields.max_blocks === '256' ? null : 'derived';
    case 'tx_receipts':
    case 'tx_block':
      // `proof/<m>/<B>/196611/<std|zk>/0x<client state>`, no query
      // (`prover_cache_url.c:29–45`); `B` is the block the tx cache named,
      // `0x%lx`.
      if (!isBlockNumber(fields.block) || !isClientState(fields.state, 0)) return 'field';
      if (fields.version !== String(COLIBRI_CLIENT_VERSION)) return 'derived';
      if (fields.proof === 'zk') return op.zk ? null : 'props';
      return fields.proof === 'std' ? null : 'derived';
    case 'lc_updates':
      return isDecimal(fields.start_period, 32) && isDecimal(fields.count, 32) ? null : 'field';
    case 'lc_bootstrap':
      return isHash32(fields.root) ? null : 'field';
    case 'block_root':
    case 'checkpoint_root':
      return isDecimal(fields.slot, 64) ? null : 'field';
    default:
      return null;
  }
}

/** The rule a prover POST's payload breaks, or `null`. */
function proverPayloadRule(payload, post, op) {
  if (!isPlainObject(payload)) return 'payload';
  let last = -1;
  for (const key of Object.keys(payload)) {
    const at = PROVER_KEYS.indexOf(key);
    if (at <= last) return 'props';
    last = at;
  }
  if (!Object.hasOwn(payload, 'method') || !Object.hasOwn(payload, 'params')) return 'derived';
  let same;
  try {
    same = payload.method === post.method && sameJson(payload.params, post.params);
  } catch {
    // Nested past the stack: not the derivation.
    same = false;
  }
  if (!same) return 'derived';
  if (payload.version !== COLIBRI_CLIENT_VERSION) return 'props';
  if (Object.hasOwn(payload, 'c4') && !isClientState(payload.c4, 1)) return 'props';
  if (Object.hasOwn(payload, 'zk_proof') && (payload.zk_proof !== true || !op.zk)) return 'props';
  if (Object.hasOwn(payload, 'last_block_hash') && !isHash32(payload.last_block_hash)) {
    return 'props';
  }
  return null;
}

/** The tx cache's `max_age` (`verify_pap_tx.c:49–51`). */
function txCacheMaxAge(chain) {
  return GNOSIS_CHAINS.includes(chain) ? 2 : 6;
}

/**
 * Admits one `shell.colibri_fetch`, or refuses it.
 *
 * `op` is the open operation the fetch's `request` names on this process,
 * or `null` when it names none:
 * - `{ kind: 'request', id, chain, method, params, zk, prover, ended?,
 *   taken? }`: a `colibri.request`, `params` being the JSON text main sent,
 *   `zk` the client's ZK setting and `prover` its prover URL;
 * - `{ kind: 'checkpoint', id, chain, ended?, taken? }`: a
 *   `colibri.checkpoint`.
 * `id` is main's id for it (a positive integer, required: an operation
 * without one is main's bug, a TypeError), and the fetch's `request` must be
 * it. `ended` marks one that has replied, been cancelled or passed its
 * deadline; `taken` counts the fetches of each variant already admitted for
 * it, which the caller keeps.
 *
 * `fetch` is the service's params: `{ request, type, method, path, payload?,
 * accept, exclude_mask, max_age? }`, the payload parsed.
 *
 * The answer is `{ refused: rule }`, or what main sends: `{ variant, type,
 * verb, path, payload, accept, maxAge, maxBody, attempts, fields }`, `verb`
 * being the HTTP method, `payload` the body text (`null` without one),
 * `accept` the `Accept` header, `maxAge` the `Cache-Control` max-age
 * (`null` without one), `maxBody` the most bytes main reads, and `fields`
 * the path's fields, which `sameVariant` compares.
 *
 * `attempts` is `exclude_mask` applied: the servers to try, in order, as
 * `{ url, node }`, `node` being the server's index in the type's full list,
 * which the reply's head carries (`fetch_from_servers`' `nodeIndex`). A mask
 * may exclude every server: the fetch is admitted with no attempts, and the
 * executor answers it `All nodes failed` without sending anything, as
 * `fetch_from_servers` throws its first `lastError` when it skips them all.
 * A mask bit past the list is refused (`exclude_mask`).
 */
function admit(op, fetch) {
  if (!op || op.ended) return refuse('request');
  checkOperation(op);
  if (!isPlainObject(fetch) || Object.keys(fetch).some((key) => !FETCH_KEYS.includes(key))) {
    return refuse('fetch');
  }
  const { request, type, method, path, accept } = fetch;
  const excludeMask = fetch.exclude_mask;
  if (
    !Number.isSafeInteger(request) ||
    typeof type !== 'string' ||
    typeof method !== 'string' ||
    typeof path !== 'string' ||
    typeof accept !== 'string' ||
    !Number.isInteger(excludeMask) ||
    excludeMask < 0 ||
    excludeMask > 0xffffffff ||
    (Object.hasOwn(fetch, 'max_age') &&
      (!Number.isSafeInteger(fetch.max_age) || fetch.max_age <= 0))
  ) {
    return refuse('fetch');
  }
  if (request !== op.id) return refuse('request');
  const allowed = allowedBy(op);
  if (!allowed) return refuse('operation');
  if (type === 'eth_rpc') return refuse('eth_rpc');
  if (!PROCESS_TYPES[op.kind].includes(type)) return refuse('type');
  if (method !== 'get' && method !== 'post') return refuse('verb');
  const syntax = pathRule(path);
  if (syntax) return refuse(syntax);
  let body = null;
  if (Object.hasOwn(fetch, 'payload')) {
    try {
      body = JSON.stringify(fetch.payload);
    } catch {
      return refuse('payload');
    }
    if (body === undefined || Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      return refuse('payload');
    }
  }
  const shape = classify(op, allowed, type, path);
  if (shape.refused) return shape;
  const name = shape.variant;
  if (!allowed.variants.has(name)) return refuse('variant');
  const spec = COLIBRI_FETCH_VARIANTS[name];
  if (method !== spec.verb) return refuse('verb');
  if (accept !== spec.encoding) return refuse('accept');
  const fieldBroken = fieldRule(name, shape.fields, op);
  if (fieldBroken) return refuse(fieldBroken);
  if (spec.type === 'prover' && spec.verb === 'post') {
    const payloadBroken = proverPayloadRule(fetch.payload, allowed.post, op);
    if (payloadBroken) return refuse(payloadBroken);
  } else if (body !== null) {
    return refuse('payload');
  }
  const maxAge =
    name === 'tx_cache' || name === 'tx_cache_incremental' ? txCacheMaxAge(op.chain) : null;
  if (maxAge === null ? Object.hasOwn(fetch, 'max_age') : fetch.max_age !== maxAge) {
    return refuse('max_age');
  }
  const servers = colibriServers({ kind: op.kind, chain: op.chain, type, prover: op.prover });
  if (servers.length === 0) return refuse('servers');
  if (servers.length < 32 && excludeMask >= 2 ** servers.length) return refuse('exclude_mask');
  // `excludeMask & (1 << node)`, as `fetch_from_servers` reads it; the list
  // is under 32 servers or the mask can't reach past index 31.
  const attempts = servers
    .map((url, node) => Object.freeze({ url, node }))
    .filter(({ node }) => node >= 32 || Math.floor(excludeMask / 2 ** node) % 2 === 0);
  if (spec.limit !== undefined && (op.taken?.[name] ?? 0) >= spec.limit) return refuse('count');
  return Object.freeze({
    variant: name,
    type,
    verb: spec.verb.toUpperCase(),
    path,
    payload: name === 'checkpoint_proof' ? CHECKPOINT_PROOF_PAYLOAD : body,
    accept: ACCEPT[spec.encoding],
    maxAge,
    maxBody: spec.maxBody,
    attempts: Object.freeze(attempts),
    fields: Object.freeze({ ...shape.fields }),
  });
}

/**
 * Whether two admitted fetches are the same variant with the same fields:
 * a redirect's `Location`, admitted for the same operation, must be the
 * fetch it redirects (design 0014, "Redirects"). Path fields and payloads
 * compare as parsed values, hex without regard to case.
 */
function sameVariant(a, b) {
  if (!a || !b || a.refused || b.refused) return false;
  if (
    a.variant !== b.variant ||
    a.type !== b.type ||
    a.verb !== b.verb ||
    a.accept !== b.accept ||
    a.maxAge !== b.maxAge ||
    a.maxBody !== b.maxBody
  ) {
    return false;
  }
  if ((a.payload === null) !== (b.payload === null)) return false;
  if (a.payload !== null && !sameJson(JSON.parse(a.payload), JSON.parse(b.payload))) return false;
  return sameJson(a.fields, b.fields);
}

module.exports = {
  COLIBRI_CLIENT_VERSION,
  COLIBRI_FETCH_RULES,
  COLIBRI_FETCH_VARIANTS,
  CHECKPOINT_PROOF_PAYLOAD,
  MAX_PAYLOAD_BYTES,
  admit,
  sameVariant,
  joinPath,
};
