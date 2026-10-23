/**
 * The fee check at confirmation, on the approval screens (freedom-core
 * design 0005, A: the check at confirmation).
 *
 * Main judges a transaction's fee against today's network fee: when the
 * screen is shown (`wallet:fee-check`), and again at the user's press,
 * when it mints the confirmation (`wallet:confirm-signing`). The screen
 * shows the verdict:
 * - the most the payment can cost, and how its fee compares with today's
 *   network fee;
 * - above the threshold, an amber warning naming the ratio, and the
 *   confirm button asks again ("Send anyway") before anything is signed;
 * - without a reference, that the fee couldn't be compared.
 *
 * A fee that was fine when shown can be above the threshold at the press
 * (today's fee fell, or the evidence was gathered again): main then mints
 * nothing and answers FEE_CHECK_ASK_AGAIN with the new verdict, and the
 * screen asks again.
 */

/** Main's answer when a fee is newly above the threshold at the press. */
export const FEE_CHECK_ASK_AGAIN = 'FEE_CHECK_ASK_AGAIN';

/** Main's answer when an auto-approved send's fee needs the user. */
export const FEE_CHECK_NOT_AUTO_APPROVED = 'FEE_CHECK_NOT_AUTO_APPROVED';

/** Every text the fee check shows. */
export const FEE_CHECK = Object.freeze({
  upTo: (amount, symbol) => `Up to ${amount} ${symbol}`,
  compared: (ratio, oneEndpoint) =>
    oneEndpoint
      ? `About ${ratio}× today's network fee, as one network source reports it`
      : `About ${ratio}× today's network fee`,
  notCompared: "Couldn't compare this fee with today's network fee",
  above: (ratio) => `This network fee is ${ratio}× today's network fee.`,
  askAgain: 'Check the fee, then press Send anyway to pay it.',
  sendAnyway: 'Send anyway',
});

/** An amount of wei in whole units, rounded up at 9 decimals (a gwei):
 * "up to" never understates it. */
export function formatMaxCost(wei) {
  const gwei = 10n ** 9n;
  const amount = ((BigInt(wei) + gwei - 1n) / gwei) * gwei;
  const base = 10n ** 18n;
  const fraction = (amount % base).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${amount / base}.${fraction}` : String(amount / base);
}

/** The fee fields of a transaction, as main judges them. */
export function feeFields(tx) {
  const fields = { chainId: tx.chainId, gasLimit: tx.gasLimit };
  if (tx.maxFeePerGas != null && tx.maxPriorityFeePerGas != null) {
    fields.maxFeePerGas = tx.maxFeePerGas;
    fields.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  } else if (tx.gasPrice != null) {
    fields.gasPrice = tx.gasPrice;
  }
  return fields;
}

/** Main's verdict on `tx`'s fee, or null when it couldn't give one. */
export async function fetchFeeCheck(tx) {
  try {
    const result = await window.wallet.feeCheck(feeFields(tx));
    return result?.success ? result.feeCheck : null;
  } catch (err) {
    console.warn('[FeeCheck] No verdict:', err?.message);
    return null;
  }
}

/**
 * One confirmation's fee check: the verdict it shows, and whether the user
 * has confirmed a fee above the threshold again.
 *
 * @param {object} elements
 * @param {HTMLElement} [elements.maxEl] - "Up to …"
 * @param {HTMLElement} [elements.noteEl] - the comparison, or "couldn't compare"
 * @param {HTMLElement} [elements.warningEl] - the amber callout, shown above
 *   the threshold
 * @param {HTMLElement} [elements.warningTextEl] - its text
 */
export class FeeConfirmation {
  constructor({ maxEl = null, noteEl = null, warningEl = null, warningTextEl = null } = {}) {
    this.elements = { maxEl, noteEl, warningEl, warningTextEl };
    this.symbol = 'ETH';
    this.verdict = null;
    this.asking = false;
    this.acknowledged = false;
    this.request = 0;
  }

  /** Clears it for another transaction: nothing shown, nothing confirmed. */
  reset(symbol = 'ETH') {
    this.request += 1;
    this.symbol = symbol;
    this.verdict = null;
    this.asking = false;
    this.acknowledged = false;
    this.render();
  }

  /** Asks main for `tx`'s verdict and shows it; an answer for an earlier
   * transaction is dropped. */
  async load(tx, symbol = 'ETH') {
    this.reset(symbol);
    const request = this.request;
    const verdict = await fetchFeeCheck(tx);
    if (request !== this.request) return null;
    this.verdict = verdict;
    this.render();
    return verdict;
  }

  /**
   * The user pressed confirm. True to go on; false when the fee is above
   * the threshold and not yet confirmed again: the screen now asks, and the
   * next press confirms it.
   */
  proceed() {
    if (!this.verdict?.above || this.acknowledged) return true;
    if (this.asking) {
      this.acknowledged = true;
      return true;
    }
    this.asking = true;
    this.render();
    return false;
  }

  /** What the confirmation's request tells main of the user's answer. */
  options() {
    return this.acknowledged ? { feeAcknowledged: true } : undefined;
  }

  /**
   * Main asked again at the press (FEE_CHECK_ASK_AGAIN): show its verdict,
   * and ask. False for any other error.
   */
  askAgain(err) {
    if (err?.code !== FEE_CHECK_ASK_AGAIN || !err.feeCheck) return false;
    this.request += 1;
    this.verdict = err.feeCheck;
    this.acknowledged = false;
    this.asking = true;
    this.render();
    return true;
  }

  /** The confirm button's label: `label`, or "Send anyway" while asking. */
  confirmLabel(label) {
    return this.asking && !this.acknowledged ? FEE_CHECK.sendAnyway : label;
  }

  render() {
    const { maxEl, noteEl, warningEl, warningTextEl } = this.elements;
    const verdict = this.verdict;
    if (maxEl) {
      maxEl.textContent = verdict?.maxCost
        ? FEE_CHECK.upTo(formatMaxCost(verdict.maxCost), this.symbol)
        : '';
      maxEl.classList.toggle('hidden', !verdict?.maxCost);
    }
    if (noteEl) {
      let note = '';
      if (verdict && !verdict.comparable) note = FEE_CHECK.notCompared;
      else if (verdict && !verdict.above)
        note = FEE_CHECK.compared(verdict.ratio, verdict.oneEndpoint);
      noteEl.textContent = note;
      noteEl.classList.toggle('hidden', !note);
    }
    if (warningEl) {
      const above = Boolean(verdict?.above);
      if (warningTextEl) {
        warningTextEl.textContent = above
          ? `${FEE_CHECK.above(verdict.ratio)}${this.asking ? ` ${FEE_CHECK.askAgain}` : ''}`
          : '';
      }
      warningEl.classList.toggle('hidden', !above);
    }
  }
}
