/**
 * Typed data that @ledgerhq/hw-app-eth would send to the Ledger wrongly (#1064).
 *
 * hw-app-eth's EIP-712 sender (lib/modules/EIP712, the same in 7.11.1 and
 * 7.12.1) gets these wrong:
 * - A string or bytes value goes out in pieces of 255 bytes, but the pieces
 *   are counted as if they held 256, so a value of 254, 509-510, 764-766, ...
 *   bytes loses its last bytes, and so does every value over 65,023 bytes.
 * - Array lengths and fixed array sizes go out as one byte, made through a
 *   hex string that is wrong from 256 on (256 becomes 16).
 * - A field or struct name is announced with its length in UTF-16 units but
 *   sent as UTF-8, so a non-ASCII name is announced too short.
 * - Its type parser misreads some types ethers accepts and hashes as written:
 *   array sizes like "[01]", a struct named with brackets ("Point[X]"), and
 *   a struct named like a base type ("Bytes", "Address") or ending in "int"
 *   or "bytes" plus digits ("Point2"). A nested struct named "Custom" has
 *   none of its values sent.
 * - A nested struct's values go out in object key order, which puts names
 *   like "0" and "1" first, while its definition keeps the declared order.
 * - A base-type field named "__proto__" loses its value in ethers' payload.
 * - hw-transport refuses a message of 256 bytes or more, which a long name
 *   produces.
 *
 * The Ledger then refuses the request, or reads a different message from the
 * one Freedom showed for approval. Refusing first keeps the two in agreement
 * and gives a clear error. eip712-limits.test.js runs hw-app-eth against a
 * fake device, so a release that changes any of this fails it.
 */

const { getBytes } = require('ethers');

const { LEDGER_ERROR_CODES, createLedgerError } = require('./errors');

// hw-transport refuses message data of 256 bytes or more.
const MAX_MESSAGE_DATA = 255;
// Counts and sizes that hw-app-eth writes as a single byte.
const MAX_ONE_BYTE = 255;
// hw-app-eth's base types (EIP712_TYPE_PROPERTIES), which it looks up by the
// upper-cased name, so a struct with one of these names is defined as one.
const LEDGER_BASE_TYPES = new Set(['INT', 'UINT', 'ADDRESS', 'BOOL', 'STRING', 'BYTES']);

const ARRAY_SUFFIX = /\[(\d*)\]$/;

const isAscii = (text) => Buffer.byteLength(text, 'utf8') === text.length;

/** True when hw-app-eth's pieces carry every byte of a value this long, with its two-byte length. */
function sendsWholeValue(length) {
  const withLength = length + 2;
  return withLength <= 255 * Math.ceil(withLength / 256);
}

/** Split "T[2][]" into "T" and its array sizes as written ('' for dynamic). */
function splitArrays(type) {
  const sizes = [];
  let base = type;
  for (let match = ARRAY_SUFFIX.exec(base); match; match = ARRAY_SUFFIX.exec(base)) {
    sizes.unshift(match[1]);
    base = base.slice(0, match.index);
  }
  return { base, sizes };
}

/**
 * True when hw-app-eth's type parser (destructTypeFromString) defines a
 * struct name as that struct. Base types need no such check: ethers' payload
 * spells them canonically ("uint" becomes "uint256").
 */
function ledgerDefinesAsStruct(name) {
  if (/[[\]]/.test(name) || LEDGER_BASE_TYPES.has(name.toUpperCase())) return false;
  return !/(?=u?int|bytes)([a-zA-Z-0-9]+?)(\d{1,3})$/.test(name);
}

/** Bytes hw-app-eth sends to define one field (makeTypeEntryStructBuffer). */
function fieldDefinitionLength(name, base, sizes, isStruct) {
  const hasTypeSize = !isStruct && /^(u?int|bytes)\d+$/.test(base);
  const arrayLevels = sizes.length
    ? 1 + sizes.reduce((sum, size) => sum + (size === '' ? 1 : 2), 0)
    : 0;
  return (
    1 + (isStruct ? 1 + base.length : 0) + (hasTypeSize ? 1 : 0) + arrayLevels + 1 + name.length
  );
}

function findDefinitionProblem(types, typeName, fields) {
  // ethers reads a value of a struct named like a base type or an array as that type.
  if (/^(address|bool|string|bytes\d*|u?int\d*)$/.test(typeName) || ARRAY_SUFFIX.test(typeName)) {
    return `struct ${typeName} has the name of another type`;
  }
  // A struct's own name goes out as plain UTF-8; only a field's reference to it has a length.
  const nameLength = Buffer.byteLength(typeName, 'utf8');
  if (nameLength > MAX_MESSAGE_DATA) return `a struct name is ${nameLength} bytes`;
  for (const { name, type } of fields) {
    const where = `${typeName}.${name}`;
    if (!isAscii(name)) return `field ${JSON.stringify(where)} has a non-ASCII name`;
    const { base, sizes } = splitArrays(type);
    const isStruct = Object.hasOwn(types, base);
    // ethers' payload sets the prototype for "__proto__", which keeps an array or struct only.
    if (name === '__proto__' && !isStruct && !sizes.length) {
      return `field ${where} is named __proto__`;
    }
    if (isStruct && !isAscii(base)) {
      return `field ${JSON.stringify(where)} has a struct with a non-ASCII name`;
    }
    if (isStruct && !ledgerDefinesAsStruct(base)) {
      return `field ${where}'s struct ${base} would be defined as another type`;
    }
    if (sizes.some((size) => size !== '' && String(Number(size)) !== size)) {
      return `field ${where} has an array size written with leading zeros`;
    }
    if (sizes.some((size) => size !== '' && Number(size) > MAX_ONE_BYTE)) {
      return `field ${where} has a fixed array over ${MAX_ONE_BYTE} entries`;
    }
    if (fieldDefinitionLength(name, base, sizes, isStruct) > MAX_MESSAGE_DATA) {
      return `field ${where} has too long a definition`;
    }
  }
  return null;
}

/** True when a value of this type makes hw-app-eth send anything: a value or an array length. */
function sendsAnything(types, type) {
  if (ARRAY_SUFFIX.test(type) || !Object.hasOwn(types, type)) return true;
  return types[type].some((field) => sendsAnything(types, field.type));
}

/**
 * A nested struct's value goes through hw-app-eth's recursion, which skips
 * one named "Custom" and walks the others in object key order.
 */
function findNestedStructProblem(types, typeName, fields, path) {
  if (typeName.toUpperCase() === 'CUSTOM' && sendsAnything(types, typeName)) {
    return `${path} is a struct named ${typeName}, whose values wouldn't be sent`;
  }
  // Only the fields that send something can arrive out of order.
  const declared = fields.filter((field) => sendsAnything(types, field.type)).map((f) => f.name);
  const sending = new Set(declared);
  const sentOrder = Object.keys(Object.fromEntries(fields.map((f) => [f.name, f.type])));
  if (sentOrder.filter((name) => sending.has(name)).some((name, i) => name !== declared[i])) {
    return `${path}'s values would be sent out of order`;
  }
  return null;
}

function findValueProblem(types, type, value, path, nested) {
  const array = ARRAY_SUFFIX.exec(type);
  if (array) {
    if (value.length > MAX_ONE_BYTE) return `${path} has ${value.length} entries`;
    const entryType = type.slice(0, array.index);
    for (let i = 0; i < value.length; i++) {
      const problem = findValueProblem(types, entryType, value[i], `${path}[${i}]`, true);
      if (problem) return problem;
    }
    return null;
  }
  if (Object.hasOwn(types, type)) {
    const fields = types[type];
    const structProblem = nested && findNestedStructProblem(types, type, fields, path);
    if (structProblem) return structProblem;
    for (const field of fields) {
      const fieldPath = `${path}.${field.name}`;
      const problem = findValueProblem(types, field.type, value[field.name], fieldPath, true);
      if (problem) return problem;
    }
    return null;
  }
  let length = null;
  if (type === 'string') length = Buffer.byteLength(value, 'utf8');
  if (type === 'bytes') length = getBytes(value).length;
  if (length !== null && !sendsWholeValue(length)) return `${path} is ${length} bytes`;
  return null;
}

/**
 * @param {{types: object, domain: object, primaryType: string, message: object}} payload
 *   The wire payload from getEip712WirePayload, which ethers has already
 *   checked against its types.
 * @returns {string|null} The first thing hw-app-eth would send wrongly, or null
 */
function findLedgerTypedDataProblem(payload) {
  const { types } = payload;
  for (const [typeName, fields] of Object.entries(types)) {
    const problem = findDefinitionProblem(types, typeName, fields);
    if (problem) return problem;
  }
  return (
    findValueProblem(types, 'EIP712Domain', payload.domain, 'domain', false) ||
    findValueProblem(types, payload.primaryType, payload.message, 'message', false)
  );
}

/** Throw LEDGER_TYPED_DATA_UNSUPPORTED, with the reason in `detail`, for such typed data. */
function assertLedgerCanSendTypedData(payload) {
  const problem = findLedgerTypedDataProblem(payload);
  if (!problem) return;
  const err = createLedgerError(LEDGER_ERROR_CODES.TYPED_DATA_UNSUPPORTED);
  err.detail = problem;
  throw err;
}

module.exports = { findLedgerTypedDataProblem, assertLedgerCanSendTypedData };
