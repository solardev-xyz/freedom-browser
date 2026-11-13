'use strict';

/**
 * The wallet's own approvals in the approvals document (freedom-core design
 * 0011, "The approvals document": "From APS-3 it mints none of the wallet's
 * own kinds on its own either: it opens the request in the approvals
 * document, and the token is returned only when the user approves there").
 *
 * With the document on, the chrome's `wallet:confirm-signing` for one of the
 * wallet's six kinds (a send, a Safe send of its own, an intent's resend,
 * replacement or close, an executor's fee) opens a prompt of the window's
 * own in its approvals document (`page-requests.js` `walletPrompt`), with a
 * view main builds from the request it would bind and from its own state:
 * the account, the chain, the fee check's verdict. The token is minted only
 * on the user's approval there. A fee above the threshold is confirmed by a
 * second press, on the prompt main shows again (`feeAskAgain`), as a page's
 * send is: the chrome's own acknowledgement counts for nothing.
 *
 * The chrome's screens still lead up to it (the send form, the held
 * payments, the Safe board's execution); the decision is the document's.
 *
 * A held payment's resend whose approval went stale because the payment was
 * replaced meanwhile (its latest transaction, which the token binds, is
 * another) is asked again by the chrome once (`intent-resend.js`). Main
 * then says why (APS-4): the prompt names the transaction approved before
 * (`replaced`), so the user sees the payment changed, with a higher fee,
 * rather than a second prompt they didn't cause.
 *
 * x402's two kinds ask here too (APS-5), so that with the document on the
 * chrome mints no approval at all: a 402's payment (`x402-payment`), with
 * main's record of its detection (the paid URL, the seller's entry at the
 * chosen index), the active account and the allowance granted with it; and
 * an edit of a site's auto-pay cap (`x402-cap-update`), with the cap as
 * main holds it and the change. An auto-pay within a cap asks nothing, as
 * before.
 */

const PROMPT_KINDS = Object.freeze({
  'wallet-send': 'wallet.send',
  'safe-send': 'wallet.safe_send',
  'intent-resend': 'wallet.intent_resend',
  'intent-replace': 'wallet.intent_replace',
  'intent-close': 'wallet.intent_close',
  'executor-send': 'wallet.executor_send',
  'x402-payment': 'wallet.x402_payment',
  'x402-cap-update': 'wallet.x402_cap_update',
});

const REJECTED = Object.freeze({ approved: false, error: 'User rejected the request', code: 'USER_REJECTED' });
const NO_WINDOW = Object.freeze({ approved: false, error: 'This window has no approvals document', code: 'NO_WINDOW' });
// Past the prompt budget (0011, "Prompt views"): nothing is asked, and no
// token minted.
const LIMITED = Object.freeze({
  approved: false,
  error: 'Too many approvals are waiting in the panel',
  code: 'LIMIT_EXCEEDED',
});
const NO_ACCOUNT = Object.freeze({
  approved: false,
  error: "This request's account isn't in the wallet",
  code: 'ACCOUNT_UNKNOWN',
});

// The kinds whose token binds the index of the account that signs: the
// panel must show that very account, from main's wallet list, or nothing
// is asked. An intent's kinds bind its sender's address instead, which a
// held payment may keep after its account has left the wallet.
const INDEX_BOUND = new Set(['wallet-send', 'safe-send', 'executor-send', 'x402-payment']);

// ERC-20's transfer(address,uint256): the recipient and the amount, read
// from the data main binds, so the panel says what a token send does.
const TRANSFER = /^0xa9059cbb0{24}([0-9a-fA-F]{40})([0-9a-fA-F]{64})$/;

// How long main remembers a resend's approval, to say why it is asked again:
// the life of the token it minted (signing-confirmation.js), within which a
// stale one is refused and asked again at once.
const RESEND_MEMORY_MS = 2 * 60 * 1000;
const RESEND_MEMORY_MAX = 32;

const isQuantity = (value) => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);

function decimal(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const n = BigInt(value);
    return n < 0n ? null : n.toString();
  } catch {
    return null;
  }
}

function hexData(value) {
  if (value === undefined || value === null || value === '') return '0x';
  return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value.toLowerCase() : '0x';
}

/** A transaction's fee fields as main binds them, decimal. */
function feeOf(payload) {
  const fee = { gasLimit: decimal(payload?.gasLimit) };
  const maxFee = decimal(payload?.maxFeePerGas);
  const tip = decimal(payload?.maxPriorityFeePerGas);
  if (maxFee !== null && tip !== null) {
    fee.maxFeePerGas = maxFee;
    fee.maxPriorityFeePerGas = tip;
  } else {
    fee.gasPrice = decimal(payload?.gasPrice);
  }
  return Object.values(fee).every(isQuantity) ? fee : null;
}

function txOf(source) {
  return {
    to: typeof source?.to === 'string' ? source.to : '',
    value: decimal(source?.value) ?? '0',
    data: hexData(source?.data),
  };
}

const textOr = (value, fallback = '') => (typeof value === 'string' ? value : fallback);

function transferOf(tx) {
  const match = TRANSFER.exec(tx.data);
  if (!match) return null;
  return { token: tx.to, recipient: `0x${match[1]}`, amount: BigInt(`0x${match[2]}`).toString() };
}

/**
 * @param {object} deps
 * @param {(windowId: number, spec: object) => Promise<object>} deps.walletPrompt
 * @param {(contents: object) => number|null} deps.chromeWindowOf
 * @param {() => Promise<object[]>} deps.getDerivedWallets
 * @param {(chainId: number) => string|null} deps.chainName
 * @param {(chainId: number) => string|null} deps.nativeSymbol
 * @param {(tx: object) => Promise<object>} deps.checkFees
 * @param {(tx: object, options: object) => Promise<object>} deps.checkAtApproval
 * @param {(chainId: number, asset: string) => object|null} [deps.tokenOf] an
 *   asset main knows: `{ symbol, decimals }` from its token list
 * @param {(accept: object) => object|null} [deps.x402Tuple] an x402 entry's
 *   `{ chainId, asset, amount }`, or null for a network main can't pay on
 * @param {(url: string) => string|null} [deps.x402Origin] the paid URL's
 *   origin, the key its allowance is granted under
 * @param {(origin: string, chainId: number, asset: string) => object|null} [deps.x402Cap]
 *   a site's active auto-pay cap, as main holds it
 * @param {() => number} [deps.now]
 */
function createWalletApprovals({
  walletPrompt,
  chromeWindowOf,
  getDerivedWallets,
  chainName = () => null,
  nativeSymbol = () => null,
  checkFees,
  checkAtApproval,
  tokenOf = () => null,
  x402Tuple = () => null,
  x402Origin = () => null,
  x402Cap = () => null,
  now = () => Date.now(),
}) {
  // A held payment's last approved resend, by intent id: the hash it bound.
  const resends = new Map();

  /**
   * The transaction a resend of this payment was approved for moments ago,
   * when that was another than the one now asked about: the payment was
   * replaced since. Read once.
   */
  function replacedSince(payload) {
    const id = typeof payload?.intentId === 'string' ? payload.intentId : null;
    const last = id === null ? null : resends.get(id);
    if (!last) return null;
    resends.delete(id);
    if (now() - last.at > RESEND_MEMORY_MS) return null;
    return typeof payload.hash === 'string' && last.hash.toLowerCase() !== payload.hash.toLowerCase() ? last.hash : null;
  }

  function rememberResend(payload) {
    if (typeof payload?.intentId !== 'string' || typeof payload.hash !== 'string') return;
    resends.delete(payload.intentId);
    resends.set(payload.intentId, { hash: payload.hash, at: now() });
    while (resends.size > RESEND_MEMORY_MAX) resends.delete(resends.keys().next().value);
  }

  // The account as main's wallet list has it. By index (the account a
  // token signs with): null unless the list is read and has it. By address
  // (an intent's sender): the address alone, `unknown`, when it isn't.
  async function accountOf({ index = null, address = null } = {}) {
    const byIndex = index !== null;
    if (byIndex && !Number.isSafeInteger(index)) return null;
    let wallets;
    try {
      wallets = await getDerivedWallets();
    } catch {
      wallets = null;
    }
    if (!Array.isArray(wallets)) {
      if (byIndex) return null;
      wallets = [];
    }
    const wanted = typeof address === 'string' ? address.toLowerCase() : null;
    const wallet = wallets.find((candidate) =>
      byIndex ? candidate?.index === index : wanted !== null && String(candidate?.address).toLowerCase() === wanted
    );
    if (!wallet && byIndex) return null;
    if (!wallet) return { index: null, name: '', address: typeof address === 'string' ? address : null, type: 'unknown' };
    return {
      index: wallet.index,
      name: typeof wallet.name === 'string' ? wallet.name : '',
      address: typeof wallet.address === 'string' ? wallet.address : null,
      type: typeof wallet.type === 'string' ? wallet.type : 'mnemonic',
    };
  }

  function chainOf(chainId) {
    let name;
    let symbol;
    try {
      name = chainName(chainId) || null;
    } catch {
      name = null;
    }
    try {
      symbol = nativeSymbol(chainId) || null;
    } catch {
      symbol = null;
    }
    return { id: chainId, name, symbol: symbol || 'ETH' };
  }

  // An asset as main's token list has it, for amounts in whole units.
  function tokenView(chainId, asset) {
    let token;
    try {
      token = tokenOf(chainId, asset);
    } catch {
      token = null;
    }
    if (!token || typeof token.symbol !== 'string' || !Number.isSafeInteger(token.decimals)) return null;
    return { symbol: token.symbol, decimals: token.decimals };
  }

  function safely(fn, ...args) {
    try {
      return fn(...args) ?? null;
    } catch {
      return null;
    }
  }

  // A 402's payment (APS-5): the seller's entry as main's record of the
  // detection holds it, and what main makes of it (the chain, the asset).
  function x402PaymentView(account, payload) {
    const accept = payload.accept;
    const tuple = safely(x402Tuple, accept);
    const chainId = Number.isSafeInteger(tuple?.chainId) && tuple.chainId > 0 ? tuple.chainId : null;
    const grant = payload.grant ? { capAmount: payload.grant.capAmount, windowSeconds: payload.grant.windowSeconds } : null;
    return {
      account,
      site: textOr(safely(x402Origin, payload.url)),
      url: textOr(payload.url),
      payment: {
        scheme: textOr(accept.scheme),
        network: textOr(accept.network),
        asset: textOr(accept.asset),
        amount: decimal(accept.amount ?? accept.maxAmountRequired) ?? '0',
        payTo: textOr(accept.payTo),
      },
      chain: chainId === null ? null : chainOf(chainId),
      token: chainId === null ? null : tokenView(chainId, tuple.asset),
      grant,
    };
  }

  // An auto-pay cap's edit (APS-5): the cap as main holds it, and the change.
  function x402CapView(payload) {
    const cap = safely(x402Cap, payload.origin, payload.chainId, payload.asset);
    if (!cap || !payload.current) throw new Error('No such auto-pay cap');
    if (payload.windowSeconds !== null && payload.windowSeconds !== undefined && !Number.isSafeInteger(payload.windowSeconds)) {
      throw new Error('Invalid window');
    }
    const windowSeconds = Number.isSafeInteger(payload.windowSeconds) ? payload.windowSeconds : null;
    return {
      site: textOr(cap.origin),
      chain: chainOf(payload.chainId),
      asset: textOr(payload.asset),
      token: tokenView(payload.chainId, payload.asset),
      current: {
        capAmount: payload.current.capAmount,
        spentAmount: decimal(cap.spentAmount) ?? '0',
        expiresAt: payload.current.expiresAt,
      },
      change: {
        capAmount: typeof payload.capAmount === 'string' ? payload.capAmount : null,
        windowSeconds,
        expiresAt: windowSeconds === null ? null : payload.current.createdAt + windowSeconds,
      },
    };
  }

  /**
   * Main's view of the request, for its kind's template in the document.
   * Null for an index-bound kind whose account main can't show.
   */
  async function viewOf(kind, index, payload, { verdict, askAgain, replaced = null }) {
    const feeCheck = verdict ? { ...verdict } : null;
    let account = null;
    if (INDEX_BOUND.has(kind)) {
      account = Number.isSafeInteger(index) ? await accountOf({ index }) : null;
      if (!account) return null;
    }
    switch (kind) {
      case 'wallet-send': {
        const tx = txOf(payload);
        return {
          account,
          chain: chainOf(payload.chainId),
          tx,
          transfer: transferOf(tx),
          fee: feeOf(payload),
          feeCheck,
          feeAskAgain: askAgain,
        };
      }
      case 'safe-send': {
        const tx = txOf(payload.tx);
        return { account, chain: chainOf(payload.chainId), tx, transfer: transferOf(tx) };
      }
      case 'intent-resend':
        return {
          account: await accountOf({ address: payload.sender }),
          chain: chainOf(payload.chainId),
          nonce: payload.nonce,
          hash: payload.hash,
          replaced,
        };
      case 'intent-replace': {
        const tx = txOf(payload);
        return {
          account: await accountOf({ address: payload.sender }),
          chain: chainOf(payload.chainId),
          nonce: payload.nonce,
          tx,
          transfer: transferOf(tx),
          fee: feeOf(payload),
          feeCheck,
          feeAskAgain: askAgain,
        };
      }
      case 'intent-close':
        return {
          account: await accountOf({ address: payload.sender }),
          chain: chainOf(payload.chainId),
          nonce: payload.nonce,
          hashes: Array.isArray(payload.hashes) ? payload.hashes.slice() : [],
        };
      case 'executor-send':
        return {
          account,
          chain: chainOf(payload.chainId),
          tx: txOf(payload),
          fee: feeOf(payload),
          feeCheck,
          feeAskAgain: askAgain,
        };
      case 'x402-payment':
        return x402PaymentView(account, payload);
      case 'x402-cap-update':
        return x402CapView(payload);
      default:
        throw new Error(`wallet-approvals: no view for ${kind}`);
    }
  }

  async function verdictFor(payload) {
    try {
      return (await checkFees(payload)) || null;
    } catch {
      return null;
    }
  }

  /**
   * Ask the user in `sender`'s window's approvals document. Resolves with
   * `{ approved: true, ...onApproved() }` only on their approval there, the
   * fee confirmed again when it is above the threshold at the press; with
   * a refusal, and nothing asked, for an index-bound kind whose account
   * main can't show, or when the prompt budget is full (`LIMITED`).
   *
   * Each prompt's decision is released (`page-requests.js` `walletPrompt`)
   * once what it started is done: a rejection at once, an approval whose
   * fee is asked again once main has the verdict that asks, and any other
   * approval once `onApproved` (the token's mint) has run, or thrown. The
   * panel's invocation is answered then. The device step comes after, with
   * the token, on the chrome's screen (design 0011: "Device steps keep
   * today's paths after the decision").
   *
   * @param {object} request `{ sender, kind, index, payload, feeChecked }`,
   *   or `windowId` in place of `sender` for a step main itself runs in a
   *   window (a Safe board's executor fee, `safe-boards.js`)
   * @param {() => object} [onApproved] run on the approval, before it is
   *   released; what it returns joins the answer.
   */
  async function confirm({ sender, windowId: inWindow, kind, index, payload, feeChecked }, onApproved = () => ({})) {
    const promptKind = PROMPT_KINDS[kind];
    if (!promptKind) throw new Error(`wallet-approvals: not a wallet kind: ${kind}`);
    let windowId = Number.isInteger(inWindow) ? inWindow : null;
    if (windowId === null) {
      try {
        windowId = chromeWindowOf(sender);
      } catch {
        windowId = null;
      }
    }
    if (!Number.isInteger(windowId)) return NO_WINDOW;
    let verdict = feeChecked ? await verdictFor(payload) : null;
    let askAgain = false;
    const replaced = kind === 'intent-resend' ? replacedSince(payload) : null;
    for (;;) {
      const view = await viewOf(kind, index, payload, { verdict, askAgain, replaced });
      if (!view) return NO_ACCOUNT;
      let release;
      const released = new Promise((resolve) => {
        release = resolve;
      });
      try {
        const decision = await walletPrompt(windowId, {
          kind: promptKind,
          view,
          choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
          released,
          // The chrome's request, kept here while the prompt waits: charged
          // to the prompt budget with its view.
          holds: payload,
        });
        if (decision?.error) return LIMITED;
        if (decision?.approve !== true) return REJECTED;
        if (feeChecked) {
          // The fee at the press (design 0005, A): above the threshold and
          // not yet confirmed again, the prompt is shown again, asking.
          const atPress = await checkAtApproval(payload, { acknowledged: askAgain });
          if (atPress?.askAgain) {
            verdict = { ...atPress };
            delete verdict.askAgain;
            askAgain = true;
            continue;
          }
        }
        const minted = await onApproved();
        if (kind === 'intent-resend') rememberResend(payload);
        return { ...minted, approved: true };
      } finally {
        release();
      }
    }
  }

  return { confirm, viewOf };
}

let shared = null;

/** The app's one instance, or null while the approvals document is off. */
function getWalletApprovals() {
  const { isApprovalsDocumentEnabled } = require('./approvals-document');
  if (!isApprovalsDocumentEnabled()) return null;
  if (!shared) {
    const registry = () => require('../networks/network-registry').getAllNetworks() || {};
    const fees = require('../wallet/fee-check');
    shared = createWalletApprovals({
      walletPrompt: (windowId, spec) => require('../page/page-requests').getPageRequests().walletPrompt(windowId, spec),
      chromeWindowOf: (contents) => {
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.fromWebContents(contents);
        if (!win || win.isDestroyed() || win.webContents !== contents) return null;
        return win.id;
      },
      getDerivedWallets: () => require('../identity-manager').getDerivedWallets(),
      chainName: (chainId) => registry()?.[chainId]?.name ?? null,
      nativeSymbol: (chainId) => {
        const symbol = registry()?.[chainId]?.nativeSymbol;
        return typeof symbol === 'string' ? symbol : null;
      },
      checkFees: (tx) => fees.checkFees(tx),
      checkAtApproval: (tx, options) => fees.checkAtApproval(tx, options),
      tokenOf: (chainId, asset) => {
        const { getToken, getTokenKey } = require('../token-registry');
        return getToken(getTokenKey(chainId, asset)) ?? null;
      },
      x402Tuple: (accept) => require('../x402/payment-utils').tupleFromAccept(accept),
      x402Origin: (url) => require('../x402/intercept').originKeyForUrl(url),
      x402Cap: (origin, chainId, asset) => require('../x402/permissions').getPermission(origin, chainId, asset),
    });
  }
  return shared;
}

module.exports = { PROMPT_KINDS, REJECTED, LIMITED, NO_ACCOUNT, createWalletApprovals, getWalletApprovals, transferOf };
