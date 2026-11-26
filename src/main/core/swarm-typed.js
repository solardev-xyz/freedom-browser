/**
 * The typed form of a page's Swarm params, read back as JavaScript holds
 * them (freedom-core design 0015, "Main's encoding of a request"; the
 * vectors' `formats.typed`, as the core's `Value::from_typed` reads it).
 *
 * `swarm.request` carries a page's params in a typed form, because the
 * reference's validators read JavaScript types that JSON loses. Main writes
 * that form (SWM-7's encoder) and binds its operation grammar to what it
 * sent, never to the core's word (swarm-grammar.js). This module is the
 * reader the grammar takes them from:
 *
 * - **Values:** `{ string }`, `{ number: String(n) }` (`-0`, `NaN` and the
 *   infinities included), `{ bigint }`, `{ boolean }`, `{ null: true }`,
 *   `{ undefined: true }`, `{ array }` (`{ hole: true }` for a hole), and
 *   `{ object: [[key, value], …] }` in key order. Each becomes the value
 *   itself: a number, a BigInt, an array with its holes, an object whose
 *   own keys are the pairs' (`__proto__` included, as an own key).
 * - **Data:** where a method reads bytes, `{ bytes, kind, base64 }` (at most
 *   64 KiB) or `{ bytes, kind, part }`, and a string there `{ string_bytes,
 *   base64 | part }`, its UTF-8. Each becomes a `SwarmData`: its kind, its
 *   length, and its bytes when the params carry them, or the part the core
 *   pulls them from (`shell.swarm_part`).
 * - **Bytes elsewhere:** `{ bytes_elsewhere, kind, base64 }`, bytes where no
 *   method reads data, become what the page held (a `Buffer`, a
 *   `Uint8Array`, an `ArrayBuffer`, or `{ type: 'Buffer', data }`), so
 *   `String()` and truthiness read them as the reference does.
 *
 * Read strictly: a tag this form doesn't have, a member past the tag's, a
 * value of another type, a duplicate key or base64 that isn't its bytes'
 * throws a `TypedFormError`. Main wrote the form, so a throw is main's bug.
 */

/** Inline bytes are at most 64 KiB; past that they come as a part. */
const INLINE_BYTES = 64 * 1024;

const BYTES_KINDS = ['Buffer', 'Uint8Array', 'ArrayBuffer', 'BufferJSON'];
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

class TypedFormError extends Error {
  constructor(message) {
    super(`typed params: ${message}`);
    this.name = 'TypedFormError';
  }
}

/**
 * Bytes at a position a method reads as data: `kind` is the JavaScript
 * value the page sent (`Buffer`, `Uint8Array`, `ArrayBuffer`, `BufferJSON`,
 * or `string` for a string's UTF-8), `length` its byte length, and either
 * `bytes` (carried inline) or `part` (pulled with `shell.swarm_part`).
 */
class SwarmData {
  constructor(kind, length, bytes, part) {
    this.kind = kind;
    this.length = length;
    this.bytes = bytes;
    this.part = part;
    Object.freeze(this);
  }

  /** Whether the page sent a string (`typeof` reads `string`). */
  get isString() {
    return this.kind === 'string';
  }
}

/** Base64 decoded strictly: the text must be the bytes' own encoding. */
function decodeBase64(text) {
  if (typeof text !== 'string') return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

function isLength(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_SAFE;
}

/** `Number(text)` for the text `String(n)` writes (`-0` written as such). */
function readNumber(text) {
  if (typeof text !== 'string') throw new TypedFormError('a number is not its text');
  const n = Number(text);
  const written = Object.is(n, -0) ? '-0' : String(n);
  if (text !== written) throw new TypedFormError(`a number's text is not String(n): ${text}`);
  return n;
}

function readBigInt(text) {
  if (typeof text !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(text) || text === '-0') {
    throw new TypedFormError("a BigInt's text is not its decimal");
  }
  return BigInt(text);
}

/** The bytes a data or bytes tag carries, held to its length. */
function inlineBytes(length, base64) {
  if (!isLength(length)) throw new TypedFormError('a byte length is not a length');
  const bytes = decodeBase64(base64);
  if (!bytes || bytes.length !== length || bytes.length > INLINE_BYTES) {
    throw new TypedFormError("base64 that isn't its bytes'");
  }
  return bytes;
}

/** What JavaScript held for bytes no method reads as data. */
function heldBytes(kind, bytes) {
  switch (kind) {
    case 'Buffer':
      return Buffer.from(bytes);
    case 'Uint8Array':
      return new Uint8Array(bytes);
    case 'ArrayBuffer':
      return new Uint8Array(bytes).buffer;
    default:
      return { type: 'Buffer', data: [...bytes] };
  }
}

/** The members a tag may carry besides itself. */
function only(typed, allowed) {
  for (const key of Object.keys(typed).slice(1)) {
    if (!allowed.includes(key)) throw new TypedFormError(`an unknown member ${key}`);
  }
}

/**
 * Reads one typed value. Throws a `TypedFormError` for anything outside
 * the form.
 *
 * @param {object} typed
 * @returns {*} the value as JavaScript held it
 */
function readTyped(typed) {
  if (typed === null || typeof typed !== 'object' || Array.isArray(typed)) {
    throw new TypedFormError('a value is not an object of one tag');
  }
  const keys = Object.keys(typed);
  if (keys.length === 0) throw new TypedFormError('a value has no tag');
  const tag = keys[0];
  const content = typed[tag];
  switch (tag) {
    case 'string':
      only(typed, []);
      if (typeof content !== 'string') throw new TypedFormError('a string is not one');
      return content;
    case 'number':
      only(typed, []);
      return readNumber(content);
    case 'bigint':
      only(typed, []);
      return readBigInt(content);
    case 'boolean':
      only(typed, []);
      if (typeof content !== 'boolean') throw new TypedFormError('a boolean is not one');
      return content;
    case 'null':
    case 'undefined':
      only(typed, []);
      if (content !== true) throw new TypedFormError(`${tag} is not true`);
      return tag === 'null' ? null : undefined;
    case 'array': {
      only(typed, []);
      if (!Array.isArray(content)) throw new TypedFormError('an array is not one');
      const out = new Array(content.length);
      content.forEach((item, i) => {
        const hole =
          item !== null &&
          typeof item === 'object' &&
          Object.keys(item).length === 1 &&
          item.hole === true;
        if (!hole) out[i] = readTyped(item);
      });
      return out;
    }
    case 'object': {
      only(typed, []);
      if (!Array.isArray(content)) throw new TypedFormError('an object is not its pairs');
      const out = {};
      for (const pair of content) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') {
          throw new TypedFormError('an object member is not a [key, value] pair');
        }
        if (Object.hasOwn(out, pair[0])) throw new TypedFormError('a key twice');
        // An own property, whatever its name: `__proto__` included.
        Object.defineProperty(out, pair[0], {
          value: readTyped(pair[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    case 'bytes':
    case 'string_bytes': {
      const string = tag === 'string_bytes';
      only(typed, string ? ['base64', 'part'] : ['kind', 'base64', 'part']);
      const kind = string ? 'string' : typed.kind;
      if (!string && !BYTES_KINDS.includes(kind)) {
        throw new TypedFormError('bytes of an unknown kind');
      }
      const hasBase64 = Object.hasOwn(typed, 'base64');
      const hasPart = Object.hasOwn(typed, 'part');
      if (hasBase64 === hasPart) throw new TypedFormError('data needs base64 or a part');
      if (hasBase64) return new SwarmData(kind, content, inlineBytes(content, typed.base64), null);
      if (!isLength(content)) throw new TypedFormError('a byte length is not a length');
      if (!Number.isInteger(typed.part) || typed.part < 0 || typed.part > 0xffff_ffff) {
        throw new TypedFormError('a part is not a part number');
      }
      return new SwarmData(kind, content, null, typed.part);
    }
    case 'bytes_elsewhere':
      only(typed, ['kind', 'base64']);
      if (!BYTES_KINDS.includes(typed.kind)) throw new TypedFormError('bytes of an unknown kind');
      return heldBytes(typed.kind, inlineBytes(content, typed.base64));
    default:
      throw new TypedFormError(`an unknown tag ${tag}`);
  }
}

/** `!!value`, with data read as the page held it (a string's by its length). */
function truthy(value) {
  if (value instanceof SwarmData) return value.isString ? value.length > 0 : true;
  return Boolean(value);
}

/**
 * `params[key]` as the reference reads a method's own params: an object's
 * own property, else `undefined` (a prototype's never counts).
 */
function param(params, key) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined;
  if (params instanceof SwarmData) return undefined;
  return Object.hasOwn(params, key) ? params[key] : undefined;
}

/** `params[key]` when it is truthy (design 0015's "`params.owner` when truthy"), else undefined. */
function truthyParam(params, key) {
  const value = param(params, key);
  return truthy(value) ? value : undefined;
}

/** `value === undefined || value === null`. */
function isNullish(value) {
  return value === undefined || value === null;
}

module.exports = {
  INLINE_BYTES,
  SwarmData,
  TypedFormError,
  isNullish,
  param,
  readTyped,
  truthy,
  truthyParam,
};
