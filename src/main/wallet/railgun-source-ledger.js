/** Main-only append-only source cache, separate from the engine DB and journal.
 * Cached public logs are source observations, never chain proofs. A cached tail
 * may precede or outlive a journal prepare; only the journal chooses applied work.
 */
const { createHash } = require('crypto');
const { readRailgunSourceRetention } = require('./railgun-scan-journal');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const fail = () =>
  Object.assign(new Error('Railgun source ledger unavailable'), {
    code: 'RAILGUN_SOURCE_LEDGER_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const hash = (v) => createHash('sha256').update(v).digest('hex');
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const hexHash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const initial = () => ({
  version: 1,
  count: 0,
  logs: 0,
  bytes: 0,
  sha256: hash('freedom:railgun:source-ledger-v1'),
  to: -1,
  blockHash: '0x' + '0'.repeat(64),
});
const rangeKey = (n) => 'source:range:' + n.toString().padStart(5, '0');
const logKey = (r, n) => rangeKey(r) + ':log:' + n.toString().padStart(5, '0');
const encoded = (v) => Buffer.from(v).toString('base64');
function exact(v, keys) {
  return (
    v &&
    typeof v === 'object' &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
function validateMeta(v) {
  check(
    exact(v, ['version', 'count', 'logs', 'bytes', 'sha256', 'to', 'blockHash']) &&
      v.version === 1 &&
      integer(v.count) &&
      v.count <= 10000 &&
      integer(v.logs) &&
      v.logs <= 100000 &&
      integer(v.bytes) &&
      v.bytes <= 128 * 1024 * 1024 &&
      digest(v.sha256) &&
      Number.isSafeInteger(v.to) &&
      v.to >= -1 &&
      hexHash(v.blockHash)
  );
  if (!v.count) check(JSON.stringify(v) === JSON.stringify(initial()));
  return v;
}
async function createRailgunSourceLedger({ handle, filename, key, binding, create = false }) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.role === 'protocol-rpc' &&
      subject.operation === null &&
      digest(binding)
  );
  // Distinct store binding and filename; the engine never gets this worker.
  const ledgerBinding = hash('freedom:railgun:source-ledger-v1:' + binding);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: context.signal,
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const engineSubject = { ...subject, role: 'engine' };
  delete engineSubject.operation;
  let session,
    closed = false,
    busy = false,
    sequence = 0,
    identity,
    meta;
  const references = new WeakMap();
  function close() {
    if (closed) return;
    closed = true;
    scope.close();
    session?.close();
  }
  const active = () => {
    check(!closed);
    getPrivacyContext(handle);
    check(!session.signal.aborted);
  };
  try {
    session = startRailgunSessionWorker({
      handle: scope.getContext(engineSubject),
      storage: { format: 'paged-v2', filename, key, binding: ledgerBinding, create },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw fail();
        },
      }),
      onClose: close,
    });
    await session.ready;
    identity = await session.inspectStoreIdentity();
    session.assertFresh(identity);
    check(digest(identity.instanceId));
  } catch (error) {
    close();
    throw error;
  }
  async function call(method, args) {
    active();
    const id = ++sequence;
    const reply = JSON.parse(await session.dispatch(JSON.stringify({ id, method, args })));
    active();
    check(reply.id === id && Object.hasOwn(reply, 'value'));
    return reply.value;
  }
  const get = async (key) => {
    const value = await call('get', { key: encoded(key) });
    return value === null ? null : JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  };
  async function write(rows) {
    const transaction = await call('txBegin', {});
    let operations = [],
      bytes = 0;
    const flush = async () => {
      if (!operations.length) return;
      await call('txStage', { transaction, operations });
      operations = [];
      bytes = 0;
    };
    for (const [key, value] of rows) {
      const text = JSON.stringify(value);
      check(Buffer.byteLength(text) <= 1024 * 1024);
      const operation =
        value === null
          ? { type: 'del', key: encoded(key) }
          : { type: 'put', key: encoded(key), value: encoded(text) };
      const size = Buffer.byteLength(JSON.stringify(operation));
      if (operations.length && (operations.length >= 256 || bytes + size > 1500000)) await flush();
      operations.push(operation);
      bytes += size;
    }
    await flush();
    await call('txCommit', { transaction });
  }
  try {
    const stored = await get('source:meta');
    if (stored === null) {
      check(create);
      meta = initial();
      await write([['source:meta', meta]]);
    } else {
      check(!create);
      meta = validateMeta(stored);
    }
  } catch (error) {
    close();
    await session.closed;
    throw error;
  }
  function issue(range) {
    const reference = Object.freeze({ ledgerId: identity.instanceId, ledgerSha256: range.sha256 });
    references.set(reference, range);
    return reference;
  }
  async function stage(input, logs) {
    active();
    check(!busy);
    busy = true;
    try {
      const supplied = JSON.parse(JSON.stringify(input)),
        values = JSON.parse(JSON.stringify(logs));
      check(
        exact(supplied, ['from', 'to', 'previousHash', 'providersSha256', 'logs']) &&
          digest(supplied.providersSha256)
      );
      const { providersSha256, ...range } = supplied;
      check(
        integer(range.from) &&
          exact(range.to, ['number', 'hash']) &&
          integer(range.to.number) &&
          range.to.number >= range.from &&
          hexHash(range.to.hash) &&
          hexHash(range.previousHash)
      );
      check(
        exact(range.logs, ['count', 'sha256']) &&
          integer(range.logs.count) &&
          range.logs.count <= 4096 &&
          digest(range.logs.sha256)
      );
      check(Array.isArray(values) && values.length === range.logs.count);
      const text = values.map((v) => JSON.stringify(v) + '\n').join('');
      check(Buffer.byteLength(text) <= 4 * 1024 * 1024 && hash(text) === range.logs.sha256);
      // Previously acquired tails are immutable. Reacquisition can select an
      // exact existing range, never overwrite an applied source or erase history.
      if (range.from <= meta.to) {
        for (let index = 0; index < meta.count; index++) {
          const stored = await get(rangeKey(index));
          check(stored && stored.index === index);
          if (stored.range.from === range.from) {
            check(JSON.stringify(stored.range) === JSON.stringify(range));
            return issue(stored);
          }
        }
        throw fail();
      }
      check(
        range.from === meta.to + 1 && range.previousHash === meta.blockHash && meta.count < 10000
      );
      const record = {
        index: meta.count,
        providersSha256,
        range,
        previous: meta.sha256,
        sha256: hash(meta.sha256 + '\n' + JSON.stringify(range)),
      };
      const next = validateMeta({
        version: 1,
        count: meta.count + 1,
        logs: meta.logs + values.length,
        bytes: meta.bytes + Buffer.byteLength(text),
        sha256: record.sha256,
        to: range.to.number,
        blockHash: range.to.hash,
      });
      const rows = values.map((value, n) => [logKey(record.index, n), value]);
      rows.push([rangeKey(record.index), record], ['source:meta', next]);
      await write(rows);
      meta = next;
      return issue(record);
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  async function visit(reference, visitor) {
    active();
    check(!busy && typeof visitor === 'function');
    const target = references.get(reference);
    check(target);
    busy = true;
    try {
      let previous = initial(),
        count = 0,
        bytes = 0;
      for (let index = 0; index <= target.index; index++) {
        const record = await get(rangeKey(index));
        check(
          exact(record, ['index', 'providersSha256', 'range', 'previous', 'sha256']) &&
            digest(record.providersSha256) &&
            record.index === index &&
            record.previous === previous.sha256 &&
            record.sha256 === hash(record.previous + '\n' + JSON.stringify(record.range))
        );
        check(
          record.range.from === previous.to + 1 && record.range.previousHash === previous.blockHash
        );
        const logDigest = createHash('sha256');
        for (let n = 0; n < record.range.logs.count; n++) {
          const value = await get(logKey(index, n));
          check(value);
          const text = JSON.stringify(value) + '\n';
          logDigest.update(text);
          bytes += Buffer.byteLength(text);
          count++;
          check(count <= 100000 && bytes <= 128 * 1024 * 1024);
          await visitor(value);
          active();
        }
        check(logDigest.digest('hex') === record.range.logs.sha256);
        previous = {
          sha256: record.sha256,
          to: record.range.to.number,
          blockHash: record.range.to.hash,
        };
      }
      check(previous.sha256 === reference.ledgerSha256);
      return Object.freeze({ count, bytes });
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  async function nextAfter(sha256) {
    active();
    check(!busy && digest(sha256));
    busy = true;
    try {
      let previous = initial().sha256;
      for (let index = 0; index < meta.count; index++) {
        const record = await get(rangeKey(index));
        check(
          record &&
            record.index === index &&
            record.previous === previous &&
            record.sha256 === hash(previous + '\n' + JSON.stringify(record.range))
        );
        if (previous === sha256) return JSON.parse(JSON.stringify(record));
        previous = record.sha256;
      }
      check(previous === sha256);
      return null;
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  async function retain(token) {
    active();
    check(!busy);
    busy = true;
    try {
      const authority = () => readRailgunSourceRetention(token, identity.instanceId);
      const protectedState = authority();
      let previous = initial().sha256,
        checkpoint = -1,
        pending = -1;
      for (let index = 0; index < meta.count; index++) {
        const record = await get(rangeKey(index));
        check(
          record &&
            record.index === index &&
            record.previous === previous &&
            record.sha256 === hash(previous + '\n' + JSON.stringify(record.range))
        );
        if (record.sha256 === protectedState.checkpoint) checkpoint = index;
        if (record.sha256 === protectedState.pending) pending = index;
        previous = record.sha256;
      }
      check(previous === meta.sha256);
      check(
        (protectedState.checkpoint === null || checkpoint >= 0) &&
          (protectedState.pending === null || pending === checkpoint + 1)
      );
      const keep = Math.max(checkpoint, pending) + 1;
      while (meta.count > keep) {
        const index = meta.count - 1,
          record = await get(rangeKey(index));
        check(
          record.sha256 === meta.sha256 &&
            integer(record.range.logs.count) &&
            record.range.logs.count <= 4096
        );
        const rows = [],
          logDigest = createHash('sha256');
        let bytes = 0;
        for (let n = 0; n < record.range.logs.count; n++) {
          const value = await get(logKey(index, n));
          check(value);
          const text = JSON.stringify(value) + '\n';
          bytes += Buffer.byteLength(text);
          logDigest.update(text);
          rows.push([logKey(index, n), null]);
        }
        check(logDigest.digest('hex') === record.range.logs.sha256);
        const prior = index ? await get(rangeKey(index - 1)) : null;
        const next = validateMeta({
          version: 1,
          count: index,
          logs: meta.logs - record.range.logs.count,
          bytes: meta.bytes - bytes,
          sha256: record.previous,
          to: prior?.range.to.number ?? -1,
          blockHash: prior?.range.to.hash ?? initial().blockHash,
        });
        if (prior) check(prior.sha256 === record.previous);
        rows.push([rangeKey(index), null], ['source:meta', next]);
        authority();
        await write(rows);
        meta = next;
        authority();
      }
      return Object.freeze({ count: meta.count, sha256: meta.sha256 });
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    stage,
    visit,
    retain,
    nextAfter,
    close,
    identity: () => {
      active();
      return identity.instanceId;
    },
    closed: session.closed,
    signal: session.signal,
  });
}
module.exports = { createRailgunSourceLedger };
