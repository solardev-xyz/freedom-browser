/**
 * Shared utility functions for wallet UI modules.
 */

import { walletState } from './wallet-state.js';

export function truncateAddress(address, startChars = 6, endChars = 4) {
  if (!address || address.length <= startChars + endChars + 3) {
    return address;
  }
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/** Account type ('mnemonic' | 'ledger' | 'remote') for a wallet index. */
export function accountType(walletIndex) {
  return walletState.derivedWallets?.find((wallet) => wallet.index === walletIndex)?.type;
}

export function isLedgerAccount(walletIndex) {
  return accountType(walletIndex) === 'ledger';
}

/**
 * Whether a wallet index belongs to a device account (Ledger hardware,
 * remote phone). Device accounts sign on the device: no vault unlock,
 * and approval UIs show a "confirm on your device" state instead of
 * instant signing.
 *
 * @param {number} walletIndex
 * @returns {boolean}
 */
export function isDeviceAccount(walletIndex) {
  const type = accountType(walletIndex);
  return type === 'ledger' || type === 'remote';
}

/**
 * Where a device account confirms ('your Ledger' / 'your phone'), or
 * null for vault accounts — the one type→noun mapping the approval UIs
 * build their copy from.
 */
export function deviceLabel(walletIndex) {
  return { ledger: 'your Ledger', remote: 'your phone' }[accountType(walletIndex)] || null;
}

/** Pending label for approve buttons while a signature is in flight. */
export function signingButtonLabel(walletIndex) {
  const label = deviceLabel(walletIndex);
  return label ? `Confirm on ${label}…` : 'Signing…';
}

/** QR options for phone-scanned codes: fixed black-on-white regardless of theme. */
export function generateScannableQr(text) {
  return window.wallet.generateQR(text, {
    width: 200,
    margin: 2,
    dark: '#000000',
    light: '#ffffff',
    errorCorrectionLevel: 'M',
  });
}

/**
 * Device accounts sign on the device — no vault key, no unlock gate.
 * Hides the unlock section and enables the confirm button; returns true
 * when the gate was bypassed so callers can skip the vault-status flow.
 *
 * @param {number} walletIndex
 * @param {HTMLElement|null} unlockEl - the unlock section to hide
 * @param {HTMLButtonElement|null} confirmBtn - the approve/confirm button
 * @returns {boolean}
 */
export function bypassUnlockGateForDevice(walletIndex, unlockEl, confirmBtn) {
  if (!isDeviceAccount(walletIndex)) return false;
  unlockEl?.classList.add('hidden');
  if (confirmBtn) confirmBtn.disabled = false;
  return true;
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Show a message in an inline error box (the `.hidden`-toggled pattern). */
export function showInlineError(el, message) {
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

export function hideInlineError(el) {
  if (el) {
    el.classList.add('hidden');
    el.textContent = '';
  }
}

export function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
    }
  }

  return 'Just now';
}

export function formatBalance(formatted, maxDecimals = 4) {
  const num = parseFloat(formatted);
  if (isNaN(num)) return '0';
  if (num === 0) return '0';
  if (num < 0.0001) return '<0.0001';

  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Window options for the x402 cap-resets-every selector. Used by the
// grant editor on the approval card (dapp-x402.js) and the
// permission-manage subscreen (permission-manage.js) — single source
// of truth so a new entry / label change can't drift between surfaces.
export const X402_WINDOW_OPTIONS = [
  { label: '1 day',    seconds: 24 * 60 * 60 },
  { label: '7 days',   seconds: 7 * 24 * 60 * 60 },
  { label: '30 days',  seconds: 30 * 24 * 60 * 60 },
  { label: '90 days',  seconds: 90 * 24 * 60 * 60 },
  { label: '1 year',   seconds: 365 * 24 * 60 * 60 },
];

export function isChequebookDeployed(address) {
  return typeof address === 'string' && address !== ZERO_ADDRESS && address.length > 2;
}

export function formatRawTokenBalance(rawValue, decimals = 18) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return '--';
  }

  try {
    const value = BigInt(rawValue);
    const divisor = 10n ** BigInt(decimals);
    const integerPart = value / divisor;
    const fractionalPart = value % divisor;
    const fractional = fractionalPart.toString().padStart(decimals, '0').replace(/0+$/, '');
    const formatted = fractional ? `${integerPart}.${fractional}` : integerPart.toString();
    return formatBalance(formatted);
  } catch {
    return '--';
  }
}

// Inverse of formatRawTokenBalance for *whole-unit* inputs: "10" + 6 → "10000000".
// Pass a digit string (or a number coercible to BigInt) — fractional amounts
// would need a different parser and aren't accepted here.
export function toAtomicUnits(humanAmount, decimals) {
  return (BigInt(humanAmount) * 10n ** BigInt(decimals)).toString();
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
