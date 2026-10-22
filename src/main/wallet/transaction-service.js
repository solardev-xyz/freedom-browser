/**
 * Transaction Service
 *
 * Handles gas estimation, transaction building, and broadcasting.
 * Signing is delegated to a Signer (see ./signers.js), so this module
 * never touches key material.
 */

const { parseUnits, formatUnits, Interface, Transaction, keccak256 } = require('ethers');
const chainData = require('../networks/chain-data');
const { getTxExplorerUrl } = require('./chains');
const { REMOTE_ERROR_CODES, createRemoteError } = require('./remote/errors');
const { getIntentStore } = require('./intent-store');
const { reserve, withAccountLock, withIntentKeyLock } = require('./nonce-reservations');

// ERC-20 transfer function interface
const ERC20_INTERFACE = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Estimate gas for a transaction
 * @param {Object} params - Transaction parameters
 * @param {string} params.from - Sender address
 * @param {string} params.to - Recipient address
 * @param {string} params.value - Value in wei (as string)
 * @param {string} [params.data] - Transaction data (for token transfers)
 * @param {number} params.chainId - Chain ID
 * @returns {Promise<{gasLimit: string, error?: string}>}
 */
async function estimateGas({ from, to, value, data, chainId }) {
  try {
    const tx = {
      from,
      to,
      value: value || '0',
    };

    if (data) {
      tx.data = data;
    }

    const { result } = await chainData.request(chainId, 'eth_estimateGas', [tx]);
    const gasLimit = BigInt(result);

    // Add 20% buffer for safety
    const bufferedGas = (gasLimit * 120n) / 100n;

    return {
      gasLimit: bufferedGas.toString(),
    };
  } catch (err) {
    console.error('[TransactionService] Gas estimation failed:', err);
    throw new Error(`Gas estimation failed: ${err.message}`, { cause: err });
  }
}

/**
 * Get current gas prices for a chain
 * Returns EIP-1559 fee data with market preset
 * @param {number} chainId - Chain ID
 * @returns {Promise<Object>} Gas price data
 */
async function getGasPrices(chainId) {
  try {
    const quote = await chainData.getFeeQuote(chainId);
    console.log('[TransactionService] Fee quote:', {
      chainId,
      type: quote.type,
      source: quote.source,
      maxFeePerGas: quote.maxFeePerGas,
      maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
      gasPrice: quote.gasPrice,
    });
    return quote;
  } catch (err) {
    console.error('[TransactionService] Failed to get gas prices:', err);
    throw new Error(`Failed to get gas prices: ${err.message}`, { cause: err });
  }
}

/**
 * getGasPrices result → the fee fields buildTransaction / send params
 * expect, so callers don't re-derive the eip1559-vs-legacy branch.
 * @param {Object} gasPrices - Result of getGasPrices
 * @returns {{maxFeePerGas: string, maxPriorityFeePerGas: string}|{gasPrice: string}}
 */
function toFeeFields(gasPrices) {
  return gasPrices.type === 'eip1559'
    ? {
        maxFeePerGas: gasPrices.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices.maxPriorityFeePerGas,
      }
    : { gasPrice: gasPrices.gasPrice };
}

/**
 * Build ERC-20 transfer calldata
 * @param {string} to - Recipient address
 * @param {string} amount - Amount in token's smallest unit (as string)
 * @returns {string} Encoded calldata
 */
function buildErc20TransferData(to, amount) {
  return ERC20_INTERFACE.encodeFunctionData('transfer', [to, amount]);
}

/**
 * Parse amount string to wei/smallest unit
 * @param {string} amount - Human-readable amount (e.g., "1.5")
 * @param {number} decimals - Token decimals
 * @returns {bigint} Amount in smallest unit
 */
function parseAmount(amount, decimals = 18) {
  return parseUnits(amount, decimals);
}

/**
 * Format amount from wei/smallest unit to human-readable
 * @param {string|bigint} amount - Amount in smallest unit
 * @param {number} decimals - Token decimals
 * @returns {string} Human-readable amount
 */
function formatAmount(amount, decimals = 18) {
  return formatUnits(amount, decimals);
}

/**
 * Build a transaction object
 * @param {Object} params - Transaction parameters
 * @returns {Object} Unsigned transaction
 */
function buildTransaction({
  to,
  value,
  data,
  gasLimit,
  maxFeePerGas,
  maxPriorityFeePerGas,
  gasPrice,
  nonce,
  chainId,
}) {
  const tx = {
    to,
    value: value || '0',
    gasLimit,
    chainId,
  };

  if (data) {
    tx.data = data;
  }

  if (nonce !== undefined) {
    tx.nonce = nonce;
  }

  // EIP-1559 or legacy
  if (maxFeePerGas != null && maxPriorityFeePerGas != null) {
    if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
      throw new Error('Invalid transaction fees: priority fee exceeds maximum fee');
    }
    tx.maxFeePerGas = maxFeePerGas;
    tx.maxPriorityFeePerGas = maxPriorityFeePerGas;
    tx.type = 2; // EIP-1559
  } else if (gasPrice) {
    tx.gasPrice = gasPrice;
    tx.type = 0; // Legacy
  }

  return tx;
}

/**
 * Best-effort check that a device-broadcast tx really came from the
 * signer's account: a compromised responder could report the hash of
 * someone else's transaction. The tx usually reaches our RPC a beat
 * after the device's, so "not visible yet" is not an error — only a
 * visible mismatch is.
 */
async function verifyDeviceBroadcastFrom(hash, expectedFrom, chainId) {
  let tx;
  try {
    ({ result: tx } = await chainData.request(chainId, 'eth_getTransactionByHash', [hash]));
  } catch (err) {
    console.warn('[TransactionService] Device-broadcast lookup failed:', err.message);
    return;
  }
  if (!tx) {
    console.warn('[TransactionService] Device-broadcast tx not visible on our RPC yet:', hash);
    return;
  }
  if (tx.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    throw createRemoteError(REMOTE_ERROR_CODES.WRONG_ACCOUNT);
  }
}

/**
 * Fill in fee parameters the caller didn't supply.
 *
 * ethers' Wallet.sendTransaction used to populate missing fees from the
 * network before signing. Now that signing and broadcasting are separate
 * steps nothing does, so an unpriced tx would be signed with
 * maxFeePerGas = 0 and rejected by every node as underpriced — on a
 * hardware wallet, only after the user confirmed it on-device. Populate
 * (or refuse) here, before the signer is ever asked to sign.
 *
 * @param {Object} params
 * @returns {Promise<{maxFeePerGas?: string, maxPriorityFeePerGas?: string, gasPrice?: string}>}
 */
async function resolveFeeParams({ maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId }) {
  if ((maxFeePerGas && maxPriorityFeePerGas) || gasPrice) {
    return { maxFeePerGas, maxPriorityFeePerGas, gasPrice };
  }

  const fees = await getGasPrices(chainId);

  if (fees.type === 'eip1559' && isPositiveFee(fees.maxFeePerGas) && isPositiveFee(fees.maxPriorityFeePerGas)) {
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }
  if (isPositiveFee(fees.gasPrice)) {
    return { gasPrice: fees.gasPrice };
  }

  throw new Error('Unable to determine a gas price for this transaction. Please try again.');
}

function isPositiveFee(value) {
  try {
    return value !== undefined && value !== null && BigInt(value) > 0n;
  } catch {
    return false;
  }
}

// Today's friendly texts for send failures (texts are PR 10's). Device
// backends' errors and the intent records' own refusals carry a stable code
// and a message meant for the user, so they pass through as they are.
function toSendError(err) {
  if (typeof err.code === 'string' && /^(LEDGER|REMOTE|INTENT|NONCE)_/.test(err.code)) {
    return err;
  }

  const message = String(err?.message || '');
  const normalizedMessage = message.toLowerCase();
  if (normalizedMessage.includes('insufficient funds')) {
    return new Error('Insufficient funds for transaction', { cause: err });
  }
  if (
    [
      'nonce too low',
      'nonce too high',
      'invalid nonce',
      'nonce has already been used',
      'replacement transaction underpriced',
    ].some((pattern) => normalizedMessage.includes(pattern))
  ) {
    return new Error('Transaction nonce error. Please try again.', { cause: err });
  }
  if (
    normalizedMessage.includes('priority fee') ||
    normalizedMessage.includes('priorityfee') ||
    normalizedMessage.includes('maxfeepergas') ||
    normalizedMessage.includes('maxpriorityfeepergas') ||
    normalizedMessage.includes('fee cap') ||
    normalizedMessage.includes('base fee')
  ) {
    return new Error('Transaction fee data is invalid. Please refresh and try again.', {
      cause: err,
    });
  }
  if (normalizedMessage.includes('gas')) {
    return new Error('Gas estimation error. The transaction may fail.', { cause: err });
  }
  // Server errors (rate limiting, blocked, etc.)
  if (
    err.code === 'SERVER_ERROR' ||
    message.includes('SERVER_ERROR') ||
    message.includes('403') ||
    message.includes('429') ||
    normalizedMessage.includes('invalid numeric value')
  ) {
    return new Error('RPC provider temporarily unavailable. Please try again.', { cause: err });
  }

  return new Error(`Transaction failed: ${err.message}`, { cause: err });
}

/**
 * Phone wallets (the remote signer) populate fees, pick the nonce and
 * broadcast through their own RPC, so main has neither the nonce nor the
 * bytes: no intent record, no reservation (design 0005, "Retrying an
 * intent"). Only the intent fields go over; our gas parameters would be
 * stale guesses by the time the user confirms on the device.
 *
 * A lost answer to a payment that reached the phone is
 * REMOTE_OUTCOME_UNKNOWN (remote/bridge.js), passed through as it is: the
 * payment may have been sent, and nothing here sends it again.
 */
async function sendThroughDevice({ to, value, data, chainId }, signer) {
  try {
    const from = await signer.getAddress();
    const hash = await signer.sendTransaction({ to, value, data, chainId });
    await verifyDeviceBroadcastFrom(hash, from, chainId);
    console.log('[TransactionService] Transaction broadcast by signer:', hash);
    return {
      hash,
      from,
      to,
      value,
      chainId,
      explorerUrl: getTxExplorerUrl(chainId, hash),
    };
  } catch (err) {
    console.error('[TransactionService] Transaction failed:', err);
    throw toSendError(err);
  }
}

// The txpool refusals design 0005 lists ("Refusals"), as a `rejected`
// outcome's reason class.
const REFUSAL_CLASSES = [
  'insufficient funds',
  'nonce too low',
  'replacement transaction underpriced',
  'transaction underpriced',
  'intrinsic gas too low',
  'exceeds block gas limit',
  'max fee per gas less than block base fee',
  'max priority fee per gas higher than max fee per gas',
  'invalid sender',
  'invalid chain id',
  'oversized data',
  'transaction type not supported',
];

function refusalClass(err) {
  const message = String(err?.message || '');
  return REFUSAL_CLASSES.find((refusal) => message.startsWith(refusal)) ?? null;
}

function shortText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/**
 * Hand a committed transaction of an intent to the broadcaster, and record
 * how it ended. The handoff is committed before the bytes leave main.
 *
 * Returns for `sent` and `uncertain`: `uncertain` may have been sent, so it
 * is never a failure, and the hash is always main's own keccak of the bytes.
 * Throws only for `rejected` and `not_sent` (today's texts, with `outcome`,
 * `intentId` and, for a refusal, its `reasonClass` on the error); nothing
 * after a broadcast that may have gone out throws.
 *
 * @param {Object} intent - Intent store view: intentId, chainId, sender, nonce
 * @param {{ handoffId: string, hash: string, raw: string }} handoff
 * @param {{ resent?: boolean }} [extra]
 */
async function broadcastIntent(intent, handoff, extra = {}) {
  const { intentId, chainId } = intent;
  const { hash, raw } = handoff;
  // Everything the result needs, before the bytes go anywhere.
  const parsed = Transaction.from(raw);
  const result = {
    hash,
    nonce: parsed.nonce,
    from: parsed.from,
    to: parsed.to,
    value: parsed.value.toString(),
    chainId,
    explorerUrl: getTxExplorerUrl(chainId, hash),
    intentId,
    ...extra,
  };

  let outcome;
  let source;
  let failure = null;
  try {
    const broadcast = await chainData.broadcastRawTransaction(chainId, raw);
    source = broadcast?.source ?? null;
    // `sent` only when the broadcaster names these very bytes.
    const named = typeof broadcast?.result === 'string' && broadcast.result.toLowerCase() === hash;
    outcome = broadcast?.outcome !== 'uncertain' && named ? 'sent' : 'uncertain';
    if (outcome === 'uncertain' && broadcast?.result && !named) {
      console.warn(
        `[TransactionService] Broadcaster answered ${broadcast.result} for ${hash}; treating it as uncertain`
      );
    }
  } catch (err) {
    failure = err;
    source = err?.source ?? null;
    // A throw with no outcome may have gone out.
    outcome =
      err?.outcome === 'rejected' || err?.outcome === 'not_sent' ? err.outcome : 'uncertain';
  }

  try {
    await getIntentStore().outcome({
      intentId,
      handoffId: handoff.handoffId,
      outcome,
      source: shortText(source, 64),
      reasonClass: outcome === 'rejected' ? refusalClass(failure) : null,
    });
  } catch (err) {
    // The handoff stays open: possibly sent, which is the safe reading.
    console.warn(
      `[TransactionService] Could not record the outcome of intent ${intentId}:`,
      err.message
    );
  }

  if (outcome === 'rejected' || outcome === 'not_sent') {
    console.error('[TransactionService] Transaction failed:', failure);
    const error = toSendError(failure);
    error.outcome = outcome;
    error.intentId = intentId;
    if (outcome === 'rejected') error.reasonClass = refusalClass(failure);
    throw error;
  }
  if (failure) {
    console.warn(
      `[TransactionService] Broadcast of ${hash} ended without an outcome:`,
      failure.message
    );
  }
  console.log(`[TransactionService] Transaction ${outcome}:`, hash);
  return { ...result, outcome, broadcastSource: source };
}

// Committed, but not handed off: nothing left main.
function notSent(err, intentId) {
  const error = toSendError(err);
  error.outcome = 'not_sent';
  error.intentId = intentId;
  return error;
}

/**
 * A new intent: reserve the account's next nonce, build the transaction at
 * it, sign it (vault through the core, or a Ledger approval) and commit it,
 * all under the account's lock. Resolves with the committed intent (its id
 * named by the store); nothing has been sent yet. A failure before the
 * commit (a rejection on the device, a locked vault, a refused commit)
 * leaves nothing recorded.
 */
async function commitNewIntent(params, signer, { context = {}, key = null } = {}) {
  const { to, value, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId } =
    params;
  if (!gasLimit) throw new Error('Missing gas limit: refusing to sign a transaction without one');
  // All raw-signing backends need complete fee data before device approval.
  const fees = await resolveFeeParams({ maxFeePerGas, maxPriorityFeePerGas, gasPrice, chainId });
  const store = getIntentStore();
  await store.ready;

  let intent;
  try {
    const from = await signer.getAddress();
    let nonceSource;
    const readPending = async () => {
      const response = await chainData.request(chainId, 'eth_getTransactionCount', [
        from,
        'pending',
      ]);
      nonceSource = response.source;
      return BigInt(response.result);
    };

    intent = await reserve({ chainId, sender: from, readPending, store }, async (nonce) => {
      const tx = buildTransaction({
        to,
        value,
        data,
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        gasPrice: fees.gasPrice,
        nonce,
        chainId,
      });

      console.log('[TransactionService] Signing transaction:', {
        to: tx.to,
        value: tx.value,
        gasLimit: tx.gasLimit,
        chainId: tx.chainId,
        nonce: tx.nonce,
        nonceSource,
      });

      const raw = await signer.signTransaction(tx);
      // The store names the intent: its id comes back with the commit,
      // before anything is handed off.
      return store.commit({
        chainId,
        sender: from,
        nonce,
        hash: keccak256(raw),
        raw,
        via: 'original',
        context: intentContext(context, key),
      });
    });
  } catch (err) {
    console.error('[TransactionService] Transaction failed:', err);
    throw toSendError(err);
  }
  return intent;
}

// A committed new intent, handed to the broadcaster once the account's
// lock is released.
async function handOff(intent) {
  let handoff;
  try {
    handoff = await getIntentStore().handoff(intent.intentId);
  } catch (err) {
    console.error('[TransactionService] Transaction not sent:', err);
    throw notSent(err, intent.intentId);
  }
  return broadcastIntent(intent, handoff);
}

const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// What the record keeps of a send's context: display-only, so a value the
// record can't hold is dropped rather than failing the send.
function intentContext(context, key) {
  const walletIndex = context.walletIndex;
  return {
    kind: KIND_PATTERN.test(context.kind ?? '') ? context.kind : 'wallet-send',
    origin: shortText(context.origin, 2048),
    key,
    walletIndex: Number.isSafeInteger(walletIndex) && walletIndex >= 0 ? walletIndex : null,
  };
}

/**
 * Send a held intent's latest committed bytes again: no signing and no
 * nonce read, so it keeps its one nonce. The handoff is taken under the
 * account's lock, which a void takes too: a voided intent is refused, and a
 * void can't slip in while this one is under way. The broadcast itself runs
 * after the lock is released, as a new intent's does.
 *
 * @param {string} intentId
 * @param {{ hash?: string }} [options] which committed transaction to send
 *   again (one whose bytes are still kept); the latest by default
 * @returns {Promise<Object>} as signAndSendTransaction, with `resent: true`
 */
async function resendIntent(intentId, { hash } = {}) {
  const store = getIntentStore();
  await store.ready;
  const intent = store.get(intentId);
  if (!intent) {
    const error = new Error(
      "This payment is not in the wallet's records, so it can't be sent again."
    );
    error.code = 'INTENT_UNKNOWN';
    throw error;
  }
  let handoff;
  try {
    handoff = await withAccountLock({ chainId: intent.chainId, sender: intent.sender }, () =>
      store.handoff(intentId, hash)
    );
  } catch (err) {
    console.error('[TransactionService] Transaction not sent:', err);
    throw notSent(err, intentId);
  }
  console.log(`[TransactionService] Sending intent ${intentId} again at nonce ${intent.nonce}`);
  return broadcastIntent(intent, handoff, { resent: true });
}

// A replacement must raise every fee it pays by at least 10%: what nodes
// require of a transaction replacing another at the same nonce.
const REPLACEMENT_BUMP_PERCENT = 110n;

function bumped(value) {
  return (BigInt(value) * REPLACEMENT_BUMP_PERCENT + 99n) / 100n;
}

function feeTooLow() {
  const error = new Error('A replacement must raise the fee by at least 10%.');
  error.code = 'INTENT_FEE_TOO_LOW';
  return error;
}

/**
 * The fees of a replacement of `fields` (a held intent's latest unsigned
 * fields), checked: the same fee type, every fee at least 10% higher, and a
 * priority fee no higher than the maximum. Returns them as decimal strings.
 *
 * The rule is the one nodes apply to a replacement, `new ≥ ceil(old × 1.1)`
 * for each fee, so a priority fee of 0 may stay 0: its floor is 0 (and
 * `replacementFees` offers exactly that when no quote is available). The
 * maximum fee, or a legacy gas price, must be positive, so a replacement
 * always differs from what it replaces.
 */
function replacementFeesFor(fields, fees) {
  const quantity = (value, { positive }) => {
    try {
      const n = BigInt(value);
      if (n < 0n || (positive && n === 0n)) throw new Error('out of range');
      return n;
    } catch {
      throw feeTooLow();
    }
  };
  if (fields.type === 2) {
    const maxFeePerGas = quantity(fees?.maxFeePerGas, { positive: true });
    const maxPriorityFeePerGas = quantity(fees?.maxPriorityFeePerGas, { positive: false });
    if (fees.gasPrice !== undefined && fees.gasPrice !== null) throw feeTooLow();
    if (
      maxFeePerGas < bumped(fields.maxFeePerGas) ||
      maxPriorityFeePerGas < bumped(fields.maxPriorityFeePerGas)
    ) {
      throw feeTooLow();
    }
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new Error('Invalid transaction fees: priority fee exceeds maximum fee');
    }
    return {
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    };
  }
  if (fees?.maxFeePerGas !== undefined || fees?.maxPriorityFeePerGas !== undefined) {
    throw feeTooLow();
  }
  const gasPrice = quantity(fees?.gasPrice, { positive: true });
  if (gasPrice < bumped(fields.gasPrice)) throw feeTooLow();
  return { gasPrice: gasPrice.toString() };
}

function heldIntent(store, intentId) {
  const intent = store.get(intentId);
  if (!intent) {
    const error = new Error("This payment is not in the wallet's records.");
    error.code = 'INTENT_UNKNOWN';
    throw error;
  }
  if (intent.state !== 'held') {
    const error = new Error(
      intent.state === 'voided' ? 'This payment was voided.' : 'This payment is already settled.'
    );
    error.code = 'INTENT_NOT_HELD';
    throw error;
  }
  return intent;
}

/**
 * The fees to offer for replacing a held intent: each at least 10% above
 * what its latest transaction pays, and at least today's quote.
 *
 * @param {string} intentId
 * @returns {Promise<{maxFeePerGas: string, maxPriorityFeePerGas: string}|{gasPrice: string}>}
 */
async function replacementFees(intentId) {
  const store = getIntentStore();
  await store.ready;
  const { fields, chainId } = heldIntent(store, intentId);
  let quote = null;
  try {
    quote = await getGasPrices(chainId);
  } catch {
    // The bump alone still makes a valid replacement.
  }
  const atLeast = (floor, candidate) => {
    try {
      const n = BigInt(candidate);
      return n > floor ? n : floor;
    } catch {
      return floor;
    }
  };
  // The maximum fee and a legacy gas price must be positive in a
  // replacement (replacementFeesFor). An original sent at 0, with no quote
  // to raise it, is offered 1 wei: the smallest replacement allowed.
  const positive = (n) => (n > 0n ? n : 1n);
  if (fields.type === 2) {
    const eip1559 = quote?.type === 'eip1559';
    const maxPriorityFeePerGas = atLeast(
      bumped(fields.maxPriorityFeePerGas),
      eip1559 ? quote.maxPriorityFeePerGas : null
    );
    let maxFeePerGas = positive(
      atLeast(bumped(fields.maxFeePerGas), eip1559 ? quote.maxFeePerGas : quote?.gasPrice)
    );
    if (maxPriorityFeePerGas > maxFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
    return {
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    };
  }
  return {
    gasPrice: positive(
      atLeast(bumped(fields.gasPrice), quote?.gasPrice ?? quote?.maxFeePerGas)
    ).toString(),
  };
}

/**
 * Replace a held intent at its nonce: the same payment (to, value, data,
 * gas limit), signed again with fees at least 10% higher, so it can take
 * the nonce's slot from the transaction it replaces. Under the account's
 * lock, as a new intent's signature is, but `pending` is never read: the
 * nonce is the intent's own. Only one transaction at that nonce can be
 * mined, so a replacement can't pay twice.
 *
 * @param {string} intentId
 * @param {Object} fees - {maxFeePerGas, maxPriorityFeePerGas} or {gasPrice}
 * @param {import('./signers').Signer} signer - the intent's own account
 * @returns {Promise<Object>} as signAndSendTransaction, with `replaced: true`
 */
async function replaceIntent(intentId, fees, signer) {
  const store = getIntentStore();
  await store.ready;
  const intent = heldIntent(store, intentId);
  replacementFeesFor(intent.fields, fees);

  let committed = null;
  let handoff;
  try {
    handoff = await withAccountLock(
      { chainId: intent.chainId, sender: intent.sender },
      async () => {
        // As it stands under the lock: another replacement may have landed.
        const current = heldIntent(store, intentId);
        const checked = replacementFeesFor(current.fields, fees);
        if (String(await signer.getAddress()).toLowerCase() !== current.sender) {
          const error = new Error("This payment's account is not the one asked to sign it.");
          error.code = 'INTENT_KEY_MISMATCH';
          throw error;
        }
        const tx = buildTransaction({
          to: current.fields.to,
          value: current.fields.value,
          data: current.fields.data,
          gasLimit: current.fields.gasLimit,
          ...checked,
          nonce: current.nonce,
          chainId: current.chainId,
        });
        const raw = await signer.signTransaction(tx);
        committed = await store.commit({
          intentId,
          chainId: current.chainId,
          sender: current.sender,
          nonce: current.nonce,
          hash: keccak256(raw),
          raw,
          via: 'replacement',
        });
        return store.handoff(intentId, committed.hash);
      }
    );
  } catch (err) {
    console.error('[TransactionService] Replacement failed:', err);
    if (committed) throw notSent(err, intentId);
    const error = toSendError(err);
    error.intentId = intentId;
    throw error;
  }
  console.log(`[TransactionService] Replacing intent ${intentId} at nonce ${committed.nonce}`);
  return broadcastIntent(committed, handoff, { replaced: true });
}

/**
 * The held intent an intent key names (`safe-exec:<chain>:<safeTxHash>`,
 * `safe-deploy:<chain>:<safeAddress>`), or null.
 */
async function heldIntentFor(intentKey) {
  if (!intentKey) return null;
  const store = getIntentStore();
  await store.ready;
  return store.byKey(intentKey);
}

/**
 * A send under an intent key: the operation's first send creates the
 * intent, any later one sends it again. Keys come from main's own callers
 * only (Safe execution and deployment derive theirs), never from a
 * renderer. The decision is made under the key's lock, and the key is
 * checked again inside it before `pending` is read or anything is signed,
 * so two first sends can't both create the intent: the second waits and
 * sends the first's bytes again. A held intent of another chain, sender or
 * kind is refused, with nothing sent.
 */
async function sendUnderKey(params, signer, intentKey, context) {
  const next = await withIntentKeyLock({ intentKey }, async () => {
    const held = await heldIntentFor(intentKey);
    if (!held) {
      return { committed: await commitNewIntent(params, signer, { context, key: intentKey }) };
    }
    const sender = String(await signer.getAddress()).toLowerCase();
    const { kind } = intentContext(context, intentKey);
    if (
      held.chainId !== Number(params.chainId) ||
      held.sender !== sender ||
      held.context.kind !== kind
    ) {
      const error = new Error(
        "This payment's records belong to another account, network or kind of payment. " +
          'Nothing was sent.'
      );
      error.code = 'INTENT_KEY_MISMATCH';
      throw error;
    }
    return { held };
  });
  return next.held ? resendIntent(next.held.intentId) : handOff(next.committed);
}

/**
 * Sign and broadcast a transaction.
 *
 * Signing and broadcasting are separate steps so the signer can be
 * anything implementing the signer interface (vault key, hardware
 * device) — the provider only ever sees the serialized signed tx.
 *
 * Every send main signs is an intent (freedom-core design 0005, "Retrying
 * an intent"): signed at one nonce, committed to the intent records before
 * its bytes go anywhere, and never signed again at another nonce.
 * - **Phone wallets** sign and broadcast themselves: today's path, no record.
 * - **An `intentKey`**, from main's own callers only, names an operation
 *   that may be retried (sendUnderKey): its first send creates the intent,
 *   later ones send its bytes again (resendIntent). That is how Safe "Try
 *   again" and activation retries keep their nonce.
 * - **Anything else** is a new intent.
 *
 * Fee parameters are optional: when the caller supplies none they are
 * fetched from the network (see resolveFeeParams) rather than signed as
 * zero.
 *
 * @param {Object} params - Transaction parameters
 * @param {string} params.to - Recipient (or token contract for ERC-20)
 * @param {string} params.value - Value in wei
 * @param {string} [params.data] - Transaction data
 * @param {string} params.gasLimit - Gas limit
 * @param {string} [params.maxFeePerGas] - Max fee per gas (EIP-1559)
 * @param {string} [params.maxPriorityFeePerGas] - Max priority fee (EIP-1559)
 * @param {string} [params.gasPrice] - Gas price (legacy)
 * @param {number} params.chainId - Chain ID
 * @param {import('./signers').Signer} signer - Signer for the sending account
 * @param {Object} [options]
 * @param {string} [options.intentKey] - Names the intent across retries.
 *   Main's own callers only: never pass a renderer's value.
 * @param {{ kind?: string, origin?: string, walletIndex?: number }} [options.context]
 *   what the intent record keeps for display
 * @returns {Promise<Object>} Transaction result: `hash` (main's keccak of
 *   the bytes), `nonce`, `from`, `to`, `value`, `chainId`, `explorerUrl`,
 *   `broadcastSource`, `intentId` and `outcome` (`sent` or `uncertain`)
 */
async function signAndSendTransaction(params, signer, { intentKey = null, context = {} } = {}) {
  if (typeof signer.sendTransaction === 'function') {
    return sendThroughDevice(params, signer);
  }
  if (intentKey) return sendUnderKey(params, signer, intentKey, context);
  return handOff(await commitNewIntent(params, signer, { context }));
}

/**
 * Get transaction status/receipt
 * @param {string} txHash - Transaction hash
 * @param {number} chainId - Chain ID
 * @returns {Promise<Object>} Transaction status
 */
async function getTransactionStatus(txHash, chainId) {
  try {
    const { result: receipt } = await chainData.request(chainId, 'eth_getTransactionReceipt', [txHash]);

    if (!receipt) {
      return {
        status: 'pending',
        hash: txHash,
      };
    }

    return {
      status: BigInt(receipt.status || 0) === 1n ? 'confirmed' : 'failed',
      hash: txHash,
      blockNumber: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed).toString() : null,
      effectiveGasPrice: receipt.effectiveGasPrice
        ? BigInt(receipt.effectiveGasPrice).toString()
        : null,
      explorerUrl: getTxExplorerUrl(chainId, txHash),
    };
  } catch (err) {
    console.error('[TransactionService] Failed to get transaction status:', err);
    return {
      status: 'unknown',
      hash: txHash,
      error: err.message,
    };
  }
}

/**
 * Wait for transaction confirmation
 * @param {string} txHash - Transaction hash
 * @param {number} chainId - Chain ID
 * @param {number} confirmations - Number of confirmations to wait for
 * @returns {Promise<Object>} Transaction receipt
 */
async function waitForTransaction(txHash, chainId, confirmations = 1) {
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = await getTransactionStatus(txHash, chainId);
      if (status.status === 'failed') return status;
      if (status.status === 'confirmed') {
        if (confirmations <= 1) return status;
        try {
          const { result: head } = await chainData.request(chainId, 'eth_blockNumber');
          if (Number(BigInt(head)) - status.blockNumber + 1 >= confirmations) return status;
        } catch (err) {
          // Receipt confirmation is already known. A transient head lookup
          // must not turn that into a false timeout; keep polling until the
          // requested confirmation depth can be established.
          console.warn('[TransactionService] Confirmation head lookup failed:', err.message);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('Timed out waiting for transaction confirmation');
  } catch (err) {
    console.error('[TransactionService] Wait for transaction failed:', err);
    throw new Error(`Transaction confirmation timeout: ${err.message}`, { cause: err });
  }
}

module.exports = {
  estimateGas,
  getGasPrices,
  toFeeFields,
  buildErc20TransferData,
  parseAmount,
  formatAmount,
  buildTransaction,
  signAndSendTransaction,
  resendIntent,
  replaceIntent,
  replacementFees,
  heldIntentFor,
  getTransactionStatus,
  waitForTransaction,
};
