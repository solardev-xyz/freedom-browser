/** Public 70,000-leaf fixture, real engine, host-only storage. No chain data. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { assertRailgunFixture } = require('../railgun-fixture-integrity');
const { createRailgunRemote } = require('../../src/main/wallet/railgun-remote');
const {
  installRailgunTreeTransactions,
} = require('../../src/main/wallet/railgun-tree-transactions');
async function run(serialized, { request, signal, guardReport }) {
  const { write } = JSON.parse(serialized);
  assert.equal(typeof write, 'boolean');
  assert.deepEqual({ ...process.env }, { WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' });
  const fixture = path.join(__dirname, 'railgun-engine');
  const inventory = assertRailgunFixture(path.join(fixture, 'node_modules'));
  const r = createRequire(path.join(fixture, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { Database } = require(path.join(root, 'database/database'));
  const { UTXOMerkletree } = require(path.join(root, 'merkletree/utxo-merkletree'));
  const { Merkletree } = require(path.join(root, 'merkletree/merkletree'));
  const { RailgunEngine } = require(path.join(root, 'railgun-engine'));
  const { poseidonHex, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  const { MERKLE_ZERO_VALUE } = require(path.join(root, 'models/merkletree-types'));
  await initPoseidonPromise;
  const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
  function reference(tree, count) {
    let nodes = Array.from({ length: count }, (_, n) => hex(tree * 65536 + n + 1));
    let zero = MERKLE_ZERO_VALUE;
    for (let level = 0; level < 16; level++) {
      const next = [];
      for (let n = 0; n < nodes.length; n += 2)
        next.push(poseidonHex([nodes[n], nodes[n + 1] ?? zero]));
      zero = poseidonHex([zero, zero]);
      nodes = next;
    }
    return nodes[0];
  }
  const calls = {};
  let maxFrameBytes = 0;
  const remote = createRailgunRemote({
    ...r('abstract-leveldown'),
    signal,
    send: async (wire) => {
      const { method } = JSON.parse(wire);
      calls[method] = (calls[method] ?? 0) + 1;
      const reply = await request(wire);
      maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(wire), Buffer.byteLength(reply));
      return reply;
    },
  });
  installRailgunTreeTransactions({ Merkletree, remote });
  const db = new Database(remote.leveldown);
  const chain = { type: 0, id: 11155111 },
    version = 'V2_PoseidonMerkle';
  let expectedTree, expectedLength, expectedRoot;
  const tree = await UTXOMerkletree.create(db, chain, version, async (v, c, t, last, hash) => {
    assert.equal(v, version);
    assert.deepEqual(c, chain);
    assert.equal(t, expectedTree);
    assert.equal(last + 1, expectedLength);
    assert.equal(hash, expectedRoot);
    return true;
  });
  if (write) {
    for (let inserted = 0; inserted < 70000;) {
      expectedTree = Math.floor(inserted / 65536);
      const index = inserted % 65536;
      const count = Math.min(4096, 70000 - inserted, 65536 - index);
      expectedLength = index + count;
      expectedRoot = reference(expectedTree, expectedLength);
      await tree.insertLeaves(
        expectedTree,
        index,
        Array.from({ length: count }, (_, n) => ({
          hash: hex(inserted + n + 1),
          blockNumber: 1,
        }))
      );
      inserted += count;
    }
  }
  const trees = [];
  for (const [t, count] of [
    [0, 65536],
    [1, 4464],
  ]) {
    assert.equal(await tree.getTreeLength(t), count);
    assert.equal(await tree.getTreeLengthFromDBCount(t), count);
    const proof = await tree.getMerkleProof(t, count - 1);
    const root = reference(t, count);
    assert.equal(proof.root, root);
    assert.equal(proof.leaf, hex(t * 65536 + count));
    let computed = proof.leaf;
    for (let level = 0; level < 16; level++)
      computed =
        ((count - 1) >> level) & 1
          ? poseidonHex([proof.elements[level], computed])
          : poseidonHex([computed, proof.elements[level]]);
    assert.equal(computed, root);
    trees.push({ tree: t, count, root });
  }
  await RailgunEngine.prototype.setUTXOMerkletreeHistoryVersion.call({ db }, chain, 13);
  await RailgunEngine.prototype.setLastSyncedBlock.call({ db }, version, chain, 9000000);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.ok(guards.canaries >= 88);
  assert.ok(
    !Object.keys(require.cache).some(
      (file) => file.includes('better-sqlite3') || /railgun-(paged-)?store\.js$/.test(file)
    )
  );
  await db.level.put(
    'public-electron-volume-report',
    JSON.stringify({
      leaves: 70000,
      trees,
      calls,
      maxFrameBytes,
      guards,
      inventory: inventory.sha256,
    })
  );
}
module.exports = { run };
