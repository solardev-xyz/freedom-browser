'use strict';

/**
 * The size walk for page requests (freedom-core design 0011, "Bounds", "The
 * size and the charge"; step PRQ-2).
 *
 * One walk over a request gives its size and its counts. The tab preload
 * walks each request before it sends it, and main walks it again as it
 * arrives, the same way, so both refuse the same requests:
 *
 *   - It takes strings, numbers, BigInts, booleans, null, undefined, arrays,
 *     plain objects, Uint8Array and ArrayBuffer. Anything else (another
 *     typed array, a DataView, a Map, a Date, a Blob) is refused (`type`).
 *   - At most 10,000 values (`values`), nested at most 32 levels (`depth`),
 *     the request object itself being the first.
 *   - A BigInt whose magnitude needs more than 256 bits is refused
 *     (`bigint`); one it takes counts 32 bytes.
 *   - The size is the UTF-8 bytes of every string and property name (a lone
 *     surrogate as U+FFFD, three bytes), the bytes of binary data (a
 *     Uint8Array at its buffer's whole length), and 32 per BigInt. Numbers,
 *     booleans, null and undefined add nothing to the size, only a value.
 *   - Past its method's size (`size`): `swarm_publishData` and
 *     `swarm_publishFiles` may carry their payload limit plus 64 KiB, every
 *     other method 1 MiB. A request over 1 MiB needs a ticket first
 *     (`page:reserve`).
 *
 * The walk stops at the first limit it passes, so a hostile request costs
 * no more than its limit to measure.
 *
 * A sandboxed preload can't require this module, so webview-preload.js
 * carries a copy of the code between the BEGIN and END lines below, and
 * page-request-bounds.test.js fails if the two differ by a byte.
 */

// BEGIN page-request-bounds
const PAGE_REQUEST_LIMITS = Object.freeze({
  maxValues: 10000,
  maxDepth: 32,
  bigintBits: 256,
  bigintBytes: 32,
  defaultBytes: 1024 * 1024,
  ticketAbove: 1024 * 1024,
});

// Today's Swarm payload limits (`LIMITS` in swarm-provider-ipc.js), which
// the two methods that carry data or files may fill, plus 64 KiB for the
// rest of the request.
const PAGE_REQUEST_PAYLOADS = Object.freeze({
  'swarm:swarm_publishData': Object.freeze({
    limit: 10 * 1024 * 1024,
    message: 'Payload exceeds maximum size of 10485760 bytes',
  }),
  'swarm:swarm_publishFiles': Object.freeze({
    limit: 50 * 1024 * 1024,
    message: 'Total size exceeds maximum of 52428800 bytes',
  }),
});
const PAGE_REQUEST_REST = 64 * 1024;
const PAGE_REQUEST_BIGINT_BOUND = 1n << BigInt(PAGE_REQUEST_LIMITS.bigintBits);

function pageRequestPayload(provider, method) {
  const key = `${provider}:${method}`;
  return Object.prototype.hasOwnProperty.call(PAGE_REQUEST_PAYLOADS, key) ? PAGE_REQUEST_PAYLOADS[key] : null;
}

/** The most a request of this method may measure, in bytes. */
function pageRequestMaxBytes(provider, method) {
  const payload = pageRequestPayload(provider, method);
  return payload ? payload.limit + PAGE_REQUEST_REST : PAGE_REQUEST_LIMITS.defaultBytes;
}

// The UTF-8 length of a string, stopping once it passes `cap`.
function pageRequestUtf8Length(text, cap) {
  // Every UTF-16 unit takes at least one UTF-8 byte.
  if (text.length > cap) return text.length;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > cap) return bytes;
  }
  return bytes;
}

function pageRequestIsPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk `root` against `maxBytes`. A top-level property named `skipKey` is
 * left out (main's own ticket). `replaceView(view)`, when given, is called
 * for a Uint8Array that doesn't span its buffer, and its answer takes the
 * view's place in its parent and is measured instead (the preload sends a
 * copy of just the view's bytes).
 *
 * @returns {{ok: true, size: number, values: number, names: number} |
 *   {ok: false, reason: 'type'|'values'|'depth'|'bigint'|'size', size: number}}
 */
function measurePageRequest(root, maxBytes, options = {}) {
  const skipKey = options.skipKey === undefined ? null : options.skipKey;
  const replaceView = typeof options.replaceView === 'function' ? options.replaceView : null;
  const max = PAGE_REQUEST_LIMITS.maxValues;
  let size = 0;
  let values = 0;
  let names = 0;
  // Four slots per value still to walk: the value, its depth, its parent
  // and its key in the parent.
  const stack = [root, 1, null, null];
  const fail = (reason) => ({ ok: false, reason, size });
  while (stack.length > 0) {
    const key = stack.pop();
    const parent = stack.pop();
    const depth = stack.pop();
    let value = stack.pop();
    values += 1;
    if (values > max) return fail('values');
    if (depth > PAGE_REQUEST_LIMITS.maxDepth) return fail('depth');
    const type = typeof value;
    if (type === 'string') {
      size += pageRequestUtf8Length(value, maxBytes - size);
    } else if (type === 'bigint') {
      if (value >= PAGE_REQUEST_BIGINT_BOUND || value <= -PAGE_REQUEST_BIGINT_BOUND) return fail('bigint');
      size += PAGE_REQUEST_LIMITS.bigintBytes;
    } else if (type === 'number' || type === 'boolean' || type === 'undefined' || value === null) {
      // A value, and nothing more.
    } else if (type !== 'object') {
      return fail('type');
    } else if (value instanceof Uint8Array) {
      if (replaceView && parent !== null && (value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength)) {
        value = replaceView(value);
        parent[key] = value;
      }
      size += value.buffer.byteLength;
    } else if (value instanceof ArrayBuffer) {
      size += value.byteLength;
    } else if (Array.isArray(value)) {
      if (values + stack.length / 4 + value.length > max) return fail('values');
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i], depth + 1, value, i);
    } else if (pageRequestIsPlainObject(value)) {
      for (const name in value) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
        if (depth === 1 && name === skipKey) continue;
        if (values + stack.length / 4 + 1 > max) return fail('values');
        names += 1;
        size += pageRequestUtf8Length(name, maxBytes - size);
        if (size > maxBytes) return fail('size');
        stack.push(value[name], depth + 1, value, name);
      }
    } else {
      return fail('type');
    }
    if (size > maxBytes) return fail('size');
  }
  return { ok: true, size, values, names };
}

/** The error a page gets for a request the walk refuses. */
function pageRequestWalkError(reason, provider, method, size) {
  if (reason === 'size') {
    const payload = pageRequestPayload(provider, method);
    if (payload) {
      return {
        code: -32602,
        message: payload.message,
        data: { reason: 'payload_too_large', limit: payload.limit, actual: size },
      };
    }
    return { code: -32005, message: 'Limit exceeded' };
  }
  if (reason === 'values' || reason === 'depth') return { code: -32005, message: 'Limit exceeded' };
  return { code: -32602, message: 'Invalid parameters' };
}
// END page-request-bounds

module.exports = {
  PAGE_REQUEST_LIMITS,
  PAGE_REQUEST_PAYLOADS,
  PAGE_REQUEST_REST,
  pageRequestMaxBytes,
  pageRequestUtf8Length,
  measurePageRequest,
  pageRequestWalkError,
};
