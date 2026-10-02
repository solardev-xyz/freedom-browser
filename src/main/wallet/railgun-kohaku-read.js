/** Current Kohaku instanceId/balance/notes surface over main-owned read evidence.
 * This is a viewing-only instance: no transaction preparation is advertised.
 */
const assert = require('assert/strict');
const { isRailgunWalletRunner } = require('./railgun-wallet-runner');
function assetKey(asset) {
  assert.ok(asset && typeof asset === 'object' && !Array.isArray(asset));
  if (asset.__type === 'native') {
    assert.deepEqual(Object.keys(asset), ['__type']);
    return 'native';
  }
  assert.ok(['erc20', 'erc721'].includes(asset.__type));
  assert.equal(typeof asset.contract, 'string');
  assert.match(asset.contract, /^0x[0-9a-fA-F]{40}$/);
  const keys = ['__type', 'contract'];
  let suffix = '';
  if (asset.__type === 'erc721') {
    keys.push('tokenId');
    assert.equal(typeof asset.tokenId, 'bigint');
    assert.ok(asset.tokenId >= 0n && asset.tokenId < 1n << 256n);
    suffix = ':' + asset.tokenId;
  }
  assert.deepEqual(Object.keys(asset).sort(), keys.sort());
  return asset.__type + ':' + asset.contract.toLowerCase() + suffix;
}
function filterAssets(assets) {
  if (assets === undefined) return () => true;
  assert.ok(Array.isArray(assets) && assets.length <= 1000);
  const keys = new Set(assets.map(assetKey));
  return (note) => note.asset.__type !== 'erc1155' && keys.has(assetKey(note.asset));
}
function createRailgunKohakuRead({ runner, journal, receipt }) {
  assert.ok(isRailgunWalletRunner(runner));
  const current = () => runner.read(receipt, journal);
  current();
  return Object.freeze({
    async instanceId() {
      return current().instanceId;
    },
    async balance(assets) {
      const matches = filterAssets(assets),
        notes = current().received.filter((note) => note.spentTxid === false && matches(note)),
        totals = new Map();
      for (const note of notes) {
        // ERC1155 is outside the current Kohaku AssetId union. Never silently
        // omit it from an unfiltered balance or relabel it as ERC721/ERC20.
        assert.notEqual(note.asset.__type, 'erc1155', 'Unsupported Kohaku balance asset');
        const key = assetKey(note.asset),
          old = totals.get(key);
        totals.set(key, {
          asset: note.asset,
          amount: (old?.amount ?? 0n) + note.amount,
          tag: 'unverified',
        });
      }
      return Object.freeze(
        [...totals.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, v]) => Object.freeze(v))
      );
    },
    async notes(assets, includeSpent = false) {
      assert.equal(typeof includeSpent, 'boolean');
      const matches = filterAssets(assets),
        notes = current().received.filter(
          (note) => (includeSpent || note.spentTxid === false) && matches(note)
        );
      for (const note of notes)
        assert.notEqual(note.asset.__type, 'erc1155', 'Unsupported Kohaku note asset');
      return Object.freeze(notes);
    },
    async status() {
      const read = current();
      return Object.freeze({ ...read.readiness, poi: 'unverified', spendableGranted: false });
    },
  });
}
module.exports = { createRailgunKohakuRead };
