/**
 * Shared account picker for the device-connect screens (connect-ledger,
 * connect-phone): a list of addresses read from the device, with
 * already-added accounts disabled. The screens keep their own flow
 * state and pass it in per render.
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
 * @param {Array<{address: string, subLabel?: string}>} accounts
 * @param {Object} opts
 * @param {string|null} opts.selectedAddress
 * @param {Set<string>} opts.existingAddresses - from existingWalletAddresses()
 * @param {(account: {address: string}) => void} opts.onSelect
 */
export function renderDeviceAccountList(listEl, accounts, { selectedAddress, existingAddresses, onSelect }) {
  if (!listEl) return;
  listEl.innerHTML = '';

  accounts.forEach((account) => {
    const alreadyAdded = existingAddresses.has(account.address.toLowerCase());
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'connect-ledger-account';
    if (alreadyAdded) item.classList.add('added');
    if (selectedAddress && selectedAddress.toLowerCase() === account.address.toLowerCase()) {
      item.classList.add('selected');
    }
    item.disabled = alreadyAdded;

    item.innerHTML = `
      <div class="connect-ledger-account-info">
        <code class="connect-ledger-account-address">${escapeHtml(truncateAddress(account.address))}</code>
        ${account.subLabel ? `<span class="connect-ledger-account-path">${escapeHtml(account.subLabel)}</span>` : ''}
      </div>
      ${alreadyAdded ? '<span class="connect-ledger-account-added">Added</span>' : ''}
    `;

    if (!alreadyAdded) {
      item.addEventListener('click', () => onSelect(account));
    }

    listEl.appendChild(item);
  });
}
