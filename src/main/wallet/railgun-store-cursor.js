/** One cursor contract for legacy bounded stores and explicit paged stores.
 * Paged cursors retain immutable references, never a whole-history row array.
 */
function createRailgunStoreCursor(store, options = {}) {
  if (store.openSnapshot) return store.openSnapshot(options);
  const rows = store.snapshot(options, options.values === false);
  if (options.reverse) rows.reverse();
  let position = 0,
    count = 0,
    closed = false;
  const active = () => {
    store.assertActive();
    if (closed) throw new Error('Railgun cursor revoked');
  };
  return {
    next() {
      active();
      if (position >= rows.length || (options.limit >= 0 && count >= options.limit)) return null;
      count++;
      return rows[position++].map((b) => Buffer.from(b));
    },
    seek(target) {
      active();
      const index = rows.findIndex(([key]) =>
        options.reverse ? Buffer.compare(key, target) <= 0 : Buffer.compare(key, target) >= 0
      );
      position = index < 0 ? rows.length : index;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [key, value] of rows) {
        key.fill(0);
        value.fill(0);
      }
      rows.length = 0;
    },
  };
}
function clearRailgunStore(store, options) {
  if (store.clear) return store.clear(options);
  const cursor = createRailgunStoreCursor(store, { ...options, values: false }),
    operations = [];
  try {
    for (let row; (row = cursor.next());) operations.push({ type: 'del', key: row[0] });
    if (operations.length) store.batch(operations);
  } finally {
    cursor.close();
    for (const op of operations) op.key.fill(0);
  }
}
module.exports = { createRailgunStoreCursor, clearRailgunStore };
