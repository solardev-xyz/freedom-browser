/**
 * A Safe account on the core's Safe backend (freedom-core design 0016,
 * SAFE-3's PR 3; FREEDOM_SAFE_BACKEND=core, development builds only:
 * safe-backend-kind.js): its record, its status and its activation, through
 * the core's `safe.*`. safe-service.js routes here on the core, and keeps
 * today's protocol-kit path on js.
 *
 * - **Create** is `safe.create`: the core reads the owners' addresses from
 *   their records, draws the salt and computes the address, and writes the
 *   record on its vault queue. Main reads no chain and computes nothing.
 * - **Status** is `safe.status`: `getSafeStatus`'s fields, and `setup`,
 *   what the core's reads show of the Safe's setup, as data (design 0016,
 *   API). It refuses nothing a signing step would: a changed or unverified
 *   setup, or a Safe not deployed, is reported, never thrown. A Safe the
 *   core reports deployed from an unverified answer has `setup` naming the
 *   code read unverified, and its record stays unmarked
 *   (renderer/lib/wallet/safe-status.js says so). What it shows of the
 *   setup also goes on the Safe's pending transaction's board
 *   (core-sends.js `noteSetup`).
 * - **Activate:** `safe.deploy` reads the code and the executor's balance,
 *   prices the deployment and judges its fee, and answers `{ deployed:
 *   true }`, `{ send }` or `{ fee_check }`.
 *   - `{ send: { kind: "executor-send", account, tx, token } }`: main signs
 *     exactly `tx` from `account` with `sign.transaction` presenting `{
 *     token, kind: "executor-send" }`, the nonce the only field it adds
 *     (under the account's lock); the signed bytes are journaled under
 *     `deployIntentKey` (safe-executor.js) before the broadcast; and after
 *     the receipt `safe.deployed { safe, hash }`, on whose verified evidence
 *     alone the core marks the record. The token is burnt once the send
 *     ends, spent or not.
 *   - `{ fee_check }`, the core's verdict on a fee its check didn't approve
 *     on its own (the SAFE-3 plan's point 8): asked in the approvals
 *     document's `wallet.executor_send` panel of the window that asked
 *     (wallet-approvals.js `confirmCoreFee`), twice for a fee above the
 *     threshold; on the approval `safe.deploy { fee_ack: true }` mints the
 *     token for exactly the offered transaction. With the document off (a
 *     development build's FREEDOM_APPROVALS_DOCUMENT=0), the chrome's card
 *     shows the verdict (FEE_CHECK_NEEDS_CONFIRMATION with `feeAskId`), and
 *     its confirmation returns that ID: main takes it only for the ask it
 *     holds for that Safe, from the chrome it was shown in, twice for a fee
 *     above the threshold, before `safe.deploy { fee_ack: true }`. Main
 *     holds one ask per Safe, so another activation of it (another window's
 *     included) leaves an earlier ID confirming nothing, and it counts the
 *     asks across the card's round trips (MAX_FEE_ASKS). Either way the
 *     send that follows must be the offer shown: its executor, and the
 *     verdict's most it can cost.
 *   - A deployment already journaled under the key (an activation retried
 *     after its first send) is sent again as it was, at its nonce: from a
 *     `{ send }` the held bytes go again and the new token is burnt
 *     unused; from a `{ fee_check }` nothing is asked, as no new fee would
 *     be paid.
 *
 * - **A held deployment's speed-up** (SAFE-3's PR 7; design 0016, C1):
 *   under the hello's `safe3` `sign.transaction` signs a deployment only
 *   with its `executor-send` token, so the journal's intent-replace, main's
 *   word, can't re-sign one. `activateSafe(index, { speedUp: true })`
 *   instead asks `safe.deploy` again: its fee asked as an activation's
 *   (above), its `{ send }` at the core's own quote checked as above, and
 *   then signed with its token at the held deployment's nonce, nothing
 *   else changed (the token leaves the nonce to main), as a replacement of
 *   the held intent: it must pay what the held one pays, and each fee must
 *   be at least 10% above its fees, or nothing is signed (a node would
 *   refuse it). Then the receipt and `safe.deployed`, as above. With no
 *   held deployment there is nothing to speed up.
 *
 * Main never mints `executor-send` here (the plan's point 2): the token is
 * the core's, from `safe.deploy`, and a chrome's confirmation of an
 * executor's fee is burnt unused. Nothing falls back to main's own path:
 * a refusal of the core's keeps its code (wallet/safe/errors.js). The
 * token is a bearer secret: never logged, and never in an error.
 */

const crypto = require('crypto');
const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
const { codedError, SAFE_UNVERIFIED } = require('./errors');

/** v1: Safes deploy on Gnosis only (design 0016, Q24). */
const DEPLOY_CHAIN_ID = 100;

/** The core's prepared executor send (cored 0.32.0, `safe::methods`). */
const SEND_KIND = 'executor-send';

/** How many fees one activation asks about, across the card's round trips, before it stops. */
const MAX_FEE_ASKS = 3;

// The fee ask main holds for each Safe, by its index: `{ id, asker, verdict,
// executor, presses, count }` (`holdAsk`). One per Safe: a newer ask, or a
// new activation, replaces it, and its ID then confirms nothing.
const asks = new Map();

/** `confirmDeployment`'s text, the core's own for `safe.deployed`. */
const DEPLOYMENT_UNVERIFIED_TEXT =
  "Freedom sent the activation, but couldn't verify on Gnosis that it went through. " +
  'It checks again the next time you open this account. ' +
  'If it stays unverified, add an RPC provider in Settings.';

function vault() {
  return require('../../core/vault-backend').vaultBackend;
}

function signing() {
  return require('../signing-confirmation');
}

/** The approvals document's wallet prompts, or null while it is off. */
function walletApprovals() {
  return require('../../approvals/wallet-approvals').getWalletApprovals();
}

function getSafeRecord(index) {
  const record = getWalletRecord(index);
  if (!record || record.type !== WALLET_TYPES.SAFE) {
    throw new Error(`Wallet ${index} is not a Safe account`);
  }
  return record;
}

/** Burnt, its outcome unread: the core burns it at its life's end anyway. */
function burn(token) {
  try {
    Promise.resolve(signing().discardConfirmation(token)).catch(() => {});
  } catch {
    // Burnt by the core at its life's end all the same.
  }
}

/**
 * Create a Safe account record through the core (`safe.create`).
 *
 * @param {{ name: string, ownerIndexes: number[], threshold: number }} params
 * @returns {Promise<Object>} the stored record
 */
async function createSafeAccount({ name, ownerIndexes, threshold }) {
  const { wallet } = await vault().safe.create({ name, owners: ownerIndexes, threshold });
  return wallet;
}

/**
 * The Safe's status (`safe.status`), as the core gives it: `deployed`,
 * `chainId`, `executorIndex`, `executorAddress`, `executorBalance`,
 * `estimatedCost`, `needsFunds` and `setup`.
 *
 * @param {number} index - Wallet index of the Safe record
 */
async function getSafeStatus(index) {
  getSafeRecord(index);
  const status = await vault().safe.status({ safe: index });
  // What the reads show of its setup goes on its pending transaction's
  // board too (core-sends.js, SAFE-3's PR 9): a changed Safe's offers
  // only the discard.
  require('./core-sends').noteSetup(index, status?.setup);
  return status;
}

/**
 * The core's `{ send }` checked as main signs it: the executor's send, from
 * a vault account that owns this Safe, on Gnosis, with its token. After a
 * fee the user confirmed (`shown`, the ask), it must also be the offer
 * shown: from the executor named, at the verdict's most it can cost.
 * Anything else is refused before a key is touched, its token burnt.
 */
function checkedSend(record, send, shown = null) {
  const token = typeof send?.token === 'string' && send.token.length > 0 ? send.token : null;
  const tx = send?.tx;
  const account = send?.account;
  const owner = Number.isSafeInteger(account) && record.owners.includes(account);
  const vaultAccount = owner && getWalletRecord(account)?.type === WALLET_TYPES.MNEMONIC;
  const valid =
    token &&
    send.kind === SEND_KIND &&
    vaultAccount &&
    tx !== null &&
    typeof tx === 'object' &&
    String(tx.chain_id) === String(DEPLOY_CHAIN_ID);
  if (!valid) {
    if (token) burn(token);
    throw new Error("The core's activation isn't one Freedom signs: nothing was sent");
  }
  if (shown && (account !== shown.executor || !costs(tx, shown.verdict.maxCost))) {
    burn(token);
    throw notShown();
  }
  return { token, account, tx };
}

/** Whether `tx` (the core's form) costs at most exactly `maxCost`, a verdict's. */
function costs(tx, maxCost) {
  try {
    const perGas = tx.type === 2 ? tx.max_fee_per_gas : tx.gas_price;
    return typeof maxCost === 'string' && BigInt(tx.gas_limit) * BigInt(perGas) === BigInt(maxCost);
  } catch {
    return false;
  }
}

/** Whether `safe.deploy` answered `{ fee_check }`: a fee for the user. */
function feeAsked(answer) {
  return (
    answer !== null &&
    typeof answer === 'object' &&
    Object.hasOwn(answer, 'fee_check') &&
    answer.deployed !== true
  );
}

/**
 * The address of the Safe's executor, its first vault owner (the core's
 * choice too): read through the vault, so a locked vault is VAULT_LOCKED
 * here.
 */
async function executorAddress(record) {
  const { pickDefaultExecutor } = require('./safe-executor');
  return require('../signers').getSigner(pickDefaultExecutor(record.owners)).getAddress();
}

/** A fee confirmation that isn't the ask main holds for this Safe and window. */
function notShown() {
  return codedError(
    "This fee confirmation isn't the one shown for this account. Nothing was sent: try again.",
    signing().NOT_CONFIRMED
  );
}

/** The asking chrome's webContents id, which an ask is bound to, or null. */
function askerOf(sender) {
  return Number.isSafeInteger(sender?.id) ? sender.id : null;
}

/**
 * The core's fee verdict `verdict` for Safe `index`, held as the ask main
 * shows (`asks`): a new ID, the asking chrome (`sender`), the verdict and
 * the executor that pays. It replaces the Safe's earlier ask, whose ID no
 * longer confirms anything, and counts one more of the activation's asks:
 * past MAX_FEE_ASKS the activation stops, nothing sent.
 */
function holdAsk(index, verdict, sender, record) {
  const count = (asks.get(index)?.count ?? 0) + 1;
  if (count > MAX_FEE_ASKS) {
    asks.delete(index);
    throw new Error("The activation's network fee kept changing. Nothing was sent: try again.");
  }
  const { pickDefaultExecutor } = require('./safe-executor');
  const ask = {
    id: crypto.randomUUID(),
    asker: askerOf(sender),
    verdict,
    executor: pickDefaultExecutor(record.owners),
    presses: 0,
    count,
  };
  asks.set(index, ask);
  return ask;
}

/** The card's ask (approvals document off): the verdict, the ask's ID, and whether it asks again. */
function cardAsk(ask) {
  const { FEE_CHECK_NEEDS_CONFIRMATION, feeCheckError } = require('../fee-check');
  return Object.assign(feeCheckError(FEE_CHECK_NEEDS_CONFIRMATION, ask.verdict), {
    feeAskId: ask.id,
    feeAskAgain: ask.presses > 0,
  });
}

/**
 * The card's confirmation of ask `id` for Safe `index` (approvals document
 * off): the ask main holds for the Safe, shown in the same chrome; anything
 * else is refused. A fee above the threshold takes two presses: the first
 * is asked again, under a new ID. Resolves with the ask the fee_ack
 * confirms, its ID spent.
 */
function confirmedAsk(index, id, sender) {
  const ask = asks.get(index);
  const asker = askerOf(sender);
  if (!ask || typeof id !== 'string' || ask.id !== id || asker === null || ask.asker !== asker) {
    throw notShown();
  }
  if (ask.verdict?.above === true && ask.presses === 0) {
    ask.presses = 1;
    ask.id = crypto.randomUUID();
    throw cardAsk(ask);
  }
  ask.id = null;
  return ask;
}

/**
 * Ask `ask`'s fee in the approvals document, then `safe.deploy { fee_ack:
 * true }` on its approval, while the ask is still the one main holds for
 * the Safe (another activation meanwhile replaces it). Resolves with that
 * answer.
 */
async function askInPanel(index, record, ask, { approvals, sender, deploy }) {
  const id = ask.id;
  const outcome = await approvals.confirmCoreFee(
    {
      sender,
      index: ask.executor,
      safe: record.address,
      chainId: DEPLOY_CHAIN_ID,
      verdict: ask.verdict,
    },
    async () => {
      if (asks.get(index) !== ask || ask.id !== id) throw notShown();
      ask.id = null;
      return { answer: await deploy(true) };
    }
  );
  if (!outcome?.approved)
    throw codedError(outcome?.error ?? 'User rejected the request', outcome?.code);
  return outcome.answer;
}

/**
 * Activate (deploy) the Safe through the core, as this module's header
 * says. Resolves `{ safeAddress, hash }`, or `{ safeAddress, alreadyDeployed:
 * true }` for a Safe the core finds deployed.
 *
 * @param {number} index - Wallet index of the Safe record
 * @param {object} [options]
 * @param {string} [options.feeAskId] - With the approvals document off, the
 *   card's confirmation of the ask it showed (`confirmedAsk`); ignored
 *   while the document is on, which asks itself
 * @param {object} [options.sender] - The asking chrome's webContents: its
 *   approvals document asks about a fee, and an ask is bound to it
 * @param {object} [options.feeConfirmation] - A chrome's executor-send
 *   confirmation (today's path): burnt unused
 * @param {boolean} [options.speedUp] - The held deployment re-signed at its
 *   nonce with `safe.deploy`'s send (`speedUpHeld`), not sent again as it
 *   was; refused when none is held
 */
async function activateSafe(
  index,
  { feeAskId = null, sender = null, feeConfirmation = null, speedUp = false } = {}
) {
  const record = getSafeRecord(index);
  if (feeConfirmation?.confirmation) burn(feeConfirmation.confirmation);
  const { deployIntentKey } = require('./safe-executor');
  const intentKey = deployIntentKey(DEPLOY_CHAIN_ID, record.address);
  const transactions = require('../transaction-service');
  // The deployment to speed up: the one journaled under its key, read
  // before anything is asked, and again (`speedUpHeld`) under its lock.
  const toSpeedUp = speedUp === true ? await transactions.heldIntentFor(intentKey) : null;
  if (speedUp === true && !toSpeedUp) {
    throw new Error('This account has no activation waiting to speed up');
  }
  const approvals = walletApprovals();
  const deploy = (feeAck) =>
    vault().safe.deploy(feeAck ? { safe: index, fee_ack: true } : { safe: index });

  // The fee the user confirmed, which the send must then be.
  let shown = null;
  let answer;
  if (!approvals && feeAskId !== null) {
    shown = confirmedAsk(index, feeAskId, sender);
    answer = await deploy(true);
  } else {
    // A new activation: its own asks, and no earlier ask confirms anything.
    asks.delete(index);
    answer = await deploy(false);
  }
  while (feeAsked(answer)) {
    // Journaled already: its bytes go again, and no fee is asked; unless
    // it is being sped up, whose new fee is the user's to confirm.
    const held = toSpeedUp ? null : await transactions.heldIntentFor(intentKey);
    if (held) {
      asks.delete(index);
      return sendHeld(record, held);
    }
    // A locked vault is unlocked before the fee is asked, not after the
    // user confirmed it, as today's activation reads the executor first.
    await executorAddress(record);
    const ask = holdAsk(index, answer.fee_check, sender, record);
    if (!approvals) throw cardAsk(ask);
    shown = ask;
    answer = await askInPanel(index, record, ask, { approvals, sender, deploy });
  }
  asks.delete(index);
  if (answer?.deployed === true) return { safeAddress: record.address, alreadyDeployed: true };
  if (!answer?.send) {
    throw new Error("The core's activation isn't one Freedom signs: nothing was sent");
  }
  const send = checkedSend(record, answer.send, shown);
  const sent = await signing().withConfirmation(send.token, () =>
    toSpeedUp ? speedUpHeld(record, send, toSpeedUp) : sendDeployment(record, send, intentKey)
  );
  return finishDeployment(record, sent.hash);
}

/**
 * The core's prepared deployment (`send`, its token's) signed at the held
 * deployment's nonce as its replacement, nothing else changed: under the
 * executor's lock, `sign.transaction` with `{ token, kind: "executor-send"
 * }` (never the journal's intent-replace, which `safe3` refuses for a
 * deployment), the signed bytes committed as a replacement of the held
 * intent, then broadcast. It must pay what the held deployment pays, from
 * its account, and raise each fee at least 10%; otherwise nothing is
 * signed (transaction-service.js `replaceIntentWith`).
 */
async function speedUpHeld(record, { token, account, tx }, held) {
  const { getSigner } = require('../signers');
  const { replaceWithAndRecord } = require('../tx-recorder');
  const executor = getSigner(account, { confirmation: { token, kind: SEND_KIND } });
  return replaceWithAndRecord(held.intentId, sendParamsOf(tx), executor);
}

/** The payment-history row of the deployment: the executor paid gas to create the Safe. */
function historyOf(record, executor) {
  const { KINDS } = require('../tx-recorder');
  return {
    kind: KINDS.SAFE_DEPLOY,
    toAddress: record.address,
    amount: '0',
    metadata: { safeAddress: record.address, executor },
  };
}

/**
 * The core's prepared deployment, signed with its token and sent: under
 * the executor's lock its nonce added and nothing else changed;
 * `sign.transaction` with `{ token, kind: "executor-send" }`; the signed
 * bytes committed to the journal under the deployment's key; the
 * broadcast. A deployment held under the key is sent again instead, and
 * nothing is signed.
 */
async function sendDeployment(record, { token, account, tx }, intentKey) {
  const { getSigner } = require('../signers');
  const { signAndRecord } = require('../tx-recorder');
  const executor = getSigner(account, { confirmation: { token, kind: SEND_KIND } });
  const from = await executor.getAddress();
  return signAndRecord(sendParamsOf(tx), executor, historyOf(record, from), { intentKey });
}

/**
 * The core's transaction (`sign.transaction`'s form, no nonce) as main's
 * send parameters, the same fields, which `buildTransaction` and
 * `toCoreTransaction` give back unchanged with the nonce the only one
 * added (as page-core-sends.js `mainTxOf` reads a page's prepared send).
 */
function sendParamsOf(tx) {
  const params = {
    to: tx.to,
    value: tx.value,
    data: tx.data,
    chainId: Number(tx.chain_id),
    gasLimit: tx.gas_limit,
  };
  if (tx.type === 2) {
    params.maxFeePerGas = tx.max_fee_per_gas;
    params.maxPriorityFeePerGas = tx.max_priority_fee_per_gas;
  } else {
    params.gasPrice = tx.gas_price;
  }
  return params;
}

/** A deployment journaled before, sent again as it was (no signature, no token). */
async function sendHeld(record, held) {
  const { resendAndRecord } = require('../tx-recorder');
  const sent = await resendAndRecord(held.intentId);
  return finishDeployment(record, sent.hash);
}

/**
 * After the broadcast: the receipt, then `safe.deployed { safe, hash }`,
 * which marks the record only on verified evidence (design 0016, D4). One
 * the core reports for the session only (`verified: false`), or doesn't
 * find deployed, marks nothing, and the activation says so
 * (SAFE_UNVERIFIED): the next status check reads again.
 */
async function finishDeployment(record, hash) {
  const { waitForTransaction } = require('../transaction-service');
  const receipt = await waitForTransaction(hash, DEPLOY_CHAIN_ID);
  if (receipt?.status !== 'confirmed') {
    throw new Error('Safe deployment transaction failed on chain');
  }
  const outcome = await vault().safe.deployed({ safe: record.index, hash });
  if (outcome?.deployed !== true || outcome.verified === false) {
    throw codedError(DEPLOYMENT_UNVERIFIED_TEXT, SAFE_UNVERIFIED);
  }
  return { safeAddress: record.address, hash };
}

module.exports = {
  DEPLOY_CHAIN_ID,
  MAX_FEE_ASKS,
  createSafeAccount,
  getSafeStatus,
  activateSafe,
};
