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
 * key. Main signs no x402 payment itself with a key. A Ledger or phone
 * account takes the core's device path (cored 0.19.0, freedom-core #392):
 * `x402.authorize { device }` checks the token or charges the cap and gives
 * the typed data to sign, the device signs it (a Ledger by EIP-712, a phone
 * through its core job, `phone.job`), and `x402.settle { reservation,
 * signature }` checks the device's signature and gives the payment.
 * A Ledger on the core's backend (FREEDOM_LEDGER_BACKEND=core, development
 * builds only; freedom-core design 0016, "x402 from a Ledger account", D2
 * option A; LDG-3's PR 9) sends main's clock with it (`now_s`), checks the
 * core's typed data against main's own rebuild before anything reaches the
 * device, and has the core sign main's copy on its device lane through
 * main's relay (`x402.settle { reservation, typed_data }`); it never takes
 * the `{ signature }` form.
 * Extracting here keeps that sequence in one place and dodges a circular
 * ipc.js ↔ intercept.js dependency.
 */

const crypto = require('crypto');
const { webContents } = require('electron');
const { TypedDataEncoder } = require('ethers');
const log = require('../logger');
const { getActiveWalletIndex, getWalletRecord } = require('../identity-manager');
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
const { withHashOnlyTarget } = require('../wallet/ledger/hash-only-warning');
const {
  authorize: authorizePayment,
  settle: settlePayment,
  settleSignature,
  settleTypedData,
  rereadCaps,
} = require('./caps');
const { checkLedgerAuthorization, nonceOf } = require('./ledger-authorization');
const { tupleFromAccept } = require('./payment-utils');
const { holdIfCovered, releaseHold, awaitSpend } = require('./cap-holds');
const { ledgerBackendKind } = require('../wallet/ledger/ledger-backend-kind');
const { createLedgerError } = require('../wallet/ledger/errors');
const { isUserPageId, isAgentPageId } = require('../wallet/agent-tab-custody');
const { withVaultAccount } = require('../wallet/vault-access');
const { discardConfirmation } = require('../wallet/signing-confirmation');
const { reserveHistorySlot, releaseHistorySlot } = require('../payment-history');

// An auto-pay whose cap no longer covers it, at the moment it would be
// signed: nothing is signed, and the charge goes to the approval card.
// A tab that has gone into Agent custody is not covered either.
const CAP_NOT_COVERED = 'X402_CAP_NOT_COVERED';
// Too many x402 records wait to land in the payment history, which the
// identity core keeps (design 0013, PRF-6(c)): nothing more is signed, so
// no money leaves without a place in the history.
const PAYMENT_HISTORY_FULL = 'X402_PAYMENT_HISTORY_FULL';

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

// The core's refusals of a device's signature (`x402.settle { signature }`):
// the reservation is spent, and its charge given back (`data.refunded`).
const SIGNATURE_REFUSALS = new Set(['wrong_account', 'bad_response']);

/**
 * The device a payment from `walletIndex` is signed on, as the core's
 * device path names it (`x402.authorize { device: { kind, address } }`):
 * a Ledger or a phone, its address on main's word (the account record), or
 * null for an account of the vault's, which the core signs with. Refuses,
 * before the core is asked, an account that can't pay: a Safe (it has no
 * key; its owners sign through the Safe flow) and an index in the device
 * range that no account holds any more (the vault would derive a key the
 * user never saw there). `record` is main's snapshot of the account's
 * record (`getWalletRecord`), read once for the payment.
 */
function paymentDevice(walletIndex, record) {
  const { isHardwareWalletIndex, WALLET_TYPES } = require('../identity-manager');
  if (!record) {
    if (isHardwareWalletIndex(walletIndex)) throw new Error('Device account no longer exists; reconnect the device');
    return null;
  }
  switch (record.type) {
    case WALLET_TYPES.MNEMONIC:
      return null;
    case WALLET_TYPES.LEDGER:
      return { kind: 'ledger', address: record.address };
    case WALLET_TYPES.REMOTE:
      return { kind: 'phone', address: record.address };
    case WALLET_TYPES.SAFE:
      throw new Error("A Safe account can't pay an x402 payment: switch to one of its owners");
    default:
      throw new Error("This account can't pay an x402 payment");
  }
}

/**
 * The device's signature over the typed data the core gave (`typed_data`),
 * which must hash to the core's `hash`: the signer factory checks that
 * with the core before the device is asked, and the device's signature
 * must recover over it (wallet/signers.js). A Ledger signs it by EIP-712
 * on the device; a phone through its core job (`phone.job`, main's own),
 * relayed to the window's chrome. No token goes with it: the core already
 * checked the payment's (`x402.authorize`).
 */
function signOnDevice(walletIndex, device) {
  const { getSigner } = require('../wallet/signers');
  return getSigner(walletIndex).signTypedData(device?.typed_data, { expectedHash: device?.hash });
}


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
 * pays through the core's device path: the core checks the token or
 * charges the cap first, then the device signs, then the core checks its
 * signature (`x402.settle { reservation, signature }`). A signature the
 * core refuses spends the reservation and gives the charge back there; a
 * device that refuses or fails leaves the reservation to be settled
 * `withheld` here. A Ledger on the core's backend sends `now_s` instead,
 * and its reservation is settled `withheld` here before its payment is
 * signed only when main refused the core's authorization, or the settle,
 * before the settle was sent: once `x402.settle { reservation, typed_data }`
 * is sent, any end but a signed payment spends it (`settledByLedger`).
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
  // takes it over: settled `withheld` if nothing is stashed. And the slot
  // reserved for the payment's history record: released if nothing is.
  const held = { reservation: null, origin: null, historySlot: null };
  // It runs for the window that hosts the tab (freedom-core design 0011,
  // APS-5): an auto-pay within a cap, which asks nothing, goes there too.
  // A Ledger's hash-only warning on the core's backend shows over that tab
  // (freedom-core design 0016, Q23; LDG-3's PR 11, hash-only-warning.js).
  return runInWindow(hostWindowIdOf(webContentsId), () =>
    withHashOnlyTarget({ guest: webContentsId }, async () => {
      try {
        return await signAndStash(webContentsId, opts, held);
      } catch (err) {
        if (held.reservation) settleAndTell(webContentsId, held.reservation, held.origin);
        releaseHistorySlot(held.historySlot);
        held.historySlot = null;
        throw err;
      }
    })
  );
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
  // A slot for its history record, reserved in this turn, before the core
  // is asked: with none left, nothing is charged, signed or spent.
  held.historySlot = reserveHistorySlot();
  if (!held.historySlot) {
    throw Object.assign(new Error('Payment history is unavailable; try again shortly'), {
      code: PAYMENT_HISTORY_FULL,
    });
  }

  let origin;
  try {
    const parsed = new URL(detected.url);
    origin = normalizeOrigin(parsed.origin === 'null' ? detected.url : parsed.origin);
  }
  catch { throw new Error('Refusing to pay: unparseable URL'); }
  if (!origin) throw new Error('Refusing to pay: unnormalisable origin');

  const authorizedBy = opts.authorizedBy ?? AUTHORIZED_BY.MANUAL;
  const walletIndex = opts.walletIndex ?? getActiveWalletIndex();
  const record = getWalletRecord(walletIndex);
  // A Ledger's or a phone's, or null for the vault's: an account that can't
  // pay (a Safe, a device account deleted) is refused here, unasked.
  const device = paymentDevice(walletIndex, record);
  // A Ledger on the core's backend (design 0016, D2 option A): main's own
  // wall-clock reading in whole seconds, taken once for this payment, which
  // every time in the authorization is built on, and the record's address
  // and path as main holds them now.
  const ledger =
    device?.kind === 'ledger' && ledgerBackendKind() === 'core'
      ? { walletIndex, address: record.address, path: record.path, nowS: Math.floor(Date.now() / 1000) }
      : null;
  const params = {
    account: walletIndex,
    detection: {
      tab: webContentsId,
      id: detected.detectionId ?? `gen-${crypto.randomUUID()}`,
      url: detected.url,
    },
    requirements: detected.requirements,
  };
  if (device) params.device = device;
  if (ledger) params.now_s = ledger.nowS;
  if (authorizedBy === AUTHORIZED_BY.CAP) {
    // An auto-pay is for a tab the user controls now, before the core is
    // asked: one resumed after an unlock included. The core is told the
    // same, and refuses a cap's payment for a tab in custody.
    refuseUnlessUserTab(webContentsId);
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
  // The entry a Ledger's payment may pay (`ledgerEntry`): a cap's, or the
  // one the token binds.
  if (ledger) {
    ledger.byCap = authorizedBy === AUTHORIZED_BY.CAP;
    ledger.acceptIndex = ledger.byCap ? null : params.accept_index;
  }

  const ask = () => {
    // Only a token sent to the core is spent there: one the payment
    // doesn't present (a cap's) is burnt here, as one never asked.
    if (params.authorization.token) presenting();
    return authorizePayment(params);
  };
  let reply;
  try {
    // A device's payment uses no key of the vault's, so it needs no unlock.
    // A vault account's runs through withVaultAccount, which refuses a
    // device's index before the core is asked: the core would sign with the
    // vault's key at it, an address the user never saw.
    reply = device ? await ask() : await withVaultAccount(walletIndex, ask);
  } catch (err) {
    if (authorizedBy === AUTHORIZED_BY.CAP && err?.code === 'not_authorized' && CAP_REFUSALS.has(err.data?.reason)) {
      throw capNotCoveredError();
    }
    if (err?.code === 'not_authorized' || err?.code === 'forbidden') {
      const { confirmationError } = require('../wallet/signing-confirmation');
      throw confirmationError(err);
    }
    throw err;
  }
  held.reservation = typeof reply?.reservation === 'string' ? reply.reservation : null;
  held.origin = origin;
  if (reply?.charged) sendToHost(webContentsId, 'x402:cap-consumed', { origin });
  if (ledger) reply = await settledByLedger(webContentsId, detected, reply, held, ledger);
  else if (device) reply = await signedByDevice(webContentsId, walletIndex, reply, held);
  if (reply?.grant && reply.grant.added === false) {
    log.warn(`[x402:sign] grant not added (${reply.grant.reason ?? 'unknown'})`);
  }
  if (reply?.durable === false) {
    log.warn('[x402:sign] the cap change may not survive a power loss yet (the flush after the rename failed)');
  }

  // The core's payment, the device's signature in it exactly as the device
  // answered (its case and last byte) on the device path.
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
      historySlot: held.historySlot,
      charged: reply.charged === true,
    },
    detected.requestShape,
  );
  // Stashed: the pending payment holds the reservation now, and
  // intercept.js settles it.
  held.reservation = null;
  held.historySlot = null;
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

/**
 * A device's payment, after `x402.authorize { device }` answered: the
 * device signs the core's typed data, and `x402.settle { reservation,
 * signature }` checks the signature and gives the payment, `{ payload,
 * charged, grant?, durable? }`, the reservation then waiting for `sent` or
 * `withheld`. Returns the authorize reply with the payment in it.
 *
 * A device that refuses or fails throws, and the caller settles the
 * reservation `withheld` (the charge goes back). A signature the core
 * refuses (`wrong_account`, `bad_response`) has spent the reservation and
 * given its charge back already (`data.refunded`), so nothing is left to
 * settle.
 */
async function signedByDevice(webContentsId, walletIndex, reply, held) {
  const typed = reply?.device;
  if (!typed || typeof typed.hash !== 'string' || !typed.typed_data || !held.reservation) {
    throw new Error('The identity core gave no payment for the device to sign');
  }
  const signature = await signOnDevice(walletIndex, typed);
  let settled;
  try {
    settled = await settleSignature(held.reservation, signature, held.origin);
  } catch (err) {
    if (err?.code === 'not_authorized' && SIGNATURE_REFUSALS.has(err.data?.reason)) {
      held.reservation = null;
      if (err.data?.refunded === true) sendToHost(webContentsId, 'x402:cap-consumed', { origin: held.origin });
      throw new Error(
        err.data.reason === 'wrong_account'
          ? 'The device signed with another account: nothing was paid'
          : "The device's signature couldn't be read: nothing was paid",
        { cause: err }
      );
    }
    throw err;
  }
  // A token's payment writes its grant and charges a cap only now.
  if (settled?.charged && !reply.charged) sendToHost(webContentsId, 'x402:cap-consumed', { origin: held.origin });
  return {
    payload: settled?.payload,
    reservation: held.reservation,
    accept_index: reply.accept_index,
    charged: reply.charged === true || settled?.charged === true,
    ...(settled?.grant ? { grant: settled.grant } : {}),
    ...(settled?.durable === false || reply.durable === false ? { durable: false } : {}),
  };
}

/**
 * What a Ledger's payment showed about its record, kept by the identity
 * core (`accounts.record_address_check`) as the JS backend keeps it for a
 * Ledger's signature (wallet/signers.js `keepAddressCheck`; the LDG-3
 * plan's point 8), without holding up the payment: a failure is logged.
 */
function keepLedgerAddressCheck(walletIndex, matched) {
  const warn = (err) => {
    log.warn(`[x402:sign] account ${walletIndex}'s address check was not kept: ${err?.message}`);
  };
  try {
    const { recordLedgerAddressCheck } = require('../identity-manager');
    Promise.resolve(recordLedgerAddressCheck(walletIndex, matched)).catch(warn);
  } catch (err) {
    warn(err);
  }
}

/**
 * The core's error for a Ledger payment as the caller shows it: a device's
 * failure (`device_failed` with its `LEDGER_*` code in `data.ledger`,
 * design 0016's API) with ledger/errors.js's text and code, the core's error
 * as its cause; any other as it is.
 */
function ledgerPaymentError(err) {
  const code = err?.code === 'device_failed' ? err.data?.ledger : null;
  if (typeof code !== 'string' || !/^LEDGER_[A-Z_]+$/.test(code)) return err;
  const failure = createLedgerError(code);
  failure.cause = err;
  return failure;
}

/**
 * The entry a Ledger's payment is rebuilt from (`settledByLedger`): main's
 * own copy of the `accepts[]` entry the core's reply names, only if it is
 * one main asked the core to pay, as `{ accept, hold }`; null otherwise. A
 * payment the user approved pays the entry its token binds, the
 * `accept_index` main sent: the reply must name that very index (`hold`
 * null). An auto-pay pays the entry the core picked under a cap (the first
 * a cap covers, in the seller's order) only if main's own view shows a cap
 * covering it: its mirror of the caps as main's auto-pay selector reads it
 * (payment-utils.js `coverageForAccept`: the site's cap for that entry's
 * chain and asset answers now and has room for its amount), less what main
 * already holds against that cap for the Ledger's other auto-pays in
 * flight, whose charges the mirror can't show yet; the entry's amount is
 * then held in the same synchronous step (cap-holds.js `holdIfCovered`),
 * so two auto-pays can't both pass on the same room. So a core can't move
 * a payment onto another entry (another amount, asset, chain or
 * recipient), nor have the Ledger sign more than main's cap.
 */
function ledgerEntry(detected, reply, ledger, origin) {
  const index = reply?.accept_index;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const accepts = detected.requirements?.accepts;
  const accept = Array.isArray(accepts) && index < accepts.length ? accepts[index] : null;
  if (!accept) return null;
  if (ledger.byCap) {
    const hold = holdIfCovered(origin, accept);
    return hold ? { accept, hold } : null;
  }
  return index === ledger.acceptIndex ? { accept, hold: null } : null;
}

/**
 * A Ledger's payment on the core's backend (freedom-core design 0016, "x402
 * from a Ledger account", D2 option A, and LDG-2's L5 as built; the LDG-3
 * plan's point 13), after `x402.authorize { device, now_s }` answered `{
 * device: { typed_data, hash }, reservation, accept_index, charged }`.
 * Returns the authorize reply with the payment in it, as `signedByDevice`.
 *
 * - **Checked before the device:** the reply must name an entry main asked
 *   for (`ledgerEntry`: the token's, or one a cap covers in main's own
 *   view beyond its other auto-pays' holds; an auto-pay's that isn't is
 *   CAP_NOT_COVERED, for the card). Main
 *   rebuilds the authorization from what it holds (its parsed requirements'
 *   copy of that entry, the record's address, the `now_s` it sent) and the
 *   core's nonce, and
 *   requires the core's typed data, and its hash, to equal its own
 *   (ledger-authorization.js `checkLedgerAuthorization`). A refusal throws
 *   before anything is sent to the device, with the reservation untouched,
 *   and the caller settles it `withheld`, which drops its hold.
 * - **Signed on the device lane:** `x402.settle { reservation, typed_data }`
 *   with main's own frozen copy, through main's relay under the device
 *   watchdog (caps.js `settleTypedData`). Never the `{ signature }` form.
 * - **Spent once sent:** from the moment that settle is written to the
 *   core, the reservation is the core's to spend, whatever the outcome. A
 *   signed payment's is kept again, for `sent` or `withheld`; any other end
 *   spends it, so this throws with nothing left for the caller to settle,
 *   and `data.refunded` says whether the charge's room is back on its cap.
 *   A settle main refused unsent (a stream it can't derive, no core) leaves
 *   the reservation as it was, for the caller to settle `withheld`.
 * - **The address check** is kept as the JS backend keeps it: `matched`
 *   after a signed payment, `mismatched` on LEDGER_WRONG_DEVICE.
 * - **An auto-pay's hold** (cap-holds.js) is let go at once only when the
 *   device's signature never left main, as main's relay saw it
 *   (`handle.signed`: refused before the device or unsent, then settled
 *   `withheld`; rejected on the device; failed or ended before the
 *   signature was handed to the core, a signature its cancel overtook
 *   included), whatever the core says of its charge. Otherwise (a signed
 *   payment, or one the core failed after the signature) it stays until
 *   main's mirror accounts for the spend or another cap takes its key
 *   (`awaitSpend`), checked once a mirror read asked after the end lands
 *   and at every later check of that cap: so the charge is never counted
 *   by neither, and a core that never reports it leaves its room held.
 */
async function settledByLedger(webContentsId, detected, reply, held, ledger) {
  const typed = reply?.device;
  if (!typed || typeof typed.hash !== 'string' || !typed.typed_data || !held.reservation) {
    throw new Error('The identity core gave no payment for the device to sign');
  }
  const entry = ledgerEntry(detected, reply, ledger, held.origin);
  if (!entry) {
    log.warn("[x402:sign] the identity core's payment for a Ledger names an entry main didn't ask for: nothing reaches the device");
    if (ledger.byCap) throw capNotCoveredError();
    throw new Error("The payment the identity core prepared isn't the one you approved: nothing was paid");
  }
  // The settle's progress (caps.js `settleTypedData`): whether it was sent,
  // and whether the device's signature may have left main.
  const track = { sent: false, signed: false };
  try {
    return await settleLedgerEntry(webContentsId, detected, reply, held, ledger, entry.accept, track);
  } finally {
    if (track.signed) awaitSpend(entry.hold, rereadCaps(held.origin));
    else releaseHold(entry.hold);
  }
}

/** `settledByLedger`'s check and settle of `accept`, the entry main asked for, filling `track`. */
async function settleLedgerEntry(webContentsId, detected, reply, held, ledger, accept, track) {
  const typed = reply.device;
  const checked = checkLedgerAuthorization({
    x402Version: detected.requirements?.x402Version,
    accept,
    from: ledger.address,
    nowS: ledger.nowS,
    nonce: nonceOf(typed.typed_data),
    authorization: typed.typed_data,
  });
  const ownHash = checked.accepted
    ? TypedDataEncoder.hash(checked.typedData.domain, checked.typedData.types, checked.typedData.message)
    : null;
  if (!checked.accepted || typed.hash !== ownHash) {
    log.warn(
      `[x402:sign] the identity core's authorization for a Ledger isn't main's ` +
      `(${checked.accepted ? 'hash' : checked.reason}): nothing reaches the device`
    );
    throw new Error("The payment the identity core prepared isn't the one this site asked for: nothing was paid");
  }
  let settled;
  try {
    settled = await settleTypedData(held.reservation, checked.typedData, {
      path: ledger.path,
      expectedHash: ownHash,
      origin: held.origin,
      track,
    });
  } catch (err) {
    if (track.sent) {
      held.reservation = null;
      if (err?.data?.refunded === true) sendToHost(webContentsId, 'x402:cap-consumed', { origin: held.origin });
    }
    const failure = ledgerPaymentError(err);
    if (failure?.code === 'LEDGER_WRONG_DEVICE') keepLedgerAddressCheck(ledger.walletIndex, false);
    throw failure;
  }
  keepLedgerAddressCheck(ledger.walletIndex, true);
  // A token's payment writes its grant and charges a cap only now.
  if (settled?.charged && !reply.charged) sendToHost(webContentsId, 'x402:cap-consumed', { origin: held.origin });
  return {
    payload: settled?.payload,
    reservation: held.reservation,
    accept_index: reply.accept_index,
    charged: reply.charged === true || settled?.charged === true,
    ...(settled?.grant ? { grant: settled.grant } : {}),
    ...(settled?.durable === false || reply.durable === false ? { durable: false } : {}),
  };
}

module.exports = {
  signAndQueueRetry,
  isCapNotCoveredError,
  CAP_NOT_COVERED,
  PAYMENT_HISTORY_FULL,
  X402_HEADERS,
};
