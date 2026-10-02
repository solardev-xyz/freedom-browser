/** Development host capability broker. Main owns the encrypted database and
 * grants RPC; an engine child receives only bounded JSON commands. This module
 * neither launches a process nor grants signing, artifacts, POI or broadcasting.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunStore } = require('./railgun-store');
const MAX_MESSAGE = 2 * 1024 * 1024;
const READS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
]);
const fail = () =>
  Object.assign(new Error('Railgun session unavailable'), { code: 'RAILGUN_SESSION_REVOKED' });
const shape = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function decode(value, max, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(max / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || (!empty && !bytes.length) || bytes.toString('base64') !== value)
    throw fail();
  return bytes;
}
function range(input) {
  const keys = ['gt', 'gte', 'lt', 'lte', 'reverse', 'limit', 'keys', 'values'];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw fail();
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (['gt', 'gte', 'lt', 'lte'].includes(key)) result[key] = decode(value, 4096);
    else if (key === 'limit') {
      if (!Number.isInteger(value) || value < -1 || value > 65536) throw fail();
      result[key] = value;
    } else {
      if (typeof value !== 'boolean') throw fail();
      result[key] = value;
    }
  }
  return result;
}
function createRailgunSession({ handle, storage, createProvider, onClose }) {
  const owner = getPrivacyContext(handle);
  if (
    owner.subject.kind !== 'private-account' ||
    owner.subject.protocol !== 'railgun' ||
    owner.subject.role !== 'engine' ||
    owner.subject.chainId !== 11155111 ||
    owner.subject.operation !== null ||
    typeof createProvider !== 'function' ||
    typeof onClose !== 'function'
  )
    throw fail();
  const scope = createPrivacyScope({
    profileId: owner.profileId,
    signal: owner.signal,
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const subject = { ...owner.subject };
  delete subject.operation;
  const storeHandle = scope.getContext({ ...subject, role: 'storage' }, owner.requirements);
  const rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' }, owner.requirements);
  let store,
    provider,
    closed = false,
    lastId = 0,
    pending = 0,
    nextCursor = 0;
  const cursors = new Map();
  const wipe = (rows) => {
    for (const [key, value] of rows) {
      key.fill(0);
      value.fill(0);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    scope.signal.removeEventListener('abort', close);
    scope.close();
    for (const cursor of cursors.values()) wipe(cursor.rows);
    cursors.clear();
    try {
      store?.close();
    } finally {
      try {
        onClose();
      } catch {
        // Capabilities are already revoked. The owner must still observe process
        // exit before releasing its slot; callback failure cannot reopen access.
      }
    }
  };
  const active = () => {
    if (closed || scope.signal.aborted) throw fail();
    getPrivacyContext(storeHandle);
    getPrivacyContext(rpcHandle);
    store.assertActive();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  try {
    store = createRailgunStore({ ...storage, handle: storeHandle, onFatal: close });
    provider = createProvider({ handle: rpcHandle, signal: scope.signal });
    if (typeof provider?.request !== 'function' || provider.signal !== scope.signal) throw fail();
    active();
  } catch (error) {
    close();
    throw error;
  }
  async function execute(method, args) {
    active();
    if (method === 'rpc') {
      if (
        !shape(args, ['method', 'params']) ||
        !READS.has(args.method) ||
        !Array.isArray(args.params) ||
        Buffer.byteLength(JSON.stringify(args)) > 65536
      )
        throw fail();
      // The trusted factory must also constrain contracts, selectors and ranges.
      const value = await provider.request(args, { signal: scope.signal });
      active();
      if (args.method === 'eth_chainId' && value !== '0xaa36a7') throw fail();
      return value;
    }
    if (method === 'get' && shape(args, ['key'])) {
      return store.get(decode(args.key, 4096))?.toString('base64') ?? null;
    }
    if (method === 'getMany' && shape(args, ['keys'])) {
      if (!Array.isArray(args.keys) || args.keys.length > 1024) throw fail();
      // No await between reads: the batch observes one host snapshot. Bound the
      // aggregate before retaining an oversized response, never return a prefix.
      let size = 0;
      return args.keys.map((key) => {
        const value = store.get(decode(key, 4096))?.toString('base64') ?? null;
        size += (value?.length ?? 4) + 3;
        if (size > MAX_MESSAGE - 128) throw fail();
        return value;
      });
    }
    if (method === 'batch' && shape(args, ['operations'])) {
      if (
        !Array.isArray(args.operations) ||
        !args.operations.length ||
        args.operations.length > 1024
      )
        throw fail();
      const operations = [];
      try {
        for (const op of args.operations) {
          if (
            !shape(op, op?.type === 'put' ? ['type', 'key', 'value'] : ['type', 'key']) ||
            !['put', 'del'].includes(op.type)
          )
            throw fail();
          const key = decode(op.key, 4096);
          operations.push({ type: op.type, key });
          if (op.type === 'put') operations.at(-1).value = decode(op.value, 1024 * 1024, true);
        }
        store.batch(operations);
        return null;
      } finally {
        for (const op of operations) {
          op.key.fill(0);
          op.value?.fill(0);
        }
      }
    }
    if ((method === 'open' || method === 'clear') && shape(args, ['options'])) {
      const options = range(args.options);
      if (method === 'open' && cursors.size >= 2) throw fail();
      const rows = store.snapshot(options, method === 'clear' || options.values === false);
      if (options.reverse) rows.reverse();
      if (method === 'clear') {
        try {
          const selected = options.limit >= 0 ? rows.slice(0, options.limit) : rows;
          if (selected.length) store.batch(selected.map(([key]) => ({ type: 'del', key })));
          return null;
        } finally {
          wipe(rows);
        }
      }
      const cursor = ++nextCursor;
      cursors.set(cursor, { rows, options, position: 0, count: 0 });
      return cursor;
    }
    if (
      ['next', 'seek', 'end'].includes(method) &&
      shape(args, method === 'seek' ? ['cursor', 'target'] : ['cursor'])
    ) {
      if (!Number.isSafeInteger(args.cursor) || !cursors.has(args.cursor)) throw fail();
      const cursor = cursors.get(args.cursor),
        { rows, options } = cursor;
      if (method === 'end') {
        wipe(rows);
        cursors.delete(args.cursor);
        return null;
      }
      if (method === 'seek') {
        const target = decode(args.target, 4096);
        const index = rows.findIndex(([key]) =>
          options.reverse ? Buffer.compare(key, target) <= 0 : Buffer.compare(key, target) >= 0
        );
        cursor.position = index < 0 ? rows.length : index;
        return null;
      }
      if (cursor.position >= rows.length || (options.limit >= 0 && cursor.count >= options.limit))
        return null;
      cursor.count++;
      const [key, value] = rows[cursor.position++];
      return [
        options.keys === false ? null : key.toString('base64'),
        options.values === false ? null : value.toString('base64'),
      ];
    }
    throw fail();
  }
  async function dispatch(wire) {
    let timer,
      counted = false;
    try {
      active();
      if (
        typeof wire !== 'string' ||
        wire.length > MAX_MESSAGE ||
        Buffer.byteLength(wire) > MAX_MESSAGE
      )
        throw fail();
      const message = JSON.parse(wire);
      if (
        !shape(message, ['id', 'method', 'args']) ||
        !Number.isSafeInteger(message.id) ||
        message.id !== lastId + 1 ||
        typeof message.method !== 'string' ||
        pending >= 8
      )
        throw fail();
      lastId = message.id;
      pending++;
      counted = true;
      timer = setTimeout(close, 30000);
      const value = await scope.run(rpcHandle, () => execute(message.method, message.args));
      active();
      const response = JSON.stringify({ id: message.id, value });
      if (value === undefined || Buffer.byteLength(response) > MAX_MESSAGE) throw fail();
      return response;
    } catch {
      close();
      throw fail();
    } finally {
      clearTimeout(timer);
      if (counted) pending--;
    }
  }
  return Object.freeze({ dispatch, close, signal: scope.signal });
}
module.exports = { createRailgunSession };
