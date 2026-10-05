jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
}));
const { expectedHeaders, assertBootstrap } = require('./railgun-combined-poi-restart-counts');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const copy = (v) => JSON.parse(JSON.stringify(v));
let value, wire, source;
beforeEach(() => {
  wire = {
    checkpoint: { anchor: { number: 100 }, from: 80, to: { number: 100 } },
    receipt: { logs: [{ address: pins.proxy, blockNumber: '0x5a' }] },
  };
  source = { logs: [{ address: pins.proxy, blockNumber: 1 }] };
  const jobs = {
    'railgun-identity-job.js': 2,
    'railgun-public-job.js': 1,
    'railgun-combined-poi-row-job.js': 1,
    'railgun-txid-job.js': 3,
  };
  const calls = {
    'private-account:protocol-rpc:eth_chainId': 1,
    'private-account:protocol-rpc:eth_getBlockByNumber': 17,
    'private-account:protocol-rpc:eth_getLogs': 1,
    'service:poi:ppoi_validated_txid': 2,
    'service:poi:ppoi_validate_txid_merkleroot': 2,
  };
  value = {
    audit: {
      ...Object.fromEntries(
        ['starts', 'exits', 'attemptedResults', 'admittedResults'].map((k) => [k, copy(jobs)])
      ),
      modes: { inspect: 2, witness: 1 },
      keyRequests: { 'railgun-identity-job.js': 2 },
      keyReplies: { 'railgun-identity-job.js': 2 },
    },
    keys: { 'spending-public': 1, 'viewing-identity': 1 },
    eoa: { signatureAttempts: 0, signatures: 0, reviews: 0, sends: 0 },
    storageWorkers: { starts: 3, exits: 1, pending: 2 },
    roleMethods: copy(calls),
    chain: { attempted: copy(calls), validated: copy(calls), posts: 0 },
    services: {
      transportEntries: 0,
      poiMethods: Object.fromEntries(
        [
          'ppoi_pois_per_list',
          'ppoi_merkle_proofs',
          'ppoi_poi_events',
          'ppoi_validate_poi_merkleroots',
        ].map((k) => [k, 0])
      ),
      publicServiceMethods: { latest: 0, page: 0, validate: 0 },
      signatureChecks: 1,
    },
  };
});
test('cold four-pass dedup boundaries and distinct in-range event blocks', () => {
  expect(
    expectedHeaders(wire.checkpoint, [...source.logs, ...wire.receipt.logs, wire.receipt.logs[0]])
  ).toBe(17);
  expect(assertBootstrap(value, wire, source).walletViewingLoans).toBe(0);
});
test.each([
  'extra owned query',
  'unclosed job',
  'key loan',
  'post',
  'worker',
  'wrong source passes',
  'unexpected page',
])('bootstrap %s is not a green restart', (name) => {
  if (name === 'extra owned query') value.roleMethods['private-account:poi:ppoi_pois_per_list'] = 1;
  if (name === 'unclosed job') value.audit.exits['railgun-txid-job.js'] = 2;
  if (name === 'key loan') value.keys.viewing = 1;
  if (name === 'post') value.chain.posts = 1;
  if (name === 'worker') value.storageWorkers.pending = 3;
  if (name === 'wrong source passes')
    value.roleMethods['private-account:protocol-rpc:eth_getBlockByNumber'] = 9;
  if (name === 'unexpected page') value.services.publicServiceMethods.page = 1;
  expect(() => assertBootstrap(value, wire, source)).toThrow();
});
