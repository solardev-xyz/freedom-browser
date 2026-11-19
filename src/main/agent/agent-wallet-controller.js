'use strict';

const { formatUnits, getAddress } = require('ethers');
const { AutomationError, ERROR_CODES } = require('../automation/contract/errors');
const { getPermissionKey, isEnsHost } = require('../../shared/origin-utils');
const identityManager = require('../identity-manager');
const tokenRegistry = require('../token-registry');
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
const { feeCheckError, FEE_CHECK_ASK_AGAIN } = require('../wallet/fee-check');

// A page's wallet request in a tab the Agent holds goes to the identity
// core like any page's, and the Agent's sheet answers the core's prompt for
// it (freedom-core design 0012, "The Agent's answer", APB-5:
// `answerPrompt`): the core's prompts it answers, with the page methods
// each serves.
const PROMPT_METHODS = Object.freeze({
  'eth.connect': new Set(['eth_requestAccounts']),
  'eth.sign': new Set(['personal_sign', 'eth_signTypedData_v4']),
  'eth.send': new Set(['eth_sendTransaction']),
});
// The longest request, and the longest payload the sheet shows in full.
const MAX_REQUEST_CHARS = 131_072;
const MAX_PAYLOAD_CHARS = 65_536;

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

/** A `personal_sign` message's bytes as UTF-8 text, or null (`approvals-kinds.js`'s `messageText`). */
function messageText(hex) {
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex.slice(2), 'hex'));
  } catch {
    return null;
  }
}

const TYPED_WARNINGS = Object.freeze({
  'named-type':
    'The site named a different type of data than the one shown here. This shows what is signed, but another wallet could sign something different for this request.',
  'chain-mismatch': 'This data is for another chain than the site is on.',
  'chain-absent': 'This data names no chain. The signature is valid on every chain where the contract it is for exists.',
});

/**
 * What the sheet shows of a signature: the identity core's view of what its
 * token binds (design 0012, A7-10), as the user's prompt shows it. A
 * message as text where its bytes are UTF-8, else its bytes in hex; typed
 * data as the core's parsed view, with its hash, the fields the site sent
 * that aren't signed, and the core's warnings.
 */
function signatureSummary(view) {
  if (view.method === 'personal_sign') {
    const text = view.message.rawHash ? null : messageText(view.message.hex);
    const lines = [text === null ? view.message.hex : text];
    if (view.message.rawHash) {
      lines.push('', "Warning: this signs a raw 32-byte value. It can authorize things this screen can't show.");
    }
    return lines.join('\n');
  }
  const typed = view.typedData;
  const shown = typed.view || {};
  const lines = [
    `Domain: ${JSON.stringify(shown.domain ?? {}, null, 2)}`,
    `${typeof shown.primary_type === 'string' ? shown.primary_type : 'Message'}: ${JSON.stringify(shown.message ?? null, null, 2)}`,
    `Hash: ${typed.hash}`,
  ];
  if (Array.isArray(shown.ignored) && shown.ignored.length > 0) {
    lines.push(`Not signed, though the site sent it: ${shown.ignored.join(', ')}`);
  }
  for (const warning of typed.warnings) {
    if (TYPED_WARNINGS[warning]) lines.push(`Warning: ${TYPED_WARNINGS[warning]}`);
  }
  return lines.join('\n');
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

  /**
   * The Agent's sheet answering the identity core's prompt for a page's
   * connect, signature or send in a tab the Agent holds (freedom-core design
   * 0012, "The Agent's answer", APB-5). Main asks it from its handler of the
   * core's `approval.request`, on a handle it opened for the sheet's
   * decision, and answers the core with that decision; the core then writes
   * the grant, or mints the token and signs, or hands main `{ send }` or
   * `{ device }`.
   *
   * `context`: the run's (`tabId`, `pageUrl`, `requestApproval`) and main's
   * (`attested`: the key the request acts under and the page's transport
   * key). `prompt`: `{ kind, method, params, chainId, view }`, `view` the
   * core's as main shows it (`page-eip1193.js`), which the sheet shows: what
   * the token will bind, not the page's params (A7-10).
   *
   * The agent's own refusals answer without the sheet (A7-3): a request over
   * 131,072 characters, a page this run sees on another transport, a Safe's
   * account, a signature for another address, typed data for another chain,
   * a payload too large to show in full, a send with no `to`, another
   * `from` or `chainId`, or data over 65,536 characters, and a send with no
   * fee. So does a send whose fee the core's check stops (A7-5): its sheet
   * would approve a fee it can't confirm.
   *
   * @returns {Promise<object>} `{ handled: false }` for a prompt it doesn't
   *   take; `{ handled: true, error, errorCode }` for a refusal; or
   *   `{ handled: true, decision, receiptOf }`, `decision` `{ approve: true,
   *   walletIndex? }`, `{ approve: false }` or `{ closed: true }` (the sheet
   *   withdrawn), and `receiptOf(answer)` the Agent's receipt for the page's
   *   answer, or null.
   */
  async answerPrompt(context, prompt) {
    if (
      !context ||
      typeof context !== 'object' ||
      typeof context.tabId !== 'string' ||
      typeof context.pageUrl !== 'string' ||
      typeof context.requestApproval !== 'function' ||
      !context.attested
    ) {
      return { handled: false };
    }
    if (!prompt || typeof prompt !== 'object' || !PROMPT_METHODS[prompt.kind]?.has(prompt.method)) {
      return { handled: false };
    }
    const { view, method } = prompt;
    const chainId = view?.chain?.id;
    if (!view || typeof view !== 'object' || !Number.isSafeInteger(chainId)) return { handled: false };
    const refuse = (code, message, errorCode) => ({ handled: true, error: providerError(code, message), errorCode });
    let serialized;
    try {
      serialized = JSON.stringify({ method, params: prompt.params, chainId: prompt.chainId });
    } catch {
      return refuse(-32602, 'Wallet request is too large', ERROR_CODES.INVALID_ARGUMENT);
    }
    if (serialized.length > MAX_REQUEST_CHARS) {
      return refuse(-32602, 'Wallet request is too large', ERROR_CODES.INVALID_ARGUMENT);
    }
    // It acts under main's key (a DNS name over IPNS keeps its name), on the
    // page this run sees on the same transport.
    const pageKey = getPermissionKey(context.pageUrl);
    const { key, transportKey } = context.attested;
    if (typeof key !== 'string' || !key || !pageKey || pageKey !== transportKey) {
      return refuse(4100, 'Wallet request origin did not match the page', ERROR_CODES.POLICY_DENIED);
    }
    const chainName = bounded(view.chain.name, 80);
    const request = {
      operation: 'browser_wallet_action',
      tabId: context.tabId,
      origin: key,
      destinationOrigin: key,
    };

    if (prompt.kind === 'eth.connect') {
      const wallets = (Array.isArray(view.accounts) ? view.accounts : []).map(safeWallet).filter(Boolean);
      if (wallets.length === 0) {
        return refuse(-32603, 'No wallet account is available', ERROR_CODES.CAPABILITY_UNAVAILABLE);
      }
      const offered = wallets.map((wallet) => wallet.index);
      const defaultWalletIndex = offered.includes(view.defaultIndex) ? view.defaultIndex : offered[0];
      const decision = await this.#decide(context, {
        ...request,
        action: 'wallet_connection',
        label: 'Connect a wallet account',
        wallet: { kind: 'connection', chainId, chainName, wallets, defaultWalletIndex, requiresUnlock: false },
      });
      return {
        handled: true,
        decision: decision.approve === true ? { approve: true, walletIndex: decision.walletIndex ?? defaultWalletIndex } : decision,
        receiptOf: (answer) =>
          Array.isArray(answer?.result) && typeof answer.result[0] === 'string'
            ? { wallet: { action: 'connected', origin: key, chainId, account: answer.result[0] } }
            : null,
      };
    }

    const account = safeWallet(view.account);
    if (!account) {
      return refuse(-32603, 'The connected wallet is unavailable', ERROR_CODES.CAPABILITY_UNAVAILABLE);
    }
    try {
      assertSupportedSigningWallet(account);
    } catch (error) {
      return refuse(-32603, error.message, error.code);
    }
    if (prompt.kind === 'eth.send') return this.#answerSend(context, prompt, { request, account, chainName, key, refuse });
    const personal = method === 'personal_sign';
    const params = Array.isArray(prompt.params) ? prompt.params : [];
    const claimedAddress = personal ? params[1] : params[0];
    if (typeof claimedAddress === 'string' && claimedAddress.toLowerCase() !== account.address.toLowerCase()) {
      return refuse(-32603, 'Signature account does not match the connected wallet', ERROR_CODES.POLICY_DENIED);
    }
    const exactPayload = personal ? (typeof params[0] === 'string' ? params[0] : '') : exactTypedData(params[1]);
    if (!exactPayload || exactPayload.length > MAX_PAYLOAD_CHARS) {
      return refuse(-32603, 'The signature payload is invalid or too large to review safely', ERROR_CODES.INVALID_ARGUMENT);
    }
    if (!personal) {
      const domainChain = JSON.parse(exactPayload)?.domain?.chainId;
      if (domainChain !== undefined && Number(domainChain) !== chainId) {
        return refuse(-32603, 'Typed-data chain does not match the approved wallet network', ERROR_CODES.POLICY_DENIED);
      }
    }
    const decision = await this.#decide(context, {
      ...request,
      action: 'wallet_signature',
      label: personal ? 'Sign a message' : 'Sign typed data',
      wallet: {
        kind: 'signature',
        chainId,
        chainName,
        account,
        signatureType: personal ? 'Personal message' : 'EIP-712 typed data',
        summary: signatureSummary(view),
        requiresUnlock: account.type === 'mnemonic',
      },
    });
    return {
      handled: true,
      decision: decision.approve === true ? { approve: true } : decision,
      // The signature itself stays out of the receipt.
      receiptOf: (answer) =>
        typeof answer?.result === 'string'
          ? { wallet: { action: 'signed', origin: key, chainId, signatureType: method } }
          : null,
    };
  }

  /**
   * A send's prompt (APB-5b): the agent's own refusals (A7-3) and the fee
   * check's (A7-5) without the sheet; otherwise the sheet, showing the
   * core's view: the transaction it prepared and its quote (A7-7, A7-10).
   */
  async #answerSend(context, prompt, { request, account, chainName, key, refuse }) {
    const { view } = prompt;
    const chainId = view.chain.id;
    const params = Array.isArray(prompt.params) ? prompt.params : [];
    const txParams = params[0];
    if (!txParams || typeof txParams !== 'object' || !txParams.to) {
      return refuse(-32603, 'Transaction parameters are incomplete', ERROR_CODES.INVALID_ARGUMENT);
    }
    if (txParams.chainId !== undefined && Number(txParams.chainId) !== chainId) {
      return refuse(-32603, 'Transaction chain does not match the approved wallet network', ERROR_CODES.POLICY_DENIED);
    }
    if (
      txParams.data !== undefined &&
      (typeof txParams.data !== 'string' ||
        txParams.data.length > MAX_PAYLOAD_CHARS ||
        !/^0x(?:[a-f0-9]{2})*$/i.test(txParams.data))
    ) {
      return refuse(
        -32603,
        'Use valid transaction data no larger than the approval display limit.',
        ERROR_CODES.INVALID_ARGUMENT
      );
    }
    if (txParams.from && String(txParams.from).toLowerCase() !== account.address.toLowerCase()) {
      return refuse(-32603, 'Transaction sender does not match the connected wallet', ERROR_CODES.POLICY_DENIED);
    }
    // The core's quote: with none (a failed read), no fee to show.
    const fee = view.fee;
    let maxFee;
    try {
      maxFee = BigInt(fee?.gasLimit ?? 0) * BigInt(fee?.maxFeePerGas ?? fee?.gasPrice ?? 0);
    } catch {
      maxFee = 0n;
    }
    if (maxFee <= 0n) {
      return refuse(
        -32603,
        'Freedom could not determine the maximum transaction fee. Try again before approving.',
        ERROR_CODES.POLICY_DENIED
      );
    }
    // Above the fee check's threshold, or asked again at the approve: the
    // sheet confirms no fee, so it isn't asked (A7-5).
    if (view.feeCheck?.above === true || view.feeAskAgain === true) {
      const { message } = feeCheckError(FEE_CHECK_ASK_AGAIN, { ratio: view.feeCheck?.ratio ?? '?' });
      return refuse(-32603, message, ERROR_CODES.POLICY_DENIED);
    }
    const chain = this.getChain(chainId);
    const decimals = Number.isSafeInteger(chain?.nativeCurrency?.decimals) ? chain.nativeCurrency.decimals : 18;
    const symbol = bounded(view.chain.symbol, 20);
    const data = typeof view.tx?.data === 'string' && view.tx.data !== '0x' ? view.tx.data : '';
    const decision = await this.#decide(context, {
      ...request,
      action: 'wallet_transaction',
      label: 'Send a wallet transaction',
      wallet: {
        kind: 'transaction',
        chainId,
        chainName,
        account,
        to: bounded(view.tx?.to, 100),
        value: `${displayValue(view.tx?.value, decimals)} ${symbol}`,
        maxFee: `${displayValue(maxFee, decimals)} ${symbol}`,
        data: bounded(data, MAX_PAYLOAD_CHARS),
        requiresUnlock: account.type === 'mnemonic',
      },
    });
    return {
      handled: true,
      decision: decision.approve === true ? { approve: true } : decision,
      // The page's answer, with the payment's record main kept from the
      // page (`paymentId`), as the agent route's receipt had it.
      receiptOf: (answer) =>
        typeof answer?.result === 'string'
          ? {
              wallet: {
                action: 'broadcast',
                origin: key,
                chainId,
                transactionHash: answer.result,
                ...(answer.paymentId !== undefined && answer.paymentId !== null && { paymentId: answer.paymentId }),
              },
            }
          : null,
    };
  }

  // The sheet's decision, as main relays it: approved (with the account a
  // connect picked), declined, or withdrawn.
  async #decide(context, request) {
    const decision = normalizeDecision(await context.requestApproval(request));
    if (decision.status === 'approved') {
      return { approve: true, ...(decision.walletIndex !== undefined && { walletIndex: decision.walletIndex }) };
    }
    return decision.status === 'withdrawn' ? { closed: true } : { approve: false };
  }
}

module.exports = { AgentWalletController };
