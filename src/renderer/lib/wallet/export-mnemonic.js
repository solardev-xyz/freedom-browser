/**
 * Export Mnemonic Module
 *
 * Mnemonic export with unlock flow.
 */

import { walletState, registerScreenHider } from './wallet-state.js';

// DOM references
let exportMnemonicScreen;
let exportUnlockRequired;
let exportMnemonicDisplay;
let exportTouchIdBtn;
let exportPasswordSection;

// Callback for switching tabs (set by coordinator)
let switchTabFn = null;

// Local state
let exportMnemonicPassword = null;

export function initExportMnemonic(switchTab) {
  switchTabFn = switchTab;
  exportMnemonicScreen = document.getElementById('sidebar-export-mnemonic');
  exportUnlockRequired = document.getElementById('export-unlock-required');
  exportMnemonicDisplay = document.getElementById('export-mnemonic-display');
  exportTouchIdBtn = document.getElementById('export-touchid-btn');
  exportPasswordSection = document.getElementById('export-password-section');

  // Register screen hider
  registerScreenHider(() => exportMnemonicScreen?.classList.add('hidden'));

  setupExportMnemonicListeners();
}

function setupExportMnemonicListeners() {
  const exportMnemonicBtn = document.getElementById('sidebar-export-mnemonic-btn');
  if (exportMnemonicBtn) {
    exportMnemonicBtn.addEventListener('click', openExportMnemonic);
  }

  const exportBackBtn = document.getElementById('export-mnemonic-back');
  if (exportBackBtn) {
    exportBackBtn.addEventListener('click', async () => {
      await closeExportMnemonic();
      if (switchTabFn) switchTabFn('settings');
    });
  }

  if (exportTouchIdBtn) {
    exportTouchIdBtn.addEventListener('click', handleExportTouchIdUnlock);
  }

  const exportPasswordSubmit = document.getElementById('export-password-submit');
  if (exportPasswordSubmit) {
    exportPasswordSubmit.addEventListener('click', handleExportPasswordUnlock);
  }

  const exportPasswordInput = document.getElementById('export-password-input');
  if (exportPasswordInput) {
    exportPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleExportPasswordUnlock();
    });
  }

  const copyMnemonicBtn = document.getElementById('copy-mnemonic-btn');
  if (copyMnemonicBtn) {
    copyMnemonicBtn.addEventListener('click', copyMnemonicToClipboard);
  }
}

async function openExportMnemonic() {
  walletState.identityView?.classList.add('hidden');
  exportMnemonicScreen?.classList.remove('hidden');

  await configureUnlockUI();
  showExportView('unlock');
}

export async function closeExportMnemonic() {
  // Guard: skip vault lock and cleanup if screen is already hidden
  if (!exportMnemonicScreen || exportMnemonicScreen.classList.contains('hidden')) return;

  const wordsContainer = document.getElementById('mnemonic-words');
  if (wordsContainer) {
    wordsContainer.innerHTML = '';
  }

  exportMnemonicPassword = null;
  const passwordInput = document.getElementById('export-password-input');
  if (passwordInput) {
    passwordInput.value = '';
  }

  const errorEl = document.getElementById('export-unlock-error');
  if (errorEl) {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }

  const copyBtn = document.getElementById('copy-mnemonic-btn');
  if (copyBtn) {
    copyBtn.classList.remove('copied');
  }

  try {
    await window.identity.lock();
    console.log('[WalletUI] Vault locked after export');
  } catch (err) {
    console.error('[WalletUI] Failed to lock vault:', err);
  }

  exportMnemonicScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

async function configureUnlockUI() {
  try {
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    if (exportTouchIdBtn) {
      if (canUseTouchId && touchIdEnabled) {
        exportTouchIdBtn.classList.remove('hidden');
      } else {
        exportTouchIdBtn.classList.add('hidden');
      }
    }

    if (exportPasswordSection) {
      if (userKnowsPassword) {
        exportPasswordSection.classList.remove('hidden');
      } else {
        exportPasswordSection.classList.add('hidden');
      }
    }

    if (canUseTouchId && touchIdEnabled) {
      setTimeout(() => handleExportTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure unlock UI:', err);
  }
}

function showExportView(view) {
  if (view === 'unlock') {
    exportUnlockRequired?.classList.remove('hidden');
    exportMnemonicDisplay?.classList.add('hidden');
  } else {
    exportUnlockRequired?.classList.add('hidden');
    exportMnemonicDisplay?.classList.remove('hidden');
  }
}

async function handleExportTouchIdUnlock() {
  const errorEl = document.getElementById('export-unlock-error');

  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    const password = result.password;
    const unlockResult = await window.identity.unlock(password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    await showMnemonicWords(password);
  } catch (err) {
    console.error('[WalletUI] Touch ID unlock failed:', err);
    if (errorEl && err.message !== 'Touch ID cancelled') {
      errorEl.textContent = err.message || 'Touch ID failed';
      errorEl.classList.remove('hidden');
    }
  }
}

async function handleExportPasswordUnlock() {
  const passwordInput = document.getElementById('export-password-input');
  const errorEl = document.getElementById('export-unlock-error');
  const password = passwordInput?.value;

  if (!password) {
    if (errorEl) {
      errorEl.textContent = 'Please enter your password';
      errorEl.classList.remove('hidden');
    }
    return;
  }

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    await showMnemonicWords(password);
  } catch (err) {
    console.error('[WalletUI] Password unlock failed:', err);
    if (errorEl) {
      errorEl.textContent = err.message || 'Failed to unlock';
      errorEl.classList.remove('hidden');
    }
  }
}

async function showMnemonicWords(password) {
  try {
    if (password) exportMnemonicPassword = password;
    const result = await window.identity.exportMnemonic(exportMnemonicPassword);
    if (!result.success) {
      throw new Error(result.error || 'Failed to export mnemonic');
    }

    const words = result.mnemonic.split(' ');
    const container = document.getElementById('mnemonic-words');
    if (!container) return;

    container.innerHTML = '';
    words.forEach((word, index) => {
      const wordEl = document.createElement('div');
      wordEl.className = 'mnemonic-word';
      wordEl.innerHTML = `
        <span class="mnemonic-word-num">${index + 1}</span>
        <span class="mnemonic-word-text">${word}</span>
      `;
      container.appendChild(wordEl);
    });

    showExportView('mnemonic');
  } catch (err) {
    console.error('[WalletUI] Failed to show mnemonic:', err);
    const errorEl = document.getElementById('export-unlock-error');
    if (errorEl) {
      errorEl.textContent = err.message || 'Failed to export';
      errorEl.classList.remove('hidden');
    }
  }
}

async function copyMnemonicToClipboard() {
  try {
    const result = await window.identity.exportMnemonic(exportMnemonicPassword);
    if (!result.success) {
      throw new Error(result.error);
    }

    await window.electronAPI.copyText(result.mnemonic);

    const btn = document.getElementById('copy-mnemonic-btn');
    if (btn) {
      btn.classList.add('copied');
      const span = btn.querySelector('span');
      const originalText = span?.textContent;
      if (span) span.textContent = 'Copied!';

      setTimeout(() => {
        btn.classList.remove('copied');
        if (span && originalText) span.textContent = originalText;
      }, 2000);
    }
  } catch (err) {
    console.error('[WalletUI] Copy mnemonic failed:', err);
  }
}
