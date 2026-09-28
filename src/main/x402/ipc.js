/**
 * x402 IPC.
 *
 * Five channels driven by the wallet sidebar (running in the host
 * browser-shell webContents, NOT in the webview that hit the 402).
 * All channels that operate on a specific tab take `webContentsId`
 * explicitly — the sender is the sidebar, not the paying webview.
 *
 *   x402:get-details(webContentsId) — return the parsed PaymentRequired
 *     the detector stashed for that webContents, plus asset metadata
 *     for amount formatting and the auto-pay state for cap rendering.
 *
 *   x402:approve({webContentsId, grant?}) — drive the vault-backed
 *     x402Client to sign, stash the signed header for the dispatcher
 *     to inject, optionally grant a per-origin allowance, and re-issue
 *     the original navigation.
 *
 *   x402:cancel({webContentsId}) — discard the detected payment and
 *     step the webview back one history entry (or about:blank if no
 *     back stack).
 *
 *   x402:get-receipts({limit?}) — recent payments for the Payments tab.
 *
 *   x402:get-all-permissions / x402:revoke-permission — allowance UI.
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
  hasPendingApproval,
  getPendingApproval,
  settlePendingApproval,
  sendToHost,
} = require('./intercept');
const {
  revoke: revokePermission,
  revokeAllForOrigin,
  updatePermission,
  getAllPermissions,
} = require('./permissions');
const paymentHistory = require('../payment-history');
const { signAndQueueRetry } = require('./sign-flow');
const { tupleFromAccept, coverageForAccept } = require('./payment-utils');
const { getActiveWalletAddress } = require('../identity-manager');
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

function registerX402Ipc() {
  // The tab-scoped handlers accept an explicit `webContentsId` from the
  // sidebar (which is the host webContents and doesn't know which
  // webview the 402 came from). For test ergonomics we also fall back
  // to `event.sender.id` — production callers pass it explicitly.
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
    const id = args.webContentsId ?? event.sender.id;

    let detected;
    if (detectionId) {
      detected = getPendingApproval(detectionId);
      if (!detected) {
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

  // Not gated by wallet:confirm-signing (O-7). This handler signs an
  // EIP-3009 authorization on a bare chrome call: there is no
  // param-bound confirmation token, and `webContentsId`,
  // `detectionId`, `selectedAcceptIndex` and `grant` are all taken from
  // the renderer as-is. What bounds it is that the payment requirements
  // themselves are main-held (a detected 402, so the renderer can only
  // pick among a seller's own `accepts[]`), and that the channel is
  // exposed only through the chrome preload. Note the renderer also
  // chooses *which* detection is signed: on the tab-keyed path (no
  // detectionId) `webContentsId` selects the tab, so a compromised
  // chrome can approve any tab's pending main-held 402, not just the
  // one on screen. Bringing x402 under the signing
  // confirmation is a separate follow-up, not covered by O-7.
  ipcMain.handle(IPC.X402_APPROVE, async (event, args = {}) => {
    const id = args.webContentsId ?? event.sender.id;
    const { detectionId, grant, selectedAcceptIndex } = args;

    // WP7.1 subresource path: detector is awaiting the approval Promise.
    // Settle it (the detector handler does sign + 307). Returns
    // `pending: true` so the renderer keeps the card in "Signing..."
    // state and waits for the x402:approval-result event — the actual
    // sign happens inside the detector after this IPC returns, and we
    // need to surface its success/failure back to the UI. The selected
    // accept rides through on the decision so the detector signs the
    // entry the chooser highlighted, not whichever is at position 0.
    if (detectionId && hasPendingApproval(detectionId)) {
      settlePendingApproval(detectionId, { approved: true, grant, selectedAcceptIndex });
      return { success: true, pending: true };
    }

    // P1: stale detectionId must NOT silently fall through to the
    // tab-keyed mainFrame path. If A's card click arrives after B's
    // 402 has superseded A in main, we MUST refuse — falling through
    // would sign B (whatever's currently in detectedPayments[id]) and
    // re-create the "approved A, paid B" race we designed against.
    // Only allow fallback when the tab-keyed detection's detectionId
    // still matches (i.e. the mainFrame approval-card flow where the
    // map entry carries the same detectionId).
    if (detectionId) {
      const stored = getDetectedPayment(id);
      if (!stored || stored.detectionId !== detectionId) {
        return { success: false, error: 'Approval is stale — the detection has been superseded' };
      }
    }

    try {
      // Manual approve path (mainFrame) — user clicked Pay on the
      // sidebar card. `pendingUnlockResume` is intentionally NOT
      // consumed here; that token is dedicated to the locked-vault
      // auto-pay flow and only X402_RESUME_UNLOCK touches it. Mixing
      // the two would let a click on B's approval card consume A's
      // resume token and sign A.
      //
      // detectedPayments may carry `authorizedBy` if the auto-pay
      // detector tagged the map — pure defence-in-depth here, since the
      // normal cap-covered flow signs without UI and never reaches this
      // handler. sign-flow defaults to MANUAL when undefined.
      const detected = getDetectedPayment(id);
      // Explicit-index path threads the chooser's pick through;
      // omitted-index path lets sign-flow's fallback chain run
      // (preserves `detected.selectedAccept` precedence used by the
      // unlock-resume path before falling back to accepts[0]). Pay
      // click never blocks on a balance RPC — fundability gating is
      // the chooser's job (cached balances) and the seller's
      // facilitator is the real settlement-time gate.
      const selectedAccept = selectedAcceptIndex != null
        ? detected?.requirements?.accepts?.[selectedAcceptIndex]
        : undefined;
      await signAndQueueRetry(id, {
        grant,
        authorizedBy: detected?.authorizedBy,
        selectedAccept,
      });
      return { success: true };
    } catch (err) {
      // Vault locked / unparseable URL / sdk error all surface verbatim
      // so the sidebar can prompt the right next step.
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.X402_REJECT, async (_event, args = {}) => {
    // Subresource approval-card reject. Settles the pending Promise with
    // approved:false; the detector returns null and the page sees the
    // 402. mainFrame paywall cancel still goes through X402_CANCEL.
    const { detectionId } = args;
    if (!detectionId) {
      return { success: false, error: 'detectionId required' };
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
    const id = args.webContentsId ?? event.sender.id;
    if (hasPendingUnlockWait(id)) {
      consumePendingUnlockResume(id);
      settlePendingUnlockWait(id);
      return { success: true };
    }
    try {
      const resume = consumePendingUnlockResume(id);
      if (!resume) {
        return { success: false, error: 'No pending unlock-resume for this tab' };
      }
      await signAndQueueRetry(id, {
        detection: resume.detection,
        authorizedBy: resume.authorizedBy,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
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
    const id = args.webContentsId ?? event.sender.id;
    clearDetectedPayment(id);
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

  ipcMain.handle(IPC.X402_UPDATE_PERMISSION, async (_event, { origin, chainId, asset, capAmount, windowSeconds } = {}) => {
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
