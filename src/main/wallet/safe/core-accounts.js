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
 *   (renderer/lib/wallet/safe-status.js says so).
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
 *     shows the verdict (FEE_CHECK_NEEDS_CONFIRMATION with `feeAck`), and
 *     its confirmation is `safe.deploy { fee_ack: true }` on its word. The
 *     core confirms only an offer it made: `fee_ack` with none standing is
 *     judged again.
 *   - A deployment already journaled under the key (an activation retried
 *     after its first send) is sent again as it was, at its nonce: from a
 *     `{ send }` the held bytes go again and the new token is burnt
 *     unused; from a `{ fee_check }` nothing is asked, as no new fee would
 *     be paid.
 *
 * Main never mints `executor-send` here (the plan's point 2): the token is
 * the core's, from `safe.deploy`, and a chrome's confirmation of an
 * executor's fee is burnt unused. Nothing falls back to main's own path:
 * a refusal of the core's keeps its code (wallet/safe/errors.js). The
 * token is a bearer secret: never logged, and never in an error.
 */

const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
const { codedError, SAFE_UNVERIFIED } = require('./errors');

/** v1: Safes deploy on Gnosis only (design 0016, Q24). */
const DEPLOY_CHAIN_ID = 100;

/** The core's prepared executor send (cored 0.32.0, `safe::methods`). */
const SEND_KIND = 'executor-send';

/** How many fees one activation asks about in the panel before it stops. */
const MAX_FEE_ASKS = 3;

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
  return vault().safe.status({ safe: index });
}

/**
 * The core's `{ send }` checked as main signs it: the executor's send, from
 * a vault account that owns this Safe, on Gnosis, with its token. Anything
 * else is refused before a key is touched, its token burnt.
 */
function checkedSend(record, send) {
  const token = typeof send?.token === 'string' && send.token.length > 0 ? send.token : null;
  const tx = send?.tx;
  const account = send?.account;
  const owner = Number.isSafeInteger(account) && record.owners.includes(account);
  const vaultAccount = owner && getWalletRecord(account)?.type === WALLET_TYPES.MNEMONIC;
  if (
    !token ||
    send.kind !== SEND_KIND ||
    !vaultAccount ||
    tx === null ||
    typeof tx !== 'object' ||
    String(tx.chain_id) !== String(DEPLOY_CHAIN_ID)
  ) {
    if (token) burn(token);
    throw new Error("The core's activation isn't one Freedom signs: nothing was sent");
  }
  return { token, account, tx };
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

/**
 * The deployment's fee, which the core's check stopped, asked as point 8
 * has it: in the approvals document, then `safe.deploy { fee_ack: true }`
 * on its approval. Resolves with that answer. Without the document, the
 * chrome's card asks (FEE_CHECK_NEEDS_CONFIRMATION, `feeAck`: its
 * confirmation is `feeAcknowledged`, never a token).
 */
async function askFee(record, verdict, { approvals, sender, deploy }) {
  if (!approvals) {
    const { FEE_CHECK_NEEDS_CONFIRMATION, feeCheckError } = require('../fee-check');
    throw Object.assign(feeCheckError(FEE_CHECK_NEEDS_CONFIRMATION, verdict), { feeAck: true });
  }
  // The core's executor, its first vault owner: the account the panel
  // names as paying, which `checkedSend` then requires of the send.
  const { pickDefaultExecutor } = require('./safe-executor');
  const outcome = await approvals.confirmCoreFee(
    {
      sender,
      index: pickDefaultExecutor(record.owners),
      safe: record.address,
      chainId: DEPLOY_CHAIN_ID,
      verdict,
    },
    async () => ({ answer: await deploy(true) })
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
 * @param {boolean} [options.feeAcknowledged] - With the approvals document
 *   off, the chrome's confirmation of the fee its card showed; ignored
 *   while the document is on, which asks itself
 * @param {object} [options.sender] - The asking window's webContents, whose
 *   approvals document asks about a fee
 * @param {object} [options.feeConfirmation] - A chrome's executor-send
 *   confirmation (today's path): burnt unused
 */
async function activateSafe(
  index,
  { feeAcknowledged = false, sender = null, feeConfirmation = null } = {}
) {
  const record = getSafeRecord(index);
  if (feeConfirmation?.confirmation) burn(feeConfirmation.confirmation);
  const { deployIntentKey } = require('./safe-executor');
  const intentKey = deployIntentKey(DEPLOY_CHAIN_ID, record.address);
  const approvals = walletApprovals();
  const deploy = (feeAck) =>
    vault().safe.deploy(feeAck ? { safe: index, fee_ack: true } : { safe: index });

  let answer = await deploy(!approvals && feeAcknowledged === true);
  for (let asked = 0; feeAsked(answer); asked += 1) {
    // Journaled already: its bytes go again, and no fee is asked.
    const held = await require('../transaction-service').heldIntentFor(intentKey);
    if (held) return sendHeld(record, held);
    if (asked >= MAX_FEE_ASKS) {
      throw new Error("The activation's network fee kept changing. Nothing was sent: try again.");
    }
    // A locked vault is unlocked before the fee is asked, not after the
    // user confirmed it, as today's activation reads the executor first.
    await executorAddress(record);
    answer = await askFee(record, answer.fee_check, { approvals, sender, deploy });
  }
  if (answer?.deployed === true) return { safeAddress: record.address, alreadyDeployed: true };
  if (!answer?.send) {
    throw new Error("The core's activation isn't one Freedom signs: nothing was sent");
  }
  const send = checkedSend(record, answer.send);
  const sent = await signing().withConfirmation(send.token, () =>
    sendDeployment(record, send, intentKey)
  );
  return finishDeployment(record, sent.hash);
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
