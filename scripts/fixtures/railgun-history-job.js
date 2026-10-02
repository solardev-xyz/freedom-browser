/** Offline replay of public captured events. No chain-verification or balance
 * grant: the cursor below is deliberately an engine-owned claim. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createRequire } = require('module');
const { Interface } = require('ethers');
const { assertRailgunFixture } = require('../railgun-fixture-integrity');
const { readRailgunLogCapture } = require('../railgun-log-capture-data');
const { createRailgunRemote } = require('../../src/main/wallet/railgun-remote');
const {
  installRailgunTreeTransactions,
} = require('../../src/main/wallet/railgun-tree-transactions');
const baseline = require('../../docs/qualification/railgun-sepolia-deployment-2026-10-02.json');
const cursorKey = 'public-history-replay-engine-cursor';
const reportKey = 'public-history-replay-engine-report';
async function run(serialized, { request, signal, guardReport, progress = () => {} }) {
  const input = JSON.parse(serialized);
  const fixture = path.join(__dirname, 'railgun-engine');
  const inventory = assertRailgunFixture(path.join(fixture, 'node_modules'));
  const r = createRequire(path.join(fixture, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { Database } = require(path.join(root, 'database/database'));
  const { UTXOMerkletree } = require(path.join(root, 'merkletree/utxo-merkletree'));
  const { Merkletree } = require(path.join(root, 'merkletree/merkletree'));
  const { RailgunEngine } = require(path.join(root, 'railgun-engine'));
  const { V2Events } = require(path.join(root, 'contracts/railgun-smart-wallet/V2/V2-events'));
  const { poseidonHex, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  const { MERKLE_ZERO_VALUE } = require(path.join(root, 'models/merkletree-types'));
  await initPoseidonPromise;
  const capture = readRailgunLogCapture(input.captureDirectory);
  assert.equal(input.logSetSha256, capture.logSetSha256);
  const abi = new Interface(
    JSON.parse(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')))
  );
  const chunks = [];
  let chunk = { leaves: [], nullifiers: [], unshields: [], toBlock: 0 };
  // This pinned Sepolia qualification deliberately handles only the observed tree0.
  // Production rollover and canonical coverage are separate host responsibilities.
  const finish = () => {
    if (!chunk.leaves.length && !chunk.nullifiers.length && !chunk.unshields.length) return;
    chunks.push(chunk);
    chunk = { leaves: [], nullifiers: [], unshields: [], toBlock: 0 };
  };
  let previousBlock = 0;
  for (const log of capture.logs()) {
    if (
      log.blockNumber !== previousBlock &&
      (chunk.leaves.length >= 256 || chunk.nullifiers.length >= 256 || chunk.unshields.length >= 64)
    )
      finish();
    previousBlock = log.blockNumber;
    chunk.toBlock = log.blockNumber;
    const event = abi.parseLog(log);
    if (!event) continue; // Proxy governance was checked by the separate offline verifier.
    const { name, args } = event;
    if (name === 'Shield' || name === 'Transact') {
      assert.equal(args.treeNumber, 0n);
      const formatted =
        name === 'Shield'
          ? V2Events.formatShieldEvent(
              args,
              log.transactionHash,
              log.blockNumber,
              args.fees,
              undefined
            )
          : V2Events.formatTransactEvent(args, log.transactionHash, log.blockNumber, undefined);
      for (const leaf of formatted.commitments) {
        leaf.txid = leaf.txid.replace(/^0x/, '');
        chunk.leaves.push(leaf);
      }
    }
    if (name === 'Nullified') {
      for (const item of V2Events.formatNullifiedEvents(
        args,
        log.transactionHash,
        log.blockNumber
      )) {
        item.txid = item.txid.replace(/^0x/, '');
        item.nullifier = item.nullifier.replace(/^0x/, '');
        chunk.nullifiers.push(item);
      }
    }
    if (name === 'Unshield') {
      const item = V2Events.formatUnshieldEvent(
        args,
        log.transactionHash,
        log.blockNumber,
        log.logIndex,
        undefined
      );
      item.txid = item.txid.replace(/^0x/, '');
      chunk.unshields.push(item);
    }
    assert.ok(
      chunk.leaves.length <= 1024 &&
        chunk.nullifiers.length <= 1024 &&
        chunk.unshields.length <= 256,
      'Single public event block exceeds qualification capacity'
    );
  }
  finish();
  assert.ok(chunks.length > 3 && chunks.length <= 1000);
  chunks.at(-1).toBlock = capture.report.anchor.number;
  let length = 0;
  const zeros = [MERKLE_ZERO_VALUE],
    nodes = Array.from({ length: 17 }, () => new Map());
  for (let level = 0; level < 16; level++) zeros.push(poseidonHex([zeros[level], zeros[level]]));
  for (const value of chunks) {
    value.start = length;
    for (const leaf of value.leaves) {
      assert.equal(leaf.utxoTree, 0);
      assert.equal(leaf.utxoIndex, length);
      let index = length++,
        node = leaf.hash.replace(/^0x/, '');
      nodes[0].set(index, node);
      for (let level = 0; level < 16; level++) {
        const sibling = nodes[level].get(index ^ 1) ?? zeros[level];
        node = index & 1 ? poseidonHex([sibling, node]) : poseidonHex([node, sibling]);
        index >>= 1;
        nodes[level + 1].set(index, node);
      }
    }
    value.length = length;
    value.root = nodes[16].get(0) ?? zeros[16];
  }
  assert.equal(length, Number(baseline.state.nextLeafIndex));
  assert.equal('0x' + chunks.at(-1).root, baseline.state.merkleRoot);
  const calls = {};
  const remote = createRailgunRemote({
    ...r('abstract-leveldown'),
    signal,
    send: async (wire) => {
      const { method } = JSON.parse(wire);
      calls[method] = (calls[method] ?? 0) + 1;
      return request(wire);
    },
  });
  installRailgunTreeTransactions({ Merkletree, remote });
  const db = new Database(remote.leveldown);
  const chain = { type: 0, id: 11155111 },
    version = 'V2_PoseidonMerkle';
  let activeChunk,
    validations = 0;
  const tree = await UTXOMerkletree.create(db, chain, version, async (v, c, t, last, root) => {
    assert.equal(v, version);
    assert.deepEqual(c, chain);
    assert.equal(t, 0);
    assert.equal(last + 1, activeChunk.length);
    assert.equal(root, activeChunk.root);
    validations++;
    return true;
  });
  let cursor = -1;
  try {
    const stored = JSON.parse(await db.level.get(cursorKey));
    assert.equal(stored.logSetSha256, capture.logSetSha256);
    assert.ok(Number.isInteger(stored.chunk) && stored.chunk >= 0 && stored.chunk < chunks.length);
    assert.equal(stored.toBlock, chunks[stored.chunk].toBlock);
    cursor = stored.chunk;
  } catch (error) {
    if (!error.notFound) throw error;
  }
  const initialCursor = cursor,
    initialLength = await tree.getTreeLength(0);
  const committedLength = cursor < 0 ? 0 : chunks[cursor].length;
  assert.ok(
    initialLength === committedLength || initialLength === chunks[cursor + 1]?.length,
    'Tree is inconsistent with replay cursor'
  );
  const limit = input.limit ?? chunks.length;
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= chunks.length);
  const phase = async (index, name) => {
    await progress({ chunk: index, phase: name, length: await tree.getTreeLength(0), cursor });
    if (input.crashChunk === index && input.crashPhase === name)
      process.kill(process.pid, 'SIGKILL');
  };
  for (let index = cursor + 1; index < limit; index++) {
    activeChunk = chunks[index];
    const existing = await tree.getTreeLength(0);
    assert.ok(existing === activeChunk.start || existing === activeChunk.length);
    if (existing < activeChunk.length) await tree.insertLeaves(0, existing, activeChunk.leaves);
    else if (activeChunk.length) assert.equal(await tree.getRoot(0), activeChunk.root);
    await phase(index, 'commitments');
    for (let offset = 0; offset < activeChunk.nullifiers.length; offset += 256)
      await tree.nullify(activeChunk.nullifiers.slice(offset, offset + 256));
    await phase(index, 'nullifiers');
    for (const unshield of activeChunk.unshields) await tree.addUnshieldEvents([unshield]);
    await phase(index, 'unshields');
    await RailgunEngine.prototype.setUTXOMerkletreeHistoryVersion.call({ db }, chain, 13);
    await RailgunEngine.prototype.setLastSyncedBlock.call(
      { db },
      version,
      chain,
      activeChunk.toBlock
    );
    await phase(index, 'engine-cursor');
    await db.level.put(
      cursorKey,
      JSON.stringify({
        logSetSha256: capture.logSetSha256,
        chunk: index,
        toBlock: activeChunk.toBlock,
      })
    );
    cursor = index;
    await phase(index, 'checkpoint');
  }
  assert.equal(await tree.getTreeLength(0), chunks[limit - 1].length);
  assert.equal(await tree.getTreeLengthFromDBCount(0), chunks[limit - 1].length);
  assert.equal(await tree.getRoot(0), chunks[limit - 1].root);
  let checkedLeaves = 0,
    checkedNullifiers = 0,
    checkedUnshields = 0;
  const leafDigest = createHash('sha256'),
    nullifierDigest = createHash('sha256'),
    unshieldDigest = createHash('sha256');
  const included = chunks.slice(0, limit);
  const leaves = included.flatMap((value) => value.leaves);
  const nullifiers = included.flatMap((value) => value.nullifiers);
  const unshields = included.flatMap((value) => value.unshields);
  async function checkRecords(values, key, encoding, validate) {
    for (let start = 0; start < values.length; start += 128) {
      const batch = values.slice(start, start + 128);
      const stored = await db.level.getMany(
        batch.map((item) => Database.pathToKey(key(item))),
        { valueEncoding: encoding }
      );
      assert.equal(stored.length, batch.length);
      for (let i = 0; i < batch.length; i++) validate(stored[i], batch[i]);
    }
  }
  await checkRecords(
    leaves,
    (leaf) => tree.getDataDBPath(0, leaf.utxoIndex),
    'json',
    (stored, leaf) => {
      assert.deepEqual(stored, JSON.parse(JSON.stringify(leaf)));
      leafDigest.update(JSON.stringify(stored) + '\n');
      checkedLeaves++;
    }
  );
  const nullifierKeys = await db.getNamespaceKeys(
    tree.getNullifierDBPath(0, '00'.repeat(32)).slice(0, -1)
  );
  assert.deepEqual(
    [...nullifierKeys].sort(),
    nullifiers
      .map((item) => Database.pathToKey(tree.getNullifierDBPath(item.treeNumber, item.nullifier)))
      .sort()
  );
  await checkRecords(
    nullifiers,
    (item) => tree.getNullifierDBPath(item.treeNumber, item.nullifier),
    'hex',
    (stored, item) => {
      assert.equal(stored, item.txid);
      nullifierDigest.update(JSON.stringify(item) + '\n');
      checkedNullifiers++;
    }
  );
  const unshieldKeys = await db.getNamespaceKeys(
    tree.getUnshieldEventsDBPath(undefined, undefined, undefined)
  );
  assert.deepEqual(
    [...unshieldKeys].sort(),
    unshields
      .map((item) =>
        Database.pathToKey(tree.getUnshieldEventsDBPath(item.txid, item.eventLogIndex, undefined))
      )
      .sort()
  );
  await checkRecords(
    unshields,
    (item) => tree.getUnshieldEventsDBPath(item.txid, item.eventLogIndex, undefined),
    'json',
    (stored, item) => {
      assert.deepEqual(stored, JSON.parse(JSON.stringify(item)));
      unshieldDigest.update(JSON.stringify(item) + '\n');
      checkedUnshields++;
    }
  );
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.equal(signal.aborted, false);
  assert.ok(!calls.rpc);
  const report = {
    initialCursor,
    initialLength,
    cursor,
    totalChunks: chunks.length,
    completedChunks: limit,
    checks: { leaves: checkedLeaves, nullifiers: checkedNullifiers, unshields: checkedUnshields },
    digests: {
      leaves: leafDigest.digest('hex'),
      nullifiers: nullifierDigest.digest('hex'),
      unshields: unshieldDigest.digest('hex'),
    },
    chunks: chunks.map(({ start, length, root, toBlock, nullifiers, unshields }) => ({
      start,
      length,
      root,
      toBlock,
      nullifiers: nullifiers.length,
      unshields: unshields.length,
    })),
    root: '0x' + chunks[limit - 1].root,
    logSetSha256: capture.logSetSha256,
    validations,
    calls,
    guards,
    inventory: inventory.sha256,
    wholeChunkAtomic: false,
    engineCursorIsHostCoverage: false,
    intermediateRootsFromCapturedLeaves: true,
    intermediateRootsCheckedOnChain: false,
    walletScanned: false,
    signingEnabled: false,
  };
  await db.level.put(reportKey, JSON.stringify(report));
  return report;
}
module.exports = { run, reportKey };
