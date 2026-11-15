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
 * for the webContents, have the identity core authorize and sign it
 * (`x402.authorize`, freedom-core design 0012 "x402"; X402-2), stash the
 * signed header for the dispatcher to inject, then re-issue the original
 * navigation. The core checks the `x402-payment` token or the cap, charges
 * a cap before it signs, writes the cap a payment grants, and builds the
 * payment byte for byte as `@x402/evm` builds it, with the account's vault
 * key. Main signs no x402 payment itself. Extracting here keeps that
 * sequence in one place and dodges a circular ipc.js ↔ intercept.js
 * dependency.
 */

const crypto = require('crypto');
const { webContents } = require('electron');
const log = require('../logger');
const { getActiveWalletIndex } = require('../identity-manager');
const { normalizeOrigin } = require('../../shared/origin-utils');
const {
  X402_HEADERS,
  AUTHORIZED_BY,
  outgoingHeaderForVersion,
  getDetectedPayment,
  clearDetectedPayment,
  setPendingPayment,
  sendToHost,
  hostWindowIdOf,
} = require('./intercept');
const { runInWindow } = require('../windows/request-window');
const { authorize: authorizePayment, settle: settlePayment } = require('./caps');
const { tupleFromAccept } = require('./payment-utils');
const { isUserPageId, isAgentPageId } = require('../wallet/agent-tab-custody');
const { withVaultAccount } = require('../wallet/vault-access');
const { discardConfirmation } = require('../wallet/signing-confirmation');

// An auto-pay whose cap no longer covers it, at the moment it would be
// signed: nothing is signed, and the charge goes to the approval card.
// A tab that has gone into Agent custody is not covered either.
const CAP_NOT_COVERED = 'X402_CAP_NOT_COVERED';

function capNotCoveredError(message = "This payment is no longer within the site's auto-pay allowance") {
  const err = new Error(message);
  err.code = CAP_NOT_COVERED;
  return err;
}

// An allowance pays only for a live tab the user controls (#1044).
// Detection reads custody as the 402 arrives (intercept.js); an auto-pay
// is signed later, after an unlock the user may take minutes over, or a
// confirmation on a hardware wallet, and the tab can have gone into Agent
// custody meanwhile. So custody is read again as the auto-pay is charged
// and signed. A tab in Agent custody is not covered, as at detection:
// nothing is signed for it, and the charge goes to the approval card.
function refuseUnlessUserTab(webContentsId) {
  if (!isUserPageId(webContentsId)) {
    throw capNotCoveredError("The site's auto-pay allowance pays only for an open tab that isn't in Agent custody");
  }
}

function isCapNotCoveredError(err) {
  return err?.code === CAP_NOT_COVERED;
}

// The core's refusals of a cap's payment (`not_authorized`): no cap covers
// it, the tab is in Agent custody, or main couldn't attribute the request.
const CAP_REFUSALS = new Set(['cap', 'custody', 'no_rule']);

// A device account (a Ledger, a phone) keeps its key elsewhere: the core
// signs x402 payments only with the vault's own accounts (cored 0.18.0).
function isDeviceAccount(walletIndex) {
  const { getWalletRecord, isHardwareWalletIndex, WALLET_TYPES } = require('../identity-manager');
  if (typeof isHardwareWalletIndex === 'function' && isHardwareWalletIndex(walletIndex)) return true;
  const record = typeof getWalletRecord === 'function' ? getWalletRecord(walletIndex) : null;
  return Boolean(record && WALLET_TYPES && record.type !== WALLET_TYPES.MNEMONIC);
}

const DEVICE_REFUSED =
  "x402 payments are signed by the browser's own wallet: a Ledger or phone account can't pay one yet";

// The paying account's address, from the authorization the core signed.
function payerOf(payload) {
  const inner = payload?.payload;
  const from = inner?.authorization?.from ?? inner?.permit2Authorization?.from;
  return typeof from === 'string' ? from : null;
}

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
 * Which `accepts[]` entry is paid is the core's to pick under a cap (the
 * first one a cap covers, in the seller's order, as
 * `findCoveringPermission` picks it), and the token's under an approval
 * (the entry its `accept_index` binds). The reply names it.
 *
 * `detection.requestShape` (captured `{ method, range }`) threads
 * through to setPendingPayment for shape-keyed FIFO bucketing.
 *
 * `opts.walletIndex` is the account to sign with: the one an approval's
 * confirmation token was minted for (x402:approve). Auto-pay omits it and
 * signs with the active account. A device account (a Ledger, a phone)
 * can't pay: the core signs only with the vault's own accounts.
 *
 * The identity core charges a cap as it signs (#1024, design 0012
 * `x402-at-sign`): an auto-pay (`authorizedBy: CAP`) is signed only if the
 * core's `x402.authorize` finds a cap that covers it, outside Agent custody
 * and for a request main attributes to a live tab, and charges it first.
 * Otherwise nothing is signed and this throws CAP_NOT_COVERED, as it does
 * for a tab that is not a live one the user controls, read before the core
 * is asked and again just before the stash (#1044). A payment the user
 * approved presents its `x402-payment` token (`opts.confirmation`, the
 * core's), which the core spends against exactly the tab, detection, URL,
 * entry, account and grant it binds; the core writes the cap granted with it
 * and charges a cap that covers it, as accounting. The reservation of a
 * charge rides on the pending payment: settled `withheld` if the signature
 * is withheld (intercept.js), and here if this throws before stashing it,
 * and `sent` once the header has been attached, whatever the server
 * answers: the seller holds the signed authorization.
 *
 * @param {number} webContentsId
 * @param {{
 *   detection?: { url: string, requirements: object, detectionId?: string, resourceType?: string, requestShape?: { method: string, range: string | null } },
 *   authorizedBy?: 'cap' | 'manual',
 *   walletIndex?: number,
 *   confirmation?: { token: string, payload: { accept_index: number, grant?: object } },
 * }} [opts]
 */
async function signAndQueueRetry(webContentsId, opts = {}) {
  // `webContents.fromId` is native and throws a cryptic ABI-style error
  // for non-integer input. Reject early with something the caller can act on.
  if (typeof webContentsId !== 'number' || webContentsId < 0) {
    throw new Error(`x402: invalid webContentsId: ${webContentsId}`);
  }
  // The reservation of a charge this call holds until the pending payment
  // takes it over: settled `withheld` if nothing is stashed.
  const held = { reservation: null, origin: null };
  // It runs for the window that hosts the tab (freedom-core design 0011,
  // APS-5): an auto-pay within a cap, which asks nothing, goes there too.
  return runInWindow(hostWindowIdOf(webContentsId), async () => {
    try {
      return await signAndStash(webContentsId, opts, held);
    } catch (err) {
      if (held.reservation) settleAndTell(webContentsId, held.reservation, held.origin);
      throw err;
    }
  });
}

function settleAndTell(webContentsId, reservation, origin) {
  settlePayment(reservation, 'withheld', origin).then((refunded) => {
    if (refunded) sendToHost(webContentsId, 'x402:cap-consumed', { origin });
  });
}

async function signAndStash(webContentsId, opts, held) {
  const token = opts.confirmation?.token;
  // A token not presented to the core is burnt: the request ended first.
  let presented = false;
  try {
    return await authorizeAndStash(webContentsId, opts, held, () => {
      presented = true;
    });
  } finally {
    if (token && !presented) discardConfirmation(token);
  }
}

async function authorizeAndStash(webContentsId, opts, held, presenting) {
  const detected = opts.detection ?? getDetectedPayment(webContentsId);
  if (!detected) throw new Error('No pending x402 payment for this tab');

  let origin;
  try {
    const parsed = new URL(detected.url);
    origin = normalizeOrigin(parsed.origin === 'null' ? detected.url : parsed.origin);
  }
  catch { throw new Error('Refusing to pay: unparseable URL'); }
  if (!origin) throw new Error('Refusing to pay: unnormalisable origin');

  const authorizedBy = opts.authorizedBy ?? AUTHORIZED_BY.MANUAL;
  const walletIndex = opts.walletIndex ?? getActiveWalletIndex();
  const params = {
    account: walletIndex,
    detection: {
      tab: webContentsId,
      id: detected.detectionId ?? `gen-${crypto.randomUUID()}`,
      url: detected.url,
    },
    requirements: detected.requirements,
  };
  if (authorizedBy === AUTHORIZED_BY.CAP) {
    // An auto-pay is for a tab the user controls now, before the core is
    // asked: one resumed after an unlock included. The core is told the
    // same, and refuses a cap's payment for a tab in custody.
    refuseUnlessUserTab(webContentsId);
    if (isDeviceAccount(walletIndex)) throw capNotCoveredError(DEVICE_REFUSED);
    const agent = isAgentPageId(webContentsId);
    params.authorization = { cap: { agent, attributable: agent || isUserPageId(webContentsId) } };
  } else {
    const confirmation = opts.confirmation;
    if (!confirmation || typeof confirmation.token !== 'string') {
      throw new Error('Signing was not confirmed: no confirmation token');
    }
    params.authorization = { token: confirmation.token };
    params.accept_index = confirmation.payload?.accept_index;
    if (confirmation.payload?.grant) params.grant = confirmation.payload.grant;
  }

  let reply;
  try {
    // Refuses a device account before the core is asked: the core would
    // sign with the vault's key at its index, an address the user never saw.
    reply = await withVaultAccount(walletIndex, () => {
      presenting();
      return authorizePayment(params);
    });
  } catch (err) {
    if (authorizedBy === AUTHORIZED_BY.CAP && err?.code === 'not_authorized' && CAP_REFUSALS.has(err.data?.reason)) {
      throw capNotCoveredError();
    }
    if (err?.code === 'not_authorized' || err?.code === 'forbidden') {
      const { confirmationError } = require('../wallet/signing-confirmation');
      throw confirmationError(err);
    }
    if (/another device/.test(err?.message ?? '')) throw new Error(DEVICE_REFUSED, { cause: err });
    throw err;
  }
  held.reservation = typeof reply?.reservation === 'string' ? reply.reservation : null;
  held.origin = origin;
  if (reply?.charged) sendToHost(webContentsId, 'x402:cap-consumed', { origin });
  if (reply?.grant && reply.grant.added === false) {
    log.warn(`[x402:sign] grant not added (${reply.grant.reason ?? 'unknown'})`);
  }
  if (reply?.durable === false) {
    log.warn('[x402:sign] the cap change may not survive a power loss yet (the flush after the rename failed)');
  }

  const payload = reply?.payload;
  const selectedAccept = detected.requirements?.accepts?.[reply?.accept_index];
  if (!payload || typeof payload !== 'object' || !selectedAccept) {
    throw new Error('The identity core gave no payment to send');
  }
  const tuple = tupleFromAccept(selectedAccept);

  // A payment with too little life left is refused by the facilitator, and
  // the core refuses to sign one (the 20 s runway); a stash delayed past it
  // is dropped here, before anything is stashed or navigated.
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

  // And again once it is signed: the tab can have gone into Agent custody
  // meanwhile. Nothing awaits from here to the stash, so a signature made
  // for such a tab is dropped unsent, and its charge given back.
  if (authorizedBy === AUTHORIZED_BY.CAP) refuseUnlessUserTab(webContentsId);

  const headerValue = Buffer.from(JSON.stringify(payload)).toString('base64');
  const headerName = outgoingHeaderForVersion(detected.requirements.x402Version);
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
      fromAddress: payerOf(payload),
      authorizedBy,
      reservation: held.reservation,
      charged: reply.charged === true,
    },
    detected.requestShape,
  );
  // Stashed: the pending payment holds the reservation now, and
  // intercept.js settles it.
  held.reservation = null;
  // Only clear the map when we sourced FROM it. With a snapshot we used
  // our own copy and clearing here would erase whatever detection has
  // since taken its place (e.g. a second 402 that fired during our async
  // sign and is now showing in the sidebar).
  if (!opts.detection) {
    clearDetectedPayment(webContentsId);
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
  isCapNotCoveredError,
  CAP_NOT_COVERED,
  X402_HEADERS,
};
