/**
 * dApp Transaction Approval Module
 *
 * Transaction approval screen for dApp-initiated transactions.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel } from '../sidebar.js';

// DOM references
let dappTxScreen;
let dappTxBackBtn;
let dappTxSite;
let dappTxTo;
let dappTxValue;
let dappTxValueRow;
let dappTxData;
let dappTxDataRow;
let dappTxNetwork;
let dappTxFee;
let dappTxWarning;
let dappTxWarningText;
let dappTxUnlock;
let dappTxTouchIdBtn;
let dappTxPasswordLink;
let dappTxPasswordSection;
let dappTxPasswordInput;
let dappTxPasswordSubmit;
let dappTxUnlockError;
let dappTxError;
let dappTxRejectBtn;
let dappTxApproveBtn;

// Local state
let dappTxPending = null;

export function initDappTx() {
  dappTxScreen = document.getElementById('sidebar-dapp-tx');
  dappTxBackBtn = document.getElementById('dapp-tx-back');
  dappTxSite = document.getElementById('dapp-tx-site');
  dappTxTo = document.getElementById('dapp-tx-to');
  dappTxValue = document.getElementById('dapp-tx-value');
  dappTxValueRow = document.getElementById('dapp-tx-value-row');
  dappTxData = document.getElementById('dapp-tx-data');
  dappTxDataRow = document.getElementById('dapp-tx-data-row');
  dappTxNetwork = document.getElementById('dapp-tx-network');
  dappTxFee = document.getElementById('dapp-tx-fee');
  dappTxWarning = document.getElementById('dapp-tx-warning');
  dappTxWarningText = document.getElementById('dapp-tx-warning-text');
  dappTxUnlock = document.getElementById('dapp-tx-unlock');
  dappTxTouchIdBtn = document.getElementById('dapp-tx-touchid-btn');
  dappTxPasswordLink = document.getElementById('dapp-tx-password-link');
  dappTxPasswordSection = document.getElementById('dapp-tx-password-section');
  dappTxPasswordInput = document.getElementById('dapp-tx-password-input');
  dappTxPasswordSubmit = document.getElementById('dapp-tx-password-submit');
  dappTxUnlockError = document.getElementById('dapp-tx-unlock-error');
  dappTxError = document.getElementById('dapp-tx-error');
  dappTxRejectBtn = document.getElementById('dapp-tx-reject');
  dappTxApproveBtn = document.getElementById('dapp-tx-approve');

  // Register screen hider
  registerScreenHider(() => dappTxScreen?.classList.add('hidden'));

  setupDappTxScreen();
}

function setupDappTxScreen() {
  if (dappTxBackBtn) {
    dappTxBackBtn.addEventListener('click', () => {
      rejectDappTx();
      closeDappTx();
    });
  }

  if (dappTxRejectBtn) {
    dappTxRejectBtn.addEventListener('click', () => {
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
 */
export async function showDappTxApproval(webview, permissionKey, txParams) {
  return new Promise(async (resolve, reject) => {
    const permission = await window.dappPermissions.getPermission(permissionKey);
    if (!permission) {
      reject({ code: 4100, message: 'Unauthorized - not connected' });
      return;
    }

    dappTxPending = { permissionKey, walletIndex: permission.walletIndex, txParams, resolve, reject, webview };

    if (dappTxSite) {
      dappTxSite.textContent = permissionKey;
    }

    await populateDappTxDetails(txParams, permission.chainId || walletState.selectedChainId);
    await checkDappTxUnlockStatus();

    hideAllSubscreens();
    walletState.identityView?.classList.add('hidden');
    dappTxScreen?.classList.remove('hidden');

    openSidebarPanel();
  });
}

async function populateDappTxDetails(txParams, chainId) {
  const chainsResult = await window.chainRegistry.getChains();
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
  if (!dappTxPending) return;

  const { walletIndex, txParams, resolve, gasLimit, gasPrice, chainId } = dappTxPending;

  try {
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = true;
      dappTxApproveBtn.textContent = 'Signing...';
    }

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

    const result = await window.wallet.dappSendTransaction(tx, walletIndex);

    if (!result.success) {
      throw new Error(result.error || 'Transaction failed');
    }

    console.log('[WalletUI] dApp transaction sent:', result.hash);
    resolve(result.hash);
    closeDappTx();
  } catch (err) {
    console.error('[WalletUI] dApp transaction failed:', err);
    showDappTxError(err.message || 'Transaction failed');
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = false;
      dappTxApproveBtn.textContent = 'Confirm';
    }
  }
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
  if (dappTxApproveBtn) {
    dappTxApproveBtn.disabled = false;
    dappTxApproveBtn.textContent = 'Confirm';
  }
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
