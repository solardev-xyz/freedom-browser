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
 *   method that raises a cap's amount or window. The activity pane lowers
 *   a cap's amount or shortens its window through the core's narrowing
 *   (`x402.update`, cored 0.19.0), which refuses anything that isn't
 *   strictly narrower, and revokes a cap; it never raises one.
 * - **A cap's payment is sent** only once the core accepts `sent` for it
 *   (`settleSent`): one whose cap was revoked, or revoked and granted
 *   again, since its charge is refused (`cap_changed`), and main withholds
 *   its header.
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
 * The caps of `origin` read again: resolves once that read has landed in
 * the mirror (or failed, when the mirror drops the key until the core
 * answers again); never rejects.
 */
function rereadCaps(origin) {
  const key = normalizeOrigin(origin);
  if (!key) return Promise.resolve();
  try {
    return Promise.resolve(mirror().reread(key)).then(
      () => {},
      () => {}
    );
  } catch {
    // No mirror (a test without the core): nothing to wait for.
    return Promise.resolve();
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
 * Narrow one cap: `x402.update { key, cap: { chain_id, asset }, cap_amount?,
 * window_seconds? }` as the chrome (cored 0.19.0). Main refuses, unasked,
 * a change that isn't strictly narrower than the cap as the mirror holds
 * it, field by field; the core judges it again against its own file and
 * refuses anything else (`forbidden`), writing nothing. The key reads as
 * no cap while the core writes (a narrowing), then as the core answers.
 *
 * @param {{capAmount?: string, windowSeconds?: number}} change
 * @returns {Promise<object>} the core's reply, `{ cap, durable? }`, or
 *   `{ saved: false }` for a narrowing that stands unsaved
 */
function narrow(origin, chainId, asset, change = {}) {
  const key = normalizeOrigin(origin);
  if (!key) return Promise.reject(new Error('An auto-pay cap needs the site it is for'));
  const { capAmount, windowSeconds } = change;
  if (capAmount === undefined && windowSeconds === undefined) {
    return Promise.reject(new Error('Nothing to change'));
  }
  if (capAmount !== undefined && (typeof capAmount !== 'string' || !/^(0|[1-9]\d*)$/.test(capAmount))) {
    return Promise.reject(new Error("An auto-pay cap is a whole number of the token's smallest units"));
  }
  if (windowSeconds !== undefined && (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1)) {
    return Promise.reject(new Error("An auto-pay cap's window is a whole number of seconds"));
  }
  const cap = (mirror().get(key) || []).find((record) => record.chainId === chainId && sameAsset(record.asset, asset));
  if (!cap) return Promise.reject(new Error('This auto-pay cap is no longer there'));
  if (capAmount !== undefined && !(BigInt(capAmount) < BigInt(cap.capAmount))) {
    return Promise.reject(narrowOnlyError());
  }
  if (windowSeconds !== undefined && !(cap.createdAt + windowSeconds < cap.expiresAt)) {
    return Promise.reject(narrowOnlyError());
  }
  const params = { key, cap: { chain_id: chainId, asset } };
  if (capAmount !== undefined) params.cap_amount = capAmount;
  if (windowSeconds !== undefined) params.window_seconds = windowSeconds;
  return mirror().narrow(key, params, 'chrome');
}

const NARROW_ONLY =
  'An auto-pay cap can only be lowered here. To raise it, set a new cap when you next approve a payment.';

function narrowOnlyError() {
  const err = new Error(NARROW_ONLY);
  err.code = 'forbidden';
  return err;
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

/**
 * `x402.settle { reservation, outcome: 'sent' }` for a cap's payment, before
 * its header is attached: the core accepts it only while the cap it was
 * charged to stands. Resolves `{ sent: true }`, or `{ sent: false, reason }`
 * when the core refused it or couldn't be asked: `cap_changed` (the cap was
 * revoked, or revoked and granted again, since the charge; the reservation
 * is spent and the charge stays where it was taken) or any other failure.
 * Never rejects.
 */
async function settleSent(reservation, origin = null) {
  if (typeof reservation !== 'string' || reservation.length === 0) return { sent: false, reason: 'no_reservation' };
  try {
    await vault().x402.settle({ reservation, outcome: 'sent' });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.data?.reason ?? err?.code ?? 'unavailable', message: err?.message };
  } finally {
    reread(origin);
  }
}

/**
 * `x402.settle { reservation, signature }`: a device's signature over the
 * typed data `x402.authorize { device }` gave. Resolves the core's reply,
 * `{ payload, charged, grant?, durable? }` (the reservation then waits for
 * `sent` or `withheld`); rejects with the core's refusal (`not_authorized`,
 * `wrong_account` or `bad_response`, with `data.refunded`: the reservation
 * is spent). The mirror reads the seller's caps again either way.
 */
async function settleSignature(reservation, signature, origin = null) {
  try {
    return await vault().x402.settle({ reservation, signature });
  } finally {
    reread(origin);
  }
}

function refusal(code, message, data) {
  return Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
}

/**
 * `x402.settle { reservation, typed_data }` (freedom-core design 0016,
 * "x402 from a Ledger account", D2, and LDG-2's L5 as built): a Ledger
 * payment made with `now_s`, `typedData` main's own frozen rebuild of its
 * authorization (ledger-authorization.js), which the core requires to equal
 * the one it reserved and signs on its device lane. Main's relay for the
 * core's `shell.ledger_apdu` (core/ledger-relay.js) carries each APDU to
 * the device once it is admitted against the stream main derives here,
 * before the settle is sent, from that same copy, the account's `path`
 * from main's record snapshot and main's own `expectedHash` of the copy
 * (`prepare`). A stream main can't derive is refused unsent
 * (`invalid_argument`, with the relay's rule and reason). Otherwise the
 * settle goes under the device watchdog (vault-backend.js
 * `x402.settleOnLedger`) and is opened in the relay from its `onSent`,
 * before the core can ask anything for it; its end, whatever it is, closes
 * it there.
 *
 * `track` is filled as the settle goes: `track.sent` once it is written to
 * the core (from then on the reservation is the core's to spend, however
 * the settle ends), and `track.signed` once it ends, the relay's
 * `handle.signed` (whether the device's signature may have left main).
 * Resolves
 * `{ payload, charged, grant?, durable? }` (the reservation then waits for
 * `sent` or `withheld`); rejects with the core's error, whose `data.refunded`
 * says whether the charge's room is back on its cap (`cancelled` carries
 * none). The mirror reads the seller's caps again either way.
 */
async function settleTypedData(reservation, typedData, { path, expectedHash, origin = null, track = {} } = {}) {
  try {
    const relay = require('../core/core-process').getLedgerRelay();
    if (!relay) throw refusal('core_unavailable', 'The identity core is not running');
    const params = { reservation, typed_data: typedData };
    const prepared = relay.prepare({ method: 'x402.settle', params, path, expectedHash });
    if (!prepared.ok) {
      throw refusal('invalid_argument', "A Ledger can't sign this payment", {
        rule: prepared.rule,
        reason: prepared.reason,
      });
    }
    const controller = new AbortController();
    let handle = null;
    let unopened = null;
    try {
      return await vault().x402.settleOnLedger(params, {
        signal: controller.signal,
        onSent: (id, generation) => {
          track.sent = true;
          try {
            handle = relay.open({ id, generation }, { prepared, controller });
          } catch (err) {
            // Every APDU of it would be refused: main cancels it at once.
            unopened = err;
            controller.abort();
          }
        },
      });
    } catch (err) {
      throw unopened ?? err;
    } finally {
      track.signed = handle?.signed === true;
      handle?.close();
    }
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
  settleSent,
  settleSignature,
  settleTypedData,
  rereadCaps,
  narrow,
  NARROW_ONLY,
  capKeyOf,
};
