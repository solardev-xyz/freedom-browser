/** C signature stop ends before C and before the failing operate snapshot's
 * post-callback canonical refresh. All earlier admissions remain exact. */
const { assert } = require('./railgun-native-assertions');
const { delta } = require('./railgun-combined-poi-second-cold-counts');
function assertSignStop(before, after, traffic, wire) {
  const jobs = {
    'railgun-wallet-job.js': 2,
    'railgun-txid-job.js': 3,
    'railgun-private-operate-job.js': 1,
    'railgun-note-provenance-job.js': 1,
    'railgun-poi-job.js': 1,
    'railgun-spend-sign-job.js': 1,
  };
  for (const k of ['starts', 'exits', 'attemptedResults'])
    assert.deepEqual(delta(after.audit[k], before.audit[k]), jobs);
  const admitted = { ...jobs };
  delete admitted['railgun-private-operate-job.js'];
  assert.deepEqual(delta(after.audit.admittedResults, before.audit.admittedResults), admitted);
  for (const k of ['keyRequests', 'keyReplies'])
    assert.deepEqual(delta(after.audit[k], before.audit[k]), {
      'railgun-wallet-job.js': 2,
      'railgun-private-operate-job.js': 1,
      'railgun-spend-sign-job.js': 1,
    });
  assert.deepEqual(delta(after.audit.modes, before.audit.modes), {
    inspect: 2,
    'note-witness': 1,
  });
  assert.equal(after.storageWorkers.starts - before.storageWorkers.starts, 3);
  assert.equal(after.storageWorkers.exits - before.storageWorkers.exits, 3);
  assert.equal(after.storageWorkers.pending, before.storageWorkers.pending);
  // The production prepare path reads its public submitter before private signing.
  // No EOA transaction signature, submission or transaction review occurs here.
  assert.deepEqual(after.eoa, { ...before.eoa, addressAttempts: before.eoa.addressAttempts + 1 });
  assert.equal(after.chain.posts, before.chain.posts);
  for (const k of ['poiMethods', 'publicServiceMethods', 'transportEntries'])
    assert.deepEqual(after.services[k], before.services[k]);
  assert.equal(after.services.signatureChecks - before.services.signatureChecks, 1);
  const plan = wire.checkpoint;
  const boundaries = new Set([
    plan.anchor.number,
    plan.from,
    plan.to.number,
    ...(plan.from ? [plan.from - 1] : []),
  ]);
  const calls = {
    'private-account:protocol-rpc:eth_getBlockByNumber': 5 * (1 + boundaries.size),
    ...Object.fromEntries(
      [
        'ppoi_pois_per_list',
        'ppoi_merkle_proofs',
        'ppoi_poi_events',
        'ppoi_validate_poi_merkleroots',
      ].map((n) => ['private-account:poi:' + n, 1])
    ),
    'service:poi:ppoi_validated_txid': 3,
    'service:poi:ppoi_validate_txid_merkleroot': 3,
  };
  for (const k of ['attempted', 'validated'])
    assert.deepEqual(delta(after.chain[k], before.chain[k]), calls);
  const rpc = {
    'protocol-rpc:shield-preflight:eth_chainId': 1,
    'protocol-rpc:shield-preflight:eth_getBlockByNumber': 2,
    'protocol-rpc:shield-preflight:eth_getCode': 4,
    'protocol-rpc:shield-preflight:eth_getStorageAt': 2,
    'protocol-rpc:shield-preflight:eth_call': 4,
    'protocol-rpc:private-preflight:eth_chainId': 1,
    'protocol-rpc:private-preflight:eth_call': 4,
    'protocol-rpc:private-preflight:eth_getBlockByNumber': 1,
    'transaction-rpc:public:eth_chainId': 1,
    'transaction-rpc:public:eth_blockNumber': 1,
    'transaction-rpc:public:eth_getBlockByNumber': 1,
    'transaction-rpc:public:eth_getCode': 1,
    'transaction-rpc:public:eth_getBalance': 1,
  };
  assert.deepEqual(traffic.attempted, rpc);
  assert.deepEqual(traffic.validated, rpc);
  const roles = { ...calls };
  for (const [k, n] of Object.entries(rpc)) {
    const [role, , method] = k.split(':');
    const key =
      (role === 'transaction-rpc' ? 'public-address:' : 'private-account:') + role + ':' + method;
    roles[key] = (roles[key] || 0) + n;
  }
  assert.deepEqual(delta(after.roleMethods, before.roleMethods), roles);
  assert.deepEqual(traffic.privateCalls, {
    rootHistory: 1,
    unshieldFee: 1,
    getVerificationKey: 1,
    nullifiers: 1,
  });
  assert.equal(traffic.firstCanonicalRefreshReads, 1);
  for (const k of ['sends', 'signatures', 'journalBeforeSend']) assert.equal(traffic[k], 0);
}
module.exports = { assertSignStop };
