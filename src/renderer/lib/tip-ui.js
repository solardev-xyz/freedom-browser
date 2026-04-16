/**
 * Address Bar Tipping UI
 *
 * Shows "$1" / "$2" buttons at the end of the address bar whenever the
 * current page is a .eth domain, and initiates a one-click ETH tip to the
 * ENS `addr` record via an inline confirmation popover.
 *
 * Tips are sent on Ethereum mainnet (chainId 1) using the active wallet.
 * The USD-denominated amount is converted to ETH via a live ETH/USD price
 * from CoinGecko (cached in the main process).
 */

const ETH_MAINNET_CHAIN_ID = 1;
const MAX_FEE_BUFFER_BPS = 12000n; // 120% buffer on fee for display stability
const BPS_DIVISOR = 10000n;

// Feature flag state (mirrors sidebar enableIdentityWallet gating)
let walletFeatureEnabled = false;

// DOM refs (populated in initTipUi)
let tip1Btn = null;
let tip2Btn = null;
let panel = null;
let titleEl = null;
let closeBtn = null;

let loadingState = null;
let confirmState = null;
let sendingState = null;
let successState = null;
let errorState = null;

let recipientNameEl = null;
let recipientAddressEl = null;
let amountEl = null;
let feeEl = null;
let unlockSection = null;
let touchIdBtn = null;
let passwordLink = null;
let passwordSection = null;
let passwordInput = null;
let passwordSubmit = null;
let unlockErrorEl = null;
let confirmBtn = null;
let cancelBtn = null;
let explorerLink = null;
let successCloseBtn = null;
let errorTextEl = null;
let errorCloseBtn = null;

let panelOpen = false;
// Monotonically increasing request id so async callbacks from a previous
// opening don't clobber a fresh one.
let currentRequestId = 0;
// Details of the currently-prepared tip, populated when confirm state is
// shown. Cleared on close.
let pendingTip = null;

const electronAPI = () => window.electronAPI;

/**
 * Extract a .eth ENS name from a raw address-bar value (if any).
 *
 * Accepts:
 *  - "vitalik.eth"
 *  - "vitalik.eth/path"
 *  - "https://vitalik.eth/"
 *  - "https://vitalik.eth/path?x=1"
 *
 * Returns the lowercased ENS name, or null if the value isn't a .eth domain.
 * Subdomains are supported (e.g. "foo.vitalik.eth" -> "foo.vitalik.eth").
 */
export function extractEthNameFromAddress(value) {
  const raw = (value || '').trim();
  if (!raw) return null;

  let host = raw;

  // Strip scheme if present (http, https, ens, bzz, ipfs, ipns, etc.)
  const schemeMatch = host.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i);
  if (schemeMatch) {
    host = schemeMatch[1];
  }

  // Take everything up to the first path/query/fragment separator
  const endIdx = host.search(/[\/?#]/);
  if (endIdx >= 0) {
    host = host.slice(0, endIdx);
  }

  // Strip userinfo and port
  const atIdx = host.lastIndexOf('@');
  if (atIdx >= 0) host = host.slice(atIdx + 1);
  const colonIdx = host.indexOf(':');
  if (colonIdx >= 0) host = host.slice(0, colonIdx);

  const lower = host.toLowerCase();
  if (!lower.endsWith('.eth')) return null;

  // Require at least one character before ".eth" and valid label chars.
  // ENS labels allow a-z, 0-9, and hyphens (we're permissive here).
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/.test(lower)) return null;

  return lower;
}

function showState(name) {
  loadingState?.classList.toggle('hidden', name !== 'loading');
  confirmState?.classList.toggle('hidden', name !== 'confirm');
  sendingState?.classList.toggle('hidden', name !== 'sending');
  successState?.classList.toggle('hidden', name !== 'success');
  errorState?.classList.toggle('hidden', name !== 'error');
}

function openPanel() {
  if (!panel) return;
  panelOpen = true;
  panel.classList.remove('hidden');
}

function closePanel() {
  if (!panel) return;
  panelOpen = false;
  panel.classList.add('hidden');
  pendingTip = null;
  currentRequestId++;
  if (passwordInput) passwordInput.value = '';
  unlockErrorEl?.classList.add('hidden');
  if (confirmBtn) confirmBtn.disabled = false;
}

function formatEthForDisplay(wei) {
  // Render wei as a short ETH string with up to 6 significant fractional digits.
  if (wei === 0n) return '0 ETH';
  const integerPart = wei / 10n ** 18n;
  const fractional = wei % 10n ** 18n;
  const fracStr = fractional.toString().padStart(18, '0').slice(0, 6);
  const trimmed = fracStr.replace(/0+$/, '');
  const body = trimmed ? `${integerPart}.${trimmed}` : `${integerPart}`;
  return `${body} ETH`;
}

function formatFeeForDisplay(feeWei, usdPrice) {
  const ethStr = formatEthForDisplay(feeWei);
  if (!usdPrice) return ethStr;
  const feeEth = Number(feeWei) / 1e18;
  const feeUsd = feeEth * usdPrice;
  if (!Number.isFinite(feeUsd) || feeUsd <= 0) return ethStr;
  const usdFormatted =
    feeUsd < 0.01 ? '<$0.01' : `$${feeUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${ethStr} (~${usdFormatted})`;
}

function truncateAddress(addr) {
  if (!addr) return '';
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function usdToWei(usdAmount, ethUsdPrice) {
  // Convert USD to wei using integer math to avoid float drift.
  // wei = usd / (usd/ETH) * 1e18 = (usdAmount * 1e18) / ethUsdPrice
  // We scale price by 1e8 to keep precision without floats.
  const priceScaled = BigInt(Math.round(ethUsdPrice * 1e8));
  if (priceScaled === 0n) throw new Error('Invalid ETH/USD price');
  const usdScaled = BigInt(Math.round(usdAmount * 1e8));
  // amountWei = (usdScaled / priceScaled) * 1e18
  return (usdScaled * 10n ** 18n) / priceScaled;
}

async function prepareTip(usdAmount, ensName, requestId) {
  const api = electronAPI();
  if (!api) {
    throw new Error('Internal API unavailable');
  }

  // 1. Resolve ENS -> address
  const ensResult = await api.resolveEnsAddress(ensName);
  if (requestId !== currentRequestId) return null;
  if (!ensResult?.success || !ensResult.address) {
    const reason = ensResult?.error || ensResult?.reason || 'Could not resolve ENS address';
    throw new Error(reason);
  }
  const recipient = ensResult.address;

  // 2. Fetch ETH/USD price
  const priceResult = await api.getEthUsdPrice();
  if (requestId !== currentRequestId) return null;
  if (!priceResult?.success || typeof priceResult.price !== 'number') {
    throw new Error(priceResult?.error || 'Could not fetch ETH/USD price');
  }
  const ethUsdPrice = priceResult.price;

  // 3. Convert USD to wei
  const amountWei = usdToWei(usdAmount, ethUsdPrice);
  if (amountWei <= 0n) {
    throw new Error('Tip amount too small');
  }

  // 4. Check wallet + vault availability
  const identityStatus = await window.identity?.getStatus?.();
  if (requestId !== currentRequestId) return null;
  const fromAddress = identityStatus?.addresses?.userWallet;
  if (!fromAddress) {
    throw new Error('No wallet address available. Set up your Freedom identity first.');
  }

  // 5. Estimate gas on Ethereum mainnet
  const gasResult = await window.wallet.estimateGas({
    from: fromAddress,
    to: recipient,
    value: amountWei.toString(),
    chainId: ETH_MAINNET_CHAIN_ID,
  });
  if (requestId !== currentRequestId) return null;
  if (!gasResult?.success) {
    const msg = gasResult?.error || 'Gas estimation failed';
    if (/No RPC endpoints|No provider available/i.test(msg)) {
      throw new Error(
        'No Ethereum mainnet RPC configured. Open Settings → Wallet to add an Alchemy/Infura/DRPC key.'
      );
    }
    throw new Error(msg);
  }
  const gasLimit = gasResult.gasLimit;

  // 6. Fetch current gas prices
  const priceFeeResult = await window.wallet.getGasPrice(ETH_MAINNET_CHAIN_ID);
  if (requestId !== currentRequestId) return null;
  if (!priceFeeResult?.success) {
    throw new Error(priceFeeResult?.error || 'Failed to fetch gas price');
  }

  // 7. Estimate fee in wei for display (with small safety buffer)
  const effectiveGasPrice = BigInt(
    priceFeeResult.effectiveGasPrice || priceFeeResult.gasPrice || '0'
  );
  const gasLimitBig = BigInt(gasLimit);
  const estimatedFeeWei = (effectiveGasPrice * gasLimitBig * MAX_FEE_BUFFER_BPS) / BPS_DIVISOR;

  return {
    ensName,
    recipient,
    usdAmount,
    ethUsdPrice,
    amountWei,
    gasLimit,
    maxFeePerGas: priceFeeResult.maxFeePerGas || null,
    maxPriorityFeePerGas: priceFeeResult.maxPriorityFeePerGas || null,
    gasPrice: priceFeeResult.gasPrice || null,
    estimatedFeeWei,
    from: fromAddress,
  };
}

function populateConfirmView(tip) {
  if (recipientNameEl) recipientNameEl.textContent = tip.ensName;
  if (recipientAddressEl) {
    recipientAddressEl.textContent = truncateAddress(tip.recipient);
    recipientAddressEl.title = tip.recipient;
  }
  if (amountEl) {
    amountEl.textContent = `${formatEthForDisplay(tip.amountWei)} (~$${tip.usdAmount})`;
  }
  if (feeEl) {
    feeEl.textContent = formatFeeForDisplay(tip.estimatedFeeWei, tip.ethUsdPrice);
  }
}

async function configureUnlockUi() {
  try {
    const status = await window.identity.getStatus();
    if (status?.isUnlocked) {
      unlockSection?.classList.add('hidden');
      if (confirmBtn) confirmBtn.disabled = false;
      return;
    }

    unlockSection?.classList.remove('hidden');
    if (confirmBtn) confirmBtn.disabled = true;

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;
    const hasTouchId = canUseTouchId && touchIdEnabled;

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
    console.error('[TipUi] Failed to configure unlock UI:', err);
    touchIdBtn?.classList.add('hidden');
    passwordLink?.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
  }
}

async function handleTouchIdUnlock() {
  unlockErrorEl?.classList.add('hidden');
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      if (result.error && result.error !== 'Touch ID cancelled') {
        showUnlockError(result.error);
      }
      return;
    }
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      showUnlockError(unlockResult.error || 'Failed to unlock vault');
      return;
    }
    unlockSection?.classList.add('hidden');
    if (confirmBtn) confirmBtn.disabled = false;
  } catch (err) {
    showUnlockError(err.message || 'Touch ID failed');
  }
}

async function handlePasswordUnlock() {
  const password = passwordInput?.value;
  if (!password) {
    showUnlockError('Please enter your vault password');
    return;
  }
  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      showUnlockError(result.error || 'Incorrect password');
      return;
    }
    unlockSection?.classList.add('hidden');
    if (confirmBtn) confirmBtn.disabled = false;
  } catch (err) {
    showUnlockError(err.message || 'Failed to unlock');
  }
}

function showUnlockError(msg) {
  if (!unlockErrorEl) return;
  unlockErrorEl.textContent = msg;
  unlockErrorEl.classList.remove('hidden');
}

function showError(message) {
  if (errorTextEl) errorTextEl.textContent = message || 'Tip failed';
  showState('error');
}

async function handleConfirm() {
  if (!pendingTip) return;
  if (confirmBtn) confirmBtn.disabled = true;

  const tip = pendingTip;
  showState('sending');

  try {
    const txParams = {
      to: tip.recipient,
      value: tip.amountWei.toString(),
      gasLimit: tip.gasLimit,
      chainId: ETH_MAINNET_CHAIN_ID,
    };
    if (tip.maxFeePerGas) {
      txParams.maxFeePerGas = tip.maxFeePerGas;
      txParams.maxPriorityFeePerGas = tip.maxPriorityFeePerGas;
    } else if (tip.gasPrice) {
      txParams.gasPrice = tip.gasPrice;
    }

    const result = await window.wallet.sendTransaction(txParams);
    if (!result.success) {
      throw new Error(result.error || 'Transaction failed');
    }

    if (explorerLink) {
      if (result.explorerUrl) {
        explorerLink.href = result.explorerUrl;
        explorerLink.classList.remove('hidden');
      } else {
        explorerLink.href = '#';
        explorerLink.classList.add('hidden');
      }
    }
    showState('success');

    window.dispatchEvent(
      new CustomEvent('wallet:tx-success', { detail: { hash: result.hash } })
    );
  } catch (err) {
    console.error('[TipUi] Tip send failed:', err);
    showError(err.message || 'Transaction failed');
  }
}

async function openTip(usdAmount) {
  const addressInput = document.getElementById('address-input');
  const ensName = extractEthNameFromAddress(addressInput?.value);
  if (!ensName) return;

  const requestId = ++currentRequestId;
  pendingTip = null;
  openPanel();
  if (titleEl) titleEl.textContent = `Tip $${usdAmount} to ${ensName}`;
  showState('loading');

  try {
    const tip = await prepareTip(usdAmount, ensName, requestId);
    if (!tip || requestId !== currentRequestId) return;
    pendingTip = tip;
    populateConfirmView(tip);
    await configureUnlockUi();
    if (requestId !== currentRequestId) return;
    showState('confirm');
  } catch (err) {
    if (requestId !== currentRequestId) return;
    console.error('[TipUi] Failed to prepare tip:', err);
    showError(err.message || 'Could not prepare tip');
  }
}

/**
 * Show or hide the $1/$2 tip buttons based on whether the address bar
 * currently holds a .eth domain (and the wallet feature is enabled).
 *
 * Called from navigation.js on URL changes and from settings:updated.
 */
export function updateTipButtons() {
  if (!tip1Btn || !tip2Btn) return;

  if (!walletFeatureEnabled) {
    tip1Btn.classList.add('hidden');
    tip2Btn.classList.add('hidden');
    if (panelOpen) closePanel();
    return;
  }

  const addressInput = document.getElementById('address-input');
  const ensName = extractEthNameFromAddress(addressInput?.value);

  if (ensName) {
    tip1Btn.classList.remove('hidden');
    tip2Btn.classList.remove('hidden');
  } else {
    tip1Btn.classList.add('hidden');
    tip2Btn.classList.add('hidden');
    if (panelOpen) closePanel();
  }
}

/**
 * Initialize tip UI: wire up DOM, event handlers, and feature-flag listener.
 */
export function initTipUi() {
  tip1Btn = document.getElementById('tip-1-btn');
  tip2Btn = document.getElementById('tip-2-btn');
  panel = document.getElementById('tip-panel');
  titleEl = document.getElementById('tip-title');
  closeBtn = document.getElementById('tip-close');

  loadingState = document.getElementById('tip-loading');
  confirmState = document.getElementById('tip-confirm');
  sendingState = document.getElementById('tip-sending');
  successState = document.getElementById('tip-success');
  errorState = document.getElementById('tip-error');

  recipientNameEl = document.getElementById('tip-recipient-name');
  recipientAddressEl = document.getElementById('tip-recipient-address');
  amountEl = document.getElementById('tip-amount');
  feeEl = document.getElementById('tip-fee');
  unlockSection = document.getElementById('tip-unlock');
  touchIdBtn = document.getElementById('tip-touchid-btn');
  passwordLink = document.getElementById('tip-password-link');
  passwordSection = document.getElementById('tip-password-section');
  passwordInput = document.getElementById('tip-password-input');
  passwordSubmit = document.getElementById('tip-password-submit');
  unlockErrorEl = document.getElementById('tip-unlock-error');
  confirmBtn = document.getElementById('tip-confirm-btn');
  cancelBtn = document.getElementById('tip-cancel-btn');
  explorerLink = document.getElementById('tip-explorer-link');
  successCloseBtn = document.getElementById('tip-success-close');
  errorTextEl = document.getElementById('tip-error-text');
  errorCloseBtn = document.getElementById('tip-error-close');

  tip1Btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openTip(1);
  });
  tip2Btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openTip(2);
  });

  closeBtn?.addEventListener('click', closePanel);
  cancelBtn?.addEventListener('click', closePanel);
  successCloseBtn?.addEventListener('click', closePanel);
  errorCloseBtn?.addEventListener('click', closePanel);

  touchIdBtn?.addEventListener('click', handleTouchIdUnlock);
  passwordSubmit?.addEventListener('click', handlePasswordUnlock);
  passwordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handlePasswordUnlock();
  });
  passwordLink?.addEventListener('click', () => {
    passwordLink.classList.add('hidden');
    passwordSection?.classList.remove('hidden');
    passwordInput?.focus();
  });

  confirmBtn?.addEventListener('click', handleConfirm);

  explorerLink?.addEventListener('click', (e) => {
    e.preventDefault();
    const url = explorerLink.href;
    if (url && url !== '#' && window.electronAPI?.openUrlInNewWindow) {
      // Use the browser's external-link handler by opening in a new tab.
      window.dispatchEvent(
        new CustomEvent('open-url-new-tab', { detail: { url } })
      );
    }
    closePanel();
  });

  // Close popover when clicking outside it (but not on the tip buttons)
  document.addEventListener('click', (e) => {
    if (!panelOpen || !panel) return;
    if (panel.contains(e.target)) return;
    if (e.target === tip1Btn || tip1Btn?.contains(e.target)) return;
    if (e.target === tip2Btn || tip2Btn?.contains(e.target)) return;
    closePanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) {
      closePanel();
    }
  });

  // Track wallet-feature setting (matches sidebar gating)
  electronAPI()
    ?.getSettings?.()
    .then((settings) => {
      walletFeatureEnabled = settings?.enableIdentityWallet === true;
      updateTipButtons();
    })
    .catch(() => {
      walletFeatureEnabled = false;
      updateTipButtons();
    });

  window.addEventListener('settings:updated', (event) => {
    walletFeatureEnabled = event.detail?.enableIdentityWallet === true;
    updateTipButtons();
  });
}
