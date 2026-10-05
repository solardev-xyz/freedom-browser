/** Offline fixture instrumentation. All authorities and returned objects delegate
 * to production. Never import this fixture from production. */
const assert = require('assert/strict');
const walletPath = (name) => '../../src/main/wallet/' + name;
function installObservers({ onProved, onReceiver, onSubmitted }) {
  const names = [
    'railgun-kohaku-plugin',
    'railgun-private-operation',
    'railgun-private-receive',
    'railgun-private-submission',
  ];
  for (const name of names)
    assert.equal(require.cache[require.resolve(walletPath(name))], undefined, name);
  const counts = { prove: 0, receiver: 0, submit: 0 };
  const receive = require(walletPath('railgun-private-receive'));
  const originalReceive = receive.verifyRailgunPrivateReceiver;
  receive.verifyRailgunPrivateReceiver = async (options) => {
    counts.receiver++;
    const result = await originalReceive(options);
    onReceiver(options, result);
    return result;
  };
  assert.equal(require.cache[require.resolve(walletPath('railgun-private-operation'))], undefined);
  const operation = require(walletPath('railgun-private-operation'));
  const originalProve = operation.proveRailgunAccountPrivateOperation;
  operation.proveRailgunAccountPrivateOperation = async (options) => {
    counts.prove++;
    const result = await originalProve(options);
    try {
      await onProved(options, result);
    } catch (error) {
      result.completion?.close();
      throw error;
    }
    return result;
  };
  const submission = require(walletPath('railgun-private-submission'));
  const originalSubmit = submission.submitRailgunPrivateTransaction;
  submission.submitRailgunPrivateTransaction = async (options) => {
    counts.submit++;
    const result = await originalSubmit(options);
    onSubmitted(options, result);
    return result;
  };
  assert.equal(require.cache[require.resolve(walletPath('railgun-kohaku-plugin'))], undefined);
  return Object.freeze({
    counts,
    close() {
      receive.verifyRailgunPrivateReceiver = originalReceive;
      operation.proveRailgunAccountPrivateOperation = originalProve;
      submission.submitRailgunPrivateTransaction = originalSubmit;
    },
  });
}
function assertAmounts({ summary, stored, receiver, note, recipient, privateRecipient, amount }) {
  assert.ok(Object.isFrozen(summary));
  assert.equal(summary.operation, 'railgun-partial-unshield');
  assert.equal(summary.fullNote, false);
  assert.equal(summary.amount, amount.toString());
  const expected = {
    inputAmount: note.amount.toString(),
    unshieldAmount: amount.toString(),
    changeAmount: (note.amount - amount).toString(),
  };
  assert.ok(amount > 0n && amount < note.amount);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(summary[key], value);
    assert.equal(stored.capsule.preparation[key], value);
    assert.equal(receiver[key], value);
  }
  assert.equal(summary.recipient, recipient);
  assert.equal(summary.submitter, recipient);
  assert.equal(summary.entireInputConsumed, true);
  assert.equal(summary.changeRecipient, 'same-private-account');
  assert.equal(summary.unshieldAmountIncludesProtocolFee, true);
  assert.equal(summary.changeRequiresConfirmedScan, true);
  assert.equal(summary.changeSpendRequiresSeparatePoiSubmission, true);
  assert.match(summary.changePoiDisclosure, /separately reviewed combined POI/);
  assert.match(
    summary.changePoiDisclosure,
    /public unshield recipient and amount at the aggregator/
  );
  assert.match(summary.changePoiDisclosure, /does not publish it automatically/);
  assert.equal(stored.capsule.version, 2);
  assert.equal(stored.capsule.selection.kind, 'railgun-partial-unshield');
  assert.equal(stored.capsule.selection.recipient, recipient);
  assert.equal(stored.capsule.selection.unshieldAmount, amount.toString());
  assert.equal(receiver.recipient, privateRecipient);
  assert.equal(receiver.recipientVerified, true);
  assert.ok(stored.signature && stored.provedTransaction);
  const { validateRailgunPrivateSigningIntent, matchRailgunPrivateProvedTransaction } = require(
    walletPath('railgun-private-intent')
  );
  const intent = validateRailgunPrivateSigningIntent(
    stored.capsule.preparation.transaction,
    stored.capsule.preparation.expected
  );
  assert.equal(intent.kind, 'railgun-partial-unshield');
  assert.equal(intent.unshieldAmount, amount.toString());
  assert.equal(intent.digest, receiver.transactionDigest);
  matchRailgunPrivateProvedTransaction(
    stored.capsule.preparation.transaction,
    stored.provedTransaction,
    stored.capsule.preparation.expected
  );
}
function difference(before, after) {
  return Object.fromEntries(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .map((key) => [key, (after[key] || 0) - (before[key] || 0)])
      .filter(([, value]) => value !== 0)
  );
}
function assertCounts(before, after, expected) {
  for (const [category, values] of Object.entries(expected))
    assert.deepEqual(difference(before[category], after[category]), values, category);
}
// Source-derived admissions, not values learned/updated by an initial native run.
// A preparation is one A + receive + POI + B + C. Transact additionally stages
// three TXID jobs and one wallet job, then verifies creator provenance once.
function rpcPreflight(bad = false) {
  return {
    'protocol-rpc:shield-preflight:eth_chainId': 1,
    'protocol-rpc:shield-preflight:eth_getBlockByNumber': 2,
    'protocol-rpc:shield-preflight:eth_getCode': 4,
    'protocol-rpc:shield-preflight:eth_getStorageAt': 2,
    'protocol-rpc:shield-preflight:eth_call': 4,
    'protocol-rpc:private-preflight:eth_chainId': 1,
    'protocol-rpc:private-preflight:eth_call': bad ? 3 : 4,
    ...(bad ? {} : { 'protocol-rpc:private-preflight:eth_getBlockByNumber': 1 }),
  };
}
function rpcTransaction(methods) {
  return Object.fromEntries(
    Object.entries(methods).map(([key, value]) => ['transaction-rpc:none:' + key, value])
  );
}
function rpcLabel(subject, wire) {
  const operation = subject.operation?.startsWith('poi:')
    ? 'selected-poi'
    : subject.operation || 'none';
  return `${subject.role}:${operation}:${wire.method || 'graphql'}`;
}
function setupCounts(source, anchor, transact) {
  const ranges = [];
  for (let from = 0; from <= anchor.number; from += 100000) {
    const to = Math.min(from + 99999, anchor.number);
    ranges.push({
      from,
      to,
      canonical: 1 + new Set([anchor.number, from, to, ...(from ? [from - 1] : [])]).size,
    });
  }
  const first = ranges[0].canonical,
    last = ranges.at(-1).canonical;
  // Each range: two acquire passes + post-apply refresh. Every successor also
  // refreshes the previous range; publish and initial wallet each refresh twice.
  const eventBlocks = new Set(source.logs.map((log) => log.blockNumber)).size;
  const headers =
    4 * ranges.reduce((n, v) => n + v.canonical, 0) - last + eventBlocks + 2 * first + 2 * last;
  return {
    jobs: {
      'railgun-identity-job.js': 2,
      'railgun-public-job.js': ranges.length + 1,
      'railgun-wallet-job.js': 1,
      'railgun-partial-controller-poi-input-job.js': 1,
      ...(transact ? { 'railgun-transact-staging-row.js': 1, 'railgun-txid-job.js': 6 } : {}),
    },
    keys: { 'spending-public': 1, 'viewing-identity': 1, 'wallet-viewing': 1 },
    workers: { started: transact ? 8 : 6, exited: transact ? 5 : 3 },
    eoa: { addressAttempts: 1 },
    methods: {},
    rpcCounts: {
      'protocol-rpc:none:eth_chainId': 1,
      'protocol-rpc:none:eth_getBlockByNumber': headers,
      'protocol-rpc:none:eth_getLogs': ranges.length,
      ...(transact
        ? {
            'poi:none:ppoi_validated_txid': 3,
            'poi:none:ppoi_validate_txid_merkleroot': 2,
            'indexer:none:graphql': 1,
          }
        : {}),
    },
  };
}
function prepareCounts(transact) {
  const methods = { eth_chainId: 1, eth_getCode: 1, eth_getBalance: 1 };
  return {
    jobs: {
      'railgun-private-operate-job.js': 1,
      'railgun-private-receive-job.js': 1,
      'railgun-poi-job.js': 1,
      'railgun-spend-sign-job.js': 1,
      'railgun-private-verify-job.js': 1,
      ...(transact
        ? {
            'railgun-txid-job.js': 3,
            'railgun-wallet-job.js': 1,
            'railgun-note-provenance-job.js': 1,
          }
        : {}),
    },
    keys: {
      'private-operate': 1,
      'private-receive': 1,
      'spending-sign': 1,
      ...(transact ? { 'wallet-viewing': 1 } : {}),
    },
    methods,
    eoa: { addressAttempts: 2 },
    workers: transact ? { started: 2, exited: 2 } : {},
    rpcCounts: {
      ...rpcPreflight(),
      ...rpcTransaction(methods),
      'poi:selected-poi:ppoi_pois_per_list': 1,
      'poi:selected-poi:ppoi_merkle_proofs': 1,
      'poi:selected-poi:ppoi_poi_events': 1,
      'poi:selected-poi:ppoi_validate_poi_merkleroots': 1,
      'protocol-rpc:none:eth_getBlockByNumber': transact ? 16 : 8,
      ...(transact
        ? {
            'poi:none:ppoi_validated_txid': 3,
            'poi:none:ppoi_validate_txid_merkleroot': 3,
          }
        : {}),
    },
  };
}
function submitCounts(testCase) {
  const bad = testCase === 'bad-verifier';
  const cancelled = testCase === 'transaction-review-close';
  const methods = bad
    ? {}
    : {
        eth_chainId: 1,
        eth_getCode: 1,
        eth_getBalance: 1,
        eth_estimateGas: 1,
        eth_call: 1,
        eth_gasPrice: 1,
        eth_getTransactionCount: 3,
        ...(cancelled ? {} : { eth_sendRawTransaction: 1 }),
      };
  return {
    jobs: { 'railgun-private-verify-job.js': 1 },
    keys: {},
    methods,
    workers: { exited: 1 },
    eoa: bad
      ? { addressAttempts: 1 }
      : {
          addressAttempts: 2,
          reviews: 1,
          ...(cancelled
            ? {}
            : {
                signatureAttempts: 1,
                signatures: 1,
                sends: 1,
                journalBeforeSend: 1,
                ...(testCase === 'lost-response' ? { controlledLostAcknowledgments: 1 } : {}),
              }),
        },
    rpcCounts: { ...rpcPreflight(bad), ...rpcTransaction(methods) },
  };
}
// Source expansion: standalone observe = O, reversed resolve = R+O,
// successful resolve = R+O+F+O+F(previous)+R. R reads receipt/header/head;
// O adds transaction/receipt; F reads 3 (then 4) headers and one head.
function recoveryCounts(bad) {
  const methods = bad
    ? {}
    : {
        eth_chainId: 1,
        eth_getTransactionReceipt: 11,
        eth_getBlockByNumber: 14,
        eth_blockNumber: 9,
        eth_getTransactionByHash: 4,
      };
  return {
    jobs: {},
    keys: {},
    methods,
    eoa: {},
    workers: bad ? {} : { exited: 2 },
    rpcCounts: rpcTransaction(methods),
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}
async function heldClose({
  plugin,
  entered,
  release,
  pending,
  owners,
  closeAccount,
  bounded,
  snapshot,
  runs,
  name,
}) {
  await bounded(entered.promise);
  const before = snapshot();
  let drained = false;
  plugin.closed.then(() => (drained = true));
  try {
    plugin.close();
    await bounded(closeAccount());
    // Real account handoff/recovery exclusion, not only the facade's own map.
    const { claimRailgunAccountPhase } = require(walletPath('railgun-account-phase'));
    let acquired;
    try {
      assert.throws(() => (acquired = claimRailgunAccountPhase(owners.enrollment, 'recovery')));
    } finally {
      acquired?.release();
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(drained, false);
    assertCounts(before, snapshot(), {
      jobs: {},
      keys: {},
      methods: {},
      rpcCounts: {},
    });
  } finally {
    release.resolve(true);
  }
  await bounded(Promise.allSettled([pending]));
  await bounded(plugin.closed);
  assert.equal(drained, true);
  assertCounts(before, snapshot(), {
    jobs: {},
    keys: {},
    methods: {},
    rpcCounts: {},
  });
  runs.push({
    mode: name,
    originalReviewSettled: true,
    adoptedAccountClosedBeforeHeldPhaseProbe: true,
    closedHeldUntilOriginalReview: true,
    realAccountPhaseExcluded: true,
    noLateJobKeyOrRpc: true,
    noLateEoaSignatureOrSend: snapshot().eoa.sends === 0 && snapshot().eoa.signatures === 0,
    logicalDrainOnly: true,
  });
}
module.exports = {
  installObservers,
  assertAmounts,
  assertCounts,
  recoveryCounts,
  setupCounts,
  prepareCounts,
  submitCounts,
  rpcLabel,
  deferred,
  heldClose,
};
