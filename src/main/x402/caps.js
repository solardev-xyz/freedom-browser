/**
 * x402's auto-pay caps, as the identity core holds them (freedom-core design
 * 0012, "x402"; X402-2).
 *
 * `x402-permissions.json` is the core's file: `x402` is in the hello's
 * `grant_moved` (core/core-client.js), and main writes it nowhere. The core
 * charges a cap as it signs a payment (`x402.authorize`), gives a charge back
 * for a payment main withheld (`x402.settle`), writes the cap a payment's
 * approval grants with it, and revokes caps (`approval.revoke`). Main reads
 * the caps through the core (`approval.grants`), on the mirror
 * core/grants.js keeps, so its reads stay synchronous: the auto-pay
 * pre-check (payment-utils.js), the approval card's cap state and the
 * activity pane. The core decides each payment again, so a mirror a moment
 * behind can't make it pay what no cap covers.
 *
 * - **A cap answers** while `createdAt <= now < expiresAt`, as the core's
 *   does (a clock set back expires it), and its asset in any case: the core
 *   keys it in lowercase (`x402-asset-case`).
 * - **Widening a cap** needs a decision the core checks: a payment's
 *   `x402-payment` token that binds the new cap (`grant`). Main has no
 *   method that raises a cap's amount or window, and neither has the core
 *   before a narrowing method of its own (pending): the activity pane can
 *   revoke a cap, never raise one.
 *
 * x402/permissions.js, main's store before X402-2, stays in place unused: an
 * older build's reading of the file the core writes now (the rollback).
 */

const { normalizeOrigin } = require('../../shared/origin-utils');

function mirror() {
  return require('../core/grants').grantStore('x402');
}

function vault() {
  return require('../core/vault-backend').vaultBackend;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function answers(record, now = nowSeconds()) {
  return (
    Number.isFinite(record?.createdAt) &&
    Number.isFinite(record?.expiresAt) &&
    record.createdAt <= now &&
    now < record.expiresAt &&
    typeof record.capAmount === 'string' &&
    /^\d+$/.test(record.capAmount) &&
    typeof record.spentAmount === 'string' &&
    /^\d+$/.test(record.spentAmount)
  );
}

function sameAsset(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * The cap for an origin, chain and asset (any case) if it answers now, as
 * the core last reported it, or null.
 *
 * @returns {{origin: string, chainId: number, asset: string, capAmount: string,
 *   spentAmount: string, createdAt: number, expiresAt: number} | null}
 */
function getPermission(origin, chainId, asset) {
  const key = normalizeOrigin(origin);
  if (!key) return null;
  const now = nowSeconds();
  const found = (mirror().get(key) || []).find(
    (record) => record.chainId === chainId && sameAsset(record.asset, asset) && answers(record, now)
  );
  return found ? { ...found, origin: key } : null;
}

/** Every cap that answers now, as the core holds them (the activity pane). */
function getAllPermissions() {
  const now = nowSeconds();
  return mirror()
    .all()
    .filter((record) => answers(record, now));
}

/**
 * Revoke one cap: `approval.revoke { store: 'x402', key, what: { cap } }`,
 * the chrome's narrowing. Resolves once the core has answered and the
 * mirror holds its answer.
 */
function revoke(origin, chainId, asset) {
  const key = normalizeOrigin(origin);
  if (!key) return Promise.reject(new Error('An auto-pay cap needs the site it is for'));
  return mirror().revoke(key, { cap: { chain_id: chainId, asset } }, 'chrome');
}

/** Revoke every cap of an origin (`what: 'grant'`), the chrome's narrowing. */
function revokeAllForOrigin(origin) {
  const key = normalizeOrigin(origin);
  if (!key) return Promise.reject(new Error('An auto-pay cap needs the site it is for'));
  return mirror().revoke(key, 'grant', 'chrome');
}

/**
 * The cap key the core computes from a paid URL (Q11): its origin. Main's
 * mirror is read again for it after each payment, whatever the outcome.
 */
function capKeyOf(url) {
  try {
    const parsed = new URL(url);
    return normalizeOrigin(parsed.origin === 'null' ? url : parsed.origin);
  } catch {
    return null;
  }
}

function reread(key) {
  if (!key) return;
  try {
    // Kept, not hidden, until the answer lands: a charge only narrows, and
    // the core judges every payment again.
    mirror().reread(key);
  } catch {
    // No mirror (a test without the core): nothing to read again.
  }
}

/**
 * `x402.authorize`: the core checks the token or the cap, charges a cap
 * before it signs, and builds and signs the payment. The mirror reads the
 * seller's caps again afterwards, whatever the outcome.
 */
async function authorize(params) {
  try {
    return await vault().x402.authorize(params);
  } finally {
    reread(capKeyOf(params?.detection?.url));
  }
}

/**
 * `x402.settle`: `withheld` gives a payment's charge back (main dropped its
 * header), `sent` keeps it. Resolves whether anything was given back; never
 * rejects (a reservation the core no longer holds keeps its charge, as the
 * core does with one it dropped).
 */
async function settle(reservation, outcome, origin = null) {
  if (typeof reservation !== 'string' || reservation.length === 0) return false;
  try {
    const reply = await vault().x402.settle({ reservation, outcome });
    return reply?.refunded === true;
  } catch (err) {
    console.warn(`[x402:permissions] could not settle a payment (${outcome}): ${err.message}`);
    return false;
  } finally {
    reread(origin);
  }
}

module.exports = {
  getPermission,
  getAllPermissions,
  revoke,
  revokeAllForOrigin,
  authorize,
  settle,
  capKeyOf,
};
