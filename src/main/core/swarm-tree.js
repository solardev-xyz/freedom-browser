/**
 * Main's Swarm chunk arithmetic and file-tree reader (freedom-core design
 * 0015, "Values main derives from its own replies"): the BMT a chunk's
 * address is, and the occurrences of a file tree that `readData`'s walk may
 * fetch, read from the chunks main itself returned to the core.
 *
 * - **The BMT** (`chunkAddress`): keccak256(span ‖ the binary Merkle root
 *   of the payload, zero-padded to 4,096 bytes), 128 hashes a chunk, on
 *   ethers' keccak256. The grammar checks a wrapped chunk's address and a
 *   large feed write's root with it; held to `vectors/swarm.json`'s trees.
 * - **An intermediate chunk** (`intermediate`), read as `fc_swarm::tree`
 *   reads it (Ant's joiner, design 0009's *Files*): the trailing all-zero
 *   references dropped (Bee's padding), the parity count taken from the
 *   chunk's own span with Bee's parity tables, and the data references
 *   before the parities, each with the logical length its parent's
 *   geometry gives it (never its own span). A chunk the core would refuse
 *   (no whole references, none left, more than 128, or as many parities as
 *   references) gives none.
 * - **The occurrences** (`Occurrences`): a `Map` from address, logical
 *   length and depth to the count of unfetched slots. One valid chunk can
 *   sit at two positions with two lengths, or at two depths, and each is
 *   its own key; repeated content (a file of zeros) is one key with many
 *   slots. A logical leaf adds nothing; an intermediate adds its data
 *   children of positive length one level deeper, except one that isn't a
 *   leaf at depth 8, where 0009's walk ends `unverifiable` instead. Parity
 *   references never enter. Each slot is fetched at most once, and the slots
 *   are at most `MAX_SLOTS`, the row's call cap; past it nothing more is
 *   admitted, as the core's walk refuses such a tree first.
 *
 * Main doesn't check the chunks it returned: the core checks every one.
 * Lengths are BigInts here, as a span is 64 bits; `readData` holds them to
 * 5 MiB before it walks.
 */

const { keccak256 } = require('ethers');

const CHUNK_SIZE = 4096;
const SPAN_SIZE = 8;
const REF_SIZE = 32;
/** The most references an intermediate chunk holds. */
const MAX_REFS = 128;
/** 0009's walk (fc-dweb's `MAX_LEVELS`): no intermediate is read at depth 8. */
const MAX_DEPTH = 8;
/** The occurrences' cap: 2 + 2⌈B / 4,096⌉ for B = 5 MiB (readData's row). */
const MAX_SLOTS = 2 + 2 * Math.ceil((5 * 1024 * 1024) / CHUNK_SIZE);
/** What one slot is charged in the Swarm I/O pool (design 0015). */
const SLOT_CHARGE = 256;

const CHUNK = BigInt(CHUNK_SIZE);
const U64_MAX = (1n << 64n) - 1n;

/** keccak256 of `bytes`, as 32 bytes. */
function keccak(bytes) {
  return Buffer.from(keccak256(bytes).slice(2), 'hex');
}

/**
 * The BMT root of a payload of 0 to 4,096 bytes, zero-padded to 4,096; null
 * for a longer one.
 *
 * @param {Uint8Array} payload
 * @returns {Buffer|null}
 */
function bmtRoot(payload) {
  if (payload.length > CHUNK_SIZE) return null;
  let level = Buffer.alloc(CHUNK_SIZE);
  level.set(payload);
  for (let width = CHUNK_SIZE; width > REF_SIZE; width /= 2) {
    const next = Buffer.alloc(width / 2);
    for (let at = 0; at < width; at += 2 * REF_SIZE) {
      next.set(keccak(level.subarray(at, at + 2 * REF_SIZE)), at / 2);
    }
    level = next;
  }
  return level;
}

/**
 * A content-addressed chunk's address: keccak256(span ‖ BMT root), in
 * lowercase hex; null for a payload past 4,096 bytes.
 *
 * @param {Uint8Array} span - 8 bytes, little-endian
 * @param {Uint8Array} payload
 * @returns {string|null}
 */
function chunkAddress(span, payload) {
  if (span.length !== SPAN_SIZE) return null;
  const root = bmtRoot(payload);
  if (!root) return null;
  return keccak(Buffer.concat([span, root])).toString('hex');
}

/** The address of a chunk as the node stores it, `span ‖ payload` (8 to 4,104 bytes); null otherwise. */
function wireAddress(wire) {
  if (wire.length < SPAN_SIZE || wire.length > SPAN_SIZE + CHUNK_SIZE) return null;
  return chunkAddress(wire.subarray(0, SPAN_SIZE), wire.subarray(SPAN_SIZE));
}

/** `span` as 8 bytes, little-endian. */
function spanBytes(size) {
  const span = Buffer.alloc(SPAN_SIZE);
  span.writeBigUInt64LE(BigInt(size));
  return span;
}

/**
 * A span's redundancy level and its size without it (Bee's `DecodeSpan`;
 * chunk-service.js's `dataSizeFromSpan`): a top byte past 128 is the level,
 * and is cleared.
 *
 * @param {Uint8Array} span - 8 bytes
 * @returns {{ level: number, size: bigint }}
 */
function decodeSpan(span) {
  const plain = Buffer.from(span.subarray(0, SPAN_SIZE));
  let level = 0;
  if (plain[SPAN_SIZE - 1] > 128) {
    level = plain[SPAN_SIZE - 1] & 0x7f;
    plain[SPAN_SIZE - 1] = 0;
  }
  return { level, size: plain.readBigUInt64LE(0) };
}

// Bee's parity tables (pkg/file/redundancy/level.go, which Ant's rs.rs and
// fc_swarm::tree copy): [at least this many data shards, parities].
const MEDIUM = [
  [95, 9],
  [69, 8],
  [47, 7],
  [29, 6],
  [15, 5],
  [6, 4],
  [2, 3],
  [1, 2],
];
const STRONG = [
  [105, 21],
  [96, 20],
  [87, 19],
  [78, 18],
  [70, 17],
  [62, 16],
  [54, 15],
  [47, 14],
  [40, 13],
  [33, 12],
  [27, 11],
  [21, 10],
  [16, 9],
  [11, 8],
  [7, 7],
  [4, 6],
  [2, 5],
  [1, 4],
];
const INSANE = [
  [93, 31],
  [88, 30],
  [83, 29],
  [78, 28],
  [74, 27],
  [69, 26],
  [64, 25],
  [60, 24],
  [55, 23],
  [51, 22],
  [46, 21],
  [42, 20],
  [38, 19],
  [34, 18],
  [30, 17],
  [27, 16],
  [23, 15],
  [20, 14],
  [17, 13],
  [14, 12],
  [11, 11],
  [9, 10],
  [6, 9],
  [4, 8],
  [3, 7],
  [2, 6],
  [1, 5],
];
const PARANOID = [
  [37, 89],
  [36, 87],
  [35, 86],
  [34, 84],
  [33, 83],
  [32, 81],
  [31, 80],
  [30, 78],
  [29, 76],
  [28, 75],
  [27, 73],
  [26, 71],
  [25, 70],
  [24, 68],
  [23, 66],
  [22, 65],
  [21, 63],
  [20, 61],
  [19, 59],
  [18, 58],
  [17, 56],
  [16, 54],
  [15, 52],
  [14, 50],
  [13, 48],
  [12, 47],
  [11, 45],
  [10, 43],
  [9, 40],
  [8, 38],
  [7, 36],
  [6, 34],
  [5, 31],
  [4, 29],
  [3, 26],
  [2, 23],
  [1, 19],
];
const TABLES = [null, MEDIUM, STRONG, INSANE, PARANOID];

/** Parities for `shards` data shards at `level` (Bee's `GetParities`). */
function parities(level, shards) {
  const table = TABLES[level];
  if (!table) return 0;
  const row = table.find(([min]) => shards >= min);
  return row ? row[1] : 0;
}

/** The most data references a full intermediate holds at `level`: 128, 119, 107, 97 or 39. */
function maxShards(level) {
  return MAX_REFS - parities(level, MAX_REFS);
}

const satMul = (a, b) => (a * b > U64_MAX ? U64_MAX : a * b);
const satAdd = (a, b) => (a + b > U64_MAX ? U64_MAX : a + b);
const satSub = (a, b) => (a > b ? a - b : 0n);

/** The data shards a node of `span` bytes holds at `branching` (Bee's `ReferenceCount`, saturating as Ant does). */
function dataShards(span, branching) {
  let branchSize = CHUNK;
  let branchLevel = 1;
  while (branchSize < span) {
    branchSize = satMul(branchSize, branching);
    branchLevel += 1;
  }
  let referenceSize = CHUNK;
  for (let i = 1; i + 1 < branchLevel; i++) referenceSize = satMul(referenceSize, branching);
  let shards = 1;
  let offset = referenceSize;
  while (offset < span) {
    offset = satAdd(offset, referenceSize);
    shards += 1;
  }
  return shards;
}

/** A chunk's own parity count, from its own span (Ant's `chunk_meta`). */
function ownParities(span) {
  const { level, size } = decodeSpan(span);
  if (level === 0 || size <= CHUNK) return 0;
  return parities(level, dataShards(size, BigInt(maxShards(level))));
}

/** Each data child's capacity but the last's (Bee's `subtrieSection`). */
function branchSize(refs, span, branching) {
  const before = BigInt(refs) - 1n;
  let branch = CHUNK;
  for (;;) {
    if (satSub(span, satMul(branch, before)) <= branch) return branch;
    if (branch > U64_MAX / branching) return branch;
    branch *= branching;
  }
}

/**
 * Reads a chunk main returned (`span ‖ payload`) as an intermediate node of
 * `length` logical bytes: its level, its parity count, and its data
 * children in order, each `{ address, length }` (BigInt). Null where
 * `fc_swarm::tree::intermediate` refuses it.
 *
 * @param {Uint8Array} wire
 * @param {bigint} length
 * @returns {{ level: number, parities: number, children: { address: string, length: bigint }[] }|null}
 */
function intermediate(wire, length) {
  if (wire.length < SPAN_SIZE) return null;
  const span = wire.subarray(0, SPAN_SIZE);
  const payload = wire.subarray(SPAN_SIZE);
  if (payload.length % REF_SIZE !== 0) return null;
  let effective = payload.length;
  while (
    effective >= REF_SIZE &&
    payload.subarray(effective - REF_SIZE, effective).every((b) => b === 0)
  ) {
    effective -= REF_SIZE;
  }
  const refs = effective / REF_SIZE;
  if (refs === 0 || refs > MAX_REFS) return null;
  const { level } = decodeSpan(span);
  const parityCount = ownParities(span);
  if (parityCount >= refs) return null;
  const shards = refs - parityCount;
  const branching = BigInt(level === 0 ? MAX_REFS : maxShards(level));
  const branch = branchSize(shards, length, branching);
  const children = [];
  for (let i = 0; i < shards; i++) {
    const address = Buffer.from(payload.subarray(i * REF_SIZE, (i + 1) * REF_SIZE)).toString('hex');
    const rest = satSub(length, satMul(branch, BigInt(i)));
    children.push({ address, length: i + 1 === shards || rest < branch ? rest : branch });
  }
  return { level, parities: parityCount, children };
}

/** Whether an entry of `length` logical bytes is a leaf: one chunk's worth or fewer. */
function isLeaf(length) {
  return BigInt(length) <= CHUNK;
}

/**
 * A request's file-tree occurrences: what `readData`'s later `chunk` calls
 * may fetch, each slot once.
 */
class Occurrences {
  /**
   * @param {{ maxSlots?: number }} [options]
   */
  constructor({ maxSlots = MAX_SLOTS } = {}) {
    this.maxSlots = maxSlots;
    // `${address}/${length}/${depth}` → unfetched slots. A key that is
    // named stays, at 0, once its slots are taken.
    this.map = new Map();
    this.slots = 0;
    this.over = false;
  }

  static key(address, length, depth) {
    return `${address}/${length}/${depth}`;
  }

  /**
   * Adds the data children of the chunk main returned for an occurrence of
   * `length` logical bytes at `depth` (the root: its own decoded span, at
   * 0). A leaf adds nothing. Returns whether the chunk was read as an
   * intermediate.
   *
   * @param {Uint8Array} wire
   * @param {bigint|number} length
   * @param {number} depth
   */
  addChildren(wire, length, depth) {
    const logical = BigInt(length);
    if (this.over || isLeaf(logical)) return false;
    const node = intermediate(wire, logical);
    if (!node) return false;
    const childDepth = depth + 1;
    const added = node.children.filter(
      (child) => child.length > 0n && (isLeaf(child.length) || childDepth < MAX_DEPTH)
    );
    if (this.slots + added.length > this.maxSlots) {
      // The core's walk refuses a tree past the cap before it fetches more.
      this.over = true;
      return true;
    }
    for (const child of added) {
      const key = Occurrences.key(child.address, child.length, childDepth);
      this.map.set(key, (this.map.get(key) || 0) + 1);
    }
    this.slots += added.length;
    return true;
  }

  /**
   * Takes one unfetched slot of the occurrence `address` at `length` and
   * `depth`: null when there was one, `value` for an occurrence the tree
   * doesn't name, `count` when its slots are taken or the tree passed the
   * cap.
   *
   * @returns {null|'value'|'count'}
   */
  take(address, length, depth) {
    if (this.over) return 'count';
    const logical = typeof length === 'bigint' || Number.isSafeInteger(length) ? BigInt(length) : null;
    if (typeof address !== 'string' || logical === null || !Number.isSafeInteger(depth)) return 'value';
    const key = Occurrences.key(address, logical, depth);
    const left = this.map.get(key);
    if (left === undefined) return 'value';
    if (left === 0) return 'count';
    this.map.set(key, left - 1);
    return null;
  }

  /** Every unfetched slot, as `[address, length, depth, count]`. */
  *unfetched() {
    for (const [key, left] of this.map) {
      if (left === 0) continue;
      const [address, length, depth] = key.split('/');
      yield [address, BigInt(length), Number(depth), left];
    }
  }
}

module.exports = {
  CHUNK_SIZE,
  MAX_DEPTH,
  MAX_REFS,
  MAX_SLOTS,
  SLOT_CHARGE,
  SPAN_SIZE,
  Occurrences,
  bmtRoot,
  chunkAddress,
  decodeSpan,
  intermediate,
  isLeaf,
  keccak,
  maxShards,
  parities,
  spanBytes,
  wireAddress,
};
