/** Child-side asynchronous LevelDOWN and RPC bridge. Injected engine classes;
 * no database path/key, URL, vault, spending key or signing operation exists here.
 * The caller supplies a private point-to-point request/reply transport.
 */
const fail = () =>
  Object.assign(new Error('Railgun session unavailable'), { code: 'RAILGUN_SESSION_REVOKED' });
function createRailgunRemote({ AbstractLevelDOWN, AbstractIterator, send, signal }) {
  const { AsyncLocalStorage } = require('async_hooks');
  const writeScope = new AsyncLocalStorage();
  let writing = false;
  if (typeof send !== 'function' || !(signal instanceof AbortSignal)) throw fail();
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  let sequence = 0,
    pending = 0,
    queuedBytes = 0;
  const queue = [];
  const active = () => {
    if (lifetime.aborted) throw fail();
  };
  const close = () => controller.abort();
  lifetime.addEventListener(
    'abort',
    () => {
      for (const item of queue.splice(0)) {
        clearTimeout(item.deadline);
        item.payload = '';
        item.reject(fail());
      }
      queuedBytes = 0;
    },
    { once: true }
  );
  function pump() {
    while (!lifetime.aborted && pending < 8 && queue.length) {
      const item = queue.shift();
      queuedBytes -= item.bytes;
      clearTimeout(item.deadline);
      pending++;
      const { method, args } = JSON.parse(item.payload);
      item.payload = '';
      exchange(method, args)
        .then(item.resolve, item.reject)
        .finally(() => {
          pending--;
          pump();
        });
    }
  }
  function call(method, args) {
    try {
      active();
      const group = writeScope.getStore();
      const control = ['txBegin', 'txStage', 'txCommit', 'txAbort'].includes(method);
      const rpc = method === 'rpc';
      if (!rpc && ((group && !group.open) || (writing && !group && !control))) throw fail();
      if (group?.begin && !group.id && !control && !rpc) {
        const snapshot = JSON.parse(JSON.stringify(args));
        return group.begin.then(() => call(method, snapshot));
      }
      if (group?.id && !control && !rpc) {
        if (!['get', 'getMany'].includes(method)) throw fail();
        args = { transaction: group.id, method, args };
        method = 'txRead';
      }
      // Snapshot arguments on arrival. Assign IDs only when dequeued, preserving
      // FIFO storage ordering without ever exceeding the host's eight-call limit.
      const payload = JSON.stringify({ method, args }),
        bytes = Buffer.byteLength(payload);
      if (
        bytes > 2 * 1024 * 1024 - 64 ||
        queue.length >= 1024 ||
        queuedBytes + bytes > 8 * 1024 * 1024
      )
        throw fail();
      return new Promise((resolve, reject) => {
        queue.push({ payload, bytes, resolve, reject, deadline: setTimeout(close, 30000) });
        queuedBytes += bytes;
        pump();
      });
    } catch {
      close();
      return Promise.reject(fail());
    }
  }
  async function exchange(method, args) {
    let abort, timer;
    try {
      active();
      const id = ++sequence,
        wire = JSON.stringify({ id, method, args });
      if (Buffer.byteLength(wire) > 2 * 1024 * 1024) throw fail();
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(fail());
        lifetime.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          close();
        }, 30000);
      });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          active();
          return send(wire);
        }),
        cancelled,
      ]);
      active();
      if (
        typeof result !== 'string' ||
        result.length > 2 * 1024 * 1024 ||
        Buffer.byteLength(result) > 2 * 1024 * 1024
      )
        throw fail();
      const response = JSON.parse(result);
      if (
        !response ||
        Array.isArray(response) ||
        Object.keys(response).length !== 2 ||
        response.id !== id ||
        !Object.hasOwn(response, 'value')
      )
        throw fail();
      const value = response.value;
      if (method === 'txRead') {
        method = args.method;
        args = args.args;
      }
      const bytes = (input, maximum) => {
        if (typeof input !== 'string' || input.length > Math.ceil(maximum / 3) * 4) return false;
        const decoded = Buffer.from(input, 'base64');
        return decoded.length <= maximum && decoded.toString('base64') === input;
      };
      if (
        (method === 'get' && value !== null && !bytes(value, 1024 * 1024)) ||
        (method === 'getMany' &&
          (!Array.isArray(value) ||
            value.length !== args.keys.length ||
            value.some((item) => item !== null && !bytes(item, 1024 * 1024)))) ||
        (['batch', 'clear', 'seek', 'end', 'txStage', 'txCommit', 'txAbort'].includes(method) &&
          value !== null) ||
        (['open', 'txBegin'].includes(method) && (!Number.isSafeInteger(value) || value < 1)) ||
        (method === 'next' &&
          value !== null &&
          (!Array.isArray(value) ||
            value.length !== 2 ||
            (value[0] !== null && !bytes(value[0], 4096)) ||
            (value[1] !== null && !bytes(value[1], 1024 * 1024))))
      )
        throw fail();
      return response.value;
    } catch {
      close();
      throw fail();
    } finally {
      clearTimeout(timer);
      if (abort) lifetime.removeEventListener('abort', abort);
    }
  }
  const encode = (value) => Buffer.from(value).toString('base64');
  async function withTransaction(work) {
    if (writing || typeof work !== 'function') {
      close();
      throw fail();
    }
    writing = true;
    let group;
    try {
      group = { id: null, begin: null, open: true, count: 0, bytes: 0 };
      const value = await writeScope.run(group, work);
      group.open = false;
      if (group.id) await call('txCommit', { transaction: group.id });
      return value;
    } catch {
      if (group) {
        group.open = false;
        if (group.id && !lifetime.aborted)
          await call('txAbort', { transaction: group.id }).catch(() => {});
      }
      close();
      throw fail();
    } finally {
      writing = false;
    }
  }
  async function write(operations, group) {
    if (!operations.length) return;
    if (!group) {
      await call('batch', {
        operations: operations.map(({ type, key, value }) =>
          type === 'put'
            ? { type, key: encode(key), value: encode(value) }
            : { type, key: encode(key) }
        ),
      });
      return;
    }
    active();
    if (!group.open) {
      close();
      throw fail();
    }
    group.count += operations.length;
    group.bytes += operations.reduce(
      (n, op) =>
        n + Buffer.byteLength(op.key) + (op.type === 'put' ? Buffer.byteLength(op.value) : 0),
      0
    );
    if (group.count > 32768 || group.bytes > 16 * 1024 * 1024) {
      close();
      throw fail();
    }
    group.begin ||= call('txBegin', {}).then((id) => {
      group.id = id;
    });
    await group.begin;
    let chunk = [],
      bytes = 128;
    const flush = async () => {
      if (!chunk.length) return;
      if (!group.open) {
        close();
        throw fail();
      }
      await call('txStage', { transaction: group.id, operations: chunk });
      chunk = [];
      bytes = 128;
    };
    for (const { type, key, value } of operations) {
      const op =
        type === 'put'
          ? { type, key: encode(key), value: encode(value) }
          : { type, key: encode(key) };
      const size = JSON.stringify(op).length + 1;
      if (chunk.length >= 1024 || bytes + size > 2 * 1024 * 1024 - 64) await flush();
      chunk.push(op);
      bytes += size;
    }
    await flush();
  }
  const optionsFor = (options) =>
    Object.fromEntries(
      ['gt', 'gte', 'lt', 'lte', 'reverse', 'limit', 'keys', 'values']
        .filter((key) => options[key] !== undefined)
        .map((key) => [
          key,
          ['gt', 'gte', 'lt', 'lte'].includes(key) ? encode(options[key]) : options[key],
        ])
    );
  // Keep user callback invocation outside the promise chain: a throwing callback
  // must not be mistaken for an operation failure and invoked a second time.
  const finish = (callback, work) => {
    Promise.resolve()
      .then(() => {
        active();
        return work();
      })
      .then(
        (result) =>
          queueMicrotask(() => {
            if (lifetime.aborted) callback(fail());
            else callback(null, ...result);
          }),
        () => queueMicrotask(() => callback(fail()))
      );
  };
  class Iterator extends AbstractIterator {
    constructor(db, options) {
      super(db);
      active();
      this.options = options;
      this.ended = false;
      this.error = null;
      this.tail = call('open', { options: optionsFor(options) })
        .then((cursor) => {
          if (!Number.isSafeInteger(cursor) || cursor < 1) throw fail();
          this.cursor = cursor;
        })
        .catch((error) => {
          this.error = error;
        });
    }
    enqueue(work) {
      const task = this.tail.then(() => {
        active();
        if (this.error) throw this.error;
        return work();
      });
      this.tail = task.catch((error) => {
        this.error = error;
      });
      return task;
    }
    _next(callback) {
      finish(callback, () =>
        this.enqueue(async () => {
          if (this.ended) throw fail();
          const row = await call('next', { cursor: this.cursor });
          if (row === null) return [];
          if (!Array.isArray(row) || row.length !== 2) throw fail();
          return row.map((value, index) =>
            value === null
              ? undefined
              : this.options[index === 0 ? 'keyAsBuffer' : 'valueAsBuffer'] === false
                ? Buffer.from(value, 'base64').toString()
                : Buffer.from(value, 'base64')
          );
        })
      );
    }
    _seek(target) {
      active();
      if (this.ended) throw fail();
      this.enqueue(() => call('seek', { cursor: this.cursor, target: encode(target) })).catch(
        () => {}
      );
    }
    _end(callback) {
      if (this.ended) {
        queueMicrotask(callback);
        return;
      }
      this.ended = true;
      if (lifetime.aborted) {
        queueMicrotask(callback);
        return;
      }
      finish(callback, async () => {
        await this.enqueue(() => call('end', { cursor: this.cursor }));
        return [];
      });
    }
  }
  class Leveldown extends AbstractLevelDOWN {
    constructor() {
      super({ snapshots: true, permanence: true, seek: true });
    }
    _serializeKey(value) {
      if (value == null) return value;
      if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw fail();
      return Buffer.from(value);
    }
    _serializeValue(value) {
      return this._serializeKey(value);
    }
    _open(_options, callback) {
      finish(callback, () => []);
    }
    _close(callback) {
      close();
      queueMicrotask(callback);
    }
    _get(key, options, callback) {
      // NotFound is an ordinary LevelDB result, never a session failure.
      call('get', { key: encode(key) }).then(
        (value) =>
          queueMicrotask(() => {
            if (lifetime.aborted) {
              callback(fail());
              return;
            }
            if (value === null) {
              callback(Object.assign(new Error('NotFound'), { notFound: true, status: 404 }));
              return;
            }
            const bytes = Buffer.from(value, 'base64');
            callback(null, options.asBuffer === false ? bytes.toString() : bytes);
          }),
        () => queueMicrotask(() => callback(fail()))
      );
    }
    _getMany(keys, options, callback) {
      finish(callback, async () => {
        const values = await call('getMany', { keys: keys.map(encode) });
        return [
          values.map((value) =>
            value === null
              ? undefined
              : options.asBuffer === false
                ? Buffer.from(value, 'base64').toString()
                : Buffer.from(value, 'base64')
          ),
        ];
      });
    }
    _put(key, value, options, callback) {
      this._batch([{ type: 'put', key, value }], options, callback);
    }
    _del(key, options, callback) {
      this._batch([{ type: 'del', key }], options, callback);
    }
    _batch(operations, _options, callback) {
      const group = writeScope.getStore();
      finish(callback, async () => {
        await write(operations, group);
        return [];
      });
    }
    _clear(options, callback) {
      finish(callback, async () => {
        await call('clear', { options: optionsFor(options) });
        return [];
      });
    }
    _iterator(options) {
      return new Iterator(this, options);
    }
  }
  return Object.freeze({
    leveldown: new Leveldown(),
    signal: lifetime,
    close,
    withTransaction,
    provider: Object.freeze({ signal: lifetime, request: (input) => call('rpc', input) }),
  });
}
module.exports = { createRailgunRemote };
