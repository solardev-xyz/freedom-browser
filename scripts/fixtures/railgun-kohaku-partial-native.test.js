/** Fixture assertion tests only; structural data and controlled import loader.
 * These do not establish native proof validity or genuine issuer authority. */
const fs = require('fs');
const vm = require('vm');
const {
  assertAmounts,
  assertCounts,
  prepareCounts,
  submitCounts,
  rpcLabel,
} = require('./railgun-kohaku-partial-native');
const { createRailgunPartialCapsuleData } = require('./railgun-partial-capsule-data');
const {
  validateRailgunPrivateSigningIntent,
} = require('../../src/main/wallet/railgun-private-intent');
function amounts() {
  const { capsule } = createRailgunPartialCapsuleData({
    inputAmount: '1000',
    unshieldAmount: '1',
  });
  const note = { amount: 1000n };
  const recipient = capsule.selection.recipient;
  const privateRecipient = 'fixture-private-recipient';
  const values = {
    inputAmount: '1000',
    unshieldAmount: '1',
    changeAmount: '999',
  };
  const summary = Object.freeze({
    ...values,
    operation: 'railgun-partial-unshield',
    fullNote: false,
    amount: '1',
    recipient,
    submitter: recipient,
    entireInputConsumed: true,
    changeRecipient: 'same-private-account',
    unshieldAmountIncludesProtocolFee: true,
    changeRequiresConfirmedScan: true,
    changeSpendRequiresSeparatePoiSubmission: true,
    changePoiDisclosure:
      'separately reviewed combined POI links public unshield recipient and amount at the aggregator; does not publish it automatically',
  });
  const receiver = {
    ...values,
    recipient: privateRecipient,
    recipientVerified: true,
    transactionDigest: validateRailgunPrivateSigningIntent(
      capsule.preparation.transaction,
      capsule.preparation.expected
    ).digest,
  };
  return {
    summary,
    stored: {
      capsule,
      signature: {},
      provedTransaction: capsule.preparation.transaction,
    },
    receiver,
    note,
    recipient,
    privateRecipient,
    amount: 1n,
  };
}
it('joins source note, real normalized original calldata, receiver and frozen summary at U1', () => {
  expect(() => assertAmounts(amounts())).not.toThrow();
});
it.each(['inputAmount', 'unshieldAmount', 'changeAmount'])(
  'refuses %s drift in any of the three compared representations',
  (key) => {
    for (const side of ['summary', 'receiver', 'capsule']) {
      const v = amounts();
      if (side === 'capsule')
        v.stored = {
          ...v.stored,
          capsule: {
            ...v.stored.capsule,
            preparation: { ...v.stored.capsule.preparation, [key]: '2' },
          },
        };
      else v[side] = Object.freeze({ ...v[side], [key]: '2' });
      expect(() => assertAmounts(v)).toThrow();
    }
  }
);
it.each(['recipient', 'recipientVerified', 'transactionDigest'])(
  'rejects receiver %s substitution',
  (key) => {
    const v = amounts();
    v.receiver = { ...v.receiver, [key]: false };
    expect(() => assertAmounts(v)).toThrow();
  }
);
it('refuses mutable review and missing independent receiver (nonvacuous join)', () => {
  const v = amounts();
  expect(() => assertAmounts({ ...v, summary: { ...v.summary } })).toThrow();
  expect(() => assertAmounts({ ...v, receiver: undefined })).toThrow();
});
it('refuses public recipient and explicit future POI linkage omissions', () => {
  const v = amounts();
  expect(() => assertAmounts({ ...v, recipient: '0x' + '33'.repeat(20) })).toThrow();
  expect(() =>
    assertAmounts({
      ...v,
      summary: Object.freeze({
        ...v.summary,
        changeSpendRequiresSeparatePoiSubmission: false,
      }),
    })
  ).toThrow();
});
it.each([false, true])(
  'fixed preparation admission contract detects extra/omitted activity (%s)',
  (transact) => {
    const expected = prepareCounts(transact);
    const before = Object.fromEntries(Object.keys(expected).map((k) => [k, {}]));
    expect(() => assertCounts(before, expected, expected)).not.toThrow();
    for (const category of Object.keys(expected)) {
      const after = structuredClone(expected);
      after[category].unexpected = 1;
      expect(() => assertCounts(before, after, expected)).toThrow();
    }
    const after = structuredClone(expected);
    delete after.jobs['railgun-private-receive-job.js'];
    expect(() => assertCounts(before, after, expected)).toThrow();
  }
);
it.each(['acknowledged', 'lost-response', 'bad-verifier', 'transaction-review-close'])(
  'submission count contract bounds %s before execution',
  (testCase) => {
    const expected = submitCounts(testCase);
    expect(expected.jobs).toEqual({ 'railgun-private-verify-job.js': 1 });
    expect(expected.keys).toEqual({});
    expect(expected.methods.eth_sendRawTransaction || 0).toBe(
      ['acknowledged', 'lost-response'].includes(testCase) ? 1 : 0
    );
    expect(expected.rpcCounts['protocol-rpc:private-preflight:eth_call']).toBe(
      testCase === 'bad-verifier' ? 3 : 4
    );
  }
);
it('RPC labels omit dynamic account/POI identifiers but retain role/method categories', () => {
  expect(
    rpcLabel({ role: 'poi', operation: 'poi:' + 'f'.repeat(64) }, { method: 'ppoi_merkle_proofs' })
  ).toBe('poi:selected-poi:ppoi_merkle_proofs');
  expect(rpcLabel({ role: 'indexer', operation: null }, {})).toBe('indexer:none:graphql');
});
function observerFixture(preloaded) {
  const cache = {};
  const calls = [];
  const results = {
    receive: { verified: true },
    prove: { status: 'proved' },
    submit: { hash: 'fixture' },
  };
  const modules = {};
  const fakeRequire = (name) => {
    if (name === 'assert/strict') return require(name);
    calls.push(name);
    if (modules[name]) return modules[name];
    let exports;
    if (name.endsWith('railgun-private-receive'))
      exports = {
        verifyRailgunPrivateReceiver: async (options) => {
          calls.push(options);
          return results.receive;
        },
      };
    if (name.endsWith('railgun-private-operation')) {
      const receiver = fakeRequire(
        '../../src/main/wallet/railgun-private-receive'
      ).verifyRailgunPrivateReceiver;
      exports = {
        proveRailgunAccountPrivateOperation: async (options) => {
          await receiver(options);
          return results.prove;
        },
      };
    }
    if (name.endsWith('railgun-private-submission'))
      exports = {
        submitRailgunPrivateTransaction: async (options) => {
          calls.push(options);
          return results.submit;
        },
      };
    if (!exports) throw Error('Unexpected import');
    cache[name] = { exports };
    modules[name] = exports;
    return exports;
  };
  fakeRequire.resolve = (name) => name;
  fakeRequire.cache = cache;
  if (preloaded) cache['../../src/main/wallet/' + preloaded] = { exports: {} };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./railgun-kohaku-partial-native'), 'utf8'), {
    require: fakeRequire,
    module,
  });
  return { api: module.exports, modules, calls, results };
}
it.each([
  'railgun-kohaku-plugin',
  'railgun-private-operation',
  'railgun-private-receive',
  'railgun-private-submission',
])('rejects preloaded %s before installing wrappers', (name) => {
  const { api, calls } = observerFixture(name);
  expect(() => api.installObservers({})).toThrow();
  expect(calls).toEqual([]);
});
it('receiver wrapper precedes captured operation import; exact results and option identity preserved', async () => {
  const { api, modules, results } = observerFixture();
  const seen = [];
  const observer = api.installObservers({
    onReceiver: (...v) => seen.push(v),
    onProved: (...v) => seen.push(v),
    onSubmitted: (...v) => seen.push(v),
  });
  const options = { fixture: true };
  expect(
    await modules[
      '../../src/main/wallet/railgun-private-operation'
    ].proveRailgunAccountPrivateOperation(options)
  ).toBe(results.prove);
  expect(
    await modules[
      '../../src/main/wallet/railgun-private-submission'
    ].submitRailgunPrivateTransaction(options)
  ).toBe(results.submit);
  expect(observer.counts).toEqual({ prove: 1, receiver: 1, submit: 1 });
  expect(seen).toEqual([
    [options, results.receive],
    [options, results.prove],
    [options, results.submit],
  ]);
  observer.close();
  await modules['../../src/main/wallet/railgun-private-submission'].submitRailgunPrivateTransaction(
    options
  );
  expect(observer.counts.submit).toBe(1);
});
it('predicts setup canonical passes from ranges and unique event blocks, not a learned report', () => {
  const { setupCounts } = require('./railgun-kohaku-partial-native');
  const value = setupCounts(
    {
      logs: [
        { blockNumber: 5944710 },
        { blockNumber: 5944720 },
        { blockNumber: 5944730 },
        { blockNumber: 5944730 },
      ],
    },
    { number: 5944800 },
    false
  );
  expect(value.jobs['railgun-public-job.js']).toBe(61);
  expect(value.rpcCounts['protocol-rpc:none:eth_getLogs']).toBe(60);
  expect(value.rpcCounts['protocol-rpc:none:eth_getBlockByNumber']).toBe(1207);
  expect(value.workers).toEqual({ started: 6, exited: 3 });
});
it('predicts inherited observe/reversed/healthy resolution calls without a send or key', () => {
  const { recoveryCounts } = require('./railgun-kohaku-partial-native');
  expect(recoveryCounts(false).methods).toEqual({
    eth_chainId: 1,
    eth_getTransactionReceipt: 11,
    eth_getBlockByNumber: 14,
    eth_blockNumber: 9,
    eth_getTransactionByHash: 4,
  });
  expect(recoveryCounts(true)).toEqual({
    jobs: {},
    keys: {},
    methods: {},
    eoa: {},
    workers: {},
    rpcCounts: {},
  });
});
it.each([false, true])(
  'held-review assertion releases its gate even on premature closed failure (%s)',
  async (premature) => {
    // This mock tests fixture control/drain assertions, not real phase authority.
    jest.doMock('../../src/main/wallet/railgun-account-phase', () => ({
      claimRailgunAccountPhase: () => {
        throw Error('busy');
      },
    }));
    const { heldClose, deferred } = require('./railgun-kohaku-partial-native');
    const entered = deferred(),
      release = deferred(),
      drain = deferred();
    const pending = release.promise.then(() => drain.resolve());
    const closeAccount = jest.fn(async () => {});
    const plugin = { closed: drain.promise, close: jest.fn() };
    const snapshot = () => ({
      jobs: {},
      keys: {},
      methods: {},
      rpcCounts: {},
      eoa: { sends: 0, signatures: 0 },
    });
    entered.resolve();
    if (premature) drain.resolve();
    const runs = [];
    const call = heldClose({
      plugin,
      entered,
      release,
      pending,
      owners: { enrollment: {} },
      closeAccount,
      bounded: (v) => v,
      snapshot,
      runs,
      name: 'fixture-only',
    });
    if (premature) await expect(call).rejects.toThrow();
    else await call;
    await pending;
    await plugin.closed;
    expect(closeAccount).toHaveBeenCalledTimes(1);
    expect(runs.length).toBe(premature ? 0 : 1);
    jest.dontMock('../../src/main/wallet/railgun-account-phase');
  }
);
