/** Fixed canonical local-record transfer. This is a data protocol, never custody
 * or permission. The job broker owns contiguous outer IDs and key id 1; these
 * helpers own only the inner chunk index. No generic payload or file route. */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { TextDecoder } = require('util');
const { shape } = require('./railgun-relay-quote-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const {
  decodeRailgunRelayLocalRecord,
  RAILGUN_RELAY_LOCAL_LIMITS,
} = require('./railgun-relay-recovery-data');
const CHUNK = 16384,
  MAX = RAILGUN_RELAY_LOCAL_LIMITS.record;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const refusal = () =>
  Object.assign(new Error('Railgun relay record stream refused'), {
    code: 'RAILGUN_RELAY_RECORD_STREAM_REFUSED',
  });
const bounded = (v) => assert.ok(Buffer.byteLength(JSON.stringify(v)) < 65536);
function checkedManifest(v) {
  shape(v, ['schema', 'bytes', 'sha256', 'chunks']);
  assert.equal(v.schema, 'railgun-relay-local-record-stream-v1');
  assert.ok(Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= MAX);
  assert.equal(typeof v.sha256, 'string');
  assert.match(v.sha256, /^[0-9a-f]{64}$/);
  assert.equal(v.chunks, Math.ceil(v.bytes / CHUNK));
  return Object.freeze({ ...v });
}
function sender(text, signal, method, state) {
  let bytes,
    index = 0,
    closed = false,
    subscribed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bytes?.fill(0);
    if (subscribed) {
      subscribed = false;
      EventTarget.prototype.removeEventListener.call(signal, 'abort', close);
    }
  };
  try {
    assertRailgunRelaySignal(signal);
    assert.equal(decodeRailgunRelayLocalRecord(text).state, state);
    bytes = Buffer.from(text);
    const manifest = checkedManifest({
      schema: 'railgun-relay-local-record-stream-v1',
      bytes: bytes.length,
      sha256: sha(bytes),
      chunks: Math.ceil(bytes.length / CHUNK),
    });
    EventTarget.prototype.addEventListener.call(signal, 'abort', close, { once: true });
    subscribed = true;
    return Object.freeze({
      manifest,
      close,
      read(message) {
        try {
          assertRailgunRelaySignal(signal);
          assert.equal(closed, false);
          shape(message, ['method', 'index']);
          assert.equal(message.method, method);
          assert.equal(message.index, index);
          assert.ok(index < manifest.chunks);
          bounded(message);
          const result = Object.freeze({
            index,
            data: bytes
              .subarray(index * CHUNK, Math.min(bytes.length, (index + 1) * CHUNK))
              .toString('hex'),
          });
          bounded(result);
          index++;
          if (index === manifest.chunks) close();
          return result;
        } catch {
          close();
          throw refusal();
        }
      },
    });
  } catch {
    close();
    throw refusal();
  }
}
function reader(options, method, state) {
  let used = false;
  try {
    shape(options, ['manifest', 'request', 'signal']);
    const { request, signal } = options;
    assertRailgunRelaySignal(signal);
    assert.equal(typeof request, 'function');
    const manifest = checkedManifest(options.manifest);
    return Object.freeze({
      async read() {
        let bytes;
        try {
          assert.equal(used, false);
          used = true;
          assertRailgunRelaySignal(signal);
          bytes = Buffer.alloc(manifest.bytes);
          for (let index = 0; index < manifest.chunks; index++) {
            // Do not race against abort. The original request remains observed.
            const value = await request(Object.freeze({ method, index }));
            assertRailgunRelaySignal(signal);
            shape(value, ['index', 'data']);
            assert.equal(value.index, index);
            const length = Math.min(CHUNK, manifest.bytes - index * CHUNK);
            assert.equal(typeof value.data, 'string');
            assert.equal(value.data.length, length * 2);
            assert.match(value.data, /^[0-9a-f]+$/);
            bounded(value);
            Buffer.from(value.data, 'hex').copy(bytes, index * CHUNK);
          }
          assert.equal(sha(bytes), manifest.sha256);
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          assert.equal(decodeRailgunRelayLocalRecord(text).state, state);
          assertRailgunRelaySignal(signal);
          return text;
        } catch {
          throw refusal();
        } finally {
          bytes?.fill(0);
        }
      },
    });
  } catch {
    throw refusal();
  }
}
module.exports = {
  createRailgunRelayProofRecordSender: (text, signal) =>
    sender(text, signal, 'relay-proof-record', 'signed'),
  createRailgunRelayVerifyRecordSender: (text, signal) =>
    sender(text, signal, 'relay-verify-record', 'ready-local'),
  createRailgunRelayProofRecordReader: (options) => reader(options, 'relay-proof-record', 'signed'),
  createRailgunRelayVerifyRecordReader: (options) =>
    reader(options, 'relay-verify-record', 'ready-local'),
};
