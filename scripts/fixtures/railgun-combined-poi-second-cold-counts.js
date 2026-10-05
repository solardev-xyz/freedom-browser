/** Exact phase deltas, not prefilled native results. Bootstrap identity work and
 * terminal baseline/ingestion are deliberately outside cold host counters. */
const { assert } = require('./railgun-native-assertions');
const delta = (a, b) =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .map((k) => [k, (a[k] || 0) - (b[k] || 0)])
      .filter(([, v]) => v)
  );
function jobs(before, after, expected, keys, storage) {
  for (const f of ['starts', 'exits', 'attemptedResults', 'admittedResults'])
    assert.deepEqual(delta(after.audit[f], before.audit[f]), expected);
  for (const f of ['keyRequests', 'keyReplies'])
    assert.deepEqual(delta(after.audit[f], before.audit[f]), keys);
  assert.equal(after.storageWorkers.starts - before.storageWorkers.starts, storage);
  assert.equal(after.storageWorkers.exits - before.storageWorkers.exits, storage);
  assert.equal(after.storageWorkers.pending, before.storageWorkers.pending);
  assert.equal(after.chain.posts, before.chain.posts);
  assert.deepEqual(after.services.poiMethods, before.services.poiMethods);
  assert.deepEqual(after.services.publicServiceMethods, before.services.publicServiceMethods);
  assert.equal(after.services.transportEntries, before.services.transportEntries);
}
function list(before, after) {
  const calls = delta(after.chain.attempted, before.chain.attempted);
  assert.deepEqual(delta(after.chain.validated, before.chain.validated), calls);
  for (const name of [
    'ppoi_pois_per_list',
    'ppoi_merkle_proofs',
    'ppoi_poi_events',
    'ppoi_validate_poi_merkleroots',
  ])
    assert.equal(calls['private-account:poi:' + name], 1);
  for (const name of ['ppoi_validated_txid', 'ppoi_validate_txid_merkleroot'])
    assert.equal(calls['service:poi:' + name], 3);
  assert.equal(calls['service:indexer:page'] || 0, 0);
  assert.equal(calls['private-account:poi:ppoi_submit_transact_proof'] || 0, 0);
  assert.equal(after.services.signatureChecks - before.services.signatureChecks, 1);
  return calls;
}
// One nested deployment + private preflight, including each independent lazy
// chain handshake. Public submission refreshes the first resolved record three
// times (core, service, broadcast); prove-stop refreshes it once before B.
function rpcInventory(cold) {
  return {
    'protocol-rpc:shield-preflight:eth_chainId': 1,
    'protocol-rpc:shield-preflight:eth_getBlockByNumber': 2,
    'protocol-rpc:shield-preflight:eth_getCode': 4,
    'protocol-rpc:shield-preflight:eth_getStorageAt': 2,
    'protocol-rpc:shield-preflight:eth_call': 4,
    'protocol-rpc:private-preflight:eth_chainId': 1,
    'protocol-rpc:private-preflight:eth_call': 4,
    'protocol-rpc:private-preflight:eth_getBlockByNumber': 1,
    'transaction-rpc:public:eth_chainId': 1,
    'transaction-rpc:public:eth_blockNumber': cold ? 3 : 1,
    'transaction-rpc:public:eth_getBlockByNumber': cold ? 3 : 1,
    'transaction-rpc:public:eth_getCode': 1,
    'transaction-rpc:public:eth_getBalance': 1,
    ...(cold
      ? {
          'transaction-rpc:public:eth_estimateGas': 1,
          'transaction-rpc:public:eth_call': 1,
          'transaction-rpc:public:eth_gasPrice': 1,
          'transaction-rpc:public:eth_getTransactionCount': 3,
          'transaction-rpc:public:eth_sendRawTransaction': 1,
        }
      : {}),
  };
}
function trafficInventory(before, after, traffic, calls, cold) {
  const expected = rpcInventory(cold);
  assert.deepEqual(traffic.attempted, expected);
  assert.deepEqual(traffic.validated, expected);
  // Count the entire outer transport too: equal handled counts cannot hide
  // an unexpected role/method routed through a different fixture branch.
  const roles = { ...calls };
  for (const [key, n] of Object.entries(expected)) {
    const [role, , method] = key.split(':');
    const combined =
      (role === 'transaction-rpc' ? 'public-address:' : 'private-account:') + role + ':' + method;
    roles[combined] = (roles[combined] || 0) + n;
  }
  assert.deepEqual(delta(after.roleMethods, before.roleMethods), roles);
}
function assertProveStop(before, after, traffic, wire) {
  const expected = {
    'railgun-wallet-job.js': 2,
    'railgun-txid-job.js': 3,
    'railgun-private-operate-job.js': 1,
    'railgun-note-provenance-job.js': 1,
    'railgun-poi-job.js': 1,
    'railgun-spend-sign-job.js': 1,
    'railgun-private-verify-job.js': 1,
  };
  jobs(
    before,
    after,
    expected,
    {
      'railgun-wallet-job.js': 2,
      'railgun-private-operate-job.js': 1,
      'railgun-spend-sign-job.js': 1,
    },
    3
  );
  const calls = list(before, after);
  // Warm public evidence from the genuine resume bootstrap. Initial wallet
  // restore, staging replacement restore, and private operate each perform
  // exactly two canonical refresh passes; none fetch logs or replan.
  const plan = wire.checkpoint;
  const boundaries = new Set([
    plan.anchor.number,
    plan.from,
    plan.to.number,
    ...(plan.from ? [plan.from - 1] : []),
  ]);
  assert.deepEqual(calls, {
    'private-account:protocol-rpc:eth_getBlockByNumber': 6 * (1 + boundaries.size),
    ...Object.fromEntries(
      [
        'ppoi_pois_per_list',
        'ppoi_merkle_proofs',
        'ppoi_poi_events',
        'ppoi_validate_poi_merkleroots',
      ].map((name) => ['private-account:poi:' + name, 1])
    ),
    'service:poi:ppoi_validated_txid': 3,
    'service:poi:ppoi_validate_txid_merkleroot': 3,
  });
  assert.deepEqual(delta(after.audit.modes, before.audit.modes), { inspect: 2, 'note-witness': 1 });
  assert.deepEqual(traffic.privateCalls, {
    rootHistory: 1,
    unshieldFee: 1,
    getVerificationKey: 1,
    nullifiers: 1,
  });
  trafficInventory(before, after, traffic, calls, false);
  assert.equal(traffic.firstCanonicalRefreshReads, 1);
  for (const f of ['signatures', 'sends', 'journalBeforeSend']) assert.equal(traffic[f], 0);
  for (const f of ['signatureAttempts', 'signatures', 'sends', 'reviews'])
    assert.equal(after.eoa[f], before.eoa[f]);
  return { jobs: expected, calls, storageWorkers: 3, firstCanonicalRefreshReads: 1 };
}
function assertColdHost(before, after, traffic, wire, source) {
  const expected = {
    'railgun-public-job.js': 2,
    'railgun-wallet-job.js': 1,
    'railgun-txid-job.js': 3,
    'railgun-note-provenance-job.js': 1,
    'railgun-private-verify-job.js': 1,
    'railgun-poi-job.js': 1,
  };
  jobs(before, after, expected, { 'railgun-wallet-job.js': 1 }, 2);
  const calls = list(before, after);
  const proxy = require('../../src/main/wallet/railgun-shield-pins.json').proxy;
  const sourceHeaders = require('./railgun-combined-poi-restart-counts').expectedHeaders(
    wire.checkpoint,
    [...source.logs, ...wire.receipt.logs.filter((v) => v.address.toLowerCase() === proxy)]
  );
  assert.deepEqual(calls, {
    'private-account:protocol-rpc:eth_chainId': 1,
    'private-account:protocol-rpc:eth_getBlockByNumber': sourceHeaders * 2,
    'private-account:protocol-rpc:eth_getLogs': 2,
    ...Object.fromEntries(
      [
        'ppoi_pois_per_list',
        'ppoi_merkle_proofs',
        'ppoi_poi_events',
        'ppoi_validate_poi_merkleroots',
      ].map((v) => ['private-account:poi:' + v, 1])
    ),
    'service:poi:ppoi_validated_txid': 3,
    'service:poi:ppoi_validate_txid_merkleroot': 3,
  });

  assert.deepEqual(delta(after.audit.modes, before.audit.modes), { inspect: 2, 'note-witness': 1 });
  assert.deepEqual(traffic.privateCalls, {
    rootHistory: 1,
    unshieldFee: 1,
    getVerificationKey: 1,
    nullifiers: 1,
  });
  trafficInventory(before, after, traffic, calls, true);
  assert.equal(traffic.firstCanonicalRefreshReads, 3);
  for (const f of ['signatures', 'sends', 'journalBeforeSend']) assert.equal(traffic[f], 1);
  for (const f of ['signatureAttempts', 'signatures', 'sends', 'reviews'])
    assert.equal(after.eoa[f] - before.eoa[f], 1);
  return { jobs: expected, calls, storageWorkers: 2, firstCanonicalRefreshReads: 3 };
}
function assertColdBootstrap(value) {
  for (const f of ['starts', 'exits', 'attemptedResults', 'admittedResults'])
    assert.deepEqual(value.audit[f], { 'railgun-identity-job.js': 2 });
  for (const f of ['keyRequests', 'keyReplies'])
    assert.deepEqual(value.audit[f], { 'railgun-identity-job.js': 2 });
  assert.deepEqual(value.keys, { 'spending-public': 1, 'viewing-identity': 1 });
  assert.deepEqual(value.roleMethods, {});
  assert.deepEqual(value.chain.attempted, {});
  assert.deepEqual(value.chain.validated, {});
  assert.equal(value.chain.posts, 0);
  assert.equal(value.storageWorkers.starts, 2);
  assert.equal(value.storageWorkers.exits, 0);
  assert.equal(value.storageWorkers.pending, 2);
  assert.equal(value.services.signatureChecks, 1);
  assert.equal(value.services.transportEntries, 0);
  for (const f of ['signatureAttempts', 'signatures', 'sends', 'reviews'])
    assert.equal(value.eoa[f], 0);
  return { identityJobs: 2, publicStorageWorkers: 2, networkRequests: 0 };
}
module.exports = { delta, assertProveStop, assertColdHost, assertColdBootstrap, jobs };
