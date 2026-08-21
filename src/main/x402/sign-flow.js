/**
 * Shared "sign + queue retry" flow.
 *
 * Two call sites:
 *   - Auto-pay path in the detector, fired when an active cap covers
 *     the charge — silent, no UI.
 *   - The x402:approve IPC handler, fired when the user clicks Approve
 *     in the sidebar.
 *
 * Both want the same sequence: pick up the latest detected payment
 * for the webContents, build the vault-backed x402 client, sign,
 * stash the signed header for the dispatcher to inject, optionally
 * grant a fresh per-origin allowance and consume against it, then
 * re-issue the original navigation. Extracting here keeps that
 * sequence in one place and dodges a circular ipc.js ↔ intercept.js
 * dependency.
 */

const { webContents } = require('electron');
const log = require('../logger');
const { createX402Client } = require('./client');
const { getActiveWalletIndex } = require('../identity-manager');
const { normalizeOrigin } = require('../../shared/origin-utils');
const {
  X402_HEADERS,
  AUTHORIZED_BY,
  outgoingHeaderForVersion,
  getDetectedPayment,
  clearDetectedPayment,
  setPendingPayment,
} = require('./intercept');
const { grant: grantPermission } = require('./permissions');
const { tupleFromAccept } = require('./payment-utils');

/**
 * Runway an EIP-3009 authorization must still have when we hand it to the
 * dispatcher. `@x402/evm`'s exact facilitator rejects anything with
 * `validBefore < now + 6`, so a payload with less than that left is dead on
 * arrival however valid the signature is. We gate on the *client's* clock at
 * sign-completion, but the facilitator re-checks the same rule on *its* clock
 * seconds later — after the mainFrame re-navigation, the server round-trip and
 * the server→facilitator verify hop — so matching the bare 6 leaves no margin
 * for transit or clock skew and can still be refused server-side (the exact
 * burned-charge case this gate exists to prevent). Keep comfortably above it;
 * a false positive only re-shows the same "try again" card.
 */
const MIN_AUTHORIZATION_RUNWAY_SECONDS = 20;

/**
 * Seconds left on the signed authorization, or `null` when the payload has
 * no `validBefore` to check (non-EIP-3009 scheme, or a test double).
 *
 * Both the V1 and V2 exact schemes nest the authorization the same way:
 * `{ payload: { authorization: { validBefore } } }`.
 */
function authorizationRunwaySeconds(payload) {
  const validBefore = Number(payload?.payload?.authorization?.validBefore);
  if (!Number.isFinite(validBefore)) return null;
  return validBefore - Math.floor(Date.now() / 1000);
}

/**
 * Sign the currently-detected payment for `webContentsId` and queue a
 * retry of the original URL. Throws on any failure (vault locked, URL
 * unparseable, client error, an authorization that expired while it was
 * being confirmed). Caller decides how to surface the error.
 *
 * `opts.detection` lets the caller pass an explicit snapshot of the
 * detection to sign — used by the auto-pay path so a second 402 firing
 * between setImmediate-schedule and setImmediate-run can't redirect the
 * sign to a different charge. When omitted (IPC approve path) we fall
 * back to looking up the current detection by webContentsId.
 *
 * `opts.authorizedBy` rides through to the pending payment so the inject
 * handler can withhold the signature if a cap-authorized auto-pay races
 * over the cap. Defaults to MANUAL — callers that aren't auto-pay should
 * omit it. The auto-pay path must pass CAP explicitly.
 *
 * `opts.selectedAccept` is the specific `accepts[]` entry to sign.
 * Multi-accept callers (detector's findCoveringPermission result, or
 * the IPC's selectedAcceptIndex resolution) pass it explicitly.
 * Detection records can also carry a `selectedAccept` field (set by
 * the auto-pay branch so its snapshot survives across the cap-locked
 * unlock-resume). Legacy callers that omit both default to
 * `accepts[0]` — preserves single-accept behavior during the WP-MA
 * migration.
 *
 * `detection.requestShape` (captured `{ method, range }`) threads
 * through to setPendingPayment for shape-keyed FIFO bucketing.
 *
 * @param {number} webContentsId
 * @param {{
 *   grant?: { capAmount: string, windowSeconds: number },
 *   detection?: { url: string, requirements: object, resourceType?: string, selectedAccept?: object, requestShape?: { method: string, range: string | null } },
 *   selectedAccept?: object,
 *   authorizedBy?: 'cap' | 'manual',
 * }} [opts]
 */
async function signAndQueueRetry(webContentsId, opts = {}) {
  // `webContents.fromId` is native and throws a cryptic ABI-style error
  // for non-integer input. Reject early with something the caller can act on.
  if (typeof webContentsId !== 'number' || webContentsId < 0) {
    throw new Error(`x402: invalid webContentsId: ${webContentsId}`);
  }
  const detected = opts.detection ?? getDetectedPayment(webContentsId);
  if (!detected) throw new Error('No pending x402 payment for this tab');

  const selectedAccept = opts.selectedAccept
    ?? detected.selectedAccept
    ?? detected.requirements?.accepts?.[0];
  if (!selectedAccept) throw new Error('No accepts[] entry to sign');

  let origin;
  try {
    const parsed = new URL(detected.url);
    origin = normalizeOrigin(parsed.origin === 'null' ? detected.url : parsed.origin);
  }
  catch { throw new Error('Refusing to pay: unparseable URL'); }
  if (!origin) throw new Error('Refusing to pay: unnormalisable origin');

  const client = await createX402Client(getActiveWalletIndex());
  // Pre-filter `accepts[]` down to the chosen entry so the SDK's default
  // first-of-filtered selector signs the right one. Avoids registering a
  // custom paymentRequirementsSelector for what is effectively a one-
  // entry choice at this point in the flow.
  const payload = await client.createPaymentPayload({
    ...detected.requirements,
    accepts: [selectedAccept],
  });

  // The SDK stamps `validBefore = now + maxTimeoutSeconds` BEFORE it asks the
  // signer for a signature, and on a hardware wallet that call blocks for as
  // long as the user takes to review the EIP-712 payload on the device. A
  // confirmation slower than the server's window (often ~60s) therefore
  // produces a perfectly valid signature over an already-expired
  // authorization. Dispatching it burns the charge: the facilitator refuses
  // it, the server re-402s, the loop guard in intercept.js declines to
  // re-sign, and a `failed` row lands in payment history after the user
  // physically confirmed on the device.
  //
  // Widening the window instead (inflating `maxTimeoutSeconds` on the accept
  // we sign) is NOT an option: for x402 v2 the client echoes the selected
  // requirements back as `payload.accepted`, and @x402/core's server does a
  // deep-equal against its own advertised accepts — a padded window would be
  // rejected as a non-matching requirement.
  //
  // So bail before anything is stashed or navigated. The detection is still
  // in the map and no pending payment is armed, which means the caller's
  // error surfaces on the approval card with Pay live again — a second
  // device prompt, but no reload and no bogus failure row.
  const runway = authorizationRunwaySeconds(payload);
  if (runway !== null && runway < MIN_AUTHORIZATION_RUNWAY_SECONDS) {
    log.warn(
      `[x402:sign] authorization expired during signing (${runway}s of runway left); ` +
      `not dispatching a payment the facilitator will refuse`
    );
    throw new Error(
      'Payment authorization expired while it was being confirmed. Please try again.'
    );
  }

  const headerValue = Buffer.from(JSON.stringify(payload)).toString('base64');
  const headerName = outgoingHeaderForVersion(detected.requirements.x402Version);
  const tuple = tupleFromAccept(selectedAccept);
  const payTo = selectedAccept.payTo ?? null;

  setPendingPayment(
    webContentsId,
    detected.url,
    {
      header: headerName,
      value: headerValue,
      origin,
      chainId: tuple?.chainId,
      asset: tuple?.asset,
      amount: tuple?.amount,
      payTo,
      fromAddress: client.address,
      authorizedBy: opts.authorizedBy ?? AUTHORIZED_BY.MANUAL,
    },
    detected.requestShape,
  );
  // Only clear the map when we sourced FROM it. With a snapshot we used
  // our own copy and clearing here would erase whatever detection has
  // since taken its place (e.g. a second 402 that fired during our async
  // sign and is now showing in the sidebar).
  if (!opts.detection) {
    clearDetectedPayment(webContentsId);
  }

  // `grant` (create-a-cap) is an explicit user action from the approval
  // card and happens here, at sign time. `tryConsume` (burn-from-cap)
  // lives in the inject handler so we only bump `spentAmount` when the
  // signature actually rides out on a real request — subresource 402s
  // that sign-but-never-retry must not burn cap headroom.
  if (tuple && opts.grant) {
    try {
      grantPermission(origin, tuple.chainId, tuple.asset, opts.grant.capAmount, opts.grant.windowSeconds);
    } catch (err) {
      log.warn(`[x402:sign] grant rejected: ${err.message}`);
    }
  }

  const wc = webContents.fromId(webContentsId);
  if (!wc) {
    log.warn(`[x402:sign] webContents ${webContentsId} vanished before re-navigation`);
    return;
  }
  // `wc.loadURL` is a tab-level navigation — correct when the 402 came
  // from a top-level navigation (the tab was *between pages*), but for
  // subresource 402s (xhr/fetch/media/image/...) it would evict the page
  // that initiated the fetch and replace it with the raw subresource URL.
  // Subresources don't navigate here at all; the detector's self-307
  // path (and the approval-card retry loop) returns the 307 directly
  // from onHeadersReceived. This function only stashes the pending
  // signature; the injector attaches it on the followed-redirect request.
  if (detected.resourceType === 'mainFrame') {
    wc.loadURL(detected.url).catch((err) => {
      log.error(`[x402:sign] re-navigation failed: ${err.message}`);
    });
  } else {
    log.info(
      `[x402:sign] subresource ${detected.resourceType ?? '<unknown>'} 402 paid; ` +
      `signature stashed for the self-307 follow-up to ${detected.url}`
    );
  }
}

module.exports = {
  signAndQueueRetry,
  X402_HEADERS,
};
