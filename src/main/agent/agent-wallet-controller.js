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

// The methods main serves for a page and hands to the agent attested
// (freedom-core design 0011): connecting (PRQ-4), messages and typed data
// (PRQ-5a), and sends (PRQ-5b).
const ATTESTED_METHODS = new Set([
  'eth_requestAccounts',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
]);

// The page kinds the Agent's decision mints (freedom-core design 0012, "A
// page request the Agent answers"), as main's issuer names them.
const PAGE_TOKEN_KINDS = Object.freeze({
  personal_sign: 'sign-message',
  eth_signTypedData_v4: 'sign-typed-data',
  eth_sendTransaction: 'dapp-send',
});

/**
 * Main's issuer for the Agent's decision on a page request it attested
 * (design 0012): `mint(kind, walletIndex, payload, options)` has the identity
 * core mint the request's page-kind token under `page`, `present(token)`
 * hands it to the signature in the same run as main's last checks, under
 * the page's live PageContext (`{ confirmation }`, for `getSigner`), and
 * `discard(token)` burns one the request ended before presenting. Null
 * when main gave none.
 */
function pageTokenOf(context) {
  const token = context?.pageToken;
  return token &&
    typeof token.mint === 'function' &&
    typeof token.present === 'function' &&
    typeof token.discard === 'function'
    ? token
    : null;
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
    type: ['mnemonic', 'ledger', 'remote', 'safe'].includes(wallet.type) ? wallet.type : 'unknown',
  });
}

function assertSupportedSigningWallet(wallet) {
  if (!['mnemonic', 'ledger', 'remote'].includes(wallet.type)) {
    throw new AutomationError(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      'Agent signing and transfers are unavailable for this wallet type; use Freedom’s wallet controls'
    );
  }
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
    assertSupportedSigningWallet(wallet);
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
    const originMismatch = {
      handled: true,
      error: providerError(4100, 'Wallet request origin did not match the page'),
      errorCode: ERROR_CODES.POLICY_DENIED,
    };
    let permissionKey;
    if (context.attested) {
      // A request main attested (freedom-core design 0011, PRQ-4 and
      // PRQ-5a): it acts under main's key (a DNS name over IPNS keeps its
      // name), on the page this run sees on the same transport.
      if (!ATTESTED_METHODS.has(payload.method)) return { handled: false };
      const { key, transportKey } = context.attested;
      if (typeof key !== 'string' || !key || !pageKey || pageKey !== transportKey) return originMismatch;
      permissionKey = key;
    } else {
      const requestKey = getPermissionKey(payload.displayUrl);
      if (!pageKey || requestKey !== pageKey || payload.permissionKey !== pageKey) return originMismatch;
      permissionKey = pageKey;
    }

    try {
      const outcome = await this.#executeRequest(context, payload, permissionKey);
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
    if (!Number.isSafeInteger(chainId) || !chain || chain.chainId !== chainId) {
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
      // A request main attested writes only while main still holds it: not
      // answered (its deadline, its page gone), the name checked again, and
      // the page still under its key in the same run as the write.
      await this.#underMain(context, () => {
        const current = context.attested ? this.getPermission(permissionKey) : permission;
        let grant;
        if (current) {
          grant = current.walletIndex !== selected.index ? 'updated' : 'unchanged';
          if (grant === 'updated') {
            this.updateWalletIndex(permissionKey, selected.index);
          }
          this.updateLastUsed(permissionKey, chainId);
        } else {
          grant = 'created';
          this.grantPermission(permissionKey, selected.index, chainId);
        }
        // What this write did, decided here, told to main in the same run
        // (freedom-core design 0011, PRQ-6): main queues a created grant's
        // events at this write, in the key's order.
        if (context.attested && typeof context.grantWritten === 'function') {
          try {
            context.grantWritten({ grant, walletIndex: selected.index, account: selected.address, chainId });
          } catch {
            // Main's events never undo the write.
          }
        }
      });
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

    assertSupportedSigningWallet(wallet);
    // A page's signature or send is the page's (design 0012, APB-1): it
    // goes under `page` with the token the Agent's decision mints through
    // main's issuer, never as main's own. A request main didn't attest, or
    // one it gave no issuer for, has no page to sign under: refused before
    // anything is asked.
    if (!context.attested || !pageTokenOf(context)) {
      throw new AutomationError(
        ERROR_CODES.POLICY_DENIED,
        'A page’s wallet request signs only through Freedom’s page dispatcher'
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
    if (txParams.chainId !== undefined && Number(txParams.chainId) !== chain.chainId) {
      throw new AutomationError(ERROR_CODES.POLICY_DENIED, 'Transaction chain does not match the approved wallet network');
    }
    if (txParams.data !== undefined && (typeof txParams.data !== 'string' || txParams.data.length > 65_536 || !/^0x(?:[a-f0-9]{2})*$/i.test(txParams.data))) {
      throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'Use valid transaction data no larger than the approval display limit.');
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
    const feePerGas = tx.maxFeePerGas || tx.gasPrice;
    if (!gasLimit || !feePerGas || BigInt(gasLimit) <= 0n || BigInt(feePerGas) <= 0n) {
      throw new AutomationError(ERROR_CODES.POLICY_DENIED, 'Freedom could not determine the maximum transaction fee. Try again before approving.');
    }
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
    // A request main attested sends only while main still holds it: not
    // answered (its deadline, its page gone), the name checked again, the
    // page still under its key and its grant still exposing this account, in
    // the same run as the send. A signer can take long (a Ledger, the core),
    // so the same gates run again after the signature and before the signed
    // bytes are recorded or sent (the transaction service's `guardCommit`),
    // and the guard commits them itself. A phone signs and broadcasts in one
    // step: its send is gated before the phone is asked.
    const grantStillExposes = () => {
      if (this.getPermission(permissionKey)?.walletIndex !== wallet.index) {
        throw new AutomationError(ERROR_CODES.POLICY_DENIED, 'The site is no longer connected with this account');
      }
    };
    const record = { kind: KINDS.DAPP_SEND, origin: permissionKey };
    // The Agent's approval mints the page's `dapp-send` token for this
    // transaction (design 0012), the phone's unjudged by the core's fee
    // check as on main's own path; the send presents it under `page`.
    const result = await this.#underMain(context, () => {
      grantStillExposes();
      return this.#withPageToken(
        context,
        PAGE_TOKEN_KINDS.eth_sendTransaction,
        wallet.index,
        { ...tx, origin: permissionKey },
        { phone: wallet.type === 'remote' },
        (authorized) => {
          grantStillExposes();
          return this.signAndRecord(tx, this.getSigner(wallet.index, authorized()), record, {
            guardCommit: (commit) =>
              this.#underMain(context, () => {
                grantStillExposes();
                return commit();
              }),
          });
        }
      );
    });
    // A grant held under the attested key is touched only while main still
    // holds the request after the send's wait, checked the same way. The
    // hash itself reaches the page only while its name holds, which main
    // checks when it answers.
    await this.#underMain(context, () => this.updateLastUsed(permissionKey, chainId), { required: false });
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
    if (!personal) {
      const domainChain = JSON.parse(exactPayload)?.domain?.chainId;
      if (domainChain !== undefined && Number(domainChain) !== chain.chainId) {
        throw new AutomationError(ERROR_CODES.POLICY_DENIED, 'Typed-data chain does not match the approved wallet network');
      }
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
    // A request main attested signs only while main still holds it: not
    // answered (its deadline, its page gone), the name checked again, and
    // the page still under its key in the same run as the signature, which
    // presents the page's token the Agent's approval minted (design 0012):
    // a message's bytes, or typed data viewed on the page's chain, whose
    // hash the core bound is the one it signs.
    const signature = await this.#underMain(context, () =>
      this.#withPageToken(
        context,
        PAGE_TOKEN_KINDS[payload.method],
        wallet.index,
        personal ? message : typedData,
        personal ? {} : { chainId: chain.chainId },
        (authorized, confirmation) => {
          const signer = this.getSigner(wallet.index, authorized());
          return personal
            ? signer.signMessage(message)
            : signer.signTypedData(typedData, { expectedHash: confirmation.hash });
        }
      )
    );
    // A grant held under the attested key is touched only while main still
    // holds the request after the signature's wait, checked the same way.
    // The signature itself reaches the page only while its name holds, which
    // main checks when it answers.
    await this.#underMain(context, () => this.updateLastUsed(permissionKey, chain.chainId), { required: false });
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

  /**
   * A page's signature or send under the token the Agent's decision mints
   * (design 0012, "A page request the Agent answers"): main's issuer mints
   * it for this request, then `sign(authorized, confirmation)` runs, and
   * `authorized()`, called in the same run as the signer is asked for,
   * presents it there after main's checks again (the request still open,
   * its page holding its key, the agent still holding the tab), under the
   * page's live PageContext. The token is burnt afterwards, spent or not.
   */
  async #withPageToken(context, kind, walletIndex, payload, options, sign) {
    const issuer = pageTokenOf(context);
    const confirmation = await issuer.mint(kind, walletIndex, payload, options);
    try {
      return await sign(() => issuer.present(confirmation), confirmation);
    } finally {
      issuer.discard(confirmation);
    }
  }

  /**
   * Run `effect` (a grant write, a signature) for a request: at once for one
   * of the agent's own, and for one main attested only once main's gates
   * pass, in the same run as the last of them (`effectAllowed`), never across
   * an await, so no other check can end the page's key between them. When
   * they don't pass, nothing runs, and `required` throws.
   */
  async #underMain(context, effect, { required = true } = {}) {
    if (!context.attested) return effect();
    const ready = typeof context.beforeEffect === 'function' && (await context.beforeEffect()) === true;
    if (ready && typeof context.effectAllowed === 'function' && context.effectAllowed() === true) return effect();
    if (required) throw new AutomationError(ERROR_CODES.POLICY_DENIED, 'The page’s wallet request is no longer open');
    return undefined;
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
