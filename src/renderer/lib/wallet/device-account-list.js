/**
 * Shared account picker for the wallet subscreens (connect-ledger,
 * connect-phone, create-safe): a list of accounts with selected /
 * already-added states. The screens keep their own flow state and pass
 * it in per render.
 */

import { escapeHtml, truncateAddress } from './wallet-utils.js';

/** Lowercased addresses already in the wallet list. */
export function existingWalletAddresses(derivedWallets) {
  return new Set(
    derivedWallets
      .filter((wallet) => wallet.address)
      .map((wallet) => wallet.address.toLowerCase())
  );
}

/**
 * @param {HTMLElement} listEl
 * @param {Array<{address: string, label?: string, subLabel?: string}>} accounts
 *   `label` overrides the primary line (default: truncated address).
 * @param {Object} opts
 * @param {string|null} [opts.selectedAddress] - single-select mode
 * @param {Set<string>} [opts.selectedAddresses] - multi-select mode
 *   (lowercased); selected items stay clickable so they can be toggled
 * @param {string} [opts.selectedBadge] - badge on selected items
 * @param {Set<string>} opts.existingAddresses - from existingWalletAddresses();
 *   these render disabled with an "Added" badge
 * @param {(account: {address: string}) => void} opts.onSelect
 */
export function renderDeviceAccountList(
  listEl,
  accounts,
  { selectedAddress, selectedAddresses, selectedBadge, existingAddresses, onSelect }
) {
  if (!listEl) return;
  listEl.innerHTML = '';

  const isSelected = (address) =>
    selectedAddresses
      ? selectedAddresses.has(address.toLowerCase())
      : Boolean(selectedAddress && selectedAddress.toLowerCase() === address.toLowerCase());

  accounts.forEach((account) => {
    const alreadyAdded = existingAddresses.has(account.address.toLowerCase());
    const selected = !alreadyAdded && isSelected(account.address);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'connect-ledger-account';
    if (alreadyAdded) item.classList.add('added');
    if (selected) item.classList.add('selected');
    item.disabled = alreadyAdded;

    const badge = alreadyAdded ? 'Added' : selected && selectedBadge ? selectedBadge : '';
    item.innerHTML = `
      <div class="connect-ledger-account-info">
        <code class="connect-ledger-account-address">${escapeHtml(account.label ?? truncateAddress(account.address))}</code>
        ${account.subLabel ? `<span class="connect-ledger-account-path">${escapeHtml(account.subLabel)}</span>` : ''}
      </div>
      ${badge ? `<span class="connect-ledger-account-added">${escapeHtml(badge)}</span>` : ''}
    `;

    if (!alreadyAdded) {
      item.addEventListener('click', () => onSelect(account));
    }

    listEl.appendChild(item);
  });
}
