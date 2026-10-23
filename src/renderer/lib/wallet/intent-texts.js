/**
 * Every user-visible text about held payments (the wallet's intent
 * records): what a send's outcome means, the labels, and the words on the
 * buttons and warnings that offer to send a payment again or replace it.
 *
 * One module, so the product decisions D9 to D11 are a one-file change.
 * They are settled as written here: an outcome is described, never called
 * a failure, and nothing says "Please try again". A retry sends the same
 * signed payment again, at its one nonce, and can't pay twice.
 *
 * The payments page (pages/scripts/payments.js) is a classic script that
 * can't import this module. It keeps a copy of the final labels and of
 * TAKEN_EXPLANATION and CLOSED_EXPLANATION, and pages/payments.test.js
 * holds the copy equal.
 */

/** What happened to a send, by outcome (D9). */
export const OUTCOME_TEXT = Object.freeze({
  sent: 'Sent, waiting for confirmation',
  uncertain: 'Sent, waiting for confirmation',
  not_sent: 'Not sent; nothing left this computer',
});

/** A refusal, with the network's reason when it named one (D9). */
export function refusedText(reasonClass) {
  return reasonClass ? `The network refused it: ${reasonClass}` : 'The network refused it';
}

/**
 * The text for a failed or uncertain send's outcome, or null when the
 * reply carried none (an error before anything was signed).
 */
export function outcomeText(outcome, reasonClass) {
  if (outcome === 'rejected') return refusedText(reasonClass);
  return OUTCOME_TEXT[outcome] ?? null;
}

/**
 * Labels of a payment's state (D10). `confirmed`, `failed` and `taken` are
 * read at the finalized block (intent-labels.js: paid, failed, taken), and
 * the payments page shows them for a settled payment. `pending` is a held
 * one's. `couldntConfirm` is a held payment's whose label couldn't be read
 * for a day, and a payment's the user then closed by hand (design 0005,
 * "State history", #94).
 */
export const LABELS = Object.freeze({
  pending: 'Pending',
  confirmed: 'Confirmed (final)',
  failed: 'Failed on chain',
  taken: 'Taken',
  couldntConfirm: "Couldn't confirm",
});

/**
 * Shown with "Taken" (D10). Another transaction of the sender used the
 * payment's nonce on the finalized chain, so none of the payment's own
 * transactions can be mined. That other transaction may be this same
 * payment, signed elsewhere (design 0005, "Labels, not permissions").
 */
export const TAKEN_EXPLANATION =
  "Another transaction from this account used this payment's place in the queue, so this " +
  'payment will never go through. That transaction may have done the same thing.';

/**
 * A held payment's line in the list, by where it stands. `absent`: one
 * recovered after a restart that verified reads show is not on chain.
 */
export const ATTENTION_TEXT = Object.freeze({
  sending: 'Sending…',
  sent: OUTCOME_TEXT.sent,
  uncertain: OUTCOME_TEXT.uncertain,
  'not-sent': OUTCOME_TEXT.not_sent,
  absent: 'Not on chain yet',
  pending: LABELS.pending,
});

/**
 * A held payment whose label the wallet couldn't read on chain for a day
 * (design 0005, "State history", #94): shown with its nonce and its
 * hashes, each with an explorer link. Once the network shows its place in
 * the queue used, none of its transactions can go through, and it may be
 * closed by hand; the confirmation says that closing proves nothing about
 * whether it paid.
 */
export const COULDNT_CONFIRM = Object.freeze({
  label: LABELS.couldntConfirm,
  note:
    "We couldn't confirm whether this payment went through. It stays here, and the wallet " +
    'keeps checking.',
  explorer: 'View on explorer',
  close: 'Close payment',
  confirmClose:
    "We couldn't confirm whether this payment went through. It can no longer be sent. " +
    'Check the explorer to see what happened.',
  closing: 'Closing…',
});

/**
 * Shown with "Couldn't confirm" on the payments page, for a payment the
 * user closed by hand.
 */
export const CLOSED_EXPLANATION =
  "You closed this payment. We couldn't confirm whether it went through. Check the explorer " +
  'to see what happened.';

// What would settle the payment lies too deep below the finalized block to
// verify (intent-labels.js): it stays waiting, and after a day of that it
// is shown as Couldn't confirm.
export const UNVERIFIABLE_TEXT = 'Too old to check on chain';

export function attentionText(summary) {
  if (summary?.couldntConfirm) return COULDNT_CONFIRM.label;
  if (summary?.observed === 'unverifiable') return UNVERIFIABLE_TEXT;
  if (summary?.attention === 'refused') return refusedText(summary.lastOutcome?.reasonClass);
  return ATTENTION_TEXT[summary?.attention] ?? LABELS.pending;
}

/** Buttons. */
export const ACTIONS = Object.freeze({
  sendAgain: 'Send again',
  sendingAgain: 'Sending again…',
  // A failed send's payment that is no longer held: nothing to send again.
  close: 'Close',
});

/** Titles of the send screen's result views. */
export const RESULT_TITLES = Object.freeze({
  sent: 'Transaction Sent',
  uncertain: OUTCOME_TEXT.uncertain,
  failed: 'Transaction Failed',
  notSent: 'Not sent',
  refused: 'Refused by the network',
  unknown: 'Outcome unknown',
});

/**
 * The error code of a phone account's payment whose answer was lost (D13).
 * A phone signs and broadcasts the payment itself, so it may have been
 * sent: the screens title it as unknown and offer no retry, which would
 * ask the phone to pay again. The text, asking the user to check the
 * phone's wallet first, is main's (src/main/wallet/remote/errors.js).
 */
export const PHONE_OUTCOME_UNKNOWN = 'REMOTE_OUTCOME_UNKNOWN';

/**
 * The error a site gets for such a payment, from the approval or from an
 * auto-approved send (D13). Never EIP-1193's 4001 "User rejected the
 * request": that says nothing happened, so a site may send the request
 * again, and the phone could pay twice. No standard code means "the
 * outcome is unknown". EIP-1193's 4xxx codes and EIP-1474's -3200x each
 * say the request was refused, failed or never ran, so this is JSON-RPC's
 * -32603 (internal error), which claims neither. The message says what is
 * known, and `data.outcome` says it for a site that reads the error's data.
 * Neither names the account's kind.
 */
export const SITE_OUTCOME_UNKNOWN = Object.freeze({
  code: -32603,
  message:
    "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
  data: Object.freeze({ outcome: 'unknown' }),
});

/** A fresh copy of SITE_OUTCOME_UNKNOWN, to reject a site's request with. */
export function siteOutcomeUnknownError() {
  return { ...SITE_OUTCOME_UNKNOWN, data: { ...SITE_OUTCOME_UNKNOWN.data } };
}

/** The waiting payments: the identity-view row and its list. */
export const HELD = Object.freeze({
  // The sub-screen's title, "Payments Waiting", is in index.html.
  rowLabel: 'Payments waiting',
  message:
    'These payments are signed but not confirmed yet. Sending one again sends the same ' +
    'payment: it can only be paid once.',
  nonce: (nonce) => `nonce ${nonce}`,
  requestedBy: (origin) => `Requested by ${origin}`,
  contractCall: (to) => `Contract call to ${to}`,
  payment: (amount, symbol, to) => `${amount} ${symbol} to ${to}`,
  // A dApp's payment is sent again only after this second step: the site's
  // request may have moved on since.
  confirmDappResend: (origin, age) =>
    `Send the payment ${origin} requested ${age} again? It is the same signed payment.`,
  confirm: 'Confirm',
  cancel: 'Cancel',
});

/** Replacing a payment at its nonce with a higher fee. */
export const REPLACE = Object.freeze({
  replace: 'Raise the fee',
  speedUp: 'Speed up',
  newFee: (fee, symbol) => `New network fee: up to ${fee} ${symbol}`,
  note: 'The same payment, signed again with a higher fee. Only one of the two can go through.',
  replacing: 'Replacing…',
  replaced: 'Replaced with a higher fee',
});

/**
 * The warning on the send review when the new payment would wait behind an
 * earlier one of the account that hasn't gone through (D11).
 */
export function heldWarning(payment, nonce) {
  return (
    `This payment will wait behind an earlier one that hasn't gone through yet: ${payment} ` +
    `(${HELD.nonce(nonce)}). Send that one again or raise its fee first, from ` +
    `${HELD.rowLabel}.`
  );
}
