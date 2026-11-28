/**
 * The typed form of a page's Swarm params, read back as JavaScript holds
 * them (freedom-core design 0015, "Main's encoding of a request"; the
 * vectors' `formats.typed`, as the core's `Value::from_typed` reads it).
 *
 * `swarm.request` carries a page's params in a typed form, because the
 * reference's validators read JavaScript types that JSON loses. Main writes
 * that form (`writePageParams`, below) and binds its operation grammar to
 * what it sent, never to the core's word (swarm-grammar.js). This module is
 * the reader the grammar takes them from, the writer of a page's params,
 * and the writer of the Swarm store ops' members (`writeTyped`, below):
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
 *
 * **A page's params** (design 0015, "Main's encoding of a request"; SWM-7):
 * `writePageParams(method, params)` writes them as the vectors' generator
 * does (`formats.typed`). Where a method reads data (`data` for the
 * uploads, the sends and the writes; each `files[i].bytes` of
 * `swarm_publishFiles`), a value `normalizeBytes` accepts is its bytes,
 * and a string there is its UTF-8 (`Buffer.from(s, 'utf-8')`, a lone
 * surrogate as U+FFFD), except at a file's `bytes`, which takes no string:
 * inline up to 64 KiB, as long as the params' inline data stays within
 * 256 KiB (one frame holds the request), else a part, numbered from 0 in
 * the order written, which the core pulls with `shell.swarm_part` and main
 * streams from the bytes it holds (`parts`: the page's own view where it
 * sent one, a copy for a string or a `{ type: 'Buffer', data }`). A value
 * there that `normalizeBytes` refuses keeps its plain tag. Bytes anywhere
 * else are `bytes_elsewhere`, inline. Everything else is a plain tag, as
 * `writeTyped` writes it, a string with a lone surrogate as it is (fc-json
 * reads the escape `JSON.stringify` gives it).
 *
 * **The store ops** (design 0015, D5 and D7; SWM-6): `swarm.identities`,
 * `swarm.history` and `swarm.manifest` take each member of their params as
 * a typed value, since the reference reads the chrome's IPC values by
 * their JavaScript types (a label that isn't a string, an `activate` that
 * isn't `true`, an identity id of any type), and answer `{ result_typed }`
 * or `{ error_typed }`. `writeTyped` writes a member: the values above but
 * data and bytes, which no store holds (the core refuses them,
 * `invalid_argument`). `readPlain` reads an answer: `readTyped` with no
 * data or bytes tag, which no store op answers.
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
  return readValue(typed, false);
}

/**
 * Reads one typed value that holds no data or bytes (a store op's answer,
 * design 0015, D5): `readTyped`, with a `bytes`, `string_bytes` or
 * `bytes_elsewhere` tag anywhere in it a `TypedFormError` too.
 *
 * @param {object} typed
 * @returns {*}
 */
function readPlain(typed) {
  return readValue(typed, true);
}

function readValue(typed, plain) {
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
        if (!hole) out[i] = readValue(item, plain);
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
          value: readValue(pair[1], plain),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    case 'bytes':
    case 'string_bytes': {
      if (plain) throw new TypedFormError(`${tag} where no bytes can be`);
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
      if (plain) throw new TypedFormError(`${tag} where no bytes can be`);
      only(typed, ['kind', 'base64']);
      if (!BYTES_KINDS.includes(typed.kind)) throw new TypedFormError('bytes of an unknown kind');
      return heldBytes(typed.kind, inlineBytes(content, typed.base64));
    default:
      throw new TypedFormError(`an unknown tag ${tag}`);
  }
}

/** `String(n)`, with `-0` written as such (the text `readNumber` takes). */
function numberText(n) {
  return Object.is(n, -0) ? '-0' : String(n);
}

/**
 * Whether `value` is a plain object: of no class but `Object` (any realm's,
 * as `structuredClone` makes them), or of none.
 */
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * Writes one value in the typed form, as a store op's member (design 0015,
 * D7: `formats.typed`): `{ string }`, `{ number: String(n) }` (`-0`, `NaN`
 * and the infinities included), `{ bigint }`, `{ boolean }`,
 * `{ null: true }`, `{ undefined: true }`, `{ array }` with `{ hole: true }`
 * for a hole, and `{ object: [[key, value], …] }` for a plain object, its
 * own enumerable string keys in `Object.keys` order (`__proto__` among
 * them when it is an own key). `readTyped` reads back what it wrote.
 *
 * Anything else is no value a store holds, and throws a `TypedFormError`,
 * unsent: a symbol, a function, bytes (a Buffer, a typed array, an
 * ArrayBuffer: the page's data is SWM-7's encoder's), an object of
 * another class (a Date, a Map, an Error), or a value that holds itself.
 *
 * @param {*} value
 * @returns {object}
 */
function writeTyped(value) {
  return writeValue(value, new Set());
}

function writeValue(value, holding) {
  switch (typeof value) {
    case 'string':
      return { string: value };
    case 'number':
      return { number: numberText(value) };
    case 'bigint':
      return { bigint: value.toString() };
    case 'boolean':
      return { boolean: value };
    case 'undefined':
      return { undefined: true };
    case 'object':
      break;
    default:
      throw new TypedFormError(`a ${typeof value} has no typed form`);
  }
  if (value === null) return { null: true };
  if (holding.has(value)) throw new TypedFormError('a value holds itself');
  holding.add(value);
  try {
    if (Array.isArray(value)) {
      const items = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        items[i] = Object.hasOwn(value, i) ? writeValue(value[i], holding) : { hole: true };
      }
      return { array: items };
    }
    if (!isPlainObject(value)) {
      const name = value.constructor?.name || 'unnamed';
      throw new TypedFormError(`an object of class ${name} is no store value`);
    }
    return { object: Object.keys(value).map((key) => [key, writeValue(value[key], holding)]) };
  } finally {
    holding.delete(value);
  }
}

/** The methods whose `data` is data (design 0015, Main's encoding). */
const DATA_METHODS = new Set([
  'swarm_publishData',
  'swarm_publishChunk',
  'swarm_writeSingleOwnerChunk',
  'swarm_writeFeedEntry',
  'swarm_sendPss',
  'swarm_sendGsoc',
]);

/**
 * The most of a page's data the params carry inline, all values together:
 * the rest goes as parts, so the request stays within one frame (1 MiB)
 * with room for everything else in it.
 */
const INLINE_TOTAL = 256 * 1024;

/**
 * What a position of `method`'s params reads: `'data'` (bytes, or a
 * string's UTF-8), `'bytes'` (bytes only: a string there keeps its tag), or
 * false.
 */
function dataAt(method, path) {
  if (DATA_METHODS.has(method) && path.length === 1 && path[0] === 'data') return 'data';
  if (method === 'swarm_publishFiles' && path.length === 3 && path[0] === 'files' && path[2] === 'bytes') {
    return 'bytes';
  }
  return false;
}

const isBufferJson = (value) =>
  value !== null && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data);

/** What JavaScript held: `Buffer`, `Uint8Array`, `ArrayBuffer` or `BufferJSON`. */
function kindOf(value) {
  if (Buffer.isBuffer(value)) return 'Buffer';
  if (value instanceof Uint8Array) return 'Uint8Array';
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  return 'BufferJSON';
}

/**
 * The bytes `normalizeBytes` (or a string's UTF-8) gives for `value`, as a
 * view, with whether making it copied anything; or null.
 */
function dataBytes(value) {
  if (typeof value === 'string') return { view: Buffer.from(value, 'utf-8'), kind: 'string', copied: true };
  if (value instanceof Uint8Array) return { view: value, kind: kindOf(value), copied: false };
  if (value instanceof ArrayBuffer) return { view: new Uint8Array(value), kind: 'ArrayBuffer', copied: false };
  if (isBufferJson(value)) return { view: Buffer.from(value.data), kind: 'BufferJSON', copied: true };
  return null;
}

/** Base64 of a view's own bytes (never the rest of its buffer). */
const base64Of = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');

/**
 * Writes a page's params for `method` in the typed form (above, "A page's
 * params"). Throws a `TypedFormError` for a value the form has no tag for
 * (a symbol, a function) or one that holds itself; page-requests' walk
 * lets neither through.
 *
 * @param {string} method
 * @param {*} params - as the page sent them
 * @returns {{ typed: object, parts: Map<number, Uint8Array>, copies: number }}
 *   the typed params; each part's bytes by its number; and how many of
 *   those bytes main copied to make them (a string's UTF-8, a
 *   `{ type: 'Buffer', data }`), the inline ones included
 */
function writePageParams(method, params) {
  const parts = new Map();
  const state = { inline: 0, copies: 0 };
  const holding = new Set();
  const write = (value, path) => {
    const reads = dataAt(method, path);
    if (reads && (reads === 'data' || typeof value !== 'string')) {
      const bytes = dataBytes(value);
      if (bytes) {
        const length = bytes.view.byteLength;
        if (bytes.copied) state.copies += length;
        const tag = bytes.kind === 'string' ? { string_bytes: length } : { bytes: length, kind: bytes.kind };
        if (length <= INLINE_BYTES && state.inline + length <= INLINE_TOTAL) {
          state.inline += length;
          return { ...tag, base64: base64Of(bytes.view) };
        }
        const part = parts.size;
        parts.set(part, bytes.view);
        return { ...tag, part };
      }
    }
    switch (typeof value) {
      case 'string':
        return { string: value };
      case 'number':
        return { number: numberText(value) };
      case 'bigint':
        return { bigint: value.toString() };
      case 'boolean':
        return { boolean: value };
      case 'undefined':
        return { undefined: true };
      case 'object':
        break;
      default:
        throw new TypedFormError(`a ${typeof value} has no typed form`);
    }
    if (value === null) return { null: true };
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      // Bytes where no method reads them: their kind and bytes, all the same.
      const view = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      return { bytes_elsewhere: view.byteLength, kind: kindOf(value), base64: base64Of(view) };
    }
    if (holding.has(value)) throw new TypedFormError('a value holds itself');
    holding.add(value);
    try {
      if (Array.isArray(value)) {
        const items = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
          items[i] = Object.hasOwn(value, i) ? write(value[i], [...path, i]) : { hole: true };
        }
        return { array: items };
      }
      return { object: Object.keys(value).map((key) => [key, write(value[key], [...path, key])]) };
    } finally {
      holding.delete(value);
    }
  };
  const typed = write(params, []);
  return { typed, parts, copies: state.copies };
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
  INLINE_TOTAL,
  SwarmData,
  TypedFormError,
  isNullish,
  param,
  readPlain,
  readTyped,
  truthy,
  truthyParam,
  writePageParams,
  writeTyped,
};
