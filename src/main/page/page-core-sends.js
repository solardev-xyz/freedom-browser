'use strict';

/**
 * Main's steps for a page's send once the identity core has decided it
 * (freedom-core design 0012, "Transaction building", "A device send's rule",
 * "Phone jobs"; APR-5e; step APB-4c).
 *
 * The core prepares a page's `eth_sendTransaction` itself (the gas limit
 * from its estimate, the fees from its own quote), asks through main's
 * `eth.send` prompt or answers it by the site's rule, and hands main what
 * main still owns in Stage 1: the site's turn (D12), the nonce, the intent
 * journal and the broadcast. `page-eip1193.js` checks each answer against
 * the request first (its kind, its account, the transaction the page asked
 * for on the page's chain, the fee the user approved, and the handle main
 * approved the core's prompt on), and hands it here:
 *
 *   - **`{ send: { kind, account, tx, handle, token } }`**, a vault
 *     account's approved send (`pay`): the site's turn, waited for; then
 *     under the account's lock the nonce, and only the nonce, added to the
 *     core's transaction; `sign.transaction` with `{ token, kind, handle }`
 *     under the request's PageContext, which refuses any other changed
 *     field; the signed bytes committed to `wallet-intents.jsonl`; the
 *     broadcast; and the page's answer, the hash. "Always allow" ticked on a
 *     contract call rides in the token, and the core writes its rule as it
 *     signs; main reports what the core said.
 *   - **`{ send: { kind, account, tx, standing: true } }`**, a send the
 *     site's rule answers (`pay`): the site's turn without waiting, refused
 *     while another of the site's payments is under way or waiting (D12's
 *     text); the signature under `{ standing: { paused: false } }`, which the
 *     core judges and counts again; then, after the broadcast, the key's last
 *     use (`approval.touch`).
 *   - **A device's send** (`device`): a Ledger's (`ledger`) as a vault
 *     send, with its token spent through the core (`approval.spend`) before
 *     the device is asked, and, for "Always allow", the finalize receipt
 *     that spend gives presented once the device signed and main recorded
 *     the send (`approval.remember`); a phone's (`remote`) as the core's job
 *     (`phone.job`), which spends the token, and whose phone picks its own
 *     nonce and fee and broadcasts; a Safe's (`safe-send`) spent for a Safe
 *     approval, its SafeTx started, and its board shown, the page getting
 *     the execution's hash.
 *
 * Main checks an IPNS-served page's name itself, where the reference did:
 * in the send's turn just before the signature, and after a signer's wait
 * before the signed bytes are recorded or sent (the core resolves no name
 * for a send in cored 0.20.0). Once a payment that passed that gate has
 * gone out, its hash is the requesting document's (`page-sends.js`'s
 * header, D13); a write under the key after it (the last use, a device's
 * rule) waits on the name again.
 *
 * The token is a bearer secret: it goes only to the core's spend or
 * signature, is never logged or put in an error, and never reaches a
 * renderer. Main discards it once the step ends, spent or not.
 *
 * The send's steps after the decision are main's own route's
 * (`page-sends.js`), shared with it until APB-4d removes that route.
 */

const { NOT_CONFIRMED } = require('../wallet/signing-confirmation');
const { guestInCustody } = require('./page-signing');
const {
  sendDappPayment,
  failure,
  reportRule,
  reportPhoneRuleWaits,
  withdrawn,
  safeDisplay,
} = require('./page-sends');

const INTERNAL_ERROR_CODE = -32603;
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
const NOT_CONNECTED = Object.freeze({ code: 4100, message: 'Not connected. Call eth_requestAccounts first.' });
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
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
// The core's refusals of a rule's signature that mean the rule no longer
// answers it. The reference sent a fee or a rate the core no longer allowed
// to the prompt; after `{ send }` the core's request is over, so the page
// hears that the rule didn't cover it, with nothing signed.
const RULE_REASONS = new Set(['no_rule', 'not_exposed', 'rate_limited', 'fee_check', 'warning']);
const VAULT_TYPES = new Set([undefined, null, 'mnemonic']);

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });

/**
 * The core's transaction (`sign.transaction`'s form, no nonce) in main's
 * form, as `signAndRecord` takes a send: the same fields, which
 * `buildTransaction` and `toCoreTransaction` give back unchanged, with the
 * nonce the only one added.
 */
function mainTxOf(tx) {
  const out = { to: tx.to, value: tx.value, data: tx.data, chainId: Number(tx.chain_id), gasLimit: tx.gas_limit };
  if (tx.type === 2) {
    out.maxFeePerGas = tx.max_fee_per_gas;
    out.maxPriorityFeePerGas = tx.max_priority_fee_per_gas;
  } else {
    out.gasPrice = tx.gas_price;
  }
  return out;
}

function defaultDependencies() {
  return {
    takeSiteTurn: (site, options) => require('../wallet/auto-approve-pause').takeSiteTurn(site, options),
    sitePaymentWaiting: (site) => require('../wallet/auto-approve-pause').sitePaymentWaiting(site),
    getSigner: (walletIndex, authorized) => require('../wallet/signers').getSigner(walletIndex, authorized),
    signAndRecord: (tx, signer, context, options) =>
      require('../wallet/tx-recorder').signAndRecord(tx, signer, context, options),
    inCustody: guestInCustody,
    rememberDeviceSend: (held) => require('../wallet/signing-confirmation').rememberDeviceSend(held),
    discardToken: (token) => require('../wallet/signing-confirmation').discardConfirmation(token),
    spendSafe: (confirmation) => require('../wallet/signing-confirmation').spendSafeConfirmation(confirmation),
    startSafeSend: (options) => require('../wallet/safe/safe-transactions').startSafeSend(options),
    reserveSafeSend: (safeIndex) => require('../wallet/safe/safe-transactions').reserveSafeSend(safeIndex),
    onSafeSendSettled: (listener) => require('../wallet/safe/safe-transactions').onSafeSendSettled(listener),
    guardSiteSafeSend: (safeTxHash, guard) =>
      require('../wallet/safe/safe-transactions').guardSiteSafeSend(safeTxHash, guard),
    siteWithdrawn: () => {
      const { codedError, SAFE_SITE_WITHDRAWN } = require('../wallet/safe/errors');
      return codedError('The site no longer holds this transaction', SAFE_SITE_WITHDRAWN);
    },
    safeBoards: () => require('../approvals/safe-boards').getSafeBoards(),
  };
}

/**
 * @param {object} shared from page-ethereum.js: `getPermission`,
 *   `updateLastUsed` (`(context)`: the request's last use, written by the
 *   core under its PageContext) and `walletList`.
 * @param {object} [deps] injected for tests; each defaults to main's own.
 */
function createCoreSends(shared, deps = {}) {
  const { getPermission, updateLastUsed, walletList } = shared;
  const d = { ...defaultDependencies(), ...deps };
  const paymentDeps = {
    takeSiteTurn: d.takeSiteTurn,
    sitePaymentWaiting: d.sitePaymentWaiting,
    getSigner: d.getSigner,
    signAndRecord: d.signAndRecord,
  };

  const discard = (token) => {
    try {
      Promise.resolve(d.discardToken(token)).catch(() => {});
    } catch {
      // Burnt by the core at its life's end all the same.
    }
  };

  // Unknown custody counts as custody.
  const custody = (guest) => {
    try {
      return d.inCustody(guest) === true;
    } catch {
      return true;
    }
  };

  // The key's grant, but only while it exposes exactly `walletIndex`.
  function grantExposes(key, walletIndex) {
    const permission = getPermission(key);
    return Boolean(permission && permission.walletIndex === walletIndex);
  }

  // The account as main lists it now, or null.
  async function listed(account) {
    let wallets;
    try {
      wallets = await walletList();
    } catch {
      wallets = [];
    }
    return (Array.isArray(wallets) ? wallets : []).find((candidate) => candidate?.index === account) || null;
  }

  /**
   * A write under the key after a send's wait: the name resolved again,
   * then, in one run, the document holding its key, the grant exposing the
   * account, and the write made here. False, with nothing written, when the
   * name or the key no longer holds; the hash is the page's either way.
   */
  async function recheckThen(context, walletIndex, write) {
    if (!(await context.nameHolds())) return false;
    if (!context.holdsKey()) return false;
    if (grantExposes(context.requester.key, walletIndex)) {
      try {
        Promise.resolve(write()).catch(() => {});
      } catch {
        // The payment stands; the write didn't happen.
      }
    }
    return true;
  }

  /**
   * A Ledger's flagged send, once the device signed and main recorded it:
   * its finalize receipt presented through the core (`approval.remember`),
   * under the PageContext the token was spent under, only while the name,
   * the document's key and the grant hold (`page-sends.js`'s
   * `rememberDeviceSend`, its reference).
   */
  async function rememberDeviceSend(context, walletIndex, sent, heldNow) {
    const { key } = context.requester;
    if (sent?.recorded !== true) {
      reportRule(key, { added: false, reason: 'the send was not recorded' });
      return;
    }
    if (!heldNow()) {
      reportRule(key, { added: false, reason: context.signal.aborted ? 'the site no longer holds the send' : 'no receipt' });
      return;
    }
    let presented = null;
    await recheckThen(context, walletIndex, () => {
      const held = heldNow();
      if (held) presented = d.rememberDeviceSend(held);
      return presented;
    });
    if (!presented) {
      reportRule(key, { added: false, reason: 'the site no longer holds the send' });
      return;
    }
    let rule;
    try {
      rule = await presented;
    } catch (err) {
      rule = { added: false, reason: err?.reason || err?.code || 'no reply' };
    }
    reportRule(key, rule);
  }

  /**
   * A send the user approved on the core's prompt, with the core's token:
   * a vault account's, a Ledger's or a phone's (its signer picks the path:
   * the core's signature, a spend then the device, the core's phone job).
   * The site's turn is waited for; just before the signature, and after a
   * signer's wait, the name, the grant and the document's key, in the same
   * run as the effect.
   */
  async function confirmed(context, { account, type, tx, confirmation, remember }) {
    const { requester, signal } = context;
    const stillHeld = (spending) => async (run) => {
      if (!(await context.nameHolds())) throw withdrawn(error(NO_ADDRESS));
      if (!grantExposes(requester.key, account)) throw withdrawn(error(NOT_CONNECTED));
      if (!context.holdsKey()) throw withdrawn(error(NO_ADDRESS));
      if (spending) context.traceCoreToken?.('spent', confirmation.kind);
      return run();
    };
    let coreRule = null;
    // A Ledger's finalize receipt, erased when the request ends before the
    // flow does, as on main's own route.
    let receipt = null;
    const eraseReceipt = () => {
      if (receipt) {
        receipt.receipt = null;
        receipt.page = null;
      }
      receipt = null;
    };
    signal.addEventListener('abort', eraseReceipt, { once: true });
    try {
      let sent;
      try {
        sent = await sendDappPayment(
          {
            walletIndex: account,
            tx: mainTxOf(tx),
            site: requester.key,
            silent: false,
            guard: stillHeld(true),
            afterSignature: stillHeld(false),
            authorized: () => ({
              confirmation,
              onRule: (rule) => {
                coreRule = rule;
              },
              onReceipt: (held) => {
                receipt = held;
                if (signal.aborted) eraseReceipt();
              },
            }),
          },
          paymentDeps
        );
      } catch (err) {
        return err?.answer ?? failure(err);
      } finally {
        // Spent at its presentation; one a send ended before is burnt.
        discard(confirmation.token);
      }
      if (remember && type === 'ledger') await rememberDeviceSend(context, account, sent, () => receipt);
      else if (remember && type === 'remote' && !coreRule) reportPhoneRuleWaits(requester.key, sent);
      else if (remember) reportRule(requester.key, coreRule);
      return { result: sent.hash };
    } finally {
      signal.removeEventListener('abort', eraseReceipt);
      eraseReceipt();
    }
  }

  /**
   * A send the site's rule answered, with no token: the site's turn without
   * waiting (D12), and the signature under `{ standing }`, which the core
   * judges again as it signs. Just before it, and after the signature,
   * the name, custody read live, the grant and the document's key.
   */
  async function standing(context, { account, tx }) {
    const { requester } = context;
    const stillAnswers = async (run) => {
      if (!(await context.nameHolds())) throw withdrawn(error(NO_ADDRESS));
      if (custody(requester.guest)) throw withdrawn(error(AGENT_CUSTODY));
      if (!grantExposes(requester.key, account)) throw withdrawn(error(RULE_GONE));
      if (!context.holdsKey()) throw withdrawn(error(NO_ADDRESS));
      return run();
    };
    let sent;
    try {
      sent = await sendDappPayment(
        {
          walletIndex: account,
          tx: mainTxOf(tx),
          site: requester.key,
          silent: true,
          guard: stillAnswers,
          afterSignature: stillAnswers,
          // Not paused: its turn is the send's own, which a paused site
          // doesn't get (`sendDappPayment`). The PageContext read live, so
          // a tab the Agent took meanwhile is the core's refusal too.
          authorized: () => ({ page: context.pageContext(), standing: { paused: false } }),
        },
        paymentDeps
      );
    } catch (err) {
      if (err?.code === NOT_CONFIRMED && err.reason === 'custody') return error(AGENT_CUSTODY);
      if (err?.code === NOT_CONFIRMED && RULE_REASONS.has(err.reason)) return error(RULE_GONE);
      return err?.answer ?? failure(err);
    }
    // The site's last use, only while the name still answers. The hash is
    // the page's: the payment has gone out.
    await recheckThen(context, account, () => updateLastUsed(context));
    return { result: sent.hash };
  }

  /**
   * A `{ send }` the relay checked against its request: `{ kind, account,
   * tx, handle, token, remember }` for an approved send, or `{ kind,
   * account, tx, standing: true }` for a rule's. `page` is the PageContext
   * main sent the request under.
   */
  async function pay(context, send, page) {
    const account = await listed(send.account);
    if (!account || !VAULT_TYPES.has(account.type)) {
      discard(send.token);
      return error(ACCOUNT_GONE);
    }
    if (send.standing === true) return standing(context, { account: send.account, tx: send.tx });
    return confirmed(context, {
      account: send.account,
      type: 'mnemonic',
      tx: send.tx,
      confirmation: { token: send.token, kind: send.kind, handle: send.handle, page },
      remember: send.remember === true,
    });
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

  /**
   * A Safe's send, with the core's `safe-send` token for the site: the
   * name, the grant and the document checked, the Safe reserved, the token
   * spent for the Safe approval its owners present, the SafeTx started, and
   * its board shown (`page-sends.js`'s `safeSend`, its reference, from the
   * spend on). The page gets the execution's hash.
   */
  async function safeSend(context, device, page) {
    const { requester } = context;
    const safeIndex = device.account;
    const { tx } = device.payload;
    const safeTx = { to: tx.to, value: tx.value, data: tx.data };
    const chainId = Number(device.payload.chain_id);
    const confirmation = {
      token: device.token,
      kind: device.kind,
      account: safeIndex,
      payload: device.payload,
      handle: device.handle,
      page,
    };
    let started;
    let reservation = null;
    try {
      if (!(await context.nameHolds())) return error(NO_ADDRESS);
      if (!grantExposes(requester.key, safeIndex)) return error(NOT_CONNECTED);
      if (!context.holdsKey()) return error(NO_ADDRESS);
      // One pending SafeTx per Safe, reserved before the token is spent.
      reservation = d.reserveSafeSend(safeIndex);
      context.traceCoreToken?.('spent', device.kind);
      const { approval } = await d.spendSafe(confirmation);
      if (!approval) return failure(new Error('The identity core gave no Safe approval'));
      started = await d.startSafeSend({
        safeIndex,
        tx: safeTx,
        display: safeDisplay(safeTx, requester.key),
        chainId,
        approval,
        reservation,
      });
    } catch (err) {
      return failure(err);
    } finally {
      reservation?.release();
      discard(device.token);
    }
    const safeTxHash = started?.safeTxHash;
    const settled = settledOutcome(context, safeIndex, safeTxHash);
    // Before each step that can execute the SafeTx: the name, the key, the
    // grant and the requesting document again, in the same run as the
    // execution. One whose site no longer holds stays the wallet's.
    let withdraw;
    const withdrawnOutcome = new Promise((resolve) => {
      withdraw = () => resolve({ outcome: 'withdrawn' });
    });
    const stopGuard = d.guardSiteSafeSend(safeTxHash, async (execute) => {
      const live = () => !context.signal.aborted;
      if (
        !live() ||
        !(await context.nameHolds()) ||
        !live() ||
        !context.holdsKey() ||
        !grantExposes(requester.key, safeIndex)
      ) {
        withdraw();
        throw d.siteWithdrawn();
      }
      return execute();
    });
    const boards = context.approvalsDocument ? d.safeBoards() : null;
    const shown = boards
      ? boards.runSendBoard(context, { safeIndex, safeTxHash }).catch(() => ({ outcome: 'failed' }))
      : context.prompt({
          kind: 'eth.safe_send',
          view: { safeIndex, state: started },
          choices: (raw) => (Object.keys(raw).length === 0 ? {} : null),
        });
    const board = shown.then((decision) => {
      context.leaveWalletSlot();
      return { board: decision };
    });
    let outcome;
    try {
      const first = await Promise.race([settled, withdrawnOutcome, board]);
      outcome = first.board ? await Promise.race([settled, withdrawnOutcome]) : first;
    } finally {
      stopGuard();
    }
    if (outcome.outcome === 'withdrawn') return error(NO_ADDRESS);
    if (outcome.outcome !== 'executed' || typeof outcome.hash !== 'string') return error(USER_REJECTED);
    return { result: outcome.hash };
  }

  /**
   * A device's send, from a `{ device }` the relay checked against its
   * request: `{ type, kind, account, payload, handle, token, remember }`,
   * and `page`, the PageContext main sent the request under.
   */
  async function device(context, checked, page) {
    const account = await listed(checked.account);
    if (!account || account.type !== checked.type) {
      discard(checked.token);
      return error(ACCOUNT_GONE);
    }
    if (checked.type === 'safe') return safeSend(context, checked, page);
    return confirmed(context, {
      account: checked.account,
      type: checked.type,
      tx: checked.payload.tx,
      // As `signers.js` presents it: a Ledger's spend, a phone's job.
      confirmation: {
        token: checked.token,
        kind: checked.kind,
        account: checked.account,
        payload: checked.payload,
        handle: checked.handle,
        page,
      },
      remember: checked.remember === true,
    });
  }

  return { pay, device, discard };
}

module.exports = { createCoreSends, mainTxOf };
