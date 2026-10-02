/** Development host capability broker. Main owns the encrypted database and
 * grants RPC; an engine child receives only bounded JSON commands. This module
 * neither launches a process nor grants signing, artifacts, POI or broadcasting.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunStore } = require('./railgun-store');
const { createRailgunPagedStore } = require('./railgun-paged-store');
const { createRailgunStoreCursor, clearRailgunStore } = require('./railgun-store-cursor');
const { readRailgunFrontier, readRailgunPosition } = require('./railgun-frontier');
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
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value)
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
      if (!Number.isInteger(value) || value < -1 || value > 2000000) throw fail();
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
    nextCursor = 0,
    nextTransaction = 0,
    transaction;
  // This session exclusively owns the store. Every new write path must advance
  // this revision before mutation, or move revision ownership into the store.
  let revision = 0;
  const frontiers = new WeakMap();
  const observations = new WeakMap();
  const cursors = new Map();
  const discardTransaction = () => {
    if (!transaction) return;
    clearTimeout(transaction.timer);
    for (const op of transaction.operations) {
      op.key.fill(0);
      op.value?.fill(0);
    }
    transaction = undefined;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    scope.signal.removeEventListener('abort', close);
    scope.close();
    discardTransaction();
    for (const cursor of cursors.values()) cursor.reader.close();
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
    if (storage.format !== undefined && storage.format !== 'paged-v2') throw fail();
    const factory = storage.format === 'paged-v2' ? createRailgunPagedStore : createRailgunStore;
    store = factory({ ...storage, handle: storeHandle, onFatal: close });
    provider = createProvider({ handle: rpcHandle, signal: scope.signal });
    if (typeof provider?.request !== 'function' || provider.signal !== scope.signal) throw fail();
    active();
  } catch (error) {
    close();
    throw error;
  }
  async function execute(method, args) {
    active();
    if (transaction && !['txStage', 'txCommit', 'txAbort', 'txRead', 'rpc'].includes(method))
      throw fail();
    if (method === 'txRead') {
      if (
        !shape(args, ['transaction', 'method', 'args']) ||
        !transaction ||
        args.transaction !== transaction.id ||
        !['get', 'getMany'].includes(args.method)
      )
        throw fail();
      method = args.method;
      args = args.args;
      const keys =
        method === 'get' && shape(args, ['key'])
          ? [args.key]
          : method === 'getMany' &&
              shape(args, ['keys']) &&
              Array.isArray(args.keys) &&
              args.keys.length <= 1024
            ? args.keys
            : null;
      if (!keys || keys.some((key) => transaction.keys.has(decode(key, 4096).toString('hex'))))
        throw fail();
    }
    if (method === 'txBegin' && shape(args, [])) {
      if (transaction) throw fail();
      revision++;
      transaction = {
        id: ++nextTransaction,
        operations: [],
        keys: new Set(),
        bytes: 0,
        timer: setTimeout(close, 30000),
      };
      return transaction.id;
    }
    if (['txCommit', 'txAbort'].includes(method) && shape(args, ['transaction'])) {
      if (!transaction || args.transaction !== transaction.id) throw fail();
      try {
        if (method === 'txCommit' && transaction.operations.length) {
          revision++;
          store.batch(transaction.operations);
        }
      } finally {
        discardTransaction();
      }
      return null;
    }
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
    if (
      (method === 'batch' && shape(args, ['operations'])) ||
      (method === 'txStage' && shape(args, ['transaction', 'operations']))
    ) {
      const staging = method === 'txStage';
      // This initial protocol grants exclusive writes to one group. Unrelated
      // writes/clear cannot interleave; reads and snapshots see committed state.
      // Concurrent scanner/wallet write scheduling needs separate qualification.
      if (staging ? !transaction || args.transaction !== transaction.id : transaction) throw fail();
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
        if (staging) {
          const frameKeys = new Set();
          for (const op of operations) {
            const key = op.key.toString('hex');
            if (transaction.keys.has(key) || frameKeys.has(key)) throw fail();
            frameKeys.add(key);
          }
          const bytes = operations.reduce(
            (n, op) => n + op.key.length + (op.value?.length ?? 0),
            0
          );
          if (
            transaction.operations.length + operations.length > 32768 ||
            transaction.bytes + bytes > 16 * 1024 * 1024
          )
            throw fail();
          transaction.operations.push(...operations);
          for (const op of operations) transaction.keys.add(op.key.toString('hex'));
          transaction.bytes += bytes;
          operations.length = 0; // Ownership transfers to the transaction until commit/abort.
        } else {
          revision++;
          store.batch(operations);
        }
        return null;
      } finally {
        for (const op of operations) {
          op.key.fill(0);
          op.value?.fill(0);
        }
      }
    }
    if ((method === 'open' || method === 'clear') && shape(args, ['options'])) {
      if (method === 'clear' && transaction) throw fail();
      const options = range(args.options);
      if (method === 'open' && cursors.size >= 2) throw fail();
      if (method === 'clear') {
        revision++;
        clearRailgunStore(store, options);
        return null;
      }
      const cursor = ++nextCursor;
      cursors.set(cursor, { reader: createRailgunStoreCursor(store, options), options });
      return cursor;
    }
    if (
      ['next', 'nextMany', 'seek', 'end'].includes(method) &&
      shape(
        args,
        method === 'seek'
          ? ['cursor', 'target']
          : method === 'nextMany'
            ? ['cursor', 'limit']
            : ['cursor']
      )
    ) {
      if (!Number.isSafeInteger(args.cursor) || !cursors.has(args.cursor)) throw fail();
      const cursor = cursors.get(args.cursor),
        { reader, options } = cursor;
      if (method === 'end') {
        reader.close();
        cursors.delete(args.cursor);
        return null;
      }
      if (method === 'seek') {
        const target = decode(args.target, 4096);
        try {
          reader.seek(target);
        } finally {
          target.fill(0);
        }
        return null;
      }
      const next = () => {
        const row = reader.next();
        if (!row) return null;
        const [key, value] = row;
        try {
          return [
            options.keys === false ? null : key.toString('base64'),
            options.values === false ? null : value.toString('base64'),
          ];
        } finally {
          key.fill(0);
          value.fill(0);
        }
      };
      if (method === 'next') return next();
      if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 128) throw fail();
      const rows = [];
      let size = 128;
      while (rows.length < args.limit) {
        const row = next();
        if (!row) return { rows, done: true };
        const bytes = JSON.stringify(row).length + 1;
        // Stop after crossing the target size. One bounded row added to less
        // than 512 KiB remains below the hard 2 MiB frame cap, without consuming
        // an invisible overflow row that would alter seek/limit semantics.
        rows.push(row);
        size += bytes;
        if (size > 512 * 1024) break;
      }
      return { rows, done: false };
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
  const unavailable = (code) => Object.assign(new Error('Railgun frontier unavailable'), { code });
  const inspectFrontier = () => {
    active();
    if (transaction) throw unavailable('RAILGUN_FRONTIER_BUSY');
    try {
      // No await: metadata, roots and cursor are read from one main-owned store
      // revision. This is an engine-state observation, never a chain attestation.
      const result = readRailgunFrontier((key) => store.get(key));
      frontiers.set(result, revision);
      observations.set(result, revision);
      return result;
    } catch {
      close();
      throw unavailable('RAILGUN_FRONTIER_INVALID');
    }
  };
  const inspectPosition = (frontier, { tree, index } = {}) => {
    active();
    if (transaction || frontiers.get(frontier) !== revision)
      throw unavailable('RAILGUN_FRONTIER_STALE');
    try {
      const result = readRailgunPosition((key) => store.get(key), frontier, tree, index);
      observations.set(result, revision);
      return result;
    } catch (error) {
      if (error.code === 'RAILGUN_FRONTIER_NOT_ELIGIBLE') throw error;
      close();
      throw unavailable('RAILGUN_FRONTIER_INVALID');
    }
  };
  // Consumers must revalidate immediately before use, with no intervening await.
  // Freshness never upgrades an observation into verified chain state.
  const assertFresh = (observation) => {
    active();
    if (transaction || observations.get(observation) !== revision)
      throw unavailable('RAILGUN_FRONTIER_STALE');
  };
  return Object.freeze({
    dispatch,
    close,
    signal: scope.signal,
    inspectFrontier,
    inspectPosition,
    assertFresh,
  });
}
module.exports = { createRailgunSession };
