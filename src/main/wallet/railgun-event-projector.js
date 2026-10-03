/** Source-only public-event projection, run in the guarded runtime child.
 * Crypto and official formatters are injected from the authenticated runtime.
 * No database, wallet keys, network or signer capability is accepted here.
 */
const assert = require('assert/strict');
const { paths } = require('./railgun-frontier');
const {
  ZERO_NODES,
  projectPublicRecord,
  createPublicRecordDigest,
} = require('./railgun-public-records');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (value) => BigInt(value).toString(16).padStart(64, '0');
const bare = (value) => value.replace(/^0x/, '').toLowerCase();
const segment = (n) => hex(n);
const proxyEvents = [
  'event ProxyUpgrade(address previousImplementation,address newImplementation)',
  'event ProxyOwnershipTransfer(address previousOwner,address newOwner)',
  'event ProxyPause()',
  'event ProxyUnpause()',
];
const proxyInterfaces = new WeakMap();
const governanceEvents = new Set([
  'ProxyUpgrade',
  'ProxyOwnershipTransfer',
  'ProxyPause',
  'ProxyUnpause',
  'OwnershipTransferred',
  'TreasuryChange',
  'FeeChange',
  'Initialized',
  'VerifyingKeySet',
]);
function parseRailgunSourceEvent(abi, log, qualifiedThrough = 0, ethers = require('ethers')) {
  if (!proxyInterfaces.has(ethers.Interface))
    proxyInterfaces.set(ethers.Interface, new ethers.Interface(proxyEvents));
  const proxyAbi = proxyInterfaces.get(ethers.Interface);
  const event = abi.parseLog(log) ?? proxyAbi.parseLog(log);
  assert.ok(event, 'Unidentified proxy event');
  if (!['Shield', 'Transact', 'Nullified', 'Unshield'].includes(event.name)) {
    assert.ok(governanceEvents.has(event.name), 'Unqualified event type');
    assert.ok(log.blockNumber <= qualifiedThrough, 'Contract change requires host requalification');
  }
  return event;
}
function createRailgunEventProjector({
  abi,
  V2Events,
  poseidonHex,
  zero,
  qualifiedThrough = 0,
  ethers = require('ethers'),
}) {
  const { AbiCoder, keccak256 } = ethers;
  assert.ok(Number.isSafeInteger(qualifiedThrough) && qualifiedThrough >= 0);
  assert.equal(typeof abi?.parseLog, 'function');
  assert.equal(typeof poseidonHex, 'function');
  const zeros = [zero];
  for (let i = 0; i < 16; i++) zeros.push(poseidonHex([zeros[i], zeros[i]]));
  assert.deepEqual(zeros, ZERO_NODES);
  const records = new Map(),
    trees = [],
    prefix = paths.metadata().toString();
  let count = 0,
    bytes = 0,
    lastBlock = -1,
    lastLog = -1,
    finished = false;
  const insert = (key, value) => {
    assert.ok(!records.has(key.toString()), 'Duplicate public source record');
    bytes += key.length + value.length;
    assert.ok(records.size < 100000 && bytes <= 128 * 1024 * 1024);
    records.set(key.toString(), [key, value]);
  };
  function ingest(log) {
    assert.ok(!finished && ++count <= 100000);
    assert.ok(Number.isSafeInteger(log.blockNumber) && Number.isSafeInteger(log.logIndex));
    assert.ok(
      log.blockNumber > lastBlock || (log.blockNumber === lastBlock && log.logIndex > lastLog),
      'Unordered public source'
    );
    lastBlock = log.blockNumber;
    lastLog = log.logIndex;
    const event = parseRailgunSourceEvent(abi, log, qualifiedThrough, ethers);
    const { name, args } = event;
    if (name === 'Shield' || name === 'Transact') {
      const number = Number(args.treeNumber),
        start = Number(args.startPosition);
      let hashes, formatted;
      if (name === 'Shield') {
        assert.equal(args.commitments.length, args.shieldCiphertext.length);
        assert.equal(args.commitments.length, args.fees.length);
        hashes = args.commitments.map((pre) => {
          const type = Number(pre.token.tokenType);
          assert.ok(type >= 0 && type <= 2);
          const token =
            type === 0
              ? BigInt(pre.token.tokenAddress)
              : BigInt(
                  keccak256(
                    AbiCoder.defaultAbiCoder().encode(
                      ['tuple(uint8 tokenType,address tokenAddress,uint256 tokenSubID)'],
                      [pre.token]
                    )
                  )
                ) % FIELD;
          return poseidonHex([hex(pre.npk), hex(token), hex(pre.value)]);
        });
        formatted = V2Events.formatShieldEvent(
          args,
          log.transactionHash,
          log.blockNumber,
          args.fees,
          undefined
        );
      } else {
        assert.equal(args.hash.length, args.ciphertext.length);
        hashes = args.hash.map(hex);
        formatted = V2Events.formatTransactEvent(
          args,
          log.transactionHash,
          log.blockNumber,
          undefined
        );
      }
      assert.ok((name === 'Shield' || hashes.length > 0) && hashes.length <= 65536);
      assert.deepEqual(
        formatted.commitments.map((leaf) => bare(leaf.hash)),
        hashes
      );
      assert.ok(
        Number.isSafeInteger(number) &&
          number >= 0 &&
          number < 256 &&
          Number.isSafeInteger(start) &&
          start >= 0
      );
      if (!hashes.length) {
        assert.equal(number, Math.max(0, trees.length - 1));
        assert.equal(start, trees[number]?.length ?? 0);
        return { kind: 'commitments', tree: number, start, leaves: [] };
      }
      if (number === trees.length) {
        assert.equal(start, 0);
        if (number)
          assert.ok(trees[number - 1].length + hashes.length > 65536, 'Premature tree rollover');
        trees.push({
          tree: number,
          length: 0,
          root: '0x' + zeros[16],
          nodes: Array.from({ length: 17 }, () => new Map()),
        });
      }
      assert.equal(number, trees.length - 1);
      const tree = trees[number];
      assert.equal(start, tree.length);
      assert.ok(start + hashes.length <= 65536);
      for (const [offset, hash] of hashes.entries()) {
        let index = tree.length++,
          node = hash;
        tree.nodes[0].set(index, node);
        for (let level = 0; level < 16; level++) {
          const sibling = tree.nodes[level].get(index ^ 1) ?? zeros[level];
          node = index & 1 ? poseidonHex([sibling, node]) : poseidonHex([node, sibling]);
          index >>= 1;
          tree.nodes[level + 1].set(index, node);
        }
        tree.root = '0x' + node;
        const leaf = formatted.commitments[offset];
        leaf.txid = bare(leaf.txid);
        assert.equal(leaf.utxoTree, number);
        assert.equal(leaf.utxoIndex, start + offset);
        const key = paths.data(number, start + offset),
          value = Buffer.from(JSON.stringify(leaf));
        const shared = [
          name === 'Shield' ? 'ShieldCommitment' : 'TransactCommitmentV2',
          hash,
          bare(log.transactionHash),
          log.blockNumber,
          number,
          start + offset,
        ];
        let expected;
        if (name === 'Shield') {
          const pre = args.commitments[offset],
            cipher = args.shieldCiphertext[offset];
          expected = [
            ...shared,
            hex(pre.npk),
            [Number(pre.token.tokenType), bare(pre.token.tokenAddress), hex(pre.token.tokenSubID)],
            BigInt(pre.value).toString(16).padStart(32, '0'),
            cipher.encryptedBundle.map(hex),
            hex(cipher.shieldKey),
            // Pinned engine9.6 omits the fee field for a zero fee.
            args.fees[offset] ? args.fees[offset].toString() : null,
          ];
        } else {
          const cipher = args.ciphertext[offset],
            words = cipher.ciphertext.map(hex);
          expected = [
            ...shared,
            [words[0].slice(0, 32), words[0].slice(32), words.slice(1)],
            hex(cipher.blindedSenderViewingKey),
            hex(cipher.blindedReceiverViewingKey),
            bare(cipher.annotationData),
            bare(cipher.memo),
          ];
        }
        assert.deepEqual(projectPublicRecord(key, value, trees)[1], expected);
        insert(key, value);
      }
      return { kind: 'commitments', tree: number, start, leaves: formatted.commitments };
    }
    if (name === 'Nullified') {
      const items = V2Events.formatNullifiedEvents(args, log.transactionHash, log.blockNumber);
      assert.deepEqual(
        items.map((v) => [v.treeNumber, bare(v.nullifier), bare(v.txid), v.blockNumber]),
        args.nullifier.map((v) => [
          Number(args.treeNumber),
          bare(v),
          bare(log.transactionHash),
          log.blockNumber,
        ])
      );
      for (const item of items) {
        assert.ok(trees[item.treeNumber]);
        item.txid = bare(item.txid);
        item.nullifier = bare(item.nullifier);
        insert(
          Buffer.from(
            [prefix, segment(item.treeNumber), segment(0xfffffffe), item.nullifier].join(':')
          ),
          Buffer.from(item.txid, 'hex')
        );
      }
      return { kind: 'nullifiers', items };
    }
    if (name === 'Unshield') {
      const item = V2Events.formatUnshieldEvent(
        args,
        log.transactionHash,
        log.blockNumber,
        log.logIndex,
        undefined
      );
      item.txid = bare(item.txid);
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
          bare(log.transactionHash),
          log.logIndex,
          log.blockNumber,
          args.to.toLowerCase(),
          Number(args.token.tokenType),
          args.token.tokenAddress.toLowerCase(),
          args.token.tokenSubID.toString(),
          args.amount.toString(),
          args.fee.toString(),
        ]
      );
      insert(
        Buffer.from(
          [prefix, segment(0xfffffffd), item.txid, segment(item.eventLogIndex)].join(':')
        ),
        Buffer.from(JSON.stringify(item))
      );
      return { kind: 'unshields', items: [item] };
    }
    return null; // Governance/deployment checks remain a separate host gate.
  }
  function finish(storeId) {
    assert.ok(!finished);
    assert.match(storeId, /^[0-9a-f]{64}$/);
    finished = true;
    const publicTrees = trees.map(({ tree, length, root }) => ({ tree, length, root }));
    const digests = Object.fromEntries(
      ['commitments', 'nullifiers', 'unshields'].map((kind) => [
        kind,
        createPublicRecordDigest(kind),
      ])
    );
    for (const [key, value] of [...records.values()].sort(([a], [b]) => Buffer.compare(a, b))) {
      const [kind, tuple] = projectPublicRecord(key, value, publicTrees);
      digests[kind].add(key, tuple);
    }
    return {
      schema: 'public-records-v1',
      storeId,
      trees: publicTrees,
      ...Object.fromEntries(
        Object.entries(digests).map(([kind, digest]) => [kind, digest.finish()])
      ),
    };
  }
  return {
    add(log) {
      try {
        return ingest(log);
      } catch (error) {
        finished = true;
        throw error;
      }
    },
    finish,
  };
}
module.exports = { createRailgunEventProjector, parseRailgunSourceEvent };
