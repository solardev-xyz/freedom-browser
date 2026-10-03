/** Offline public-history qualification. Uses authenticated engine formatting
 * and Poseidon, with independent contract-derived leaf/tree calculations.
 * No private wallet data, nullifier queries, proof or signing authority.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { Interface, AbiCoder, keccak256, toUtf8Bytes } = require('ethers');
const { assertRailgunFixture } = require('./railgun-fixture-integrity');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const baseline = require('../docs/qualification/railgun-sepolia-deployment-2026-10-02.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (value) => {
  const n = BigInt(value);
  assert.ok(n >= 0n && n < FIELD);
  return n.toString(16).padStart(64, '0');
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
function readHeaderEvidence(directory, capture) {
  assert.ok(path.isAbsolute(directory));
  const read = (name, cap) => {
    const filename = path.join(directory, name),
      stat = fs.lstatSync(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap);
    const bytes = fs.readFileSync(filename);
    assert.ok(bytes.length <= cap);
    return bytes;
  };
  const reportBytes = read('report.json', 2 * 1024 * 1024);
  const report = JSON.parse(reportBytes);
  assert.equal(report.chainId, 11155111);
  assert.equal(report.logSetSha256, capture.logSetSha256);
  assert.equal(report.captureReportSha256, capture.reportSha256);
  assert.deepEqual(report.anchor, capture.report.anchor);
  assert.equal(report.eventBlockHashesCanonicalByAgreement, true);
  assert.equal(report.bloomCheckedLogs, capture.report.totalLogs);
  assert.equal(report.eventBlocks, capture.blocks.size);
  assert.equal(report.rangeBoundaryParentLinks, capture.boundaries.length - 1);
  assert.equal(report.headerFileSha256, hash(read('headers.jsonl', 128 * 1024 * 1024)));
  for (const file of [
    'scripts/verify-railgun-sepolia-headers.js',
    'scripts/railgun-log-capture-data.js',
    'scripts/capture-railgun-sepolia-logs.js',
  ])
    assert.equal(
      report.sourceSha256[file],
      hash(fs.readFileSync(path.join(__dirname, '..', file)))
    );
  return { report, sha256: hash(reportBytes) };
}
function appendLeaves(trees, tree, start, leaves) {
  assert.ok(Number.isSafeInteger(tree) && tree >= 0 && tree <= 65535);
  assert.ok(Number.isSafeInteger(start) && start >= 0 && start <= 65536);
  assert.ok(leaves.length <= 65536);
  const latest = trees.size ? trees.size - 1 : 0;
  if (tree !== latest) {
    assert.equal(tree, latest + 1, 'Missing or revisited tree');
    assert.ok(trees.has(latest));
    assert.ok(trees.get(latest).length + leaves.length > 65536, 'Premature tree rollover');
  }
  const values = trees.get(tree) ?? [];
  assert.equal(values.length, start, 'Commitment gap or overlap');
  assert.ok(values.length + leaves.length <= 65536);
  values.push(...leaves);
  trees.set(tree, values);
}
function nullifierKey(tree, value, currentTree) {
  assert.ok(tree >= 0n && tree <= BigInt(currentTree), 'Nullifier tree exceeds anchor');
  return tree + ':' + hex(value);
}
function checkTransactionPresence(transactions) {
  for (const tx of transactions.values())
    assert.equal(
      tx.nullifiers > 0,
      tx.transact > 0 || tx.unshield > 0,
      'Missing private transaction event category'
    );
}
async function main() {
  const [directory, output, headersDirectory] = process.argv.slice(2);
  assert.ok(output && path.isAbsolute(output) && !fs.existsSync(output));
  const capture = readRailgunLogCapture(directory);
  const headerEvidence = headersDirectory ? readHeaderEvidence(headersDirectory, capture) : null;
  const fixture = path.join(__dirname, 'fixtures/railgun-engine/node_modules');
  const inventory = assertRailgunFixture(fixture);
  const guard = require('../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
    onRefusal: () => process.exit(2),
  });
  const root = path.join(fixture, '@railgun-community/engine/dist');
  const { poseidonHex, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  const { V2Events } = require(path.join(root, 'contracts/railgun-smart-wallet/V2/V2-events'));
  await initPoseidonPromise;
  const abiPath = path.join(root, 'abi/V2.1/RailgunSmartWallet.json');
  const abi = new Interface(JSON.parse(fs.readFileSync(abiPath)));
  const proxyAbi = new Interface([
    'event ProxyUpgrade(address previousImplementation,address newImplementation)',
    'event ProxyOwnershipTransfer(address previousOwner,address newOwner)',
    'event ProxyPause()',
    'event ProxyUnpause()',
  ]);
  const trees = new Map(),
    nullifiers = new Set(),
    transactions = new Map(),
    lastKeys = new Map(),
    events = {};
  const tokenTypes = { erc20: 0, erc721: 0, erc1155: 0 };
  let shieldLeaves = 0,
    transactLeaves = 0,
    lastImplementation,
    paused,
    owner,
    treasury,
    fees,
    unshieldEvents = 0;
  for (const log of capture.logs()) {
    const event = abi.parseLog(log) ?? proxyAbi.parseLog(log);
    assert.ok(event, 'Unidentified proxy event');
    const { name, args } = event;
    const count = (events[name] ??= {
      count: 0,
      firstBlock: log.blockNumber,
      lastBlock: log.blockNumber,
    });
    count.count++;
    count.lastBlock = log.blockNumber;
    if (name === 'ProxyUpgrade') lastImplementation = args.newImplementation.toLowerCase();
    if (name === 'ProxyPause') paused = true;
    if (name === 'ProxyUnpause') paused = false;
    if (name === 'OwnershipTransferred') owner = args.newOwner;
    if (name === 'TreasuryChange') treasury = args.treasury;
    if (name === 'FeeChange') fees = [args.shieldFee.toString(), args.unshieldFee.toString()];
    if (name === 'VerifyingKeySet')
      lastKeys.set(
        args.nullifiers + ':' + args.commitments,
        abi.encodeFunctionResult('getVerificationKey', [args.verifyingKey])
      );
    if (!['Shield', 'Transact', 'Nullified', 'Unshield'].includes(name)) continue;
    const tx = transactions.get(log.transactionHash) ?? {
      block: log.blockNumber,
      nullifiers: 0,
      transact: 0,
      unshield: 0,
    };
    assert.equal(tx.block, log.blockNumber);
    transactions.set(log.transactionHash, tx);
    if (name === 'Nullified') {
      assert.ok(args.nullifier.length > 0);
      assert.ok(trees.has(Number(args.treeNumber)), 'Nullifier tree does not yet exist');
      for (const value of args.nullifier) {
        const key = nullifierKey(args.treeNumber, value, trees.size ? trees.size - 1 : 0);
        assert.ok(!nullifiers.has(key), 'Repeated nullifier within tree');
        nullifiers.add(key);
        tx.nullifiers++;
      }
      continue;
    }
    if (name === 'Unshield') {
      tx.unshield++;
      unshieldEvents++;
      continue;
    }
    let leaves, formatted;
    if (name === 'Shield') {
      assert.equal(args.commitments.length, args.shieldCiphertext.length);
      assert.equal(args.commitments.length, args.fees.length);
      leaves = args.commitments.map((preimage) => {
        const type = Number(preimage.token.tokenType);
        assert.ok(type >= 0 && type <= 2);
        tokenTypes[['erc20', 'erc721', 'erc1155'][type]]++;
        const token =
          type === 0
            ? BigInt(preimage.token.tokenAddress)
            : BigInt(
                keccak256(
                  AbiCoder.defaultAbiCoder().encode(
                    ['tuple(uint8 tokenType,address tokenAddress,uint256 tokenSubID)'],
                    [preimage.token]
                  )
                )
              ) % FIELD;
        return poseidonHex([hex(preimage.npk), hex(token), hex(preimage.value)]);
      });
      formatted = V2Events.formatShieldEvent(
        args,
        log.transactionHash,
        log.blockNumber,
        args.fees,
        undefined
      );
      shieldLeaves += leaves.length;
    } else {
      assert.ok(args.hash.length > 0, 'Empty Transact cannot be emitted by this contract');
      assert.equal(args.hash.length, args.ciphertext.length);
      leaves = args.hash.map(hex);
      formatted = V2Events.formatTransactEvent(
        args,
        log.transactionHash,
        log.blockNumber,
        undefined
      );
      transactLeaves += leaves.length;
      tx.transact++;
    }
    assert.deepEqual(
      formatted.commitments.map((commitment) => commitment.hash.replace(/^0x/, '')),
      leaves
    );
    const tree = Number(args.treeNumber),
      start = Number(args.startPosition);
    appendLeaves(trees, tree, start, leaves);
  }
  checkTransactionPresence(transactions);
  assert.equal(lastImplementation, baseline.implementation.address);
  assert.equal(paused, false);
  assert.equal(owner.toLowerCase(), baseline.state.owner.toLowerCase());
  assert.equal(treasury.toLowerCase(), baseline.state.treasury.toLowerCase());
  assert.deepEqual(fees, [baseline.state.shieldFee, baseline.state.unshieldFee]);
  for (const key of baseline.verificationKeys)
    assert.equal(lastKeys.get(key.shape.join(':')), key.encoded);
  const roots = [];
  for (const [tree, values] of trees) {
    assert.equal(tree, roots.length, 'Missing tree');
    let nodes = values,
      zero = hex(BigInt(keccak256(toUtf8Bytes('Railgun'))) % FIELD);
    for (let level = 0; level < 16; level++) {
      const next = [];
      for (let n = 0; n < nodes.length; n += 2)
        next.push(poseidonHex([nodes[n], nodes[n + 1] ?? zero]));
      zero = poseidonHex([zero, zero]);
      nodes = next;
    }
    roots.push({ tree, leaves: values.length, root: '0x' + nodes[0] });
  }
  assert.equal(roots.at(-1).tree, Number(baseline.state.treeNumber));
  assert.equal(roots.at(-1).leaves, Number(baseline.state.nextLeafIndex));
  assert.equal(roots.at(-1).root, baseline.state.merkleRoot);
  const guards = guard.report();
  assert.equal(guards.attempts, 0);
  const report = {
    observedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    chainId: 11155111,
    anchor: capture.report.anchor,
    captureReportSha256: capture.reportSha256,
    logSetSha256: capture.logSetSha256,
    trust: 'two-rpc-agreement-unverified',
    providerIndependenceAssumed: true,
    canonicalEventHeadersCompared: !!headerEvidence,
    headerReportSha256: headerEvidence?.sha256 ?? null,
    receiptProofsVerified: false,
    nullifierCompletenessProven: false,
    privateNullifierQueries: 0,
    events,
    shieldLeaves,
    transactLeaves,
    roots,
    shieldTokenTypes: tokenTypes,
    uniqueNullifiers: nullifiers.size,
    unshieldEvents,
    privateTransactionEventCategoryPresenceChecked: true,
    individualNullifierEventCompletenessProven: false,
    governanceFieldsMatchingAnchor: [
      'implementation',
      'paused',
      'owner',
      'treasury',
      'shieldFee',
      'unshieldFee',
    ],
    proxyAdminSource: 'anchor-storage-slot-only-no-transfer-events',
    nftFeeCompared: false,
    distinctVerificationKeyShapes: lastKeys.size,
    verificationKeyShapesCompared: baseline.verificationKeys.map((key) => key.shape),
    verificationKeyEventsMatchAnchor: true,
    independentLeafAndTreeRules: true,
    poseidonSharedWithEngine: true,
    circuitArtifactsMatched: false,
    engineFormattingMatches: true,
    engineInventory: inventory.sha256,
    guards,
    walletScanned: false,
    signingEnabled: false,
    submissions: 0,
    sourceSha256: Object.fromEntries(
      [
        'scripts/verify-railgun-sepolia-history.js',
        'scripts/railgun-log-capture-data.js',
        'scripts/capture-railgun-sepolia-logs.js',
        'scripts/railgun-fixture-integrity.js',
        'src/main/wallet/railgun-process-guards.js',
      ].map((file) => [file, hash(fs.readFileSync(path.join(__dirname, '..', file)))])
    ),
    abiSha256: hash(fs.readFileSync(abiPath)),
    contractRulesSources: Object.fromEntries(
      ['RailgunLogic.sol', 'Commitments.sol', 'RailgunSmartWallet.sol'].map((name) => [
        name,
        {
          url:
            'https://github.com/Railgun-Privacy/contract/blob/36bcf5ed7cf94bfafb6e1a303e1832c769c16780/contracts/logic/' +
            name,
          sha256: {
            'RailgunLogic.sol': 'e3c3218ee77f0984dd43837d4cb9f33c5a15cb35018be6396824c14d0ac4b11d',
            'Commitments.sol': 'fe56adcc9aa04fcbe2bb7346207f8eed58dd1e13ba6eb2aa7661329c2c4b5d1b',
            'RailgunSmartWallet.sol':
              'b926c2ee7a4fae03f1326e2c4bf6e232cab32bfae0f452aed3dc76e8fb7e70d8',
          }[name],
        },
      ])
    ),
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        shieldLeaves,
        transactLeaves,
        roots,
        uniqueNullifiers: nullifiers.size,
        unshieldEvents,
        tokenTypes,
        canonicalEventHeadersCompared: !!headerEvidence,
      },
      null,
      2
    )
  );
}
module.exports = { appendLeaves, nullifierKey, checkTransactionPresence, readHeaderEvidence };
if (require.main === module)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
