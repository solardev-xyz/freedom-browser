/** Real-engine process-boundary qualification; public viewing material only. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { assertRailgunFixture } = require('../railgun-fixture-integrity');
const { installPPv2EgressTripwire } = require('./ppv2-egress-tripwire');
const { createRailgunRemote } = require('../../src/main/wallet/railgun-remote');
const {
  createRailgunHostProvider,
  lockRailgunHttp,
} = require('../../src/main/networks/railgun-host-provider');
const pending = new Map();
const abort = new AbortController();
const post = (value) => process.send(value);
// Deliberately uncooperative child: prove the parent escalates termination and
// waits for actual exit rather than trusting engine cleanup or a result message.
process.on('SIGTERM', () => {});
process.on('disconnect', () => {
  abort.abort();
  process.exit(1);
});
process.on('message', (message) => {
  if (message?.type !== 'reply') return;
  const parsed = JSON.parse(message.wire),
    task = pending.get(parsed.id);
  assert.ok(task);
  pending.delete(parsed.id);
  task.resolve(message.wire);
});
async function main(input) {
  assert.deepEqual(Object.keys(input).sort(), ['mode', 'spendingPublicKey', 'type', 'viewingKey']);
  assert.ok(['create', 'lock', 'fault', 'restore'].includes(input.mode));
  assert.match(input.viewingKey, /^[0-9a-f]{64}$/);
  const root = path.join(__dirname, 'railgun-engine');
  const inventory = assertRailgunFixture(path.join(root, 'node_modules'));
  const r = createRequire(path.join(root, 'package.json'));
  const tripwire = installPPv2EgressTripwire();
  const ethers = r('ethers');
  lockRailgunHttp(ethers.FetchRequest);
  const engine = r('@railgun-community/engine');
  const remote = createRailgunRemote({
    ...r('abstract-leveldown'),
    signal: abort.signal,
    send: (wire) =>
      new Promise((resolve, reject) => {
        const id = JSON.parse(wire).id;
        pending.set(id, { resolve, reject });
        post({ type: 'command', wire });
      }),
  });
  const refused = async () => {
    throw new Error('Capability unavailable');
  };
  const errors = [];
  const instance = await engine.RailgunEngine.initForWallet(
    'freedomfixture',
    remote.leveldown,
    {
      assertArtifactExists() {
        throw new Error('Capability unavailable');
      },
      getArtifacts: refused,
      getArtifactsPOI: refused,
    },
    refused,
    refused,
    refused,
    refused,
    {
      log() {},
      error(error) {
        errors.push(error?.name);
      },
    },
    false
  );
  const checks = [];
  const wallet = new engine.HardwareWallet(
    'public-process-fixture',
    instance.db,
    {
      privateKey: Buffer.from(input.viewingKey, 'hex'),
      pubkey: await engine.getPublicViewingKey(Buffer.from(input.viewingKey, 'hex')),
    },
    input.spendingPublicKey.map(BigInt),
    undefined,
    instance.prover
  );
  wallet.setConnector({ sign: refused, requestBatchApproval: refused });
  assert.deepEqual((await wallet.getSpendingKeyPair('unused')).privateKey, new Uint8Array(32));
  await assert.rejects(
    wallet.sign(
      { merkleRoot: 1n, boundParamsHash: 2n, nullifiers: [3n], commitmentsOut: [4n] },
      'fixture'
    )
  );
  checks.push('viewing-only-hardware-wallet-without-signing');
  if (input.mode !== 'create') {
    assert.equal(await instance.db.get(['aa'], 'utf8'), wallet.getAddress());
    assert.deepEqual(
      await instance.db.level.getMany(['public-json', 'missing'], { valueEncoding: 'json' }),
      [{ stable: true }, undefined]
    );
    await assert.rejects(instance.db.level.get('must-not-commit'));
  }
  await instance.db.put(['aa'], wallet.getAddress(), 'utf8');
  await instance.db.level.put('public-json', { stable: true }, { valueEncoding: 'json' });
  checks.push('actual-engine-remote-database-and-fresh-restore');
  const level = remote.leveldown;
  const call = (method, ...args) =>
    new Promise((resolve, reject) =>
      level[method](...args, (error, ...values) => (error ? reject(error) : resolve(values)))
    );
  await call(
    'batch',
    ['a', 'b', 'c'].map((key) => ({ type: 'put', key: 'iter-' + key, value: key })),
    {}
  );
  const iterator = level.iterator({
    gte: 'iter-a',
    lte: 'iter-c',
    reverse: true,
    limit: 2,
    keyAsBuffer: false,
    valueAsBuffer: false,
  });
  await call('put', 'iter-b', 'changed', {});
  assert.deepEqual(await iterator.next(), ['iter-c', 'c']);
  iterator.seek('iter-b');
  assert.deepEqual(await iterator.next(), ['iter-b', 'b']);
  assert.equal(await iterator.next(), undefined);
  await iterator.end();
  await call('clear', { gte: 'iter-a', lte: 'iter-c', limit: -1 });
  await assert.rejects(call('get', 'iter-a', {}), /NotFound/);
  checks.push('remote-stable-iterator-seek-limit-and-clear');
  const provider = createRailgunHostProvider({
    PollingJsonRpcProvider: engine.PollingJsonRpcProvider,
    provider: remote.provider,
    signal: remote.signal,
    chainId: 11155111,
  });
  assert.equal(await provider.getBlockNumber(), 291);
  await instance.loadNetwork(
    { type: 0, id: 11155111 },
    '0x' + '11'.repeat(20),
    '0x' + '22'.repeat(20),
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    provider,
    provider,
    { [engine.TXIDVersion.V2_PoseidonMerkle]: 1, [engine.TXIDVersion.V3_PoseidonMerkle]: 1 },
    2,
    false
  );
  assert.ok(
    instance.getUTXOMerkletree(engine.TXIDVersion.V2_PoseidonMerkle, { type: 0, id: 11155111 })
  );
  checks.push('actual-engine-controlled-network-over-host-rpc');
  const tree = instance.getUTXOMerkletree(engine.TXIDVersion.V2_PoseidonMerkle, {
    type: 0,
    id: 11155111,
  });
  const proof = await tree.getMerkleProof(0, 0);
  assert.equal(proof.elements.length, 16);
  // Empty-tree proof construction still performs the cold parallel DB reads;
  // upstream catches missing nodes, so also assert the session remains active.
  assert.equal(remote.signal.aborted, false);
  const burst = await Promise.all(
    Array.from({ length: 128 }, () => instance.db.get(['aa'], 'utf8'))
  );
  assert.ok(burst.every((address) => address === wallet.getAddress()));
  checks.push('actual-engine-cold-merkle-path-and-concurrent-reads');
  assert.ok(
    !Object.keys(require.cache).some(
      (file) => file.includes('better-sqlite3') || file.endsWith('/railgun-store.js')
    )
  );
  for (const module of Object.values(require.cache)) {
    if (!module.filename.startsWith(path.join(root, 'node_modules') + path.sep)) continue;
    for (const child of module.children)
      assert.ok(child.filename.startsWith(path.join(root, 'node_modules') + path.sep));
  }
  // Positive tripwire canaries are counted separately from actual attempts.
  tripwire.assertClean();
  const egress = tripwire.report();
  assert.equal(errors.length, 0);
  const report = {
    mode: input.mode,
    checks,
    inventory: inventory.sha256,
    hooks: egress.hooks.length,
    canaries: egress.refusedCanaries.length,
    directAttempts: 0,
    address: wallet.getAddress(),
    databaseInChild: false,
    spendingKeyDelivered: false,
    contractHistoryScanned: false,
  };
  if (['lock', 'fault'].includes(input.mode)) {
    const held = level.iterator({});
    assert.ok(await held.next());
    // Start a read whose synthetic host deliberately never completes until after
    // revocation. Its result must never reach the child.
    provider
      ._send({
        jsonrpc: '2.0',
        id: 777,
        method: 'eth_getBlockByHash',
        params: ['0x' + '99'.repeat(32), false],
      })
      .catch(() => {});
    post({ type: 'armed', report });
    if (input.mode === 'fault')
      await instance.db.level.batch([
        { type: 'put', key: 'must-not-commit', value: 'first' },
        { type: 'put', key: 'public-json', value: 'overwritten' },
      ]);
  } else post({ type: 'result', report });
}
process.once('message', (message) => {
  main(message).catch(() => {
    post({ type: 'failure' });
    process.exitCode = 1;
  });
});
