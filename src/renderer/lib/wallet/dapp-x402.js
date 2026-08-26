/**
 * x402 Payment Approval Module
 *
 * Two responsibilities, mirroring dapp-connect.js's split:
 *
 *   1. The "this page wants $X to load" sidebar sub-screen, triggered by
 *      the `x402:approval-needed` event from main when the webRequest
 *      detector sees a 402 the user hasn't pre-authorised. Same shape as
 *      dapp-tx.js / dapp-sign.js: hide all sub-screens, render the card,
 *      await Approve or Reject, IPC back to main.
 *
 *   2. The auto-pay connection banner at the top of the Wallet tab. When
 *      the current site has an active x402 cap, the banner shows it (with
 *      remaining headroom) and offers a × button to revoke everything for
 *      the origin, or a click to open the detail subscreen for fine
 *      adjustment. Mirrors dapp-connection-banner / swarm-connection-banner.
 *
 * Auto-pay (an active per-origin cap covers the charge) is handled
 * entirely in main — the approval card never fires for that case.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import {
  isSignatureInFlight,
  beginSignatureFlight,
  endSignatureFlight,
} from './signature-flight.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import {
  escapeHtml,
  formatRawTokenBalance,
  truncateAddress,
  toAtomicUnits,
  X402_WINDOW_OPTIONS,
  isDeviceAccount,
  deviceLabel,
  signingButtonLabel,
} from './wallet-utils.js';
import { getPermissionKey } from '../origin-utils.js';
import { refreshBalances } from './balance-display.js';
import { showX402Permissions } from './permission-manage.js';
import { showVaultUnlock } from './vault-unlock.js';
import {
  normalizeX402BannerOrigin,
  selectedAcceptChanged,
  shouldShowChooserForSelection,
} from './dapp-x402-utils.js';

// Defaults from the WP0 consent decision. The interstitial offers
// these via the grant toggle; main signs+stores the cap if the toggle
// stays checked when the user clicks Pay.
const DEFAULT_GRANT_CAP_USDC = 10;
const DEFAULT_GRANT_WINDOW_SECONDS = 30 * 24 * 60 * 60;

// DOM references
let screen;
let backBtn;
let siteEl;
let amountEl;
let toEl;
let networkEl;
let urlEl;
let detailsEl;
let chooserEl;
let chooserOptionsEl;
let insufficientEl;
let insufficientListEl;
let insufficientFooterEl;
let insufficientRefreshBtn;
let warningEl;
let warningTextEl;
let unlockBlock;
let touchIdBtn;
let passwordLink;
let passwordSection;
let passwordInput;
let passwordSubmit;
let unlockError;
let errorEl;
let grantRow;
let grantToggle;
let ledgerNoteEl;
let grantCapInput;
let grantCapSymbol;
let grantWindowSelect;
let rejectBtn;
let approveBtn;
let lastValidGrantCap = String(DEFAULT_GRANT_CAP_USDC);

// Approval state for the currently-displayed card. `null` when idle.
let pending = null;

let bannerEl;
let bannerInfoEl;
let bannerSiteEl;
let bannerRemainingEl;
let bannerDisconnectBtn;

// Origin key currently displayed in the banner; cleared when hidden.
let currentBannerKey = null;

export function initDappX402() {
  screen = document.getElementById('sidebar-x402-approval');
  backBtn = document.getElementById('x402-approval-back');
  siteEl = document.getElementById('x402-approval-site');
  amountEl = document.getElementById('x402-approval-amount');
  toEl = document.getElementById('x402-approval-to');
  networkEl = document.getElementById('x402-approval-network');
  urlEl = document.getElementById('x402-approval-url');
  detailsEl = document.getElementById('x402-approval-details');
  chooserEl = document.getElementById('x402-approval-chooser');
  chooserOptionsEl = document.getElementById('x402-approval-chooser-options');
  insufficientEl = document.getElementById('x402-approval-insufficient');
  insufficientListEl = document.getElementById('x402-approval-insufficient-list');
  insufficientFooterEl = document.getElementById('x402-approval-insufficient-footer');
  insufficientRefreshBtn = document.getElementById('x402-approval-insufficient-refresh');
  warningEl = document.getElementById('x402-approval-warning');
  warningTextEl = document.getElementById('x402-approval-warning-text');
  unlockBlock = document.getElementById('x402-approval-unlock');
  touchIdBtn = document.getElementById('x402-approval-touchid-btn');
  passwordLink = document.getElementById('x402-approval-password-link');
  passwordSection = document.getElementById('x402-approval-password-section');
  passwordInput = document.getElementById('x402-approval-password-input');
  passwordSubmit = document.getElementById('x402-approval-password-submit');
  unlockError = document.getElementById('x402-approval-unlock-error');
  errorEl = document.getElementById('x402-approval-error');
  grantRow = document.getElementById('x402-approval-grant-row');
  grantToggle = document.getElementById('x402-approval-grant-toggle');
  ledgerNoteEl = document.getElementById('x402-approval-ledger-note');
  grantCapInput = document.getElementById('x402-approval-grant-cap-input');
  grantCapSymbol = document.getElementById('x402-approval-grant-cap-symbol');
  grantWindowSelect = document.getElementById('x402-approval-grant-window-select');
  rejectBtn = document.getElementById('x402-approval-reject');
  approveBtn = document.getElementById('x402-approval-approve');

  bannerEl = document.getElementById('x402-connection-banner');
  bannerInfoEl = document.getElementById('x402-connection-manage');
  bannerSiteEl = document.getElementById('x402-connection-site');
  bannerRemainingEl = document.getElementById('x402-connection-remaining');
  bannerDisconnectBtn = document.getElementById('x402-connection-disconnect');

  registerScreenHider(() => {
    // An in-flight payment signature owns the card: the device prompt it
    // produced cannot be recalled, so cancelling here would tear down the
    // detection in main (x402:cancel navigates the paywall away) while the
    // user is still confirming the very payment on the device.
    // hideAllSubscreens() already refuses to run while a signature is in
    // flight; this is the second line of defence for a direct hider call.
    if (pending?.signing) return;
    if (pending) {
      reject().catch((err) => console.error('[x402] hide reject failed:', err));
    } else {
      screen?.classList.add('hidden');
      resetGrantEditor();
    }
  });
  wireButtons();
  wireBanner();
  wireChooser();
  wireGrantEditor();

  // Subscribe to main's "approval needed" events. Returned disposer is
  // discarded — the renderer lives for the window's lifetime.
  window.electronAPI?.onX402ApprovalNeeded?.((payload) => {
    showApproval(payload).catch((err) => {
      console.error('[x402] failed to show approval:', err);
    });
  });

  // Subresource sign-after-approve completion. The IPC approve handler
  // returns `pending: true` for subresource — the card stays in
  // "Signing..." until this event arrives with success or error.
  window.electronAPI?.onX402ApprovalResult?.((payload) => {
    handleApprovalResult(payload);
  });

  // Vault-was-locked-during-auto-pay events. The cap was already granted,
  // so no permission card — just unlock and resume sign-flow via the
  // dedicated x402:resume-unlock IPC (NOT x402:approve — see
  // handleAutoPayUnlock for the source-separation rationale).
  window.electronAPI?.onX402UnlockNeeded?.(({ webContentsId, origin }) => {
    handleAutoPayUnlock(webContentsId, origin).catch((err) => {
      console.error('[x402] auto-pay unlock flow failed:', err);
    });
  });

  // Silent cap-covered auto-pay (video segments, lazy paragraphs, …)
  // doesn't round-trip through the renderer, so the banner's spend
  // counter would otherwise only refresh on navigation. Filter by
  // origin so multi-tab pays on other origins don't trigger a
  // full x402GetAllPermissions round-trip we'd just throw away.
  window.electronAPI?.onX402CapConsumed?.(({ origin } = {}) => {
    const key = normalizeX402BannerOrigin(origin);
    if (!isSidebarVisible() || key !== currentBannerKey) return;
    updateX402ConnectionBanner(key).catch((err) => {
      console.error('[x402] banner refresh after cap-consumed failed:', err);
    });
  });

  // Background balance refresh landed on a card that's currently open.
  // Recompute fundability per displayed entry and update the chooser
  // rows in place. Selection-pinning rule: never silently change the
  // user's pick. If their selected row flips from fundable to
  // unfundable mid-flow, the inline "Balance changed" error at Pay
  // click is the safety net; we don't auto-flip.
  window.electronAPI?.onX402BalancesUpdated?.(({ balances, webContentsId } = {}) => {
    if (!pending || pending.webContentsId !== webContentsId) return;
    applyFreshBalances(balances || {});
  });

  window.addEventListener('payments:tx-recorded', (event) => {
    if (event.detail?.kind !== 'x402') return;
    refreshAfterX402Payment().catch((err) => {
      console.error('[x402] balance refresh after payment failed:', err);
    });
  });
}

async function handleAutoPayUnlock(webContentsId, origin) {
  try {
    await showVaultUnlock(origin);
  } catch {
    // User cancelled the unlock; nothing to do — the original 402 page
    // stays rendered, the user can retry by navigating again. Main's
    // resume token expires via TTL.
    return;
  }
  // Dedicated resume channel — NOT x402Approve. The resume token in main
  // is consent-source-specific (CAP from the original auto-pay) and must
  // not be consumed by a manual approval click on a different charge.
  const result = await window.electronAPI.x402ResumeUnlock({ webContentsId });
  if (!result?.success) {
    console.error('[x402] resume-after-unlock failed:', result?.error);
  }
}

// Populate cap input default + window options at init; snap invalid
// cap input back to the prior valid value on `change` so the live
// state is always meaningful. Avoids the "silent fallback at Pay
// click" anti-pattern.
function wireGrantEditor() {
  resetGrantEditor();
  if (grantWindowSelect) {
    grantWindowSelect.innerHTML = '';
    for (const opt of X402_WINDOW_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(opt.seconds);
      o.textContent = opt.label;
      if (opt.seconds === DEFAULT_GRANT_WINDOW_SECONDS) o.selected = true;
      grantWindowSelect.appendChild(o);
    }
  }
  grantCapInput?.addEventListener('change', () => {
    const whole = grantCapInput.value.trim();
    if (/^\d+$/.test(whole) && whole !== '0') {
      lastValidGrantCap = whole;
    } else {
      grantCapInput.value = lastValidGrantCap;
    }
  });
}

function resetGrantEditor() {
  lastValidGrantCap = String(DEFAULT_GRANT_CAP_USDC);
  if (grantToggle) grantToggle.checked = false;
  if (grantCapInput) grantCapInput.value = lastValidGrantCap;
  if (grantWindowSelect) grantWindowSelect.value = String(DEFAULT_GRANT_WINDOW_SECONDS);
}

function wireChooser() {
  // One delegated `change` listener for all dynamically-rendered radio
  // rows. Survives across renderCard rebuilds; rebuilt rows just
  // re-target the same handler.
  chooserOptionsEl?.addEventListener('change', (event) => {
    if (!pending) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== 'x402-chooser') return;
    const index = Number(target.value);
    if (!Number.isInteger(index) || index < 0) return;
    if (pending.signing) {
      // Frozen: the selected accept is already on the device and cannot be
      // swapped. Repaint the rows so the radio snaps back to the payment
      // actually being confirmed — accepting the click would also
      // re-render the card and re-enable Pay under the live prompt.
      showChooser(pending.accepts || [], pending.selectedAcceptIndex);
      return;
    }
    if (pending.selectedAcceptIndex === index) return;
    pending.selectedAcceptIndex = index;
    renderCard();
  });
}

function wireBanner() {
  bannerInfoEl?.addEventListener('click', () => {
    if (currentBannerKey) {
      showX402Permissions(currentBannerKey);
    }
  });
  bannerDisconnectBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentBannerKey) {
      disconnectX402(currentBannerKey);
    }
  });

  // Refresh on sidebar open + after navigations finish, same as the
  // dapp/swarm banners — otherwise the banner only updates on explicit
  // tab switches and misses initial-load and in-tab navigation cases.
  document.addEventListener('sidebar-opened', () => {
    updateX402ConnectionBanner();
  });
  document.addEventListener('navigation-completed', () => {
    if (isSidebarVisible()) {
      updateX402ConnectionBanner();
    }
  });
}

function wireButtons() {
  backBtn?.addEventListener('click', reject);
  rejectBtn?.addEventListener('click', reject);
  approveBtn?.addEventListener('click', approve);
  insufficientRefreshBtn?.addEventListener('click', refreshInsufficientBalances);

  touchIdBtn?.addEventListener('click', handleTouchIdUnlock);
  passwordSubmit?.addEventListener('click', handlePasswordUnlock);
  passwordInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handlePasswordUnlock();
  });
  passwordLink?.addEventListener('click', () => {
    passwordLink.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
    passwordInput?.focus();
  });
}

async function showApproval({ webContentsId, detectionId, url, resourceType }) {
  // The sidebar is a single shared surface and an in-flight signature owns
  // it: the device prompt it produced cannot be recalled, so a second 402
  // must not overwrite `pending` and re-enable Pay/Reject/Back underneath
  // it — the user would be cancelling (or paying) the newcomer while the
  // device still shows the first payment, and the first payment's own
  // result would land on the wrong card. The lock is global (see
  // signature-flight.js), so a dapp-tx/dapp-sign confirmation blocks the
  // card too. Leave the detection with main; it is re-offered the next
  // time the page asks.
  if (isSignatureInFlight()) {
    console.warn('[x402] approval-needed ignored: a signature is already in flight');
    return;
  }

  // Re-fetch the canonical details via IPC so the sidebar trusts main's
  // view (asset allowlist, autoPay state, per-accept balances).
  // detectionId routes to the specific 402 we got the event for, immune
  // to a newer detection replacing detectedPayments[webContentsId] in
  // main.
  const details = await window.electronAPI.x402GetDetails({ webContentsId, detectionId });
  if (!details?.success) {
    console.warn('[x402] approval-needed event for an unknown tab:', details?.error);
    return;
  }

  // Re-checked after the await: the user may have hit Pay on the card
  // that is currently up (or confirmed on another surface) while the
  // details round-trip was in flight.
  if (isSignatureInFlight()) {
    console.warn('[x402] approval-needed ignored: a signature is already in flight');
    return;
  }

  hideAllSubscreens();
  resetGrantEditor();

  pending = {
    webContentsId,
    detectionId: details.detectionId ?? detectionId ?? null,
    resourceType: resourceType ?? null,
    url: details.url ?? url,
    // Enriched per-accept rows from main: {accept, tuple, balanceKey,
    // asset, balance, fundable, autoPay}. Renderer treats `tuple` as
    // opaque — fundability recomputation uses balanceKey directly.
    accepts: details.accepts ?? [],
    selectedAcceptIndex: details.initialSelectionIndex ?? 0,
    signing: false,
  };

  renderCard();
  await checkUnlockState();

  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  openSidebarPanel();
}

// Render the card from `pending.accepts` + `pending.selectedAcceptIndex`.
// Branches on the count of fundable entries (locked decisions §2 + §3):
// 0 → insufficient-funds state, Pay disabled
// 1 → single-entry detail rows when the selected entry is fundable
// 2+ → chooser dropdown + the selected entry's detail rows
//
// Pinned-selection rule: the user's `selectedAcceptIndex` is never
// silently moved by reactive balance updates. If their pick becomes
// unfundable mid-flow, the row stays selected, the chooser marks it as
// such, Pay is disabled, and an inline notice prompts a re-pick.
function renderCard() {
  const accepts = pending.accepts || [];
  const fundableCount = accepts.filter((e) => e.fundable).length;

  // Auto-pay can skip this dialog but never the device confirmation —
  // say so when the paying account signs on a device.
  const confirmWhere = deviceLabel(walletState.activeWalletIndex);
  ledgerNoteEl?.classList.toggle('hidden', !confirmWhere);
  if (ledgerNoteEl && confirmWhere) {
    ledgerNoteEl.textContent = `Auto-pay skips this dialog, but every payment still needs a confirmation on ${confirmWhere}.`;
  }

  let origin;
  try { origin = new URL(pending.url).origin; } catch { origin = pending.url; }
  siteEl.textContent = origin;
  urlEl.textContent = pending.url;
  urlEl.title = pending.url;

  if (accepts.length === 0) {
    // Unreachable per the zod schema (`accepts: …min(1)`); defensive.
    showInsufficientState([]);
    approveBtn.disabled = true;
    grantRow.classList.add('hidden');
    showError('This site requested payment but offered no payable assets.');
    return;
  }

  if (fundableCount === 0) {
    // Locked decision §3: disable Pay, list every requested asset
    // alongside the active wallet's current balance, no "Pay anyway"
    // escape hatch. Single-accept paywalls with insufficient balance
    // surface here too.
    showInsufficientState(accepts);
    approveBtn.disabled = true;
    grantRow.classList.add('hidden');
    hideError();
    return;
  }

  // 1+ fundable: render the selected entry's detail rows. Chooser appears
  // when there are multiple fundable rows, or when the pinned selection
  // has gone unfundable and the user needs a visible path to re-pick.
  pending.selectedAcceptIndex = clampSelectionIndex(accepts, pending.selectedAcceptIndex);
  const selectedIndex = pending.selectedAcceptIndex;
  const entry = accepts[selectedIndex];
  const selectedFundable = !!entry?.fundable;

  if (shouldShowChooserForSelection(fundableCount, selectedFundable)) {
    showChooser(accepts, selectedIndex);
  } else {
    hideChooser();
  }
  showDetailRows(entry);

  // Symbol suffix tracks the selected entry; cap + window inputs
  // keep whatever the user last typed across selection flips.
  if (entry?.asset && typeof entry.asset.decimals === 'number') {
    if (grantCapSymbol) grantCapSymbol.textContent = entry.asset.symbol;
    grantRow.classList.remove('hidden');
  } else {
    grantRow.classList.add('hidden');
  }

  // Selection state vs Pay button: only enable Pay when the selected
  // entry is fundable AND its asset is recognised. The user's pick is
  // pinned even if it becomes unfundable — we show the row as-selected
  // and surface the reason inline so they re-pick deliberately.
  if (!selectedFundable) {
    approveBtn.disabled = true;
    showError('Your selected option is no longer fundable — pick another or top up.');
  } else if (!entry.asset || typeof entry.asset.decimals !== 'number') {
    approveBtn.disabled = true;
    showError('This site asks for payment in an asset we don’t recognise.');
  } else {
    approveBtn.disabled = false;
    hideError();
  }

  // A live device prompt outranks every re-derived button state above:
  // the signature cannot be recalled, so nothing may hand the user a
  // second Pay (or a Reject/Back that tears the card down) underneath it.
  if (pending.signing) lockCardForFlight();

  // Over-cap warning for the SELECTED entry's autoPay state.
  if (entry?.autoPay?.kind === 'over-cap') {
    warningTextEl.textContent =
      'This charge exceeds your remaining allowance for this site; approving will reset the allowance for the next 30 days.';
    warningEl.classList.remove('hidden');
  } else {
    warningEl.classList.add('hidden');
  }
}

function showDetailRows(entry) {
  detailsEl.classList.remove('hidden');
  insufficientEl.classList.add('hidden');

  const accept = entry.accept || {};
  const rawAmount = accept.amount ?? accept.maxAmountRequired ?? '';
  toEl.textContent = truncateAddress(accept.payTo || '');
  toEl.title = accept.payTo || '';
  networkEl.textContent = String(accept.network || '—');

  if (entry.asset && typeof entry.asset.decimals === 'number') {
    const pretty = formatRawTokenBalance(rawAmount, entry.asset.decimals);
    amountEl.textContent = `${pretty} ${entry.asset.symbol}`;
  } else {
    amountEl.textContent = `${rawAmount} of ${truncateAddress(accept.asset || '')}`;
  }
}

// Render the chooser dropdown for multi-fundable cases. Each row is a
// radio control over the SAME named group so the browser handles the
// "exactly one selected" semantics. A single delegated `change`
// listener on the container catches selection updates — listening on
// label `click` would double-fire because the browser also synthesizes
// a click on the wrapped <input> that bubbles back to the label.
//
// The selected row keeps its visual treatment even when it becomes
// unfundable (pinned-selection rule); the inline error below the card
// surfaces the reason.
function showChooser(accepts, selectedIndex) {
  chooserEl.classList.remove('hidden');
  chooserOptionsEl.innerHTML = '';

  accepts.forEach((entry, index) => {
    const row = document.createElement('label');
    const classes = ['x402-chooser-row'];
    if (!entry.fundable) classes.push('is-unfundable');
    if (index === selectedIndex) classes.push('is-selected');
    row.className = classes.join(' ');
    row.innerHTML = `
      <input type="radio" name="x402-chooser" value="${index}"${index === selectedIndex ? ' checked' : ''}${entry.fundable ? '' : ' disabled'}>
      <span class="x402-chooser-row-main">
        <span class="x402-chooser-row-amount">${escapeHtml(formatAmountLabel(entry))}</span>
        <span class="x402-chooser-row-network">on ${escapeHtml(networkLabel(entry))}</span>
      </span>
      <span class="x402-chooser-row-balance${entry.fundable ? '' : ' is-low'}">${escapeHtml(balanceLabel(entry))}</span>
    `;
    chooserOptionsEl.appendChild(row);
  });
}

function hideChooser() {
  chooserEl.classList.add('hidden');
  chooserOptionsEl.innerHTML = '';
}

// Render the "no fundable accepts" state. Replaces the detail rows;
// lists every accepted asset + the wallet's current balance. Footer
// copy differs by accept count — "at least one of these" reads wrong
// when there's only one option.
function showInsufficientState(accepts) {
  detailsEl.classList.add('hidden');
  hideChooser();
  insufficientEl.classList.remove('hidden');
  insufficientListEl.innerHTML = '';

  accepts.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'x402-insufficient-item';
    li.innerHTML = `
      <span class="x402-insufficient-need">${escapeHtml(formatAmountLabel(entry))} on ${escapeHtml(networkLabel(entry))}</span>
      <span class="x402-insufficient-have">you have: ${escapeHtml(balanceLabel(entry))}</span>
    `;
    insufficientListEl.appendChild(li);
  });

  if (insufficientFooterEl) {
    insufficientFooterEl.textContent = accepts.length > 1
      ? 'Top up at least one of these to pay.'
      : 'Top up to pay.';
  }
}

// Recompute fundability for every displayed entry from a fresh-broadcast
// balances map. Selection is pinned (never silently moved); a flip to
// unfundable surfaces as a row treatment + inline notice instead.
// Skipped while a sign is in flight — repainting the button while it's
// stuck in "Signing…" would flicker the UI for no gain.
function applyFreshBalances(balances) {
  if (!pending?.accepts?.length || pending.signing) return;
  const prevAccepts = pending.accepts;
  const prevMode = computeMode(pending.accepts);
  const selectedIndex = pending.selectedAcceptIndex ?? 0;
  let changed = false;
  pending.accepts = pending.accepts.map((entry) => {
    if (!entry.tuple || !entry.balanceKey) return entry;
    const raw = balances?.[entry.balanceKey]?.raw ?? null;
    const fundable = !!(raw && safeBigInt(raw) >= safeBigInt(entry.tuple.amount));
    if (raw !== entry.balance || fundable !== entry.fundable) changed = true;
    return { ...entry, balance: raw, fundable };
  });
  if (!changed) return;
  if (computeMode(pending.accepts) !== prevMode ||
      selectedAcceptChanged(prevAccepts, pending.accepts, selectedIndex)) {
    renderCard();
  } else if (!chooserEl.classList.contains('hidden')) {
    showChooser(pending.accepts, pending.selectedAcceptIndex ?? 0);
  } else if (!insufficientEl.classList.contains('hidden')) {
    showInsufficientState(pending.accepts);
  }
}

function computeMode(accepts) {
  if (!accepts?.length) return 'empty';
  const f = accepts.filter((e) => e.fundable).length;
  if (f === 0) return 'insufficient';
  if (f === 1) return 'single';
  return 'chooser';
}

function clampSelectionIndex(accepts, currentIndex) {
  // Pinned-selection rule: never silently move the user's pick. Only
  // clamp out-of-bounds — if a stale initialSelectionIndex from main
  // pointed past the array, fall back to position 0 (any saner
  // recovery would override the user's intent on a reactive refresh).
  if (Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < accepts.length) {
    return currentIndex;
  }
  return 0;
}

function formatAmountLabel(entry) {
  const accept = entry.accept || {};
  const raw = accept.amount ?? accept.maxAmountRequired ?? '';
  if (entry.asset && typeof entry.asset.decimals === 'number') {
    return `${formatRawTokenBalance(raw, entry.asset.decimals)} ${entry.asset.symbol}`;
  }
  return `${raw} of ${truncateAddress(accept.asset || '')}`;
}

function networkLabel(entry) {
  // Prefer the registered chain name (e.g. "Base") when we recognise
  // the chainId; otherwise fall back to the raw CAIP-2 / V1 string.
  const chainId = entry.tuple?.chainId;
  if (chainId && walletState.registeredChains) {
    const chain = walletState.registeredChains[String(chainId)];
    if (chain?.name) return chain.name;
  }
  return String(entry.accept?.network || '—');
}

function balanceLabel(entry) {
  if (entry.balance == null) return '—';
  if (entry.asset && typeof entry.asset.decimals === 'number') {
    return `${formatRawTokenBalance(entry.balance, entry.asset.decimals)} ${entry.asset.symbol}`;
  }
  return entry.balance;
}

function safeBigInt(s) {
  try { return BigInt(s); } catch { return 0n; }
}

// Manual refresh on the insufficient-funds card. Disables the button +
// shows a "Refreshing…" label until main fetches fresh balances and
// broadcasts them via `x402:balances-updated`; the existing
// `onX402BalancesUpdated` handler then re-renders the card. If the
// fresh balances now make any entry fundable, `applyFreshBalances`
// detects the mode flip (insufficient → chooser/single) and triggers
// a full re-render.
async function refreshInsufficientBalances() {
  if (!pending || !insufficientRefreshBtn) return;
  // Guard against double-click while the previous IPC is in flight —
  // re-entering would race two clearBalanceCache + getAllBalances calls.
  if (insufficientRefreshBtn.disabled) return;
  const label = insufficientRefreshBtn.querySelector('.x402-insufficient-refresh-label');
  const originalLabel = label?.textContent ?? 'Refresh balances';
  insufficientRefreshBtn.disabled = true;
  if (label) label.textContent = 'Refreshing…';
  try {
    const result = await window.electronAPI.x402RefreshBalances({
      webContentsId: pending.webContentsId,
    });
    if (!result?.success) {
      console.warn('[x402] refresh-balances failed:', result?.error);
    }
  } catch (err) {
    console.error('[x402] refresh-balances threw:', err);
  } finally {
    if (insufficientRefreshBtn) insufficientRefreshBtn.disabled = false;
    if (label) label.textContent = originalLabel;
  }
}

// Read the live cap-amount + window inputs at Pay-click time. Returns
// undefined when the user hasn't ticked the grant checkbox or when the
// selected accept has no recognised asset (no decimals to convert
// with). Cap input is snap-back-validated on `change` (see
// wireGrantEditor) so the live value is always a positive whole, no
// silent fallback needed here.
function buildGrantPayloadFromInputs() {
  if (!grantToggle?.checked) return undefined;
  const accept = pending?.accepts?.[pending.selectedAcceptIndex];
  const decimals = accept?.asset?.decimals;
  if (typeof decimals !== 'number') return undefined;

  const capWhole = grantCapInput?.value?.trim() || String(DEFAULT_GRANT_CAP_USDC);
  const windowSeconds = Number(grantWindowSelect?.value) || DEFAULT_GRANT_WINDOW_SECONDS;
  return {
    capAmount: toAtomicUnits(capWhole, decimals),
    windowSeconds,
  };
}

async function checkUnlockState() {
  try {
    // Device accounts sign payment authorizations on the device — no
    // vault key, no unlock gate (short-circuit skips the status IPC).
    // Either way: drop locked-mode collapse + re-derive Pay-button
    // state from fundability + asset-recognised. The locked branch
    // below force-disables Pay, so this is what restores the correct
    // disabled state — without it the Pay button stays stuck until a
    // chooser interaction re-triggers renderCard.
    if (
      isDeviceAccount(walletState.activeWalletIndex) ||
      (await window.identity.getStatus()).isUnlocked
    ) {
      screen?.classList.remove('is-locked');
      unlockBlock?.classList.add('hidden');
      if (pending) renderCard();
      return;
    }

    // Collapse to just the site header + unlock block + Reject — the
    // CSS rules for `.is-locked` hide everything the user can't act
    // on yet (chooser, payment details, grant editor, Pay button).
    screen?.classList.add('is-locked');
    unlockBlock?.classList.remove('hidden');
    if (approveBtn) approveBtn.disabled = true;

    // Show Touch ID when available + enrolled, fall back to the password
    // link, and the section directly if the user doesn't yet have a
    // memorised password.
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    touchIdBtn?.classList.toggle('hidden', !hasTouchId);

    if (hasTouchId && userKnowsPassword) {
      passwordLink?.classList.remove('hidden');
      passwordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      passwordLink?.classList.add('hidden');
      passwordSection?.classList.remove('hidden');
    } else {
      passwordLink?.classList.add('hidden');
      passwordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[x402] failed to check vault status:', err);
    // Treat status-check failure as locked — show the unlock UI in
    // its safest shape (password section, no Touch ID), and keep the
    // card in locked-collapse mode so the user isn't presented with
    // the full chooser/details/grant they can't act on yet.
    screen?.classList.add('is-locked');
    unlockBlock?.classList.remove('hidden');
    touchIdBtn?.classList.add('hidden');
    passwordLink?.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
  }
}

async function handleTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result?.success) throw new Error(result?.error || 'Touch ID failed');
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult?.success) throw new Error(unlockResult?.error || 'Failed to unlock vault');
    hideUnlockError();
    await checkUnlockState();
  } catch (err) {
    if (err?.message !== 'Touch ID cancelled') {
      showUnlockError(err?.message || 'Touch ID failed');
    }
  }
}

async function handlePasswordUnlock() {
  const password = passwordInput?.value;
  if (!password) return;
  try {
    const result = await window.identity.unlock(password);
    if (!result?.success) throw new Error(result?.error || 'Incorrect password');
    if (passwordInput) passwordInput.value = '';
    hideUnlockError();
    await checkUnlockState();
  } catch (err) {
    showUnlockError(err?.message || 'Failed to unlock');
  }
}

async function approve() {
  // Re-entrance guard, same shape as dapp-tx/dapp-sign: a second click
  // (the chooser's `change` handler re-renders the card, which re-enables
  // Pay) would start a second, concurrent device signature and let
  // whichever finishes first settle the other one's flight.
  if (!pending || pending.signing) return;

  const request = pending;
  request.signing = true;
  // Claim the sidebar for the whole flight: no other approval surface may
  // repaint over the card or tear it down (which would cancel the
  // detection in main) while the device confirmation is live.
  beginSignatureFlight(request);
  lockCardForFlight();
  hideError();

  const grant = buildGrantPayloadFromInputs();
  let result;
  try {
    result = await window.electronAPI.x402Approve({
      webContentsId: request.webContentsId,
      detectionId: request.detectionId,
      grant,
      selectedAcceptIndex: request.selectedAcceptIndex,
    });
  } catch (err) {
    restoreCardWithError(request, err?.message || 'Payment approval failed.');
    return;
  }

  if (result?.success) {
    // Subresource path returns pending:true; card stays in "Signing..."
    // and handleApprovalResult finalises it. mainFrame path returns
    // success without pending — close immediately.
    if (result.pending) return;
    // The card this call belongs to may already be gone (the paying tab
    // died mid-signature and main sent `cancelled`, tearing it down) and
    // replaced by a newer request. Settle only our own flight then —
    // closing here would hide a live card that isn't ours.
    if (pending !== request) {
      settleFlight(request);
      return;
    }
    closeAndReset();
    updateX402ConnectionBanner().catch(() => {});
    return;
  }

  restoreCardWithError(request, result?.error);
}

// The card's controls while a device confirmation is live: no way in and
// no way out, because the prompt on the device cannot be recalled. Also
// re-applied by renderCard, which otherwise re-enables Pay underneath an
// in-flight signature (chooser flips, unlock re-checks, balance updates).
function lockCardForFlight() {
  approveBtn.disabled = true;
  rejectBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  approveBtn.textContent = signingButtonLabel(walletState.activeWalletIndex);
}

// Settle a request's claim on the sidebar. Identity-scoped: a stale
// continuation (its card already torn down and replaced) clears its own
// flag and releases only a lock it still holds — endSignatureFlight is a
// no-op for a token that no longer owns it.
function settleFlight(request) {
  if (!request) return;
  request.signing = false;
  endSignatureFlight(request);
}

// Restore the approval card to its clickable state and show an error.
// Used by both the synchronous mainFrame error path (in approve()) and
// the async subresource sign-after-approve failure (in
// handleApprovalResult). The locked-vault re-check is the non-obvious
// behaviour worth centralising — without it the unlock UI won't re-
// appear when the vault auto-locked between render and click.
// `request` is the card the failure belongs to: a continuation whose card
// was already torn down (cancelled paying tab) must not repaint — or
// unlock — the card that replaced it, nor release its signature lock.
function restoreCardWithError(request, error) {
  settleFlight(request);
  if (request && pending !== request) {
    console.warn('[x402] ignoring result for a card that is no longer shown:', error);
    return;
  }
  approveBtn.textContent = 'Pay';
  approveBtn.disabled = false;
  rejectBtn.disabled = false;
  if (backBtn) backBtn.disabled = false;
  showError(error || 'Payment failed.');
  if (/locked/i.test(error || '')) {
    checkUnlockState();
  }
}

// Finalises the subresource "Signing..." state when the detector's
// async sign completes. detectionId-match guards against a stale event
// for a previously-rendered card.
function handleApprovalResult({ detectionId, success, error, cancelled }) {
  if (!pending || pending.detectionId !== detectionId) return;
  if (success) {
    closeAndReset();
    updateX402ConnectionBanner().catch(() => {});
    return;
  }
  if (cancelled) {
    // The request itself is gone (main sends this when the paying tab is
    // destroyed). There is nothing left to retry, so tear the card down —
    // which is also what releases the sidebar if the user had already
    // sent the authorization to the device.
    console.warn(`[x402] approval cancelled: ${error || 'request is gone'}`);
    closeAndReset();
    return;
  }
  restoreCardWithError(pending, error);
}

async function reject() {
  if (!pending) {
    closeAndReset();
    return;
  }
  const id = pending.webContentsId;
  const detectionId = pending.detectionId;
  const isSubresource = pending.resourceType && pending.resourceType !== 'mainFrame';
  closeAndReset();
  try {
    if (isSubresource && detectionId) {
      // Subresource flow: settle the pending approval Promise so the
      // detector returns null and the page sees the 402. No webview
      // navigation — the user is still on whatever page initiated the
      // subresource fetch.
      await window.electronAPI.x402Reject({ detectionId });
    } else {
      // mainFrame paywall page: existing behaviour — clear detection
      // and navigate the webview back (or to about:blank if no history).
      await window.electronAPI.x402Cancel({ webContentsId: id });
    }
  } catch (err) {
    console.error('[x402] reject/cancel failed:', err);
  }
}

function closeAndReset() {
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  // The card is gone, so whatever signature it owned is settled — release
  // the sidebar (no-op unless this card holds the lock).
  endSignatureFlight(pending);
  pending = null;
  resetGrantEditor();
  approveBtn.textContent = 'Pay';
  approveBtn.disabled = false;
  rejectBtn.disabled = false;
  if (backBtn) backBtn.disabled = false;
  hideError();
  hideUnlockError();
  if (passwordInput) passwordInput.value = '';
}

async function refreshAfterX402Payment() {
  await refreshBalances(true);
  if (!pending?.webContentsId) return;
  const result = await window.electronAPI.x402RefreshBalances({
    webContentsId: pending.webContentsId,
  });
  if (!result?.success) {
    console.warn('[x402] open-card balance refresh failed:', result?.error);
  }
}

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl?.classList.add('hidden');
  if (errorEl) errorEl.textContent = '';
}

function showUnlockError(message) {
  if (!unlockError) return;
  unlockError.textContent = message;
  unlockError.classList.remove('hidden');
}

function hideUnlockError() {
  unlockError?.classList.add('hidden');
  if (unlockError) unlockError.textContent = '';
}

/**
 * Refresh the auto-pay banner for the current address bar URL (or the
 * supplied origin key). Shows the banner iff there's at least one
 * active cap for that origin.
 */
export async function updateX402ConnectionBanner(originKey = null) {
  if (!bannerEl) return;

  let key = originKey;
  if (!key) {
    const displayUrl = document.getElementById('address-input')?.value || '';
    key = getPermissionKey(displayUrl);
  }

  if (!key) {
    bannerEl.classList.add('hidden');
    currentBannerKey = null;
    return;
  }

  try {
    const result = await window.electronAPI.x402GetAllPermissions();
    const forOrigin = (result?.permissions || []).filter((p) => p.origin === key);

    if (forOrigin.length === 0) {
      bannerEl.classList.add('hidden');
      currentBannerKey = null;
      return;
    }

    if (bannerSiteEl) bannerSiteEl.textContent = key;
    if (bannerRemainingEl) {
      bannerRemainingEl.textContent = await formatRemainingSummary(forOrigin);
    }
    currentBannerKey = key;
    bannerEl.classList.remove('hidden');
  } catch (err) {
    console.error('[x402] failed to refresh banner:', err);
    bannerEl.classList.add('hidden');
    currentBannerKey = null;
  }
}

// Render the per-origin remaining-cap summary. Single asset → sum and
// show "X SYMBOL left". Multi-asset → list each per-symbol remaining
// joined with " + " (typical multi-accept case is 2 caps, fits the
// banner width easily). Caps missing token-registry metadata
// (unrecognised asset) get a generic per-cap entry so the count is
// still surfaced even if we can't name the asset.
async function formatRemainingSummary(perms) {
  // tokens:get-token returns an `{success, token}` envelope — unwrap it.
  const enriched = await Promise.all(
    perms.map(async (p) => {
      const r = await window.tokens.getToken(`${p.chainId}:${p.asset}`);
      return { perm: p, asset: r?.token ?? null };
    })
  );

  // Aggregate remaining per symbol so two caps on the same asset
  // (different chains, same symbol — e.g. USDC on Base + USDC on
  // Ethereum) sum into one display entry rather than appearing twice.
  const bySymbol = new Map();
  for (const { perm, asset } of enriched) {
    let remaining = BigInt(perm.capAmount) - BigInt(perm.spentAmount);
    if (remaining < 0n) remaining = 0n;
    const symbol = asset?.symbol ?? `chain ${perm.chainId}`;
    const decimals = typeof asset?.decimals === 'number' ? asset.decimals : 0;
    const existing = bySymbol.get(symbol);
    if (existing) {
      existing.remaining += remaining;
    } else {
      bySymbol.set(symbol, { remaining, decimals });
    }
  }

  const parts = [];
  for (const [symbol, { remaining, decimals }] of bySymbol) {
    parts.push(`${formatRawTokenBalance(remaining.toString(), decimals)} ${symbol}`);
  }
  return `${parts.join(' + ')} left`;
}

export async function disconnectX402(originKey) {
  const key = originKey || currentBannerKey;
  if (!key) return;
  try {
    await window.electronAPI.x402RevokeAllForOrigin({ origin: key });
    bannerEl?.classList.add('hidden');
    currentBannerKey = null;
  } catch (err) {
    console.error('[x402] revoke-all failed:', err);
  }
}
