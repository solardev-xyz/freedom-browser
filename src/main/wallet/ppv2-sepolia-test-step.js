/** One explicit disposable Sepolia test step. No scheduler, retries or archives.
 * A zero balance returns a funding request before preparation or signing.
 */
const { privacyError } = require('../networks/privacy-context');
const { assertDirectTest } = require('../networks/direct-testnet-transport');
const { CANDIDATE } = require('./ppv2-sepolia-preflight');
const { NATIVE } = require('./ppv2-deposit-policy');
const { transactionIntent } = require('./private-transaction-intent');
const fail = () => privacyError('PRIVATE_PPV2_TEST_STEP_REFUSED', 'Sepolia test step refused');
const POLICY = Object.freeze({ deposit: 5000000000000000n, protocolFee: 100000000000000n,
  withdrawal: 2000000000000000n, relayFee: 2000000000000000n, gasFee: 3000000000000000n,
  minimumConfirmations: 12, maxDeposits: 2, maxWithdrawals: 2 });
const ACTIONS = Object.freeze(['register-auth', 'register-viewing', 'deposit', 'withdraw', 'ragequit', 'ragequit-cancel', 'resolve-public', 'resolve-public-failed', 'resolve-relay', 'status']);
async function runSepoliaTestStep({ handle, session, signer, owner, action, reference, readBalance, estimateGas, verifyDeployment, checkOnly = false }) {
  assertDirectTest(handle);
  if (typeof checkOnly !== 'boolean' || (reference !== undefined && !['withdraw', 'ragequit', 'ragequit-cancel', 'resolve-public', 'resolve-public-failed', 'resolve-relay'].includes(action)) || !ACTIONS.includes(action) || !/^0x[0-9a-f]{40}$/.test(owner) ||
      (await signer.getAddress()).toLowerCase() !== owner || session.descriptor.chainId !== 11155111 ||
      session.descriptor.relayerTransport !== 'direct' || !session.descriptor.identityMayBeIpLinked ||
      typeof verifyDeployment !== 'function' || typeof readBalance !== 'function') throw fail();
  const publicRecords = await session.listPublicSubmissions(), relayRecords = await session.listRelayAttempts();
  if (action === 'status') return { publicSubmissions: publicRecords, relayAttempts: relayRecords, notes: await session.notes() };
  if (['resolve-public', 'resolve-public-failed'].includes(action)) {
    if (!/^0x[0-9a-f]{64}$/.test(reference || '') || !publicRecords.some(r => r.hash === reference)) throw fail();
    return session.resolvePublicSubmission(reference, { minimumConfirmations: POLICY.minimumConfirmations, review: async review => {
      if (review.transactionHash !== reference || !(action === 'resolve-public' ? ['included'] : ['reverted', 'nonce-consumed']).includes(review.observation?.status) ||
          review.observation.confirmations < POLICY.minimumConfirmations) throw fail();
      return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
    } });
  }
  if (action === 'resolve-relay') {
    if (!relayRecords.some(r => r.id === reference)) throw fail();
    return session.resolveRelayAttempt(reference, async record => {
      if (record.id !== reference || !['included', 'exited'].includes(record.observation?.status)) throw fail();
      return { allowNextOperation: true, acceptedEvidence: 'unverified-rpc' };
    });
  }
  const cancelling = action === 'ragequit-cancel';
  const unresolvedRelays = relayRecords.filter(r => !r.resolution);
  if (publicRecords.some(r => !r.resolution) || (cancelling ?
    unresolvedRelays.length !== 1 || unresolvedRelays[0].commitment !== reference : unresolvedRelays.length !== 0)) throw fail();
  const count = kind => publicRecords.filter(r => r.intent?.kind === kind).length;
  const completed = kind => publicRecords.filter(r => r.intent?.kind === kind && r.observation?.status === 'included').length;
  if (publicRecords.length >= 6 || relayRecords.length > POLICY.maxWithdrawals) throw fail();
  const balance = await readBalance();
  if (typeof balance !== 'bigint' || balance < 0n) throw fail();
  const needed = POLICY.gasFee + (action === 'deposit' ? POLICY.deposit + POLICY.protocolFee : 0n);
  if (balance < needed) return { needsFunding: true, chainId: 11155111, address: owner, minimumForStepWei: needed.toString(), action };
  if (checkOnly) return { needsFunding: false, checkOnly: true, action, address: owner, readyForPreparation: true };
  if (await verifyDeployment() !== true) throw fail();
  let prepared, tx, gasLimit;
  if (action.startsWith('register-')) {
    const expected = action === 'register-auth' ? 'ppv2-register-auth' : 'ppv2-register-viewing';
    if (completed(expected) !== 0 || (action === 'register-viewing' && completed('ppv2-register-auth') !== 1)) throw fail();
    prepared = await session.prepareRegisterKeystore(); tx = prepared.txs?.[0];
    if (tx?.kind !== expected || tx.to !== CANDIDATE.keystore || tx.value !== 0n) throw fail();
    gasLimit = action === 'register-auth' ? 400000n : 150000n;
  } else if (action === 'deposit') {
    if (count('ppv2-native-deposit') >= POLICY.maxDeposits) throw fail();
    prepared = await session.prepareNativeDeposit({ amount: POLICY.deposit, maxFee: POLICY.protocolFee }); tx = prepared;
    if (tx.to !== CANDIDATE.entrypoint || tx.amount !== POLICY.deposit || tx.value < POLICY.deposit || tx.value > POLICY.deposit + POLICY.protocolFee) throw fail();
    gasLimit = 800000n;
  } else {
    if (!/^0x[0-9a-f]{64}$/.test(reference || '')) throw fail();
    const note = (await session.notes()).find(n => n.commitment === reference && n.asset?.__type === 'native');
    if (!note) throw fail();
    if (action === 'withdraw') {
      if (relayRecords.length >= POLICY.maxWithdrawals || note.status !== 'active' || note.value <= POLICY.withdrawal + POLICY.relayFee) throw fail();
      // Deliberately return to the public test owner; this test makes no unlinkability claim.
      prepared = await session.prepareNativeWithdrawal({ commitment: reference, recipient: owner, amount: POLICY.withdrawal, maxFee: POLICY.relayFee });
      return session.submitNativeWithdrawal(prepared, async summary => {
        assertDirectTest(handle);
        if (summary !== prepared || summary.recipient !== owner || BigInt(summary.amount) !== POLICY.withdrawal ||
            BigInt(summary.fee) > POLICY.relayFee || !summary.proofVerified || !summary.quoteSignatureVerified ||
            summary.privacy?.relayerTransport !== 'direct' || !summary.privacy?.identityMayBeIpLinked) throw fail();
        return true;
      });
    }
    if (!['ragequit', 'ragequit-cancel'].includes(action) || count('ppv2-native-ragequit') >= 2) throw fail();
    prepared = await session.prepareNativeRagequit(reference); tx = prepared;
    if (tx.to !== CANDIDATE.pool || tx.value !== 0n || tx.commitment !== reference) throw fail();
    gasLimit = 1200000n;
  }
  if (tx.chainId !== 11155111 || tx.from.toLowerCase() !== owner) throw fail();
  if (typeof estimateGas !== 'function') throw fail();
  const estimate = await estimateGas(tx);
  if (typeof estimate !== 'bigint' || estimate <= 0n) throw fail();
  const estimatedLimit = (estimate * 125n + 99n) / 100n;
  if (estimatedLimit > gasLimit) throw fail();
  gasLimit = estimatedLimit;
  const intent = transactionIntent(tx.kind, tx);
  const guardedSigner = { getAddress: () => signer.getAddress(), signTransaction: async transaction => {
    assertDirectTest(handle);
    if (BigInt(transaction.chainId) !== 11155111n || transactionIntent(tx.kind, { ...transaction, from: owner }).digest !== intent.digest ||
        BigInt(transaction.gasLimit) !== gasLimit || gasLimit * BigInt(transaction.gasPrice ?? transaction.maxFeePerGas) > POLICY.gasFee ||
        await verifyDeployment() !== true) throw fail();
    assertDirectTest(handle);
    return signer.signTransaction(transaction);
  } };
  return session.submitPublicOperation(prepared, { step: 0, signer: guardedSigner, gasLimit, maxGasFee: POLICY.gasFee,
    review: async summary => {
      assertDirectTest(handle);
      if (summary.operation !== tx.kind || summary.intent?.digest !== intent.digest || !!summary.pendingRelayCancellation !== cancelling || (cancelling && summary.competingRelayMayWin !== true) ||
          summary.replacesExistingViewingKey || summary.maxGasFee !== POLICY.gasFee ||
          (['ppv2-native-deposit', 'ppv2-native-ragequit'].includes(tx.kind) && summary.proofVerified !== true) ||
          (tx.kind === 'ppv2-native-deposit' && summary.amount !== POLICY.deposit) ||
          (tx.kind === 'ppv2-native-ragequit' && summary.noteCommitment !== reference) ||
          (summary.token && summary.token !== NATIVE)) throw fail();
      return true;
    } });
}
module.exports = { ACTIONS, POLICY, runSepoliaTestStep };
