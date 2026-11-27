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
 *     core judges and counts again, with the rule read again by main
 *     (`approval.check`) just before it and after it, before the journal;
 *     then, after the broadcast, the key's last use (`approval.touch`).
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
 * before the signed bytes are recorded or sent. From cored 0.21.0 the core
 * resolves the name for a send too, at its own checks up to the token it
 * hands main, but the signature and the broadcast come after those, in
 * main. Once a payment that passed that gate has
 * gone out, its hash is the requesting document's (D13: the hash is a public
 * fact about a payment the user approved for this request, and a site told
 * nothing of a payment made could pay again); a write under the key after it
 * (the last use, a device's rule) waits on the name again.
 *
 * For a send the Agent's sheet approved, in a tab it holds (design 0012,
 * "The Agent's answer", A7-6), main also checks that the Agent still holds
 * the tab, where the agent's own route checked it: in the send's turn just
 * before the signature, as the signer's last step right before the core or
 * the device is asked (`beforeSign`), and after the signer's wait before the
 * signed bytes are recorded or sent. A Safe's is never the sheet's (A7-3).
 *
 * The token is a bearer secret: it goes only to the core's spend or
 * signature, is never logged or put in an error, and never reaches a
 * renderer. Main discards it once the step ends, spent or not.
 *
 * On the core's Ledger backend a Ledger's send can be cancelled until its
 * signature is committed (freedom-core design 0016, "Deadlines, cancel and
 * unplugging", deviation `cancel`; LDG-3's PR 10): the step says so as it
 * starts (`context.deviceWait()`, so the surface that approved it keeps
 * Reject), and its signer gets the request's `signal`, which aborts once
 * main answers the request (that Reject, its document gone, its deadline):
 * main cancels the core's `sign.transaction`, the relay lets go of the
 * device, and the send fails before its commit, its nonce released. The
 * page hears a rejection, as for the device's own. The commit of the signed
 * bytes ends the wait in the same run (`context.endDeviceWait()`), unless
 * the signal aborted first: exactly one of the two wins, and a Reject after
 * the commit is refused `not-waiting` while the send goes out.
 *
 * The send's steps after the decision (`sendDappPayment`) and the
 * transaction's form checks (`txOf`, which `page-ethereum.js` and
 * `page-eip1193.js` read from here) came from main's own route,
 * `page-sends.js`, which APB-4d removed once nothing called it.
 */

const { NOT_CONFIRMED } = require('../wallet/signing-confirmation');
const { guestInCustody } = require('./page-custody');

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
// Custody ended after the sheet's approve (A7-6), in the agent route's words.
const CUSTODY_LOST = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: 'Signing was not confirmed: the Agent no longer holds this tab',
});
// The core's refusals of a rule's signature that mean the rule no longer
// answers it. The reference sent a fee or a rate the core no longer allowed
// to the prompt; after `{ send }` the core's request is over, so the page
// hears that the rule didn't cover it, with nothing signed.
const RULE_REASONS = new Set(['no_rule', 'not_exposed', 'rate_limited', 'fee_check', 'warning']);
// What a rule's own signature settled, read again after it: the rate, whose
// slot the signature spent (the burst's last send reads as past it), and
// the fee, fixed in the signed bytes the core judged as it signed.
const SIGNATURE_SETTLED = new Set(['rate_limited', 'fee_check']);
const VAULT_TYPES = new Set([undefined, null, 'mnemonic']);

// A phone account's payment whose answer was lost may have been sent (D13):
// never 4001, which says nothing happened, so the site doesn't pay twice.
// The chrome's SITE_OUTCOME_UNKNOWN (intent-texts.js), word for word.
const OUTCOME_UNKNOWN = Object.freeze({
  code: INTERNAL_ERROR_CODE,
  message: "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
  data: Object.freeze({ outcome: 'unknown' }),
});

const PHONE_OUTCOME_UNKNOWN = 'REMOTE_OUTCOME_UNKNOWN';
// A device's own "declined" is the user's rejection, and so is their
// Cancel while a Ledger waits (LEDGER_CANCELLED).
const DEVICE_REJECTIONS = new Set([
  'LEDGER_USER_REJECTED',
  'LEDGER_CANCELLED',
  'REMOTE_USER_REJECTED',
  'REMOTE_USER_CANCELLED',
]);

const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

const error = (base) => ({ error: { ...base, ...(base.data ? { data: { ...base.data } } : {}) } });

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

/**
 * What the core said of the contract rule a flagged send asked for (the
 * `sign.transaction` reply's `rule`, design 0012, API, or a device send's
 * `approval.remember` reply's), logged as today's rule writes are: written;
 * written but not durable; or not written, with the core's reason.
 */
function reportRule(key, rule) {
  if (rule?.added === true) {
    if (rule.durable === false) {
      console.warn(`[PageSends] contract rule saved for ${key}, but it may not survive a power loss yet`);
    }
    return;
  }
  console.error(`[PageSends] contract rule not saved for ${key}: ${rule?.reason || 'no reply'}`);
}

/**
 * A phone send's "Always allow" the core holds until its payment's
 * transaction shows and matches (design 0012, "A phone payment's rule"):
 * written then, in the same run of the core, and reported with its
 * `phone.checked` (tx-recorder.js); dropped on a mismatch, a day's end or
 * a restart.
 */
function reportPhoneRuleWaits(key, sent) {
  if (sent?.phoneCheck === 'unverified' || sent?.phoneCheck === 'unknown') {
    console.warn(`[PageSends] contract rule for ${key} waits until the phone's payment is checked`);
    return;
  }
  reportRule(key, null);
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
    getSigner: (walletIndex, authorized) => require('../wallet/signers').getSigner(walletIndex, authorized),
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
 * `authorized()`, read as the send signs, gives what its signer presents
 * to the identity core (design 0012): the request's confirmation, or the
 * page's PageContext for a rule's answer (`signers.js`).
 *
 * @returns {Promise<object>} what `signAndRecord` answered. Throws when the
 *   send fails or a guard withdraws it.
 */
async function sendDappPayment(
  { walletIndex, tx, site, silent = false, guard = null, afterSignature = null, authorized = null },
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
        getSigner(walletIndex, authorized ? authorized() : undefined),
        { kind: 'dapp-send', origin: site, ...paymentContext(tx) },
        { walletIndex, onCommitted: release, guardCommit: afterSignature }
      );
    return await (guard ? guard(send) : send());
  } finally {
    release?.();
  }
}


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
    checkStanding: (page, request) => require('../wallet/signing-confirmation').checkStanding(page, request),
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
    // Whether a Ledger's wait can be cancelled: the core's Ledger backend.
    ledgerCancels: () => require('../wallet/ledger/ledger-backend-kind').ledgerBackendKind() === 'core',
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
   * the core's signature, a spend then the device, the core's phone job;
   * on the core's Ledger backend, a Ledger's is the core's signature on its
   * device lane, design 0016).
   * The site's turn is waited for; just before the signature, and after a
   * signer's wait, the name, the grant and the document's key, in the same
   * run as the effect. `agent`: the Agent's sheet approved it, so custody
   * is read there too, and as the signer's last step (A7-6).
   */
  async function confirmed(context, { account, type, tx, confirmation, remember, agent = false }) {
    const { requester, signal } = context;
    // The Agent still holds the tab, read now; unknown counts as lost.
    const agentHolds = () => {
      try {
        return context.pageContext().agent === true;
      } catch {
        return false;
      }
    };
    // A Ledger on the core's backend: cancellable until its signature is
    // committed, the request's signal being main's own cancel of the core's
    // signature.
    const cancellable = type === 'ledger' && d.ledgerCancels();
    const stillHeld = (spending) => async (run) => {
      if (!(await context.nameHolds())) throw withdrawn(error(NO_ADDRESS));
      if (!grantExposes(requester.key, account)) throw withdrawn(error(NOT_CONNECTED));
      if (!context.holdsKey()) throw withdrawn(error(NO_ADDRESS));
      if (agent && !agentHolds()) throw withdrawn(error(CUSTODY_LOST));
      if (spending) context.traceCoreToken?.('spent', confirmation.kind);
      // The commit boundary, in the same run as the commit: from here
      // Reject no longer reaches the request, and the page hears the send's
      // own outcome. A Reject that came first (the request answered, its
      // signal aborted) wins: nothing is committed or sent.
      if (!spending && cancellable && (signal.aborted || context.endDeviceWait?.() === false)) {
        throw withdrawn(error(USER_REJECTED));
      }
      return run();
    };
    // The signer's last step, after its own waits (the fee, the nonce, a
    // device's spend), right before the core or the device is asked: a
    // refusal the signers pass on unchanged (`SIGNING_NOT_CONFIRMED`), its
    // message the page's.
    const beforeSign = agent
      ? async () => {
          if (!agentHolds()) {
            throw Object.assign(new Error(CUSTODY_LOST.message), { code: NOT_CONFIRMED, answer: error(CUSTODY_LOST) });
          }
        }
      : null;
    let coreRule = null;
    // Whether the signer heard the core's `rule` reply: a vault send's, and
    // on the core's Ledger backend a Ledger's (design 0016), which the core
    // wrote as it signed, so no receipt is presented for it.
    let ruleHeard = false;
    // A Ledger's finalize receipt (its JS backend), erased when the request
    // ends before the flow does, as on main's own route.
    let receipt = null;
    const eraseReceipt = () => {
      if (receipt) {
        receipt.receipt = null;
        receipt.page = null;
      }
      receipt = null;
    };
    signal.addEventListener('abort', eraseReceipt, { once: true });
    if (cancellable) context.deviceWait?.();
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
              ...(beforeSign ? { beforeSign } : {}),
              ...(cancellable ? { signal } : {}),
              onRule: (rule) => {
                coreRule = rule;
                ruleHeard = true;
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
      if (remember && type === 'ledger' && !ruleHeard) await rememberDeviceSend(context, account, sent, () => receipt);
      else if (remember && type === 'remote' && !coreRule) reportPhoneRuleWaits(requester.key, sent);
      else if (remember) reportRule(requester.key, coreRule);
      // The payment's record, for the Agent's receipt only: main's relay
      // keeps it from the page (`page-eip1193.js`).
      if (agent && sent?.paymentId !== undefined && sent.paymentId !== null) {
        return { result: sent.hash, paymentId: sent.paymentId };
      }
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
   * the name, the site's rule as the core reads it now, custody read live,
   * the grant and the document's key (`page-sends.js`'s `ruleStillAnswers`).
   */
  async function standing(context, { account, tx }) {
    const { requester } = context;
    const payload = mainTxOf(tx);
    // The site's rule for this send (`approval.check`, which counts nothing),
    // under the PageContext read live, not paused: its turn is the send's
    // own. A refusal's answer, or null while the rule answers. Before the
    // signature the core decides it again as it signs; after it, what the
    // signature settled stands. A check that fails is a refusal.
    const ruleRefusal = async (signed) => {
      let still;
      try {
        still = await d.checkStanding(context.pageContext(), {
          kind: 'transaction',
          account,
          accountType: 'mnemonic',
          payload: mainTxOf(tx),
          paused: false,
        });
      } catch {
        still = null;
      }
      if (still?.covered === true) return null;
      if (still?.reason === 'custody') return AGENT_CUSTODY;
      if (signed && SIGNATURE_SETTLED.has(still?.reason)) return null;
      return RULE_GONE;
    };
    const stillAnswers = (signed) => async (run) => {
      if (!(await context.nameHolds())) throw withdrawn(error(NO_ADDRESS));
      const refused = await ruleRefusal(signed);
      // From here to the effect, one run.
      if (custody(requester.guest)) throw withdrawn(error(AGENT_CUSTODY));
      if (refused) throw withdrawn(error(refused));
      if (!grantExposes(requester.key, account)) throw withdrawn(error(RULE_GONE));
      if (!context.holdsKey()) throw withdrawn(error(NO_ADDRESS));
      return run();
    };
    let sent;
    try {
      sent = await sendDappPayment(
        {
          walletIndex: account,
          tx: payload,
          site: requester.key,
          silent: true,
          guard: stillAnswers(false),
          afterSignature: stillAnswers(true),
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
   * main sent the request under; `agent`, that the Agent's sheet approved
   * it (A7-6).
   */
  async function pay(context, send, page, { agent = false } = {}) {
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
      agent: agent === true,
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
   * `page`, the PageContext main sent the request under, and `agent`, that
   * the Agent's sheet approved it (A7-6).
   */
  async function device(context, checked, page, { agent = false } = {}) {
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
      agent: agent === true,
    });
  }

  return { pay, device, discard };
}

module.exports = { createCoreSends, mainTxOf, sendDappPayment, txOf, selectorOf };
