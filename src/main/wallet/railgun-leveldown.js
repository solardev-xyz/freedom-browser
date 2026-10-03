/** Injected engine LevelDOWN bridge; no engine imports or file/key authority. */
const { createRailgunStoreCursor, clearRailgunStore } = require('./railgun-store-cursor');
function createRailgunLeveldown({ AbstractLevelDOWN, AbstractIterator, store }) {
  const iterators = new Set();
  // Encoding-down adds presentation options (keyAsBuffer, valueAsBuffer,
  // encodings). They belong to this adapter, not the strict storage range API.
  const rangeOptions = (options) =>
    Object.fromEntries(
      ['gt', 'gte', 'lt', 'lte', 'reverse', 'limit', 'keys', 'values']
        .filter((key) => options[key] !== undefined)
        .map((key) => [key, options[key]])
    );
  let closed = false;
  const active = () => {
    if (closed)
      throw Object.assign(new Error('Railgun store revoked'), { code: 'RAILGUN_STORE_REVOKED' });
    store.assertActive();
  };
  const finish = (callback, work) =>
    queueMicrotask(() => {
      let result;
      try {
        active();
        result = work();
      } catch (error) {
        callback(error);
        return;
      }
      callback(null, ...result);
    });
  const close = () => {
    closed = true;
    for (const iterator of iterators) iterator.dispose();
    store.signal.removeEventListener('abort', close);
    store.close();
  };
  class Iterator extends AbstractIterator {
    constructor(db, options) {
      super(db);
      active();
      if (iterators.size >= 2) throw new Error('Railgun iterator capacity exceeded');
      this.options = options;
      this.reader = createRailgunStoreCursor(store, rangeOptions(options));
      this.disposed = false;
      iterators.add(this);
    }
    dispose() {
      this.reader.close();
      this.disposed = true;
      iterators.delete(this);
    }
    _next(callback) {
      finish(callback, () => {
        if (this.disposed) throw new Error('Railgun iterator revoked');
        const row = this.reader.next();
        if (!row) return [];
        const [k, v] = row;
        const format = (b, asBuffer) => (asBuffer === false ? b.toString() : Buffer.from(b));
        try {
          return [
            this.options.keys === false ? undefined : format(k, this.options.keyAsBuffer),
            this.options.values === false ? undefined : format(v, this.options.valueAsBuffer),
          ];
        } finally {
          k.fill(0);
          v.fill(0);
        }
      });
    }
    _seek(target) {
      active();
      if (this.disposed) throw new Error('Railgun iterator revoked');
      this.reader.seek(target);
    }
    _end(callback) {
      this.dispose();
      queueMicrotask(callback);
    }
  }
  class Leveldown extends AbstractLevelDOWN {
    constructor() {
      super({ snapshots: true, permanence: true, seek: true });
    }
    _serializeKey(value) {
      if (value == null) return value;
      if (typeof value !== 'string' && !(value instanceof Uint8Array))
        throw new Error('Railgun bytes required');
      return Buffer.from(value);
    }
    _serializeValue(value) {
      if (value == null) return value;
      if (typeof value !== 'string' && !(value instanceof Uint8Array))
        throw new Error('Railgun bytes required');
      return Buffer.from(value);
    }
    _open(_options, callback) {
      finish(callback, () => []);
    }
    _close(callback) {
      close();
      queueMicrotask(callback);
    }
    _get(key, options, callback) {
      finish(callback, () => {
        const value = store.get(key);
        if (value === null)
          throw Object.assign(new Error('NotFound'), { notFound: true, status: 404 });
        return [options.asBuffer === false ? value.toString() : value];
      });
    }
    _put(key, value, _options, callback) {
      finish(callback, () => {
        store.batch([{ type: 'put', key, value }]);
        return [];
      });
    }
    _getMany(keys, options, callback) {
      finish(callback, () => [
        keys.map((key) => {
          const value = store.get(key);
          return value === null ? undefined : options.asBuffer === false ? value.toString() : value;
        }),
      ]);
    }
    _del(key, _options, callback) {
      finish(callback, () => {
        store.batch([{ type: 'del', key }]);
        return [];
      });
    }
    _batch(operations, _options, callback) {
      finish(callback, () => {
        if (operations.length)
          store.batch(
            operations.map(({ type, key, value }) =>
              type === 'put' ? { type, key, value } : { type, key }
            )
          );
        return [];
      });
    }
    _clear(options, callback) {
      finish(callback, () => {
        clearRailgunStore(store, rangeOptions(options));
        return [];
      });
    }
    _iterator(options) {
      return new Iterator(this, options);
    }
  }
  store.signal.addEventListener('abort', close, { once: true });
  active();
  return new Leveldown();
}
module.exports = { createRailgunLeveldown };
