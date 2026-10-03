/** Offline comparison of public indexer rows with the independently captured
 * RPC event history. Agreement remains unverified; this grants no wallet access. */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto'),
  { createRequire } = require('module');
const { Interface } = require('ethers');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const sha = (value) => createHash('sha256').update(value).digest('hex');
function main() {
  const [txidsDirectory, logsDirectory, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
  assert.ok([txidsDirectory, logsDirectory, output].every(path.isAbsolute));
  assert.ok(!fs.existsSync(output));
  const fixture = path.join(__dirname, 'fixtures/railgun-engine');
  const inventory = require('./railgun-fixture-integrity').assertRailgunFixture(
    path.join(fixture, 'node_modules')
  );
  const r = createRequire(path.join(fixture, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const abi = new Interface(
    JSON.parse(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')))
  );
  const capture = readRailgunLogCapture(logsDirectory);
  const txidBytes = fs.readFileSync(path.join(txidsDirectory, 'report.json'));
  const report = JSON.parse(txidBytes);
  assert.equal(report.passed, true);
  const transactions = [];
  for (const entry of report.pages) {
    assert.match(entry.filename, /^\d{5}\.json$/);
    const bytes = fs.readFileSync(path.join(txidsDirectory, entry.filename));
    assert.equal(sha(bytes), entry.sha256);
    transactions.push(...JSON.parse(bytes).transactions);
  }
  const events = new Map();
  for (const log of capture.logs()) {
    const event = abi.parseLog(log);
    if (!event || !['Nullified', 'Transact', 'Unshield'].includes(event.name)) continue;
    const key = log.transactionHash.slice(2);
    if (!events.has(key))
      events.set(key, {
        block: log.blockNumber,
        nullifiers: [],
        leaves: [],
        unshields: [],
        batches: [],
      });
    const group = events.get(key),
      args = event.args;
    assert.equal(group.block, log.blockNumber);
    if (event.name === 'Nullified')
      group.nullifiers.push({
        tree: Number(args.treeNumber),
        values: [...args.nullifier],
        logIndex: log.logIndex,
        matched: false,
      });
    if (event.name === 'Transact') {
      group.batches.push({
        tree: Number(args.treeNumber),
        start: Number(args.startPosition),
        length: args.hash.length,
      });
      args.hash.forEach((hash, offset) =>
        group.leaves.push({
          tree: Number(args.treeNumber),
          position: Number(args.startPosition) + offset,
          hash,
          matched: false,
        })
      );
    }
    if (event.name === 'Unshield')
      group.unshields.push({
        to: args.to.toLowerCase(),
        token: args.token.tokenAddress.toLowerCase(),
        type: Number(args.token.tokenType),
        subID: args.token.tokenSubID.toString(),
        value: (args.amount + args.fee).toString(),
        matched: false,
      });
  }
  const mismatches = [];
  let compared = 0,
    beyondAnchor = 0;
  const mismatch = (row, reason) => {
    assert.ok(mismatches.length < 100);
    mismatches.push({ txid: row.txid, blockNumber: row.blockNumber, reason });
  };
  for (const row of transactions) {
    if (row.blockNumber > capture.report.anchor.number) {
      beyondAnchor++;
      continue;
    }
    compared++;
    const group = events.get(row.txid);
    if (!group || group.block !== row.blockNumber) {
      mismatch(row, 'transaction');
      continue;
    }
    const nullifiers = group.nullifiers.find(
      (n) =>
        !n.matched &&
        n.tree === row.utxoTreeIn &&
        JSON.stringify(n.values) === JSON.stringify(row.nullifiers)
    );
    if (!nullifiers) mismatch(row, 'nullifiers');
    else nullifiers.matched = true;
    const standard = row.commitments.slice(0, row.commitments.length - (row.unshield ? 1 : 0));
    for (const [offset, hash] of standard.entries()) {
      const leaf = group.leaves.find(
        (l) =>
          !l.matched &&
          l.tree === row.utxoTreeOut &&
          l.position === row.utxoBatchStartPositionOut + offset &&
          l.hash === hash
      );
      if (!leaf) mismatch(row, 'commitment-position');
      else leaf.matched = true;
    }
    if (!standard.length) {
      const ordinary = group.batches.some(
        (b) =>
          b.tree === row.utxoTreeOut &&
          row.utxoBatchStartPositionOut >= b.start &&
          row.utxoBatchStartPositionOut <= b.start + b.length
      );
      const sentinel =
        !group.batches.length &&
        row.utxoTreeOut === 99999 &&
        row.utxoBatchStartPositionOut === 99999;
      if (!ordinary && !sentinel) mismatch(row, 'unshield-only-position');
    }
    if (row.unshield) {
      const value = row.unshield;
      const event = group.unshields.find(
        (u) =>
          !u.matched &&
          u.to === value.toAddress.toLowerCase() &&
          u.token === value.tokenData.tokenAddress.toLowerCase() &&
          u.type === value.tokenData.tokenType &&
          u.subID === BigInt(value.tokenData.tokenSubID).toString() &&
          u.value === value.value
      );
      if (!event) mismatch(row, 'unshield');
      else event.matched = true;
    }
  }
  const omitted = [];
  for (const [txid, group] of events)
    for (const event of group.nullifiers)
      if (!event.matched)
        omitted.push({
          txid,
          blockNumber: group.block,
          logIndex: event.logIndex,
          nullifierCount: event.values.length,
        });
  const unmatchedLeaves = [...events.values()].reduce(
    (n, g) => n + g.leaves.filter((v) => !v.matched).length,
    0
  );
  const unmatchedUnshields = [...events.values()].reduce(
    (n, g) => n + g.unshields.filter((v) => !v.matched).length,
    0
  );
  const result = {
    observedAt: new Date().toISOString(),
    harnessSha256: sha(fs.readFileSync(__filename)),
    sourceSha256: Object.fromEntries(
      [
        'scripts/verify-railgun-txid-history.js',
        'scripts/railgun-log-capture-data.js',
        'scripts/capture-railgun-sepolia-logs.js',
        'scripts/railgun-fixture-integrity.js',
        'scripts/fixtures/railgun-engine/runtime-integrity.json',
      ].map((name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    ),
    engineInventory: inventory.sha256,
    ethersVersion: require('ethers').version,
    abiSha256: sha(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json'))),
    txidCaptureSha256: sha(txidBytes),
    logSetSha256: capture.logSetSha256,
    anchor: capture.report.anchor,
    trust: 'indexer-versus-unverified-rpc-consistency',
    compared,
    beyondAnchor,
    mismatches,
    omitted,
    unmatchedLeaves,
    unmatchedUnshields,
    boundParamsChecked: false,
    unshieldCommitmentHashesChecked: false,
    spendableGranted: false,
    submissions: 0,
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      compared,
      beyondAnchor,
      mismatches: mismatches.length,
      omitted: omitted.length,
      unmatchedLeaves,
      unmatchedUnshields,
    })
  );
  process.exitCode =
    mismatches.length || omitted.length || unmatchedLeaves || unmatchedUnshields ? 1 : 0;
}
try {
  main();
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
