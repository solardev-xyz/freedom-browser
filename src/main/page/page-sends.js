'use strict';

/**
 * Sends through main (freedom-core design 0011, step PRQ-5b):
 * `eth_sendTransaction`, from every account kind, a Safe account's included.
 *
 * The chrome's `dapp-provider.js` ran a page's send and asked main for a
 * token (`wallet:confirm-signing`, `dapp-send`, or a `safe-send` naming the
 * site) or claimed the site's contract rule (`{ autoApprove, webContentsId }`).
 * Main runs it now, for the attested requester, in today's order:
 *
 *   1. A document with no key is refused ("This page has no address to
 *      connect from yet"). A DNS name over IPNS is checked again before the
 *      key is first used, after every wait, and just before the effect; a
 *      name that has moved answers as a keyless document's would, with
 *      nothing sent.
 *   2. A tab in Agent custody is offered to the agent service, which
 *      answers within the request (`walletOperation`) and sends only once
 *      main's checks pass just before the send.
 *   3. The site must be connected; a Safe sends only on Gnosis. The
 *      transaction's fields get main's shape checks: `to` an address,
 *      `value` a quantity, `data` hex.
 *   4. The site's contract rule ("always allow" on a confirmed send), read
 *      by main for the requester's key, is chosen only outside Agent
 *      custody, read live, for a contract call (never a plain transfer, never
 *      a Safe), with no more value than the send it was recorded from, and
 *      paused while a payment of the site waits (D12, `auto-approve-pause.js`).
 *   5. The rule answers with no prompt, but a locked vault's unlock
 *      (`vault.unlock`), once the fee check lets it (design 0005, A): a fee
 *      that couldn't be compared, is one endpoint's word, or is above the
 *      threshold goes to the prompt instead. Just before the send, after the
 *      last wait (the quote, the fee check, the site's turn, the name),
 *      custody is read again, the rule read again and the document must hold
 *      its key: a guest that entered custody meanwhile is refused
 *      (`agent_custody`), with nothing sent.
 *   6. Otherwise main prompts (`eth.send`) with its own view: the account,
 *      the chain, the transaction in main's form, the quoted fee, the fee
 *      check's verdict and the most the send can cost. On the user's
 *      approval main judges the fee again (`checkAtApproval`); one newly
 *      above the threshold, and not confirmed again, is asked again on a new
 *      prompt. An approval while the fee couldn't be quoted asks for it
 *      again. Then main's own issuer mints the `dapp-send` token for that
 *      approval, bound to the prompt's handle and the requester's key, with
 *      the transaction main holds, and the dispatcher spends it in the same
 *      run as the last checks, just before the send. "Always allow", one of
 *      the prompt's choices, records the contract rule for the requester's
 *      key once the payment is sent.
 *
 * After the signer's wait (a Ledger, the core), and before the signed bytes
 * are recorded or sent, main checks the name, the grant (or the rule and
 * custody) and the document's key again, and withdraws a send that no longer
 * holds, with nothing sent. That check is the gate: once a payment that
 * passed it has gone out, its hash is the requesting document's while that
 * document is live, even if the name moves afterwards. The hash is a public
 * fact about a payment the user approved for this request, and a site told
 * nothing of a payment made could pay again (D13). Unlike a signature
 * (`page-signing.js`), where the signature itself is the effect, nothing is
 * withheld. Every write under the key after the send (the rule's last use, a
 * contract rule) still waits on the name (`recheckThen`): the guard resolves
 * it again and makes the write itself in the same run as its checks, so a
 * name that moved gets no write.
 *
 * Device steps keep today's paths after the decision: a Ledger signs in main,
 * and a phone account's job goes through main's bridge to the chrome's
 * session (`getSigner`, `signAndRecord`). A phone signs and broadcasts in one
 * step, so its send is checked before the phone is asked. A Safe's send is minted a
 * `safe-send` token for the site and starts its SafeTx (`startSafeSend`),
 * whose signing board shows as a second prompt (`eth.safe_send`): the board
 * signs and executes as today, and main answers the page from its own record
 * of the SafeTx's outcome (`onSafeSendSettled`): the execution's hash, or a
 * rejection when it is discarded. Leaving the board parks the SafeTx, and
 * the page waits for its outcome without holding the document's wallet slot.
 * With the approvals document on (APS-3b), main runs that board in the panel
 * itself (`approvals/safe-boards.js`), from the SafeTx it holds.
 * Each execution of it, at once or after it was parked, runs only past the
 * request's guard (`guardSiteSafeSend`): the name, the key and the
 * requesting document checked again. A SafeTx whose site no longer holds is
 * not executed for the site: it stays the wallet's, with no site, and the
 * page gets the keyless answer.
 */

const { KINDS: CONFIRM_KINDS, NOT_CONFIRMED } = require('../wallet/signing-confirmation');
const { guestInCustody } = require('./page-signing');

const SEND_METHODS = Object.freeze(['eth_sendTransaction']);

const INTERNAL_ERROR_CODE = -32603;
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
const NOT_CONNECTED = Object.freeze({ code: 4100, message: 'Not connected. Call eth_requestAccounts first.' });
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
const UNLOCK_CANCELLED = Object.freeze({ code: 4001, message: 'User cancelled unlock' });
// As Swarm and Radicle answer a request Agent custody refuses.
const AGENT_CUSTODY = Object.freeze({
  code: 4100,
  message: 'The origin is not authorized for this operation',
  data: Object.freeze({ reason: 'agent_custody' }),
});
const RULE_GONE = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: "Signing was not confirmed: this request is not covered by the site's auto-approve rules",
});
const ACCOUNT_GONE = Object.freeze({ code: INTERNAL_ERROR_CODE, message: 'The connected account is no longer available' });
const SAFE_OFF_GNOSIS = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: 'This multi-owner account can only transact on Gnosis Chain — switch the app to Gnosis first.',
});
// A phone account's payment whose answer was lost may have been sent (D13):
// never 4001, which says nothing happened, so the site doesn't pay twice.
// The chrome's SITE_OUTCOME_UNKNOWN (intent-texts.js), word for word.
const OUTCOME_UNKNOWN = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
  data: Object.freeze({ outcome: 'unknown' }),
});

// v1 Safes live on Gnosis: a SafeTx for another chain could never execute.
const GNOSIS_CHAIN_ID = 100;

const PHONE_OUTCOME_UNKNOWN = 'REMOTE_OUTCOME_UNKNOWN';
// A device's own "declined" is the user's rejection.
const DEVICE_REJECTIONS = new Set(['LEDGER_USER_REJECTED', 'REMOTE_USER_REJECTED', 'REMOTE_USER_CANCELLED']);

const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

// What autoSend answers when its fee needs the user: the prompt shows it.
const NEEDS_APPROVAL = Symbol('needs approval');

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });
const invalid = (message) => ({ error: { code: -32602, message } });

function redacted(message) {
  try {
    return require('../wallet/rpc-errors').redactRpcText(message) || 'Transaction failed';
  } catch {
    return 'Transaction failed';
  }
}

/** A send's failure, as the page hears it. */
function failure(err, fallback = 'Transaction failed') {
  if (err?.code === PHONE_OUTCOME_UNKNOWN) return error(OUTCOME_UNKNOWN);
  if (DEVICE_REJECTIONS.has(err?.code)) return error(USER_REJECTED);
  const message = typeof err?.message === 'string' && err.message ? err.message : fallback;
  return { error: { code: INTERNAL_ERROR_CODE, message: redacted(message) } };
}

function notConfirmed(reason) {
  const err = new Error(`Signing was not confirmed: ${reason}`);
  err.code = NOT_CONFIRMED;
  return err;
}

/** The 4-byte function selector of `data`, or null for a plain transfer. */
function selectorOf(data) {
  return typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data) ? data.slice(0, 10).toLowerCase() : null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Bytes: pairs of hex digits.
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

/** A quantity as a decimal string, or null when absent. Throws on any other value. */
function quantityOf(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new Error(`Invalid transaction ${field}`);
  }
  let n;
  try {
    n = BigInt(value);
  } catch {
    throw new Error(`Invalid transaction ${field}`);
  }
  if (n < 0n) throw new Error(`Invalid transaction ${field}`);
  return n.toString();
}

/**
 * The page's transaction, checked for form (design 0011, "What a prompt
 * shows"): `to` an address (a contract creation can't be sent, as before),
 * `value` a quantity, `data` hex, and the page's own `gas`, the gas limit
 * used if the estimate gives none. Every other field is the wallet's.
 */
function txOf(params) {
  const raw = Array.isArray(params) ? params[0] : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Transaction parameters are required');
  if (typeof raw.to !== 'string' || !ADDRESS.test(raw.to)) {
    throw new Error('The transaction needs a recipient address (to)');
  }
  const data = raw.data === undefined || raw.data === null || raw.data === '' ? '0x' : raw.data;
  if (typeof data !== 'string' || !HEX_DATA.test(data)) throw new Error('Invalid transaction data');
  return {
    to: raw.to,
    value: quantityOf(raw.value, 'value') ?? '0',
    data,
    gas: quantityOf(raw.gas, 'gas'),
  };
}

/** Main's form of a checked transaction, as the agent service gets it. */
function agentTxOf(tx) {
  return { to: tx.to, value: tx.value, data: tx.data, ...(tx.gas ? { gas: tx.gas } : {}) };
}

/** `to` in checksummed form, as main shows an address. */
function checksummed(address) {
  try {
    return require('ethers').getAddress(address);
  } catch {
    return address;
  }
}

/** The record context of a dApp payment: an ERC-20 transfer's recipient and amount. */
function decodeErc20Transfer(data) {
  if (typeof data !== 'string') return null;
  const hex = data.toLowerCase();
  if (!hex.startsWith(ERC20_TRANSFER_SELECTOR) || hex.length < 138) return null;
  const recipient = hex.slice(10, 74);
  const amount = hex.slice(74, 138);
  if (!/^[0-9a-f]{64}$/.test(recipient) || !/^[0-9a-f]{64}$/.test(amount)) return null;
  return { toAddress: `0x${recipient.slice(24)}`, amount: BigInt(`0x${amount}`).toString(10) };
}

/** The payment-history facts of a dApp send, as the chrome built them (`buildDappTxContext`). */
function paymentContext(tx) {
  const decoded = decodeErc20Transfer(tx.data);
  if (!decoded) return {};
  return {
    asset: String(tx.to).toLowerCase(),
    toAddress: decoded.toAddress,
    amount: decoded.amount,
    metadata: { erc20Method: 'transfer' },
  };
}

/** A Safe board's presentation of a dApp's SafeTx, as the chrome built it (`buildSafeDappDisplay`). */
function safeDisplay(tx, site) {
  const decoded = decodeErc20Transfer(tx.data);
  const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
  if (decoded) {
    return {
      site,
      asset: String(tx.to).toLowerCase(),
      toAddress: decoded.toAddress,
      amount: decoded.amount,
      label: `sending tokens to ${short(decoded.toAddress)}`,
    };
  }
  if (!tx.data || tx.data === '0x') return { site, asset: null, toAddress: tx.to, amount: tx.value };
  return { site, asset: null, toAddress: tx.to, amount: tx.value, label: `a contract call to ${short(tx.to)}` };
}

function defaultPaymentDependencies() {
  return {
    takeSiteTurn: (site, options) => require('../wallet/auto-approve-pause').takeSiteTurn(site, options),
    sitePaymentWaiting: (site) => require('../wallet/auto-approve-pause').sitePaymentWaiting(site),
    getSigner: (walletIndex) => require('../wallet/signers').getSigner(walletIndex),
    signAndRecord: (tx, signer, context, options) =>
      require('../wallet/tx-recorder').signAndRecord(tx, signer, context, options),
  };
}

/**
 * A refusal a send's guard throws, with the page's answer: nothing is
 * signed, or nothing signed is recorded or sent. Its code passes through the
 * transaction service unchanged (`toSendError`).
 */
function withdrawn(answer) {
  return Object.assign(new Error('The request was withdrawn before its payment was sent'), {
    code: 'INTENT_WITHDRAWN',
    answer,
  });
}

/**
 * A dApp's payment, once main has authorized it: signed and sent by the
 * account's own signer (a Ledger in main, a phone through main's bridge),
 * and recorded under the site it is for.
 *
 * D12 (`auto-approve-pause.js`): the site's sends take turns until each
 * one's payment is committed. A send the rule answers (`silent`) doesn't
 * wait for one: with another of the site's payments under way it is paused,
 * and in its turn it stops if one of the site's payments is waiting. A send
 * the user confirmed waits for its turn and goes on.
 *
 * Two guards, each of which runs its effect itself, in the same run as its
 * last checks, or throws `withdrawn(answer)`:
 *   - `guard(send)`, in the send's turn, just before the signature;
 *   - `afterSignature(commit)`, after the signer's wait (a Ledger, the core)
 *     and before the signed bytes are recorded and sent
 *     (`signAndSendTransaction`'s `guardCommit`). A phone signs and
 *     broadcasts in one step: its payment has no such point.
 *
 * @returns {Promise<object>} what `signAndRecord` answered. Throws when the
 *   send fails or a guard withdraws it.
 */
async function sendDappPayment(
  { walletIndex, tx, site, silent = false, guard = null, afterSignature = null },
  deps = {}
) {
  const { takeSiteTurn, sitePaymentWaiting, getSigner, signAndRecord } = { ...defaultPaymentDependencies(), ...deps };
  const paused = () => notConfirmed('auto-approve is paused while a payment this site requested is waiting');
  let release = null;
  try {
    try {
      release = await takeSiteTurn(site, { wait: !silent });
    } catch (err) {
      throw silent && err?.code === 'SITE_TURN_BUSY' ? paused() : err;
    }
    if (silent && (await sitePaymentWaiting(site))) throw paused();
    const send = () =>
      signAndRecord(
        tx,
        getSigner(walletIndex),
        { kind: 'dapp-send', origin: site, ...paymentContext(tx) },
        { walletIndex, onCommitted: release, guardCommit: afterSignature }
      );
    return await (guard ? guard(send) : send());
  } finally {
    release?.();
  }
}

function defaultSendDependencies() {
  return {
    ...defaultPaymentDependencies(),
    inCustody: guestInCustody,
    isVaultUnlocked: () => require('../identity-manager').isVaultUnlocked(),
    ruleMatches: (key, to, selector, chainId, value) =>
      require('../wallet/dapp-permissions').isTransactionAutoApproved(key, to, selector, chainId, value),
    rulePaused: (key) => require('../wallet/auto-approve-pause').transactionAutoApprovePaused(key),
    addTransactionAutoApprove: (key, to, selector, chainId, value) =>
      require('../wallet/dapp-permissions').addTransactionAutoApprove(key, to, selector, chainId, value),
    estimateGas: (request) => require('../wallet/transaction-service').estimateGas(request),
    getGasPrices: (chainId) => require('../wallet/transaction-service').getGasPrices(chainId),
    checkFees: (tx) => require('../wallet/fee-check').checkFees(tx),
    checkAtApproval: (tx, options) => require('../wallet/fee-check').checkAtApproval(tx, options),
    startSafeSend: (options) => require('../wallet/safe/safe-transactions').startSafeSend(options),
    onSafeSendSettled: (listener) => require('../wallet/safe/safe-transactions').onSafeSendSettled(listener),
    guardSiteSafeSend: (safeTxHash, guard) =>
      require('../wallet/safe/safe-transactions').guardSiteSafeSend(safeTxHash, guard),
    siteWithdrawn: () => {
      const { codedError, SAFE_SITE_WITHDRAWN } = require('../wallet/safe/errors');
      return codedError('The site no longer holds this transaction', SAFE_SITE_WITHDRAWN);
    },
    // The boards main runs in the approvals document (APS-3b).
    safeBoards: () => require('../approvals/safe-boards').getSafeBoards(),
  };
}

/**
 * @param {object} shared from page-ethereum.js: `getPermission`,
 *   `updateLastUsed`, `walletList`, `chainIdOf`, `chainName`, `networks` and
 *   `agentAnswer`.
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {Record<string, (context: object) => Promise<object>>} keyed
 *   `ethereum:<method>`.
 */
function createSendDispatchers(shared, deps = {}) {
  const { getPermission, updateLastUsed, walletList, chainIdOf, chainName, networks, agentAnswer } = shared;
  const d = { ...defaultSendDependencies(), ...deps };
  const paymentDeps = {
    takeSiteTurn: d.takeSiteTurn,
    sitePaymentWaiting: d.sitePaymentWaiting,
    getSigner: d.getSigner,
    signAndRecord: d.signAndRecord,
  };

  const custody = (guest) => {
    try {
      return d.inCustody(guest) === true;
    } catch {
      // Unknown custody counts as custody: no rule answers for it.
      return true;
    }
  };

  // The key's grant, but only while it exposes exactly `walletIndex`: a
  // rule, or a confirmed send, is for the account the site is connected
  // with.
  function grantExposes(key, walletIndex) {
    const permission = getPermission(key);
    return permission && permission.walletIndex === walletIndex ? permission : null;
  }

  function chainView(chainId) {
    let name;
    let symbol;
    try {
      name = chainName(chainId) || null;
    } catch {
      name = null;
    }
    try {
      const known = networks()?.[chainId];
      symbol = typeof known?.nativeSymbol === 'string' ? known.nativeSymbol : null;
    } catch {
      symbol = null;
    }
    return { id: chainId, name, symbol: symbol || 'ETH' };
  }

  // The rule's own match, read now: the grant exposing the account, a
  // contract call, and a rule for its contract, selector and chain with no
  // less value than this send's.
  function ruleMatches(key, walletIndex, tx, chainId) {
    if (!grantExposes(key, walletIndex)) return false;
    const selector = selectorOf(tx.data);
    if (!selector) return false;
    try {
      return d.ruleMatches(key, tx.to, selector, chainId, tx.value) === true;
    } catch {
      return false;
    }
  }

  // Whether the rule answers this request, chosen now: it matches, and it
  // isn't paused for a payment of the site that waits (D12).
  async function ruleChosen(key, walletIndex, tx, chainId) {
    if (!ruleMatches(key, walletIndex, tx, chainId)) return false;
    try {
      return (await d.rulePaused(key)) !== true;
    } catch {
      return false;
    }
  }

  async function vaultUnlocked() {
    try {
      return (await d.isVaultUnlocked()) === true;
    } catch {
      return false;
    }
  }

  const accountView = (account) => ({
    index: account.index,
    name: typeof account.name === 'string' ? account.name : '',
    address: typeof account.address === 'string' ? account.address : null,
    type: typeof account.type === 'string' ? account.type : 'mnemonic',
  });

  /**
   * The fee main quotes for the send: the estimate's gas limit (or the
   * page's own `gas` when it gives none) and today's fee quote, the fields
   * main signs with. Throws when either can't be had.
   */
  async function quote(ctx) {
    const [estimate, prices] = await Promise.all([
      d.estimateGas({ from: ctx.address, to: ctx.tx.to, value: ctx.tx.value, data: ctx.tx.data, chainId: ctx.chainId }),
      d.getGasPrices(ctx.chainId),
    ]);
    const gasLimit = quantityOf(estimate?.gasLimit, 'gas') || ctx.tx.gas;
    const fees =
      prices?.type === 'eip1559'
        ? { maxFeePerGas: quantityOf(prices.maxFeePerGas, 'fee'), maxPriorityFeePerGas: quantityOf(prices.maxPriorityFeePerGas, 'fee') }
        : { gasPrice: quantityOf(prices?.gasPrice, 'fee') };
    const named = fees.gasPrice || (fees.maxFeePerGas && fees.maxPriorityFeePerGas);
    if (!gasLimit || !named) throw new Error('Unable to estimate the network fee');
    const perGas = quantityOf(prices?.effectiveGasPrice, 'fee') || fees.maxFeePerGas || fees.gasPrice;
    return {
      gasLimit,
      ...Object.fromEntries(Object.entries(fees).filter(([, value]) => value !== null)),
      estimate: (BigInt(gasLimit) * BigInt(perGas)).toString(),
    };
  }

  /** The transaction main signs: the page's fields, the quote's gas limit and fees, the page's chain. */
  function sendTxOf(ctx, quoted) {
    const { estimate: _estimate, ...fees } = quoted;
    return { to: ctx.tx.to, value: ctx.tx.value, data: ctx.tx.data, chainId: ctx.chainId, ...fees };
  }

  async function verdictOf(tx) {
    try {
      return (await d.checkFees(tx)) || null;
    } catch {
      return null;
    }
  }

  // Main's view of the send (design 0011, "What a prompt shows").
  function sendView(ctx, { quoted, verdict, askAgain }) {
    return {
      account: ctx.account,
      chain: ctx.chain,
      tx: { to: checksummed(ctx.tx.to), value: ctx.tx.value, data: ctx.tx.data },
      // A Safe's executor pays, at its execution; otherwise the quote, or
      // null when it couldn't be had.
      fee: ctx.safe
        ? { paidBy: 'executor' }
        : quoted
          ? { ...quoted }
          : null,
      // The fee check's verdict, and the most the send can cost. A phone
      // picks and pays its own fee, and a Safe's is checked as it executes.
      feeCheck: verdict ? { ...verdict } : null,
      // Main asked again at the press: the fee is newly above the threshold.
      feeAskAgain: askAgain === true,
      // "Always allow" is offered for a contract call, never a Safe's.
      alwaysAllow: !ctx.safe && Boolean(selectorOf(ctx.tx.data)),
    };
  }

  // The choices the user may make: "always allow", and the fee confirmed
  // again when it was above the threshold.
  const sendChoices = (raw) =>
    Object.keys(raw).every((name) => name === 'alwaysAllow' || name === 'feeAcknowledged') &&
    (raw.alwaysAllow === undefined || typeof raw.alwaysAllow === 'boolean') &&
    (raw.feeAcknowledged === undefined || typeof raw.feeAcknowledged === 'boolean')
      ? { alwaysAllow: raw.alwaysAllow === true, feeAcknowledged: raw.feeAcknowledged === true }
      : null;

  /**
   * A write under the key after a send's wait (the device, the bridge, the
   * core): the name resolved again, then, in one run, the document holding
   * its key and the grant exposing the account, and the write (the rule's
   * last use, a contract rule) made by this guard itself, never after an
   * await of the caller's. False, with nothing written, when the name or the
   * key no longer holds. The send's hash goes to the page either way: the
   * payment has gone out.
   */
  async function recheckThen(context, ctx, write = null) {
    if (!(await context.nameHolds())) return false;
    // From here to the write, one run: no other check can end the binding.
    if (!context.holdsKey()) return false;
    if (write && grantExposes(context.requester.key, ctx.walletIndex)) {
      try {
        write();
      } catch {
        // The payment stands; the write didn't happen.
      }
    }
    return true;
  }

  // The site's rule answers: no prompt but a locked vault's unlock, and only
  // once the fee check lets it.
  async function autoSend(context, ctx) {
    const { requester } = context;
    if (!(await vaultUnlocked())) {
      const unlock = await context.prompt({
        kind: 'vault.unlock',
        view: { account: ctx.account, reason: 'send' },
        choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
      });
      if (unlock.error) return { error: unlock.error };
      if (unlock.closed || unlock.approve !== true) return error(UNLOCK_CANCELLED);
    }
    let quoted;
    try {
      quoted = await quote(ctx);
    } catch (err) {
      return failure(err);
    }
    const tx = sendTxOf(ctx, quoted);
    // Design 0005, A: a phone picks and pays its own fee, and has none to check.
    if (!ctx.phone) {
      const verdict = await verdictOf(tx);
      if (!verdict?.autoApprove) {
        ctx.quoted = quoted;
        ctx.verdict = verdict;
        return NEEDS_APPROVAL;
      }
    }
    // Just before the signature, after the last wait, and again after the
    // signer's: the name, custody, the rule and the document's key.
    const ruleStillAnswers = async (effect) => {
      if (!(await context.nameHolds())) throw withdrawn(error(NO_ADDRESS));
      if (custody(requester.guest)) throw withdrawn(error(AGENT_CUSTODY));
      if (!ruleMatches(requester.key, ctx.walletIndex, ctx.tx, ctx.chainId)) throw withdrawn(error(RULE_GONE));
      if (!context.holdsKey()) throw withdrawn(error(NO_ADDRESS));
      return effect();
    };
    let sent;
    try {
      sent = await sendDappPayment(
        { walletIndex: ctx.walletIndex, tx, site: requester.key, silent: true, guard: ruleStillAnswers, afterSignature: ruleStillAnswers },
        paymentDeps
      );
    } catch (err) {
      return err?.answer ?? failure(err);
    }
    // The site's last use, only while the name still answers. The hash is
    // the page's: the payment has gone out.
    await recheckThen(context, ctx, () => updateLastUsed(requester.key));
    return { result: sent.hash };
  }

  // The user confirmed the send: main's issuer mints its token, spent in the
  // same run as the last checks, just before the signature.
  async function confirmedSend(context, ctx, tx, choices) {
    const { requester } = context;
    const payload = { ...tx, origin: requester.key };
    // The name, the grant and the document's key, in the same run as the
    // effect: the signature, and after the signer's wait the send.
    const stillHeld = (effect) => async (run) => {
      if (!(await context.nameHolds())) throw withdrawn(error(NO_ADDRESS));
      if (!grantExposes(requester.key, ctx.walletIndex)) throw withdrawn(error(NOT_CONNECTED));
      if (!context.holdsKey()) throw withdrawn(error(NO_ADDRESS));
      effect?.();
      return run();
    };
    // Just before the signature, main's issuer mints the token for this
    // approval and the dispatcher spends it.
    const spendToken = () => {
      const token = context.confirm(CONFIRM_KINDS.DAPP_SEND, ctx.walletIndex, payload);
      context.spend(token, CONFIRM_KINDS.DAPP_SEND, ctx.walletIndex, payload);
    };
    let sent;
    try {
      sent = await sendDappPayment(
        {
          walletIndex: ctx.walletIndex,
          tx,
          site: requester.key,
          silent: false,
          guard: stillHeld(spendToken),
          afterSignature: stillHeld(null),
        },
        paymentDeps
      );
    } catch (err) {
      return err?.answer ?? failure(err);
    }
    // "Always allow": the contract rule, for the requester's key, from the
    // transaction the user just confirmed, so it covers only a (contract,
    // selector, chain) the user saw, with no more value than this send's;
    // written only while the name still answers after the send's wait. The
    // hash is the page's either way: the payment has gone out.
    const selector = selectorOf(tx.data);
    if (choices.alwaysAllow === true && selector) {
      await recheckThen(context, ctx, () =>
        d.addTransactionAutoApprove(requester.key, tx.to, selector, ctx.chainId, tx.value)
      );
    }
    return { result: sent.hash };
  }

  // A SafeTx's outcome, from main's own record of it: executed, discarded,
  // or the request answered some other way (its document gone).
  function settledOutcome(context, safeIndex, safeTxHash) {
    return new Promise((resolve) => {
      const { signal } = context;
      let stop = () => {};
      const finish = (outcome) => {
        stop();
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({ outcome: 'gone' });
      if (signal.aborted) {
        resolve({ outcome: 'gone' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        stop = d.onSafeSendSettled((event) => {
          if (event?.safeIndex === safeIndex && event?.safeTxHash === safeTxHash) finish(event);
        });
      } catch {
        finish({ outcome: 'gone' });
      }
    });
  }

  // A Safe's send, once the user confirmed it: a `safe-send` token for the
  // site, the SafeTx started (the vault owners sign at once), and its board
  // as a second prompt. The page gets the execution's hash.
  async function safeSend(context, ctx) {
    const { requester } = context;
    const safeTx = { to: ctx.tx.to, value: ctx.tx.value, data: ctx.tx.data };
    const payload = { tx: safeTx, chainId: ctx.chainId, origin: requester.key };
    if (!(await context.nameHolds())) return error(NO_ADDRESS);
    if (!grantExposes(requester.key, ctx.walletIndex)) return error(NOT_CONNECTED);
    if (!context.holdsKey()) return error(NO_ADDRESS);
    let started;
    try {
      // In the same run as the checks: the token minted, spent, and the
      // SafeTx started.
      const token = context.confirm(CONFIRM_KINDS.SAFE_SEND, ctx.walletIndex, payload);
      context.spend(token, CONFIRM_KINDS.SAFE_SEND, ctx.walletIndex, payload);
      started = await d.startSafeSend({
        safeIndex: ctx.walletIndex,
        tx: safeTx,
        display: safeDisplay(ctx.tx, requester.key),
        chainId: ctx.chainId,
      });
    } catch (err) {
      return failure(err);
    }
    const safeTxHash = started?.safeTxHash;
    const settled = settledOutcome(context, ctx.walletIndex, safeTxHash);
    // Before each step that can execute the SafeTx, now or after it was
    // parked: the name, the key, the grant and the requesting document, checked again
    // in the same run as the execution, which the guard runs itself. A
    // SafeTx whose site no longer holds isn't executed for the site: it stays
    // the wallet's, with no site (`safe-transactions.js`), and the page gets
    // the keyless answer. Once the request has ended, there is no guard, and
    // the SafeTx is never executed for the site.
    let withdraw;
    const withdrawn = new Promise((resolve) => {
      withdraw = () => resolve({ outcome: 'withdrawn' });
    });
    const stopGuard = d.guardSiteSafeSend(safeTxHash, async (execute) => {
      const live = () => !context.signal.aborted;
      if (
        !live() ||
        !(await context.nameHolds()) ||
        !live() ||
        !context.holdsKey() ||
        !grantExposes(requester.key, ctx.walletIndex)
      ) {
        withdraw();
        throw d.siteWithdrawn();
      }
      return execute();
    });
    // The board: it signs and executes as today. Leaving it parks the
    // SafeTx, and the page waits for its outcome, without the document's
    // wallet slot. With the approvals document on (APS-3b), main runs it in
    // the panel, and its execution reaches `settled` as the chrome's did;
    // the board acts only on the SafeTx this request started.
    const boards = context.approvalsDocument ? d.safeBoards() : null;
    const shown = boards
      ? boards.runSendBoard(context, { safeIndex: ctx.walletIndex, safeTxHash }).catch(() => ({ outcome: 'failed' }))
      : context.prompt({
          kind: 'eth.safe_send',
          view: { safeIndex: ctx.walletIndex, state: started },
          choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
        });
    const board = shown.then((decision) => {
      context.leaveWalletSlot();
      return { board: decision };
    });
    let outcome;
    try {
      const first = await Promise.race([settled, withdrawn, board]);
      outcome = first.board ? await Promise.race([settled, withdrawn]) : first;
    } finally {
      stopGuard();
    }
    if (outcome.outcome === 'withdrawn') return error(NO_ADDRESS);
    if (outcome.outcome !== 'executed' || typeof outcome.hash !== 'string') return error(USER_REJECTED);
    // The SafeTx the user approved for this request has executed: its hash
    // is the page's while the document is live, whatever the name does.
    return { result: outcome.hash };
  }

  // The user decides, on main's prompt, and main's issuer mints the token.
  // With the approvals document on, a vault account's prompt asks for the
  // vault unlocked first (APS-2): the document has no unlock of its own in
  // the signing screen, as the chrome's had. Devices and Safes need none.
  async function unlockFirst(context, ctx, reason) {
    if (!context.approvalsDocument || ctx.account?.type !== 'mnemonic' || ctx.safe || ctx.phone || (await vaultUnlocked())) return null;
    const unlock = await context.prompt({
      kind: 'vault.unlock',
      view: { account: ctx.account, reason },
      choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
    });
    if (unlock.error) return { error: unlock.error };
    if (unlock.closed || unlock.approve !== true) return error(UNLOCK_CANCELLED);
    return null;
  }

  async function promptedSend(context, ctx) {
    const locked = await unlockFirst(context, ctx, 'send');
    if (locked) return locked;
    let quoted = ctx.quoted;
    let verdict = ctx.verdict ?? null;
    let askAgain = false;
    for (;;) {
      if (!ctx.safe && quoted === undefined) {
        try {
          quoted = await quote(ctx);
        } catch {
          quoted = null;
        }
        verdict = quoted && !ctx.phone ? await verdictOf(sendTxOf(ctx, quoted)) : null;
      }
      const decision = await context.prompt({
        kind: 'eth.send',
        view: sendView(ctx, { quoted, verdict, askAgain }),
        choices: sendChoices,
      });
      if (decision.error) return { error: decision.error };
      if (decision.closed || decision.approve !== true) return error(USER_REJECTED);
      if (ctx.safe) return safeSend(context, ctx);
      // No fee to confirm: the approval asks for the quote again.
      if (!quoted) {
        quoted = undefined;
        askAgain = false;
        continue;
      }
      const tx = sendTxOf(ctx, quoted);
      // The fee check at the moment of approval (design 0005, A): a fee
      // newly above the threshold, not confirmed again, is asked again.
      if (!ctx.phone) {
        let atApproval;
        try {
          atApproval = await d.checkAtApproval(tx, { acknowledged: decision.choices.feeAcknowledged === true });
        } catch (err) {
          return failure(err);
        }
        if (atApproval?.askAgain) {
          verdict = atApproval;
          askAgain = true;
          continue;
        }
      }
      return confirmedSend(context, ctx, tx, decision.choices);
    }
  }

  async function send(context) {
    const { requester, params } = context;
    if (!requester.key) return error(NO_ADDRESS);
    // The transaction's form, checked before anything else, in custody or
    // not: a malformed one is refused at once (-32602), and the agent gets
    // only main's form of a well-formed one (the page's `from` and `chainId`
    // ignored, as on main's own path).
    let tx;
    try {
      tx = txOf(params);
    } catch (err) {
      return invalid(err.message);
    }
    // No keyless answer is set on the record (`nameHolds`' option): every
    // refusal before the send answers NO_ADDRESS itself, and after a send
    // that passed main's gate the hash is the document's (see the header).
    if (!(await context.nameHolds())) return error(NO_ADDRESS);
    // A tab the agent holds: the agent service answers, within the request,
    // and sends only past main's gate just before its send and after its
    // signature. Only a tab in custody is offered to it.
    const agent = custody(requester.guest) ? await agentAnswer(context, {}, [agentTxOf(tx)]) : null;
    // Refused because the name moved: the keyless answer. Sent: the hash.
    if (agent) return agent.error && !context.holdsKey() ? error(NO_ADDRESS) : agent;
    if (!(await context.nameHolds())) return error(NO_ADDRESS);
    const permission = getPermission(requester.key);
    if (!permission) return error(NOT_CONNECTED);
    const walletIndex = permission.walletIndex;
    // The chain this page reads (an onchain app's own), never the grant's.
    const chainId = chainIdOf(requester);
    const account = (await walletList()).find((candidate) => candidate?.index === walletIndex);
    if (!account) return error(ACCOUNT_GONE);
    const safe = account.type === 'safe';
    if (safe && chainId !== GNOSIS_CHAIN_ID) return error(SAFE_OFF_GNOSIS);
    const ctx = {
      walletIndex,
      chainId,
      chain: chainView(chainId),
      account: accountView(account),
      address: account.address,
      safe,
      phone: account.type === 'remote',
      tx,
      quoted: undefined,
      verdict: null,
    };
    // A standing rule is chosen only outside Agent custody, read live now.
    // A request that goes to its prompt keeps it, whatever custody does
    // next; one the rule answers reads custody again just before its send.
    if (!safe && !custody(requester.guest) && (await ruleChosen(requester.key, walletIndex, tx, chainId))) {
      if (!(await context.nameHolds())) return error(NO_ADDRESS);
      const out = await autoSend(context, ctx);
      if (out !== NEEDS_APPROVAL) return out;
    }
    if (!(await context.nameHolds())) return error(NO_ADDRESS);
    return promptedSend(context, ctx);
  }

  const dispatchers = {};
  for (const method of SEND_METHODS) dispatchers[`ethereum:${method}`] = send;
  return dispatchers;
}

module.exports = {
  SEND_METHODS,
  createSendDispatchers,
  sendDappPayment,
  txOf,
};
