/**
 * What a collected Radicle result holds in main's heap (freedom-core design
 * 0008, "JSON results": the collection budget is "for the bytes being
 * collected and the parsed value"), measured, for the charge per byte
 * radicle-service-backend.js reserves (CHARGE_PER_BYTE).
 *
 * Run with `node --expose-gc test/helpers/radicle-collected-heap.js`; it
 * prints one JSON line per shape: `{ shape, op, bytes, held }`.
 * radicle-service-backend.test.js runs it in a child process (the measure
 * needs `gc()`), and holds every shape's `held` within its charge.
 *
 * - **The shapes** are those the service writes, each at its op's cap and in
 *   its worst form for main's heap: libradicle's listing entries (`{ rid,
 *   name, description }`, `name` and `description` null for a seeding
 *   policy without a stored repository), `repo_info` with its arrays of
 *   DIDs, and the 64 KiB shapes whose one free-text string fills them. Two
 *   forms are the worst: a text V8 holds at two bytes a character (one
 *   character past U+00FF anywhere makes the whole text so) with string
 *   values of the same kind; and an object-dense listing, many entries with
 *   empty or two-character names, which V8 neither shares nor slices.
 * - **What is measured** is the state at the end of the parse, which the
 *   reservation must cover until the scope settles: the text, decoded as
 *   the backend decodes it (`readText`: chunk by chunk, 64 KiB each), and
 *   the value parsed from it, both alive. (V8 slices a listing's longer
 *   strings out of the text, so its value keeps the text alive anyway.) The
 *   heap and the memory outside it (`heapUsed` + `external`), after
 *   garbage collection, against the same before the body is decoded. A
 *   64 KiB shape is measured over 32 copies held together, so the heap's
 *   granularity doesn't swamp it.
 */

const path = require('path');

const { readText, COLLECTED_CAPS } = require(
  path.join(__dirname, '..', '..', 'src', 'main', 'radicle', 'radicle-service-backend.js')
);

const CHUNK = 64 * 1024;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A character V8 can't hold in one byte: the whole text becomes two-byte. */
const WIDE = String.fromCharCode(0x100);

/** A distinct RID for entry `i`, as libradicle writes one. */
function rid(i) {
  let out = 'rad:z';
  let n = i + 1;
  for (let k = 0; k < 32; k++) {
    out += BASE58[(n + k * 31) % 58];
    n = Math.floor(n / 58) + k;
  }
  return out;
}

/** A distinct DID for `i`. */
const did = (i) => `did:key:z6Mk${rid(i).slice(5)}${rid(i + 7).slice(5, 17)}`;

/** A distinct two-character name for `i`, as no string V8 shares. */
const two = (i) =>
  String.fromCharCode(0x61 + (i % 26)) + String.fromCharCode(0x61 + (Math.floor(i / 26) % 26));

/** A listing of entries from `entry(i)`, as close to `bytes` as it fits,
 * with `tail` (an entry's JSON) last, if given. */
function listing(bytes, entry, tail = null) {
  const parts = [];
  let size = 2 + (tail ? Buffer.byteLength(tail) + 1 : 0);
  for (let i = 0; ; i++) {
    const json = JSON.stringify(entry(i));
    const next = Buffer.byteLength(json) + 1;
    if (size + next > bytes) break;
    parts.push(json);
    size += next;
  }
  if (tail) parts.push(tail);
  return `[${parts.join(',')}]`;
}

/** One entry with a character past U+00FF: the whole text two-byte. */
const WIDE_TAIL = JSON.stringify({ rid: rid(1e9), name: WIDE, description: '' });

/** An object of `base`, its string `key` grown to fill `bytes`, wide. */
function filled(bytes, base, key) {
  const room = bytes - Buffer.byteLength(JSON.stringify({ ...base, [key]: '' })) - 2;
  return JSON.stringify({ ...base, [key]: WIDE + 'x'.repeat(room) });
}

const REPO_INFO = {
  rid: rid(1),
  name: 'name',
  description: '',
  defaultBranch: 'main',
  head: 'a'.repeat(40),
  delegates: [did(1)],
  threshold: 1,
  visibility: { type: 'public' },
  issuesOpen: 0,
  patchesOpen: 0,
};

/** Each shape: its op, and its JSON at `bytes`. */
const SHAPES = {
  'listing: long strings, two-byte': {
    op: 'list_repos',
    json: (bytes) =>
      listing(bytes, (i) => ({ rid: rid(i), name: `n${i}`, description: WIDE + 'x'.repeat(4000) })),
  },
  'listing: two-character names, two-byte text': {
    op: 'list_repos',
    json: (bytes) =>
      listing(bytes, (i) => ({ rid: rid(i), name: two(i), description: two(i + 1) }), WIDE_TAIL),
  },
  'listing: empty names, two-byte text': {
    op: 'list_repos',
    json: (bytes) => listing(bytes, (i) => ({ rid: rid(i), name: '', description: '' }), WIDE_TAIL),
  },
  'listing: seeding policies (null names), two-byte text': {
    op: 'list_seeded_repos',
    json: (bytes) =>
      listing(bytes, (i) => ({ rid: rid(i), name: null, description: null }), WIDE_TAIL),
  },
  'listing: one two-byte character names': {
    op: 'list_seeded_repos',
    json: (bytes) =>
      listing(bytes, (i) => ({
        rid: rid(i),
        name: String.fromCharCode(0x100 + (i % 3000)),
        description: String.fromCharCode(0x100 + ((i + 7) % 3000)),
      })),
  },
  'repo_info: a private allow list of DIDs': {
    op: 'repo_info',
    json: (bytes) => {
      const info = { ...REPO_INFO, visibility: { type: 'private', allow: [] } };
      for (let i = 0; Buffer.byteLength(JSON.stringify(info)) + 80 < bytes; i++) {
        info.visibility.allow.push(did(i));
      }
      return JSON.stringify(info);
    },
  },
  'repo_info: a long description, two-byte': {
    op: 'repo_info',
    json: (bytes) => filled(bytes, REPO_INFO, 'description'),
  },
  'node_info: a long repos_error, two-byte': {
    op: 'node_info',
    json: (bytes) =>
      filled(bytes, { connected_peers: 1, repos_total: null, repos_error: '' }, 'repos_error'),
  },
  'identity: a long alias, two-byte': {
    op: 'identity',
    json: (bytes) => filled(bytes, { did: did(1), nid: did(1).slice(8), alias: '' }, 'alias'),
  },
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The heap and the memory outside it, after collecting what's garbage. */
async function used() {
  for (let i = 0; i < 4; i++) {
    global.gc();
    await tick();
  }
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external;
}

/** A byte stream of `bytes` in 64 KiB chunks, as the client hands a body. */
function bodyOf(bytes) {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(at, at + CHUNK));
      at += CHUNK;
    },
  });
}

/** What `copies` of `json`, decoded and parsed, hold at the parse's end. */
async function measure(json, copies) {
  const bytes = Buffer.from(json);
  const base = await used();
  const held = [];
  for (let k = 0; k < copies; k++) {
    const text = await readText(bodyOf(bytes).getReader(), bytes.length);
    held.push(text, JSON.parse(text));
  }
  const after = await used();
  // The array that holds them isn't the result's.
  return { bytes: bytes.length * copies, held: after - base - held.length * 8 };
}

async function main() {
  if (typeof global.gc !== 'function') throw new Error('run with node --expose-gc');
  for (const [shape, { op, json }] of Object.entries(SHAPES)) {
    const cap = COLLECTED_CAPS[op];
    const text = json(cap);
    const size = Buffer.byteLength(text);
    if (size > cap || size < cap * 0.98) throw new Error(`${shape}: ${size} bytes, not its cap`);
    const copies = cap <= 64 * 1024 ? 32 : 1;
    const { bytes, held } = await measure(text, copies);
    process.stdout.write(`${JSON.stringify({ shape, op, bytes, held })}\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}

module.exports = { SHAPES };
