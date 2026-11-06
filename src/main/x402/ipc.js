/**
 * x402 IPC.
 *
 * Five channels driven by the wallet sidebar (running in the host
 * browser-shell webContents, NOT in the webview that hit the 402).
 * All channels that operate on a specific tab take `webContentsId`
 * explicitly — the sender is the sidebar, not the paying webview.
 * Reading a payment, approving it, declining it and resuming it after
 * an unlock are for the chrome window that hosts its tab alone: another
 * window's sidebar is refused, and its payment stays as it was.
 *
 *   x402:get-details(webContentsId) — return the parsed PaymentRequired
 *     the detector stashed for that webContents, plus asset metadata
 *     for amount formatting and the auto-pay state for cap rendering.
 *
 *   x402:approve({webContentsId, detectionId, selectedAcceptIndex?,
 *     grant?, confirmation}) — drive the vault-backed x402Client to
 *     sign, stash the signed header for the dispatcher to inject,
 *     optionally grant a per-origin allowance, and re-issue the original
 *     navigation. Signs nothing without `confirmation`: an
 *     'x402-payment' token the card minted through
 *     `wallet:confirm-signing` when the user pressed Pay, for exactly
 *     this detection, entry, account and grant.
 *
 *   x402:cancel({webContentsId, navigate?}) — discard the detected
 *     payment and step the webview back one history entry (or
 *     about:blank if no back stack). `navigate: false` only discards:
 *     the renderer then runs the Back itself so it is counted as a
 *     history traversal.
 *
 *   x402:get-receipts({limit?}) — recent payments for the Payments tab.
 *
 *   x402:get-all-permissions / x402:revoke-permission — allowance UI.
 *
 *   x402:update-permission({origin, chainId, asset, capAmount?,
 *     windowSeconds?, confirmation}) — change an allowance's amount or
 *     window. Changes nothing without `confirmation`: an
 *     'x402-cap-update' token the cap editor minted through
 *     `wallet:confirm-signing`, in this same window, for exactly this
 *     edit of the cap as main holds it.
 *
 * Auto-pay (active cap covers the charge) doesn't go through these —
 * the detector calls signAndQueueRetry directly. See sign-flow.js.
 */

const { ipcMain, webContents } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { getToken, getTokenKey } = require('../token-registry');
const {
  getDetectedPayment,
  clearDetectedPayment,
  consumePendingUnlockResume,
  hasPendingUnlockWait,
  settlePendingUnlockWait,
  getPendingApproval,
  settlePendingApproval,
  claimApproval,
  isApprovalClaimed,
  releaseApprovalClaim,
  sendToHost,
} = require('./intercept');
const { guestHostedBy } = require('../wallet/agent-tab-custody');
const {
  revoke: revokePermission,
  revokeAllForOrigin,
  updatePermission,
  capUpdateRequest,
  getAllPermissions,
} = require('./permissions');
const paymentHistory = require('../payment-history');
const { signAndQueueRetry, isCapNotCoveredError } = require('./sign-flow');
const { tupleFromAccept, coverageForAccept } = require('./payment-utils');
const { getActiveWalletAddress, getActiveWalletIndex } = require('../identity-manager');
const {
  KINDS: CONFIRM_KINDS,
  consumeConfirmation,
  discardConfirmation,
} = require('../wallet/signing-confirmation');
const { getBalancesWithCache, getAllBalances, clearBalanceCache } = require('../wallet/balance-service');
const { normalizeOrigin } = require('../../shared/origin-utils');

// Cancel fallback when the webview has no back history. `about:blank` is
// safe everywhere — the user gets an empty page and the address bar so
// they can navigate away.
const CANCEL_FALLBACK_URL = 'about:blank';

// Resolve the asset entry the sidebar uses to format the amount as
// e.g. "0.01 USDC" instead of "10000 of 0x8335…". Returns null when
// the asset isn't in the (strict) tokens allowlist. Caller passes the
// specific `accepts[]` entry being displayed (today: always position 0
// pre-chooser; WP-MA.2 plumbs the selected index through).
function lookupAsset(accept) {
  const tuple = tupleFromAccept(accept);
  if (!tuple) return null;
  return getToken(getTokenKey(tuple.chainId, tuple.asset)) ?? null;
}

// Sidebar consumes this to decide between "render Approve UI" vs
// "render Allow-extra UI" (over-cap branch is the same UX as 'none'
// today, but the sidebar surfaces the existing-but-insufficient cap
// for transparency). Takes the explicit accept entry being displayed —
// over-cap state belongs to that entry, not whichever entry is at
// position 0 of the requirements blob.
function autoPayStateFor(origin, accept) {
  if (!origin) return { kind: 'none' };
  const coverage = coverageForAccept(origin, accept);
  if (!coverage) return { kind: 'none' };
  return {
    kind: coverage.covers ? 'cover' : 'over-cap',
    remaining: coverage.remaining.toString(),
    capAmount: coverage.perm.capAmount,
    expiresAt: coverage.perm.expiresAt,
  };
}

// Per-entry shape the chooser renders: each accepts[] entry annotated
// with asset metadata + balance + fundability + per-entry auto-pay
// state. Caller resolves the origin once and passes it in (URL parse
// would otherwise repeat per entry). Balance comes from the wallet's
// balance-service shape: `balances[chainId:asset] = { raw, formatted,
// symbol, decimals }`. We surface `balance` to the renderer as the
// raw atomic-unit string so the chooser can render its own formatting.
function enrichAcceptForDisplay(accept, origin, balances) {
  const tuple = tupleFromAccept(accept);
  // `balanceKey` lets renderer-side reactive refresh look up balances
  // without re-deriving from the tuple shape — `applyFreshBalances`
  // treats `tuple` as opaque after we hand off.
  const balanceKey = tuple ? `${tuple.chainId}:${tuple.asset}` : null;
  const raw = balanceKey ? balances?.[balanceKey]?.raw : null;
  const balance = typeof raw === 'string' ? raw : null;
  let fundable = false;
  if (tuple && balance) {
    try { fundable = BigInt(balance) >= BigInt(tuple.amount); } catch { /* leave fundable=false */ }
  }
  return {
    accept,
    tuple,
    balanceKey,
    asset: lookupAsset(accept),
    balance,
    fundable,
    autoPay: autoPayStateFor(origin, accept),
  };
}

// Find the first index whose entry is fundable; falls back to 0 so the
// renderer always has a valid initial selection. The single-fundable
// rule (locked decision §2) means a chooser is hidden when only one
// row qualifies — the renderer picks that one even if it's not at 0.
function initialSelectionIndex(enrichedAccepts) {
  const idx = enrichedAccepts.findIndex((e) => e.fundable);
  return idx >= 0 ? idx : 0;
}

// Single source of truth for the `x402:balances-updated` event shape.
// Both the card-open background refresh and the user-initiated
// `x402:refresh-balances` handler dispatch through this, so the two
// surfaces can't drift on payload structure.
function broadcastBalances(webContentsId, address, balances) {
  sendToHost(webContentsId, 'x402:balances-updated', {
    webContentsId,
    address,
    balances: balances ?? {},
  });
}

function originKeyForUrl(url) {
  try {
    const parsed = new URL(url);
    return normalizeOrigin(parsed.origin === 'null' ? url : parsed.origin);
  } catch {
    return null;
  }
}

// Background-refresh broadcast: fire a balance refresh after
// x402:get-details serves the (cached) approval card data; when it
// lands, push to the host renderer so the chooser rows update
// fundability in place. Pinned-selection semantics live on the
// renderer side. Failures are logged and ignored — cached balances
// stay on screen and the user can hit the Refresh button on the
// insufficient-funds card if they need explicit re-fetch.
function refreshAndBroadcastBalances(webContentsId, address) {
  if (!address) return;
  getAllBalances(address)
    .then((balances) => {
      broadcastBalances(webContentsId, address, balances);
    })
    .catch((err) => {
      log.warn(`[x402:get-details] background balance refresh failed: ${err.message}`);
    });
}

// What a window is told when it names a payment on a tab it doesn't host.
const NOT_THIS_WINDOW = 'This payment is not on a tab of this window';

function registerX402Ipc() {
  // The tab-scoped handlers accept an explicit `webContentsId` from the
  // sidebar (which is the host webContents and doesn't know which
  // webview the 402 came from). Only x402:refresh-balances, which acts on
  // no payment, also falls back to `event.sender.id`.
  //
  // Every handler that acts on a payment (x402:get-details, x402:approve,
  // x402:reject, x402:cancel, x402:resume-unlock) serves only the chrome
  // window that hosts the payment's tab (`guestHostedBy`), and only while
  // that tab lives: the sender policy admits any Freedom chrome renderer,
  // and one window must not read, pay, decline, navigate or resume the
  // payment on another window's card. A refused call changes nothing: the
  // payment stays pending for its own window. A renderer can still act on
  // payments on its own window's tabs (approving one with a token it
  // minted for it).
  ipcMain.handle(IPC.X402_GET_DETAILS, async (event, args = {}) => {
    // When detectionId is provided, the lookup is strict — refusing to
    // serve a different detection's data avoids "user sees A's details
    // but actually approves B" if a newer 402 replaced the map slot
    // between the event and this round-trip. Falls back to the
    // tab-keyed entry only when the tab-keyed entry's detectionId still
    // matches the request (mainFrame approval-card path).
    //
    // When detectionId is not provided (legacy / mainFrame callers
    // that haven't been updated), fall back to the tab-keyed entry.
    const { detectionId } = args;
    let id = args.webContentsId;

    let detected;
    if (detectionId) {
      detected = getPendingApproval(detectionId);
      if (detected) {
        id = detected.webContentsId;
      } else {
        const stored = getDetectedPayment(id);
        if (stored && stored.detectionId === detectionId) {
          detected = stored;
        }
      }
      if (!detected) {
        return { success: false, error: 'No pending x402 payment for this detectionId' };
      }
    } else {
      detected = getDetectedPayment(id);
      if (!detected) {
        return { success: false, error: 'No pending x402 payment for this tab' };
      }
    }
    if (!guestHostedBy(event.sender, id)) {
      return { success: false, error: NOT_THIS_WINDOW };
    }

    // Resolve origin + active address once for the whole enrichment
    // pass. Vault-locked / no-active-wallet → null address → balance
    // fields come back as null and the renderer paints a "balance
    // unknown" state until the post-paint refresh lands.
    const origin = originKeyForUrl(detected.url);
    let address = null;
    try { address = await getActiveWalletAddress(); }
    catch (err) { log.warn(`[x402:get-details] active address lookup failed: ${err.message}`); }

    let balances = {};
    if (address) {
      try {
        const result = await getBalancesWithCache(address, false);
        balances = result?.balances ?? {};
      } catch (err) {
        log.warn(`[x402:get-details] balance lookup failed: ${err.message}`);
      }
    }

    const accepts = (detected.requirements?.accepts ?? []).map((accept) =>
      enrichAcceptForDisplay(accept, origin, balances)
    );

    // Kick a balance refresh in the background so the chooser can
    // update fundability in place once it lands. Awaiting would delay
    // the approval card open; the cached balances are good-enough for
    // initial paint. The seller's facilitator is the settlement-time
    // correctness gate — if our cached balance was stale and signing
    // succeeds against insufficient funds, the response logger writes
    // a `failed` payment-history row. Users with reason to believe the
    // cache is stale (just bridged / received) can force-fetch via the
    // Refresh button on the insufficient-funds card.
    refreshAndBroadcastBalances(id, address);

    // Legacy single-accept fields kept for the not-yet-migrated
    // renderer; WP-MA.2 will read everything from `accepts[]`. Once
    // the renderer migrates these can be dropped. Pull from the
    // already-enriched accepts[0] to avoid duplicate token-registry
    // lookups.
    const head = accepts[0];
    return {
      success: true,
      url: detected.url,
      requirements: detected.requirements,
      detectionId: detected.detectionId ?? detectionId ?? null,
      accepts,
      initialSelectionIndex: initialSelectionIndex(accepts),
      asset: head?.asset ?? null,
      autoPay: head?.autoPay ?? { kind: 'none' },
    };
  });

  // Gated by a signing confirmation (O-7), like the wallet's other
  // signing handlers. The card mints an 'x402-payment' token through
  // `wallet:confirm-signing` when the user presses Pay, for the payment
  // as it shows it; this handler rebuilds that binding from main's own
  // record of the detection named (its tab, detectionId and URL, and the
  // `accepts[]` entry at the chosen index), with the active account and
  // the grant passed, and signs only if the token matches exactly. A
  // token is single use, lives two minutes and is burnt by any call that
  // presents it. A detection without a detectionId was never put on a
  // card (an allowance covered it) and can't be approved here. Auto-pay
  // within an allowance doesn't come through this handler: the detector
  // evaluates the cap in main and signs (intercept.js).
  //
  // Only the window hosting the payment's tab can approve it, and each
  // detection is approved once: the token that checks out claims it in
  // the same turn, before anything is settled or signed, and any later
  // approval of it is refused with its token burnt — a second token
  // minted for the same card included, while the first sign is on the
  // device or after. A failed sign that queued nothing hands the claim
  // back for the retry the card offers (below, and the detector's loop).
  ipcMain.handle(IPC.X402_APPROVE, async (event, args = {}) => {
    const id = args.webContentsId;
    const { detectionId, grant, selectedAcceptIndex, confirmation } = args;

    // Which payment this approves, from main's record. WP7.1 subresource
    // path: the detector is awaiting the approval Promise for this
    // detectionId. mainFrame approval card: the tab-keyed detection,
    // only while it still carries the same detectionId.
    //
    // P1: a stale detectionId must NOT fall through to the tab-keyed
    // record. If A's card click arrives after B's 402 has superseded A
    // in main, we MUST refuse — falling through would sign B (whatever's
    // currently in detectedPayments[id]) and re-create the "approved A,
    // paid B" race we designed against.
    const awaiting = detectionId ? getPendingApproval(detectionId) : null;
    let record = null;
    if (awaiting) {
      record = {
        webContentsId: awaiting.webContentsId,
        url: awaiting.url,
        requirements: awaiting.requirements,
      };
    } else if (detectionId) {
      const stored = getDetectedPayment(id);
      if (stored && stored.detectionId === detectionId) {
        record = {
          webContentsId: id,
          url: stored.url,
          requirements: stored.requirements,
          // Defence in depth: a cap tag rides through so the inject
          // handler still withholds on a raced-over cap.
          authorizedBy: stored.authorizedBy,
        };
      }
    }
    if (!record) {
      discardConfirmation(confirmation);
      return {
        success: false,
        error: detectionId
          ? 'Approval is stale — the detection has been superseded'
          : 'No pending x402 payment to approve',
      };
    }
    if (!guestHostedBy(event.sender, record.webContentsId)) {
      discardConfirmation(confirmation);
      return { success: false, error: NOT_THIS_WINDOW };
    }
    if (isApprovalClaimed(detectionId)) {
      discardConfirmation(confirmation);
      return { success: false, error: 'This payment has already been approved' };
    }

    const acceptIndex = selectedAcceptIndex ?? 0;
    const accept = Number.isInteger(acceptIndex) && acceptIndex >= 0
      ? record.requirements?.accepts?.[acceptIndex]
      : undefined;
    if (!accept) {
      discardConfirmation(confirmation);
      return { success: false, error: 'No such payment option for this payment' };
    }

    // The account that signs is the one the token was minted for: the
    // active account now, handed down so the signature can't use another.
    const walletIndex = getActiveWalletIndex();
    try {
      consumeConfirmation(confirmation, CONFIRM_KINDS.X402_PAYMENT, walletIndex, {
        webContentsId: record.webContentsId,
        detectionId,
        url: record.url,
        acceptIndex,
        accept,
        grant,
      });
    } catch (err) {
      return { success: false, error: err.message, code: err.code };
    }
    // Checked as unclaimed above, in this same turn: nothing in between
    // awaits, so no other approval can have claimed it since.
    claimApproval(detectionId, record.webContentsId);

    // Subresource: settle the detector's pending approval (it signs +
    // 307s). Returns `pending: true` so the renderer keeps the card in
    // "Signing..." state and waits for the x402:approval-result event —
    // the actual sign happens inside the detector after this IPC
    // returns. The entry, account and grant confirmed ride through on
    // the decision so the detector signs exactly those.
    if (awaiting) {
      settlePendingApproval(detectionId, {
        approved: true,
        grant,
        selectedAcceptIndex: acceptIndex,
        walletIndex,
      });
      return { success: true, pending: true };
    }

    try {
      // Manual approve path (mainFrame) — user clicked Pay on the
      // sidebar card. `pendingUnlockResume` is intentionally NOT
      // consumed here; that token is dedicated to the locked-vault
      // auto-pay flow and only X402_RESUME_UNLOCK touches it. Mixing
      // the two would let a click on B's approval card consume A's
      // resume token and sign A.
      //
      // signAndQueueRetry reads the tab-keyed detection synchronously,
      // in this same turn, so it signs the record checked above. Pay
      // click never blocks on a balance RPC — fundability gating is the
      // chooser's job (cached balances) and the seller's facilitator is
      // the real settlement-time gate.
      await signAndQueueRetry(id, {
        grant,
        authorizedBy: record.authorizedBy,
        selectedAccept: accept,
        walletIndex,
      });
      return { success: true };
    } catch (err) {
      // The card offers Pay again after a failed sign. While the detection
      // is still the tab's current one it was never signed (the sign
      // clears it as it queues the signature), so it can be approved
      // again; one that has since gone or been replaced keeps the claim.
      if (getDetectedPayment(id)?.detectionId === detectionId) {
        releaseApprovalClaim(detectionId);
      }
      // Vault locked / unparseable URL / sdk error all surface verbatim
      // so the sidebar can prompt the right next step.
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.X402_REJECT, async (event, args = {}) => {
    // Subresource approval-card reject. Settles the pending Promise with
    // approved:false; the detector returns null and the page sees the
    // 402. mainFrame paywall cancel still goes through X402_CANCEL.
    //
    // Judged by the awaiting detection's own tab: the caller names only
    // the detection. Another window's refusal leaves it awaiting.
    const { detectionId } = args;
    if (!detectionId) {
      return { success: false, error: 'detectionId required' };
    }
    const awaiting = getPendingApproval(detectionId);
    if (!awaiting) {
      return { success: true, settled: false };
    }
    if (!guestHostedBy(event.sender, awaiting.webContentsId)) {
      return { success: false, error: NOT_THIS_WINDOW };
    }
    const settled = settlePendingApproval(detectionId, { approved: false });
    return { success: true, settled };
  });

  ipcMain.handle(IPC.X402_RESUME_UNLOCK, async (event, args = {}) => {
    // Two resume shapes converge here: (1) subresource — settle the
    // wait, the detector's closure retries sign + 307 inline; (2)
    // mainFrame — consume the resume token and dispatch via
    // signAndQueueRetry (closure is gone). Discard any orphan resume
    // token alongside the wait — they pair to different paths and a
    // surviving token would be consumed by a stale future call.
    //
    // Both are keyed by the tab, so the tab named is the one judged.
    // Another window's call leaves the wait and the token in place.
    const id = args.webContentsId;
    if (!guestHostedBy(event.sender, id)) {
      return { success: false, error: NOT_THIS_WINDOW };
    }
    if (hasPendingUnlockWait(id)) {
      consumePendingUnlockResume(id);
      settlePendingUnlockWait(id);
      return { success: true };
    }
    let resume = null;
    try {
      resume = consumePendingUnlockResume(id);
      if (!resume) {
        return { success: false, error: 'No pending unlock-resume for this tab' };
      }
      await signAndQueueRetry(id, {
        detection: resume.detection,
        authorizedBy: resume.authorizedBy,
      });
      return { success: true };
    } catch (err) {
      // The cap no longer covers it (spent while the vault was locked):
      // nothing was signed. Loading the page again brings its 402 back,
      // which now goes to the approval card.
      if (isCapNotCoveredError(err) && resume?.detection?.url) {
        webContents.fromId(id)?.loadURL(resume.detection.url).catch((navErr) => {
          log.error(`[x402:resume-unlock] reload failed: ${navErr.message}`);
        });
      }
      return { success: false, error: err.message, ...(err.code ? { code: err.code } : {}) };
    }
  });

  // Renderer-initiated balance refresh — user clicked "Refresh
  // balances" on the insufficient-funds card because they think the
  // cached state is stale (just bridged / received / etc.). Bypass
  // the 30s in-memory cache so the user's deliberate request actually
  // hits the chain, then broadcast `x402:balances-updated` so the
  // open card reactively re-renders fundability. Awaits the fetch
  // before resolving so the broadcast is guaranteed to have landed
  // (Electron IPC is ordered per channel) by the time the renderer
  // gets `{success: true}` back — the caller's `finally` block that
  // re-enables the button runs only after the card has already
  // re-rendered.
  ipcMain.handle(IPC.X402_REFRESH_BALANCES, async (event, args = {}) => {
    const id = args.webContentsId ?? event.sender.id;
    try {
      const address = await getActiveWalletAddress();
      if (!address) return { success: false, error: 'No active wallet' };
      clearBalanceCache(address);
      const balances = await getAllBalances(address);
      broadcastBalances(id, address, balances);
      return { success: true };
    } catch (err) {
      log.warn(`[x402:refresh-balances] failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.X402_CANCEL, async (event, args = {}) => {
    // Clears the tab's detection and may navigate the tab, so another
    // window's call is refused before either: the detection stays.
    const id = args.webContentsId;
    if (!guestHostedBy(event.sender, id)) {
      return { success: false, error: NOT_THIS_WINDOW };
    }
    clearDetectedPayment(id);
    // The renderer drives the Back itself when it can (through
    // `goBackInHistory`, so the commit is counted as a traversal — see
    // dapp-x402.js `reject`) and asks main only to clear the detection.
    if (args.navigate === false) return { success: true };
    const wc = webContents.fromId(id);
    if (!wc) return { success: true };
    if (wc.canGoBack && wc.canGoBack()) {
      wc.goBack();
    } else {
      wc.loadURL(CANCEL_FALLBACK_URL).catch((err) => {
        log.error(`[x402:cancel] fallback navigation failed: ${err.message}`);
      });
    }
    return { success: true };
  });

  ipcMain.handle(IPC.X402_GET_ALL_PERMISSIONS, async () => {
    return { success: true, permissions: getAllPermissions() };
  });

  // Legacy x402-only receipts channel. Now a thin alias over the unified
  // payment-history store; new callers should use the `payments:*` IPC.
  ipcMain.handle(IPC.X402_GET_RECEIPTS, async (_event, { limit } = {}) => {
    return {
      success: true,
      receipts: paymentHistory.getRecent({ kind: paymentHistory.KINDS.X402, limit }),
    };
  });

  ipcMain.handle(IPC.X402_REVOKE_PERMISSION, async (_event, { origin, chainId, asset }) => {
    revokePermission(origin, chainId, asset);
    return { success: true };
  });

  ipcMain.handle(IPC.X402_REVOKE_ALL_FOR_ORIGIN, async (_event, { origin } = {}) => {
    revokeAllForOrigin(origin);
    return { success: true };
  });

  // Changing a cap's amount or window changes what auto-pay may spend
  // without asking (#1023), so it is gated like a payment: the cap editor
  // mints an 'x402-cap-update' token through `wallet:confirm-signing` for
  // the edit it is about to make, and the edit is applied only with that
  // token, from the window that minted it, while the cap is still the one
  // it was minted for. Any call presenting a token burns it.
  ipcMain.handle(IPC.X402_UPDATE_PERMISSION, async (event, args = {}) => {
    const { origin, chainId, asset, capAmount, windowSeconds, confirmation } = args ?? {};
    try {
      consumeConfirmation(
        confirmation,
        CONFIRM_KINDS.X402_CAP_UPDATE,
        null,
        capUpdateRequest(event?.sender?.id, { origin, chainId, asset, capAmount, windowSeconds })
      );
    } catch (err) {
      return { success: false, error: err.message, code: err.code };
    }
    try {
      const updated = updatePermission(origin, chainId, asset, { capAmount, windowSeconds });
      return { success: true, permission: updated };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerX402Ipc,
};
