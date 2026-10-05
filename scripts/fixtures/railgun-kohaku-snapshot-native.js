/** Optional fixture probe over borrowed genuine owners. Never an authority issuer. */
const { assert } = require('./railgun-native-assertions');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const keys = [
  'brokerMessages',
  'rpcFactories',
  'rpcRequests',
  'transportFactories',
  'signerFactories',
  'railgunKeyRequests',
  'railgunKeyReplies',
];
function install() {
  for (const name of [
    'railgun-kohaku-snapshot-host',
    'railgun-kohaku-snapshot-plugin',
    'railgun-account-wallet',
    'signers',
  ])
    assert.equal(
      !!require.cache[require.resolve(wallet + name)],
      false,
      'Snapshot observer installed late: ' + name
    );
  const meter = require('./railgun-kohaku-contract-observer').installResourceMeter();
  const signers = require(wallet + 'signers');
  const original = signers.getSigner;
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  const observed = function (...args) {
    counts.signerFactories++;
    return Reflect.apply(original, this, args);
  };
  signers.getSigner = observed;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    assert.equal(signers.getSigner, observed);
    signers.getSigner = original;
  }
  const resources = Object.freeze({
    ...meter,
    async close() {
      try {
        close();
      } finally {
        await meter.close();
      }
    },
  });
  return Object.freeze({
    resources,
    count(key) {
      assert.ok(!closed && keys.includes(key));
      counts[key]++;
    },
    measure({ applications, walletRestores }) {
      assert.ok(!closed);
      return { ...resources.snapshot(), ...counts, applications, walletRestores };
    },
    close,
  });
}
function encryptedFiles(profile, walletDirectory) {
  const { inventory } = require('./railgun-public-cold-data');
  const values = {};
  for (const name of ['identity', 'wallet-railgun-accounts', 'wallet-private-submissions']) {
    const directory = path.join(profile, name);
    let stat;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      assert.ok(name === 'wallet-private-submissions' && error.code === 'ENOENT');
      values[name] = null;
      continue;
    }
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    values[name] = inventory(directory);
  }
  const marker = path.join(profile, 'wallet-privacy-inventory.json');
  const stat = fs.lstatSync(marker);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  values.inventory = createHash('sha256').update(fs.readFileSync(marker)).digest('hex');
  const walletStat = fs.lstatSync(walletDirectory);
  assert.ok(walletStat.isDirectory() && !walletStat.isSymbolicLink());
  values.walletGeneration = inventory(walletDirectory);
  assert.ok(Object.hasOwn(values.walletGeneration, 'wallet.sqlite'));
  return values;
}
async function qualify({ account, owners, signal, profile, walletDirectory, measure }) {
  const { readRailgunAccountOwnedNotes } = require(wallet + 'railgun-account-wallet');
  const { createRailgunKohakuSnapshotHost } = require(wallet + 'railgun-kohaku-snapshot-host');
  const { createRailgunKohakuSnapshotPlugin } = require(wallet + 'railgun-kohaku-snapshot-plugin');
  const { checkSnapshotConformance } = require('./railgun-kohaku-snapshot-conformance');
  const { assertReadProjection } = require('./railgun-kohaku-contract-oracle');
  const baseline = readRailgunAccountOwnedNotes(account, owners);
  assert.equal(baseline.read.instanceId, owners.identity.descriptor.instanceId);
  assert.equal(baseline.read.received.length, 3);
  assert.equal(baseline.read.received.filter((note) => note.spentTxid === false).length, 2);
  assert.equal(
    baseline.read.received
      .filter((note) => note.spentTxid === false)
      .reduce((total, note) => total + note.amount, 0n),
    2700n
  );
  const before = measure();
  // This default lane must have no earlier signer that could escape the factory observer.
  assert.equal(before.signerFactories, 0);
  const bytes = encryptedFiles(profile, walletDirectory);
  const view = account.view,
    generation = account.generationId;
  const signals = [
    account.signal,
    owners.identity.signal,
    owners.enrollment.signal,
    owners.coordinator.signal,
  ];
  const check = () => {
    assert.deepEqual(measure(), before, 'Snapshot reads added measured work');
    assert.deepEqual(
      encryptedFiles(profile, walletDirectory),
      bytes,
      'Snapshot reads changed durable files'
    );
    assert.deepEqual(readRailgunAccountOwnedNotes(account, owners), baseline);
    assert.equal(account.view, view);
    assert.equal(account.generationId, generation);
    assert.ok(signals.every((value) => !value.aborted));
  };
  const hostController = new AbortController();
  let plugin;
  try {
    const host = createRailgunKohakuSnapshotHost({
      account,
      owners,
      signal: AbortSignal.any([signal, hostController.signal]),
    });
    plugin = createRailgunKohakuSnapshotPlugin({ host, signal });
    check();
    const shared = await checkSnapshotConformance(plugin, baseline.read);
    assert.equal(shared.readVectors, 9);
    check();
    const notes = await plugin.notes(undefined, true);
    const balances = await plugin.balance();
    assert.ok(notes.length && balances.length);
    for (const values of [notes, balances]) {
      assert.ok(
        !Object.isFrozen(values) && !Object.isFrozen(values[0]) && !Object.isFrozen(values[0].asset)
      );
      assert.ok(
        !baseline.read.received.some((note) => note === values[0] || note.asset === values[0].asset)
      );
      values[0].amount = 999n;
      values[0].asset.contract = '0x' + 'f'.repeat(40);
      values.push({ fixtureMutation: true });
    }
    for (const [method, args] of [
      ['notes', [undefined, true]],
      ['balance', []],
    ]) {
      const pending = plugin[method](...args);
      assertReadProjection(baseline.read, {
        method,
        args,
        value: await pending,
        promiseReturned: pending instanceof Promise,
      });
      check();
    }
    const admitted = plugin.instanceId();
    let pendingSettled = false;
    const refusedRead = admitted.then(
      () => {
        assert.fail('Read admitted immediately before close must refuse');
      },
      (error) => {
        pendingSettled = true;
        assert.equal(error.code, 'RAILGUN_KOHAKU_SNAPSHOT_REFUSED');
        assert.equal(error.message, 'Kohaku snapshot read unavailable');
      }
    );
    const observedClosed = plugin.closed.then(() => {
      assert.equal(pendingSettled, true, 'Adapter closed before admitted read settled');
    });
    const drained = Promise.all([refusedRead, observedClosed]);
    try {
      plugin.close();
      assert.equal(pendingSettled, false, 'Read must still be pending at same-turn close');
    } finally {
      await drained;
    }
    assert.equal(plugin.signal.aborted, true);
    hostController.abort();
    assert.throws(() => host.capture(), { code: 'RAILGUN_KOHAKU_SNAPSHOT_REFUSED' });
    for (const method of ['instanceId', 'balance', 'notes'])
      await assert.rejects(plugin[method](), { code: 'RAILGUN_KOHAKU_SNAPSHOT_REFUSED' });
    for (const [method, args] of [
      ['balance', []],
      ['notes', [undefined, true]],
    ]) {
      const pending = view[method](...args);
      assertReadProjection(baseline.read, {
        method,
        args,
        value: await pending,
        promiseReturned: pending instanceof Promise,
      });
    }
    check();
    return Object.freeze({
      schema: 'railgun-kohaku-snapshot-native-v1',
      scenario: 'enrolled-stage30-restore',
      instances: 1,
      sharedReadVectors: 9,
      successfulAdapterReads: 13,
      postCloseRefusals: 3,
      hostAbortRefusals: 1,
      inFlightReadRefusedAtClose: 1,
      borrowedViewReadsAfterClose: 2,
      receivedRecords: 3,
      unspentRecords: 2,
      spentRecords: 1,
      genuineAccountAndOwners: true,
      comparedToGenuineOwnedSnapshot: true,
      detachedMutationIsolation: true,
      borrowedAccountRemainsUsable: true,
      adapterClosedObserved: true,
      durableEncryptedFilesAndNamesUnchanged: true,
      wholeBrowserProfileByteIdentity: false,
      provenance: 'host-supplied',
      zeroAdditionalMeasuredWork: true,
      deltas: Object.freeze(
        Object.fromEntries(
          Object.entries(measure()).map(([key, value]) => [key, value - before[key]])
        )
      ),
      eligibilityGranted: false,
      spendingAuthorityGranted: false,
      typescriptConformance: false,
      genericHostQualified: false,
      physicalSocketDrainQualified: false,
    });
  } finally {
    try {
      if (plugin) {
        try {
          plugin.close();
        } finally {
          await plugin.closed;
        }
      }
    } finally {
      hostController.abort();
    }
  }
}
module.exports = { install, qualify, encryptedFiles };
