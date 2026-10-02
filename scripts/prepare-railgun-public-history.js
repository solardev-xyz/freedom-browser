/** Offline expected public state, computed solely from a validated capture
 * before any engine store is created or applied. Pinned engine formatting and
 * Poseidon are shared dependencies; this is independent of engine database state.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createRequire } = require('module');
const { Interface } = require('ethers');
const { assertRailgunFixture } = require('./railgun-fixture-integrity');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const {
  ZERO_NODES,
  projectPublicRecord,
  createPublicRecordDigest,
} = require('../src/main/wallet/railgun-public-records');
const { paths } = require('../src/main/wallet/railgun-frontier');
const baseline = require('../docs/qualification/railgun-sepolia-deployment-2026-10-02.json');
async function preparePublicHistory(input, withStates = false) {
  const fixture = path.join(__dirname, 'fixtures/railgun-engine');
  const inventory = assertRailgunFixture(path.join(fixture, 'node_modules'));
  const r = createRequire(path.join(fixture, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
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
      const formatted = V2Events.formatNullifiedEvents(args, log.transactionHash, log.blockNumber);
      assert.deepEqual(
        formatted.map((item) => [
          item.treeNumber,
          item.nullifier.replace(/^0x/, ''),
          item.txid.replace(/^0x/, ''),
          item.blockNumber,
        ]),
        args.nullifier.map((value) => [
          Number(args.treeNumber),
          value.slice(2).toLowerCase(),
          log.transactionHash.slice(2).toLowerCase(),
          log.blockNumber,
        ]),
        'Nullifier formatting must preserve every ABI event argument'
      );
      for (const item of formatted) {
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
      assert.deepEqual(
        [
          item.txid,
          item.eventLogIndex,
          item.blockNumber,
          item.toAddress.toLowerCase(),
          item.tokenType,
          item.tokenAddress.toLowerCase(),
          item.tokenSubID,
          item.amount,
          item.fee,
        ],
        [
          log.transactionHash.slice(2).toLowerCase(),
          log.logIndex,
          log.blockNumber,
          args.to.toLowerCase(),
          Number(args.token.tokenType),
          args.token.tokenAddress.toLowerCase(),
          args.token.tokenSubID.toString(),
          args.amount.toString(),
          args.fee.toString(),
        ],
        'Unshield formatting must preserve every ABI event argument'
      );
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
  assert.deepEqual(zeros, ZERO_NODES, 'Pinned host padding nodes must match authenticated engine');
  const expectedStates = [];
  if (withStates) {
    const records = new Map(),
      segment = (n) => BigInt(n).toString(16).padStart(64, '0');
    const prefix = paths.metadata().toString();
    const add = (key, value) => {
      const id = key.toString();
      assert.ok(!records.has(id), 'Repeated public source key');
      records.set(id, [key, value]);
    };
    for (const chunk of chunks) {
      for (const leaf of chunk.leaves)
        add(paths.data(0, leaf.utxoIndex), Buffer.from(JSON.stringify(leaf)));
      for (const item of chunk.nullifiers)
        add(
          Buffer.from(
            [prefix, segment(item.treeNumber), segment(0xfffffffe), item.nullifier].join(':')
          ),
          Buffer.from(item.txid, 'hex')
        );
      for (const item of chunk.unshields)
        add(
          Buffer.from(
            [prefix, segment(0xfffffffd), item.txid, segment(item.eventLogIndex)].join(':')
          ),
          Buffer.from(JSON.stringify(item))
        );
      const trees = [{ tree: 0, length: chunk.length, root: '0x' + chunk.root }];
      const hashes = Object.fromEntries(
        ['commitments', 'nullifiers', 'unshields'].map((kind) => [
          kind,
          createPublicRecordDigest(kind),
        ])
      );
      for (const [key, value] of [...records.values()].sort(([a], [b]) => Buffer.compare(a, b))) {
        const [kind, tuple] = projectPublicRecord(key, value, trees);
        hashes[kind].add(key, tuple);
      }
      expectedStates.push({
        schema: 'public-records-v1',
        storeId: '0'.repeat(64),
        trees,
        ...Object.fromEntries(Object.entries(hashes).map(([kind, hash]) => [kind, hash.finish()])),
      });
    }
  }
  return { capture, chunks, inventory, expectedStates };
}
module.exports = { preparePublicHistory };
