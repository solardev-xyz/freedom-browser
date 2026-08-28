'use strict';

const { formatUnits, getAddress } = require('ethers');
const { AutomationError, ERROR_CODES } = require('../automation/contract/errors');
const { getPermissionKey, isEnsHost } = require('../../shared/origin-utils');
const identityManager = require('../identity-manager');
const tokenRegistry = require('../token-registry');
const {
  getPermission,
  grantPermission,
  updateLastUsed,
  updateWalletIndex,
} = require('../wallet/dapp-permissions');
const { getChain } = require('../wallet/chains');
const { getAllBalances, clearBalanceCache } = require('../wallet/balance-service');
const { resolveEnsAddress } = require('../ens-resolver');
const {
  estimateGas,
  getGasPrices,
  buildErc20TransferData,
  parseAmount,
} = require('../wallet/transaction-service');
const { signAndRecord, KINDS } = require('../wallet/tx-recorder');
const { getSigner } = require('../wallet/signers');

const PRIVILEGED_METHODS = new Set([
  'eth_requestAccounts',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
]);

function providerError(code, message) {
  return { code, message };
}

function bounded(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function safeWallet(wallet) {
  if (!Number.isSafeInteger(wallet?.index) || wallet.index < 0 || !wallet.address) return null;
  return Object.freeze({
    index: wallet.index,
    name: bounded(wallet.name, 80) || `Wallet ${wallet.index + 1}`,
    address: bounded(wallet.address, 80),
    type: ['mnemonic', 'ledger', 'remote'].includes(wallet.type) ? wallet.type : 'mnemonic',
  });
}

function normalizeDecision(value) {
  if (value === true || value === 'approved') return { status: 'approved' };
  if (value && typeof value === 'object') {
    return {
      status: value.status === 'approved' ? 'approved' : value.status || 'declined',
      ...(Number.isSafeInteger(value.walletIndex) && value.walletIndex >= 0
        ? { walletIndex: value.walletIndex }
        : {}),
    };
  }
  return { status: value === 'withdrawn' ? 'withdrawn' : 'declined' };
}

function displayValue(value, decimals) {
  try {
    return formatUnits(BigInt(value || 0), decimals);
  } catch {
    return 'Invalid';
  }
}

function exactTypedData(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return '';
  }
}

function abortIfRequested(signal) {
  if (signal?.aborted) {
    throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The wallet transfer was cancelled');
  }
}

function normalizedAddress(value) {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function tokenKey(token) {
  return token.address ? `${token.chainId}:${token.address.toLowerCase()}` : `${token.chainId}:native`;
}

class AgentWalletController {
  constructor(options = {}) {
    this.identity = options.identityManager || identityManager;
    this.getPermission = options.getPermission || getPermission;
    this.grantPermission = options.grantPermission || grantPermission;
    this.updateLastUsed = options.updateLastUsed || updateLastUsed;
    this.updateWalletIndex = options.updateWalletIndex || updateWalletIndex;
    this.getChain = options.getChain || getChain;
    this.estimateGas = options.estimateGas || estimateGas;
    this.getGasPrices = options.getGasPrices || getGasPrices;
    this.signAndRecord = options.signAndRecord || signAndRecord;
    this.getSigner = options.getSigner || getSigner;
    this.getTokens = options.getTokens || tokenRegistry.getTokens;
    this.getAllBalances = options.getAllBalances || getAllBalances;
    this.clearBalanceCache = options.clearBalanceCache || clearBalanceCache;
    this.resolveEnsAddress = options.resolveEnsAddress || resolveEnsAddress;
    this.buildErc20TransferData = options.buildErc20TransferData || buildErc20TransferData;
    this.parseAmount = options.parseAmount || parseAmount;
  }

  async transfer(input, context = {}) {
    if (typeof context.requestApproval !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Direct wallet transfers require an Agent approval surface'
      );
    }
    abortIfRequested(context.signal);
    const token = this.#resolveTransferToken(input.asset, input.chainId);
    const chain = this.getChain(token.chainId);
    if (!chain) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Chain ${token.chainId} is unavailable`
      );
    }
    const wallets = (await this.identity.getDerivedWallets()).map(safeWallet).filter(Boolean);
    const walletIndex = input.walletIndex ?? this.identity.getActiveWalletIndex();
    const wallet = wallets.find((item) => item.index === walletIndex);
    if (!wallet) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The selected wallet account is unavailable'
      );
    }
    const recipient = await this.#resolveTransferRecipient(input.recipient);
    let atomicAmount;
    try {
      atomicAmount = this.parseAmount(input.amount, token.decimals);
    } catch {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        `${input.amount} is not a valid ${token.symbol} amount`
      );
    }
    if (atomicAmount <= 0n) {
      throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'Transfer amount must be positive');
    }
    const tx = {
      to: token.address || recipient.address,
      value: token.address ? '0' : atomicAmount.toString(),
      ...(token.address && {
        data: this.buildErc20TransferData(recipient.address, atomicAmount.toString()),
      }),
      chainId: token.chainId,
    };
    const [gasEstimate, gasPrices] = await Promise.all([
      this.estimateGas({ from: wallet.address, ...tx }),
      this.getGasPrices(token.chainId),
    ]);
    tx.gasLimit = gasEstimate.gasLimit;
    if (!tx.gasLimit) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Freedom could not estimate the transfer fee'
      );
    }
    if (gasPrices.type === 'eip1559') {
      tx.maxFeePerGas = gasPrices.maxFeePerGas;
      tx.maxPriorityFeePerGas = gasPrices.maxPriorityFeePerGas;
    } else {
      tx.gasPrice = gasPrices.gasPrice;
    }
    const feePerGas = tx.maxFeePerGas || tx.gasPrice;
    if (!feePerGas) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Freedom could not determine the maximum transfer fee'
      );
    }
    const maxFee = BigInt(tx.gasLimit) * BigInt(feePerGas);
    await this.#assertTransferBalance(wallet.address, token, atomicAmount, maxFee);
    abortIfRequested(context.signal);
    const amount = formatUnits(atomicAmount, token.decimals);
    const to = recipient.name
      ? `${recipient.name} · ${recipient.address}`
      : recipient.address;
    const recipientVerification = recipient.name
      ? recipient.trustLevel === 'verified'
        ? 'Verified name resolution'
        : 'Unverified name resolution — check the address carefully'
      : '';
    const decision = normalizeDecision(
      await context.requestApproval({
        action: 'wallet_transfer',
        operation: 'wallet_transfer',
        label: `Send ${amount} ${token.symbol}`,
        wallet: {
          kind: 'transfer',
          chainId: token.chainId,
          chainName: bounded(chain.name, 80),
          account: wallet,
          to,
          ...(recipientVerification && { recipientVerification }),
          value: `${amount} ${token.symbol}`,
          maxFee: `${formatUnits(maxFee, chain.nativeCurrency.decimals)} ${chain.nativeCurrency.symbol}`,
          ...(token.address && { tokenContract: token.address }),
          requiresUnlock: wallet.type === 'mnemonic',
        },
      })
    );
    if (decision.status !== 'approved') {
      throw new AutomationError(
        ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER,
        decision.status === 'withdrawn'
          ? 'Wallet approval was withdrawn'
          : 'The user declined the wallet transfer'
      );
    }
    abortIfRequested(context.signal);
    await this.#assertTransferBalance(wallet.address, token, atomicAmount, maxFee);
    const result = await this.signAndRecord(tx, this.getSigner(wallet.index), {
      kind: KINDS.WALLET_SEND,
      origin: 'freedom-agent',
      asset: token.address,
      amount: atomicAmount.toString(),
      toAddress: recipient.address,
      metadata: { source: 'agent', assetSymbol: token.symbol },
    });
    return {
      wallet: {
        action: 'broadcast',
        chainId: token.chainId,
        transactionHash: result.hash,
        ...(result.paymentId && { paymentId: result.paymentId }),
        recipient: recipient.address,
        amount,
        asset: token.symbol,
      },
    };
  }

  #resolveTransferToken(asset, chainId) {
    const needle = asset.toLowerCase();
    const candidates = Object.values(this.getTokens())
      .filter(
        (token) =>
          token &&
          (!chainId || token.chainId === chainId) &&
          (String(token.symbol || '').toLowerCase() === needle ||
            String(token.address || '').toLowerCase() === needle)
      )
      .map((token) => ({ ...token, address: token.address || null }));
    if (candidates.length === 0) {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        chainId
          ? `${asset} is not a configured asset on chain ${chainId}`
          : `${asset} is not a configured Freedom wallet asset`,
        { suggestedAction: 'Ask the user to choose a configured asset and network' }
      );
    }
    if (candidates.length > 1) {
      const networks = candidates
        .map((token) => this.getChain(token.chainId)?.name || `chain ${token.chainId}`)
        .join(', ');
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        `${asset} is available on multiple networks: ${networks}`,
        { suggestedAction: 'Ask the user which network to use, then provide its chainId' }
      );
    }
    return candidates[0];
  }

  async #resolveTransferRecipient(value) {
    const address = normalizedAddress(value);
    if (address) return { address };
    if (!isEnsHost(value)) {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'Recipient must be an Ethereum address or supported Ethereum name'
      );
    }
    let result;
    try {
      result = await this.resolveEnsAddress(value);
    } catch {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Freedom could not resolve ${value}`,
        { retryable: true }
      );
    }
    const resolved = result?.success ? normalizedAddress(result.address) : null;
    if (!resolved) {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        `${value} does not resolve to an Ethereum address`
      );
    }
    return {
      address: resolved,
      name: bounded(result.name || value, 255),
      trustLevel: result.trust?.level === 'verified' ? 'verified' : 'unverified',
    };
  }

  async #assertTransferBalance(address, token, amount, maxFee) {
    this.clearBalanceCache(address);
    const balances = await this.getAllBalances(address);
    const assetBalance = balances?.[tokenKey(token)];
    if (!assetBalance || BigInt(assetBalance.raw) < amount) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `The selected wallet does not have enough ${token.symbol}`
      );
    }
    const native = Object.values(this.getTokens()).find(
      (candidate) => candidate?.chainId === token.chainId && candidate.address === null
    );
    const nativeBalance = native ? balances?.[tokenKey(native)] : null;
    const requiredNative = token.address ? maxFee : amount + maxFee;
    if (!nativeBalance || BigInt(nativeBalance.raw) < requiredNative) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `The selected wallet does not have enough ${native?.symbol || 'native currency'} for the transfer and maximum fee`
      );
    }
  }

  async handleRequest(context, payload) {
    if (
      !context ||
      typeof context !== 'object' ||
      typeof context.tabId !== 'string' ||
      typeof context.pageUrl !== 'string' ||
      typeof context.requestApproval !== 'function'
    ) {
      return { handled: false };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return { handled: false };
    if (!PRIVILEGED_METHODS.has(payload.method)) return { handled: false };
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return { handled: false };
    }
    if (serialized.length > 131_072) {
      return {
        handled: true,
        error: providerError(-32602, 'Wallet request is too large'),
        errorCode: ERROR_CODES.INVALID_ARGUMENT,
      };
    }

    const pageKey = getPermissionKey(context.pageUrl);
    const requestKey = getPermissionKey(payload.displayUrl);
    if (!pageKey || requestKey !== pageKey || payload.permissionKey !== pageKey) {
      return {
        handled: true,
        error: providerError(4100, 'Wallet request origin did not match the page'),
        errorCode: ERROR_CODES.POLICY_DENIED,
      };
    }

    try {
      const outcome = await this.#executeRequest(context, payload, pageKey);
      return {
        handled: true,
        result: outcome.providerResult,
        receipt: outcome.receipt,
      };
    } catch (error) {
      const declined = error?.code === ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER;
      return {
        handled: true,
        error: declined
          ? providerError(4001, 'User rejected the request')
          : providerError(-32603, bounded(error?.message, 240) || 'Wallet request failed'),
        errorCode:
          error instanceof AutomationError ? error.code : ERROR_CODES.INTERNAL_ERROR,
      };
    }
  }

  async #executeRequest(context, payload, permissionKey) {
    const chainId = Number(payload.chainId);
    const chain = this.getChain(chainId);
    if (!Number.isSafeInteger(chainId) || !chain) {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'The wallet request uses an unsupported chain'
      );
    }
    const wallets = (await this.identity.getDerivedWallets()).map(safeWallet).filter(Boolean);
    if (wallets.length === 0) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'No wallet account is available'
      );
    }
    const permission = this.getPermission(permissionKey);

    if (payload.method === 'eth_requestAccounts') {
      const defaultWalletIndex = permission?.walletIndex ?? this.identity.getActiveWalletIndex();
      const decision = await this.#approve(context, {
        action: 'wallet_connection',
        operation: 'browser_wallet_action',
        tabId: context.tabId,
        origin: permissionKey,
        destinationOrigin: permissionKey,
        label: 'Connect a wallet account',
        wallet: {
          kind: 'connection',
          chainId,
          chainName: bounded(chain.name, 80),
          wallets,
          defaultWalletIndex,
          requiresUnlock: false,
        },
      });
      const selected = wallets.find((wallet) => wallet.index === decision.walletIndex);
      if (!selected) {
        throw new AutomationError(
          ERROR_CODES.INVALID_ARGUMENT,
          'The selected wallet is unavailable'
        );
      }
      if (permission) {
        if (permission.walletIndex !== selected.index) {
          this.updateWalletIndex(permissionKey, selected.index);
        }
        this.updateLastUsed(permissionKey, chainId);
      } else {
        this.grantPermission(permissionKey, selected.index, chainId);
      }
      return {
        providerResult: [selected.address],
        receipt: {
          wallet: {
            action: 'connected',
            origin: permissionKey,
            chainId,
            account: selected.address,
          },
        },
      };
    }

    if (!permission) {
      throw new AutomationError(
        ERROR_CODES.POLICY_DENIED,
        'The site must connect to a wallet before requesting this action'
      );
    }
    const wallet = wallets.find((item) => item.index === permission.walletIndex);
    if (!wallet) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The connected wallet is unavailable'
      );
    }

    if (payload.method === 'eth_sendTransaction') {
      return this.#sendTransaction(context, payload, permissionKey, chain, wallet);
    }
    return this.#sign(context, payload, permissionKey, chain, wallet);
  }

  async #sendTransaction(context, payload, permissionKey, chain, wallet) {
    const txParams = payload.params?.[0];
    if (!txParams || typeof txParams !== 'object' || !txParams.to) {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'Transaction parameters are incomplete'
      );
    }
    if (txParams.from && txParams.from.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new AutomationError(
        ERROR_CODES.POLICY_DENIED,
        'Transaction sender does not match the connected wallet'
      );
    }
    const chainId = chain.chainId;
    const [gasEstimate, gasPrices] = await Promise.all([
      this.estimateGas({
        from: wallet.address,
        to: txParams.to,
        value: txParams.value || '0',
        data: txParams.data,
        chainId,
      }),
      this.getGasPrices(chainId),
    ]);
    const gasLimit = gasEstimate.gasLimit || txParams.gas;
    const tx = {
      to: txParams.to,
      value: txParams.value || '0',
      data: txParams.data,
      gasLimit,
      chainId,
    };
    if (gasPrices.type === 'eip1559') {
      tx.maxFeePerGas = gasPrices.maxFeePerGas;
      tx.maxPriorityFeePerGas = gasPrices.maxPriorityFeePerGas;
    } else {
      tx.gasPrice = gasPrices.gasPrice;
    }
    const feePerGas = tx.maxFeePerGas || tx.gasPrice || '0';
    const maxFee = BigInt(gasLimit) * BigInt(feePerGas);
    await this.#approve(context, {
      action: 'wallet_transaction',
      operation: 'browser_wallet_action',
      tabId: context.tabId,
      origin: permissionKey,
      destinationOrigin: permissionKey,
      label: 'Send a wallet transaction',
      wallet: {
        kind: 'transaction',
        chainId,
        chainName: bounded(chain.name, 80),
        account: wallet,
        to: bounded(tx.to, 100),
        value: `${displayValue(tx.value, chain.nativeCurrency.decimals)} ${chain.nativeCurrency.symbol}`,
        maxFee: `${displayValue(maxFee, chain.nativeCurrency.decimals)} ${chain.nativeCurrency.symbol}`,
        data: tx.data ? bounded(tx.data, 65_536) : '',
        requiresUnlock: wallet.type === 'mnemonic',
      },
    });
    const result = await this.signAndRecord(tx, this.getSigner(wallet.index), {
      kind: KINDS.DAPP_SEND,
      origin: permissionKey,
    });
    this.updateLastUsed(permissionKey, chainId);
    return {
      providerResult: result.hash,
      receipt: {
        wallet: {
          action: 'broadcast',
          origin: permissionKey,
          chainId,
          transactionHash: result.hash,
          ...(result.paymentId && { paymentId: result.paymentId }),
        },
      },
    };
  }

  async #sign(context, payload, permissionKey, chain, wallet) {
    const personal = payload.method === 'personal_sign';
    const message = personal && typeof payload.params?.[0] === 'string' ? payload.params[0] : '';
    const typedData = personal ? null : payload.params?.[1];
    const claimedAddress = personal ? payload.params?.[1] : payload.params?.[0];
    if (
      typeof claimedAddress === 'string' &&
      claimedAddress.toLowerCase() !== wallet.address.toLowerCase()
    ) {
      throw new AutomationError(
        ERROR_CODES.POLICY_DENIED,
        'Signature account does not match the connected wallet'
      );
    }
    const exactPayload = personal ? message : exactTypedData(typedData);
    if (!exactPayload || exactPayload.length > 65_536) {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'The signature payload is invalid or too large to review safely'
      );
    }
    await this.#approve(context, {
      action: 'wallet_signature',
      operation: 'browser_wallet_action',
      tabId: context.tabId,
      origin: permissionKey,
      destinationOrigin: permissionKey,
      label: personal ? 'Sign a message' : 'Sign typed data',
      wallet: {
        kind: 'signature',
        chainId: chain.chainId,
        chainName: bounded(chain.name, 80),
        account: wallet,
        signatureType: personal ? 'Personal message' : 'EIP-712 typed data',
        summary: exactPayload,
        requiresUnlock: wallet.type === 'mnemonic',
      },
    });
    const signer = this.getSigner(wallet.index);
    const signature = personal
      ? await signer.signMessage(payload.params?.[0])
      : await signer.signTypedData(typedData);
    this.updateLastUsed(permissionKey, chain.chainId);
    return {
      providerResult: signature,
      receipt: {
        wallet: {
          action: 'signed',
          origin: permissionKey,
          chainId: chain.chainId,
          signatureType: personal ? 'personal_sign' : 'eth_signTypedData_v4',
        },
      },
    };
  }

  async #approve(context, request) {
    const decision = normalizeDecision(await context.requestApproval(request));
    if (decision.status !== 'approved') {
      throw new AutomationError(
        ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER,
        decision.status === 'withdrawn'
          ? 'Wallet approval was withdrawn'
          : 'The user declined the wallet request'
      );
    }
    const defaultWalletIndex = request.wallet?.defaultWalletIndex;
    return {
      ...decision,
      walletIndex: decision.walletIndex ?? defaultWalletIndex,
    };
  }
}

module.exports = { AgentWalletController, PRIVILEGED_METHODS };
