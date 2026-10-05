/** Exact chosen-entry maps, derived in COUNTERS-AND-HANDOFF.md; not native evidence. */
const { assert } = require('./railgun-native-assertions');
function canonical(range) {
  return (
    1 +
    new Set([range.anchor.number, range.from, range.to, ...(range.from ? [range.from - 1] : [])])
      .size
  );
}
function expected(phase, baseline, next, events) {
  const source = {
    eth_chainId: 1,
    eth_getLogs: phase === 'resolve' ? 2 : 1,
    eth_getBlockByNumber:
      phase === 'setup'
        ? 11 * canonical(baseline) + events
        : phase === 'resolve'
          ? 3 * canonical(baseline) + 5 * canonical(next) + events + 1
          : 4 * canonical(next) + 1,
  };
  const deployment =
    phase === 'setup'
      ? {
          eth_chainId: 1,
          eth_getBlockByNumber: 2,
          eth_getCode: 4,
          eth_getStorageAt: 2,
          eth_call: 4,
        }
      : {};
  const transaction =
    phase === 'setup'
      ? {
          eth_chainId: 1,
          eth_getCode: 1,
          eth_estimateGas: 1,
          eth_call: 1,
          eth_gasPrice: 1,
          eth_getTransactionCount: 3,
          eth_getBalance: 1,
          eth_sendRawTransaction: 1,
        }
      : phase === 'resolve'
        ? {
            eth_chainId: 1,
            eth_getTransactionReceipt: 12,
            eth_getTransactionByHash: 5,
            eth_getBlockByNumber: 14,
            eth_blockNumber: 9,
          }
        : {};
  const jobs = {
    'railgun-identity-job': 2,
    'railgun-public-job:plan': phase === 'resolve' ? 2 : 1,
    ...(phase === 'restore' ? {} : { 'railgun-public-job:apply': 1 }),
    'railgun-wallet-job': phase === 'setup' ? 2 : 1,
    ...(phase === 'setup' ? { 'railgun-shield-job': 1, 'railgun-shield-receive-job': 1 } : {}),
  };
  return {
    source,
    deployment,
    transaction,
    jobs,
    keyPurposes: {
      'spending-public': 1,
      'viewing-identity': 1,
      'wallet-viewing': phase === 'setup' ? 2 : 1,
      ...(phase === 'setup' ? { 'shield-receive': 1 } : {}),
    },
    workerKinds:
      phase === 'setup'
        ? {
            'source.initialize': 1,
            'source.open': 1,
            'public.initialize': 1,
            'public.open': 1,
            'wallet.initialize': 1,
            'wallet.open': 2,
          }
        : {
            'source.open': 1,
            'public.open': 1,
            [phase === 'restore' ? 'wallet.readOnly' : 'wallet.open']: 1,
          },
    workers: phase === 'setup' ? 7 : 3,
    viewing: phase === 'setup' ? 3 : 1,
    eoaSigns: phase === 'setup' ? 1 : 0,
  };
}
function assertCounts(actual, wanted) {
  assert.deepEqual(actual.attempted, {
    source: wanted.source,
    deployment: wanted.deployment,
    transaction: wanted.transaction,
  });
  assert.deepEqual(actual.validated, actual.attempted);
  assert.deepEqual(actual.jobs, wanted.jobs);
  assert.deepEqual(actual.keyPurposes, wanted.keyPurposes);
  assert.equal(actual.workers, wanted.workers);
  assert.deepEqual(actual.workerKinds, wanted.workerKinds);
  assert.equal(actual.viewing, wanted.viewing);
  assert.equal(actual.eoaSigns, wanted.eoaSigns);
  assert.equal(actual.credentialBuffersWiped, true);
  assert.equal(actual.unexpected, 0);
}
module.exports = { canonical, expected, assertCounts };
