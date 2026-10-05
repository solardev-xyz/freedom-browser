jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const c = require('./railgun-combined-poi-second-cold-counts');
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
  source = { logs: [{ blockNumber: 90 }] };
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
    eoa: { signatureAttempts: 0, signatures: 0, sends: 0, reviews: 0 },
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
test.each([false, true])('exact source-derived phase inventory cold=%s', (cold) => {
  const { before, after, traffic } = sample(cold);
  expect(
    (cold ? c.assertColdHost : c.assertProveStop)(before, after, traffic, wire, source)
      .storageWorkers
  ).toBe(cold ? 2 : 3);
});
test.each([
  'extraB',
  'missingExit',
  'extraPost',
  'missingQuery',
  'extraQuery',
  'badProofAdmission',
  'missingLoanWipeCount',
  'extraWorker',
  'refreshFour',
  'renewedWarmup',
  'sourcePass',
  'secondPrivatePreflight',
])('%s cannot qualify cold host', (fault) => {
  const { before, after, traffic } = sample(true);
  if (fault === 'extraB') after.audit.starts['railgun-spend-sign-job.js'] = 1;
  if (fault === 'missingExit') after.audit.exits['railgun-poi-job.js'] = 0;
  if (fault === 'extraPost') after.chain.posts = 1;
  if (fault === 'missingQuery')
    delete after.chain.validated['private-account:poi:ppoi_merkle_proofs'];
  if (fault === 'extraQuery')
    after.chain.attempted['unexpected'] = after.chain.validated['unexpected'] = 1;
  if (fault === 'badProofAdmission')
    after.audit.admittedResults['railgun-private-verify-job.js'] = 0;
  if (fault === 'missingLoanWipeCount') after.audit.keyReplies['railgun-wallet-job.js'] = 0;
  if (fault === 'extraWorker') after.storageWorkers.pending++;
  if (fault === 'refreshFour') traffic.firstCanonicalRefreshReads = 4;
  if (fault === 'renewedWarmup')
    after.chain.attempted['private-account:protocol-rpc:eth_chainId'] = after.chain.validated[
      'private-account:protocol-rpc:eth_chainId'
    ] = 2;
  if (fault === 'sourcePass')
    after.chain.attempted['private-account:protocol-rpc:eth_getBlockByNumber'] =
      after.chain.validated['private-account:protocol-rpc:eth_getBlockByNumber'] = 17;
  if (fault === 'secondPrivatePreflight') traffic.privateCalls.rootHistory = 2;
  expect(() => c.assertColdHost(before, after, traffic, wire, source)).toThrow();
});
test('prove stop refuses a warm submission, even if all other jobs match', () => {
  const { before, after, traffic } = sample(false);
  traffic.sends = 1;
  expect(() => c.assertProveStop(before, after, traffic, wire)).toThrow();
});

test.each([false, true])('balanced RPC missing/extra calls cannot qualify cold=%s', (cold) => {
  const baseline = sample(cold);
  for (const method of Object.keys(baseline.traffic.attempted)) {
    for (const change of [-1, 1]) {
      const { before, after, traffic } = copy(baseline);
      traffic.attempted[method] += change;
      if (!traffic.attempted[method]) delete traffic.attempted[method];
      traffic.validated = copy(traffic.attempted);
      expect(() =>
        (cold ? c.assertColdHost : c.assertProveStop)(before, after, traffic, wire, source)
      ).toThrow();
    }
  }
  const { before, after, traffic } = sample(cold);
  traffic.attempted = traffic.validated = {};
  expect(() =>
    (cold ? c.assertColdHost : c.assertProveStop)(before, after, traffic, wire, source)
  ).toThrow();
});
test.each(['missing', 'extra', 'logs', 'role-only'])(
  'prove-stop exact full source map rejects %s',
  (fault) => {
    const { before, after, traffic } = sample(false);
    const key = 'private-account:protocol-rpc:eth_getBlockByNumber';
    if (fault === 'role-only') after.roleMethods['service:rpc:eth_chainId'] = 1;
    else {
      const calls = after.chain.attempted;
      if (fault === 'logs') calls['private-account:protocol-rpc:eth_getLogs'] = 1;
      else calls[key] += fault === 'missing' ? -1 : 1;
      after.chain.validated = copy(calls);
    }
    expect(() => c.assertProveStop(before, after, traffic, wire)).toThrow();
  }
);
