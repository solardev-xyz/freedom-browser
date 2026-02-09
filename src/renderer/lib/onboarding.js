/**
 * Onboarding Wizard
 *
 * Guides first-time users through identity creation or import.
 */

// State
let currentMnemonic = null;
let currentPassword = null;
let touchIdAvailable = false;
let isImportFlow = false; // Track if user is importing vs creating

// DOM references
let modal;
let steps = {};
let loading;
let loadingText;

/**
 * Initialize the onboarding module
 */
export function initOnboarding() {
  modal = document.getElementById('onboarding-modal');
  loading = document.getElementById('onboarding-loading');
  loadingText = document.getElementById('loading-text');

  // Cache step references
  steps = {
    welcome: modal.querySelector('[data-step="welcome"]'),
    createPassword: modal.querySelector('[data-step="create-password"]'),
    touchId: modal.querySelector('[data-step="touch-id"]'),
    backup: modal.querySelector('[data-step="backup"]'),
    import: modal.querySelector('[data-step="import"]'),
    complete: modal.querySelector('[data-step="complete"]'),
  };

  // Setup close button
  const closeBtn = document.getElementById('onboarding-close');
  closeBtn.addEventListener('click', skipOnboarding);

  // Prevent closing dialog with Escape key (user must explicitly skip or complete)
  modal.addEventListener('cancel', (e) => {
    e.preventDefault();
  });

  // Setup event listeners
  setupWelcomeStep();
  setupCreatePasswordStep();
  setupTouchIdStep();
  setupBackupStep();
  setupImportStep();
  setupCompleteStep();

  // Check Touch ID availability
  checkTouchIdAvailability();
}

/**
 * Check if Touch ID is available on this system and update UI accordingly
 */
async function checkTouchIdAvailability() {
  try {
    touchIdAvailable = await window.quickUnlock.canUseTouchId();
    console.log('[Onboarding] Touch ID available:', touchIdAvailable);
  } catch (err) {
    console.log('[Onboarding] Touch ID check failed:', err.message);
    touchIdAvailable = false;
  }

  // Update welcome screen UI based on Touch ID availability
  const quickSetupUI = document.getElementById('welcome-quick-setup');
  const standardUI = document.getElementById('welcome-standard');

  if (touchIdAvailable) {
    quickSetupUI.classList.remove('hidden');
    standardUI.classList.add('hidden');
  } else {
    quickSetupUI.classList.add('hidden');
    standardUI.classList.remove('hidden');
  }
}

/**
 * Check if onboarding is needed and show modal
 * Shows onboarding only if: no vault AND no node keys exist (true first run)
 * If user skipped before (no vault but keys exist), don't show again
 */
export async function checkAndShowOnboarding() {
  try {
    const status = await window.identity.getStatus();

    // If vault exists, user completed onboarding
    if (status.hasVault) {
      return false;
    }

    // No vault - check if any keys exist (user skipped before, or migrating from old version)
    const keysExist = status.beeInjected || status.ipfsInjected || status.radicleInjected;
    if (keysExist) {
      console.log('[Onboarding] No vault but keys exist - user previously skipped');
      return false;
    }

    // True first run - show onboarding
    showOnboarding();
    return true;
  } catch (err) {
    console.error('[Onboarding] Failed to check vault status:', err);
  }
  return false;
}

/**
 * Show the onboarding modal
 */
export function showOnboarding() {
  showStep('welcome');
  modal.showModal();
}

/**
 * Hide the onboarding modal
 */
export function hideOnboarding() {
  modal.close();
  resetState();
}

/**
 * Skip onboarding and start nodes with random keys (old behavior)
 */
async function skipOnboarding() {
  console.log('[Onboarding] User skipped - starting nodes with random keys');
  hideOnboarding();
  // Start nodes based on settings - they will auto-generate random keys
  await startNodesFromSettings();
}

/**
 * Show a specific step
 */
function showStep(stepName) {
  Object.values(steps).forEach(step => step.classList.add('hidden'));
  if (steps[stepName]) {
    steps[stepName].classList.remove('hidden');
  }

  // Show skip footer only on welcome step
  const skipFooter = document.getElementById('onboarding-skip-footer');
  if (skipFooter) {
    if (stepName === 'welcome') {
      skipFooter.classList.remove('hidden');
    } else {
      skipFooter.classList.add('hidden');
    }
  }
}

/**
 * Show loading overlay
 */
function showLoading(text = 'Setting up your identity...') {
  loadingText.textContent = text;
  loading.classList.remove('hidden');
}

/**
 * Hide loading overlay
 */
function hideLoading() {
  loading.classList.add('hidden');
}

/**
 * Reset state
 */
function resetState() {
  currentMnemonic = null;
  currentPassword = null;
  isImportFlow = false;
}

// ============================================
// Step: Welcome
// ============================================

function setupWelcomeStep() {
  // Handle all create buttons/links (there are multiple in different UIs)
  const createBtns = steps.welcome.querySelectorAll('[data-action="create"]');
  const importLinks = steps.welcome.querySelectorAll('[data-action="import"]');
  const skipLink = document.querySelector('#onboarding-skip-footer [data-action="skip"]');
  const quickSetupBtn = steps.welcome.querySelector('[data-action="quick-setup"]');

  createBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      showStep('createPassword');
      document.getElementById('create-password').focus();
    });
  });

  importLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showStep('import');
      document.getElementById('import-mnemonic').focus();
    });
  });

  skipLink.addEventListener('click', (e) => {
    e.preventDefault();
    skipOnboarding();
  });

  // Quick Setup - one tap to create identity with Touch ID
  if (quickSetupBtn) {
    quickSetupBtn.addEventListener('click', () => {
      performQuickSetup();
    });
  }
}

/**
 * Quick Setup flow - create identity with Touch ID in one step
 */
async function performQuickSetup() {
  showLoading('Setting up with Touch ID...');

  try {
    // Step 1: Prompt Touch ID first (to confirm user intent)
    const touchIdResult = await window.quickUnlock.canUseTouchId();
    if (!touchIdResult) {
      hideLoading();
      alert('Touch ID is not available');
      return;
    }

    // Step 2: Generate a random password (user never sees this)
    const randomPassword = generateRandomPassword();
    currentPassword = randomPassword;

    // Step 3: Generate mnemonic
    showLoading('Generating identity...');
    const mnemonicResult = await window.identity.generateMnemonic(256);
    if (!mnemonicResult.success) {
      hideLoading();
      alert('Failed to generate identity: ' + mnemonicResult.error);
      return;
    }
    currentMnemonic = mnemonicResult.mnemonic;

    // Step 4: Create vault with the random password (user does NOT know this password)
    showLoading('Securing your identity...');
    const vaultResult = await window.identity.importMnemonic(randomPassword, currentMnemonic, false);
    if (!vaultResult.success) {
      hideLoading();
      alert('Failed to create vault: ' + vaultResult.error);
      return;
    }

    // Step 5: Enable Touch ID (store random password in Keychain)
    showLoading('Enabling Touch ID...');
    const quickUnlockResult = await window.quickUnlock.enable(randomPassword);
    if (!quickUnlockResult.success) {
      hideLoading();
      // Touch ID failed - this is a problem since user doesn't know the password
      alert('Failed to enable Touch ID. Please try the secure setup option instead.');
      // Clean up - delete the vault since it's unusable without Touch ID
      await window.identity.deleteVault(randomPassword);
      resetState();
      return;
    }

    // Step 6: Inject identities into nodes
    // Check if nodes already have identities (user may have skipped setup initially)
    showLoading('Finalizing setup...');
    const status = await window.identity.getStatus();
    const nodesHaveIdentities = status.beeInjected || status.ipfsInjected || status.radicleInjected;

    const injectResult = await window.identity.injectAll('FreedomBrowser', nodesHaveIdentities);
    if (!injectResult.success) {
      hideLoading();
      alert('Failed to set up identity: ' + injectResult.error);
      return;
    }

    // Restart nodes that were reinjected
    if (injectResult.needsRestart && injectResult.needsRestart.length > 0) {
      showLoading('Restarting nodes with new identity...');
      await restartNodes(injectResult.needsRestart);
    }

    // Success!
    hideLoading();
    displayIdentitySummary(injectResult);
    showStep('complete');

  } catch (err) {
    hideLoading();
    console.error('[Onboarding] Quick setup failed:', err);
    alert('Setup failed: ' + err.message);
    resetState();
  }
}

/**
 * Generate a cryptographically random password
 */
function generateRandomPassword() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Restart nodes that were reinjected with new identity
 * @param {string[]} nodeNames - Array of node names to restart ('bee', 'ipfs', 'radicle')
 */
async function restartNodes(nodeNames) {
  console.log('[Onboarding] Restarting nodes:', nodeNames);

  for (const nodeName of nodeNames) {
    try {
      if (nodeName === 'bee') {
        // Check if Bee is running
        const beeStatus = await window.bee.getStatus();
        if (beeStatus.status === 'running') {
          console.log('[Onboarding] Restarting Bee node...');
          await window.bee.stop();
          await window.bee.start();
        }
      } else if (nodeName === 'ipfs') {
        // Check if IPFS is running
        const ipfsStatus = await window.ipfs.getStatus();
        if (ipfsStatus.status === 'running') {
          console.log('[Onboarding] Restarting IPFS node...');
          await window.ipfs.stop();
          await window.ipfs.start();
        }
      } else if (nodeName === 'radicle') {
        // Check if Radicle is running
        const radicleStatus = await window.radicle.getStatus();
        if (radicleStatus.status === 'running') {
          console.log('[Onboarding] Restarting Radicle node...');
          await window.radicle.stop();
          await window.radicle.start();
        }
      }
    } catch (err) {
      console.error(`[Onboarding] Failed to restart ${nodeName}:`, err);
      // Continue with other nodes even if one fails
    }
  }
}

// ============================================
// Step: Create Password
// ============================================

function setupCreatePasswordStep() {
  const passwordInput = document.getElementById('create-password');
  const confirmInput = document.getElementById('create-password-confirm');
  const confirmGroup = document.getElementById('confirm-password-group');
  const strengthMeter = document.getElementById('password-strength');
  const strengthFill = steps.createPassword.querySelector('.strength-fill');
  const strengthLabel = steps.createPassword.querySelector('.strength-label');
  const matchError = document.getElementById('password-match-error');
  const backBtn = steps.createPassword.querySelector('[data-action="back"]');
  const continueBtn = steps.createPassword.querySelector('[data-action="create-vault"]');

  let strengthAnimationTimeout = null;

  const updateStrength = () => {
    const password = passwordInput.value;
    const strength = calculatePasswordStrength(password);

    // Clear any pending animation
    if (strengthAnimationTimeout) {
      clearTimeout(strengthAnimationTimeout);
      strengthAnimationTimeout = null;
    }

    // Show strength meter only when there's input
    const wasHidden = strengthMeter.classList.contains('hidden');
    if (password.length > 0) {
      strengthMeter.classList.remove('hidden');

      // If meter just became visible, delay the bar animation
      if (wasHidden) {
        strengthFill.className = 'strength-fill'; // Reset first
        strengthAnimationTimeout = setTimeout(() => {
          strengthFill.className = 'strength-fill ' + strength.level;
        }, 50);
      } else {
        strengthFill.className = 'strength-fill ' + strength.level;
      }
    } else {
      strengthMeter.classList.add('hidden');
      strengthFill.className = 'strength-fill';
    }

    strengthLabel.textContent = strength.label;

    // Show confirm field only when password is acceptable (not weak)
    const isAcceptable = strength.level === 'medium' || strength.level === 'strong';
    if (isAcceptable) {
      confirmGroup.classList.remove('hidden');
    } else {
      confirmGroup.classList.add('hidden');
      confirmInput.value = ''; // Clear confirm when hidden
      matchError.textContent = '';
    }

    return strength;
  };

  const validateForm = () => {
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const strength = calculatePasswordStrength(password);
    const isAcceptable = strength.level === 'medium' || strength.level === 'strong';
    const isValid = isAcceptable && password === confirm;

    if (confirm && password !== confirm) {
      matchError.textContent = 'Passwords do not match';
    } else {
      matchError.textContent = '';
    }

    continueBtn.disabled = !isValid;
    return isValid;
  };

  passwordInput.addEventListener('input', () => {
    updateStrength();
    validateForm();
  });

  confirmInput.addEventListener('input', validateForm);

  backBtn.addEventListener('click', () => {
    showStep('welcome');
    passwordInput.value = '';
    confirmInput.value = '';
    confirmGroup.classList.add('hidden');
    strengthMeter.classList.add('hidden');
    strengthFill.className = 'strength-fill';
    strengthLabel.textContent = '';
  });

  continueBtn.addEventListener('click', async () => {
    if (!validateForm()) return;

    currentPassword = passwordInput.value;
    showLoading('Generating recovery phrase...');

    try {
      // Only generate mnemonic - don't save vault yet
      const result = await window.identity.generateMnemonic(256);
      if (result.success) {
        currentMnemonic = result.mnemonic;
        hideLoading();
        // Prepare the backup display (will be shown later)
        displayMnemonic(currentMnemonic);
        // Go to Touch ID step if available, otherwise straight to backup
        if (touchIdAvailable) {
          showStep('touchId');
        } else {
          showStep('backup');
        }
      } else {
        hideLoading();
        alert('Failed to generate recovery phrase: ' + result.error);
      }
    } catch (err) {
      hideLoading();
      alert('Failed to generate recovery phrase: ' + err.message);
    }
  });
}

// ============================================
// Step: Touch ID
// ============================================

function setupTouchIdStep() {
  const enableBtn = steps.touchId.querySelector('[data-action="enable-touch-id"]');
  const skipBtn = steps.touchId.querySelector('[data-action="skip-touch-id"]');

  const proceedAfterTouchId = () => {
    if (isImportFlow) {
      // Import flow: vault already saved, go to finish
      finishOnboarding();
    } else {
      // Create flow: show backup screen next
      showStep('backup');
    }
  };

  enableBtn.addEventListener('click', async () => {
    showLoading('Enabling Touch ID...');

    try {
      const result = await window.quickUnlock.enable(currentPassword);
      hideLoading();

      if (result.success) {
        console.log('[Onboarding] Touch ID enabled');
        proceedAfterTouchId();
      } else {
        // User cancelled or error - just continue without Touch ID
        console.log('[Onboarding] Touch ID not enabled:', result.error);
        alert('Could not enable Touch ID: ' + result.error);
      }
    } catch (err) {
      hideLoading();
      console.error('[Onboarding] Touch ID error:', err);
      alert('Could not enable Touch ID: ' + err.message);
    }
  });

  skipBtn.addEventListener('click', () => {
    console.log('[Onboarding] User skipped Touch ID');
    proceedAfterTouchId();
  });
}

// ============================================
// Step: Backup
// ============================================

function setupBackupStep() {
  const confirmCheckbox = document.getElementById('backup-confirmed');
  const continueBtn = steps.backup.querySelector('[data-action="continue-to-verify"]');
  const backBtn = steps.backup.querySelector('[data-action="back-to-welcome"]');
  const copyBtn = document.getElementById('copy-mnemonic');
  const toggleBtn = document.getElementById('toggle-mnemonic');
  const mnemonicDisplay = document.getElementById('mnemonic-display');

  confirmCheckbox.addEventListener('change', () => {
    continueBtn.disabled = !confirmCheckbox.checked;
  });

  backBtn.addEventListener('click', () => {
    showStep('welcome');
    resetState();
    // Reset password form values
    document.getElementById('create-password').value = '';
    document.getElementById('create-password-confirm').value = '';
    // Reset password form UI state
    document.getElementById('confirm-password-group').classList.add('hidden');
    document.getElementById('password-strength').classList.add('hidden');
    const strengthFill = steps.createPassword.querySelector('.strength-fill');
    const strengthLabel = steps.createPassword.querySelector('.strength-label');
    strengthFill.className = 'strength-fill';
    strengthLabel.textContent = '';
    // Reset backup form
    confirmCheckbox.checked = false;
    continueBtn.disabled = true;
  });

  continueBtn.addEventListener('click', () => {
    finishOnboarding();
  });

  copyBtn.addEventListener('click', async () => {
    if (currentMnemonic) {
      try {
        // Use Electron's clipboard API via preload
        await window.electronAPI.copyText(currentMnemonic);
        copyBtn.querySelector('svg').style.stroke = '#4caf50';
        setTimeout(() => {
          copyBtn.querySelector('svg').style.stroke = '';
        }, 1000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  });

  toggleBtn.addEventListener('click', () => {
    const isBlurred = mnemonicDisplay.classList.toggle('blurred');
    toggleBtn.classList.toggle('showing', !isBlurred);
    toggleBtn.querySelector('.toggle-label').textContent = isBlurred ? 'Show' : 'Hide';
  });
}

function displayMnemonic(mnemonic) {
  const display = document.getElementById('mnemonic-display');
  const words = mnemonic.split(' ');

  display.innerHTML = words.map((word, i) => `
    <div class="mnemonic-word">
      <span class="mnemonic-word-num">${i + 1}.</span>
      <span class="mnemonic-word-text">${word}</span>
    </div>
  `).join('');

  // Start blurred
  display.classList.add('blurred');
  document.getElementById('toggle-mnemonic').classList.remove('showing');
  document.getElementById('toggle-mnemonic').querySelector('.toggle-label').textContent = 'Show';
}

// ============================================
// Step: Import
// ============================================

function setupImportStep() {
  const mnemonicInput = document.getElementById('import-mnemonic');
  const passwordInput = document.getElementById('import-password');
  const confirmInput = document.getElementById('import-password-confirm');
  const hint = document.getElementById('import-mnemonic-hint');
  const strengthFill = steps.import.querySelector('.strength-fill');
  const strengthLabel = steps.import.querySelector('.strength-label');
  const matchError = document.getElementById('import-password-match-error');
  const backBtn = steps.import.querySelector('[data-action="back"]');
  const importBtn = steps.import.querySelector('[data-action="import-vault"]');

  let isMnemonicValid = false;

  const validateMnemonic = async () => {
    const mnemonic = mnemonicInput.value.trim().toLowerCase().replace(/\s+/g, ' ');
    const wordCount = mnemonic.split(' ').filter(w => w).length;

    if (wordCount === 0) {
      hint.textContent = '';
      hint.className = 'form-hint';
      isMnemonicValid = false;
    } else if (wordCount !== 12 && wordCount !== 24) {
      hint.textContent = `${wordCount} words entered. Need 12 or 24 words.`;
      hint.className = 'form-hint invalid';
      isMnemonicValid = false;
    } else {
      // Validate with backend
      const result = await window.identity.validateMnemonic(mnemonic);
      if (result.valid) {
        hint.textContent = `Valid ${wordCount}-word phrase`;
        hint.className = 'form-hint valid';
        isMnemonicValid = true;
      } else {
        hint.textContent = 'Invalid recovery phrase';
        hint.className = 'form-hint invalid';
        isMnemonicValid = false;
      }
    }

    validateForm();
  };

  const updateStrength = () => {
    const strength = calculatePasswordStrength(passwordInput.value);
    strengthFill.className = 'strength-fill ' + strength.level;
    strengthLabel.textContent = strength.label;
  };

  const validateForm = () => {
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const passwordValid = password.length >= 8 && password === confirm;

    if (confirm && password !== confirm) {
      matchError.textContent = 'Passwords do not match';
    } else {
      matchError.textContent = '';
    }

    importBtn.disabled = !isMnemonicValid || !passwordValid;
  };

  mnemonicInput.addEventListener('input', validateMnemonic);
  passwordInput.addEventListener('input', () => {
    updateStrength();
    validateForm();
  });
  confirmInput.addEventListener('input', validateForm);

  backBtn.addEventListener('click', () => {
    showStep('welcome');
    mnemonicInput.value = '';
    passwordInput.value = '';
    confirmInput.value = '';
    hint.textContent = '';
    hint.className = 'form-hint';
    strengthFill.className = 'strength-fill';
    strengthLabel.textContent = '';
    isMnemonicValid = false;
    importBtn.disabled = true;
  });

  importBtn.addEventListener('click', async () => {
    const mnemonic = mnemonicInput.value.trim().toLowerCase().replace(/\s+/g, ' ');
    const password = passwordInput.value;

    currentMnemonic = mnemonic;
    currentPassword = password;
    isImportFlow = true;

    showLoading('Importing your identity...');

    try {
      // Import flow - user provides their own password, so they know it
      const result = await window.identity.importMnemonic(password, mnemonic, true);
      if (result.success) {
        hideLoading();
        // Offer Touch ID if available, otherwise finish directly
        if (touchIdAvailable) {
          showStep('touchId');
        } else {
          finishOnboarding();
        }
      } else {
        hideLoading();
        alert('Failed to import: ' + result.error);
      }
    } catch (err) {
      hideLoading();
      alert('Failed to import: ' + err.message);
    }
  });
}

// ============================================
// Step: Complete
// ============================================

function setupCompleteStep() {
  const finishBtn = steps.complete.querySelector('[data-action="finish"]');

  finishBtn.addEventListener('click', () => {
    hideOnboarding();
    // Dispatch event so wallet-ui can update
    document.dispatchEvent(new CustomEvent('identity-ready'));
    // Start nodes based on settings
    startNodesFromSettings();
  });
}

async function finishOnboarding() {
  try {
    // Only save vault if not already saved (import flow saves it earlier)
    if (!isImportFlow) {
      showLoading('Saving your identity vault...');
      // Save the vault with the mnemonic (user knows this password)
      const vaultResult = await window.identity.importMnemonic(currentPassword, currentMnemonic, true);
      if (!vaultResult.success) {
        hideLoading();
        alert('Failed to save vault: ' + vaultResult.error);
        return;
      }
    }

    // Inject identities into nodes
    // Check if nodes already have identities (user may have skipped setup initially)
    showLoading('Setting up node identities...');
    const status = await window.identity.getStatus();
    const nodesHaveIdentities = status.beeInjected || status.ipfsInjected || status.radicleInjected;

    const result = await window.identity.injectAll('FreedomBrowser', nodesHaveIdentities);

    if (result.success) {
      // Restart nodes that were reinjected
      if (result.needsRestart && result.needsRestart.length > 0) {
        showLoading('Restarting nodes with new identity...');
        await restartNodes(result.needsRestart);
      }
      hideLoading();
      displayIdentitySummary(result);
      showStep('complete');
    } else {
      hideLoading();
      alert('Failed to inject identity: ' + result.error);
    }
  } catch (err) {
    hideLoading();
    alert('Failed to complete setup: ' + err.message);
  }
}

function displayIdentitySummary(result) {
  const walletEl = document.getElementById('identity-wallet');
  const ethEl = document.getElementById('identity-eth');
  const ipfsEl = document.getElementById('identity-ipfs');
  const radicleEl = document.getElementById('identity-radicle');

  // User Wallet (shown in full - it's the primary identity)
  if (result.userWallet?.address) {
    walletEl.textContent = result.userWallet.address;
    walletEl.title = result.userWallet.address;
  }

  // Node identities (truncated)
  if (result.bee?.address) {
    const addr = result.bee.address;
    ethEl.textContent = addr.slice(0, 10) + '...' + addr.slice(-8);
    ethEl.title = addr;
  }

  if (result.ipfs?.peerId) {
    const peerId = result.ipfs.peerId;
    ipfsEl.textContent = peerId.slice(0, 12) + '...' + peerId.slice(-8);
    ipfsEl.title = peerId;
  }

  if (result.radicle?.did) {
    const did = result.radicle.did;
    // Extract just the key part after did:key:
    const keyPart = did.replace('did:key:', '');
    radicleEl.textContent = keyPart.slice(0, 12) + '...' + keyPart.slice(-8);
    radicleEl.title = did;
  }
}

async function startNodesFromSettings() {
  try {
    const settings = await window.electronAPI.getSettings();

    if (settings.startBeeAtLaunch) {
      window.bee.start();
    }
    if (settings.startIpfsAtLaunch) {
      window.ipfs.start();
    }
    if (settings.startRadicleAtLaunch) {
      window.radicle.start();
    }
  } catch (err) {
    console.error('[Onboarding] Failed to start nodes:', err);
  }
}

// ============================================
// Utilities
// ============================================

function calculatePasswordStrength(password) {
  if (!password) {
    return { level: '', label: '' };
  }

  let score = 0;

  // Length
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;

  // Character variety
  if (/[a-z]/.test(password)) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  if (score <= 3) {
    return { level: 'weak', label: 'Too weak' };
  } else if (score <= 5) {
    return { level: 'medium', label: 'Acceptable' };
  } else {
    return { level: 'strong', label: 'Strong' };
  }
}
