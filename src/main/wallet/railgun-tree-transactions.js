/** Pinned development bridge for engine 9.6.0 UTXO V2 write groups. This does not
 * qualify TXID, scanner concurrency, root validation or a production runtime.
 */
const { createHash } = require('crypto');
const installed = new WeakSet();
function installRailgunTreeTransactions({ Merkletree, remote }) {
  const original = Merkletree?.prototype?.writeTreeToDB;
  if (
    typeof original !== 'function' ||
    typeof remote?.withTransaction !== 'function' ||
    installed.has(Merkletree) ||
    createHash('sha256').update(original.toString()).digest('hex') !==
      'c448db4b9f802f66876146bb8df1f2bbf26e6a03ac47903714ad236dfc09f88f'
  )
    throw new Error('Railgun tree transaction binding refused');
  Merkletree.prototype.writeTreeToDB = function (...args) {
    if (
      this.merkletreeType !== 'UTXO' ||
      this.txidVersion !== 'V2_PoseidonMerkle' ||
      this.chain?.type !== 0 ||
      this.chain?.id !== 11155111
    ) {
      remote.close();
      return Promise.reject(new Error('Railgun tree transaction binding refused'));
    }
    return remote.withTransaction(() => original.apply(this, args));
  };
  installed.add(Merkletree);
}
module.exports = { installRailgunTreeTransactions };
