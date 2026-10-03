/** Public history projection/apply in the guarded utility, using the pinned engine archive. */
const assert = require('assert/strict'),
  fs = require('fs'),
  path = require('path'),
  { createRequire } = require('module');
async function runtime(archive) {
  assert.deepEqual({ ...process.env }, { WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' });
  archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const inventory = require('./railgun-engine-manifest.json').inventory;
  const r = createRequire(path.join(archive, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const modules = Object.fromEntries(
    ['@railgun-community/engine', 'ethers', 'abstract-leveldown'].map((name) => {
      const resolved = r.resolve(name);
      assert.ok(resolved.startsWith(archive + path.sep), 'Runtime dependency escaped archive');
      return [name, path.relative(archive, resolved)];
    })
  );
  const { V2Events } = require(path.join(root, 'contracts/railgun-smart-wallet/V2/V2-events'));
  const { poseidonHex, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { MERKLE_ZERO_VALUE: zero } = require(path.join(root, 'models/merkletree-types'));
  const ethers = r('ethers'),
    { Interface } = ethers,
    abi = new Interface(
      JSON.parse(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')))
    );
  const provenance = { modules, ethersVersion: ethers.version, inventory: inventory.sha256 };
  return { r, root, inventory, V2Events, poseidonHex, zero, abi, ethers, provenance };
}
async function apply(input, { request, signal, guardReport }) {
  const { r, root, inventory, V2Events, abi, ethers, provenance } = await runtime(input.archive);
  const { Database } = require(path.join(root, 'database/database'));
  const { UTXOMerkletree } = require(path.join(root, 'merkletree/utxo-merkletree'));
  const { Merkletree } = require(path.join(root, 'merkletree/merkletree'));
  const { RailgunEngine } = require(path.join(root, 'railgun-engine'));
  const remote = require('./railgun-remote').createRailgunRemote({
    ...r('abstract-leveldown'),
    signal,
    send: request,
  });
  require('./railgun-tree-transactions').installRailgunTreeTransactions({
    Merkletree,
    remote,
  });
  const db = new Database(remote.leveldown),
    chain = { type: 0, id: 11155111 },
    version = 'V2_PoseidonMerkle';
  const tree = await UTXOMerkletree.create(db, chain, version, async (v, c, number, last, hash) => {
    assert.equal(v, version);
    assert.deepEqual(c, chain);
    const expected = input.plan.state.trees[number];
    assert.ok(expected);
    assert.equal(last + 1, expected.length);
    assert.equal('0x' + hash, expected.root);
    return true;
  });
  const commitments = new Map(),
    nullifiers = [],
    unshields = [];
  for (const log of input.logs) {
    const event = require('./railgun-event-projector').parseRailgunSourceEvent(
      abi,
      log,
      input.qualifiedThrough,
      ethers
    );
    const { name, args } = event;
    if (name === 'Shield' || name === 'Transact') {
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
      if (!formatted.commitments.length) continue;
      if (!commitments.has(formatted.treeNumber)) commitments.set(formatted.treeNumber, []);
      for (const leaf of formatted.commitments) {
        leaf.txid = leaf.txid.replace(/^0x/, '');
        commitments.get(formatted.treeNumber).push(leaf);
      }
    }
    if (name === 'Nullified')
      for (const item of V2Events.formatNullifiedEvents(
        args,
        log.transactionHash,
        log.blockNumber
      )) {
        item.txid = item.txid.replace(/^0x/, '');
        item.nullifier = item.nullifier.replace(/^0x/, '');
        nullifiers.push(item);
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
      unshields.push(item);
    }
  }
  for (const [number, leaves] of commitments) {
    const length = await tree.getTreeLength(number),
      expected = input.plan.state.trees[number];
    assert.ok(length === leaves[0].utxoIndex || length === expected.length);
    if (length < expected.length) await tree.insertLeaves(number, length, leaves);
    assert.equal('0x' + (await tree.getRoot(number)), expected.root);
  }
  for (let n = 0; n < nullifiers.length; n += 256) await tree.nullify(nullifiers.slice(n, n + 256));
  for (const item of unshields) await tree.addUnshieldEvents([item]);
  await RailgunEngine.prototype.setUTXOMerkletreeHistoryVersion.call({ db }, chain, 13);
  await RailgunEngine.prototype.setLastSyncedBlock.call(
    { db },
    version,
    chain,
    input.plan.to.number
  );
  assert.equal(guardReport().attempts, 0);
  return {
    inventory: inventory.sha256,
    runtime: provenance,
    guards: guardReport(),
    leaves: [...commitments.values()].reduce((n, v) => n + v.length, 0),
    nullifiers: nullifiers.length,
    unshields: unshields.length,
  };
}

async function run(serialized, { request, signal, guardReport }) {
  const input = JSON.parse(serialized);
  assert.ok(input.mode === 'plan' || input.mode === 'apply');
  assert.deepEqual(
    Object.keys(input).sort(),
    ['archive', 'mode', 'qualifiedThrough', input.mode === 'plan' ? 'storeId' : 'plan'].sort()
  );
  assert.equal(input.qualifiedThrough, require('./railgun-public-policy').QUALIFIED_THROUGH);
  let sequence = 0;
  const invoke = async (message) => {
    const id = ++sequence,
      reply = JSON.parse(await request(JSON.stringify({ ...message, id })));
    assert.equal(reply.id, id);
    assert.ok(!reply.error);
    return reply.value;
  };
  let result;
  if (input.mode === 'plan') {
    const projector = require('./railgun-event-projector').createRailgunEventProjector({
      ...(await runtime(input.archive)),
      qualifiedThrough: input.qualifiedThrough,
    });
    while (true) {
      const logs = await invoke({ method: 'sourceNext' });
      if (logs === null) break;
      assert.ok(Array.isArray(logs) && logs.length <= 128);
      for (const log of logs) projector.add(log);
    }
    result = { state: projector.finish(input.storeId), guards: guardReport() };
  } else {
    assert.equal(input.mode, 'apply');
    const logs = [];
    let bytes = 0;
    while (true) {
      const batch = await invoke({ method: 'sourceNext' });
      if (batch === null) break;
      assert.ok(Array.isArray(batch) && batch.length <= 128);
      bytes += Buffer.byteLength(JSON.stringify(batch));
      assert.ok(logs.length + batch.length <= 4096 && bytes <= 4 * 1024 * 1024 + 4096);
      logs.push(...batch);
    }
    result = await apply(
      { ...input, logs },
      {
        signal,
        guardReport,
        request: async (wire) => {
          const message = JSON.parse(wire),
            id = ++sequence;
          const reply = JSON.parse(await request(JSON.stringify({ ...message, id })));
          assert.equal(reply.id, id);
          return JSON.stringify({ ...reply, id: message.id });
        },
      }
    );
  }
  assert.equal(guardReport().attempts, 0);
  await invoke({ method: 'jobResult', value: result });
}
module.exports = { run };
