/** Main-owned digest of the entire derived-wallet database. This authenticates
 * cache identity/content, never wallet completeness or spendability by itself.
 */
const { createHash } = require('crypto');
function inspectRailgunWalletState(store) {
  const fail = () =>
    Object.assign(new Error('Railgun wallet state unavailable'), {
      code: 'RAILGUN_WALLET_STATE_INVALID',
    });
  const check = (condition) => {
    if (!condition) throw fail();
  };
  const storeId = store.getInstanceId?.();
  check(typeof storeId === 'string' && /^[0-9a-f]{64}$/.test(storeId));
  const digest = createHash('sha256').update('freedom:railgun:wallet-store-v1\0');
  const cursor = store.openSnapshot();
  let count = 0,
    bytes = 0,
    previous;
  try {
    for (let row; (row = cursor.next());) {
      const [key, value] = row;
      try {
        check(Buffer.isBuffer(key) && key.length > 0 && key.length <= 4096);
        check(Buffer.isBuffer(value) && value.length <= 1024 * 1024);
        check(!previous || Buffer.compare(previous, key) < 0);
        count++;
        bytes += key.length + value.length;
        check(count <= 32768 && bytes <= 64 * 1024 * 1024);
        const lengths = Buffer.alloc(8);
        lengths.writeUInt32BE(key.length);
        lengths.writeUInt32BE(value.length, 4);
        digest.update(lengths).update(key).update(value);
        previous?.fill(0);
        previous = Buffer.from(key);
      } finally {
        key?.fill?.(0);
        value?.fill?.(0);
      }
    }
    return Object.freeze({
      schema: 'wallet-store-v1',
      storeId,
      count,
      bytes,
      sha256: digest.digest('hex'),
    });
  } finally {
    previous?.fill(0);
    cursor.close();
  }
}
module.exports = { inspectRailgunWalletState };
