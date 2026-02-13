/**
 * Send Module
 *
 * Full send flow: input, chain/asset selectors, review, confirm.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { escapeHtml, formatBalance } from './wallet-utils.js';
import { refreshBalances, getTokensWithBalance, getChainsWithBalance, sortTokens } from './balance-display.js';
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
let sendResolvedAddress;
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
let sendSuccessText;
let sendExplorerLink;
let sendDoneBtn;
let sendErrorText;
let sendRetryBtn;

// Local state
let sendTxState = {
  selectedToken: null,
  recipient: '',
  amount: '',
  gasLimit: null,
  maxFeePerGas: null,
  maxPriorityFeePerGas: null,
  gasPrice: null,
  estimatedFee: null,
  chainId: null,
};

export function initSend() {
  sendScreen = document.getElementById('sidebar-send');
  sendBackBtn = document.getElementById('send-back');
  sendInputView = document.getElementById('send-input-view');
  sendReviewView = document.getElementById('send-review-view');
  sendPendingView = document.getElementById('send-pending-view');
  sendSuccessView = document.getElementById('send-success-view');
  sendErrorView = document.getElementById('send-error-view');
  sendRecipientInput = document.getElementById('send-recipient');
  sendResolvedAddress = document.getElementById('send-resolved-address');
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
  sendSuccessText = document.getElementById('send-success-text');
  sendExplorerLink = document.getElementById('send-explorer-link');
  sendDoneBtn = document.getElementById('send-done-btn');
  sendErrorText = document.getElementById('send-error-text');
  sendRetryBtn = document.getElementById('send-retry-btn');

  // Register screen hider
  registerScreenHider(() => sendScreen?.classList.add('hidden'));

  setupSendScreen();
}

function setupSendScreen() {
  const sendBtn = document.getElementById('wallet-send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', openSend);
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
    sendRecipientInput.addEventListener('input', () => clearSendError('recipient'));
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

function openSend() {
  if (!walletState.fullAddresses.wallet) {
    console.error('[WalletUI] No wallet address available');
    return;
  }

  resetSendState();
  populateSendChainSelector();

  walletState.identityView?.classList.add('hidden');
  sendScreen?.classList.remove('hidden');

  showSendInputView();
  setTimeout(() => sendRecipientInput?.focus(), 100);
}

export function closeSend() {
  sendScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  resetSendState();
}

function resetSendState() {
  sendTxState = {
    selectedToken: null,
    recipient: '',
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

  sendResolvedAddress?.classList.add('hidden');

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
  const chainsWithBalance = getChainsWithBalance();

  if (chainsWithBalance.length > 0) {
    selectSendChain(chainsWithBalance[0].chainId);
  } else {
    if (sendChainName) sendChainName.textContent = 'No funds';
    if (sendAssetName) sendAssetName.textContent = 'No assets';
  }
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

function formatWeiToDecimal(wei, decimals = 18) {
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

function validateRecipient() {
  const recipient = sendRecipientInput?.value?.trim() || '';

  if (!recipient) {
    showSendError('recipient', 'Recipient address is required');
    return false;
  }

  if (!isValidEthereumAddress(recipient)) {
    if (recipient.endsWith('.eth')) {
      showSendError('recipient', 'ENS names not supported yet. Please enter an address.');
      return false;
    }
    showSendError('recipient', 'Invalid Ethereum address');
    return false;
  }

  sendTxState.recipient = recipient;
  return true;
}

function isValidEthereumAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
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
  if (!validateRecipient() || !validateAmount()) {
    return;
  }

  if (sendContinueBtn) {
    sendContinueBtn.disabled = true;
    sendContinueBtn.textContent = 'Loading...';
  }

  try {
    await estimateTransactionGas();
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
    sendReviewTo.textContent = sendTxState.recipient;
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

async function configureSendUnlockUI() {
  try {
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

    const result = await window.wallet.sendTransaction(txParams);

    if (!result.success) {
      throw new Error(result.error || 'Transaction failed');
    }

    console.log('[WalletUI] Transaction sent:', result.hash);
    showSendSuccessView(result.explorerUrl);

    setTimeout(() => refreshBalances(), 3000);
  } catch (err) {
    console.error('[WalletUI] Transaction failed:', err);
    showSendErrorView(err.message || 'Transaction failed');
  }
}
