/** Public synthetic UTXO workload through the actual Electron utility bootstrap. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { assertRailgunFixture } = require('../railgun-fixture-integrity');
const { createRailgunRemote } = require('../../src/main/wallet/railgun-remote');
const {
  installRailgunTreeTransactions,
} = require('../../src/main/wallet/railgun-tree-transactions');
async function run(serialized, { request, signal, guardReport }) {
  const input = JSON.parse(serialized);
  assert.deepEqual(Object.keys(process.env), []);
  assert.ok(Number.isInteger(input.target) && input.target > 0 && input.target <= 4096);
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
  let nodes = Array.from({ length: input.target }, (_, n) => hex(n + 1)),
    zero = MERKLE_ZERO_VALUE;
  for (let level = 0; level < 16; level++) {
    const next = [];
    for (let n = 0; n < nodes.length; n += 2)
      next.push(poseidonHex([nodes[n], nodes[n + 1] ?? zero]));
    zero = poseidonHex([zero, zero]);
    nodes = next;
  }
  const expectedRoot = nodes[0];
  const calls = {};
  let maxFrameBytes = 0;
  let interrupted = false;
  const remote = createRailgunRemote({
    ...r('abstract-leveldown'),
    signal,
    send: async (wire) => {
      const { method } = JSON.parse(wire);
      calls[method] = (calls[method] ?? 0) + 1;
      const reply = await request(wire);
      maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(wire), Buffer.byteLength(reply));
      if (!interrupted && method === 'txStage' && ['lock', 'crash-before'].includes(input.mode)) {
        interrupted = true;
        if (input.mode === 'crash-before') {
          await remote.provider.request({ method: 'eth_chainId', params: [] });
          process.kill(process.pid, 'SIGKILL');
        }
        await remote.provider.request({ method: 'eth_blockNumber', params: [] });
      }
      if (method === 'txCommit' && input.mode === 'crash-after') {
        await remote.provider.request({ method: 'eth_chainId', params: [] });
        process.kill(process.pid, 'SIGKILL');
      }
      return reply;
    },
  });
  installRailgunTreeTransactions({ Merkletree, remote });
  const db = new Database(remote.leveldown);
  const chain = { type: 0, id: 11155111 },
    version = 'V2_PoseidonMerkle';
  const tree = await UTXOMerkletree.create(db, chain, version, async (v, c, t, last, root) => {
    assert.equal(v, version);
    assert.deepEqual(c, chain);
    assert.equal(t, 0);
    assert.equal(last + 1, input.target);
    assert.equal(root, expectedRoot);
    return true;
  });
  if (input.write) {
    assert.equal(await tree.getTreeLength(0), input.start);
    await tree.insertLeaves(
      0,
      input.start,
      Array.from({ length: input.target - input.start }, (_, n) => ({
        hash: hex(input.start + n + 1),
        blockNumber: 1,
      }))
    );
  }
  assert.equal(await tree.getTreeLength(0), input.target);
  assert.equal(await tree.getTreeLengthFromDBCount(0), input.target);
  const proof = await tree.getMerkleProof(0, input.target - 1);
  assert.equal(proof.root, expectedRoot);
  assert.equal(proof.leaf, hex(input.target));
  let computed = proof.leaf;
  for (let level = 0; level < 16; level++)
    computed =
      ((input.target - 1) >> level) & 1
        ? poseidonHex([proof.elements[level], computed])
        : poseidonHex([computed, proof.elements[level]]);
  assert.equal(computed, expectedRoot);
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
  assert.ok(calls.nextMany > 0 && calls.nextMany < input.target / 8);
  await db.level.put(
    'public-electron-tree-report',
    JSON.stringify({
      target: input.target,
      root: expectedRoot,
      calls,
      maxFrameBytes,
      guards,
      inventory: inventory.sha256,
    })
  );
  assert.equal(signal.aborted, false);
}
module.exports = { run };
