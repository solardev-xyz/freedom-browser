/** Main-owned PPv2 handoff. Preparation grants one reviewed transaction at a
 * time, never an automatic batch/retry. SDK code never receives this authority.
 */
const { Interface } = require('ethers');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { FIELD } = require('./ppv2-deposit-policy');
const { transactionIntent } = require('./private-transaction-intent');
const REGISTRATION_ABI = ['function setAuthPolicy(uint256 authDigest,uint256 nullifyingKeyHash)',
  'function setViewingKey(bytes32 viewingKey)'];
const iface = new Interface(REGISTRATION_ABI);
const readInterface = new Interface(['function nullifyingKeys(address) view returns (uint256)',
  'function viewingKeys(address) view returns (bytes32)']);
const refused = () => privacyError('PRIVATE_PPV2_HANDOFF_REFUSED', 'PPv2 transaction handoff refused');

function createPPv2PublicOperations({ scope, configuration, provider }) {
  const owner = configuration.ownerAddress.toLowerCase();
  const keystore = configuration.deployment.keystoreAddress.toLowerCase();
  const handle = scope.getContext({ kind: 'public-address', principal: owner, chainId: 11155111, role: 'transaction-rpc' });
  const issued = new WeakMap();
  let busy = false;
  const network = () => require('./private-transaction-network').getPrivateTransactionNetwork(handle);
  function issue(value, txs) {
    getPrivacyContext(handle);
    issued.set(value, { txs, used: new Set(), hashes: [], expiresAt: Date.now() + 120000 });
    return value;
  }
  function registration(operation) {
    try {
      if (operation?.__type !== 'publicOperation' || !Array.isArray(operation.txs) ||
          operation.txs.length < 1 || operation.txs.length > 2) throw refused();
      const txs = operation.txs.map((tx) => {
        if (tx.to?.toLowerCase() !== keystore || tx.value !== 0n || typeof tx.data !== 'string') throw refused();
        const parsed = iface.parseTransaction({ data: tx.data });
        if (!parsed || iface.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== tx.data.toLowerCase()) throw refused();
        if (parsed.name === 'setAuthPolicy' && !parsed.args.every((v) => v > 0n && v < FIELD)) throw refused();
        if (parsed.name === 'setViewingKey' && BigInt(parsed.args[0]) === 0n) throw refused();
        return Object.freeze({ kind: parsed.name === 'setAuthPolicy' ? 'ppv2-register-auth' : 'ppv2-register-viewing',
          chainId: 11155111, from: owner, to: keystore, value: 0n, data: tx.data.toLowerCase(), chainStateVerified: false });
      });
      if (txs.length === 2 && (txs[0].kind !== 'ppv2-register-auth' || txs[1].kind !== 'ppv2-register-viewing')) throw refused();
      return issue(Object.freeze({ __type: 'publicOperation', kind: 'ppv2-registration', txs: Object.freeze(txs), chainStateVerified: false }), txs);
    } catch { throw refused(); }
  }
  function deposit(prepared) {
    // Only the session's verified deposit bridge calls this, not renderer/SDK.
    if (prepared?.kind !== 'ppv2-native-deposit' || prepared.chainId !== 11155111 ||
        prepared.from?.toLowerCase() !== owner || prepared.to?.toLowerCase() !== configuration.deployment.entrypointAddress.toLowerCase() ||
        prepared.proofVerified !== true || prepared.chainStateVerified !== false || !Object.isFrozen(prepared)) throw refused();
    return issue(prepared, [prepared]);
  }
  async function submit(prepared, { step = 0, signer, review, gasLimit, maxGasFee, reviewTimeoutMs = 120000 } = {}) {
    getPrivacyContext(handle);
    const plan = issued.get(prepared);
    if (busy || !plan || !Number.isInteger(step) || step < 0 || step >= plan.txs.length || plan.used.has(step) ||
        Date.now() >= plan.expiresAt || typeof review !== 'function' || typeof gasLimit !== 'bigint' || gasLimit <= 0n ||
        gasLimit > 30000000n || typeof maxGasFee !== 'bigint' || maxGasFee <= 0n || maxGasFee >= 1n << 256n ||
        !Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > 120000) throw refused();
    busy = true;
    try {
      const client = network();
      await client.assertCanSubmit();
      if (step > 0) {
        if (!plan.hashes[step - 1]) throw refused();
        const previous = await client.reconcileSubmission(plan.hashes[step - 1]);
        if (!previous.resolution || previous.observation?.status !== 'included') throw refused();
      }
      getPrivacyContext(handle);
      if (Date.now() >= plan.expiresAt) throw refused();
      const tx = plan.txs[step];
      if (tx.kind === 'ppv2-native-deposit') {
        // isRegistered() in the SDK checks only the auth slot. Deposits from
        // this wallet require BOTH public registration steps to be observed.
        for (const name of ['nullifyingKeys', 'viewingKeys']) {
          if (!provider) throw refused();
          const result = await provider.call({ to: keystore, data: readInterface.encodeFunctionData(name, [owner]) });
          try { if (BigInt(readInterface.decodeFunctionResult(name, result)[0]) === 0n) throw refused(); }
          catch { throw refused(); }
        }
      }
      await client.request(tx.chainId, 'eth_call', [{ from: owner, to: tx.to,
        value: `0x${tx.value.toString(16)}`, data: tx.data }, 'latest']);
      getPrivacyContext(handle);
      if (Date.now() >= plan.expiresAt) throw refused();
      const intent = transactionIntent(tx.kind, tx);
      // Consume before review/signing. Rejection requires a fresh preparation;
      // a crash/timeout is recovered through the durable submission journal.
      plan.used.add(step);
      const send = require('./transaction-service').signAndSendTransaction;
      const result = await send({ chainId: tx.chainId, to: tx.to, value: tx.value.toString(), data: tx.data,
        gasLimit: gasLimit.toString() }, signer, { privacyContext: handle, intent,
        reviewTimeoutMs, reviewExpiresAt: plan.expiresAt,
        review: async (request) => {
          getPrivacyContext(handle);
          const actual = request.transaction;
          if (request.from.toLowerCase() !== owner || transactionIntent(tx.kind, { ...actual, from: owner }).digest !== intent.digest ||
              BigInt(actual.gasLimit) !== gasLimit || gasLimit * BigInt(actual.gasPrice ?? actual.maxFeePerGas) > maxGasFee ||
              Date.now() >= plan.expiresAt) throw refused();
          return review(Object.freeze({ ...request, intent, operation: tx.kind, step, steps: plan.txs.length,
            protocolFee: tx.fee ?? 0n, maxGasFee, proofVerified: tx.proofVerified === true, chainStateVerified: false }));
        } });
      plan.hashes[step] = result.hash;
      return Object.freeze(result);
    } catch (error) {
      if (error?.code === 'PRIVATE_BROADCAST_UNCERTAIN') plan.hashes[step] = error.transactionHash;
      throw error;
    } finally { busy = false; }
  }
  return Object.freeze({ registration, deposit, submit,
    list: () => network().listSubmissions(), observe: (hash) => network().reconcileSubmission(hash),
    resolve: (hash, policy) => network().resolveSubmission(hash, policy) });
}
module.exports = { REGISTRATION_ABI, createPPv2PublicOperations };
