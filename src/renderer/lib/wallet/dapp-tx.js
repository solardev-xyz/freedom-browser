/**
 * dApp Transaction Approval Module
 *
 * Transaction approval screen for dApp-initiated transactions.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import {
  assertNoSignatureInFlight,
  isSignatureInFlight,
  signatureInFlightError,
  beginSignatureFlight,
  endSignatureFlight,
} from './signature-flight.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { bypassUnlockGateForDevice, signingButtonLabel } from './wallet-utils.js';

// DOM references
let dappTxScreen;
let dappTxBackBtn;
let dappTxSite;
let dappTxTo;
let dappTxValue;
let dappTxData;
let dappTxDataRow;
let dappTxNetwork;
let dappTxFee;
let dappTxWarning;
let dappTxUnlock;
let dappTxTouchIdBtn;
let dappTxPasswordLink;
let dappTxPasswordSection;
let dappTxPasswordInput;
let dappTxPasswordSubmit;
let dappTxError;
let dappTxRejectBtn;
let dappTxApproveBtn;
let dappTxAutoApproveRow;
let dappTxAutoApproveCheckbox;

// Local state. `dappTxPending.signing` is true while the signature and
// broadcast are in flight: a hardware signature is a device prompt we
// cannot recall, so there is no cancellation path once it starts —
// rejecting behind it would settle the dApp promise with 4001 while the
// transaction still broadcasts.
let dappTxPending = null;

const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

export function initDappTx() {
  dappTxScreen = document.getElementById('sidebar-dapp-tx');
  dappTxBackBtn = document.getElementById('dapp-tx-back');
  dappTxSite = document.getElementById('dapp-tx-site');
  dappTxTo = document.getElementById('dapp-tx-to');
  dappTxValue = document.getElementById('dapp-tx-value');

  dappTxData = document.getElementById('dapp-tx-data');
  dappTxDataRow = document.getElementById('dapp-tx-data-row');
  dappTxNetwork = document.getElementById('dapp-tx-network');
  dappTxFee = document.getElementById('dapp-tx-fee');
  dappTxWarning = document.getElementById('dapp-tx-warning');
  dappTxUnlock = document.getElementById('dapp-tx-unlock');
  dappTxTouchIdBtn = document.getElementById('dapp-tx-touchid-btn');
  dappTxPasswordLink = document.getElementById('dapp-tx-password-link');
  dappTxPasswordSection = document.getElementById('dapp-tx-password-section');
  dappTxPasswordInput = document.getElementById('dapp-tx-password-input');
  dappTxPasswordSubmit = document.getElementById('dapp-tx-password-submit');
  dappTxError = document.getElementById('dapp-tx-error');
  dappTxRejectBtn = document.getElementById('dapp-tx-reject');
  dappTxApproveBtn = document.getElementById('dapp-tx-approve');
  dappTxAutoApproveRow = document.getElementById('dapp-tx-auto-approve-row');
  dappTxAutoApproveCheckbox = document.getElementById('dapp-tx-auto-approve');

  // Register screen hider
  registerScreenHider(() => dappTxScreen?.classList.add('hidden'));

  setupDappTxScreen();
}

function setupDappTxScreen() {
  if (dappTxBackBtn) {
    dappTxBackBtn.addEventListener('click', () => {
      if (dappTxPending?.signing) return;
      rejectDappTx();
      closeDappTx();
    });
  }

  if (dappTxRejectBtn) {
    dappTxRejectBtn.addEventListener('click', () => {
      if (dappTxPending?.signing) return;
      rejectDappTx();
      closeDappTx();
    });
  }

  if (dappTxApproveBtn) {
    dappTxApproveBtn.addEventListener('click', approveDappTx);
  }

  if (dappTxTouchIdBtn) {
    dappTxTouchIdBtn.addEventListener('click', handleDappTxTouchIdUnlock);
  }

  if (dappTxPasswordSubmit) {
    dappTxPasswordSubmit.addEventListener('click', handleDappTxPasswordUnlock);
  }

  if (dappTxPasswordInput) {
    dappTxPasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleDappTxPasswordUnlock();
    });
  }

  if (dappTxPasswordLink) {
    dappTxPasswordLink.addEventListener('click', () => {
      dappTxPasswordLink.classList.add('hidden');
      dappTxPasswordSection?.classList.remove('hidden');
      dappTxPasswordInput?.focus();
    });
  }
}

/**
 * Show dApp transaction approval screen
 *
 * The sidebar is a single shared surface, and an in-flight signature owns
 * it: the device prompt it produced cannot be recalled, so a later request
 * must not repaint the screen, reset `dappTxPending` and re-enable
 * Reject/Back/Confirm underneath it — the user would then be cancelling
 * (or confirming) request B while the device is still showing request A.
 * The lock is global (see signature-flight.js), so this refuses the
 * newcomer whichever surface is holding the device: a sibling transaction,
 * a dapp-sign request, or an x402 payment. The dApp can retry once the
 * device is done.
 */
export async function showDappTxApproval(webview, permissionKey, txParams) {
  assertNoSignatureInFlight();

  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (!permission) {
    throw Object.assign(new Error('Unauthorized - not connected'), { code: 4100 });
  }

  const chainId = permission.chainId || walletState.selectedChainId;
  const selector = extractSelector(txParams.data);

  return new Promise((resolve, reject) => {
    // Re-checked after the awaits above: the screen must still be free at
    // the moment we take it over.
    assertNoSignatureInFlight();
    const request = { permissionKey, walletIndex: permission.walletIndex, txParams, resolve, reject, webview, chainId, selector };
    dappTxPending = request;

    if (dappTxSite) {
      dappTxSite.textContent = permissionKey;
    }

    // Show auto-approve checkbox only for contract calls (has function selector)
    if (dappTxAutoApproveCheckbox) dappTxAutoApproveCheckbox.checked = false;
    setDappTxCancelEnabled(true);
    if (dappTxAutoApproveRow) {
      dappTxAutoApproveRow.classList.toggle('hidden', !selector);
    }

    Promise.all([
      populateDappTxDetails(txParams, chainId),
      checkDappTxUnlockStatus(),
    ]).then(() => {
      // Another surface may have started a device signature while we were
      // estimating fees / checking vault status (the user could still
      // click Pay on an x402 card, say). It owns the sidebar now — refuse
      // rather than paint over a live confirmation.
      if (isSignatureInFlight()) {
        if (dappTxPending === request) dappTxPending = null;
        reject(signatureInFlightError());
        return;
      }
      hideAllSubscreens();
      walletState.identityView?.classList.add('hidden');
      dappTxScreen?.classList.remove('hidden');

      openSidebarPanel();
    });
  });
}

async function populateDappTxDetails(txParams, chainId) {
  const chainsResult = await window.networks.getChains();
  const chains = chainsResult.success ? chainsResult.chains : {};
  const chain = chains[chainId];

  if (dappTxTo) {
    const to = txParams.to || '';
    dappTxTo.textContent = to ? `${to.slice(0, 10)}...${to.slice(-8)}` : 'Contract Creation';
    dappTxTo.title = to;
  }

  if (dappTxValue) {
    const value = txParams.value ? BigInt(txParams.value) : 0n;
    const ethValue = Number(value) / 1e18;
    const symbol = chain?.nativeSymbol || 'ETH';
    dappTxValue.textContent = `${ethValue.toFixed(6)} ${symbol}`;
  }

  if (dappTxData) {
    const data = txParams.data || '';
    if (data && data !== '0x') {
      dappTxData.textContent = `${data.slice(0, 20)}...`;
      dappTxData.title = data;
      dappTxDataRow?.classList.remove('hidden');
      dappTxWarning?.classList.remove('hidden');
    } else {
      dappTxData.textContent = 'No data';
      dappTxDataRow?.classList.remove('hidden');
      dappTxWarning?.classList.add('hidden');
    }
  }

  if (dappTxNetwork) {
    dappTxNetwork.textContent = chain?.name || `Chain ${chainId}`;
  }

  if (dappTxFee) {
    try {
      const walletsResult = await window.wallet.getDerivedWallets();
      const wallets = walletsResult.success ? walletsResult.wallets : [];
      const wallet = wallets.find(w => w.index === dappTxPending?.walletIndex);

      if (wallet) {
        const gasResult = await window.wallet.estimateGas({
          from: wallet.address,
          to: txParams.to,
          value: txParams.value || '0',
          data: txParams.data,
          chainId,
        });

        const priceResult = await window.wallet.getGasPrice(chainId);

        if (gasResult.success && priceResult.success) {
          const gasLimit = BigInt(gasResult.gasLimit);
          const gasPrice = BigInt(priceResult.effectiveGasPrice);
          const fee = gasLimit * gasPrice;
          const feeEth = Number(fee) / 1e18;
          const symbol = chain?.nativeSymbol || 'ETH';
          dappTxFee.textContent = `~${feeEth.toFixed(6)} ${symbol}`;

          if (dappTxPending) {
            dappTxPending.gasLimit = gasResult.gasLimit;
            dappTxPending.gasPrice = priceResult;
            dappTxPending.chainId = chainId;
          }
        } else {
          dappTxFee.textContent = 'Unable to estimate';
        }
      }
    } catch (err) {
      console.error('[WalletUI] Gas estimation failed:', err);
      dappTxFee.textContent = 'Unable to estimate';
    }
  }
}

async function checkDappTxUnlockStatus() {
  try {
    if (bypassUnlockGateForDevice(dappTxPending?.walletIndex, dappTxUnlock, dappTxApproveBtn)) {
      return;
    }

    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      dappTxUnlock?.classList.add('hidden');
      if (dappTxApproveBtn) dappTxApproveBtn.disabled = false;
      return;
    }

    dappTxUnlock?.classList.remove('hidden');
    if (dappTxApproveBtn) dappTxApproveBtn.disabled = true;

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    if (dappTxTouchIdBtn) {
      dappTxTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    if (hasTouchId && userKnowsPassword) {
      dappTxPasswordLink?.classList.remove('hidden');
      dappTxPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      dappTxPasswordLink?.classList.add('hidden');
      dappTxPasswordSection?.classList.remove('hidden');
    } else {
      dappTxPasswordLink?.classList.add('hidden');
      dappTxPasswordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[WalletUI] Failed to check vault status:', err);
    dappTxUnlock?.classList.remove('hidden');
    dappTxTouchIdBtn?.classList.add('hidden');
    dappTxPasswordLink?.classList.add('hidden');
    dappTxPasswordSection?.classList.remove('hidden');
  }
}

async function handleDappTxTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID failed');
    }

    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    dappTxUnlock?.classList.add('hidden');
    if (dappTxApproveBtn) dappTxApproveBtn.disabled = false;
    hideDappTxError();
  } catch (err) {
    console.error('[WalletUI] dApp tx Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showDappTxError(err.message || 'Touch ID failed');
    }
  }
}

async function handleDappTxPasswordUnlock() {
  const password = dappTxPasswordInput?.value;
  if (!password) return;

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    dappTxUnlock?.classList.add('hidden');
    if (dappTxApproveBtn) dappTxApproveBtn.disabled = false;
    if (dappTxPasswordInput) dappTxPasswordInput.value = '';
    hideDappTxError();
  } catch (err) {
    console.error('[WalletUI] dApp tx password unlock failed:', err);
    showDappTxError(err.message || 'Failed to unlock');
  }
}

async function approveDappTx() {
  if (!dappTxPending || dappTxPending.signing) return;

  const request = dappTxPending;
  const { permissionKey, walletIndex, txParams, resolve, gasLimit, gasPrice, chainId, selector } = request;
  // Snapshot the auto-approve intent now: the checkbox is shared DOM that
  // a later request can repopulate while this send is still in flight.
  const autoApprove = Boolean(dappTxAutoApproveCheckbox?.checked);

  try {
    request.signing = true;
    // Claim the sidebar for the whole flight: no other approval surface
    // may repaint over or tear down a live device confirmation.
    beginSignatureFlight(request);
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = true;
      dappTxApproveBtn.textContent = signingButtonLabel(walletIndex);
    }
    setDappTxCancelEnabled(false);

    const tx = {
      to: txParams.to,
      value: txParams.value || '0',
      data: txParams.data,
      gasLimit: gasLimit || txParams.gas,
      chainId,
    };

    if (gasPrice) {
      if (gasPrice.type === 'eip1559') {
        tx.maxFeePerGas = gasPrice.maxFeePerGas;
        tx.maxPriorityFeePerGas = gasPrice.maxPriorityFeePerGas;
      } else {
        tx.gasPrice = gasPrice.gasPrice;
      }
    }

    const result = await window.wallet.dappSendTransaction(
      tx,
      walletIndex,
      buildDappTxContext(permissionKey, txParams)
    );

    if (!result.success) {
      throw new Error(result.error || 'Transaction failed');
    }
    if (result.recorded === false) {
      console.warn('[WalletUI] dApp transaction broadcast but payment history did not record:', result.recordError);
    }

    if (autoApprove && permissionKey && selector && txParams.to) {
      await window.dappPermissions.addTransactionAutoApprove(permissionKey, txParams.to, selector, chainId);
      console.log('[WalletUI] Transaction auto-approve added:', txParams.to, selector, 'chain', chainId);
    }

    console.log('[WalletUI] dApp transaction sent:', result.hash);
    resolve(result.hash);
    // Only tear down the screen if it is still showing *this* request.
    if (dappTxPending === request) {
      closeDappTx();
    }
  } catch (err) {
    console.error('[WalletUI] dApp transaction failed:', err);
    showDappTxError(err.message || 'Transaction failed');
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = false;
      dappTxApproveBtn.textContent = 'Confirm';
    }
    setDappTxCancelEnabled(true);
  } finally {
    request.signing = false;
    endSignatureFlight(request);
  }
}

/**
 * Enable/disable the two ways out of the approval screen (Reject, Back).
 * Both are disabled while a signature is in flight.
 */
function setDappTxCancelEnabled(enabled) {
  if (dappTxRejectBtn) dappTxRejectBtn.disabled = !enabled;
  if (dappTxBackBtn) dappTxBackBtn.disabled = !enabled;
}

function rejectDappTx() {
  if (dappTxPending?.reject) {
    dappTxPending.reject({ code: 4001, message: 'User rejected the request' });
  }
}

function closeDappTx() {
  dappTxScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  dappTxPending = null;
  hideDappTxError();
  if (dappTxPasswordInput) dappTxPasswordInput.value = '';
  if (dappTxAutoApproveCheckbox) dappTxAutoApproveCheckbox.checked = false;
  if (dappTxApproveBtn) {
    dappTxApproveBtn.disabled = false;
    dappTxApproveBtn.textContent = 'Confirm';
  }
  setDappTxCancelEnabled(true);
}

function showDappTxError(message) {
  if (dappTxError) {
    dappTxError.textContent = message;
    dappTxError.classList.remove('hidden');
  }
}

function hideDappTxError() {
  dappTxError?.classList.add('hidden');
}

/**
 * Extract the 4-byte function selector from transaction data.
 * Returns null for plain ETH transfers (no data or data < 4 bytes).
 * @param {string} data - Hex-encoded transaction data (0x prefixed)
 * @returns {string|null} e.g. "0xabcd1234" or null
 */
export function extractSelector(data) {
  if (!data || typeof data !== 'string') return null;
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length < 8) return null;
  return '0x' + hex.slice(0, 8).toLowerCase();
}

export function decodeErc20Transfer(data) {
  if (!data || typeof data !== 'string') return null;
  const hex = data.toLowerCase();
  if (!hex.startsWith(ERC20_TRANSFER_SELECTOR) || hex.length < 138) return null;
  const recipientSlot = hex.slice(10, 74);
  const amountSlot = hex.slice(74, 138);
  if (!/^[0-9a-f]{64}$/.test(recipientSlot) || !/^[0-9a-f]{64}$/.test(amountSlot)) {
    return null;
  }
  return {
    toAddress: `0x${recipientSlot.slice(24)}`,
    amount: BigInt(`0x${amountSlot}`).toString(10),
  };
}

export function buildDappTxContext(origin, txParams = {}) {
  const decoded = decodeErc20Transfer(txParams.data);
  if (!decoded || !txParams.to) {
    return { origin };
  }
  return {
    origin,
    asset: String(txParams.to).toLowerCase(),
    toAddress: decoded.toAddress,
    amount: decoded.amount,
    metadata: { erc20Method: 'transfer' },
  };
}
