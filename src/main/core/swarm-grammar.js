/**
 * Main's side of design 0015's operation grammar (freedom-core design
 * 0015, Node access: `shell.swarm_api`, The operation grammar, Values main
 * derives from its own replies, What main can't bind): which node calls a
 * running Swarm request (the **parent**) may have main make, when, how often
 * and with which values.
 *
 * - **The forms and rows** are data: `FORMS` (each `shell.swarm_api` form's
 *   method, path, query, headers, body and reply) and `ROWS` (each parent's
 *   ready check and calls in order, with their counts, conditions and what
 *   they bind, the design's text). They ship here as JavaScript and aren't
 *   read from any file at runtime; `swarm-grammar.vectors.test.js` holds
 *   them, and every honest and forbidden scenario, to the pinned core's
 *   `vectors/swarm-grammar.json`. `FAILED` has `stopped`, as 0015 and the
 *   core's wire.rs have it, which the pinned file leaves out.
 * - **An `Admission` per parent** decides each call before any dial, from
 *   what main itself knows: the parent's row and the params main sent (a
 *   page's typed form read back with swarm-typed.js, or main's own JSON),
 *   the page's key, and its record of the calls it admitted and the replies
 *   it returned. Never from the core's word, except what the design says
 *   main can't bind: a site's own feed owner where the page names none, a
 *   GSOC's mined owner, the signatures, the bodies the core builds (held to
 *   their form and length), and the batch the core chose. The first call
 *   that names `<o>` fixes it for the parent: one feed per request.
 * - **The rules** are the design's: the ready check first, then each call
 *   only as the next its row allows (`order`), within the row's counts
 *   (`count`), one open at a time (eight under `readData`); its form, path,
 *   query and headers exactly the form's and the row's (`form`, `query`,
 *   `header`); every value the row binds (`value`); and its body's kind,
 *   length and, where the page's own bytes make it, those bytes (`body`).
 *   A refused call is answered with its rule, and every later call of that
 *   parent is refused (`ended`), as is any call after the parent ended.
 *   Each member of a call (every one of them required, `stream` included)
 *   is checked for its type before it is converted or compared, so the
 *   core's input is refused by a rule, never thrown on.
 * - **Values main derives** from its own replies: a feed update's address
 *   from the row's topic, the parent's owner and the index; the index a
 *   write takes, `swarm-feed-index-next` of a 2xx `feed_head`, else
 *   `probeFeedHead` replayed over main's answers (at most 81 reads), and
 *   for `swarm.feed`'s update the larger of that and `min_index`; the
 *   address of the chunk a feed SOC wraps; a large feed write's root,
 *   which must be `bytes_up`'s reference; and `readData`'s tree, read with
 *   swarm-tree.js from the intermediate chunks main returned.
 *
 * Its caller is main's executor for the core's Swarm asks
 * (core/swarm-shell.js), one Admission per parent it opens.
 */

const { SwarmData, isNullish, param, truthy } = require('./swarm-typed');
const {
  CHUNK_SIZE,
  MAX_SLOTS,
  Occurrences,
  decodeSpan,
  keccak,
  spanBytes,
  wireAddress,
} = require('./swarm-tree');

// The forms and rows, as vectors/swarm-grammar.json writes them (design
// 0015, `shell.swarm_api` and The operation grammar). `binds` is the
// design's text; BINDINGS below holds each call to it.

/** Each form: method, path (its values named as in VALUES), query names in order, request headers [name, value, when], body kinds and bounds, reply. */
const FORMS = {
  chunk: {
    method: 'GET',
    path: '/chunks/<a>',
    query: [],
    headers: [],
    body: null,
    reply: { whole: 4201 },
    annotations: ['feed', 'tree'],
  },
  bytes: {
    method: 'GET',
    path: '/bytes/<a>',
    query: [],
    headers: [['range', 'bytes=<s>-<e>', 'row']],
    body: null,
    reply: { stream: 'max_bytes' },
  },
  feed_head: {
    method: 'GET',
    path: '/feeds/<o>/<t>',
    query: [],
    headers: [['swarm-only-root-chunk', 'true']],
    body: null,
    reply: { whole: 4201, read: 'headers' },
  },
  feed_latest: {
    method: 'GET',
    path: '/feeds/<o>/<t>',
    query: [],
    headers: [],
    body: null,
    reply: { stream: 'max_bytes' },
  },
  tag: {
    method: 'GET',
    path: '/tags/<uid>',
    query: [],
    headers: [],
    body: null,
    reply: { whole: 65536, json: true },
  },
  addresses: {
    method: 'GET',
    path: '/addresses',
    query: [],
    headers: [],
    body: null,
    reply: { whole: 65536, json: true },
  },
  stamps: {
    method: 'GET',
    path: '/stamps',
    query: [],
    headers: [],
    body: null,
    reply: { whole: 1048576, json: true },
  },
  stamp: {
    method: 'GET',
    path: '/stamps/<b>',
    query: [],
    headers: [],
    body: null,
    reply: { whole: 65536, json: true },
  },
  bzz_file: {
    method: 'POST',
    path: '/bzz',
    query: ['name'],
    headers: [
      ['content-type', '<content-type>'],
      ['swarm-postage-batch-id', '<b>'],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'true|false'],
      ['swarm-encrypt', 'true', 'publish'],
    ],
    body: ['base64', 'stream'],
    reply: { whole: 65536, json: true },
  },
  bzz_tar: {
    method: 'POST',
    path: '/bzz',
    query: [],
    headers: [
      ['content-type', 'application/x-tar'],
      ['swarm-collection', 'true'],
      ['swarm-postage-batch-id', '<b>'],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'true'],
      ['swarm-index-document', '<p>', 'row'],
      ['swarm-encrypt', 'true', 'publish'],
    ],
    body: ['stream'],
    reply: { whole: 65536, json: true },
  },
  bytes_up: {
    method: 'POST',
    path: '/bytes',
    query: [],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', '<b>'],
    ],
    body: ['stream'],
    reply: { whole: 65536, json: true },
  },
  chunk_up: {
    method: 'POST',
    path: '/chunks',
    query: [],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', '<b>'],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'false'],
    ],
    body: ['base64'],
    body_bytes: [9, 4104],
    reply: { whole: 65536, json: true },
  },
  soc_up: {
    method: 'POST',
    path: '/soc/<o>/<id>',
    query: ['sig'],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', '<b>'],
      ['swarm-pin', 'true', 'soc-raw'],
      ['swarm-deferred-upload', 'false', 'soc-raw'],
    ],
    body: ['base64'],
    body_bytes: [9, 4104],
    reply: { whole: 65536, json: true },
  },
  feed_manifest: {
    method: 'POST',
    path: '/feeds/<o>/<t>',
    query: [],
    headers: [['swarm-postage-batch-id', '<b>']],
    body: null,
    reply: { whole: 65536, json: true },
  },
  pss_send: {
    method: 'POST',
    path: '/pss/send/<t>/<x>',
    query: ['recipient'],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', '<b>'],
    ],
    body: ['base64'],
    body_bytes: [0, 4000],
    reply: { whole: 65536, json: true },
  },
};

/** Each parent's ready check and calls in order: forms, count [min, max], when, and what the row binds. readFeedEntry_index and readFeedEntry_latest are readFeedEntry with and without params.index. */
const ROWS = {
  readChunk: {
    ready: 'reachable',
    calls: [{ forms: ['chunk'], count: [1, 1], binds: '<a> = params.reference' }],
  },
  readSingleOwnerChunk: {
    ready: 'reachable',
    calls: [
      {
        forms: ['chunk'],
        count: [1, 1],
        binds: '<a> = params.address, or keccak256(params.identifier ‖ params.owner)',
      },
    ],
  },
  readData: {
    ready: 'reachable',
    calls: [
      { forms: ['chunk'], count: [1, 1], binds: 'the root: <a> = params.reference' },
      {
        forms: ['chunk', 'bytes'],
        count: [0, 2563],
        when: "the root's size n is over 4,096 bytes (at most n ≤ B)",
        binds:
          "bytes at most once: <a> = params.reference, range: bytes=0-<n − 1>, max_bytes = n; every later chunk with tree { length, depth }, an unfetched occurrence of a data child of an intermediate main returned (0009's geometry); chunk at most 2 + 2⌈B / 4,096⌉ = 2,562 in all, 8 open at once",
      },
    ],
  },
  readFeedEntry_index: {
    ready: 'reachable',
    calls: [
      {
        forms: ['chunk'],
        count: [1, 1],
        binds:
          'with feed { owner, index }: <a> = keccak256(keccak256(<t> ‖ index as 8 bytes BE) ‖ <o>)',
      },
      {
        forms: ['bytes'],
        count: [0, 1],
        when: "the size in the SOC's wrapped span is over 4,096 bytes",
        binds:
          '<a> = the address of the chunk the SOC wraps (bytes 97 on of the reply), no range, max_bytes = that size (at most B)',
      },
    ],
  },
  readFeedEntry_latest: {
    ready: 'reachable',
    calls: [
      {
        forms: ['feed_latest'],
        count: [1, 1],
        binds:
          '<t> = params.topic or keccak256(utf8(key + "/" + params.name)); <o> = params.owner when given; max_bytes at most B',
      },
    ],
  },
  getUploadStatus: {
    ready: null,
    calls: [{ forms: ['tag'], count: [1, 1], binds: '<uid> = params.tagUid' }],
  },
  getMessagingIdentity: {
    ready: 'reachable',
    calls: [{ forms: ['addresses'], count: [1, 1], binds: '' }],
  },
  publishData: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['bzz_file'],
        count: [1, 1],
        binds:
          "<n> = params.name, else data; content-type = params.contentType; swarm-deferred-upload: false; the body exactly the data's length",
      },
    ],
  },
  publishFiles: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['bzz_tar'],
        count: [1, 1],
        binds:
          'swarm-index-document = params.indexDocument, else index.html when a top-level file has that name, else none; the body at most T(files)',
      },
    ],
  },
  publishChunk: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      { forms: ['chunk_up'], count: [1, 1], binds: 'the body = span ‖ the data' },
    ],
  },
  writeSingleOwnerChunk: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['soc_up'],
        count: [1, 1],
        binds: '<id> = params.identifier; the body = span ‖ the data',
      },
    ],
  },
  createFeed: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['feed_manifest'],
        count: [1, 1],
        binds: '<t> = keccak256(utf8(key + "/" + params.name))',
      },
    ],
  },
  updateFeed: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['feed_head'],
        count: [1, 1],
        binds: '<t> as for createFeed; one <o> throughout, fixed by feed_head',
      },
      {
        forms: ['chunk'],
        count: [0, 81],
        when: "after feed_head's 404 or 500",
        binds: 'with feed: each at the SOC address of the index the head probe asks next',
      },
      {
        forms: ['soc_up'],
        count: [1, 1],
        binds:
          '<id> = keccak256(<t> ‖ the next index as 8 bytes BE); the body = span ‖ an 8-byte timestamp ‖ params.reference (48 or 80 bytes)',
      },
    ],
  },
  writeFeedEntry: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['chunk'],
        count: [1, 1],
        when: 'with index',
        binds: 'with feed: the SOC address of params.index',
      },
      {
        forms: ['feed_head'],
        count: [1, 1],
        when: 'without index',
        binds: 'one <o> throughout, fixed by the first call that names it',
      },
      {
        forms: ['chunk'],
        count: [0, 81],
        when: "without index, after feed_head's 404 or 500",
        binds: "with feed: the probe's next index",
      },
      {
        forms: ['bytes_up'],
        count: [0, 1],
        when: 'data over 4,096 bytes',
        binds: "the body exactly the data's length",
      },
      {
        forms: ['soc_up'],
        count: [1, 1],
        binds:
          "<id> = keccak256(<t> ‖ the write's index as 8 bytes BE); the body = span ‖ the data (4,096 bytes or less), else a root chunk whose address is bytes_up's reference",
      },
    ],
  },
  sendPss: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['pss_send'],
        count: [1, 1],
        binds:
          '<t> = keccak256(utf8(params.topic)); <x> = params.targets, lowercased; recipient = params.recipient, lowercased; the body = the message',
      },
    ],
  },
  sendGsoc: {
    ready: 'publish',
    calls: [
      { forms: ['stamps'], count: [1, 1], binds: '' },
      {
        forms: ['soc_up'],
        count: [1, 1],
        binds: '<id> = keccak256(utf8(params.topic)); the body = span ‖ the message',
      },
    ],
  },
  subscribe: { ready: 'subscribe', calls: [] },
  getCapabilities: { ready: 'publish', calls: [] },
  requestAccess: { ready: null, calls: [] },
  getSigningIdentity: { ready: null, calls: [] },
  listFeeds: { ready: null, calls: [] },
  'swarm.publish:data,file': {
    ready: null,
    calls: [
      { forms: ['stamps'], count: [0, 1], when: 'no batch given', binds: '' },
      {
        forms: ['bzz_file'],
        count: [1, 1],
        binds:
          "<n> = name, else data for data; content-type = content_type, else text/plain (data) or application/octet-stream (file); swarm-deferred-upload = deferred; swarm-encrypt only when encrypt; the body exactly the part's length; with batch, swarm-postage-batch-id = batch",
      },
    ],
  },
  'swarm.publish:collection': {
    ready: null,
    calls: [
      { forms: ['stamps'], count: [0, 1], when: 'no batch given', binds: '' },
      {
        forms: ['bzz_tar'],
        count: [1, 1],
        binds:
          'swarm-index-document = index_document, else index.html when a top-level part has that name; swarm-encrypt only when encrypt; the body at most T(parts)',
      },
    ],
  },
  'swarm.feed:create': {
    ready: null,
    calls: [
      { forms: ['stamps'], count: [0, 1], when: 'no batch given', binds: '' },
      { forms: ['feed_manifest'], count: [1, 1], binds: '<t> = topic' },
    ],
  },
  'swarm.feed:update': {
    ready: null,
    calls: [
      { forms: ['stamps'], count: [0, 1], when: 'no batch given', binds: '' },
      { forms: ['feed_head'], count: [1, 1], binds: '<t> = topic' },
      {
        forms: ['chunk'],
        count: [0, 81],
        when: "after feed_head's 404 or 500",
        binds: "the probe's next index",
      },
      {
        forms: ['soc_up'],
        count: [1, 1],
        binds: 'the next index at least min_index; the body ending in reference',
      },
    ],
  },
  'swarm.feed:read': {
    ready: null,
    calls: [
      { forms: ['feed_head'], count: [1, 1], binds: '<t> = topic' },
      {
        forms: ['chunk'],
        count: [0, 81],
        when: "after feed_head's 404",
        binds: "the probe's next index",
      },
    ],
  },
  'swarm.stamps': {
    ready: null,
    calls: [{ forms: ['stamps', 'stamp'], count: [1, 1], binds: '<b> = id' }],
  },
  'swarm.upload_status': {
    ready: null,
    calls: [{ forms: ['tag'], count: [1, 1], binds: '<uid> = tag_uid' }],
  },
};

/** The values a path, query or header names. */
const VALUES = {
  '<a>': '64 lowercase hex',
  '<t>': '64 lowercase hex',
  '<id>': '64 lowercase hex',
  '<b>': '64 lowercase hex',
  '<o>': '40 lowercase hex',
  '<uid>': 'a decimal integer from 1 to 2^53 − 1 with no leading zero',
  '<x>': '4 or 6 lowercase hex',
  sig: '130 lowercase hex',
  recipient: '66 lowercase hex, a compressed key (^0[23])',
  name: "the operation's file name, as URLSearchParams encodes it",
  '<s>-<e>': 'decimal byte offsets, s ≤ e',
};

/** What main adds to every call (the transport's own aside). */
const MAIN_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-encoding': 'identity',
};

/** The reply headers the core reads, and their bounds. */
const REPLY_HEADERS = {
  read: [
    'content-type',
    'content-length',
    'swarm-tag',
    'swarm-feed-index',
    'swarm-feed-index-next',
  ],
  max: 8,
  name_bytes: 64,
  value_bytes: 1024,
  reason_bytes: 1024,
};

/** An error status's body is answered whole, read up to 8 KiB. */
const ERROR_REPLY = { whole: 8192 };

/** `{ failed }`'s closed set: 0009's, `busy`, and `stopped` (main with no node to dial after a ready answer). */
const FAILED = ['unreachable', 'error', 'aborted', 'too_large', 'busy', 'stopped'];

/** A refused call's rules. */
const RULES = ['form', 'order', 'count', 'value', 'header', 'query', 'body', 'ended'];

/** The larger read budget's `maxBytes`: what one read may return. */
const B = 5 * 1024 * 1024;
/** `readData`'s walk: at most eight calls open at once. */
const READ_DATA_OPEN = 8;
/** The head probe's longest run (index 0, 41 growing reads, 39 halvings). */
const MAX_PROBE_READS = 81;
/** `MAX_PROBED_FEED_INDEX`: the highest index the head probe looks for. */
const MAX_PROBED_INDEX = 2 ** 40;
/** A SOC's header before the chunk it wraps: identifier and signature. */
const SOC_HEADER = 32 + 65;
const INLINE_BODY = 64 * 1024;
/** The longest base64 an inline body may be: 64 KiB's, 4⌈65,536 / 3⌉. */
const INLINE_BASE64 = 4 * Math.ceil(INLINE_BODY / 3);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const SYNTAX = {
  '<a>': HEX64,
  '<t>': HEX64,
  '<id>': HEX64,
  '<b>': HEX64,
  '<o>': HEX40,
  '<x>': /^(?:[0-9a-f]{4}|[0-9a-f]{6})$/,
  '<uid>': /^[1-9][0-9]{0,15}$/,
};
const QUERY_SYNTAX = {
  sig: /^[0-9a-f]{130}$/,
  recipient: /^0[23][0-9a-f]{64}$/,
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

deepFreeze(FORMS);
deepFreeze(ROWS);
deepFreeze(VALUES);
deepFreeze(MAIN_HEADERS);
deepFreeze(REPLY_HEADERS);
deepFreeze(ERROR_REPLY);
deepFreeze(FAILED);
deepFreeze(RULES);

// ---------------------------------------------------------------------------
// Values main derives.

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/**
 * `String(value)`, as the reference converts a param, or null where that
 * throws (an object whose own `toString` or `valueOf` isn't callable).
 */
function jsString(value) {
  try {
    return String(value);
  } catch {
    return null;
  }
}

/** keccak256(utf8(text)), as bee-js's `Topic.fromString` (a lone surrogate as U+FFFD); null when `text` has no string. */
function topicOf(text) {
  const string = jsString(text);
  return string === null ? null : hex(keccak(Buffer.from(string, 'utf8')));
}

/** A feed index as 8 bytes, big-endian. */
function indexBytes(index) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt.asUintN(64, BigInt(index)));
  return out;
}

/** A feed update's identifier: keccak256(topic ‖ index as 8 bytes, big-endian). */
function feedIdentifier(topic, index) {
  return hex(keccak(Buffer.concat([Buffer.from(topic, 'hex'), indexBytes(index)])));
}

/** A SOC's address: keccak256(identifier ‖ owner). */
function socAddress(identifier, owner) {
  return hex(keccak(Buffer.concat([Buffer.from(identifier, 'hex'), Buffer.from(owner, 'hex')])));
}

/** A feed update's address: keccak256(keccak256(topic ‖ index) ‖ owner). */
function feedUpdateAddress(topic, owner, index) {
  return socAddress(feedIdentifier(topic, index), owner);
}

/** A page's own feed topic: keccak256(utf8(key + "/" + name)), as `buildTopicString`; null when `name` has no string. */
function pageTopic(key, name) {
  const string = jsString(name);
  return string === null ? null : topicOf(`${key}/${string}`);
}

/** A hex param of `bytes` bytes, lowercased first (as spi lowercases its targets); null when it isn't one. */
function hexParam(value, bytes) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(lower) ? lower : null;
}

/** An Ethereum address param, `0x` dropped and lowercased; null when it isn't one. */
function ownerParam(value) {
  if (typeof value !== 'string') return null;
  return hexParam(value.replace(/^0x/, ''), 20);
}

/** A feed index param as the reference takes it (`Number.isInteger`, not negative), as 64 bits. */
function indexParam(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return BigInt.asUintN(64, BigInt(value));
}

/** The index a `feed` annotation names: a number up to 2^53 − 1, its decimal text past it (wire.rs). */
function annotatedIndex(index) {
  if (typeof index === 'number') {
    return Number.isSafeInteger(index) && index >= 0 ? BigInt(index) : null;
  }
  if (typeof index !== 'string' || !/^[1-9][0-9]{15,19}$/.test(index)) return null;
  const value = BigInt(index);
  return value > BigInt(Number.MAX_SAFE_INTEGER) && value < 1n << 64n ? value : null;
}

/** A header's value as `Headers.get` reads it: every value of the name, joined, case-insensitive. */
function headerText(pairs, name) {
  const values = pairs
    .filter((pair) => isPairs([pair]) && pair[0].toLowerCase() === name)
    .map((pair) => pair[1]);
  return values.length ? values.join(', ') : null;
}

/** An 8-byte `FeedIndex` read from hex as core-sdk's `Bytes` reads it; null when it isn't one. */
function feedIndexHex(text) {
  if (!text) return null;
  const digits = /^0x/i.test(text) ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{16}$/.test(digits)) return null;
  return BigInt(`0x${digits}`);
}

const ok = (reply) =>
  Boolean(reply) && Number.isInteger(reply.status) && reply.status >= 200 && reply.status < 300;

/**
 * `probeFeedHead` replayed over main's own answers: index 0, then 1, 2, 4,
 * … while they exist, then the halving between the last found and the
 * first missing. A 2xx says an update exists, a 404 that it doesn't; any
 * other answer ends the probe, as the reference throws it.
 */
class HeadProbe {
  constructor() {
    this.phase = 'zero';
    this.asking = 0;
    this.lo = 0;
    this.hi = 0;
    this.pending = false;
    this.done = false;
    this.failed = false;
    /** The latest index once done, or null for a feed with no update. */
    this.head = undefined;
  }

  /** The index the next probe read must ask, or null when there is none. */
  get nextIndex() {
    return this.pending || this.done || this.failed ? null : this.asking;
  }

  /** The probe read for `nextIndex` was admitted. */
  asked() {
    this.pending = true;
  }

  /** Main answered it with `status` (null for `{ failed }`). */
  answer(status) {
    this.pending = false;
    const found = Number.isInteger(status) && status >= 200 && status < 300;
    if (!found && status !== 404) {
      this.failed = true;
      return;
    }
    if (this.phase === 'zero') {
      if (!found) return this.finish(null);
      this.phase = 'grow';
      this.lo = 0;
      this.hi = 1;
      this.asking = 1;
      return;
    }
    if (this.phase === 'grow') {
      if (!found) return this.bisect(this.lo, this.hi);
      this.lo = this.hi;
      this.hi *= 2;
      if (this.hi > MAX_PROBED_INDEX) {
        this.failed = true;
        return;
      }
      this.asking = this.hi;
      return;
    }
    if (found) this.bisect(this.asking, this.hi);
    else this.bisect(this.lo, this.asking);
  }

  bisect(lo, hi) {
    if (hi - lo > 1) {
      this.phase = 'bisect';
      this.lo = lo;
      this.hi = hi;
      this.asking = lo + Math.floor((hi - lo) / 2);
      return;
    }
    this.finish(lo);
  }

  finish(head) {
    this.done = true;
    this.head = head;
  }

  /** `head + 1`, or 0 for none: the next index a write takes. */
  get nextWriteIndex() {
    if (!this.done) return undefined;
    return this.head === null ? 0 : this.head + 1;
  }
}

/**
 * A feed's index lookup (`resolveNextIndex`, or `readFeedState`'s):
 * `feed_head`, then the head probe after a status in `probeOn`.
 */
class IndexLookup {
  constructor({ probeOn, minIndex = 0 }) {
    this.probeOn = probeOn;
    this.minIndex = minIndex;
    this.probe = null;
    this.networkNext = undefined;
  }

  /** Main answered `feed_head`. */
  answerHead(reply) {
    if (ok(reply)) {
      // bee-js's readFeedUpdateHeaders: both required, each 8 bytes.
      const index = feedIndexHex(headerText(reply.headers, 'swarm-feed-index'));
      const next = feedIndexHex(headerText(reply.headers, 'swarm-feed-index-next'));
      // feedIndexToNumber: a double.
      if (index !== null && next !== null) this.networkNext = Number(next);
      return;
    }
    if (reply && this.probeOn.includes(reply.status)) this.probe = new HeadProbe();
  }

  /** Whether the head probe may read now. */
  get probing() {
    return this.probe !== null;
  }

  /**
   * The index a write takes (`Math.max(minIndex, next)`, then
   * `FeedIndex.fromBigInt(BigInt(index))`), or undefined while unknown.
   */
  get writeIndex() {
    const next = this.probe ? this.probe.nextWriteIndex : this.networkNext;
    if (next === undefined) return undefined;
    return BigInt.asUintN(64, BigInt(Math.max(this.minIndex, next)));
  }
}

// ---------------------------------------------------------------------------
// Bodies.

/** The data's bytes (a string's UTF-8), or null when the params don't carry them. */
const inline = (data) => (data instanceof SwarmData && data.bytes ? data.bytes : null);

/** T(files): an upper bound of the tar bee-js's `TarStream` writes. */
function tarBound(entries) {
  let total = 1024;
  for (const { path, size } of entries) {
    if (typeof path !== 'string' || !Number.isSafeInteger(size) || size < 0) return null;
    total +=
      1024 + Math.ceil(Buffer.byteLength(path, 'utf8') / 512) * 512 + Math.ceil(size / 512) * 512;
  }
  return total;
}

/** A body that must be the data: its bytes when inline, else a stream of its length. */
function dataBody(data, body) {
  if (!(data instanceof SwarmData)) return 'body';
  if (data.bytes) return body.bytes && body.bytes.equals(data.bytes) ? null : 'body';
  return body.stream === data.length ? null : 'body';
}

/** A chunk body built from the data: `span ‖ data`, span the data's length unless given. */
function spanBody(data, span, body) {
  const bytes = inline(data);
  if (!bytes || !body.bytes) return 'body';
  // Compared in place: no copy of the body is made to compare it.
  const head = spanBytes(span === undefined ? bytes.length : span);
  return body.bytes.length === head.length + bytes.length &&
    body.bytes.subarray(0, head.length).equals(head) &&
    body.bytes.subarray(head.length).equals(bytes)
    ? null
    : 'body';
}

/** `params.span` as core-sdk's chunk takes it: a number or BigInt, and a span of 0, or none, is the data's length. */
function spanParam(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'bigint' && value > 0n && value < 1n << 64n) return value;
  return undefined;
}

/** A feed update's SOC body: span ‖ an 8-byte timestamp ‖ the reference (48 or 80 bytes). */
function updateBody(reference, body) {
  if (!reference || !body.bytes) return 'body';
  const ref = Buffer.from(reference, 'hex');
  const bytes = body.bytes;
  if (bytes.length !== 16 + ref.length) return 'body';
  if (!bytes.subarray(0, 8).equals(spanBytes(8 + ref.length))) return 'body';
  return bytes.subarray(16).equals(ref) ? null : 'body';
}

/** A feed update's reference: 64 or 128 hex, lowercased. */
function referenceParam(value) {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/.test(lower) ? lower : null;
}

// ---------------------------------------------------------------------------
// The rows' bindings. Each may give:
// - setup(a): the values the row binds, from the params and key;
// - enabled(a, step): whether a step's condition holds now;
// - required(a, step): whether an enabled step must be taken (its min);
// - phase(a, call, step): an `order` refusal the steps alone don't give;
// - rowHeaders(a, call, step): the row's own headers (`when: row`), by name;
// - headerValue(a, name): the value a placeholder header binds;
// - bind(a, call, ctx): the values (`value`), and what the reply will tell;
// - body(a, call, ctx): the body (`body`).
// `bind` may return a reply handler as `ctx.onReply`.

const stampsUnlessBatch = (a, step) => step !== 0 || !a.batchGiven;
/** Without a batch the row's `/stamps` is required: the upload names the batch it chose. */
const stampsRequired = (a, step) => step === 0 && !a.batchGiven;

/**
 * A tar's index document: the param when truthy (null when it has no
 * string), else `index.html` when a top-level entry has that name, else
 * none (undefined).
 */
function indexDocument(value, entries) {
  if (truthy(value)) return jsString(value);
  return entries && entries.some((entry) => entry.path === 'index.html') ? 'index.html' : undefined;
}

/** `swarm-index-document`, the tar row's own header: none, or exactly the index document (never, for one with no string). */
const indexHeader = (a, call) =>
  call.form === 'bzz_tar' && a.indexDocument !== undefined
    ? { 'swarm-index-document': a.indexDocument }
    : {};

/** A size a read streams: over one chunk (else the chunk is the whole read), and at most B. */
const walkable = (size) => size !== null && size > BigInt(CHUNK_SIZE) && size <= BigInt(B);

/** The `<a>` of a chunk at the path, held to `address`. */
const chunkAt = (ctx, address) => (address && ctx.path['<a>'] === address ? null : 'value');

/** A `feed`-annotated chunk: the owner (bound or fixed once), the index, and the path built from them. */
function feedChunk(a, call, ctx, topic, index) {
  const feed = call.feed;
  if (!feed || typeof feed !== 'object' || call.tree !== undefined) return 'value';
  if (typeof feed.owner !== 'string' || !HEX40.test(feed.owner)) return 'value';
  const named = annotatedIndex(feed.index);
  if (named === null || index === null || index === undefined || named !== BigInt(index)) {
    return 'value';
  }
  if (!a.fixOwner(feed.owner)) return 'value';
  if (!topic) return 'value';
  return chunkAt(ctx, feedUpdateAddress(topic, feed.owner, named));
}

/** A feed path `/feeds/<o>/<t>`: the topic, and the owner bound or fixed once. */
function feedPath(a, ctx, topic) {
  if (!topic || ctx.path['<t>'] !== topic) return 'value';
  return a.fixOwner(ctx.path['<o>']) ? null : 'value';
}

/** No annotation: a plain call. */
const plain = (call) => (call.feed === undefined && call.tree === undefined ? null : 'value');

/** A feed's index lookup: updateFeed's, writeFeedEntry's, and swarm.feed's update and read. */
const FEED_LOOKUP = {
  /** `feed_head`: the topic, the owner fixed; its reply starts the lookup. */
  head(a, call, ctx) {
    const refused = plain(call) || feedPath(a, ctx, a.topic);
    if (refused) return refused;
    ctx.onReply = (reply) => a.lookup.answerHead(reply);
    return null;
  },
  /** A probe read: at the index the replay asks next. */
  probe(a, call, ctx) {
    const probe = a.lookup.probe;
    const refused = feedChunk(a, call, ctx, a.topic, probe ? probe.nextIndex : null);
    if (refused) return refused;
    probe.asked();
    ctx.onReply = (reply) => probe.answer(reply ? reply.status : null);
    return null;
  },
  /** The final `soc_up`: the owner, and `<id>` at the write's index. */
  soc(a, ctx, index) {
    if (!a.fixOwner(ctx.path['<o>'])) return 'value';
    return ctx.path['<id>'] === feedIdentifier(a.topic, index) ? null : 'value';
  },
};

const BINDINGS = {
  readChunk: {
    setup(a) {
      a.address = hexParam(param(a.params, 'reference'), 32);
    },
    bind: (a, call, ctx) => plain(call) || chunkAt(ctx, a.address),
  },

  readSingleOwnerChunk: {
    setup(a) {
      const address = param(a.params, 'address');
      if (!isNullish(address)) {
        a.address = hexParam(address, 32);
        return;
      }
      const identifier = hexParam(param(a.params, 'identifier'), 32);
      const owner = ownerParam(param(a.params, 'owner'));
      a.address = identifier && owner ? socAddress(identifier, owner) : null;
    },
    bind: (a, call, ctx) => plain(call) || chunkAt(ctx, a.address),
  },

  readData: {
    setup(a) {
      a.address = hexParam(param(a.params, 'reference'), 32);
      a.size = null;
      a.tree = new Occurrences({ maxSlots: MAX_SLOTS });
      a.streamed = false;
    },
    // The walk only when the root's size is over 4,096 bytes, and at most B.
    enabled: (a, step) => step === 0 || walkable(a.size),
    rowHeaders: (a, call) => (call.form === 'bytes' ? { range: `bytes=0-${a.size - 1n}` } : {}),
    bind(a, call, ctx) {
      if (ctx.step === 0) {
        const refused = plain(call) || chunkAt(ctx, a.address);
        if (refused) return refused;
        ctx.onReply = (reply) => {
          if (!ok(reply) || !reply.body || reply.body.length < 8) return;
          a.size = decodeSpan(reply.body.subarray(0, 8)).size;
          if (walkable(a.size)) a.tree.addChildren(reply.body, a.size, 0);
        };
        return null;
      }
      if (call.form === 'bytes') {
        if (a.streamed) return 'count';
        if (plain(call) || chunkAt(ctx, a.address)) return 'value';
        if (BigInt(call.max_bytes) !== a.size) return 'value';
        a.streamed = true;
        return null;
      }
      const tree = call.tree;
      if (call.feed !== undefined || !tree || typeof tree !== 'object') return 'value';
      const { length, depth } = tree;
      if (!Number.isSafeInteger(length) || length < 0) return 'value';
      if (!Number.isInteger(depth) || depth < 1) return 'value';
      const taken = a.tree.take(ctx.path['<a>'], length, depth);
      if (taken) return taken;
      ctx.onReply = (reply) => {
        if (ok(reply) && reply.body) a.tree.addChildren(reply.body, length, depth);
      };
      return null;
    },
  },

  readFeedEntry_index: {
    setup(a) {
      a.topic = feedTopic(a);
      a.index = indexParam(param(a.params, 'index'));
      a.bindOwner(feedOwner(a));
      a.wrapped = null;
    },
    enabled: (a, step) => step === 0 || (a.wrapped !== null && walkable(a.wrapped.size)),
    bind(a, call, ctx) {
      if (ctx.step === 0) {
        const refused = feedChunk(a, call, ctx, a.topic, a.index);
        if (refused) return refused;
        ctx.onReply = (reply) => {
          if (!ok(reply) || !reply.body || reply.body.length < SOC_HEADER + 8) return;
          // The chunk the SOC wraps: its span ‖ payload, from byte 97 on.
          const wire = reply.body.subarray(SOC_HEADER);
          const address = wireAddress(wire);
          if (address) a.wrapped = { address, size: decodeSpan(wire.subarray(0, 8)).size };
        };
        return null;
      }
      if (plain(call) || chunkAt(ctx, a.wrapped.address)) return 'value';
      return BigInt(call.max_bytes) === a.wrapped.size ? null : 'value';
    },
  },

  readFeedEntry_latest: {
    setup(a) {
      a.topic = feedTopic(a);
      a.bindOwner(feedOwner(a));
    },
    bind(a, call, ctx) {
      const refused = plain(call) || feedPath(a, ctx, a.topic);
      if (refused) return refused;
      return call.max_bytes <= B ? null : 'body';
    },
  },

  getUploadStatus: {
    setup(a) {
      a.uid = uidParam(param(a.params, 'tagUid'));
    },
    bind: (a, call, ctx) => plain(call) || (a.uid && ctx.path['<uid>'] === a.uid ? null : 'value'),
  },

  getMessagingIdentity: {
    bind: (a, call) => plain(call),
  },

  publishData: {
    setup(a) {
      const name = param(a.params, 'name');
      a.name = truthy(name) ? jsString(name) : 'data';
      const contentType = param(a.params, 'contentType');
      a.contentType = typeof contentType === 'string' ? contentType : null;
      a.data = param(a.params, 'data');
    },
    headerValue: (a, name) =>
      ({ 'content-type': a.contentType, 'swarm-deferred-upload': 'false' })[name],
    bind(a, call, ctx) {
      if (plain(call)) return 'value';
      if (call.form === 'bzz_file' && ctx.query.get('name') !== a.name) return 'value';
      return null;
    },
    body: (a, call, ctx) => (call.form === 'bzz_file' ? dataBody(a.data, ctx.body) : null),
  },

  publishFiles: {
    setup(a) {
      const files = param(a.params, 'files');
      const entries = Array.isArray(files)
        ? Array.from(files, (file) => {
            const bytes = param(file, 'bytes');
            return {
              path: param(file, 'path'),
              size: bytes instanceof SwarmData ? bytes.length : -1,
            };
          })
        : null;
      a.bound = entries ? tarBound(entries) : null;
      a.indexDocument = indexDocument(param(a.params, 'indexDocument'), entries);
    },
    rowHeaders: indexHeader,
    bind: (a, call) => plain(call),
    body: (a, call, ctx) =>
      call.form !== 'bzz_tar' || (a.bound !== null && ctx.body.stream <= a.bound) ? null : 'body',
  },

  publishChunk: {
    setup(a) {
      a.data = param(a.params, 'data');
      a.span = spanParam(param(a.params, 'span'));
    },
    bind: (a, call) => plain(call),
    body: (a, call, ctx) => (call.form === 'chunk_up' ? spanBody(a.data, a.span, ctx.body) : null),
  },

  writeSingleOwnerChunk: {
    setup(a) {
      a.identifier = hexParam(param(a.params, 'identifier'), 32);
      a.data = param(a.params, 'data');
      a.span = spanParam(param(a.params, 'span'));
    },
    bind(a, call, ctx) {
      if (plain(call)) return 'value';
      if (call.form !== 'soc_up') return null;
      if (!a.fixOwner(ctx.path['<o>'])) return 'value';
      return a.identifier && ctx.path['<id>'] === a.identifier ? null : 'value';
    },
    body: (a, call, ctx) => (call.form === 'soc_up' ? spanBody(a.data, a.span, ctx.body) : null),
  },

  createFeed: {
    setup(a) {
      a.topic = pageTopic(a.key, param(a.params, 'name'));
    },
    bind: (a, call, ctx) =>
      plain(call) || (call.form === 'feed_manifest' ? feedPath(a, ctx, a.topic) : null),
  },

  updateFeed: {
    setup(a) {
      a.topic = pageTopic(a.key, param(a.params, 'feedId'));
      a.reference = referenceParam(param(a.params, 'reference'));
      a.lookup = new IndexLookup({ probeOn: [404, 500] });
    },
    enabled: (a, step) => step !== 2 || a.lookup.probing,
    phase: (a, call) =>
      call.form === 'soc_up' && a.lookup.writeIndex === undefined ? 'order' : null,
    bind(a, call, ctx) {
      if (call.form === 'feed_head') return FEED_LOOKUP.head(a, call, ctx);
      if (call.form === 'chunk') return FEED_LOOKUP.probe(a, call, ctx);
      if (plain(call)) return 'value';
      return call.form === 'soc_up' ? FEED_LOOKUP.soc(a, ctx, a.lookup.writeIndex) : null;
    },
    body: (a, call, ctx) => (call.form === 'soc_up' ? updateBody(a.reference, ctx.body) : null),
  },

  writeFeedEntry: {
    setup(a) {
      a.topic = pageTopic(a.key, param(a.params, 'name'));
      a.data = param(a.params, 'data');
      a.large = a.data instanceof SwarmData && a.data.length > CHUNK_SIZE;
      const index = param(a.params, 'index');
      a.explicit = !isNullish(index);
      a.index = a.explicit ? indexParam(index) : null;
      a.free = false;
      a.lookup = new IndexLookup({ probeOn: [404, 500] });
      a.root = undefined;
    },
    enabled(a, step) {
      if (step === 1) return a.explicit;
      if (step === 2) return !a.explicit;
      if (step === 3) return !a.explicit && a.lookup.probing;
      if (step === 4) return a.large;
      return true;
    },
    // A large entry's bytes_up comes before its soc_up.
    required: (a, step) => step === 4,
    phase(a, call) {
      if (call.form !== 'soc_up') return null;
      return writeIndexOf(a) === undefined ? 'order' : null;
    },
    bind(a, call, ctx) {
      if (call.form === 'feed_head') return FEED_LOOKUP.head(a, call, ctx);
      if (call.form === 'chunk' && ctx.step === 3) return FEED_LOOKUP.probe(a, call, ctx);
      if (call.form === 'chunk') {
        // The existence check at params.index: a 404 frees the index.
        const refused = feedChunk(a, call, ctx, a.topic, a.index);
        if (refused) return refused;
        ctx.onReply = (reply) => {
          a.free = Boolean(reply) && reply.status === 404;
        };
        return null;
      }
      if (plain(call)) return 'value';
      if (call.form === 'bytes_up') {
        ctx.onReply = (reply) => {
          a.root = ok(reply) ? uploadReference(reply.body) : null;
        };
        return null;
      }
      return call.form === 'soc_up' ? FEED_LOOKUP.soc(a, ctx, writeIndexOf(a)) : null;
    },
    body(a, call, ctx) {
      if (call.form === 'bytes_up') {
        return a.data instanceof SwarmData && ctx.body.stream === a.data.length ? null : 'body';
      }
      if (call.form !== 'soc_up') return null;
      if (!a.large) return spanBody(a.data, undefined, ctx.body);
      // The root chunk whose address is bytes_up's reference.
      if (!a.root || !ctx.body.bytes) return 'body';
      return wireAddress(ctx.body.bytes) === a.root ? null : 'body';
    },
  },

  sendPss: {
    setup(a) {
      const topic = param(a.params, 'topic');
      a.topic = typeof topic === 'string' ? topicOf(topic) : null;
      const targets = param(a.params, 'targets');
      a.targets = typeof targets === 'string' ? targets.toLowerCase() : null;
      const recipient = param(a.params, 'recipient');
      a.recipient =
        typeof recipient === 'string' ? recipient.replace(/^0x/, '').toLowerCase() : null;
      a.data = param(a.params, 'data');
    },
    bind(a, call, ctx) {
      if (plain(call)) return 'value';
      if (call.form !== 'pss_send') return null;
      if (!a.topic || ctx.path['<t>'] !== a.topic) return 'value';
      if (!a.targets || ctx.path['<x>'] !== a.targets) return 'value';
      return ctx.query.get('recipient') === a.recipient ? null : 'value';
    },
    body: (a, call, ctx) => (call.form === 'pss_send' ? dataBody(a.data, ctx.body) : null),
  },

  sendGsoc: {
    setup(a) {
      const topic = param(a.params, 'topic');
      a.identifier = typeof topic === 'string' ? topicOf(topic) : null;
      a.data = param(a.params, 'data');
    },
    bind(a, call, ctx) {
      if (plain(call)) return 'value';
      if (call.form !== 'soc_up') return null;
      if (!a.fixOwner(ctx.path['<o>'])) return 'value';
      return a.identifier && ctx.path['<id>'] === a.identifier ? null : 'value';
    },
    body: (a, call, ctx) => (call.form === 'soc_up' ? spanBody(a.data, undefined, ctx.body) : null),
  },

  subscribe: {},
  getCapabilities: {},
  requestAccess: {},
  getSigningIdentity: {},
  listFeeds: {},

  'swarm.publish:data,file': {
    setup(a) {
      mainBatch(a);
      const kind = param(a.params, 'kind');
      const name = param(a.params, 'name');
      a.name = truthy(name) ? jsString(name) : kind === 'data' ? 'data' : null;
      const contentType = param(a.params, 'content_type');
      a.contentType = truthy(contentType)
        ? jsString(contentType)
        : kind === 'data'
          ? 'text/plain'
          : 'application/octet-stream';
      const deferred = param(a.params, 'deferred');
      a.deferred = typeof deferred === 'boolean' ? String(deferred) : null;
      const parts = param(a.params, 'parts');
      a.part = Array.isArray(parts) && parts.length === 1 ? parts[0] : null;
    },
    enabled: stampsUnlessBatch,
    required: stampsRequired,
    headerValue: (a, name) =>
      ({ 'content-type': a.contentType, 'swarm-deferred-upload': a.deferred })[name],
    bind(a, call, ctx) {
      if (plain(call)) return 'value';
      if (call.form === 'bzz_file' && (a.name === null || ctx.query.get('name') !== a.name)) {
        return 'value';
      }
      return null;
    },
    body(a, call, ctx) {
      if (call.form !== 'bzz_file') return null;
      const part = a.part;
      const length = param(part, 'bytes');
      if (!Number.isSafeInteger(length) || length < 0) return 'body';
      const base64 = param(part, 'base64');
      if (typeof base64 === 'string') {
        const bytes = Buffer.from(base64, 'base64');
        return bytes.length === length && ctx.body.bytes && ctx.body.bytes.equals(bytes)
          ? null
          : 'body';
      }
      return Number.isInteger(param(part, 'part')) && ctx.body.stream === length ? null : 'body';
    },
  },

  'swarm.publish:collection': {
    setup(a) {
      mainBatch(a);
      const parts = param(a.params, 'parts');
      const entries = Array.isArray(parts)
        ? parts.map((part) => ({ path: param(part, 'path'), size: param(part, 'bytes') }))
        : null;
      a.bound = entries ? tarBound(entries) : null;
      a.indexDocument = indexDocument(param(a.params, 'index_document'), entries);
    },
    enabled: stampsUnlessBatch,
    required: stampsRequired,
    rowHeaders: indexHeader,
    bind: (a, call) => plain(call),
    body: (a, call, ctx) =>
      call.form !== 'bzz_tar' || (a.bound !== null && ctx.body.stream <= a.bound) ? null : 'body',
  },

  'swarm.feed:create': {
    setup(a) {
      mainBatch(a);
      a.topic = hexParam(param(a.params, 'topic'), 32);
    },
    enabled: stampsUnlessBatch,
    required: stampsRequired,
    bind: (a, call, ctx) =>
      plain(call) || (call.form === 'feed_manifest' ? feedPath(a, ctx, a.topic) : null),
  },

  'swarm.feed:update': {
    setup(a) {
      mainBatch(a);
      a.topic = hexParam(param(a.params, 'topic'), 32);
      a.reference = referenceParam(param(a.params, 'reference'));
      const minIndex = param(a.params, 'min_index');
      a.lookup = new IndexLookup({
        probeOn: [404, 500],
        minIndex: Number.isSafeInteger(minIndex) && minIndex > 0 ? minIndex : 0,
      });
    },
    enabled: (a, step) => stampsUnlessBatch(a, step) && (step !== 2 || a.lookup.probing),
    required: stampsRequired,
    phase: (a, call) =>
      call.form === 'soc_up' && a.lookup.writeIndex === undefined ? 'order' : null,
    bind(a, call, ctx) {
      if (call.form === 'feed_head') return FEED_LOOKUP.head(a, call, ctx);
      if (call.form === 'chunk') return FEED_LOOKUP.probe(a, call, ctx);
      if (plain(call)) return 'value';
      return call.form === 'soc_up' ? FEED_LOOKUP.soc(a, ctx, a.lookup.writeIndex) : null;
    },
    body: (a, call, ctx) => (call.form === 'soc_up' ? updateBody(a.reference, ctx.body) : null),
  },

  'swarm.feed:read': {
    setup(a) {
      a.topic = hexParam(param(a.params, 'topic'), 32);
      // readFeedState: a 404 alone falls back to the head probe.
      a.lookup = new IndexLookup({ probeOn: [404] });
    },
    enabled: (a, step) => step !== 1 || a.lookup.probing,
    bind(a, call, ctx) {
      if (call.form === 'feed_head') return FEED_LOOKUP.head(a, call, ctx);
      return FEED_LOOKUP.probe(a, call, ctx);
    },
  },

  'swarm.stamps': {
    setup(a) {
      const id = param(a.params, 'id');
      a.stampId = isNullish(id) ? null : hexParam(id, 32) || '';
    },
    bind(a, call, ctx) {
      if (plain(call)) return 'value';
      if (a.stampId === null) return call.form === 'stamps' ? null : 'value';
      return call.form === 'stamp' && ctx.path['<b>'] === a.stampId ? null : 'value';
    },
  },

  'swarm.upload_status': {
    setup(a) {
      a.uid = uidParam(param(a.params, 'tag_uid'));
    },
    bind: (a, call, ctx) => plain(call) || (a.uid && ctx.path['<uid>'] === a.uid ? null : 'value'),
  },
};

/** A page feed's topic: `params.topic`, lowercased, else keccak256(utf8(key + "/" + name)). */
function feedTopic(a) {
  const topic = param(a.params, 'topic');
  if (!isNullish(topic)) return hexParam(topic, 32);
  return pageTopic(a.key, param(a.params, 'name'));
}

/** `<o>` = `params.owner` when it is truthy; otherwise the core names the site's own. */
function feedOwner(a) {
  const owner = param(a.params, 'owner');
  return truthy(owner) ? ownerParam(owner) || '' : null;
}

/** `<uid>`: a tag uid param as the path writes it. */
function uidParam(value) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

/** Main's own `batch`: given, the row's `stamps` is left out and each upload must name it. */
function mainBatch(a) {
  const batch = param(a.params, 'batch');
  a.batchGiven = !isNullish(batch);
  a.batch = a.batchGiven ? hexParam(batch, 32) || '' : null;
}

/** writeFeedEntry's index: `params.index` once its existence check found none, else the lookup's. */
function writeIndexOf(a) {
  if (a.explicit) return a.free ? a.index : undefined;
  return a.lookup.writeIndex;
}

/** `bytes_up`'s reference, lowercased, from the JSON main returned. */
function uploadReference(body) {
  if (!body) return null;
  try {
    const reference = JSON.parse(body.toString('utf8'))?.reference;
    return typeof reference === 'string' ? reference.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The checks every call takes.

const TEMPLATES = Object.fromEntries(
  Object.entries(FORMS).map(([name, form]) => [name, form.path.split('/')])
);
const isPlaceholder = (segment) => /^<[^>]+>$/.test(segment);
const isLiteral = (pattern) => !pattern.includes('<') && !pattern.includes('|');
const isPairs = (list) =>
  Array.isArray(list) &&
  list.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      typeof pair[1] === 'string'
  );

/** The path's values by placeholder, or null when it isn't the form's. */
function parsePath(form, path) {
  if (typeof path !== 'string') return null;
  const want = TEMPLATES[form];
  const got = path.split('/');
  if (got.length !== want.length) return null;
  const values = {};
  for (let i = 0; i < want.length; i++) {
    if (isPlaceholder(want[i])) values[want[i]] = got[i];
    else if (got[i] !== want[i]) return null;
  }
  return values;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Whether `text` is base64 exactly as its bytes encode: the standard
 * alphabet in groups of four, padded to the end, and the bits a padded
 * group leaves unused all zero. The same test as decoding it and writing it
 * back (what `bytes.toString('base64') === text` asks), without making that
 * second string.
 */
function canonicalBase64(text) {
  if (!BASE64_TEXT.test(text)) return false;
  const end = text.length;
  if (text.endsWith('==')) return (BASE64_ALPHABET.indexOf(text[end - 3]) & 0x0f) === 0;
  if (text.endsWith('=')) return (BASE64_ALPHABET.indexOf(text[end - 2]) & 0x03) === 0;
  return true;
}

/** The body as the call carries it: `{ bytes }` for base64, `{ stream }`, or null; `invalid` when malformed. */
function readBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) return 'invalid';
  const keys = Object.keys(body);
  if (keys.length !== 1) return 'invalid';
  if (keys[0] === 'base64') {
    // Past the inline bound by its length alone: refused undecoded. And
    // canonical by its text, so no second string is written to compare.
    if (typeof body.base64 !== 'string' || body.base64.length > INLINE_BASE64) return 'invalid';
    if (!canonicalBase64(body.base64)) return 'invalid';
    const bytes = Buffer.from(body.base64, 'base64');
    if (bytes.length > INLINE_BODY) return 'invalid';
    return { kind: 'base64', bytes };
  }
  if (keys[0] === 'stream') {
    return Number.isSafeInteger(body.stream) && body.stream >= 0
      ? { kind: 'stream', stream: body.stream }
      : 'invalid';
  }
  return 'invalid';
}

/**
 * Main's answer to a call as the reply handlers read it: a status from 100
 * to 599, the headers' `[name, value]` string pairs, and the body when it
 * is bytes. An answer of any other shape, or one with no such status, is a
 * failed one (null), as `{ failed }` is. Nothing of it is converted before
 * its type is known.
 */
/**
 * Main's header pairs, each read once into a fresh `[name, value]` of two
 * strings: what a handler reads later is what was checked here, whatever
 * getters the answer had (Codex, round 3 on #1336).
 */
function readPairs(headers) {
  const pairs = [];
  const count = headers.length;
  for (let i = 0; i < count; i++) {
    const pair = headers[i];
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const name = pair[0];
    const value = pair[1];
    if (typeof name === 'string' && typeof value === 'string') pairs.push([name, value]);
  }
  return pairs;
}

/**
 * A reply's body as the handlers read it: the bytes, given whole or as the
 * transport's chunks of them, copied once into a fresh Buffer. A copy, not
 * a view: nothing that holds the answer's backing store (a
 * SharedArrayBuffer, a worker) can change the bytes under a handler (Codex,
 * round 4 on #1336). Main's executor charges that one copy
 * (`readsReply`).
 */
function bodyOf(body) {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (!Array.isArray(body)) return undefined;
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const part = body[i];
    if (!(part instanceof Uint8Array)) return undefined;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function readAnswer(reply) {
  try {
    if (!reply || typeof reply !== 'object') return null;
    const { status, headers, body } = reply;
    if (!Number.isInteger(status) || status < 100 || status > 599) return null;
    return {
      status,
      headers: Array.isArray(headers) ? readPairs(headers) : [],
      body: bodyOf(body),
    };
  } catch {
    // A getter that throws: no answer.
    return null;
  }
}

/**
 * One parent's admission: what main admits for it, call by call.
 */
class Admission {
  /**
   * @param {object} options
   * @param {string} options.row - the parent's row (`rowFor`)
   * @param {*} options.params - the params main sent: a page's typed form
   *   read back (swarm-typed.js `readTyped`), or main's own JSON
   * @param {string|null} [options.key] - the page's key (0011)
   */
  constructor({ row, params, key = null }) {
    if (!Object.hasOwn(ROWS, row)) throw new Error(`No grammar row ${row}`);
    this.row = row;
    this.spec = ROWS[row];
    this.params = params;
    this.key = key;
    this.binding = BINDINGS[row];
    this.publish = row.startsWith('swarm.publish:');
    this.forms = new Set(this.spec.calls.flatMap((step) => step.forms));
    this.readyState = 'none';
    this.position = -1;
    this.counts = this.spec.calls.map(() => 0);
    this.open = 0;
    this.maxOpen = row === 'readData' ? READ_DATA_OPEN : 1;
    this.ended = false;
    this.refused = null;
    this.owner = null;
    this.batchGiven = false;
    this.batch = null;
    this.binding.setup?.(this);
  }

  /** Binds `<o>` from the params (null leaves it to the first call that names it). */
  bindOwner(owner) {
    this.owner = owner;
  }

  /** The first call that names `<o>` fixes it; every later one must name the same. */
  fixOwner(owner) {
    if (typeof owner !== 'string' || !HEX40.test(owner)) return false;
    if (this.owner === null) this.owner = owner;
    return owner === this.owner;
  }

  /** `shell.swarm_ready { check }`: null when admitted, else the rule. */
  ready(check) {
    if (this.ended || this.refused) return 'ended';
    let rule = null;
    if (!this.spec.ready) rule = 'form';
    else if (this.readyState !== 'none') rule = 'count';
    else if (check !== this.spec.ready) rule = 'value';
    if (rule) {
      this.refused = rule;
      return rule;
    }
    this.readyState = 'asked';
    return null;
  }

  /** Main answered the ready check: `ok` true or false. */
  readyAnswered(ok) {
    if (this.readyState === 'asked') this.readyState = ok ? 'ok' : 'failed';
  }

  /** The parent ended (replied, cancelled, past its deadline): nothing more is admitted. */
  end() {
    this.ended = true;
  }

  /**
   * Decides one `shell.swarm_api` call before any dial: `{ ticket }` when it
   * is admitted (to `settle` with main's answer), else `{ rule }`, after
   * which every later call of this parent is refused.
   *
   * @param {object} call - `{ form, method, path, query, headers, body,
   *   max_bytes, stream?, feed?, tree? }`, the core's, with `headers`
   *   without main's own
   * @returns {{ ticket: object }|{ rule: string }} - the ticket carries
   *   `bytes`, an inline (`{ base64 }`) body as the check decoded it, so it
   *   is decoded once, for the check and the dial alike
   */
  admit(call) {
    if (this.ended || this.refused) return { rule: 'ended' };
    const rule = this.check(call);
    if (typeof rule === 'string') {
      this.refused = rule;
      return { rule };
    }
    this.counts[rule.step] += 1;
    this.position = rule.step;
    this.open += 1;
    return {
      ticket: {
        step: rule.step,
        form: call.form,
        onReply: rule.onReply,
        bytes: rule.bytes,
        settled: false,
      },
    };
  }

  /**
   * Whether settling `ticket` reads main's answer: only then is its body
   * copied (once, `readAnswer`), and only then does a handler see it. The
   * other calls' answers are never read, so never copied.
   */
  readsReply(ticket) {
    return typeof ticket?.onReply === 'function';
  }

  /**
   * Main answered an admitted call: `reply` is `{ status, headers, body? }`
   * (`headers` as `[name, value]` pairs, `body` the bytes of a whole reply
   * main returned, whole or as the transport's chunks of them), or null for
   * `{ failed }` or a call cancelled unanswered.
   */
  settle(ticket, reply) {
    if (!ticket || ticket.settled) return;
    ticket.settled = true;
    this.open -= 1;
    if (this.ended || this.refused) return;
    ticket.onReply?.(readAnswer(reply));
  }

  /** The call's rule, or `{ step, onReply }` when every check passed. */
  check(call) {
    if (!call || typeof call !== 'object') return 'form';
    const form =
      typeof call.form === 'string' && Object.hasOwn(FORMS, call.form) ? FORMS[call.form] : null;
    if (!form || !this.forms.has(call.form) || call.method !== form.method) return 'form';
    const path = parsePath(call.form, call.path);
    if (!path) return 'form';
    // Every call carries `stream`, which its form fixes.
    if (call.stream !== Boolean(form.reply.stream)) return 'form';
    if (this.spec.ready && this.readyState !== 'ok') return 'order';
    if (this.open >= this.maxOpen) return 'order';
    const step = this.locate(call.form);
    if (typeof step === 'string') return step;
    const phase = this.binding.phase?.(this, call, step);
    if (phase) return phase;
    const query = this.checkQuery(form, call.query);
    if (typeof query === 'string') return query;
    const headers = this.checkHeaders(form, call, step);
    if (typeof headers === 'string') return headers;
    // `max_bytes` is a positive integer before any value is held to it.
    if (!Number.isSafeInteger(call.max_bytes) || call.max_bytes < 1) return 'body';
    const body = readBody(call.body);
    const ctx = { step, path, query, headers, body, onReply: null };
    const value = this.checkValues(form, call, ctx);
    if (value) return value;
    const refused = this.checkBody(form, call, ctx);
    if (refused) return refused;
    return { step, onReply: ctx.onReply, bytes: body?.kind === 'base64' ? body.bytes : null };
  }

  /** The row's step the call takes: the next whose forms have it, past only steps taken or not needed. */
  locate(formName) {
    const steps = this.spec.calls;
    let exhausted = false;
    for (let j = Math.max(this.position, 0); j < steps.length; j++) {
      const enabled = this.binding.enabled ? this.binding.enabled(this, j) : true;
      if (enabled && steps[j].forms.includes(formName)) {
        if (this.counts[j] < steps[j].count[1]) return j;
        exhausted = true;
      }
      const min = enabled
        ? Math.max(steps[j].count[0], this.binding.required?.(this, j) ? 1 : 0)
        : 0;
      if (this.counts[j] < min) break;
    }
    return exhausted ? 'count' : 'order';
  }

  checkQuery(form, pairs) {
    if (!isPairs(pairs)) return 'query';
    if (pairs.length !== form.query.length) return 'query';
    const out = new Map();
    for (const [i, [name, value]] of pairs.entries()) {
      if (name !== form.query[i]) return 'query';
      if (QUERY_SYNTAX[name] && !QUERY_SYNTAX[name].test(value)) return 'query';
      out.set(name, value);
    }
    return out;
  }

  checkHeaders(form, call, step) {
    const headers = call.headers;
    if (!isPairs(headers)) return 'header';
    const rowHeaders = this.binding.rowHeaders?.(this, call, step) || {};
    const allowed = new Map();
    for (const [name, pattern, when] of form.headers) {
      let required = true;
      if (when === 'row') required = Object.hasOwn(rowHeaders, name);
      else if (when === 'publish')
        required = this.publish && param(this.params, 'encrypt') === true;
      else if (when === 'soc-raw') required = this.row === 'writeSingleOwnerChunk';
      if (required) allowed.set(name, { pattern, when });
    }
    const seen = new Map();
    for (const [name, value] of headers) {
      if (seen.has(name)) return 'header';
      seen.set(name, value);
      const spec = allowed.get(name);
      if (!spec) return 'header';
      if (
        spec.when === 'row'
          ? value !== rowHeaders[name]
          : isLiteral(spec.pattern) && value !== spec.pattern
      ) {
        return 'header';
      }
    }
    for (const name of allowed.keys()) if (!seen.has(name)) return 'header';
    return seen;
  }

  checkValues(form, call, ctx) {
    for (const [placeholder, value] of Object.entries(ctx.path)) {
      if (!SYNTAX[placeholder].test(value)) return 'value';
      if (placeholder === '<uid>' && Number(value) > Number.MAX_SAFE_INTEGER) return 'value';
    }
    for (const [name, pattern] of form.headers) {
      if (!ctx.headers.has(name)) continue;
      const value = ctx.headers.get(name);
      if (pattern === '<b>') {
        if (!HEX64.test(value)) return 'value';
        if (this.batchGiven && value !== this.batch) return 'value';
      } else if (pattern === '<content-type>' || pattern === 'true|false') {
        if (value !== this.binding.headerValue?.(this, name)) return 'value';
      }
    }
    return this.binding.bind ? this.binding.bind(this, call, ctx) : 'form';
  }

  checkBody(form, call, ctx) {
    if (form.reply.whole !== undefined && call.max_bytes > form.reply.whole) return 'body';
    const body = ctx.body;
    if (body === 'invalid') return 'body';
    if (form.body === null) return body === null ? null : 'body';
    if (body === null || !form.body.includes(body.kind)) return 'body';
    if (body.kind === 'base64' && form.body_bytes) {
      const [min, most] = form.body_bytes;
      if (body.bytes.length < min || body.bytes.length > most) return 'body';
    }
    return this.binding.body ? this.binding.body(this, call, ctx) : null;
  }
}

/**
 * A parent's row: a page's method (`swarm_readChunk`; `readFeedEntry`'s
 * by whether `params.index` is given) or main's own (`swarm.publish` by
 * its kind, `swarm.feed` by its op, `swarm.stamps`, `swarm.upload_status`).
 * Null for a method with no row.
 *
 * @param {string} method
 * @param {*} params - as the Admission takes them
 * @returns {string|null}
 */
function rowFor(method, params) {
  if (method === 'swarm.publish') {
    const kind = param(params, 'kind');
    if (kind === 'data' || kind === 'file') return 'swarm.publish:data,file';
    return kind === 'collection' ? 'swarm.publish:collection' : null;
  }
  if (method === 'swarm.feed') {
    const op = param(params, 'op');
    return op === 'create' || op === 'update' || op === 'read' ? `swarm.feed:${op}` : null;
  }
  if (method === 'swarm.stamps' || method === 'swarm.upload_status') return method;
  if (typeof method !== 'string' || !method.startsWith('swarm_')) return null;
  const name = method.slice('swarm_'.length);
  if (name === 'readFeedEntry') {
    return isNullish(param(params, 'index')) ? 'readFeedEntry_latest' : 'readFeedEntry_index';
  }
  return name.includes('_') || !Object.hasOwn(ROWS, name) ? null : name;
}

/** The headers main sends for an admitted call: its own, then the call's. */
function requestHeaders(call) {
  return [...Object.entries(MAIN_HEADERS), ...(call.headers || [])];
}

module.exports = {
  Admission,
  B,
  ERROR_REPLY,
  FAILED,
  FORMS,
  HeadProbe,
  INLINE_BASE64,
  IndexLookup,
  MAIN_HEADERS,
  MAX_PROBE_READS,
  MAX_PROBED_INDEX,
  READ_DATA_OPEN,
  REPLY_HEADERS,
  ROWS,
  RULES,
  VALUES,
  canonicalBase64,
  feedIdentifier,
  feedUpdateAddress,
  pageTopic,
  readAnswer,
  requestHeaders,
  rowFor,
  socAddress,
  topicOf,
};
