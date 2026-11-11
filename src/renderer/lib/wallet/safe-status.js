/**
 * Safe account status card — the blocking states of a Safe account as
 * first-class UI (research doc Part B, decision 2), shown under the
 * Send/Receive actions when the active account is a Safe:
 *   - ready:        activation fee quote + who pays + Activate button
 *   - needs-funds:  blocking "fund <executor> with ≥ X xDAI" card
 *   - no-executor:  none of the owners is a browser account that can pay
 *   - owner check:  a Ledger owner no device has matched yet (#1065), shown
 *                   above any of the above, deployed or not
 * (Pending SafeTxs live in the wallet-wide "unfinished transactions"
 * row — see safe-pending-list.js.) A deployed Safe with checked owners
 * shows no card. The Send button's availability is owned by send.js; this
 * module just triggers the re-evaluation whenever the active account
 * changes.
 */

import { walletState } from './wallet-state.js';
import {
  escapeHtml,
  truncateAddress,
  formatRawTokenBalance,
  walletRecord,
  isSafeDeployed,
  showInlineError,
} from './wallet-utils.js';
import { updateSendAvailability } from './send.js';
import { showVaultUnlock } from './vault-unlock.js';

let card;
let refreshToken = 0;
let ownerWarning = '';

/**
 * The Safe's Ledger owners no device has shown to hold their address
 * (#1065): records added before main read the address back from the
 * device, or ones the Ledger last connected didn't hold. New Safes refuse
 * them as owners; a Safe created before that still lists them.
 *
 * @returns {Array<Object>} the owner records, unchecked or mismatched
 */
export function uncheckedLedgerOwners(wallet, records = walletState.derivedWallets || []) {
  if (wallet?.type !== 'safe' || !Array.isArray(wallet.owners)) return [];
  return wallet.owners
    .map((ownerIndex) => records.find((record) => record.index === ownerIndex))
    .filter(
      (owner) => owner?.type === 'ledger' && owner.addressCheck && owner.addressCheck !== 'matched'
    );
}

/** The warning for those owners, or '' when there are none. */
export function ownerWarningHtml(owners) {
  if (!owners.length) return '';
  const named = owners
    .map(
      (owner) =>
        `"${escapeHtml(owner.name)}" (${
          owner.addressCheck === 'mismatched'
            ? 'not on the Ledger last connected'
            : 'not checked on its Ledger yet'
        })`
    )
    .join(', ');
  const one = owners.length === 1;
  return `
    <div class="safe-status-text safe-status-owner-warning">
      <strong>Check ${one ? 'this owner' : 'these owners'} before adding funds.</strong>
      No Ledger has confirmed ${one ? 'the address of' : 'the addresses of'} ${named}, so this
      account may not be under your control. Connect the Ledger that holds
      ${one ? 'it' : 'them'} and open Connect Hardware Wallet.
    </div>
  `;
}

/**
 * Re-evaluate the card for the active account. Called whenever the
 * active account changes (wallet-selector) and after activation.
 */
export async function refreshSafeStatusCard() {
  card = document.getElementById('safe-status-card');
  if (!card) return;

  updateSendAvailability();

  const wallet = walletRecord();
  if (wallet?.type !== 'safe') {
    card.classList.add('hidden');
    return;
  }

  ownerWarning = ownerWarningHtml(uncheckedLedgerOwners(wallet));

  // Deployed safes need no activation card — and the record snapshot is
  // trustworthy once it says deployed (deployment is permanent).
  if (isSafeDeployed(wallet)) {
    ++refreshToken;
    hideUnlessWarning();
    return;
  }

  const token = ++refreshToken;
  render(`<div class="safe-status-text">Checking account status…</div>`);

  const statusResult = await window.wallet.getSafeStatus(wallet.index);
  if (token !== refreshToken) return; // superseded by an account switch
  if (!statusResult.success) {
    render(`<div class="safe-status-text">${escapeHtml(statusResult.error)}</div>`);
    return;
  }

  // Main owns deployment truth (it self-heals the stored record from
  // chain state) — sync the renderer's record snapshot so capability
  // gates like the Send button don't act on a stale copy.
  if (statusResult.status.deployed && !wallet.deployed?.[statusResult.status.chainId]) {
    wallet.deployed = { ...wallet.deployed, [statusResult.status.chainId]: true };
    updateSendAvailability();
  }

  renderStatus(statusResult.status);
}

function renderStatus(status) {
  if (status.deployed) {
    hideUnlessWarning();
    return;
  }

  if (status.executorIndex === null) {
    render(`
      <div class="safe-status-text">
        This account can receive funds, but none of its owners is a
        browser account that could pay the activation fee.
      </div>
    `);
    return;
  }

  const executorName =
    walletState.derivedWallets.find((wallet) => wallet.index === status.executorIndex)?.name ||
    'an owner account';

  if (status.needsFunds) {
    render(`
      <div class="safe-status-text">
        <strong>Receive-only.</strong> To activate on Gnosis, fund
        <code>${escapeHtml(truncateAddress(status.executorAddress))}</code>
        (${escapeHtml(executorName)}) with at least
        <strong>${formatRawTokenBalance(status.estimatedCost)} xDAI</strong>.
      </div>
      <button type="button" class="safe-status-btn" id="safe-status-refresh">I've added funds</button>
    `);
    document
      .getElementById('safe-status-refresh')
      ?.addEventListener('click', refreshSafeStatusCard);
    return;
  }

  render(`
    <div class="safe-status-text">
      <strong>Receive-only until activated.</strong> One-time activation
      on Gnosis costs ≈ ${formatRawTokenBalance(status.estimatedCost)} xDAI,
      paid by ${escapeHtml(executorName)}.
    </div>
    <button type="button" class="safe-status-btn primary" id="safe-status-activate">Activate</button>
    <div class="unlock-error hidden" id="safe-status-error"></div>
  `);
  document.getElementById('safe-status-activate')?.addEventListener('click', handleActivate);
}

async function handleActivate() {
  const wallet = walletRecord();
  if (!wallet) return;

  const button = document.getElementById('safe-status-activate');
  if (button) {
    button.disabled = true;
    button.textContent = 'Activating…';
  }

  const result = await window.wallet.activateSafe(wallet.index);

  // Deployment is signed by the executor's vault key: a locked vault is
  // a step in the flow, not a failure — walk the user through the
  // standard unlock and retry.
  if (!result.success && result.code === 'VAULT_LOCKED') {
    try {
      await showVaultUnlock('Activate your multi-owner account');
      return handleActivate();
    } catch {
      // user cancelled — fall through to the re-rendered card
    }
  }

  await refreshSafeStatusCard(); // re-render first, then surface errors on it
  if (!result.success && result.code !== 'VAULT_LOCKED') {
    // NEEDS_FUNDS re-renders as its own blocking state; anything else
    // (RPC down …) must be said out loud, not just reset.
    console.error('[SafeStatus] Activation failed:', result.error);
    showInlineError(document.getElementById('safe-status-error'), result.error);
  }
}

function render(html) {
  card.innerHTML = ownerWarning + html;
  card.classList.remove('hidden');
}

/** A Safe with nothing to activate still shows the owner warning. */
function hideUnlessWarning() {
  if (ownerWarning) {
    render('');
  } else {
    card.classList.add('hidden');
  }
}
