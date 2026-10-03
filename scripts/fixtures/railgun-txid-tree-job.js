/** Offline public TXID reconstruction in the guarded packed engine. No account,
 * storage, network, signing or proving capability is requested. */
const assert = require('assert/strict'),
  path = require('path');
const { createRequire } = require('module');
async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const { MERKLE_ZERO_VALUE, TREE_DEPTH } = require(path.join(root, 'models/merkletree-types'));
  assert.equal(TREE_DEPTH, 16);
  assert.ok(
    Number.isSafeInteger(input.checkpoint.index) &&
      input.checkpoint.index >= 0 &&
      input.checkpoint.index < 65536
  );
  assert.ok(Number.isSafeInteger(input.pages) && input.pages > 0 && input.pages <= 200);
  const zeros = [MERKLE_ZERO_VALUE];
  for (let i = 0; i < 16; i++) zeros.push(poseidonHex([zeros[i], zeros[i]]));
  assert.deepEqual(zeros, require('../../src/main/wallet/railgun-public-records').ZERO_NODES);
  const branches = [];
  let count = 0,
    previousID = '0x00',
    verificationHash,
    treeRoot = zeros[16],
    sequence = 0;
  const txids = new Set(),
    verificationBreaks = [];
  for (let page = 0; page < input.pages && count <= input.checkpoint.index; page++) {
    assert.ok(!signal.aborted);
    const id = ++sequence;
    const reply = JSON.parse(await request(JSON.stringify({ id, method: 'page', page })));
    assert.equal(reply.id, id);
    const rows = reply.value.transactions;
    assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 100);
    for (const row of rows) {
      if (count > input.checkpoint.index) break;
      assert.ok(row.graphID > previousID);
      previousID = row.graphID;
      assert.equal(row.version, 'V2');
      const transaction = createRailgunTransactionWithHash(row);
      assert.ok(!txids.has(transaction.railgunTxid));
      txids.add(transaction.railgunTxid);
      const expectedVerificationHash = calculateRailgunTransactionVerificationHash(
        verificationHash,
        row.nullifiers[0]
      );
      if (expectedVerificationHash !== row.verificationHash) {
        assert.ok(verificationBreaks.length < 16);
        verificationBreaks.push({
          index: count,
          precedingRoot: treeRoot,
          blockNumber: row.blockNumber,
          expected: expectedVerificationHash,
          actual: row.verificationHash,
        });
      }
      verificationHash = row.verificationHash;
      let node = transaction.hash,
        index = count++;
      for (let level = 0; level < 16; level++) {
        if (index & 1) {
          assert.ok(branches[level]);
          node = poseidonHex([branches[level], node]);
        } else {
          branches[level] = node;
          node = poseidonHex([node, zeros[level]]);
        }
        index >>= 1;
      }
      treeRoot = node;
    }
  }
  assert.equal(count, input.checkpoint.index + 1);
  const id = sequence + 1;
  const value = {
    count,
    root: treeRoot,
    expectedRoot: input.checkpoint.root,
    matches: treeRoot === input.checkpoint.root,
    verificationHashChain: verificationBreaks.length === 0,
    verificationBreaks,
    duplicateTxids: false,
    guards: guardReport(),
    inventory: require('../../src/main/wallet/railgun-engine-manifest.json').inventory.sha256,
  };
  assert.equal(value.guards.attempts, 0);
  assert.deepEqual(JSON.parse(await request(JSON.stringify({ id, method: 'result', value }))), {
    id,
    value: null,
  });
}
module.exports = { run };
