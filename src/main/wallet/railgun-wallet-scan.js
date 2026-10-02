/** Guarded engine-runtime scan over an exclusive public checkpoint. The wallet
 * owns a separate derived database. A result is provisional until main rechecks
 * its snapshot; this module never grants spending or POI readiness.
 */
const assert = require('assert/strict');
const {
  createRailgunTokenResolver,
  inspectRailgunShield,
  inspectRailgunTransact,
  validateRailgunWalletRecords,
  validateRailgunSentRecords,
} = require('./railgun-wallet-records');
async function scanRailgunWallet({ wallet, tree, checkpoint, runtime, signal, restore = false }) {
  const version = 'V2_PoseidonMerkle',
    chain = { type: 0, id: 11155111 };
  const trees = checkpoint.state.trees;
  const active = () => {
    assert.ok(signal instanceof AbortSignal && !signal.aborted, 'Wallet scan cancelled');
  };
  active();
  assert.ok(Array.isArray(trees) && trees.length <= 100000);
  let total = 0;
  for (const [index, item] of trees.entries()) {
    assert.equal(item.tree, index);
    assert.ok(Number.isSafeInteger(item.length) && item.length > 0 && item.length <= 65536);
    total += item.length;
    assert.ok(total <= 100000);
    assert.equal(await tree.getTreeLength(index), item.length);
    assert.equal('0x' + (await tree.getRoot(index)), item.root);
  }
  async function visit(visitor) {
    for (const item of trees) {
      for (let start = 0; start < item.length; start += 128) {
        active();
        const end = Math.min(item.length, start + 128),
          leaves = await tree.getCommitmentRange(item.tree, start, end - 1);
        active();
        assert.equal(leaves.length, end - start);
        for (const [index, leaf] of leaves.entries()) {
          assert.equal(leaf.utxoTree, item.tree);
          assert.equal(leaf.utxoIndex, start + index);
          assert.ok(['ShieldCommitment', 'TransactCommitmentV2'].includes(leaf.commitmentType));
        }
        await visitor(leaves, item.tree, start);
        active();
      }
    }
  }
  const sourceTokens = new Map();
  await visit(async (leaves) => {
    for (const leaf of leaves) {
      if (leaf.commitmentType !== 'ShieldCommitment') continue;
      const token = leaf.preImage.token,
        hash = runtime.getTokenDataHash(token);
      if (sourceTokens.has(hash)) assert.deepEqual(sourceTokens.get(hash), token);
      else sourceTokens.set(hash, token);
      assert.ok(sourceTokens.size <= 10000);
    }
  });
  const resolver = createRailgunTokenResolver({
    sourceTokens: [...sourceTokens.values()],
    getTokenDataHash: runtime.getTokenDataHash,
    getTokenDataERC20: runtime.getTokenDataERC20,
  });
  wallet.tokenDataGetter = resolver;
  await wallet.loadUTXOMerkletree(version, tree);
  assert.equal(wallet.tokenDataGetter, resolver);
  const expectedReceived = [],
    expectedSent = [],
    quarantine = [],
    unrecoverableSent = [];
  await visit(async (leaves, number, start) => {
    const guarded = [];
    for (const [index, leaf] of leaves.entries()) {
      active();
      const inspector =
        leaf.commitmentType === 'ShieldCommitment' ? inspectRailgunShield : inspectRailgunTransact;
      const result = await inspector({ ...runtime, leaf, wallet, tokenResolver: resolver });
      const position = start + index;
      if (result.receive) expectedReceived.push({ tree: number, position });
      if (result.sent) expectedSent.push({ tree: number, position });
      if (result.status === 'sent-note-unrecoverable')
        unrecoverableSent.push({ tree: number, position, txid: leaf.txid, reason: result.status });
      if (result.status === 'commitment-mismatch')
        quarantine.push({
          tree: number,
          position,
          txid: leaf.txid,
          reason: 'commitment-mismatch',
        });
      assert.ok(
        expectedReceived.length <= 10000 &&
          expectedSent.length <= 10000 &&
          quarantine.length <= 10000 &&
          unrecoverableSent.length <= 10000
      );
      guarded.push(result.status === 'matched' ? leaf : undefined);
    }
    if (!restore) await wallet.scanLeaves(version, guarded, number, chain, start, () => {});
    assert.equal(wallet.tokenDataGetter, resolver);
  });
  active();
  const txos = await wallet.TXOs(version, chain);
  assert.equal(wallet.tokenDataGetter, resolver);
  const sent = await wallet.getSentCommitments(version, chain);
  assert.equal(wallet.tokenDataGetter, resolver);
  const common = {
    trees,
    readCommitment: (number, position) => tree.getCommitment(number, position),
    tokenResolver: resolver,
  };
  await validateRailgunWalletRecords({
    ...common,
    txos,
    expectedReceived,
    readNullifier: (nullifier, number) => tree.getNullifierTxid(nullifier, number),
    nullifyingKey: wallet.nullifyingKey,
    getNullifier: runtime.TransactNote.getNullifier,
  });
  await validateRailgunSentRecords({ ...common, sent, expectedSent });
  active();
  resolver.assertComplete();
  const note = (item) => ({
    tree: item.tree,
    position: item.position,
    txid: item.txid,
    hash: item.note.hash.toString(16).padStart(64, '0'),
    tokenHash: item.note.tokenHash,
    tokenData: { ...item.note.tokenData },
    value: item.note.value.toString(),
  });
  return {
    instanceId: wallet.getAddress(),
    scannedLeaves: total,
    expectedReceived,
    expectedSent,
    quarantine,
    unrecoverableSent,
    received: txos.map((item) => ({ ...note(item), spentTxid: item.spendtxid })),
    sent: sent.map(note),
    spendableGranted: false,
  };
}
module.exports = { scanRailgunWallet };
