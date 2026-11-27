/**
 * The typed data the pinned core accepts for `sign.typed_data` before
 * fc-ledger reads it (cored-v0.30.0, freedom-core b4e0cef4): the params
 * read by fc-evm's `parse_json`, `typed_data` an object, and fc-evm's
 * `typed_data_view` at the core's view bound. Main's typed-data
 * binding (apdu-binding.js) checks this before ethers normalizes anything:
 * `getPayload` turns `"+1"`, `" 1"` and `"0b1"` into `"1"`, a struct given as
 * `null` into `{}`, and an ICAP `verifyingContract` into hex, and walks no
 * limit, so a binding built from it alone would stream typed data fc-evm
 * refuses (the core refuses each of these before fc-ledger, so the Ledger
 * vectors hold none of them). Pure, no ethers normalization, linear in the
 * input.
 *
 * `checkTypedDataSubset(typedData)` is `null` for typed data the core
 * accepts, else `{ reason, check }`: `check` names the rule below that
 * refused it, the first in the core's order; `reason` is `name-ascii` for
 * `identifier` and `proto-name` (deviation `name-ascii`, F-2), `typed-data`
 * for every other rule.
 *
 * Every rule, in the core's order (freedom-core b4e0cef4; `eip712.rs`,
 * `u256.rs`, `hex.rs`, `address.rs` and `json.rs` are `crates/fc-evm/src/`,
 * `signing.rs` is `crates/freedom-cored/src/`, serde_json is 1.0.154 as the
 * core's Cargo.lock pins it):
 *
 * | check             | source                     | refused                                          |
 * |-------------------|----------------------------|--------------------------------------------------|
 * | json-value        | signing.rs:617,            | a value the params' JSON can't hold as itself:   |
 * |                   | json.rs:33-42              | undefined, a function, a BigInt, NaN or          |
 * |                   |                            | ±Infinity, a hole, a non-plain object            |
 * | json-surrogate    | json.rs:34; serde_json     | a lone surrogate in a string or key (its `\u`    |
 * |                   | read.rs:962-1010           | escape)                                          |
 * | json-depth        | json.rs:34; serde_json     | a container past serde_json's 127th, counting    |
 * |                   | de.rs:63,1372-1387         | the params object                                |
 * | typed-data-object | signing.rs:429-432         | `typed_data` not an object (its domain, types    |
 * |                   |                            | and message read as fc-evm reads them, an absent |
 * |                   |                            | one null; other keys unread)                     |
 * | types-object      | eip712.rs:219-221          | `types` not an object                            |
 * | types-count       | eip712.rs:43, 222-224      | more than 256 types                              |
 * | domain-type-name  | eip712.rs:226-228          | a type named EIP712Domain                        |
 * | proto-name        | eip712.rs:229-231          | a type named __proto__                           |
 * | identifier        | eip712.rs:232-237,         | a type name not `[A-Za-z_$][A-Za-z0-9_$]*` of at |
 * |                   | 107-116, 58                | most 256 chars                                   |
 * | primitive-name    | eip712.rs:238-243, 152-179 | a type named like a primitive (`bool`, `uint7`,  |
 * |                   |                            | `bytes33`)                                       |
 * | field-list        | eip712.rs:250-252          | a type's fields not an array                     |
 * | field-count       | eip712.rs:44-45, 253-256   | more than 256 fields in a type, or 1,024 in all  |
 * | field-shape       | eip712.rs:261-268          | a field without a string name and a string type  |
 * | identifier        | eip712.rs:269-274          | a field name not an identifier                   |
 * | proto-name        | eip712.rs:275-280          | a field named __proto__                          |
 * | duplicate-field   | eip712.rs:281-287          | two fields of one type with one name             |
 * | dimensions        | eip712.rs:47, 288-295,     | more than 32 array dimensions (`split_array`'s)  |
 * |                   | 121-149                    |                                                  |
 * | circular          | eip712.rs:296-303          | a field of its own type (`uint`/`int` resolved   |
 * |                   |                            | first)                                           |
 * | width             | eip712.rs:304, 152-161     | `uint`/`int` not 8..256 by 8, `bytes` not 1..32, |
 * |                   |                            | or leading 0s                                    |
 * | unknown-type      | eip712.rs:306-313          | a field of a type not declared                   |
 * | primary-type      | eip712.rs:323-337          | no type, or more than one, that no field refers  |
 * |                   |                            | to                                               |
 * | circular          | eip712.rs:342-344, 605-628 | a cycle reachable from the primary type          |
 * | type-text         | eip712.rs:50, 354-365      | over 1 MiB of encodeType text across the type    |
 * |                   |                            | hashes                                           |
 * | domain-object     | eip712.rs:784-786          | `domain` not an object                           |
 * | domain-key        | eip712.rs:787-794          | a non-null domain key other than the five        |
 * | (each scalar)     | eip712.rs:807-828          | each domain field present, as a scalar of its    |
 * |                   |                            | type, below                                      |
 * | depth             | eip712.rs:46, 400-402,     | a value nested past depth 32 (a field or an      |
 * |                   | 452-454                    | array entry adds 1)                              |
 * | struct-object     | eip712.rs:403-405          | a struct value not an object, even a struct      |
 * |                   |                            | without fields                                   |
 * | missing           | eip712.rs:419-428          | a declared field absent or null                  |
 * | values            | eip712.rs:57, 208-214, 455 | more than 100,000 values (fields and array       |
 * |                   |                            | entries)                                         |
 * | array             | eip712.rs:465              | an array field's value not an array              |
 * | array-length      | eip712.rs:466-472          | a fixed dimension's length other than the        |
 * |                   |                            | array's                                          |
 * | quantity          | eip712.rs:633-634;         | an integer string not `-?` then digits or        |
 * |                   | u256.rs:201-212            | `0x`/`0X` and hex digits (no `+`, space, `0b`,   |
 * |                   |                            | `0o`, lone `-`), or past 2^256 - 1               |
 * | safe-integer      | eip712.rs:59-60, 636-651   | an integer JSON number not a safe integer        |
 * | number            | eip712.rs:654              | an integer neither a string nor a number         |
 * | uint-range        | eip712.rs:673-679          | a uintN negative or over 2^N - 1                 |
 * | int-range         | eip712.rs:680-693          | an intN outside -2^(N-1) .. 2^(N-1) - 1          |
 * | bytes             | eip712.rs:694-698,         | bytes not a string of `0x`/`0X` and an even      |
 * |                   | 704-707; hex.rs:5-26       | count of hex digits                              |
 * | bytes-length      | eip712.rs:699-701          | a bytesN of other than N bytes                   |
 * | string            | eip712.rs:708-710          | a string value not a string                      |
 * | address           | eip712.rs:711-713;         | not `0x` and 40 hex digits, or mixed case        |
 * |                   | address.rs:13-29           | without EIP-55's                                 |
 * | bool              | eip712.rs:714-717          | a bool not true or false                         |
 * | encode-bytes      | eip712.rs:54, 200-206      | over 32 MiB hashed (unreachable here: `values`   |
 * |                   |                            | and `view-size` refuse first; kept for a later   |
 * |                   |                            | fc-evm)                                          |
 * | view-size         | eip712.rs:859-942,         | a view over the core's longest, 1,048,369 bytes, |
 * |                   | 1001-1026, 565-603,        | measured as written, the reports at their        |
 * |                   | 834-854, 1178-1221;        | longest                                          |
 * |                   | signing.rs:448-476, 494    |                                                  |
 *
 * The scalars are checked in the domain (`name` and `version` strings,
 * `chainId` a uint256, `verifyingContract` an address, `salt` a bytes32)
 * after the types, then in the message depth first. The view is fc-evm's
 * text of `getPayload` and the reports; main doesn't know the request's
 * `primary_type` and `chain_id` here, so `named_type` and `chain` count as
 * their longest (`"mismatch"`, or `"absent"` without a `chainId`), and main
 * refuses a view within those few bytes of the bound that the core would
 * take (0016's joint contract: where the two differ, main refuses).
 */

const { getAddress } = require('ethers');

/** fc-evm's limits (eip712.rs:43-60) and serde_json's depth. */
const LIMITS = Object.freeze({
  types: 256,
  fields: 256,
  totalFields: 1024,
  depth: 32,
  dimensions: 32,
  typeText: 1 << 20,
  encodeBytes: 32 << 20,
  values: 100000,
  name: 256,
  // serde_json opens at most 127 nested containers; the params object is
  // the first, so `typed_data`, the second, holds at most 125 more.
  jsonDepth: 126,
});

/**
 * The longest view the core accepts (signing.rs:448-476, 494): one frame
 * (fc-protocol's MAX_PAYLOAD, 1 MiB) less the signing response around it at
 * the largest ID, as serde_json writes it.
 */
const MAX_PAYLOAD = 1 << 20;
const SIGNING_REPLY =
  '{"type":"response","id":9007199254740991,"result":{"signature":"0x' +
  '00'.repeat(65) +
  '","view":0}}';
const MAX_VIEW_LEN = MAX_PAYLOAD - (SIGNING_REPLY.length - 1);

const DOMAIN_TYPE = 'EIP712Domain';
const PROTO_NAME = '__proto__';
const TYPED_DATA_MEMBERS = ['domain', 'types', 'message'];
const DOMAIN_FIELDS = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];
const NAME_CHECKS = new Set(['identifier', 'proto-name']);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** What `primitive` reads, as a type or an error (eip712.rs:152-179). */
const PRIMITIVE_NAME = /^(?:address|bool|bytes|string|(?:u?int|bytes)[0-9]+)$/;
const SIZED = /^(uint|int|bytes)([0-9]+)$/;
const DIGITS = /^[0-9]*$/;
const QUANTITY = /^(-?)(?:0[xX]([0-9a-fA-F]+)|([0-9]+))$/;
const LEADING_ZEROS = /^0+(?=.)/;
const HEX_BYTES = /^0[xX](?:[0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LONE_SURROGATE = /\p{Cs}/u;
const U256_MAX = (1n << 256n) - 1n;

/** A rule's refusal, thrown inside, returned at the edge. */
class Refused {
  constructor(check) {
    this.check = check;
  }
}

function refuse(check) {
  throw new Refused(check);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** A JSON object: an object whose prototype is a realm's Object.prototype, or none. */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * The params as `parse_json` reads them (json.rs:33-42): JSON values only,
 * no lone surrogate (serde_json refuses its escape), at most serde_json's
 * nesting. In the order the text is written, which is the walk's.
 */
function checkJson(value, depth) {
  switch (typeof value) {
    case 'boolean':
      return;
    case 'string':
      if (LONE_SURROGATE.test(value)) refuse('json-surrogate');
      return;
    case 'number':
      if (!Number.isFinite(value)) refuse('json-value');
      return;
    case 'object':
      break;
    default:
      refuse('json-value');
  }
  if (value === null) return;
  if (depth > LIMITS.jsonDepth) refuse('json-depth');
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!hasOwn(value, i)) refuse('json-value');
      checkJson(value[i], depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) refuse('json-value');
  for (const key of Object.keys(value)) {
    if (LONE_SURROGATE.test(key)) refuse('json-surrogate');
    checkJson(value[key], depth + 1);
  }
}

/**
 * An object (signing.rs:429-432), whose domain, types and message are its
 * own (an absent one is fc-evm's null) and JSON. Its other keys aren't read:
 * a `sign.typed_data` request has none (signing.rs:217-238), and main's own
 * typed data, x402's among them, may carry a `primaryType`.
 */
function checkObject(typedData) {
  if (!isPlainObject(typedData)) refuse('typed-data-object');
  for (const key of TYPED_DATA_MEMBERS) {
    if (hasOwn(typedData, key)) checkJson(typedData[key], 2);
  }
}

/** eip712.rs:107-116. */
function isIdentifier(name) {
  return name.length <= LIMITS.name && IDENTIFIER.test(name);
}

/**
 * `split_array` (eip712.rs:121-149): the base up to the first `[` and, when
 * the rest is all `[digits?]` groups, their counts, innermost first (`null`
 * dynamic); else the whole text is the base. A count past any array's
 * length stays one no array has.
 */
function splitArray(text) {
  const open = text.indexOf('[');
  const whole = { base: text, suffix: '', dims: [] };
  if (open === -1) return whole;
  const dims = [];
  let at = open;
  while (at < text.length) {
    if (text[at] !== '[') return whole;
    const close = text.indexOf(']', at + 1);
    if (close === -1) return whole;
    const digits = text.slice(at + 1, close);
    if (!DIGITS.test(digits)) return whole;
    dims.push(digits === '' ? null : Number(digits));
    at = close + 1;
  }
  return { base: text.slice(0, open), suffix: text.slice(open), dims };
}

/** `primitive` of a base `PRIMITIVE_NAME` matches (eip712.rs:152-179): its type, or `width`. */
function primitive(base) {
  const sized = SIZED.exec(base);
  if (!sized) return { kind: base };
  const [, kind, digits] = sized;
  const width = Number(digits);
  const [max, step] = kind === 'bytes' ? [32, 1] : [256, 8];
  if (width === 0 || width > max || width % step !== 0 || digits !== String(width)) {
    refuse('width');
  }
  return kind === 'bytes' ? { kind: 'fixedBytes', size: width } : { kind, bits: width };
}

/** `Types::parse` (eip712.rs:218-381). */
function parseTypes(types) {
  if (!isPlainObject(types)) refuse('types-object');
  const names = Object.keys(types);
  if (names.length > LIMITS.types) refuse('types-count');
  for (const name of names) {
    if (name === DOMAIN_TYPE) refuse('domain-type-name');
    if (name === PROTO_NAME) refuse('proto-name');
    if (!isIdentifier(name)) refuse('identifier');
    if (PRIMITIVE_NAME.test(name)) refuse('primitive-name');
  }
  const fields = new Map();
  const parents = new Map(names.map((name) => [name, 0]));
  const links = new Map();
  let total = 0;
  for (const name of names) {
    const list = types[name];
    if (!Array.isArray(list)) refuse('field-list');
    total += list.length;
    if (list.length > LIMITS.fields || total > LIMITS.totalFields) refuse('field-count');
    const seen = new Set();
    const children = new Set();
    const parsed = [];
    for (const field of list) {
      const fieldName = isPlainObject(field) && hasOwn(field, 'name') ? field.name : undefined;
      const fieldType = isPlainObject(field) && hasOwn(field, 'type') ? field.type : undefined;
      if (typeof fieldName !== 'string' || typeof fieldType !== 'string') refuse('field-shape');
      if (!isIdentifier(fieldName)) refuse('identifier');
      if (fieldName === PROTO_NAME) refuse('proto-name');
      if (seen.has(fieldName)) refuse('duplicate-field');
      seen.add(fieldName);
      const { base: rawBase, suffix, dims } = splitArray(fieldType);
      if (dims.length > LIMITS.dimensions) refuse('dimensions');
      let baseText = rawBase;
      if (rawBase === 'int' && !hasOwn(types, 'int')) baseText = 'int256';
      if (rawBase === 'uint' && !hasOwn(types, 'uint')) baseText = 'uint256';
      if (baseText === name) refuse('circular');
      let base;
      if (PRIMITIVE_NAME.test(baseText)) {
        base = primitive(baseText);
      } else {
        if (!parents.has(baseText)) refuse('unknown-type');
        parents.set(baseText, parents.get(baseText) + 1);
        children.add(baseText);
        base = { kind: 'struct', name: baseText };
      }
      parsed.push({ name: fieldName, typeText: baseText + suffix, base, dims });
    }
    links.set(name, children);
    fields.set(name, parsed);
  }
  const roots = names.filter((name) => parents.get(name) === 0);
  if (roots.length !== 1) refuse('primary-type');
  const primary = roots[0];

  // Each reachable type's descendants, a cycle refused (eip712.rs:605-628).
  const descendants = new Map();
  const inProgress = new Set();
  const collect = (name) => {
    if (descendants.has(name)) return;
    if (inProgress.has(name)) refuse('circular');
    inProgress.add(name);
    const all = new Set();
    for (const child of [...links.get(name)].sort()) {
      collect(child);
      all.add(child);
      for (const grandchild of descendants.get(child)) all.add(grandchild);
    }
    inProgress.delete(name);
    descendants.set(name, all);
  };
  collect(primary);

  // The type-hash text: each reachable type's encodeType, and once more
  // for each type whose hash includes it (names and types are ASCII).
  const own = new Map();
  for (const name of descendants.keys()) {
    const inner = fields.get(name).map((field) => `${field.typeText} ${field.name}`);
    own.set(name, `${name}(${inner.join(',')})`.length);
  }
  let text = 0;
  for (const [name, subtypes] of descendants) {
    text += own.get(name);
    for (const subtype of subtypes) text += own.get(subtype);
    if (text > LIMITS.typeText) refuse('type-text');
  }
  return { order: names, fields, primary };
}

/** `domain_fields` (eip712.rs:783-804): the fields present, in the canonical order. */
function domainFields(domain) {
  if (!isPlainObject(domain)) refuse('domain-object');
  for (const key of Object.keys(domain)) {
    if (domain[key] !== null && !DOMAIN_FIELDS.some(([name]) => name === key)) {
      refuse('domain-key');
    }
  }
  return DOMAIN_FIELDS.filter(([name]) => hasOwn(domain, name) && domain[name] !== null).map(
    ([name, type]) => ({ name, type, base: primitive(type), value: domain[name] })
  );
}

/** `number` (eip712.rs:630-656): a quantity string or a safe integer, its sign and magnitude. */
function number(value) {
  if (typeof value === 'string') {
    const match = QUANTITY.exec(value);
    if (!match) refuse('quantity');
    const [, sign, hex, decimal] = match;
    const digits = (hex ?? decimal).replace(LEADING_ZEROS, '');
    // Past 64 hex or 78 decimal digits, past U256 (u256.rs:165-182).
    if (digits.length > (hex === undefined ? 78 : 64)) refuse('quantity');
    const magnitude = BigInt(hex === undefined ? digits : '0x' + digits);
    if (magnitude > U256_MAX) refuse('quantity');
    return { negative: sign === '-' && magnitude !== 0n, magnitude };
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse('safe-integer');
    return { negative: value < 0, magnitude: BigInt(Math.abs(value)) };
  }
  return refuse('number');
}

/** `parse_address` (address.rs:13-29). */
function isAddress(text) {
  if (!ADDRESS.test(text)) return false;
  const digits = text.slice(2);
  if (!/[a-f]/.test(digits) || !/[A-F]/.test(digits)) return true;
  return getAddress(text.toLowerCase()) === text;
}

/** Hex bytes' length (`parse_bytes`, hex.rs:5-26). */
function hexLength(value) {
  if (typeof value !== 'string' || !HEX_BYTES.test(value)) refuse('bytes');
  return (value.length - 2) / 2;
}

/** `parse_scalar` (eip712.rs:671-720): what the view writes of it. */
function parseScalar(base, value) {
  switch (base.kind) {
    case 'uint': {
      const read = number(value);
      if (read.negative || read.magnitude > (1n << BigInt(base.bits)) - 1n) refuse('uint-range');
      return read;
    }
    case 'int': {
      const read = number(value);
      const max = (1n << BigInt(base.bits - 1)) - 1n;
      if (read.magnitude > (read.negative ? max + 1n : max)) refuse('int-range');
      return read;
    }
    case 'fixedBytes': {
      const length = hexLength(value);
      if (length !== base.size) refuse('bytes-length');
      return length;
    }
    case 'bytes':
      return hexLength(value);
    case 'string':
      if (typeof value !== 'string') refuse('string');
      return value;
    case 'address':
      if (typeof value !== 'string' || !isAddress(value)) refuse('address');
      return 20;
    case 'bool':
      if (typeof value !== 'boolean') refuse('bool');
      return value;
  }
  throw new Error(`no scalar of kind ${base.kind}`);
}

/** A JSON string's length as serde_json writes it (UTF-8, its escapes); no lone surrogate. */
function jsonStringLength(text) {
  let length = 2;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x20) length += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    else if (c === 0x22 || c === 0x5c) length += 2;
    else if (c < 0x80) length += 1;
    else if (c < 0x800) length += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      length += 4;
      i += 1;
    } else length += 3;
  }
  return length;
}

/** `ViewText`'s length (eip712.rs:859-942), refused past the core's longest. */
class ViewLength {
  constructor() {
    this.length = 0;
  }

  add(length) {
    this.length += length;
    if (this.length > MAX_VIEW_LEN) refuse('view-size');
  }

  /** ASCII only. */
  raw(text) {
    this.add(text.length);
  }

  string(text) {
    this.add(jsonStringLength(text));
  }

  hex(bytes) {
    this.add(4 + 2 * bytes);
  }

  integer({ negative, magnitude }) {
    this.add(2 + (negative ? 1 : 0) + magnitude.toString().length);
  }

  quantity(magnitude) {
    this.add(4 + magnitude.toString(16).length);
  }

  /** A scalar as `encode_base` writes it (eip712.rs:724-772). */
  scalar(base, read) {
    switch (base.kind) {
      case 'uint':
      case 'int':
        return this.integer(read);
      case 'string':
        return this.string(read);
      case 'bool':
        return this.raw(read ? 'true' : 'false');
      default:
        return this.hex(read);
    }
  }

  /** `[{"name":…,"type":…},…]` (eip712.rs:587-603). */
  fieldList(fields) {
    this.raw('[');
    fields.forEach(([name, type], index) => {
      if (index > 0) this.raw(',');
      this.raw('{"name":');
      this.string(name);
      this.raw(',"type":');
      this.string(type);
      this.raw('}');
    });
    this.raw(']');
  }
}

/** `encode_struct` and `encode_field` (eip712.rs:392-490), with their budget and view. */
class Encoder {
  constructor(parsed, view) {
    this.parsed = parsed;
    this.view = view;
    this.bytes = 0;
    this.values = 0;
  }

  hash(bytes) {
    this.bytes += bytes;
    if (this.bytes > LIMITS.encodeBytes) refuse('encode-bytes');
  }

  visit() {
    this.values += 1;
    if (this.values > LIMITS.values) refuse('values');
  }

  /** A struct's encoding's length: its type hash and a word per field. */
  struct(name, value, depth) {
    if (depth > LIMITS.depth) refuse('depth');
    if (!isPlainObject(value)) refuse('struct-object');
    const fields = this.parsed.fields.get(name);
    this.view.raw('{');
    fields.forEach((field, index) => {
      if (index > 0) this.view.raw(',');
      this.view.string(field.name);
      this.view.raw(':');
      const member = hasOwn(value, field.name) ? value[field.name] : null;
      if (member === null) refuse('missing');
      this.field(field.base, field.dims, member, depth + 1);
    });
    this.view.raw('}');
    return 32 * (fields.length + 1);
  }

  field(base, dims, value, depth) {
    if (depth > LIMITS.depth) refuse('depth');
    this.visit();
    if (dims.length === 0) {
      if (base.kind === 'struct') {
        this.hash(this.struct(base.name, value, depth));
        return;
      }
      const read = parseScalar(base, value);
      this.view.scalar(base, read);
      if (base.kind === 'bytes') this.hash(read);
      if (base.kind === 'string') this.hash(Buffer.byteLength(read, 'utf8'));
      return;
    }
    if (!Array.isArray(value)) refuse('array');
    const outer = dims[dims.length - 1];
    if (outer !== null && value.length !== outer) refuse('array-length');
    const inner = dims.slice(0, -1);
    this.view.raw('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) this.view.raw(',');
      this.field(base, inner, value[i], depth + 1);
    }
    this.view.raw(']');
    this.hash(32 * value.length);
  }
}

/** `typed_data_view` (eip712.rs:981-1026) at the core's bound. */
function checkView({ domain, types, message }) {
  const parsed = parseTypes(types);
  const present = domainFields(domain);
  for (const field of present) parseScalar(field.base, field.value);

  const view = new ViewLength();
  view.raw('{"types":{');
  for (const name of parsed.order) {
    view.string(name);
    view.raw(':');
    view.fieldList(parsed.fields.get(name).map((field) => [field.name, field.typeText]));
    view.raw(',');
  }
  view.string(DOMAIN_TYPE);
  view.raw(':');
  view.fieldList(present.map((field) => [field.name, field.type]));
  view.raw('},"domain":{');
  present.forEach((field, index) => {
    if (index > 0) view.raw(',');
    view.string(field.name);
    view.raw(':');
    if (field.name === 'chainId') view.quantity(number(field.value).magnitude);
    else view.scalar(field.base, parseScalar(field.base, field.value));
  });
  view.raw('},"primary_type":');
  view.string(parsed.primary);
  view.raw(',"message":');
  const encoder = new Encoder(parsed, view);
  encoder.hash(encoder.struct(parsed.primary, message, 0));

  // The reports (eip712.rs:1178-1221), named_type and chain at their longest.
  const declared = new Set(parsed.fields.get(parsed.primary).map((field) => field.name));
  view.raw(',"ignored":[');
  Object.keys(message)
    .filter((key) => !declared.has(key))
    .forEach((key, index) => {
      if (index > 0) view.raw(',');
      view.string(key);
    });
  view.raw('],"named_type":"mismatch","chain":');
  view.raw(present.some((field) => field.name === 'chainId') ? '"mismatch"' : '"absent"');
  view.raw('}');
}

/**
 * Whether the pinned core accepts `typedData`'s domain, types and message
 * before fc-ledger reads them.
 *
 * @param {unknown} typedData
 * @returns {null | { reason: 'name-ascii' | 'typed-data', check: string }}
 */
function checkTypedDataSubset(typedData) {
  try {
    checkObject(typedData);
    checkView({
      domain: hasOwn(typedData, 'domain') ? typedData.domain : null,
      types: hasOwn(typedData, 'types') ? typedData.types : null,
      message: hasOwn(typedData, 'message') ? typedData.message : null,
    });
    return null;
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    return { reason: NAME_CHECKS.has(err.check) ? 'name-ascii' : 'typed-data', check: err.check };
  }
}

module.exports = { LIMITS, MAX_VIEW_LEN, checkTypedDataSubset };
