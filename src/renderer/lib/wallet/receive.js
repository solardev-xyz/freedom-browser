/**
 * Receive Module
 *
 * QR code display, copy address.
 */

import { walletState, registerScreenHider } from './wallet-state.js';

// DOM references
let receiveScreen;
let receiveBackBtn;
let receiveQrImage;
let receiveAddress;
let receiveCopyBtn;

export function initReceive() {
  receiveScreen = document.getElementById('sidebar-receive');
  receiveBackBtn = document.getElementById('receive-back');
  receiveQrImage = document.getElementById('receive-qr-image');
  receiveAddress = document.getElementById('receive-address');
  receiveCopyBtn = document.getElementById('receive-copy-btn');

  // Register screen hider
  registerScreenHider(() => receiveScreen?.classList.add('hidden'));

  setupReceiveScreen();
}

function setupReceiveScreen() {
  if (receiveBackBtn) {
    receiveBackBtn.addEventListener('click', closeReceive);
  }

  if (receiveCopyBtn) {
    receiveCopyBtn.addEventListener('click', handleReceiveCopyAddress);
  }

  const receiveBtn = document.getElementById('wallet-receive-btn');
  if (receiveBtn) {
    receiveBtn.addEventListener('click', openReceive);
  }
}

async function openReceive() {
  if (!walletState.fullAddresses.wallet) {
    console.error('[WalletUI] No wallet address available');
    return;
  }

  walletState.identityView?.classList.add('hidden');
  receiveScreen?.classList.remove('hidden');

  if (receiveAddress) {
    receiveAddress.textContent = walletState.fullAddresses.wallet;
  }

  // Detect theme
  const isLightMode = document.documentElement.getAttribute('data-theme') === 'light';

  const toolbarColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--toolbar').trim() || '#3c3c3c';

  const qrColors = isLightMode
    ? { dark: '#000000', light: '#ffffff' }
    : { dark: '#ffffff', light: toolbarColor };

  try {
    const result = await window.wallet.generateQR(walletState.fullAddresses.wallet, {
      width: 200,
      margin: 2,
      dark: qrColors.dark,
      light: qrColors.light,
      errorCorrectionLevel: 'M',
    });

    if (result.success && receiveQrImage) {
      receiveQrImage.src = result.dataUrl;
      receiveQrImage.alt = `QR Code for ${walletState.fullAddresses.wallet}`;
    } else {
      console.error('[WalletUI] Failed to generate QR code:', result.error);
    }
  } catch (err) {
    console.error('[WalletUI] QR generation error:', err);
  }
}

export function closeReceive() {
  receiveScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');

  if (receiveCopyBtn) {
    receiveCopyBtn.classList.remove('copied');
    const span = receiveCopyBtn.querySelector('span');
    if (span) span.textContent = 'Copy Address';
  }
}

async function handleReceiveCopyAddress() {
  if (!walletState.fullAddresses.wallet) return;

  try {
    await window.electronAPI.copyText(walletState.fullAddresses.wallet);

    if (receiveCopyBtn) {
      receiveCopyBtn.classList.add('copied');
      const span = receiveCopyBtn.querySelector('span');
      if (span) span.textContent = 'Copied!';

      setTimeout(() => {
        receiveCopyBtn.classList.remove('copied');
        if (span) span.textContent = 'Copy Address';
      }, 2000);
    }
  } catch (err) {
    console.error('[WalletUI] Copy address failed:', err);
  }
}
