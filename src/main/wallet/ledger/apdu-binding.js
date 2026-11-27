/**
 * Main's typed-data binding for a Ledger (freedom-core design 0016, Main's
 * typed-data binding; the `sign.typed_data` rows of The APDU grammar; Typed
 * data on the device, Q23; Bounds). LDG-3's PR 2: nothing calls it yet.
 *
 * When the core signs typed data on a Ledger, it sends main each APDU as a
 * `shell.ledger_apdu`, and main compares every one, byte for byte, with the
 * stream it encodes itself from what it holds: the `typed_data` and
 * `expected_hash` of the request main sent (for `sign.typed_data`; later
 * main's own x402 rebuild and its derived SafeTx or SafeMessage). This
 * module is that encoder, written from the design, not taken from
 * hw-app-eth, and pure: no device, no core, no state.
 *
 * **The interface** (for PR 6's relay, beside PR 1's per-parent Admission,
 * `src/main/core/ledger-grammar.js`):
 *
 *     typedDataApdus({ typedData, expectedHash, path, hashOnly })
 *       → { apdus, hashes: { domainSeparator, structHash } }
 *       | { rule: 'payload', reason, bound? }
 *
 * - `typedData`: the request's `typed_data` in the core's form, as main
 *   sent it (`{ domain, types, message }`, `types` without `EIP712Domain`;
 *   anything else on it, a `primaryType` among them, is not read: the
 *   primary type is ethers' inference, as the core's is fc-evm's).
 * - `expectedHash`: the request's `expected_hash`, the EIP-712 hash the user
 *   confirmed, `0x` and 64 hex digits.
 * - `path`: `P`, the record's path as the grammar encodes it (one byte `n`,
 *   then `n` elements of 4 bytes, big-endian), in lowercase hex: the
 *   Admission's own encoding of the record's path, which this module puts
 *   in the signing APDU without reading it. Anything but `1 + 4n` bytes that
 *   fit the hash-only APDU throws a TypeError (a caller's fault, not input).
 * - `hashOnly`: false for the stream field by field; true for the branch Q23
 *   takes after the device answered `6D00` to the operation's first `E0 1A`
 *   and main's answer said `hash_only: "shown"`.
 *
 * `apdus` is the typed-data part of the operation's stream, each APDU in
 * lowercase hex (`CLA INS P1 P2 Lc data`, the wire's form), in order:
 * - field by field: the definitions (`E0 1A 00 00` each type's name,
 *   `E0 1A 00 FF` each of its fields' descriptors, the types in ascending
 *   order of their names, `EIP712Domain` among them), the values
 *   (`E0 1C 00 00` "EIP712Domain", the domain's values, `E0 1C 00 00` the
 *   primary type's name, the message's values depth first: an array's
 *   `E0 1C 00 0F` length then its entries, a value's `2-byte length ‖ bytes`
 *   in pieces of 255, `E0 1C 01 FF` each but the last, `E0 1C 00 FF` the
 *   last), then `E0 0C 00 01 P`;
 * - hash-only: the first definition (the APDU the device answered `6D00`),
 *   then `E0 0C 00 00 P ‖ domainSeparator ‖ hashStruct(message)`, the two
 *   hashes ethers' (`hashes`, which the hash-only warning shows).
 * The Admission puts the address check (`E0 02 00 00 P`) and `B0 01` before
 * it, and holds each APDU of the parent to the next one of the whole, the
 * hash-only branch only past its gate. A typed-data APDU whose header is
 * the expected one but whose data isn't is refused `payload`, the rule
 * `vectors/ledger-grammar.json` gives every changed byte, another schema and
 * message of the same shape, the reference's UTF-16 definitions and a
 * changed SafeTx or SafeMessage. Both branches are encoded whole first, so
 * either refuses what the other would.
 *
 * **A refusal** is `{ rule: 'payload', reason }`: main has no stream for the
 * parent, so every APDU of it is refused `payload`, the first before any
 * byte reaches the device (the relay logs the rule only). `reason` says why,
 * for tests and the relay's own record, never for the wire:
 * - `hash-mismatch`: ethers' `TypedDataEncoder.hash` of `typedData` isn't
 *   `expectedHash` (0016: checked first, before the first APDU);
 * - `name-ascii`: a type or field name outside 0002's identifiers
 *   (`[A-Za-z_$][A-Za-z0-9_$]*`), which fc-evm refuses before hashing, so a
 *   name's one-byte length is its byte count (deviation `name-ascii`, F-2);
 *   or `__proto__`, which neither side can carry;
 * - `typed-data`: what ethers' parse refuses, or what it accepts and fc-evm
 *   doesn't (a bool that isn't a boolean, a type named like a primitive, an
 *   address that isn't hex), or a `typed_data` not in the core's form;
 * - `not-canonical`: an array suffix written in a form the device wouldn't
 *   rebuild from its descriptor (`uint8[02]`, `LEDGER_TYPE_NOT_CANONICAL`);
 * - `device-bounds`: what a Ledger can't carry (`LEDGER_TOO_LARGE`), with
 *   `bound: { name, size }`, `name` one of `BOUNDS`' keys or `definition`
 *   (a definition APDU's data): a name over 255 bytes, a definition over 255,
 *   more than 255 dimensions, a fixed size or an array over 255 entries, a
 *   value over 65,535 bytes, or more than 2,048 APDUs in the operation (the
 *   address check, `B0 01` and the signing APDU counted), checked in the
 *   core's order (`fc-ledger`'s `TypedStream::new`).
 * The core refuses each of these itself before its first APDU; main's
 * refusal is its own check, and where the two would differ on an input the
 * core accepts, main refuses: nothing is signed, and the case is a vector
 * to raise (0016's joint contract).
 *
 * **Two derivations, one contract:** this module encodes from ethers'
 * `getPayload` (the types with `EIP712Domain`, the primary type, the domain,
 * the message with integers as decimal strings), the core from fc-evm's
 * parse; both must reproduce `vectors/ledger.json`'s APDUs, and
 * `apdu-binding.vectors.test.js` runs every typed-data case of it and every
 * family the grammar file lists against this module (R6). Values are
 * encoded as hw-app-eth's `EIP712_TYPE_ENCODERS` encode them: an integer's
 * minimal big-endian bytes (one zero byte for 0; a negative one in two's
 * complement of its width), a bool's one byte, an address's 20, bytes as
 * they are, a string's UTF-8; and cut whole into pieces of 255 (deviation
 * `field-pieces`), not as hw-app-eth cuts them.
 */

const { TypedDataEncoder, concat, getBytes, keccak256, toUtf8Bytes } = require('ethers');
const { assertBoundedTypeGraph } = require('../signing-utils');

/**
 * What a Ledger can carry: `vectors/ledger-grammar.json`'s `bounds`, which
 * the vectors suite holds these to, so a changed bound arrives with a pin.
 */
const BOUNDS = Object.freeze({
  apdu_data_bytes: 255,
  apdus_per_operation: 2048,
  value_encoding_bytes: 65535,
  array_entries: 255,
  fixed_size: 255,
  dimensions: 255,
  name_bytes: 255,
});

/** The rows' headers, `CLA INS P1 P2`. */
const HEADER = Object.freeze({
  TYPE_NAME: 'e01a0000',
  TYPE_FIELD: 'e01a00ff',
  ROOT: 'e01c0000',
  ARRAY: 'e01c000f',
  VALUE_MORE: 'e01c01ff',
  VALUE_LAST: 'e01c00ff',
  SIGN_FIELDS: 'e00c0001',
  SIGN_HASHES: 'e00c0000',
});

/** The operation's APDUs around the typed-data stream: `E0 02`, `B0 01`, `E0 0C`. */
const AROUND_STREAM = 3;

const DOMAIN_TYPE = 'EIP712Domain';
const PROTO_NAME = '__proto__';
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** ethers' `getBaseEncoder` names, and the widths it reads (or refuses). */
const PRIMITIVE_NAME = /^(?:address|bool|bytes|string|(?:u?int|bytes)\d+)$/;
const INT_TYPE = /^(u?)int(\d+)$/;
const FIXED_BYTES_TYPE = /^bytes(\d+)$/;
/** An array suffix as the device rebuilds it: `[]` or `[n]`, `n` decimal, no leading zero. */
const DIMENSION = /\[(0|[1-9][0-9]*)?\]/y;
const ADDRESS_HEX = /^0x[0-9a-f]{40}$/;
const BYTES_HEX = /^0x(?:[0-9a-f]{2})*$/;
const HASH_HEX = /^0x[0-9a-fA-F]{64}$/;
const PATH_HEX = /^(?:[0-9a-f]{2})+$/;

/** hw-app-eth's `EIP712_TYPE_PROPERTIES` keys (`EIP712/utils.js:28–56`). */
const TYPE_KEY = Object.freeze({
  struct: 0,
  int: 1,
  uint: 2,
  address: 3,
  bool: 4,
  string: 5,
  fixedBytes: 6,
  bytes: 7,
});

/** A refusal before the first APDU; thrown inside, returned at the edge. */
class Refusal {
  constructor(reason, bound) {
    this.rule = 'payload';
    this.reason = reason;
    if (bound) this.bound = bound;
  }
}

function refuse(reason, bound) {
  throw new Refusal(reason, bound);
}

function tooLarge(name, size) {
  refuse('device-bounds', { name, size });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function byteHex(n) {
  return n.toString(16).padStart(2, '0');
}

/** One APDU, `CLA INS P1 P2 Lc data`, in hex; `data` at most 255 bytes. */
function apdu(header, data) {
  const bytes = Buffer.from(data);
  if (bytes.length > BOUNDS.apdu_data_bytes) {
    throw new Error('an APDU over 255 bytes of data');
  }
  return header + byteHex(bytes.length) + bytes.toString('hex');
}

/** A name with its one-byte length, the name ASCII (checked before). */
function lengthPrefixed(name) {
  return Buffer.concat([Buffer.from([name.length]), Buffer.from(name, 'latin1')]);
}

/**
 * The request's names, before anything is hashed: 0002's identifiers, not
 * `__proto__`, no type named `EIP712Domain` or like a primitive; each field
 * a `{ name, type }` of strings.
 */
function checkNames(types) {
  if (!isRecord(types)) refuse('typed-data');
  for (const name of Object.keys(types)) {
    if (!IDENTIFIER.test(name) || name === PROTO_NAME) refuse('name-ascii');
    if (name === DOMAIN_TYPE || PRIMITIVE_NAME.test(name)) refuse('typed-data');
    const fields = types[name];
    if (!Array.isArray(fields)) refuse('typed-data');
    for (const field of fields) {
      if (!isRecord(field) || typeof field.name !== 'string' || typeof field.type !== 'string') {
        refuse('typed-data');
      }
      if (!IDENTIFIER.test(field.name) || field.name === PROTO_NAME) refuse('name-ascii');
    }
  }
}

/** A bool is a boolean: ethers takes any value as its truth, fc-evm only booleans. */
function checkBools(types, message) {
  TypedDataEncoder.from(types).visit(message, (type, value) => {
    if (type === 'bool' && typeof value !== 'boolean') refuse('typed-data');
    return value;
  });
}

/**
 * A field type of ethers' normalized types: its base (with its type key and
 * size) and its array dimensions as written, innermost first (`null` for a
 * dynamic one). A suffix the device wouldn't rebuild is refused.
 */
function parseFieldType(text, types) {
  const open = text.indexOf('[');
  const base = open === -1 ? text : text.slice(0, open);
  const dims = [];
  if (open !== -1) {
    DIMENSION.lastIndex = open;
    let at = open;
    while (at < text.length) {
      const match = DIMENSION.exec(text);
      if (!match) refuse('not-canonical');
      dims.push(match[1] === undefined ? null : Number(match[1]));
      at = DIMENSION.lastIndex;
    }
  }
  const int = INT_TYPE.exec(base);
  if (int) {
    const bits = Number(int[2]);
    if (bits % 8 !== 0 || bits === 0 || bits > 256 || int[2] !== String(bits)) {
      refuse('typed-data');
    }
    return { kind: int[1] ? 'uint' : 'int', size: bits / 8, bits, dims };
  }
  const fixed = FIXED_BYTES_TYPE.exec(base);
  if (fixed) {
    const width = Number(fixed[1]);
    if (width === 0 || width > 32 || fixed[1] !== String(width)) refuse('typed-data');
    return { kind: 'fixedBytes', size: width, dims };
  }
  if (base === 'address' || base === 'bool' || base === 'string' || base === 'bytes') {
    return { kind: base, size: null, dims };
  }
  if (!hasOwn(types, base)) refuse('typed-data');
  return { kind: 'struct', size: null, name: base, dims };
}

/**
 * A field's descriptor, the data of its `E0 1A 00 FF`: the type byte (array
 * bit, size bit, key), a custom type's name with its length byte, the size,
 * the dimensions (their count, then `0` for a dynamic one or `1 n` for a
 * fixed one), and the field's name with its length byte.
 */
function descriptor(field, parsed) {
  const parts = [
    Buffer.from([
      (parsed.dims.length ? 0x80 : 0) | (parsed.size !== null ? 0x40 : 0) | TYPE_KEY[parsed.kind],
    ]),
  ];
  if (parsed.kind === 'struct') parts.push(lengthPrefixed(parsed.name));
  if (parsed.size !== null) parts.push(Buffer.from([parsed.size]));
  if (parsed.dims.length) {
    if (parsed.dims.length > BOUNDS.dimensions) tooLarge('dimensions', parsed.dims.length);
    parts.push(Buffer.from([parsed.dims.length]));
    for (const dim of parsed.dims) {
      if (dim === null) {
        parts.push(Buffer.from([0]));
      } else {
        if (dim > BOUNDS.fixed_size) tooLarge('fixed_size', dim);
        parts.push(Buffer.from([1, dim]));
      }
    }
  }
  parts.push(lengthPrefixed(field.name));
  const data = Buffer.concat(parts);
  if (data.length > BOUNDS.apdu_data_bytes) tooLarge('definition', data.length);
  return data;
}

/** An integer's minimal big-endian bytes, one zero byte for 0. */
function minimalBytes(n) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

/** A base value as `EIP712_TYPE_ENCODERS` encode it, from getPayload's form. */
function encodeValue(parsed, value) {
  switch (parsed.kind) {
    case 'uint':
    case 'int': {
      // getPayload's decimal string; the domain's chainId a number or a quantity.
      if (typeof value !== 'string' && typeof value !== 'number') refuse('typed-data');
      let n = BigInt(value);
      if (n < 0n) {
        if (parsed.kind === 'uint') refuse('typed-data');
        n += 1n << BigInt(parsed.bits);
      }
      return minimalBytes(n);
    }
    case 'bool':
      if (typeof value !== 'boolean') refuse('typed-data');
      return Buffer.from([value ? 1 : 0]);
    case 'address':
      if (typeof value !== 'string' || !ADDRESS_HEX.test(value)) refuse('typed-data');
      return Buffer.from(value.slice(2), 'hex');
    case 'fixedBytes':
    case 'bytes': {
      if (typeof value !== 'string' || !BYTES_HEX.test(value)) refuse('typed-data');
      const bytes = Buffer.from(value.slice(2), 'hex');
      if (parsed.kind === 'fixedBytes' && bytes.length !== parsed.size) refuse('typed-data');
      return bytes;
    }
    case 'string':
      if (typeof value !== 'string') refuse('typed-data');
      return Buffer.from(toUtf8Bytes(value));
    default:
      return refuse('typed-data');
  }
}

/**
 * The stream's walk, as fc-ledger's `TypedStream` walks it: the definitions,
 * then the values depth first, counted against the operation's budget as
 * they are made. `fields` holds each type's fields with their parsed types.
 */
class StreamBuilder {
  constructor(fields, budget) {
    this.fields = fields;
    this.budget = budget;
    this.apdus = [];
  }

  push(header, data) {
    if (this.apdus.length + 1 > this.budget) {
      tooLarge('apdus_per_operation', this.apdus.length + 1 + AROUND_STREAM);
    }
    this.apdus.push(apdu(header, data));
  }

  fieldsOf(name) {
    const fields = this.fields.get(name);
    if (!fields) refuse('typed-data');
    return fields;
  }

  definitions(sortedNames) {
    for (const name of sortedNames) {
      this.push(HEADER.TYPE_NAME, Buffer.from(name, 'latin1'));
      for (const { field, parsed } of this.fieldsOf(name)) {
        this.push(HEADER.TYPE_FIELD, descriptor(field, parsed));
      }
    }
  }

  root(name, values) {
    this.push(HEADER.ROOT, Buffer.from(name, 'latin1'));
    this.struct(name, values);
  }

  struct(name, values) {
    if (!isRecord(values)) refuse('typed-data');
    for (const { field, parsed } of this.fieldsOf(name)) {
      if (!hasOwn(values, field.name)) refuse('typed-data');
      this.value(parsed, parsed.dims, values[field.name]);
    }
  }

  value(parsed, dims, value) {
    if (dims.length) {
      // The outermost dimension, the last written, first.
      if (!Array.isArray(value)) refuse('typed-data');
      const outer = dims[dims.length - 1];
      if (outer !== null && outer !== value.length) refuse('typed-data');
      if (value.length > BOUNDS.array_entries) tooLarge('array_entries', value.length);
      this.push(HEADER.ARRAY, Buffer.from([value.length]));
      const inner = dims.slice(0, -1);
      for (const entry of value) this.value(parsed, inner, entry);
      return;
    }
    if (parsed.kind === 'struct') {
      this.struct(parsed.name, value);
      return;
    }
    const bytes = encodeValue(parsed, value);
    if (bytes.length > BOUNDS.value_encoding_bytes) {
      tooLarge('value_encoding_bytes', bytes.length);
    }
    const data = Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes]);
    const pieces = Math.ceil(data.length / BOUNDS.apdu_data_bytes);
    if (this.apdus.length + pieces > this.budget) {
      tooLarge('apdus_per_operation', this.apdus.length + pieces + AROUND_STREAM);
    }
    for (let k = 0; k < pieces; k += 1) {
      const piece = data.subarray(k * BOUNDS.apdu_data_bytes, (k + 1) * BOUNDS.apdu_data_bytes);
      this.push(k + 1 < pieces ? HEADER.VALUE_MORE : HEADER.VALUE_LAST, piece);
    }
  }
}

/** Every name a Ledger carries in one byte: at most 255 bytes, checked in the request's order. */
function checkNameBounds(types) {
  for (const name of Object.keys(types)) {
    if (name.length > BOUNDS.name_bytes) tooLarge('name_bytes', name.length);
    for (const field of types[name]) {
      if (field.name.length > BOUNDS.name_bytes) tooLarge('name_bytes', field.name.length);
    }
  }
}

function checkPath(path) {
  if (typeof path !== 'string' || !PATH_HEX.test(path)) {
    throw new TypeError('path: the encoded path, in lowercase hex');
  }
  const bytes = path.length / 2;
  const n = parseInt(path.slice(0, 2), 16);
  if (n === 0 || bytes !== 1 + 4 * n || bytes + 64 > BOUNDS.apdu_data_bytes) {
    throw new TypeError('path: one byte n, then n elements of 4 bytes');
  }
}

function bind({ typedData, expectedHash, path, hashOnly }) {
  if (typeof expectedHash !== 'string' || !HASH_HEX.test(expectedHash)) refuse('hash-mismatch');
  if (!isRecord(typedData)) refuse('typed-data');
  const { domain, types, message } = typedData;
  if (!isRecord(domain) || !isRecord(message)) refuse('typed-data');
  checkNames(types);
  try {
    // ethers' walk is exponential on diamond-shaped types; refused first.
    assertBoundedTypeGraph(types);
  } catch {
    refuse('typed-data');
  }

  if (TypedDataEncoder.hash(domain, types, message) !== expectedHash.toLowerCase()) {
    refuse('hash-mismatch');
  }
  checkBools(types, message);
  const payload = TypedDataEncoder.getPayload(domain, types, message);

  // The core's order: every written form (check_written_forms), then
  // TypedStream::new's: the names, the definitions as they are made, the
  // values.
  const fields = new Map();
  for (const name of Object.keys(payload.types)) {
    fields.set(
      name,
      payload.types[name].map((field) => ({
        field,
        parsed: parseFieldType(field.type, payload.types),
      }))
    );
  }
  checkNameBounds(payload.types);
  const names = Object.keys(payload.types).sort();
  const builder = new StreamBuilder(fields, BOUNDS.apdus_per_operation - AROUND_STREAM);
  builder.definitions(names);
  builder.root(DOMAIN_TYPE, payload.domain);
  builder.root(payload.primaryType, payload.message);

  const domainSeparator = TypedDataEncoder.hashDomain(domain);
  const structHash = TypedDataEncoder.from(types).hash(message);
  // The two hashes are the confirmed one's parts: the device signs
  // keccak256(19 01 ‖ both), which must be expected_hash.
  if (keccak256(concat(['0x1901', domainSeparator, structHash])) !== expectedHash.toLowerCase()) {
    refuse('hash-mismatch');
  }
  const hashes = { domainSeparator, structHash };
  const apdus = hashOnly
    ? [
        builder.apdus[0],
        apdu(
          HEADER.SIGN_HASHES,
          Buffer.concat([Buffer.from(path, 'hex'), getBytes(domainSeparator), getBytes(structHash)])
        ),
      ]
    : [...builder.apdus, apdu(HEADER.SIGN_FIELDS, Buffer.from(path, 'hex'))];
  return { apdus, hashes };
}

/**
 * The typed-data part of a Ledger operation's expected APDU stream, or the
 * refusal of it (the interface is this file's header).
 *
 * @param {{ typedData: object, expectedHash: string, path: string, hashOnly?: boolean }} request
 * @returns {{ apdus: string[], hashes: { domainSeparator: string, structHash: string } }
 *   | { rule: 'payload', reason: string, bound?: { name: string, size: number } }}
 */
function typedDataApdus({ typedData, expectedHash, path, hashOnly = false } = {}) {
  checkPath(path);
  if (typeof hashOnly !== 'boolean') throw new TypeError('hashOnly: a boolean');
  try {
    return bind({ typedData, expectedHash, path, hashOnly });
  } catch (err) {
    if (err instanceof Refusal) return { ...err };
    // ethers' own refusal of the typed data, or a value it lets through
    // that BigInt can't read.
    return { rule: 'payload', reason: 'typed-data' };
  }
}

module.exports = { BOUNDS, HEADER, typedDataApdus };
