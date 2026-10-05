/** Same-process fixture observer only. Real plugin/controller/store authorities
 * remain intact. No operation token or returned private data is serialized. */
const { assert } = require('./railgun-native-assertions');
const tools = require('./railgun-kohaku-partial-native');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
function counts(second, transact) {
  const prepare = tools.prepareCounts(transact),
    submit = tools.submitCounts('acknowledged');
  if (second) {
    delete prepare.jobs['railgun-private-receive-job.js'];
    delete prepare.keys['private-receive'];
    for (const [phase, n] of [
      [prepare, 1],
      [submit, 3],
    ]) {
      phase.methods.eth_blockNumber = n;
      phase.methods.eth_getBlockByNumber = n;
      phase.rpcCounts['transaction-rpc:none:eth_blockNumber'] = n;
      phase.rpcCounts['transaction-rpc:none:eth_getBlockByNumber'] = n;
    }
  }
  return { prepare, submit };
}
function install() {
  let active,
    firstToken,
    firstPlugin,
    instances = 0;
  const observed = { prove: 0, receiver: 0, submit: 0 };
  const observers = tools.installObservers({
    onReceiver(options, result) {
      assert.ok(active && !active.second);
      assert.equal(options.recipient, active.h.identity.descriptor.instanceId);
      active.receiver = result;
      active.seen.receiver++;
      observed.receiver++;
    },
    async onProved(options, result) {
      assert.ok(active);
      const { h, request } = active;
      assert.deepEqual(options.request, request);
      assert.equal(options.owners.identity, h.identity);
      assert.equal(options.owners.enrollment, h.enrollment);
      assert.equal(options.owners.coordinator, h.coordinator);
      assert.equal(result.status, 'proved');
      active.seen.prove++;
      observed.prove++;
      assert.equal(active.seen.prove, 1);
      active.stored = await h.capsules.get(result.holdId);
      const { capsule } = active.stored;
      assert.equal(capsule.noteHash, h.note.hash);
      assert.equal(capsule.selection.kind, request.kind);
      assert.equal(capsule.preparation.expected.nullifier, h.record.nullifier);
      if (active.second) {
        assert.equal(capsule.version, 1);
        assert.equal(capsule.preparation.expected.amount, h.note.amount.toString());
        require('../../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
          capsule.preparation.transaction,
          active.stored.provedTransaction,
          capsule.preparation.expected
        );
        assert.equal(active.receiver, undefined);
      } else
        tools.assertAmounts({
          summary: active.summary,
          stored: active.stored,
          receiver: active.receiver,
          note: h.note,
          recipient: h.recipient,
          privateRecipient: h.identity.descriptor.instanceId,
          amount: h.amount,
        });
      h.onStored(active.stored);
    },
    onSubmitted(options, result) {
      assert.ok(active);
      assert.equal(options.identity, active.h.identity);
      assert.equal(options.enrollment, active.h.enrollment);
      active.seen.submit++;
      observed.submit++;
      assert.equal(active.seen.submit, 1);
      active.submitted = result;
    },
  });
  async function run(h, second) {
    assert.equal(active, undefined);
    assert.equal(instances, second ? 1 : 0);
    if (second) {
      assert.ok(firstPlugin && firstPlugin.signal.aborted);
      assert.equal(h.record.type, 'Transact');
      assert.equal(h.amount, h.note.amount);
    } else assert.ok(h.amount > 0n && h.amount < h.note.amount);
    const request = Object.freeze({
      kind: second ? 'railgun-token-unshield' : 'railgun-partial-unshield',
      noteId: h.record.id,
      recipient: h.recipient,
      ...(!second ? { unshieldAmount: h.amount.toString() } : {}),
    });
    const state = { h, second, request, seen: { prove: 0, receiver: 0, submit: 0 } };
    active = state;
    let plugin,
      token,
      preparationReviews = 0,
      transactionReviews = 0;
    const expected = counts(second, h.record.type === 'Transact');
    const before = h.measure();
    try {
      const { createRailgunKohakuPlugin } = require('../../src/main/wallet/railgun-kohaku-plugin');
      plugin = createRailgunKohakuPlugin({
        account: h.account,
        owners: { identity: h.identity, enrollment: h.enrollment, coordinator: h.coordinator },
        mode: 'private',
        signal: h.enrollment.signal,
        archive: h.archive,
        proverArchive: h.proverArchive,
        artifactDirectory: h.artifactDirectory,
        gasLimit: 1500000n,
        maxGasFee: 2000000000000000n,
        reviewPreparation: async (summary, lifetime) => {
          assert.equal(lifetime.signal.aborted, false);
          assert.equal(++preparationReviews, 1);
          assert.ok(Object.isFrozen(summary));
          assert.equal(summary.operation, request.kind);
          assert.equal(summary.inputType, h.record.type);
          assert.equal(summary.selection.noteId, h.record.id);
          assert.equal(summary.fullNote, second);
          assert.equal(summary.amount, h.amount.toString());
          assert.equal(summary.submitter, h.recipient);
          assert.equal(summary.recipient, h.recipient);
          for (const name of ['retainedSource', 'protocolRpc', 'transactionRpc'])
            assert.equal(
              summary.destinations[name],
              'https://synthetic.invalid/railgun-partial-controller'
            );
          if (second)
            for (const key of [
              'inputAmount',
              'unshieldAmount',
              'changeAmount',
              'changePoiDisclosure',
            ])
              assert.equal(Object.hasOwn(summary, key), false);
          else {
            assert.equal(summary.inputAmount, h.note.amount.toString());
            assert.equal(summary.unshieldAmount, h.amount.toString());
            assert.equal(summary.changeAmount, (h.note.amount - h.amount).toString());
            assert.equal(summary.changeSpendRequiresSeparatePoiSubmission, true);
          }
          tools.assertCounts(before, h.measure(), {
            jobs: {},
            keys: {},
            methods: {},
            rpcCounts: {},
            workers: {},
            eoa: { addressAttempts: 1 },
          });
          state.summary = summary;
          return true;
        },
        reviewTransaction: async (summary) => {
          assert.equal(++transactionReviews, 1);
          assert.equal(summary.operation, request.kind);
          assert.equal(summary.transaction.data, state.stored.provedTransaction.data);
          assert.equal(summary.from.toLowerCase(), h.recipient);
          assert.ok(Date.now() < summary.expiresAt);
          h.recordReview();
          return true;
        },
      });
      instances++;
      if (second) assert.notEqual(plugin, firstPlugin);
      token = await plugin.prepareUnshield(
        {
          asset: { __type: 'erc20', contract: pins.wrappedNative },
          amount: h.amount,
          noteId: h.record.id,
        },
        h.recipient
      );
      assert.equal(preparationReviews, 1);
      assert.deepEqual(state.seen, { prove: 1, receiver: second ? 0 : 1, submit: 0 });
      tools.assertCounts(before, h.measure(), expected.prepare);
      const broadcaster =
        require('../../src/main/wallet/railgun-kohaku-broadcaster').createRailgunKohakuBroadcaster(
          plugin
        );
      for (const invalid of [
        { ...token },
        Object.freeze({ __type: 'privateOperation' }),
        ...(second ? [firstToken] : []),
      ]) {
        const snapshot = h.measure();
        await assert.rejects(broadcaster.broadcast(invalid));
        assert.deepEqual(h.measure(), snapshot);
      }
      const beforeSubmit = h.measure();
      const submitted = await broadcaster.broadcast(token);
      assert.equal(submitted, state.submitted);
      assert.equal(transactionReviews, 1);
      assert.deepEqual(state.seen, { prove: 1, receiver: second ? 0 : 1, submit: 1 });
      plugin.close();
      await plugin.closed;
      tools.assertCounts(beforeSubmit, h.measure(), expected.submit);
      const snapshot = h.measure();
      await assert.rejects(broadcaster.broadcast(token));
      assert.deepEqual(h.measure(), snapshot);
      if (!second) {
        firstToken = token;
        firstPlugin = plugin;
      }
      return {
        stored: state.stored,
        submitted,
        report: {
          newPluginInstance: true,
          firstInstanceDrained: second,
          preparationReviews,
          transactionReviews,
          copiedAndUnregisteredTokenRefused: true,
          previousConsumedInstanceTokenRefused: second,
          consumedTokenRefused: true,
          observers: { ...state.seen },
          preparedCounts: expected.prepare,
          submissionCounts: expected.submit,
        },
      };
    } finally {
      try {
        if (plugin) {
          plugin.close();
          await plugin.closed;
        } else await h.account.close();
      } finally {
        active = undefined;
      }
    }
  }
  return Object.freeze({
    first: (h) => run(h, false),
    second: (h) => run(h, true),
    report: () => ({ instances, ...observed }),
    close() {
      assert.equal(active, undefined);
      observers.close();
    },
  });
}
function accountOpenCounts() {
  return {
    jobs: { 'railgun-wallet-job.js': 1 },
    keys: { 'wallet-viewing': 1 },
    methods: {},
    eoa: {},
    workers: { started: 1 },
    rpcCounts: { 'protocol-rpc:none:eth_getBlockByNumber': 8 },
  };
}
// O + R + O + F + O + F(previous) + R. O = receipt2/header1/head1/tx1;
// R = receipt1/header1/head1; F headers3/head1, previous F headers4/head1.
function resolutionAndCaptureCounts() {
  const methods = {
    eth_chainId: 1,
    eth_getTransactionReceipt: 8,
    eth_getBlockByNumber: 12,
    eth_blockNumber: 7,
    eth_getTransactionByHash: 3,
  };
  return {
    jobs: {},
    keys: {},
    workers: {},
    eoa: {},
    methods,
    rpcCounts: Object.fromEntries(
      Object.entries(methods).map(([k, v]) => ['transaction-rpc:none:' + k, v])
    ),
  };
}
module.exports = { install, counts, accountOpenCounts, resolutionAndCaptureCounts };
