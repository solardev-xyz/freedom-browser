jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { assertSignStop } = require('./railgun-combined-poi-second-sign-counts');
const copy = (v) => JSON.parse(JSON.stringify(v));
const proofJobs = {
  'railgun-wallet-job.js': 2,
  'railgun-txid-job.js': 3,
  'railgun-private-operate-job.js': 1,
  'railgun-note-provenance-job.js': 1,
  'railgun-poi-job.js': 1,
  'railgun-spend-sign-job.js': 1,
  'railgun-private-verify-job.js': 1,
};
const hostJobs = {
  'railgun-public-job.js': 2,
  'railgun-wallet-job.js': 1,
  'railgun-txid-job.js': 3,
  'railgun-note-provenance-job.js': 1,
  'railgun-private-verify-job.js': 1,
  'railgun-poi-job.js': 1,
};
const calls = {
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
const wire = {
    checkpoint: { anchor: { number: 100 }, from: 80, to: { number: 100 } },
    receipt: { logs: [] },
  },
  _source = { logs: [{ blockNumber: 90 }] };
function sample(cold) {
  const before = {
    audit: {
      starts: {},
      exits: {},
      attemptedResults: {},
      admittedResults: {},
      keyRequests: {},
      keyReplies: {},
      modes: {},
    },
    roleMethods: {},
    eoa: { addressAttempts: 3, signatureAttempts: 0, signatures: 0, sends: 0, reviews: 0 },
    storageWorkers: { starts: 2, exits: 0, pending: 2 },
    chain: { posts: 0, attempted: {}, validated: {} },
    services: { poiMethods: {}, publicServiceMethods: {}, transportEntries: 0, signatureChecks: 1 },
  };
  const after = copy(before),
    jobs = cold ? hostJobs : proofJobs,
    keys = cold
      ? { 'railgun-wallet-job.js': 1 }
      : {
          'railgun-wallet-job.js': 2,
          'railgun-private-operate-job.js': 1,
          'railgun-spend-sign-job.js': 1,
        };
  for (const f of ['starts', 'exits', 'attemptedResults', 'admittedResults'])
    after.audit[f] = copy(jobs);
  for (const f of ['keyRequests', 'keyReplies']) after.audit[f] = copy(keys);
  after.audit.modes = { inspect: 2, 'note-witness': 1 };
  after.storageWorkers.starts += cold ? 2 : 3;
  after.storageWorkers.exits += cold ? 2 : 3;
  const methodCalls = {
    ...calls,
    ...(cold
      ? {
          'private-account:protocol-rpc:eth_chainId': 1,
          'private-account:protocol-rpc:eth_getBlockByNumber': 34,
          'private-account:protocol-rpc:eth_getLogs': 2,
        }
      : { 'private-account:protocol-rpc:eth_getBlockByNumber': 24 }),
  };
  after.chain.attempted = copy(methodCalls);
  after.chain.validated = copy(methodCalls);
  after.services.signatureChecks++;
  if (cold) for (const f of Object.keys(after.eoa)) after.eoa[f]++;
  const traffic = {
    privateCalls: { rootHistory: 1, unshieldFee: 1, getVerificationKey: 1, nullifiers: 1 },
    attempted: {
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
    },
    validated: {},
    firstCanonicalRefreshReads: cold ? 3 : 1,
    sends: cold ? 1 : 0,
    signatures: cold ? 1 : 0,
    journalBeforeSend: cold ? 1 : 0,
  };
  traffic.validated = copy(traffic.attempted);
  after.roleMethods = copy(methodCalls);
  for (const [key, value] of Object.entries(traffic.attempted)) {
    const [role, , method] = key.split(':');
    const k = `${role === 'transaction-rpc' ? 'public-address' : 'private-account'}:${role}:${method}`;
    after.roleMethods[k] = (after.roleMethods[k] || 0) + value;
  }
  return { before, after, traffic };
}

function signedSample() {
  const v = sample(false);
  v.after.eoa.addressAttempts++;
  for (const k of ['starts', 'exits', 'attemptedResults', 'admittedResults'])
    delete v.after.audit[k]['railgun-private-verify-job.js'];
  delete v.after.audit.admittedResults['railgun-private-operate-job.js'];
  for (const k of ['attempted', 'validated'])
    v.after.chain[k]['private-account:protocol-rpc:eth_getBlockByNumber'] = 20;
  v.after.roleMethods['private-account:protocol-rpc:eth_getBlockByNumber'] -= 4;
  return v;
}
test('signed refusal source prefix five canonical passes, refused operate result not admitted, no C', () => {
  const { before, after, traffic } = signedSample();
  assertSignStop(before, after, traffic, wire);
});
test.each([
  'post-snapshot',
  'missing-exit',
  'result-admitted',
  'new-C',
  'new-signature',
  'missing-address-read',
  'extra-address-read',
  'eoa-signature',
  'eoa-send',
  'eoa-review',
  'extra-rpc',
  'missing-rpc',
  'new-log',
])('signed stop rejects %s', (fault) => {
  const { before, after, traffic } = signedSample();
  if (fault === 'post-snapshot')
    after.chain.attempted['private-account:protocol-rpc:eth_getBlockByNumber'] =
      after.chain.validated['private-account:protocol-rpc:eth_getBlockByNumber'] = 24;
  if (fault === 'missing-exit') after.audit.exits['railgun-private-operate-job.js'] = 0;
  if (fault === 'result-admitted')
    after.audit.admittedResults['railgun-private-operate-job.js'] = 1;
  if (fault === 'new-C') after.audit.starts['railgun-private-verify-job.js'] = 1;
  if (fault === 'new-signature') after.audit.keyRequests['railgun-spend-sign-job.js'] = 2;
  if (fault === 'missing-address-read') after.eoa.addressAttempts--;
  if (fault === 'extra-address-read') after.eoa.addressAttempts++;
  if (fault === 'eoa-signature') after.eoa.signatureAttempts++;
  if (fault === 'eoa-send') after.eoa.sends++;
  if (fault === 'eoa-review') after.eoa.reviews++;
  if (fault === 'extra-rpc')
    traffic.attempted['transaction-rpc:public:eth_getCode'] = traffic.validated[
      'transaction-rpc:public:eth_getCode'
    ] = 2;
  if (fault === 'missing-rpc') {
    delete traffic.attempted['transaction-rpc:public:eth_chainId'];
    delete traffic.validated['transaction-rpc:public:eth_chainId'];
  }
  if (fault === 'new-log') after.roleMethods['private-account:protocol-rpc:eth_getLogs'] = 1;
  expect(() => assertSignStop(before, after, traffic, wire)).toThrow();
});
