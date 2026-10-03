/** Guarded qualification child. Public source-only planner or real engine apply.
 * The parent owns all paths, encrypted stores, RPC and journal authority.
 */
for (const key of Object.keys(process.env)) delete process.env[key];
const assert = require('assert/strict'),
  fs = require('fs'),
  path = require('path'),
  { createRequire } = require('module');
const guards = require('../../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
  onRefusal: () => process.exit(2),
});
const pending = new Map();
let projector,
  mode,
  sequence = 0;
process.on('disconnect', () => process.exit(1));
function send(value) {
  return new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve()))
  );
}
async function runtime() {
  assert.deepEqual(Object.keys(process.env), []);
  const fixture = path.join(__dirname, 'railgun-engine');
  const inventory = require('../railgun-fixture-integrity').assertRailgunFixture(
    path.join(fixture, 'node_modules')
  );
  const r = createRequire(path.join(fixture, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const { V2Events } = require(path.join(root, 'contracts/railgun-smart-wallet/V2/V2-events'));
  const { poseidonHex, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { MERKLE_ZERO_VALUE: zero } = require(path.join(root, 'models/merkletree-types'));
  const { Interface } = require('ethers'),
    abi = new Interface(
      JSON.parse(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')))
    );
  return { r, root, inventory, V2Events, poseidonHex, zero, abi };
}
async function apply(input) {
  const { r, root, inventory, V2Events, abi } = await runtime();
  const { Database } = require(path.join(root, 'database/database'));
  const { UTXOMerkletree } = require(path.join(root, 'merkletree/utxo-merkletree'));
  const { Merkletree } = require(path.join(root, 'merkletree/merkletree'));
  const { RailgunEngine } = require(path.join(root, 'railgun-engine'));
  const remote = require('../../src/main/wallet/railgun-remote').createRailgunRemote({
    ...r('abstract-leveldown'),
    signal: new AbortController().signal,
    send: (wire) =>
      new Promise((resolve, reject) => {
        pending.set(JSON.parse(wire).id, { resolve, reject });
        process.send({ type: 'command', wire });
      }),
  });
  require('../../src/main/wallet/railgun-tree-transactions').installRailgunTreeTransactions({
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
    const event = require('../../src/main/wallet/railgun-event-projector').parseRailgunSourceEvent(
      abi,
      log,
      11829346
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
  async function phase(name) {
    await send({ type: 'progress', phase: name });
    if (input.crashPhase === name) process.kill(process.pid, 'SIGKILL');
  }
  for (const [number, leaves] of commitments) {
    const length = await tree.getTreeLength(number),
      expected = input.plan.state.trees[number];
    assert.ok(length === leaves[0].utxoIndex || length === expected.length);
    if (length < expected.length) await tree.insertLeaves(number, length, leaves);
    assert.equal('0x' + (await tree.getRoot(number)), expected.root);
  }
  await phase('commitments');
  for (let n = 0; n < nullifiers.length; n += 256) await tree.nullify(nullifiers.slice(n, n + 256));
  await phase('nullifiers');
  for (const item of unshields) await tree.addUnshieldEvents([item]);
  await phase('unshields');
  await RailgunEngine.prototype.setUTXOMerkletreeHistoryVersion.call({ db }, chain, 13);
  await RailgunEngine.prototype.setLastSyncedBlock.call(
    { db },
    version,
    chain,
    input.plan.to.number
  );
  await phase('engine-cursor');
  assert.equal(guards.report().attempts, 0);
  await send({
    type: 'result',
    value: {
      inventory: inventory.sha256,
      guards: guards.report(),
      leaves: [...commitments.values()].reduce((n, v) => n + v.length, 0),
      nullifiers: nullifiers.length,
      unshields: unshields.length,
    },
  });
}
let chain = Promise.resolve();
process.on('message', (message) => {
  if (message?.type === 'reply') {
    const id = JSON.parse(message.wire).id,
      task = pending.get(id);
    assert.ok(task);
    pending.delete(id);
    task.resolve(message.wire);
    return;
  }
  chain = chain
    .then(async () => {
      assert.ok(message && Buffer.byteLength(JSON.stringify(message)) <= 5 * 1024 * 1024);
      if (message.type === 'init') {
        assert.equal(mode, undefined);
        mode = message.mode;
        if (mode === 'apply') return apply(message.input);
        assert.equal(mode, 'plan');
        const dependencies = await runtime();
        projector =
          require('../../src/main/wallet/railgun-event-projector').createRailgunEventProjector({
            ...dependencies,
            qualifiedThrough: 11829346,
          });
        return send({ type: 'ready' });
      }
      assert.equal(mode, 'plan');
      assert.ok(projector);
      if (message.type === 'logs') {
        assert.equal(message.sequence, ++sequence);
        assert.ok(Array.isArray(message.logs) && message.logs.length <= 128);
        for (const log of message.logs) projector.add(log);
        return send({ type: 'ack', sequence });
      }
      assert.equal(message.type, 'finish');
      const state = projector.finish(message.storeId);
      assert.equal(guards.report().attempts, 0);
      return send({ type: 'result', value: { state, guards: guards.report() } });
    })
    .catch((error) => {
      send({ type: 'failure', message: String(error.stack).slice(0, 2000) }).finally(() =>
        process.exit(1)
      );
    });
});
