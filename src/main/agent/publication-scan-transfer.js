'use strict';

// Structured clone (worker postMessage) turns a Buffer into a plain Uint8Array
// and drops Object.freeze. These put both back, so a scan that crossed a
// thread looks exactly like one run in place: the upload code and the scan
// rules see the same Buffers either way. Zero-copy views, not copies.

function asBuffer(bytes) {
  if (bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return bytes;
}

function withBuffers(source) {
  if (!source || typeof source !== 'object') return source;
  return {
    ...source,
    ...(source.data !== undefined && { data: asBuffer(source.data) }),
    ...(Array.isArray(source.files) && { files: source.files.map(file => ({ ...file, bytes: asBuffer(file.bytes) })) }),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

// The shape preparePublication returns, rebuilt from a cloned copy.
function revivePreparedPublication(scan) {
  const source = withBuffers(scan.source);
  if (Array.isArray(source.files)) source.files = source.files.map(file => Object.freeze(file));
  return deepFreeze({ ...scan, source });
}

module.exports = { revivePreparedPublication, withBuffers };
