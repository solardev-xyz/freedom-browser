/**
 * Main's side of design 0016's APDU grammar (freedom-core design 0016,
 * `shell.ledger_apdu`, The APDU grammar, Bounds; LDG-3's PR 1): which APDUs
 * a running Ledger operation (the **parent**) may put on the device, in
 * which order and with which bytes.
 *
 * - **The rows, the rules and the bounds** are data: `ROWS`, `RULES` and
 *   `BOUNDS`, as `vectors/ledger-grammar.json` writes them. They ship here
 *   as JavaScript and aren't read from any file at runtime (LDG-3 plan,
 *   point 1); `ledger-grammar.vectors.test.js` holds them, every honest
 *   stream and every forbidden APDU, to the pinned core's file, and reads
 *   the 2,048-APDU bound from its `bounds.apdus_per_operation`, so a changed
 *   bound arrives with a pin bump. The headers the streams use are the
 *   rows' (`HEADERS`).
 * - **Paths** (deviation `path-strict`): only the two schemes' texts, `live`
 *   `44'/60'/i'/0/0` and `legacy` `44'/60'/0'/i`, `i` from 0 to 2^31 − 1,
 *   written exactly as a scheme writes them; `P` is the number of elements,
 *   then each as 4 bytes, big-endian, `0x80000000` set for a hardened one.
 * - **Each operation's whole expected stream** is built by main from what
 *   main itself holds (plan, point 2), never from the core: the params of
 *   the parent it sent, the record's path from its own snapshot
 *   (`getWalletRecord`), and for discovery's check its own list of the
 *   records no device has matched (`getLedgerRecordsToCheck`), compared
 *   strictly. Discovery: `E0 02 00 00 P` for the scheme's paths from `start`,
 *   then one for each such record at a scheme's path, the first 20. Adding:
 *   `E0 02 01 00 P`, the display on. Every signature: `E0 02 00 00 P`, then
 *   `B0 01 00 00`, then a transaction's `P ‖ T` (`E0 04`) in pieces of 255,
 *   a legacy one's in the size hw-app-eth's `safeChunkTransaction` picks
 *   (`transactionPieceSize`), with `T` ethers' unsigned serialization of the
 *   `tx` main sent, as signing-utils.js reads it; or a message's
 *   `P ‖ len(m) ‖ m` (`E0 08`), the first piece 150 − 5 − 4n bytes of `m`,
 *   then 150 at a time; or typed data's definitions and values, then
 *   `E0 0C 00 01 P`, from main's typed-data binding (below). What main can't
 *   derive, or a stream of more than 2,048 APDUs, is a `GrammarError`
 *   before anything is admitted: the core refuses the same inputs before
 *   the first APDU (`path-strict`, `empty-message`, `device-bounds`).
 * - **An `Admission` per parent** decides each `shell.ledger_apdu` before a
 *   byte reaches the device, by the design's rules: one APDU at a time, and
 *   each the next of main's stream byte for byte. Otherwise the APDU is
 *   refused with its rule: `header` for an `Lc` that isn't the data's
 *   length or a `CLA INS P1 P2` the row doesn't have there (`E0 02 01 00`
 *   outside `ledger.add` among them); `count` for the address check, `B0 01`
 *   or `E0 0C` sent again; `order` for one of the stream's APDUs out of its
 *   place (a later one, a later record's check in discovery, the hash-only
 *   APDU without its gate, or any APDU while one is unanswered); `path` for
 *   other bytes where the row has `P`; `payload` for other bytes after
 *   them; `ended` for any APDU after the operation's last, after a status
 *   other than `9000` (but the hash-only one), a `{ failed }`, a cancel or
 *   the parent's end, and for every APDU after a refusal. `parent` is the
 *   relay's: `operationOf` names the operation a parent opens, null for one
 *   that opens none (a vault key's `sign.*`, and `safe.sign_owner` and
 *   `safe.message_sign` until SAFE-3, plan point 11).
 * - **The hash-only gate** (Q23): `E0 0C 00 00 P ‖ domainSeparator ‖
 *   structHash` is admitted only as the APDU after the operation's first
 *   `E0 1A`, once main answered that APDU's `6D00` with
 *   `{ answer, hash_only: "shown" }` (`answered({ answer, hashOnly: true })`,
 *   which only that answer may carry: `isHashOnlyAnswer`).
 *
 * **The typed-data stream** (main's typed-data binding, LDG-3's PR 2,
 * `wallet/ledger/apdu-binding.js`): an Admission for `sign.typed_data` or
 * `x402.settle { reservation, typed_data }` takes `typedData`, built by the
 * binding from the typed data main sent (for x402, main's own rebuild),
 * never from the core:
 *
 *     { apdus: Buffer[], domainSeparator: Buffer, structHash: Buffer }
 *
 * - `apdus`: the definitions, then the values, each a whole APDU
 *   (`CLA INS P1 P2 Lc data`, framed with `apdu()` and the rows' `HEADERS`),
 *   in the rows' order. The first is `E0 1A 00 00` (the operation's first
 *   `E0 1A`, whose `6D00` opens the gate); each is `E0 1A 00 00` or `00 FF`
 *   until the first `E0 1C`, then `E0 1C 00 00`, `00 0F`, `01 FF` or
 *   `00 FF`; the address check, `B0 01` and `E0 0C` are the Admission's own.
 * - `domainSeparator` and `structHash`: ethers' hashes of the same typed
 *   data, 32 bytes each, the hash-only APDU's data after `P`, which the
 *   hash-only warning shows.
 *
 * The binding refuses whatever it can't encode before the parent is sent;
 * a stream not of this shape, or one that makes more than
 * `BOUNDS.apdus_per_operation` APDUs with the address check, `B0 01` and
 * `E0 0C`, is a `GrammarError`. The Safe rows join with SAFE-3's binding.
 *
 * Its caller is main's relay for `shell.ledger_apdu` (LDG-3's PR 6,
 * core/ledger-relay.js), one Admission per parent it opens. Nothing calls
 * it yet.
 */

const { Transaction, encodeRlp, toBeArray } = require('ethers');

// The rows, the rules and the bounds, as vectors/ledger-grammar.json writes
// them (design 0016, The APDU grammar, Bounds). `from` and `times` are the
// design's text; the streams below take their headers from these rows.

/** Design 0016's rows in order: each APDU's header, its data, how many, where its bytes come from, and whether it waits for the user. */
const ROWS = [
  {
    row: 'ledger.accounts',
    apdus: [
      { header: 'e0020000', data: 'P(path_k)', times: 'c, 1 to 20' },
      { header: 'e0020000', data: 'P(path_j)', times: 'r, 0 to 20' },
    ],
    from: "the scheme's paths for start … start + c − 1; then the path of each Ledger record no device has matched (unchecked or mismatched), in the wallet list's order, at most 20 (D1)",
    waits: false,
  },
  {
    row: 'ledger.add',
    apdus: [{ header: 'e0020100', data: 'P', times: 1 }],
    from: 'the path asked (question 3)',
    waits: true,
  },
  {
    row: 'signature.first',
    apdus: [{ header: 'e0020000', data: 'P', times: 1 }],
    from: "the record's path",
    waits: false,
  },
  {
    row: 'signature.second',
    apdus: [{ header: 'b0010000', data: '', times: 1 }],
    from: '—',
    waits: false,
  },
  {
    row: 'sign.transaction',
    apdus: [
      { header: 'e0040000', data: 'the first piece of P ‖ T', times: 1 },
      { header: 'e0048000', data: 'each other piece', times: 'the rest' },
    ],
    from: "the bound transaction (its nonce main chose); pieces of 255, for type 0 the size hw-app-eth's safeChunkTransaction picks",
    waits: 'the last piece',
  },
  {
    row: 'sign.message',
    apdus: [
      {
        header: 'e0080000',
        data: 'P ‖ len(m) (4 bytes) ‖ the first 150 − 5 − 4n bytes',
        times: 1,
      },
      { header: 'e0088000', data: 'each next 150 bytes', times: 'the rest' },
    ],
    from: 'the bound bytes m, at least 1',
    waits: 'the last',
  },
  {
    row: 'sign.typed_data.definitions',
    apdus: [
      { header: 'e01a0000', data: "a type's name", times: 'each type, ascending' },
      { header: 'e01a00ff', data: "a field's descriptor", times: 'each field in order' },
    ],
    from: "the bound typed data's types, EIP712Domain from the domain's keys as getPayload builds it",
    waits: false,
  },
  {
    row: 'sign.typed_data.values',
    apdus: [
      { header: 'e01c0000', data: '"EIP712Domain", then the primary type\'s name', times: 2 },
      { header: 'e01c000f', data: "an array's length", times: 'each array' },
      { header: 'e01c01ff', data: "a value's piece but the last", times: 'each but the last' },
      { header: 'e01c00ff', data: "a value's last piece", times: 'each value' },
    ],
    from: "the core's parse of the bound values, encoded as EIP712_TYPE_ENCODERS encode them, in pieces of 255",
    waits: false,
  },
  {
    row: 'sign.typed_data.sign',
    apdus: [{ header: 'e00c0001', data: 'P', times: 1 }],
    from: "the record's path",
    waits: true,
  },
  {
    row: 'hash-only',
    apdus: [{ header: 'e00c0000', data: 'P ‖ domainSeparator ‖ hashStruct(message)', times: 1 }],
    from: 'fc-evm\'s hashes of the bound typed data; only after 6D00 answered the operation\'s first E0 1A and main answered hash_only: "shown"',
    waits: true,
  },
  {
    row: 'x402.settle',
    apdus: 'as sign.typed_data, over the reserved authorization',
    from: "main's own rebuild of it, which it sent as typed_data (x402.settle { reservation, typed_data }, a Ledger account, D2)",
    waits: true,
  },
  {
    row: 'safe.sign_owner',
    apdus: "as sign.typed_data, over the core's SafeTx",
    from: 'the approved SafeTx, which main derives from its own record',
    waits: true,
  },
  {
    row: 'safe.message_sign',
    apdus: "as sign.typed_data, over the core's SafeMessage",
    from: "the session's SafeMessage, which main derives from the page's request it holds",
    waits: true,
  },
];

/** The rules a refused APDU is answered with (`invalid_argument`, `data: { rule }`). */
const RULES = {
  parent:
    "the APDU names a parent that is not live, not one of the rows' operations, or not for a Ledger account",
  order:
    "an APDU of the row out of its place: swapped, skipped, or the hash-only APDU without its 6D00 or before main's hash_only answer",
  header:
    "CLA INS P1 P2 that the row doesn't have at that point (E0 02 01 00 outside ledger.add among them), or an Lc that isn't the data's length",
  count: 'an APDU the row sends once (the address check, B0 01, E0 0C), sent again',
  path: 'another path where the row has P',
  payload:
    "the right header with other data: main's own stream, built from what it holds, has other bytes there",
  ended: "any APDU after the operation's last",
};

/** What a Ledger can carry (design 0016, Bounds). */
const BOUNDS = {
  apdu_data_bytes: 255,
  apdus_per_operation: 2048,
  value_encoding_bytes: 65535,
  array_entries: 255,
  fixed_size: 255,
  dimensions: 255,
  name_bytes: 255,
};

/** `ledger.accounts`: 1 to 20 paths (`c`), then at most 20 records' checks (`r`). */
const MAX_ACCOUNTS = 20;
const MAX_CHECKS = 20;
/** The largest index a scheme's path takes: 2^31 − 1. */
const MAX_INDEX = 2 ** 31 - 1;
/** A message's pieces after the first: 150 bytes; the first holds `P ‖ len(m)` and 150 − 5 − 4n bytes of `m`. */
const MESSAGE_PIECE = 150;
/** An APDU: `CLA INS P1 P2 Lc`, then at most 255 bytes. */
const APDU_HEAD = 5;
const STATUS_OK = 0x9000;
/** "Instruction not supported": after the operation's first `E0 1A`, the hash-only form may follow (Q23). */
const STATUS_HASH_ONLY = Buffer.from([0x6d, 0x00]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}
deepFreeze(ROWS);
deepFreeze(RULES);
deepFreeze(BOUNDS);

function rowHeader(name, k) {
  const row = ROWS.find((r) => r.row === name);
  return Buffer.from(row.apdus[k].header, 'hex');
}

/** Each APDU's `CLA INS P1 P2`, from the rows. */
const HEADERS = Object.freeze({
  address: rowHeader('signature.first', 0),
  addressDisplay: rowHeader('ledger.add', 0),
  app: rowHeader('signature.second', 0),
  transactionFirst: rowHeader('sign.transaction', 0),
  transactionMore: rowHeader('sign.transaction', 1),
  messageFirst: rowHeader('sign.message', 0),
  messageMore: rowHeader('sign.message', 1),
  typeName: rowHeader('sign.typed_data.definitions', 0),
  typeField: rowHeader('sign.typed_data.definitions', 1),
  root: rowHeader('sign.typed_data.values', 0),
  array: rowHeader('sign.typed_data.values', 1),
  valueMore: rowHeader('sign.typed_data.values', 2),
  valueLast: rowHeader('sign.typed_data.values', 3),
  signFields: rowHeader('sign.typed_data.sign', 0),
  signHashes: rowHeader('hash-only', 0),
});

/**
 * What main can't derive a stream from, refused before anything is
 * admitted. `deviation` is design 0016's, where the core refuses the same
 * input before the first APDU (`path-strict`, `empty-message`,
 * `device-bounds`), else `params` (params main itself never sends) or
 * `typed-data-stream` (a typed-data stream not of the binding's shape).
 */
class GrammarError extends Error {
  constructor(deviation, message) {
    super(message);
    this.name = 'GrammarError';
    this.deviation = deviation;
  }
}

/** One APDU: `CLA INS P1 P2 Lc data`, its data at most 255 bytes. */
function apdu(header, data = Buffer.alloc(0)) {
  if (data.length > BOUNDS.apdu_data_bytes) {
    throw new GrammarError('device-bounds', `an APDU's data of ${data.length} bytes`);
  }
  return Buffer.concat([Buffer.from(header), Buffer.from([data.length]), Buffer.from(data)]);
}

const isBytes = (value) => value instanceof Uint8Array;

/** An APDU whose `Lc` is its data's length, 5 to 260 bytes. */
const framed = (bytes) =>
  isBytes(bytes) &&
  bytes.length >= APDU_HEAD &&
  bytes.length <= APDU_HEAD + BOUNDS.apdu_data_bytes &&
  bytes[4] === bytes.length - APDU_HEAD;

const sameHeader = (a, b) => Buffer.compare(a.subarray(0, 4), b.subarray(0, 4)) === 0;
const same = (a, b) => Buffer.compare(a, b) === 0;

// ---------------------------------------------------------------------------
// Paths (deviation path-strict)

const HARDENED = 0x80000000;
const SCHEMES = Object.freeze({
  live: (i) => `44'/60'/${i}'/0/0`,
  legacy: (i) => `44'/60'/0'/${i}`,
});
const LIVE = /^44'\/60'\/(0|[1-9][0-9]{0,9})'\/0\/0$/;
const LEGACY = /^44'\/60'\/0'\/(0|[1-9][0-9]{0,9})$/;

const isIndex = (i) => Number.isSafeInteger(i) && i >= 0 && i <= MAX_INDEX;

/** A record's path text as `{ scheme, index }`, or null when it isn't exactly a scheme's. */
function parsePath(text) {
  if (typeof text !== 'string') return null;
  const live = LIVE.exec(text);
  const legacy = live ? null : LEGACY.exec(text);
  const match = live || legacy;
  if (!match) return null;
  const index = Number(match[1]);
  return isIndex(index) ? { scheme: live ? 'live' : 'legacy', index } : null;
}

/** `P` for a scheme's index. */
function encodePath({ scheme, index }) {
  if (!Object.hasOwn(SCHEMES, scheme) || !isIndex(index)) {
    throw new GrammarError('path-strict', "not a scheme's path");
  }
  const elements =
    scheme === 'live'
      ? [44 + HARDENED, 60 + HARDENED, index + HARDENED, 0, 0]
      : [44 + HARDENED, 60 + HARDENED, HARDENED, index];
  const out = Buffer.alloc(1 + 4 * elements.length);
  out[0] = elements.length;
  elements.forEach((element, k) => out.writeUInt32BE(element, 1 + 4 * k));
  return out;
}

/** `P` for a record's path text; anything but a scheme's text is refused. */
function pathBytes(text) {
  const parsed = parsePath(text);
  if (!parsed) throw new GrammarError('path-strict', "not a scheme's path");
  return encodePath(parsed);
}

/**
 * The records discovery checks (D1), from main's list of the Ledger records
 * no device has matched (`getLedgerRecordsToCheck`, in the wallet list's
 * order): those account-checks.js reads (a path that is a non-empty string,
 * an address that is a string), each at a scheme's path (`path-strict`), the
 * first 20 (`check-bound`).
 */
function checkedRecords(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((r) => r && typeof r.path === 'string' && r.path && typeof r.address === 'string')
    .filter((r) => parsePath(r.path) !== null)
    .slice(0, MAX_CHECKS);
}

// ---------------------------------------------------------------------------
// The streams. Each slot: the APDU, its row, whether it waits for the user,
// how many of its data's first bytes are `P` (the `path` rule), whether the
// row sends it once (the `count` rule), and whether it is one of discovery's
// record checks (the `order` rule among them).

function slot(bytes, row, { waits = false, pathLength = 0, once = false, record = false } = {}) {
  return { apdu: bytes, row, waits, pathLength, once, record };
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function decimal(value, name) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new GrammarError('params', `tx.${name} isn't a decimal string`);
  }
  return BigInt(value);
}

/**
 * `T`: ethers' unsigned serialization of 0002's `tx` main sent (type 0,
 * `rlp([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])`; type 2,
 * `0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit,
 * to, value, data, []])`), read as signing-utils.js reads a transaction.
 */
function unsignedTransaction(tx) {
  if (!tx || typeof tx !== 'object' || (tx.type !== 0 && tx.type !== 2)) {
    throw new GrammarError('params', 'a transaction of type 0 or 2');
  }
  const chainId = decimal(tx.chain_id, 'chain_id');
  if (chainId === 0n) throw new GrammarError('params', 'a transaction without a chain ID');
  const nonce = decimal(tx.nonce, 'nonce');
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GrammarError('params', "a nonce ethers can't serialize");
  }
  const fields = {
    type: tx.type,
    chainId,
    nonce: Number(nonce),
    gasLimit: decimal(tx.gas_limit, 'gas_limit'),
    to: tx.to ?? null,
    value: decimal(tx.value, 'value'),
    data: tx.data ?? '0x',
  };
  if (tx.type === 0) {
    fields.gasPrice = decimal(tx.gas_price, 'gas_price');
  } else {
    fields.maxFeePerGas = decimal(tx.max_fee_per_gas, 'max_fee_per_gas');
    fields.maxPriorityFeePerGas = decimal(tx.max_priority_fee_per_gas, 'max_priority_fee_per_gas');
  }
  let unsigned;
  try {
    unsigned = Transaction.from(fields).unsignedSerialized;
  } catch (err) {
    throw new GrammarError(
      'params',
      `a transaction ethers refuses: ${err.shortMessage || err.message}`
    );
  }
  return Buffer.from(unsigned.slice(2), 'hex');
}

/**
 * The piece size of `P ‖ T` (`length` bytes): 255; for a legacy transaction
 * longer than one piece, the size hw-app-eth's `safeChunkTransaction` picks
 * (utils.js:202–247), the largest from 255 down that leaves a last piece
 * longer than `rlp(chainId) ‖ rlp(0) ‖ rlp(0)`, or none, so that no piece
 * ends where a legacy transaction could.
 */
function transactionPieceSize(length, tx) {
  if (length <= BOUNDS.apdu_data_bytes || tx.type !== 0) return BOUNDS.apdu_data_bytes;
  const vrs = Buffer.from(encodeRlp(toBeArray(BigInt(tx.chain_id))).slice(2), 'hex').length + 2;
  for (let size = BOUNDS.apdu_data_bytes; size > 0; size--) {
    const last = length % size;
    if (last === 0 || last > vrs) return size;
  }
  throw new GrammarError('params', 'no piece size');
}

/** Every signature's first two: the address check, then the app's name and version. */
function signatureHead(p) {
  return [
    slot(apdu(HEADERS.address, p), 'signature.first', { pathLength: p.length, once: true }),
    slot(apdu(HEADERS.app), 'signature.second', { once: true }),
  ];
}

/** `ledger.accounts { scheme, start, count }`, then the check of main's records. */
function accountsStream(params, records) {
  const { scheme, start, count } = params || {};
  if (!Object.hasOwn(SCHEMES, scheme)) throw new GrammarError('params', 'no such scheme');
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ACCOUNTS) {
    throw new GrammarError('params', `a count of 1 to ${MAX_ACCOUNTS}`);
  }
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new GrammarError('params', 'a start of 0 or more');
  }
  if (!isIndex(start + count - 1)) {
    throw new GrammarError('path-strict', "not a scheme's path: an index above 2^31 − 1");
  }
  const slots = [];
  for (let k = 0; k < count; k++) {
    const p = encodePath({ scheme, index: start + k });
    slots.push(slot(apdu(HEADERS.address, p), 'ledger.accounts', { pathLength: p.length }));
  }
  for (const record of checkedRecords(records)) {
    const p = pathBytes(record.path);
    slots.push(
      slot(apdu(HEADERS.address, p), 'ledger.accounts', { pathLength: p.length, record: true })
    );
  }
  return slots;
}

/** `ledger.add { scheme, index }`: the address shown on the device. */
function addStream(params) {
  const p = encodePath({ scheme: params?.scheme, index: params?.index });
  return [
    slot(apdu(HEADERS.addressDisplay, p), 'ledger.add', {
      waits: true,
      pathLength: p.length,
      once: true,
    }),
  ];
}

/** `sign.transaction { tx }`: `P ‖ T` in pieces, the last waiting for the user. */
function transactionStream(p, params) {
  const tx = params?.tx;
  const payload = Buffer.concat([p, unsignedTransaction(tx)]);
  const size = transactionPieceSize(payload.length, tx);
  const pieces = Math.ceil(payload.length / size);
  bounded(2 + pieces);
  const slots = signatureHead(p);
  for (let k = 0; k < pieces; k++) {
    const data = payload.subarray(k * size, (k + 1) * size);
    slots.push(
      slot(
        apdu(k === 0 ? HEADERS.transactionFirst : HEADERS.transactionMore, data),
        'sign.transaction',
        { waits: k === pieces - 1, pathLength: k === 0 ? Math.min(p.length, data.length) : 0 }
      )
    );
  }
  return slots;
}

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** `sign.message { message }`: `P ‖ len(m) ‖ m`, the first piece 150 − 5 − 4n bytes of `m`, then 150 at a time. */
function messageStream(p, params) {
  const text = params?.message;
  if (typeof text !== 'string' || !HEX_BYTES.test(text)) {
    throw new GrammarError('params', 'a message of hex bytes');
  }
  const m = Buffer.from(text.slice(2), 'hex');
  if (m.length === 0) throw new GrammarError('empty-message', 'an empty message');
  const first = MESSAGE_PIECE - p.length - 4;
  const pieces = 1 + Math.ceil(Math.max(0, m.length - first) / MESSAGE_PIECE);
  bounded(2 + pieces);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(m.length);
  const slots = signatureHead(p);
  slots.push(
    slot(
      apdu(HEADERS.messageFirst, Buffer.concat([p, length, m.subarray(0, first)])),
      'sign.message',
      {
        waits: pieces === 1,
        pathLength: p.length,
      }
    )
  );
  for (let k = 1; k < pieces; k++) {
    const at = first + (k - 1) * MESSAGE_PIECE;
    slots.push(
      slot(apdu(HEADERS.messageMore, m.subarray(at, at + MESSAGE_PIECE)), 'sign.message', {
        waits: k === pieces - 1,
      })
    );
  }
  return slots;
}

const DEFINITIONS = [HEADERS.typeName, HEADERS.typeField];
const VALUES = [HEADERS.root, HEADERS.array, HEADERS.valueMore, HEADERS.valueLast];
const isOneOf = (bytes, headers) => headers.some((h) => same(bytes.subarray(0, 4), h));
const isHash = (value) => isBytes(value) && value.length === 32;

/**
 * Typed data's stream from main's typed-data binding (the module's
 * comment): the signature's head, the binding's definitions and values,
 * then `E0 0C 00 01 P`; and the hash-only APDU its gate admits instead.
 */
function typedDataStream(p, typedData) {
  const { apdus, domainSeparator, structHash } = typedData || {};
  if (!Array.isArray(apdus) || apdus.length === 0) {
    throw new GrammarError('typed-data-stream', 'no typed-data APDUs');
  }
  if (!isHash(domainSeparator) || !isHash(structHash)) {
    throw new GrammarError('typed-data-stream', 'the two hashes, 32 bytes each');
  }
  bounded(3 + apdus.length);
  let values = false;
  const body = apdus.map((bytes, k) => {
    if (!framed(bytes)) throw new GrammarError('typed-data-stream', `APDU ${k} isn't framed`);
    if (k === 0 && !same(bytes.subarray(0, 4), HEADERS.typeName)) {
      throw new GrammarError('typed-data-stream', 'the first APDU is a type name, E0 1A 00 00');
    }
    if (isOneOf(bytes, VALUES)) {
      values = true;
      return slot(Buffer.from(bytes), 'sign.typed_data.values');
    }
    if (!values && isOneOf(bytes, DEFINITIONS)) {
      return slot(Buffer.from(bytes), 'sign.typed_data.definitions');
    }
    throw new GrammarError('typed-data-stream', `APDU ${k} has no place in the rows`);
  });
  const hashOnly = slot(
    apdu(HEADERS.signHashes, Buffer.concat([p, domainSeparator, structHash])),
    'hash-only',
    { waits: true, pathLength: p.length, once: true }
  );
  return {
    slots: [
      ...signatureHead(p),
      ...body,
      slot(apdu(HEADERS.signFields, p), 'sign.typed_data.sign', {
        waits: true,
        pathLength: p.length,
        once: true,
      }),
    ],
    hashOnly,
  };
}

/** More APDUs than an operation may send (the address check and `B0 01` counted) are refused. */
function bounded(count) {
  if (count > BOUNDS.apdus_per_operation) {
    throw new GrammarError(
      'device-bounds',
      `more than ${BOUNDS.apdus_per_operation} APDUs in one operation`
    );
  }
}

/** The operations an Admission opens; the Safe rows join with SAFE-3's binding. */
const OPERATIONS = Object.freeze([
  'ledger.accounts',
  'ledger.add',
  'sign.transaction',
  'sign.message',
  'sign.typed_data',
  'x402.settle',
]);
const TYPED = new Set(['sign.typed_data', 'x402.settle']);

/**
 * The operation a parent main sent opens on the device, or null when it
 * opens none, which the relay refuses as `parent`: a `sign.*` with a key
 * that isn't a Ledger's, `x402.settle` but its Ledger form
 * (`{ reservation, typed_data }`), any other method, and, until SAFE-3,
 * `safe.sign_owner` and `safe.message_sign` (plan point 11).
 */
function operationOf(method, params) {
  switch (method) {
    case 'ledger.accounts':
    case 'ledger.add':
      return method;
    case 'sign.transaction':
    case 'sign.message':
    case 'sign.typed_data':
      return params?.key?.kind === 'ledger' ? method : null;
    case 'x402.settle':
      return params && typeof params === 'object' && Object.hasOwn(params, 'typed_data')
        ? method
        : null;
    default:
      return null;
  }
}

/**
 * One parent's admission: what main lets reach the device for it, APDU by
 * APDU.
 */
class Admission {
  /**
   * @param {object} options
   * @param {string} options.operation - the parent's (`operationOf`)
   * @param {object} options.params - the params main sent: `ledger.accounts
   *   { scheme, start, count }`, `ledger.add { scheme, index }`,
   *   `sign.transaction { tx }`, `sign.message { message }` (other members
   *   aren't read)
   * @param {string} [options.path] - the account's path text, from main's
   *   own record snapshot (`getWalletRecord`): every operation but
   *   discovery and adding
   * @param {object[]} [options.records] - `ledger.accounts`: main's list of
   *   the records no device has matched (`getLedgerRecordsToCheck`)
   * @param {{ apdus: Buffer[], domainSeparator: Buffer, structHash: Buffer }} [options.typedData]
   *   - `sign.typed_data` and `x402.settle`: main's typed-data binding's
   *   stream (the module's comment)
   * @throws {GrammarError} when main can't derive the operation's stream
   */
  constructor({ operation, params, path, records, typedData }) {
    if (!OPERATIONS.includes(operation)) throw new Error(`No Ledger operation ${operation}`);
    this.operation = operation;
    this.hashOnlySlot = null;
    if (operation === 'ledger.accounts') {
      this.slots = accountsStream(params, records);
    } else if (operation === 'ledger.add') {
      this.slots = addStream(params);
    } else {
      const p = pathBytes(path);
      if (operation === 'sign.transaction') this.slots = transactionStream(p, params);
      else if (operation === 'sign.message') this.slots = messageStream(p, params);
      else {
        const stream = typedDataStream(p, typedData);
        this.slots = stream.slots;
        this.hashOnlySlot = stream.hashOnly;
      }
    }
    /** The operation's first `E0 1A`, whose `6D00` may open the hash-only gate. */
    this.firstTypeName = TYPED.has(operation) ? this.slots[2] : null;
    this.position = 0;
    this.outstanding = null;
    this.refused = null;
    this.ended = false;
  }

  /** The APDUs main expects, in order (the hash-only branch once its gate opened). */
  get expected() {
    return this.slots.map((s) => s.apdu);
  }

  /**
   * Decides one `shell.ledger_apdu`'s APDU before any byte of it reaches the
   * device: `{ row, waits }` when it is admitted (`waits`: the row's "waits
   * for the user", for the exchange's deadline), else `{ rule }`, after which
   * every later APDU of this parent is refused `ended`. Each admitted APDU
   * must be answered (`answered`) before the next is admitted.
   *
   * @param {Uint8Array} bytes - the APDU, `CLA INS P1 P2 Lc data`
   * @returns {{ row: string, waits: boolean }|{ rule: string }}
   */
  admit(bytes) {
    if (this.refused || this.ended) return { rule: 'ended' };
    const rule = this.check(bytes);
    if (rule) {
      this.refused = rule;
      return { rule };
    }
    const admitted = this.slots[this.position];
    this.position += 1;
    this.outstanding = admitted;
    return { row: admitted.row, waits: admitted.waits };
  }

  /** The APDU's rule, or null when it is the next of main's stream. */
  check(bytes) {
    if (this.outstanding) return 'order';
    if (!framed(bytes)) return 'header';
    const got = Buffer.from(bytes);
    if (this.position >= this.slots.length) return 'ended';
    const expected = this.slots[this.position];
    if (same(got, expected.apdu)) return null;
    const before = this.slots.slice(0, this.position);
    const after = this.slots.slice(this.position + 1);
    if (before.some((s) => s.once && same(got, s.apdu))) return 'count';
    if (!sameHeader(got, expected.apdu)) {
      if (this.isHashOnlyApdu(got) || after.some((s) => same(got, s.apdu))) return 'order';
      return 'header';
    }
    if (expected.record && after.some((s) => s.record && same(got, s.apdu))) return 'order';
    const n = expected.pathLength;
    if (
      n > 0 &&
      !same(
        got.subarray(APDU_HEAD, APDU_HEAD + n),
        expected.apdu.subarray(APDU_HEAD, APDU_HEAD + n)
      )
    ) {
      return 'path';
    }
    return 'payload';
  }

  /** The hash-only APDU's shape (`E0 0C 00 00`, `P` and two hashes long), out of its place. */
  isHashOnlyApdu(got) {
    const own = this.hashOnlySlot?.apdu;
    return Boolean(own) && sameHeader(got, own) && got.length === own.length;
  }

  /**
   * Whether the device's `answer` to the APDU in flight is the one that may
   * open the hash-only gate: `6D00` to the operation's first `E0 1A`. Only
   * then may main hold its answer for the hash-only warning and send it as
   * `{ answer, hash_only: "shown" }`.
   */
  isHashOnlyAnswer(answer) {
    return (
      this.outstanding !== null &&
      this.outstanding === this.firstTypeName &&
      isBytes(answer) &&
      same(Buffer.from(answer), STATUS_HASH_ONLY)
    );
  }

  /**
   * Main answered the APDU in flight, as it told the core: `{ answer }` (the
   * device's bytes, its status word last), `{ answer, hashOnly: true }` (sent
   * as `hash_only: "shown"`, once the warning is on screen), `{ failed }`, or
   * null for an APDU the core cancelled. A status other than `9000`, but the
   * one the gate takes, a failure or a cancel ends the operation: the core
   * ends it then.
   *
   * @throws {Error} with no APDU in flight, or `hashOnly` on any answer but
   *   the one `isHashOnlyAnswer` names: the relay's own fault
   */
  answered(reply) {
    const answeredSlot = this.outstanding;
    if (!answeredSlot) throw new Error('No APDU of this parent awaits an answer');
    if (reply?.hashOnly) {
      if (!this.isHashOnlyAnswer(reply.answer)) {
        throw new Error("hash_only on an answer other than the first E0 1A's 6D00");
      }
      this.outstanding = null;
      this.slots = [...this.slots.slice(0, this.position), this.hashOnlySlot];
      return;
    }
    this.outstanding = null;
    const answer = reply?.answer;
    const ok =
      isBytes(answer) &&
      answer.length >= 2 &&
      Buffer.from(answer).readUInt16BE(answer.length - 2) === STATUS_OK;
    if (!ok) this.ended = true;
  }

  /** The parent ended (answered, cancelled, past its deadline): nothing more is admitted. */
  end() {
    this.ended = true;
    this.outstanding = null;
  }
}

module.exports = {
  Admission,
  BOUNDS,
  GrammarError,
  HEADERS,
  MAX_ACCOUNTS,
  MAX_CHECKS,
  MAX_INDEX,
  MESSAGE_PIECE,
  OPERATIONS,
  ROWS,
  RULES,
  SCHEMES,
  apdu,
  checkedRecords,
  encodePath,
  operationOf,
  parsePath,
  pathBytes,
  transactionPieceSize,
  unsignedTransaction,
};
