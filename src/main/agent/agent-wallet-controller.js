'use strict';

const { formatUnits } = require('ethers');
const { AutomationError, ERROR_CODES } = require('../automation/contract/errors');
const { getPermissionKey } = require('../../shared/origin-utils');
const identityManager = require('../identity-manager');
const {
  getPermission,
  grantPermission,
  updateLastUsed,
  updateWalletIndex,
} = require('../wallet/dapp-permissions');
const { getChain } = require('../wallet/chains');
const { estimateGas, getGasPrices } = require('../wallet/transaction-service');
const { signAndRecord, KINDS } = require('../wallet/tx-recorder');
const { getSigner } = require('../wallet/signers');

const REQUEST_TIMEOUT_MS = 10_000;
const PRIVILEGED_METHODS = new Set([
  'eth_requestAccounts',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

class AgentWalletController {
  constructor(options = {}) {
    this.pendingByTab = new Map();
    this.requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
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
  }

  async run({ pageAdapter, tabId, ref, conversationId, requestApproval, signal }) {
    if (!pageAdapter || typeof pageAdapter.click !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'This page cannot initiate a controlled wallet action'
      );
    }
    if (typeof requestApproval !== 'function') {
      throw new AutomationError(
        ERROR_CODES.APPROVAL_REQUIRED,
        'Wallet actions require Agent-native user approval'
      );
    }
    if (this.pendingByTab.has(tabId)) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Another wallet request is already pending for this page'
      );
    }
    if (signal?.aborted) {
      throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The wallet action was cancelled');
    }

    const result = deferred();
    const pending = {
      tabId,
      conversationId,
      pageAdapter,
      requestApproval,
      result,
      claimed: false,
      timer: null,
      onAbort: null,
    };
    pending.timer = setTimeout(() => {
      if (pending.claimed || this.pendingByTab.get(tabId) !== pending) return;
      this.pendingByTab.delete(tabId);
      result.reject(
        new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          'The page did not make a supported wallet request after the Agent interaction'
        )
      );
    }, this.requestTimeoutMs);
    pending.onAbort = () => {
      if (pending.claimed || this.pendingByTab.get(tabId) !== pending) return;
      clearTimeout(pending.timer);
      this.pendingByTab.delete(tabId);
      result.reject(
        new AutomationError(ERROR_CODES.USER_CANCELLED, 'The wallet action was cancelled')
      );
    };
    signal?.addEventListener('abort', pending.onAbort, { once: true });
    this.pendingByTab.set(tabId, pending);

    try {
      try {
        await pageAdapter.click(ref);
      } catch (error) {
        if (!pending.claimed) throw error;
      }
      return await result.promise;
    } finally {
      clearTimeout(pending.timer);
      signal?.removeEventListener('abort', pending.onAbort);
      if (this.pendingByTab.get(tabId) === pending) this.pendingByTab.delete(tabId);
    }
  }

  async handleRequest(tabId, payload) {
    const pending = this.pendingByTab.get(tabId);
    if (!pending || pending.claimed) return { handled: false };
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
      this.#rejectCapturedRequest(
        pending,
        new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'The wallet request is too large')
      );
      return { handled: true, error: providerError(-32602, 'Wallet request is too large') };
    }

    const pageKey = getPermissionKey(pending.pageAdapter.getState()?.url);
    const requestKey = getPermissionKey(payload.displayUrl);
    if (!pageKey || requestKey !== pageKey || payload.permissionKey !== pageKey) {
      this.#rejectCapturedRequest(
        pending,
        new AutomationError(
          ERROR_CODES.POLICY_DENIED,
          'Wallet request origin did not match the page'
        )
      );
      return {
        handled: true,
        error: providerError(4100, 'Wallet request origin did not match the page'),
      };
    }

    pending.claimed = true;
    clearTimeout(pending.timer);
    try {
      const outcome = await this.#executeRequest(pending, payload, pageKey);
      pending.result.resolve(outcome.receipt);
      return { handled: true, result: outcome.providerResult };
    } catch (error) {
      const declined = error?.code === ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER;
      pending.result.reject(
        error instanceof AutomationError
          ? error
          : new AutomationError(ERROR_CODES.INTERNAL_ERROR, 'The approved wallet request failed')
      );
      return {
        handled: true,
        error: declined
          ? providerError(4001, 'User rejected the request')
          : providerError(-32603, bounded(error?.message, 240) || 'Wallet request failed'),
      };
    }
  }

  #rejectCapturedRequest(pending, error) {
    pending.claimed = true;
    clearTimeout(pending.timer);
    pending.result.reject(error);
  }

  async #executeRequest(pending, payload, permissionKey) {
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
      const decision = await this.#approve(pending, {
        action: 'wallet_connection',
        operation: 'browser_wallet_action',
        tabId: pending.tabId,
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
      return this.#sendTransaction(pending, payload, permissionKey, chain, wallet);
    }
    return this.#sign(pending, payload, permissionKey, chain, wallet);
  }

  async #sendTransaction(pending, payload, permissionKey, chain, wallet) {
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
    await this.#approve(pending, {
      action: 'wallet_transaction',
      operation: 'browser_wallet_action',
      tabId: pending.tabId,
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

  async #sign(pending, payload, permissionKey, chain, wallet) {
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
    await this.#approve(pending, {
      action: 'wallet_signature',
      operation: 'browser_wallet_action',
      tabId: pending.tabId,
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

  async #approve(pending, request) {
    const decision = normalizeDecision(await pending.requestApproval(request));
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
