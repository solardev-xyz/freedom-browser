/**
 * Send Module
 *
 * Full send flow: input, chain/asset selectors, review, confirm.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import {
  isSignatureInFlight,
  beginSignatureFlight,
  endSignatureFlight,
} from './signature-flight.js';
import { escapeHtml, accountType, bypassUnlockGateForDevice } from './wallet-utils.js';
import { refreshBalances, getTokensWithBalance, getChainsWithBalance, sortTokens } from './balance-display.js';
import {
  getTrustStatusSentence,
  describeUnverifiedForward,
  describeUnverifiedReverse,
} from '../navigation-utils.js';
import { isEnsHost } from '../origin-utils.js';
import { createTab } from '../tabs.js';

// DOM references
let sendScreen;
let sendBackBtn;
let sendInputView;
let sendReviewView;
let sendPendingView;
let sendSuccessView;
let sendErrorView;
let sendRecipientInput;
let sendRecipientError;
// Send chain selector
let sendChainSelector;
let sendChainBtn;
let sendChainLogo;
let sendChainName;
let sendChainDropdown;
let sendChainList;
// Send asset selector
let sendAssetSelector;
let sendAssetBtn;
let sendAssetLogo;
let sendAssetName;
let sendAssetDropdown;
let sendAssetList;
let sendAmountInput;
let sendMaxBtn;
let sendBalanceHint;
let sendAmountError;
let sendContinueBtn;
let sendGeneralError;
let sendReviewTo;
let sendReviewAmount;
let sendReviewNetwork;
let sendReviewFee;
let sendReviewTotal;
let sendEditBtn;
let sendConfirmBtn;
let sendUnlockSection;
let sendTouchIdBtn;
let sendPasswordLink;
let sendPasswordSection;
let sendPasswordInput;
let sendPasswordSubmit;
let sendUnlockError;
let sendReviewError;
let sendExplorerLink;
let sendDoneBtn;
let sendErrorText;
let sendRetryBtn;

// Local state
let sendTxState = {
  selectedToken: null,
  recipient: '',
  // { name, trust } when `recipient` was resolved from ENS (or a reverse
  // lookup of a raw address succeeded), null otherwise. Bundled so that
  // clearing one half can't leak a stale other half.
  recipientResolution: null,
  amount: '',
  gasLimit: null,
  maxFeePerGas: null,
  maxPriorityFeePerGas: null,
  gasPrice: null,
  estimatedFee: null,
  chainId: null,
};

// Token identifying *this* screen's in-flight signature while
// wallet:send-transaction is awaiting the device. Identity (not a boolean)
// so a late release from a superseded send cannot free a lock it no longer
// holds — see signature-flight.js.
let sendFlight = null;

export function initSend() {
  sendScreen = document.getElementById('sidebar-send');
  sendBackBtn = document.getElementById('send-back');
  sendInputView = document.getElementById('send-input-view');
  sendReviewView = document.getElementById('send-review-view');
  sendPendingView = document.getElementById('send-pending-view');
  sendSuccessView = document.getElementById('send-success-view');
  sendErrorView = document.getElementById('send-error-view');
  sendRecipientInput = document.getElementById('send-recipient');
  sendRecipientError = document.getElementById('send-recipient-error');
  sendChainSelector = document.getElementById('send-chain-selector');
  sendChainBtn = document.getElementById('send-chain-btn');
  sendChainLogo = document.getElementById('send-chain-logo');
  sendChainName = document.getElementById('send-chain-name');
  sendChainDropdown = document.getElementById('send-chain-dropdown');
  sendChainList = document.getElementById('send-chain-list');
  sendAssetSelector = document.getElementById('send-asset-selector');
  sendAssetBtn = document.getElementById('send-asset-btn');
  sendAssetLogo = document.getElementById('send-asset-logo');
  sendAssetName = document.getElementById('send-asset-name');
  sendAssetDropdown = document.getElementById('send-asset-dropdown');
  sendAssetList = document.getElementById('send-asset-list');
  sendAmountInput = document.getElementById('send-amount');
  sendMaxBtn = document.getElementById('send-max-btn');
  sendBalanceHint = document.getElementById('send-balance-hint');
  sendAmountError = document.getElementById('send-amount-error');
  sendContinueBtn = document.getElementById('send-continue-btn');
  sendGeneralError = document.getElementById('send-general-error');
  sendReviewTo = document.getElementById('send-review-to');
  sendReviewAmount = document.getElementById('send-review-amount');
  sendReviewNetwork = document.getElementById('send-review-network');
  sendReviewFee = document.getElementById('send-review-fee-value');
  sendReviewTotal = document.getElementById('send-review-total');
  sendEditBtn = document.getElementById('send-edit-btn');
  sendConfirmBtn = document.getElementById('send-confirm-btn');
  sendUnlockSection = document.getElementById('send-unlock-section');
  sendTouchIdBtn = document.getElementById('send-touchid-btn');
  sendPasswordLink = document.getElementById('send-password-link');
  sendPasswordSection = document.getElementById('send-password-section');
  sendPasswordInput = document.getElementById('send-password-input');
  sendPasswordSubmit = document.getElementById('send-password-submit');
  sendUnlockError = document.getElementById('send-unlock-error');
  sendReviewError = document.getElementById('send-review-error');
  sendExplorerLink = document.getElementById('send-explorer-link');
  sendDoneBtn = document.getElementById('send-done-btn');
  sendErrorText = document.getElementById('send-error-text');
  sendRetryBtn = document.getElementById('send-retry-btn');

  // Register screen hider
  registerScreenHider(() => {
    // An in-flight send signature owns the sidebar: the device prompt it
    // produced cannot be recalled, so hiding "Confirm on your Ledger" here
    // would leave the user answering another surface's screen while the
    // device still shows this transaction — and the broadcast would land
    // with no visible feedback. hideAllSubscreens() already refuses while
    // a signature is in flight; this is the second line of defence for a
    // direct hider call.
    if (sendFlight) return;
    sendScreen?.classList.add('hidden');
  });

  setupSendScreen();
}

function setupSendScreen() {
  const sendBtn = document.getElementById('wallet-send-btn');
  if (sendBtn) {
    // Arrow wrapper so the click Event isn't passed as `options`.
    sendBtn.addEventListener('click', () => openSend());
  }

  if (sendBackBtn) {
    sendBackBtn.addEventListener('click', () => closeSend());
  }

  if (sendChainBtn) {
    sendChainBtn.addEventListener('click', toggleSendChainDropdown);
  }

  if (sendAssetBtn) {
    sendAssetBtn.addEventListener('click', toggleSendAssetDropdown);
  }

  document.addEventListener('click', (e) => {
    if (sendChainSelector && !sendChainSelector.contains(e.target)) {
      closeSendChainDropdown();
    }
    if (sendAssetSelector && !sendAssetSelector.contains(e.target)) {
      closeSendAssetDropdown();
    }
  });

  if (sendRecipientInput) {
    sendRecipientInput.addEventListener('input', () => {
      clearSendError('recipient');
      // Edits invalidate any previously-resolved ENS address.
      sendTxState.recipientResolution = null;
    });
  }

  if (sendAmountInput) {
    sendAmountInput.addEventListener('input', () => clearSendError('amount'));
  }

  if (sendMaxBtn) {
    sendMaxBtn.addEventListener('click', handleSendMax);
  }

  if (sendContinueBtn) {
    sendContinueBtn.addEventListener('click', handleSendContinue);
  }

  if (sendEditBtn) {
    sendEditBtn.addEventListener('click', showSendInputView);
  }

  if (sendConfirmBtn) {
    sendConfirmBtn.addEventListener('click', handleSendConfirm);
  }

  if (sendTouchIdBtn) {
    sendTouchIdBtn.addEventListener('click', handleSendTouchIdUnlock);
  }
  if (sendPasswordSubmit) {
    sendPasswordSubmit.addEventListener('click', handleSendPasswordUnlock);
  }
  if (sendPasswordInput) {
    sendPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSendPasswordUnlock();
    });
  }

  if (sendPasswordLink) {
    sendPasswordLink.addEventListener('click', () => {
      sendPasswordLink.classList.add('hidden');
      sendPasswordSection?.classList.remove('hidden');
      sendPasswordInput?.focus();
    });
  }

  if (sendDoneBtn) {
    sendDoneBtn.addEventListener('click', closeSend);
  }

  if (sendExplorerLink) {
    sendExplorerLink.addEventListener('click', (e) => {
      e.preventDefault();
      const url = sendExplorerLink.href;
      if (url && url !== '#') {
        createTab(url);
      }
    });
  }

  if (sendRetryBtn) {
    sendRetryBtn.addEventListener('click', showSendInputView);
  }
}

export function openSend(options = {}) {
  if (!walletState.fullAddresses.wallet) {
    console.error('[WalletUI] No wallet address available');
    return;
  }

  // The send screen takes over the sidebar directly (it predates
  // hideAllSubscreens), so it needs its own check: while a device
  // confirmation is live the screen that started it owns the sidebar and
  // nothing may paint over it — see signature-flight.js. Entry points are
  // page-reachable (an `ethereum:` tip link routes here via openSendFlow),
  // so this is not merely belt-and-braces.
  if (isSignatureInFlight()) {
    console.warn('[WalletUI] Send screen not opened: a signature is already in flight');
    return;
  }

  resetSendState();
  applySendOpenOptions(options);

  walletState.identityView?.classList.add('hidden');
  sendScreen?.classList.remove('hidden');

  showSendInputView();
  setTimeout(() => {
    if (options.recipient) {
      sendAmountInput?.focus();
    } else {
      sendRecipientInput?.focus();
    }
  }, 100);
}

export function closeSend() {
  // Same ownership rule as the screen hider, on the other teardown path:
  // Back, a sidebar close and the coordinator's closeAllSubscreens() all
  // land here. Resetting state under a live device prompt would strand the
  // broadcast with no UI to report into.
  if (sendFlight) {
    console.warn('[WalletUI] Send screen not closed: a signature is in flight on this transaction');
    return;
  }
  sendScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  resetSendState();
}

function resetSendState() {
  sendTxState = {
    selectedToken: null,
    recipient: '',
    recipientResolution: null,
    amount: '',
    gasLimit: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    gasPrice: null,
    estimatedFee: null,
    chainId: null,
  };

  if (sendRecipientInput) sendRecipientInput.value = '';
  if (sendAmountInput) sendAmountInput.value = '';
  if (sendPasswordInput) sendPasswordInput.value = '';

  closeSendChainDropdown();
  closeSendAssetDropdown();

  if (sendChainName) sendChainName.textContent = 'Select';
  if (sendChainLogo) sendChainLogo.src = '';
  if (sendAssetName) sendAssetName.textContent = 'Select';
  if (sendAssetLogo) sendAssetLogo.src = '';

  clearSendError('recipient');
  clearSendError('amount');
  clearSendError('general');
  clearSendError('review');
  clearSendError('unlock');

  if (sendContinueBtn) {
    sendContinueBtn.disabled = false;
    sendContinueBtn.textContent = 'Continue';
  }
}

function showSendInputView() {
  sendInputView?.classList.remove('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.add('hidden');
}

function showSendReviewView() {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.remove('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.add('hidden');
}

function showSendPendingView() {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.remove('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.add('hidden');

  // Device accounts wait on a confirmation elsewhere, not the network.
  const pendingCopy = {
    ledger: {
      title: 'Confirm on your Ledger',
      text: 'Review the transaction on your Ledger and approve it there.',
    },
    remote: {
      title: 'Confirm on your phone',
      text: 'Scan the QR code with your phone and approve the transaction there.',
    },
  }[accountType(walletState.activeWalletIndex)] || {
    title: 'Sending Transaction',
    text: 'Please wait while your transaction is being processed...',
  };
  const title = sendPendingView?.querySelector('.send-pending-title');
  const text = sendPendingView?.querySelector('.send-pending-text');
  if (title) title.textContent = pendingCopy.title;
  if (text) text.textContent = pendingCopy.text;
}

function showSendSuccessView(explorerUrl) {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.remove('hidden');
  sendErrorView?.classList.add('hidden');

  if (sendExplorerLink) {
    sendExplorerLink.href = explorerUrl || '#';
    sendExplorerLink.classList.toggle('hidden', !explorerUrl);
  }
}

function showSendErrorView(message) {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.remove('hidden');

  if (sendErrorText) {
    sendErrorText.textContent = message || 'An error occurred';
  }
}

// ============================================
// Send Chain Selector
// ============================================

function toggleSendChainDropdown() {
  if (!sendChainSelector || !sendChainDropdown) return;

  const isOpen = sendChainSelector.classList.contains('open');
  closeSendAssetDropdown();

  if (isOpen) {
    closeSendChainDropdown();
  } else {
    sendChainSelector.classList.add('open');
    sendChainDropdown.classList.remove('hidden');
    renderSendChainList();
  }
}

function closeSendChainDropdown() {
  if (sendChainSelector) sendChainSelector.classList.remove('open');
  if (sendChainDropdown) sendChainDropdown.classList.add('hidden');
}

function populateSendChainSelector() {
  // Carry over the chain the user has active on the main wallet view, even
  // if it has no balance yet — their intent beats "pick the top chain with
  // funds". selectedChainId is null only in the "All chains" view.
  const selected = walletState.selectedChainId;
  if (selected !== null && walletState.registeredChains[selected]) {
    selectSendChain(selected);
    return;
  }

  const chainsWithBalance = getChainsWithBalance();
  if (chainsWithBalance.length > 0) {
    selectSendChain(chainsWithBalance[0].chainId);
    return;
  }

  if (sendChainName) sendChainName.textContent = 'No funds';
  if (sendAssetName) sendAssetName.textContent = 'No assets';
}

function applySendOpenOptions(options = {}) {
  if (options.chainId) {
    selectSendChain(options.chainId);
  } else {
    populateSendChainSelector();
  }

  if (options.tokenKey || options.tokenSymbol) {
    const preferredToken = resolvePreferredSendToken(options);
    if (preferredToken) {
      selectSendAsset(preferredToken);
    }
  }

  if (options.recipient && sendRecipientInput) {
    sendRecipientInput.value = options.recipient;
    sendTxState.recipient = options.recipient;
  }

  if (options.amount && sendAmountInput) {
    sendAmountInput.value = options.amount;
    sendTxState.amount = options.amount;
  }
}

function resolvePreferredSendToken(options = {}) {
  const candidateTokens = sortTokens(getTokensWithBalance(options.chainId || sendTxState.chainId));

  if (options.tokenKey) {
    const byKey = candidateTokens.find((token) => token.key === options.tokenKey);
    if (byKey) return byKey;
  }

  if (options.tokenSymbol) {
    return candidateTokens.find((token) => token.symbol === options.tokenSymbol) || null;
  }

  return null;
}

function renderSendChainList() {
  if (!sendChainList) return;

  sendChainList.innerHTML = '';

  const chainsWithBalance = getChainsWithBalance();

  if (chainsWithBalance.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'send-selector-empty';
    emptyEl.textContent = 'No chains with balance';
    sendChainList.appendChild(emptyEl);
    return;
  }

  for (const chain of chainsWithBalance) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'send-selector-item';
    if (chain.chainId === sendTxState.chainId) {
      item.classList.add('active');
    }

    const logoHtml = chain.logo
      ? `<img class="send-selector-item-logo" src="assets/chains/${chain.logo}" alt="${chain.name}">`
      : '';

    item.innerHTML = `
      <div class="send-selector-item-info">
        ${logoHtml}
        <span class="send-selector-item-name">${escapeHtml(chain.name)}</span>
      </div>
      ${chain.chainId === sendTxState.chainId ? `
        <svg class="send-selector-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    item.addEventListener('click', () => selectSendChain(chain.chainId));
    sendChainList.appendChild(item);
  }
}

function selectSendChain(chainId) {
  closeSendChainDropdown();

  sendTxState.chainId = chainId;

  const chain = walletState.registeredChains[chainId];
  if (chain) {
    if (sendChainName) sendChainName.textContent = chain.name;
    if (sendChainLogo && chain.logo) {
      sendChainLogo.src = `assets/chains/${chain.logo}`;
    } else if (sendChainLogo) {
      sendChainLogo.src = '';
    }
  }

  populateSendAssetSelector(chainId);
  updateSendContinueButton();
}

// ============================================
// Send Asset Selector
// ============================================

function toggleSendAssetDropdown() {
  if (!sendAssetSelector || !sendAssetDropdown) return;

  const isOpen = sendAssetSelector.classList.contains('open');
  closeSendChainDropdown();

  if (isOpen) {
    closeSendAssetDropdown();
  } else {
    sendAssetSelector.classList.add('open');
    sendAssetDropdown.classList.remove('hidden');
    renderSendAssetList();
  }
}

function closeSendAssetDropdown() {
  if (sendAssetSelector) sendAssetSelector.classList.remove('open');
  if (sendAssetDropdown) sendAssetDropdown.classList.add('hidden');
}

function populateSendAssetSelector(chainId) {
  const tokensWithBalance = sortTokens(getTokensWithBalance(chainId));

  if (tokensWithBalance.length > 0) {
    selectSendAsset(tokensWithBalance[0]);
  } else {
    sendTxState.selectedToken = null;
    if (sendAssetName) sendAssetName.textContent = 'No assets';
    if (sendAssetLogo) sendAssetLogo.src = '';
    updateSendBalanceHint();
  }
}

function renderSendAssetList() {
  if (!sendAssetList) return;

  sendAssetList.innerHTML = '';

  const tokensWithBalance = sortTokens(getTokensWithBalance(sendTxState.chainId));

  if (tokensWithBalance.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'send-selector-empty';
    emptyEl.textContent = 'No assets with balance';
    sendAssetList.appendChild(emptyEl);
    return;
  }

  for (const token of tokensWithBalance) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'send-selector-item';
    if (sendTxState.selectedToken?.key === token.key) {
      item.classList.add('active');
    }

    const logoHtml = token.logo && token.builtin
      ? `<img class="send-selector-item-logo" src="assets/tokens/${token.logo}" alt="${token.symbol}">`
      : '';

    const balance = walletState.currentBalances[token.key];
    const balanceText = balance ? formatBalanceDisplay(balance.formatted) : '--';

    item.innerHTML = `
      <div class="send-selector-item-info">
        ${logoHtml}
        <span class="send-selector-item-name">${escapeHtml(token.symbol)}</span>
      </div>
      <span class="send-selector-item-balance">${balanceText}</span>
      ${sendTxState.selectedToken?.key === token.key ? `
        <svg class="send-selector-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    item.addEventListener('click', () => selectSendAsset(token));
    sendAssetList.appendChild(item);
  }
}

function selectSendAsset(token) {
  closeSendAssetDropdown();

  sendTxState.selectedToken = token;

  if (sendAssetName) sendAssetName.textContent = token.symbol;
  if (sendAssetLogo && token.logo && token.builtin) {
    sendAssetLogo.src = `assets/tokens/${token.logo}`;
  } else if (sendAssetLogo) {
    sendAssetLogo.src = '';
  }

  updateSendBalanceHint();
  updateSendContinueButton();
}

function updateSendBalanceHint() {
  if (!sendBalanceHint || !sendTxState.selectedToken) return;

  const tokenKey = sendTxState.selectedToken.key;
  const balance = walletState.currentBalances[tokenKey];

  if (balance && balance.formatted) {
    const displayBalance = formatBalanceDisplay(balance.formatted);
    sendBalanceHint.textContent = `Available: ${displayBalance} ${sendTxState.selectedToken.symbol}`;
  } else {
    sendBalanceHint.textContent = `Available: -- ${sendTxState.selectedToken.symbol}`;
  }
}

function formatBalanceDisplay(formatted) {
  const num = parseFloat(formatted);
  if (isNaN(num)) return '0';
  if (num === 0) return '0';
  if (num < 0.000001) return '<0.000001';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

async function handleSendMax() {
  if (!sendAmountInput || !sendTxState.selectedToken) return;

  const tokenKey = sendTxState.selectedToken.key;
  const balance = walletState.currentBalances[tokenKey];

  if (balance && balance.formatted) {
    // For ERC-20 tokens, use full balance
    if (sendTxState.selectedToken.address !== null) {
      sendAmountInput.value = balance.formatted;
      clearSendError('amount');
      updateSendContinueButton();
      return;
    }

    // For native tokens, estimate actual gas cost
    const chainId = sendTxState.selectedToken.chainId;
    const balanceWei = BigInt(balance.raw || '0');

    try {
      if (sendMaxBtn) {
        sendMaxBtn.textContent = '...';
        sendMaxBtn.disabled = true;
      }

      const gasPrices = await window.wallet.getGasPrice(chainId);
      const gasLimit = 21000n;
      const gasPrice = BigInt(gasPrices.maxFeePerGas || gasPrices.gasPrice || '0');
      const gasCost = (gasLimit * gasPrice * 110n) / 100n;
      const maxWei = balanceWei > gasCost ? balanceWei - gasCost : 0n;

      const decimals = sendTxState.selectedToken.decimals || 18;
      const maxAmount = formatWeiToDecimal(maxWei, decimals);

      sendAmountInput.value = maxAmount;
    } catch (err) {
      console.error('[WalletUI] Failed to estimate gas for MAX:', err);
      const fallbackMax = Math.max(0, parseFloat(balance.formatted) - 0.0001);
      sendAmountInput.value = fallbackMax.toString();
    } finally {
      if (sendMaxBtn) {
        sendMaxBtn.textContent = 'MAX';
        sendMaxBtn.disabled = false;
      }
    }

    clearSendError('amount');
    updateSendContinueButton();
  }
}

export function formatWeiToDecimal(wei, decimals = 18) {
  if (wei === 0n) return '0';

  const weiStr = wei.toString().padStart(decimals + 1, '0');
  const integerPart = weiStr.slice(0, -decimals) || '0';
  const fractionalPart = weiStr.slice(-decimals);

  const trimmed = fractionalPart.replace(/0+$/, '');

  if (trimmed === '') {
    return integerPart;
  }

  return `${integerPart}.${trimmed}`;
}

// Supported Ethereum names (.eth/.box ENS, .wei WNS, .gwei GNS) are resolved on mainnet;
// resolution decides whether the name actually has an addr record.
function classifyRecipient() {
  const recipient = sendRecipientInput?.value?.trim() || '';

  if (!recipient) {
    showSendError('recipient', 'Recipient address is required');
    return { ok: false };
  }

  if (isValidEthereumAddress(recipient)) {
    return { ok: true, type: 'address', value: recipient };
  }

  if (isEnsLikeName(recipient)) {
    return { ok: true, type: 'ens', value: recipient.toLowerCase() };
  }

  showSendError('recipient', 'Invalid Ethereum address or supported Ethereum name');
  return { ok: false };
}

function isValidEthereumAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isEnsLikeName(value) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]+$/i.test(value)) return false;
  return isEnsHost(value);
}

function validateAmount() {
  const amount = sendAmountInput?.value?.trim() || '';

  if (!amount) {
    showSendError('amount', 'Amount is required');
    return false;
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    showSendError('amount', 'Please enter a valid amount');
    return false;
  }

  if (sendTxState.selectedToken) {
    const tokenKey = sendTxState.selectedToken.key;
    const balance = walletState.currentBalances[tokenKey];
    if (balance && parseFloat(balance.formatted) < numAmount) {
      showSendError('amount', 'Insufficient balance');
      return false;
    }
  }

  sendTxState.amount = amount;
  return true;
}

function updateSendContinueButton() {
  // No-op: validation happens when Continue is clicked
}

function showSendError(field, message) {
  if (field === 'recipient' && sendRecipientError) {
    sendRecipientError.textContent = message;
    sendRecipientError.classList.remove('hidden');
    sendRecipientInput?.classList.add('error');
  } else if (field === 'amount' && sendAmountError) {
    sendAmountError.textContent = message;
    sendAmountError.classList.remove('hidden');
    sendAmountInput?.classList.add('error');
  } else if (field === 'general' && sendGeneralError) {
    sendGeneralError.textContent = message;
    sendGeneralError.classList.remove('hidden');
  } else if (field === 'review' && sendReviewError) {
    sendReviewError.textContent = message;
    sendReviewError.classList.remove('hidden');
  } else if (field === 'unlock' && sendUnlockError) {
    sendUnlockError.textContent = message;
    sendUnlockError.classList.remove('hidden');
  }
}

function clearSendError(field) {
  if (field === 'recipient') {
    sendRecipientError?.classList.add('hidden');
    sendRecipientInput?.classList.remove('error');
  } else if (field === 'amount') {
    sendAmountError?.classList.add('hidden');
    sendAmountInput?.classList.remove('error');
  } else if (field === 'general') {
    sendGeneralError?.classList.add('hidden');
  } else if (field === 'review') {
    sendReviewError?.classList.add('hidden');
  } else if (field === 'unlock') {
    sendUnlockError?.classList.add('hidden');
  }
}

async function handleSendContinue() {
  const recipientClass = classifyRecipient();
  if (!recipientClass.ok || !validateAmount()) {
    return;
  }

  if (sendContinueBtn) {
    sendContinueBtn.disabled = true;
    sendContinueBtn.textContent = 'Loading...';
  }

  try {
    let reverseLookup = Promise.resolve(null);
    if (recipientClass.type === 'ens') {
      if (sendContinueBtn) sendContinueBtn.textContent = 'Resolving name...';
      const resolved = await resolveRecipientEns(recipientClass.value);
      if (!resolved) return; // error already surfaced on the recipient field
      sendTxState.recipient = resolved.address;
      sendTxState.recipientResolution = { name: resolved.name, trust: resolved.trust };
    } else {
      sendTxState.recipient = recipientClass.value;
      // Best-effort reverse lookup so the review screen can show the
      // recipient's primary Ethereum name alongside the address when one is
      // verifiably set. Fire in parallel with gas estimation so it
      // doesn't add latency to the Continue → Review transition; a
      // failure here doesn't block the send.
      reverseLookup = lookupPrimaryNameForAddress(recipientClass.value);
    }

    if (sendContinueBtn) sendContinueBtn.textContent = 'Loading...';
    const [, reverseResult] = await Promise.all([estimateTransactionGas(), reverseLookup]);
    if (reverseResult && !sendTxState.recipientResolution) {
      sendTxState.recipientResolution = reverseResult;
    }
    populateSendReview();
    await configureSendUnlockUI();
    showSendReviewView();
  } catch (err) {
    console.error('[WalletUI] Failed to prepare transaction:', err);
    showSendError('general', err.message || 'Failed to estimate gas');
  } finally {
    if (sendContinueBtn) {
      sendContinueBtn.disabled = false;
      sendContinueBtn.textContent = 'Continue';
    }
  }
}

// Ask main for the primary Ethereum name set for an address. Returns one of:
//   { name, trust }                          forward-verified primary name
//   { warning: 'unverified', claimedName }   primary claim doesn't forward-verify
//   null                                     no reverse record / hard error
// Never throws — the review flow isn't blocked by a reverse-lookup failure.
async function lookupPrimaryNameForAddress(address) {
  const api = window.electronAPI;
  if (!api?.resolveEnsReverse) return null;
  try {
    const result = await api.resolveEnsReverse(address);
    if (result?.success && result.name) {
      return { name: result.name, trust: result.trust || null };
    }
    if (result?.reason === 'UNVERIFIED') {
      return { warning: 'unverified', claimedName: result.claimedName || null };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveRecipientEns(name) {
  const api = window.electronAPI;
  if (!api?.resolveEnsAddress) {
    showSendError('recipient', 'Name resolution unavailable');
    return null;
  }

  let result;
  try {
    result = await api.resolveEnsAddress(name);
  } catch (err) {
    showSendError('recipient', err.message || 'Name resolution failed');
    return null;
  }

  if (!result?.success || !result.address) {
    const message =
      result?.reason === 'NO_ADDRESS'
        ? `No address set for ${name}`
        : result?.error || 'Name resolution failed';
    showSendError('recipient', message);
    return null;
  }

  return {
    name: result.name || name,
    address: result.address,
    trust: result.trust || null,
  };
}


async function estimateTransactionGas() {
  const token = sendTxState.selectedToken;
  if (!token) throw new Error('No token selected');

  const from = walletState.fullAddresses.wallet;
  const to = sendTxState.recipient;
  const chainId = sendTxState.chainId;

  const amountResult = await window.wallet.parseAmount(sendTxState.amount, token.decimals);
  if (!amountResult.success) {
    throw new Error(amountResult.error || 'Failed to parse amount');
  }
  const amountWei = amountResult.value;

  let estimateParams = { from, chainId };

  if (token.address === null) {
    estimateParams.to = to;
    estimateParams.value = amountWei;
  } else {
    const dataResult = await window.wallet.buildErc20Data(to, amountWei);
    if (!dataResult.success) {
      throw new Error(dataResult.error || 'Failed to build transfer data');
    }
    estimateParams.to = token.address;
    estimateParams.value = '0';
    estimateParams.data = dataResult.data;
  }

  const gasResult = await window.wallet.estimateGas(estimateParams);
  if (!gasResult.success) {
    throw new Error(gasResult.error || 'Gas estimation failed');
  }
  sendTxState.gasLimit = gasResult.gasLimit;

  const priceResult = await window.wallet.getGasPrice(chainId);
  if (!priceResult.success) {
    throw new Error(priceResult.error || 'Failed to get gas price');
  }

  if (priceResult.type === 'eip1559') {
    sendTxState.maxFeePerGas = priceResult.maxFeePerGas;
    sendTxState.maxPriorityFeePerGas = priceResult.maxPriorityFeePerGas;
    sendTxState.gasPrice = null;
  } else {
    sendTxState.gasPrice = priceResult.gasPrice;
    sendTxState.maxFeePerGas = null;
    sendTxState.maxPriorityFeePerGas = null;
  }

  const effectiveGasPrice = BigInt(priceResult.effectiveGasPrice || priceResult.gasPrice || '0');
  const gasLimit = BigInt(sendTxState.gasLimit);
  const estimatedFeeWei = effectiveGasPrice * gasLimit;
  sendTxState.estimatedFee = estimatedFeeWei.toString();
}

function populateSendReview() {
  const token = sendTxState.selectedToken;
  const chain = walletState.registeredChains[sendTxState.chainId];

  if (sendReviewTo) {
    if (sendTxState.recipientResolution) {
      renderRecipientReview(sendReviewTo, sendTxState.recipient, sendTxState.recipientResolution);
    } else {
      sendReviewTo.textContent = sendTxState.recipient;
    }
  }

  if (sendReviewAmount) {
    sendReviewAmount.textContent = `${sendTxState.amount} ${token?.symbol || ''}`;
  }

  if (sendReviewNetwork) {
    sendReviewNetwork.textContent = chain?.name || `Chain ${sendTxState.chainId}`;
  }

  if (sendReviewFee && sendTxState.estimatedFee) {
    const feeInNative = parseFloat(sendTxState.estimatedFee) / 1e18;
    const nativeSymbol = chain?.nativeSymbol || 'ETH';
    sendReviewFee.textContent = `~${feeInNative.toFixed(6)} ${nativeSymbol}`;
  }

  if (sendReviewTotal) {
    if (token?.address === null) {
      const amount = parseFloat(sendTxState.amount);
      const fee = parseFloat(sendTxState.estimatedFee) / 1e18;
      sendReviewTotal.textContent = `${(amount + fee).toFixed(6)} ${token?.symbol || ''}`;
    } else {
      sendReviewTotal.textContent = `${sendTxState.amount} ${token?.symbol || ''}`;
    }
  }
}

function renderRecipientReview(container, address, resolution) {
  if (resolution.warning === 'unverified') {
    renderRecipientUnverified(container, address, resolution.claimedName);
    return;
  }

  const { name, trust } = resolution;
  const nameSpan = document.createElement('span');
  nameSpan.className = 'send-review-name';
  nameSpan.textContent = name;
  const children = [nameSpan];

  const badge = buildRecipientVerifiedBadge(trust);
  if (badge) children.push(badge);
  if (trust?.level === 'unverified') {
    children.push(buildRecipientWarning(describeUnverifiedForward(name)));
  }

  const addressSpan = document.createElement('span');
  addressSpan.className = 'send-review-recipient-address';
  addressSpan.textContent = ` (${address})`;
  children.push(addressSpan);

  container.replaceChildren(...children);
}

// Render path for the rare case where the recipient address has a primary
// Ethereum name set, but that name doesn't forward-resolve back to the address.
// The claim is untrusted, so we don't display it as text — only as a
// tooltip on the warning glyph, so a phisher can't slip a misleading
// name onto the review screen.
function renderRecipientUnverified(container, address, claimedName) {
  // Address inherits monospace + 11px from the parent .send-review-address
  // class on #send-review-to — no per-span styling needed for the bare case.
  container.replaceChildren(
    document.createTextNode(address),
    buildRecipientWarning(describeUnverifiedReverse(claimedName)),
  );
}

function buildRecipientWarning(detail) {
  const warn = document.createElement('span');
  warn.className = 'send-review-warning';
  warn.textContent = '⚠';
  warn.title = detail;
  warn.setAttribute('aria-label', detail);
  return warn;
}

// Verified checkmark for the recipient cell when trust is verifiable.
// Tooltip copy is sourced from the address-bar popover's status table
// so the two surfaces can't drift; for Colibri
// the prover host is appended as the one inline detail this surface adds.
function buildRecipientVerifiedBadge(trust) {
  if (!trust) return null;
  if (trust.level !== 'verified' && trust.level !== 'user-configured') return null;

  const isColibri = trust.level === 'verified' && trust.method === 'colibri';
  const key = isColibri ? 'verified-colibri' : trust.level;
  let title = getTrustStatusSentence(key, trust);
  if (!title) return null;
  if (isColibri && trust.prover) title += ` (${trust.prover})`;

  const badge = document.createElement('span');
  badge.className = 'send-review-verified';
  badge.textContent = '✓';
  badge.title = title;
  badge.setAttribute('aria-label', title);
  return badge;
}

async function configureSendUnlockUI() {
  try {
    if (bypassUnlockGateForDevice(walletState.activeWalletIndex, sendUnlockSection, sendConfirmBtn)) {
      return;
    }

    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      sendUnlockSection?.classList.add('hidden');
      if (sendConfirmBtn) sendConfirmBtn.disabled = false;
      return;
    }

    sendUnlockSection?.classList.remove('hidden');
    if (sendConfirmBtn) sendConfirmBtn.disabled = true;

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    const hasTouchId = canUseTouchId && touchIdEnabled;

    if (sendTouchIdBtn) {
      sendTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    if (hasTouchId && userKnowsPassword) {
      sendPasswordLink?.classList.remove('hidden');
      sendPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      sendPasswordLink?.classList.add('hidden');
      sendPasswordSection?.classList.remove('hidden');
    } else {
      sendPasswordLink?.classList.add('hidden');
      sendPasswordSection?.classList.add('hidden');
    }

    if (hasTouchId) {
      setTimeout(() => handleSendTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure send unlock UI:', err);
    sendTouchIdBtn?.classList.add('hidden');
    sendPasswordLink?.classList.add('hidden');
    sendPasswordSection?.classList.remove('hidden');
  }
}

async function handleSendTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    sendUnlockSection?.classList.add('hidden');
    if (sendConfirmBtn) sendConfirmBtn.disabled = false;
  } catch (err) {
    console.error('[WalletUI] Send Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showSendError('unlock', err.message || 'Touch ID failed');
    }
  }
}

async function handleSendPasswordUnlock() {
  const password = sendPasswordInput?.value;
  if (!password) {
    showSendError('unlock', 'Please enter your password');
    return;
  }

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    sendUnlockSection?.classList.add('hidden');
    if (sendConfirmBtn) sendConfirmBtn.disabled = false;
    clearSendError('unlock');
  } catch (err) {
    console.error('[WalletUI] Send password unlock failed:', err);
    showSendError('unlock', err.message || 'Failed to unlock');
  }
}

async function handleSendConfirm() {
  if (sendConfirmBtn) sendConfirmBtn.disabled = true;

  showSendPendingView();

  // Claim the sidebar for the whole flight: wallet:send-transaction puts a
  // prompt on the device that the renderer cannot recall, so no other
  // approval surface may repaint over "Confirm on your Ledger" or tear it
  // down. Back is the other way out of this screen and must go too — see
  // signature-flight.js.
  const flight = {};
  sendFlight = flight;
  beginSignatureFlight(flight);
  if (sendBackBtn) sendBackBtn.disabled = true;

  try {
    const token = sendTxState.selectedToken;

    const amountResult = await window.wallet.parseAmount(sendTxState.amount, token.decimals);
    if (!amountResult.success) {
      throw new Error(amountResult.error || 'Failed to parse amount');
    }

    let txParams = {
      chainId: sendTxState.chainId,
      gasLimit: sendTxState.gasLimit,
    };

    if (sendTxState.maxFeePerGas) {
      txParams.maxFeePerGas = sendTxState.maxFeePerGas;
      txParams.maxPriorityFeePerGas = sendTxState.maxPriorityFeePerGas;
    } else {
      txParams.gasPrice = sendTxState.gasPrice;
    }

    if (token.address === null) {
      txParams.to = sendTxState.recipient;
      txParams.value = amountResult.value;
    } else {
      const dataResult = await window.wallet.buildErc20Data(sendTxState.recipient, amountResult.value);
      if (!dataResult.success) {
        throw new Error(dataResult.error || 'Failed to build transfer data');
      }
      txParams.to = token.address;
      txParams.value = '0';
      txParams.data = dataResult.data;
    }

    // History captures the *user-visible* counterparty + amount: the real
    // recipient (not the ERC-20 contract address) and the atomic amount
    // (not txParams.value which is 0 for token transfers).
    const result = await window.wallet.sendTransaction(txParams, {
      asset: token.address,
      toAddress: sendTxState.recipient,
      amount: amountResult.value,
    });

    if (!result.success) {
      throw new Error(result.error || 'Transaction failed');
    }
    if (result.recorded === false) {
      console.warn('[WalletUI] Transaction broadcast but payment history did not record:', result.recordError);
    }

    console.log('[WalletUI] Transaction sent:', result.hash);
    showSendSuccessView(result.explorerUrl);

    window.dispatchEvent(new CustomEvent('wallet:tx-success', { detail: { hash: result.hash } }));
    setTimeout(() => refreshBalances(), 3000);
  } catch (err) {
    console.error('[WalletUI] Transaction failed:', err);
    showSendErrorView(err.message || 'Transaction failed');
  } finally {
    // The device prompt is answered (or the send never reached it), so the
    // sidebar is free again. Guarded on identity so a superseded flight
    // cannot release a lock a later send holds.
    if (sendFlight === flight) sendFlight = null;
    endSignatureFlight(flight);
    if (sendBackBtn) sendBackBtn.disabled = false;
  }
}

export const __test__ = {
  lookupPrimaryNameForAddress,
  renderRecipientReview,
};
