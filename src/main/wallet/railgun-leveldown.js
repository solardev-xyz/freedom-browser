/** Injected engine LevelDOWN bridge; no engine imports or file/key authority. */
function createRailgunLeveldown({ AbstractLevelDOWN, AbstractIterator, store }) {
  const iterators = new Set();
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
      this.rows = store.snapshot(options, options.values === false);
      this.position = 0;
      this.count = 0;
      this.disposed = false;
      if (options.reverse) this.rows.reverse();
      iterators.add(this);
    }
    dispose() {
      for (const [k, v] of this.rows) {
        k.fill(0);
        v.fill(0);
      }
      this.rows = [];
      this.disposed = true;
      iterators.delete(this);
    }
    _next(callback) {
      finish(callback, () => {
        if (this.disposed) throw new Error('Railgun iterator revoked');
        if (
          this.position >= this.rows.length ||
          (this.options.limit >= 0 && this.count >= this.options.limit)
        )
          return [];
        const [k, v] = this.rows[this.position++];
        this.count++;
        const format = (b, asBuffer) => (asBuffer === false ? b.toString() : Buffer.from(b));
        return [
          this.options.keys === false ? undefined : format(k, this.options.keyAsBuffer),
          this.options.values === false ? undefined : format(v, this.options.valueAsBuffer),
        ];
      });
    }
    _seek(target) {
      active();
      if (this.disposed) throw new Error('Railgun iterator revoked');
      const index = this.rows.findIndex(([k]) =>
        this.options.reverse ? Buffer.compare(k, target) <= 0 : Buffer.compare(k, target) >= 0
      );
      this.position = index < 0 ? this.rows.length : index;
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
        const snapshot = store.snapshot(options, true);
        try {
          if (options.reverse) snapshot.reverse();
          const rows = options.limit >= 0 ? snapshot.slice(0, options.limit) : snapshot;
          if (rows.length) store.batch(rows.map(([key]) => ({ type: 'del', key })));
        } finally {
          for (const [key] of snapshot) key.fill(0);
        }
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
