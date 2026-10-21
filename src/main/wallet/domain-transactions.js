'use strict';

const { getAddress, formatEther } = require('ethers');
const { DomainError, refuse } = require('../domains/contracts');

// Shared wallet bridge. DomainService supplies an already encoded typed plan;
// this module has no page API and never accepts calldata from an Agent tool.
class DomainTransactions {
  constructor(options = {}) {
    this.identity = options.identityManager || require('../identity-manager');
    // Domain reveal calldata contains a registration secret. Do not use the
    // general estimator's verbose RPC-error logger for this private workflow.
    this.estimateGas = options.estimateGas || (async tx => {
      const { toQuantity } = require('ethers');
      const response = await require('../networks/chain-data-router').request(1, 'eth_estimateGas', [{
        from: tx.from, to: tx.to, value: toQuantity(BigInt(tx.value)), data: tx.data,
      }]);
      return { gasLimit: (BigInt(response.result) * 120n / 100n).toString() };
    });
    this.getGasPrices = options.getGasPrices || require('./transaction-service').getGasPrices;
    this.signAndRecord = options.signAndRecord || require('./tx-recorder').signAndRecord;
    this.getSigner = options.getSigner || require('./signers').getSigner;
    this.balance = options.balance || (async address => {
      const response = await require('../networks/chain-data-router').request(1, 'eth_getBalance', [address, 'latest']);
      return BigInt(response.result);
    });
  }
  async account(index) {
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) refuse('Choose a valid Freedom wallet account.', 'DOMAIN_INVALID');
    const selected = index ?? this.identity.getActiveWalletIndex();
    const wallet = (await this.identity.getDerivedWallets()).find(item => item.index === selected);
    if (!wallet || !['mnemonic', 'ledger', 'remote'].includes(wallet.type)) refuse('Choose a supported Freedom wallet: local, Ledger or remote.');
    return { index: wallet.index, address: getAddress(wallet.address), type: wallet.type,
      name: String(wallet.name || `Wallet ${selected + 1}`).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 80) };
  }
  async send(plan, context) {
    if (typeof context.requestApproval !== 'function') refuse('This operation needs Freedom’s wallet approval surface.');
    context.signal?.throwIfAborted();
    const account = await this.account(plan.account.index);
    if (account.address !== plan.account.address || account.type !== plan.account.type) refuse('The selected wallet changed. Prepare a new domain operation.', 'DOMAIN_STALE');
    const intent = { to: plan.to, data: plan.data, value: plan.value, chainId: 1, redactErrors: true };
    const [estimate, fees] = await Promise.all([this.estimateGas({ from: account.address, ...intent }), this.getGasPrices(1)]);
    const tx = { ...intent, gasLimit: estimate.gasLimit,
      ...(fees.type === 'eip1559' ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : { gasPrice: fees.gasPrice }) };
    const gasPrice = tx.maxFeePerGas || tx.gasPrice;
    if (!tx.gasLimit || !gasPrice || BigInt(tx.gasLimit) <= 0n || BigInt(gasPrice) <= 0n ||
        (tx.maxPriorityFeePerGas && BigInt(tx.maxPriorityFeePerGas) > BigInt(gasPrice))) refuse('The maximum network fee could not be determined.');
    const maxFee = BigInt(tx.gasLimit) * BigInt(gasPrice);
    const checkBalance = async () => {
      if (await this.balance(account.address) < BigInt(tx.value) + maxFee) refuse('This wallet needs more ETH for the domain operation and its maximum network fee.', 'DOMAIN_BALANCE');
    };
    await checkBalance();
    context.signal?.throwIfAborted();
    const decision = await context.requestApproval({
      action: 'wallet_transaction', operation: 'domain_execute', label: plan.label, inputPreview: plan.summary,
      wallet: { kind: 'transaction', chainId: 1, chainName: 'Ethereum', account,
        to: tx.to, value: `${formatEther(tx.value)} ETH`, maxFee: `${formatEther(maxFee)} ETH`,
        summary: plan.summary, data: plan.data, requiresUnlock: account.type === 'mnemonic' },
    });
    if (![true, 'approved'].includes(decision) && decision?.status !== 'approved') throw new DomainError('DOMAIN_DECLINED', 'The domain transaction was not approved.');
    context.signal?.throwIfAborted();
    const current = await this.account(account.index);
    if (current.address !== account.address || current.type !== account.type) refuse('The wallet changed during approval.', 'DOMAIN_STALE');
    await context.revalidate();
    await checkBalance();
    context.signal?.throwIfAborted();
    // Journal durably before signing/broadcast; failure from this point is
    // uncertain until reconciled. No signer failure authorizes a second send.
    await context.beforeSend();
    context.signal?.throwIfAborted();
    return this.signAndRecord(tx, this.getSigner(account.index), {
      kind: require('./tx-recorder').KINDS.DAPP_SEND, fromAddress: account.address,
      metadata: { domainOperationId: plan.id, domain: plan.name, domainStep: plan.step },
    });
  }
}
module.exports = { DomainTransactions };
