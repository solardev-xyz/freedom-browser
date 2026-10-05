/** Source-derived resume bootstrap inventory. Second-spend and terminal helpers
 * separately enforce their exact deltas; no counts are initialized from setup. */
const { assert } = require('./railgun-native-assertions');
function expectedHeaders(checkpoint, logs) {
  const numbers = new Set([
    checkpoint.anchor.number,
    checkpoint.from,
    checkpoint.to.number,
    ...(checkpoint.from ? [checkpoint.from - 1] : []),
  ]);
  const blocks = new Set(
    logs
      .map((v) => Number(BigInt(v.blockNumber)))
      .filter((n) => n >= checkpoint.from && n <= checkpoint.to.number)
  );
  return 4 * (1 + numbers.size) + blocks.size;
}
function assertBootstrap(value, wire, source) {
  const jobs = {
    'railgun-identity-job.js': 2,
    'railgun-public-job.js': 1,
    'railgun-combined-poi-row-job.js': 1,
    'railgun-txid-job.js': 3,
  };
  for (const field of ['starts', 'exits', 'attemptedResults', 'admittedResults'])
    assert.deepEqual(value.audit[field], jobs);
  assert.deepEqual(value.audit.modes, { inspect: 2, witness: 1 });
  assert.deepEqual(value.audit.keyRequests, { 'railgun-identity-job.js': 2 });
  assert.deepEqual(value.audit.keyReplies, { 'railgun-identity-job.js': 2 });
  assert.deepEqual(value.keys, { 'spending-public': 1, 'viewing-identity': 1 });
  assert.equal(value.eoa.signatureAttempts, 0);
  assert.equal(value.eoa.signatures, 0);
  assert.equal(value.eoa.reviews, 0);
  assert.equal(value.eoa.sends, 0);
  assert.equal(value.storageWorkers.starts, 3);
  assert.equal(value.storageWorkers.exits, 1);
  assert.equal(value.storageWorkers.pending, 2);
  const proxy = require('../../src/main/wallet/railgun-shield-pins.json').proxy;
  const logs = [
    ...source.logs,
    ...wire.receipt.logs.filter((log) => log.address.toLowerCase() === proxy),
  ];
  const calls = {
    'private-account:protocol-rpc:eth_chainId': 1,
    'private-account:protocol-rpc:eth_getBlockByNumber': expectedHeaders(wire.checkpoint, logs),
    'private-account:protocol-rpc:eth_getLogs': 1,
    'service:poi:ppoi_validated_txid': 2,
    'service:poi:ppoi_validate_txid_merkleroot': 2,
  };
  assert.deepEqual(value.roleMethods, calls);
  assert.deepEqual(value.chain.attempted, calls);
  assert.deepEqual(value.chain.validated, calls);
  assert.equal(value.chain.posts, 0);
  assert.deepEqual(
    value.services.poiMethods,
    Object.fromEntries(
      [
        'ppoi_pois_per_list',
        'ppoi_merkle_proofs',
        'ppoi_poi_events',
        'ppoi_validate_poi_merkleroots',
      ].map((k) => [k, 0])
    )
  );
  assert.deepEqual(value.services.publicServiceMethods, {
    latest: 0,
    page: 0,
    validate: 0,
  });
  assert.equal(value.services.transportEntries, 0);
  assert.equal(value.services.signatureChecks, 1);
  return Object.freeze({
    jobs,
    requests: calls,
    storageStarts: 3,
    storageExits: 1,
    livePublicStores: 2,
    identityCredentialLoans: 2,
    walletViewingLoans: 0,
    transactionSigningLoans: 0,
    newPoiPosts: 0,
  });
}
module.exports = { expectedHeaders, assertBootstrap };
