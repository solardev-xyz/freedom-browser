/** Offline fixture only. Actual submission service, vault EOA signer and journal;
 * replaces only RPC acquisition. Never load with a funded/live profile.
 */
const assert = require('assert/strict');
const { Transaction } = require('ethers');
const {
  getPrivacyContext,
  createPrivacyScope,
} = require('../../src/main/networks/privacy-context');
let used = false;
exports.qualify = async function qualify({
  identity,
  enrollment,
  completion,
  proverArchive,
  artifactDirectory,
  owner,
  expected,
  networkModule,
  readGateCounters,
}) {
  assert.equal(used, false);
  used = true;
  const uncertain = process.env.FREEDOM_RAILGUN_SIMULATE_LOST_ACK === '1';
  let active = true,
    sends = 0,
    reviews = 0,
    journalBeforeTransport = false,
    sentHash;
  const current = () => assert.equal(active, true);
  const rpc = require('../../src/main/networks/private-rpc');
  const originalRpc = rpc.createPrivateRpc;
  const originalNetwork = networkModule.getPrivateTransactionNetwork;
  const signerModule = require('../../src/main/wallet/signers');
  const originalSigner = signerModule.getSigner;
  const activity = {
    contexts: 0,
    requests: 0,
    checks: 0,
    signerFactories: 0,
    addressReads: 0,
    signatures: 0,
  };
  const methods = Object.create(null);
  const responses = Object.freeze({
    eth_getCode: '0x',
    eth_getBalance: '0x100000000000000',
    eth_getTransactionCount: '0x0',
    eth_gasPrice: '0x64',
    eth_estimateGas: '0x100000',
    eth_call: '0x',
  });
  const unexpectedRpcAttempts = () =>
    Object.entries(methods).reduce(
      (sum, [method, count]) =>
        sum + (method === 'eth_sendRawTransaction' || Object.hasOwn(responses, method) ? 0 : count),
      0
    );
  const snapshot = () => ({
    ...activity,
    methods: { ...methods },
    sends,
    reviews,
    gates: readGateCounters(),
  });
  const names = [
    'private-transaction-network',
    'railgun-private-submission',
    'railgun-transact-recovery',
  ];
  const cached = names.map((name) => {
    const filename = require.resolve('../../src/main/wallet/' + name);
    return [filename, require.cache[filename]];
  });
  let sourceHandle;
  try {
    // Both controllers must capture this fixture's bounded sources, never a
    // previously loaded instance with different network/preflight closures.
    for (const [, entry] of cached.slice(1)) assert.equal(entry, undefined);
    signerModule.getSigner = (index) => {
      activity.signerFactories++;
      current();
      assert.equal(index, 0);
      const signer = originalSigner(index);
      return Object.freeze({
        async getAddress() {
          activity.addressReads++;
          current();
          return signer.getAddress();
        },
        async signTransaction(transaction) {
          activity.signatures++;
          current();
          assert.equal(activity.signatures, 1);
          return signer.signTransaction(transaction);
        },
      });
    };
    rpc.createPrivateRpc = (handle, role) => {
      activity.contexts++;
      current();
      const context = getPrivacyContext(handle);
      assert.equal(role, 'transaction-rpc');
      assert.equal(context.subject.principal, owner);
      assert.equal(context.subject.chainId, 11155111);
      assert.equal(context.profileId, getPrivacyContext(enrollment.getContext('engine')).profileId);
      sourceHandle = handle;
      const assertActive = () => {
        activity.checks++;
        current();
        getPrivacyContext(handle);
      };
      return Object.freeze({
        signal: context.signal,
        assertActive,
        ready: async () => assertActive(),
        request: async (method, params, validate) => {
          activity.requests++;
          methods[method] = (methods[method] ?? 0) + 1;
          if (method === 'eth_sendRawTransaction') sends++;
          assertActive();
          let result;
          if (method === 'eth_sendRawTransaction') {
            assert.equal(sends, 1);
            const transaction = Transaction.from(params[0]);
            assert.equal(transaction.from.toLowerCase(), owner);
            assert.equal(transaction.chainId, 11155111n);
            const journal =
              require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
                handle
              );
            const records = await journal.list();
            assert.equal(records.length, 1);
            assert.equal(records[0].hash, transaction.hash.toLowerCase());
            assert.deepEqual(
              records[0].intent,
              require('../../src/main/wallet/railgun-transact-intent').railgunTransactJournalIntent(
                transaction
              )
            );
            assert.equal(records[0].intent.intentDigest, expected);
            assert.equal(records[0].state, 'attempted');
            journalBeforeTransport = true;
            sentHash = transaction.hash.toLowerCase();
            if (uncertain) throw Error('Simulated transport lost acknowledgment');
            result = sentHash;
          } else {
            assert.ok(Object.hasOwn(responses, method), method);
            result = responses[method];
          }
          assert.equal(validate(result), true);
          return { result, source: 'simulated' };
        },
      });
    };
    delete require.cache[cached[0][0]];
    const actualNetwork = require('../../src/main/wallet/private-transaction-network');
    rpc.createPrivateRpc = originalRpc;
    networkModule.getPrivateTransactionNetwork = actualNetwork.getPrivateTransactionNetwork;
    const {
      submitRailgunPrivateTransaction: submit,
    } = require('../../src/main/wallet/railgun-private-submission');
    const options = {
      identity,
      enrollment,
      completion,
      proverArchive,
      artifactDirectory,
      gasLimit: 1500000n,
      maxGasFee: 2000000000000000n,
      review: async (request) => {
        current();
        reviews++;
        assert.equal(request.from.toLowerCase(), owner);
        assert.equal(request.intent.intentDigest, expected);
        return true;
      },
    };
    const result = await submit(options);
    // An unsupported call caught inside production must still fail qualification.
    assert.equal(unexpectedRpcAttempts(), 0);
    assert.ok(sentHash);
    if (uncertain) {
      assert.equal(result.transactionHash, sentHash);
      assert.equal(result.submissionStatus, 'unknown');
    } else assert.equal(result.hash?.toLowerCase(), sentHash);
    assert.equal(sends, 1);
    assert.equal(activity.signatures, 1);
    assert.equal(reviews, 1);
    assert.equal(journalBeforeTransport, true);
    assert.ok(sourceHandle);
    const beforeReuse = snapshot();
    assert.deepEqual(await submit(options), { status: 'recovery-required', stage: 'completion' });
    assert.deepEqual(snapshot(), beforeReuse);
    const reopened = createPrivacyScope({
      profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
      signal: AbortSignal.any([identity.signal, enrollment.signal]),
    });
    try {
      const handle = reopened.getContext({
        kind: 'public-address',
        principal: owner,
        chainId: 11155111,
        role: 'transaction-rpc',
      });
      const journal =
        require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
          handle
        );
      const records = await journal.list();
      assert.equal(records.length, 1);
      assert.equal(records[0].hash, sentHash);
      assert.equal(records[0].intent.intentDigest, expected);
      assert.equal(records[0].state, uncertain ? 'attempted' : 'submitted');
      await assert.rejects(journal.assertCanSubmit());
    } finally {
      reopened.close();
    }
    return Object.freeze({
      productionSubmissionController: true,
      productionTransactionService: true,
      realVaultEoaSigning: true,
      actualEoaSignatures: activity.signatures,
      unexpectedRpcAttempts: unexpectedRpcAttempts(),
      simulatedRpcActivity: { ...activity, methods: { ...methods } },
      completionReuseNoAcquisitionOrSigning: true,
      privatePreflightEvidenceSimulated: true,
      encryptedJournalBeforeSimulatedTransport: true,
      completionReuseRefused: true,
      simulatedRawTransactionSends: sends,
      simulatedRpcAcknowledged: !uncertain,
      uncertainHashPreserved: uncertain,
      freshContextJournalReopen: true,
      unresolvedAttemptBlocksNextTransaction: true,
      externalRpcSimulated: true,
      liveSubmissions: 0,
    });
  } finally {
    active = false;
    rpc.createPrivateRpc = originalRpc;
    networkModule.getPrivateTransactionNetwork = originalNetwork;
    signerModule.getSigner = originalSigner;
    for (const [filename, entry] of cached) {
      if (entry) require.cache[filename] = entry;
      else delete require.cache[filename];
    }
  }
};
