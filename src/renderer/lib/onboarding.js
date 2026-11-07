/**
 * Onboarding Wizard
 *
 * Guides first-time users through identity creation or import.
 */

import { createOnboardingNav } from './onboarding-nav.js';
import { passphraseBackupNote, setupPassphraseFields } from './wallet/passphrase-fields.js';
import { presetWalletPath } from './wallet/wallet-path-presets.js';

// State
let currentMnemonic = null;
let currentPassword = null;
let currentPassphrase = '';
let importedWalletAddress = null; // The account added at a chosen path, if any
let touchIdAvailable = false;
let isImportFlow = false; // Track if user is importing vs creating
const formResets = [];

const IPFS_EPHEMERAL_LABEL = 'Ephemeral';
const IPFS_EPHEMERAL_TITLE =
  'freedom-ipfs uses ephemeral peer identities for read-only retrieval in this release.';

// What the navigation bar shows on each screen.
const STEP_CONFIG = {
  welcome: { close: true },
  createPassword: { title: 'Create a Password', large: true, back: 'Welcome' },
  import: { title: 'Import Recovery Phrase', large: true, back: 'Welcome' },
  passphrase: () => ({
    title: 'Passphrase',
    back: isImportFlow ? 'Import' : 'Password',
    done: true,
  }),
  path: { title: 'Derivation Path', back: 'Import', done: true },
  backup: { title: 'Back Up Your Phrase', large: true, startOver: true },
};

// DOM references
let modal;
let steps = {};
let loading;
let loadingText;
let startOverSheet;
let nav;
let passphrase;

/**
 * Initialize the onboarding module
 */
export function initOnboarding() {
  modal = document.getElementById('onboarding-modal');
  loading = document.getElementById('onboarding-loading');
  loadingText = document.getElementById('loading-text');
  startOverSheet = document.getElementById('onboarding-start-over-sheet');

  // Cache step references
  steps = {
    welcome: modal.querySelector('[data-step="welcome"]'),
    createPassword: modal.querySelector('[data-step="create-password"]'),
    touchId: modal.querySelector('[data-step="touch-id"]'),
    backup: modal.querySelector('[data-step="backup"]'),
    import: modal.querySelector('[data-step="import"]'),
    passphrase: modal.querySelector('[data-step="passphrase"]'),
    path: modal.querySelector('[data-step="derivation-path"]'),
    complete: modal.querySelector('[data-step="complete"]'),
  };

  nav = createOnboardingNav({ dialog: modal, steps, stepConfig: STEP_CONFIG });
  passphrase = setupPassphraseFields();

  setupNavigationBar();

  // Setup event listeners
  setupWelcomeStep();
  setupCreatePasswordStep();
  setupTouchIdStep();
  setupBackupStep();
  setupImportStep();
  setupCompleteStep();

  nav.reset('welcome');

  // Check Touch ID availability
  checkTouchIdAvailability();
}

function setupNavigationBar() {
  document.getElementById('onboarding-close').addEventListener('click', skipOnboarding);
  document.getElementById('onboarding-back').addEventListener('click', goBack);
  document.getElementById('onboarding-done').addEventListener('click', goBack);

  document.getElementById('onboarding-start-over').addEventListener('click', () => {
    startOverSheet.classList.remove('hidden');
  });
  document.getElementById('onboarding-start-over-cancel').addEventListener('click', () => {
    startOverSheet.classList.add('hidden');
  });
  document.getElementById('onboarding-start-over-confirm').addEventListener('click', () => {
    startOverSheet.classList.add('hidden');
    resetState();
    nav.reset('welcome');
  });

  // Escape goes back a screen, but never closes the dialog: the user has to
  // choose to skip or finish, and closing here would leave what they typed in
  // the form. This is on keydown because Chromium stops letting `cancel` be
  // prevented when Escape is pressed twice with nothing else in between, and on
  // the document because focus can fall out of the dialog when a button hides.
  modal.addEventListener('cancel', (e) => e.preventDefault());
  // While a step is running, nothing in the dialog can be pressed again, by
  // mouse or by keyboard, however focus got where it is.
  modal.addEventListener(
    'click',
    (e) => {
      if (!loading.classList.contains('hidden')) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      // Another dialog can open over this one (Create Profile, from the app menu).
      const isOurs = modal.contains(e.target) || e.target === document.body;
      if (!modal.open || !isOurs) return;
      const isBusy = !loading.classList.contains('hidden');

      if (e.key === 'Escape') {
        e.preventDefault();
        if (!startOverSheet.classList.contains('hidden')) {
          startOverSheet.classList.add('hidden');
        } else if (!isBusy && nav.canGoBack()) {
          goBack();
        }
        return;
      }

      // Enter in a field does what the screen's main button does.
      if (e.key === 'Enter' && e.target.matches('input:not([type="checkbox"], [type="radio"])')) {
        e.preventDefault();
        const primary = steps[nav.current()].querySelector('.onboarding-btn.primary');
        if (!isBusy && primary && !primary.disabled) primary.click();
      }
    },
    true
  );
}

/** One screen back. Back at the start, what was typed for that flow is dropped. */
function goBack() {
  nav.pop();
  if (nav.depth() === 1) {
    resetState();
  }
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
  document.getElementById('welcome-quick-setup').classList.toggle('hidden', !touchIdAvailable);
  document.getElementById('welcome-standard').classList.toggle('hidden', touchIdAvailable);
  document.getElementById('welcome-create-row').classList.toggle('hidden', !touchIdAvailable);
}

/**
 * Show the onboarding modal. The sidebar's "Get Started" button is the
 * only entry point — we no longer auto-show on first launch to avoid
 * forcing new users through identity setup before they can use the browser.
 */
export function showOnboarding() {
  nav.reset('welcome');
  modal.showModal();
  // Otherwise the close button takes focus, and shows a ring nobody asked for.
  modal.focus({ preventScroll: true });
}

/**
 * Hide the onboarding modal
 */
export function hideOnboarding() {
  modal.close();
  resetState();
  nav.reset('welcome');
}

/**
 * Skip onboarding and start nodes with random keys (old behavior)
 */
async function skipOnboarding() {
  console.log('[Onboarding] User skipped - starting nodes with random keys');
  hideOnboarding();
  // The user walked away from identity setup: anything waiting on it (a
  // publish setup asked for from an internal page) is dropped.
  document.dispatchEvent(new CustomEvent('onboarding-dismissed'));
  // Start nodes based on settings - they will auto-generate random keys
  await startNodesFromSettings();
}

/**
 * Show loading overlay
 */
function showLoading(text = 'Setting up your identity…') {
  loadingText.textContent = text;
  loading.classList.remove('hidden');
  setScreensInert(true);
  // Chromium takes focus off an inert button a moment later, and a key pressed
  // in between would still press it. Linux and Windows focus a clicked button.
  modal.focus({ preventScroll: true });
}

/**
 * Hide loading overlay
 */
function hideLoading() {
  loading.classList.add('hidden');
  setScreensInert(false);
}

/** Nothing under the overlay can be activated, by mouse or by keyboard. */
function setScreensInert(inert) {
  modal.querySelector('.onboarding-nav').inert = inert;
  modal.querySelector('.onboarding-panel').inert = inert;
}

/**
 * Reset state
 */
function resetState() {
  currentMnemonic = null;
  currentPassword = null;
  currentPassphrase = '';
  importedWalletAddress = null;
  isImportFlow = false;
  displayBackupPassphrase('');
  // The words, passwords and passphrase must not sit in a hidden form for the
  // rest of the session.
  formResets.forEach((reset) => reset());
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
    btn.addEventListener('click', () => {
      isImportFlow = false;
      passphrase.setMode('create');
      nav.push('createPassword');
      document.getElementById('create-password').focus({ preventScroll: true });
    });
  });

  importLinks.forEach(link => {
    link.addEventListener('click', () => {
      isImportFlow = true;
      passphrase.setMode('import');
      nav.push('import');
      document.getElementById('import-mnemonic').focus({ preventScroll: true });
    });
  });

  skipLink.addEventListener('click', skipOnboarding);

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
  showLoading('Setting up with Touch ID…');

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
    showLoading('Generating identity…');
    const mnemonicResult = await window.identity.generateMnemonic(256);
    if (!mnemonicResult.success) {
      hideLoading();
      alert('Failed to generate identity: ' + mnemonicResult.error);
      return;
    }
    currentMnemonic = mnemonicResult.mnemonic;

    // Step 4: Create vault with the random password (user does NOT know this password)
    showLoading('Securing your identity…');
    const vaultResult = await window.identity.importMnemonic(randomPassword, currentMnemonic, false);
    if (!vaultResult.success) {
      hideLoading();
      alert('Failed to create vault: ' + vaultResult.error);
      return;
    }

    // Step 5: Enable Touch ID (store random password in Keychain)
    showLoading('Enabling Touch ID…');
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
    showLoading('Finalizing setup…');
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
      showLoading('Restarting nodes with new identity…');
      await restartNodes(injectResult.needsRestart);
    }

    // Success!
    hideLoading();
    displayIdentitySummary(injectResult);
    nav.push('complete');

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
 * Restart nodes that were reinjected with new identity. Ant is never in this
 * list — its restart is owned by the identity lifecycle hook in the main
 * process (stop → wipe → reinject → start).
 * @param {string[]} nodeNames - Array of node names to restart ('ipfs', 'radicle')
 */
async function restartNodes(nodeNames) {
  console.log('[Onboarding] Restarting nodes:', nodeNames);

  for (const nodeName of nodeNames) {
    try {
      if (nodeName === 'ipfs') {
        // Check if IPFS is running
        const ipfsStatus = await window.ipfs.getStatus();
        if (ipfsStatus.status === 'running') {
          console.log('[Onboarding] Restarting IPFS node…');
          await window.ipfs.stop();
          await window.ipfs.start();
        }
      } else if (nodeName === 'radicle') {
        // Check if Radicle is running
        const radicleStatus = await window.radicle.getStatus();
        if (radicleStatus.status === 'running') {
          console.log('[Onboarding] Restarting Radicle node…');
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
  const strengthFill = steps.createPassword.querySelector('.strength-fill');
  const note = document.getElementById('create-password-note');
  const continueBtn = steps.createPassword.querySelector('[data-action="create-vault"]');

  const validateForm = () => {
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const { level } = calculatePasswordStrength(password);
    const isAcceptable = level === 'medium' || level === 'strong';
    const isValid = isAcceptable && password === confirm && passphrase.isValid();

    renderPasswordNote(strengthFill, note, password, confirm);
    continueBtn.disabled = !isValid;
    return isValid;
  };

  formResets.push(() => {
    passwordInput.value = '';
    confirmInput.value = '';
    validateForm();
  });

  passwordInput.addEventListener('input', validateForm);
  confirmInput.addEventListener('input', validateForm);
  passphrase.onChange(validateForm);

  steps.createPassword
    .querySelector('[data-action="open-passphrase"]')
    .addEventListener('click', () => nav.push('passphrase'));

  validateForm();

  continueBtn.addEventListener('click', async () => {
    if (!validateForm()) return;

    currentPassword = passwordInput.value;
    currentPassphrase = passphrase.value();
    showLoading('Generating recovery phrase…');

    try {
      // Only generate mnemonic - don't save vault yet
      const result = await window.identity.generateMnemonic(256);
      if (result.success) {
        currentMnemonic = result.mnemonic;
        hideLoading();
        // Prepare the backup display (will be shown later)
        displayMnemonic(currentMnemonic);
        displayBackupPassphrase(currentPassphrase);
        // Go to Touch ID step if available, otherwise straight to backup
        if (touchIdAvailable) {
          nav.push('touchId');
        } else {
          nav.push('backup');
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

/** The strength meter and the line under a password pair. */
function renderPasswordNote(strengthFill, note, password, confirm) {
  const { level, label } = calculatePasswordStrength(password);
  const mismatch = Boolean(confirm) && password !== confirm;
  strengthFill.className = `strength-fill ${level}`;
  note.textContent = mismatch
    ? "Passwords don't match."
    : `${label ? `${label}. ` : ''}Unlocks your wallet on this computer.`;
  note.classList.toggle('bad', mismatch);
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
      nav.push('backup');
    }
  };

  enableBtn.addEventListener('click', async () => {
    showLoading('Enabling Touch ID…');

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
  const copyBtn = document.getElementById('copy-mnemonic');
  const toggleBtn = document.getElementById('toggle-mnemonic');
  const mnemonicDisplay = document.getElementById('mnemonic-display');
  const backupPassphrase = document.getElementById('backup-passphrase');

  confirmCheckbox.addEventListener('change', () => {
    continueBtn.disabled = !confirmCheckbox.checked;
  });

  formResets.push(() => {
    mnemonicDisplay.innerHTML = '';
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
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = 'Copy Words';
        }, 1000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  });

  toggleBtn.addEventListener('click', () => {
    const isBlurred = mnemonicDisplay.classList.toggle('blurred');
    backupPassphrase.classList.toggle('blurred', isBlurred);
    toggleBtn.textContent = isBlurred ? 'Show' : 'Hide';
  });
}

function displayMnemonic(mnemonic) {
  const display = document.getElementById('mnemonic-display');
  const words = mnemonic.split(' ');

  display.innerHTML = words.map((word, i) => `
    <div class="mnemonic-word">
      <span class="mnemonic-word-num">${i + 1}</span>
      <span class="mnemonic-word-text">${word}</span>
    </div>
  `).join('');

  // Start blurred
  display.classList.add('blurred');
  document.getElementById('toggle-mnemonic').textContent = 'Show';
}

function displayBackupPassphrase(value) {
  const section = document.getElementById('backup-passphrase');
  // textContent: unlike the words, this is free text the user typed.
  document.getElementById('backup-passphrase-value').textContent = value;
  document.getElementById('backup-passphrase-note').textContent = value
    ? passphraseBackupNote(value)
    : '';
  section.classList.toggle('hidden', !value);
  section.classList.add('blurred');
  document.getElementById('backup-confirmed-label').textContent = value
    ? "I've saved my phrase and passphrase"
    : "I've saved my recovery phrase";
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
  const passwordNote = document.getElementById('import-password-note');
  const importBtn = steps.import.querySelector('[data-action="import-vault"]');
  const schemeInputs = [...steps.path.querySelectorAll('input[name="import-path-scheme"]')];
  const pathIndexRow = document.getElementById('import-path-index-row');
  const pathIndex = document.getElementById('import-path-index');
  const pathMinus = document.getElementById('import-path-minus');
  const pathPlus = document.getElementById('import-path-plus');
  const pathCustomRow = document.getElementById('import-path-custom-row');
  const pathCustom = document.getElementById('import-path-custom');
  const pathError = document.getElementById('import-path-error');
  const pathStatus = document.getElementById('import-path-status');
  const advancedError = document.getElementById('import-advanced-error');
  const importPreview = document.getElementById('import-preview');
  const passphrasePreview = document.getElementById('passphrase-preview');
  const pathPreview = document.getElementById('path-preview');

  let isMnemonicValid = false;
  // Besides the fields, Import waits for main: a path has to be checked, and a
  // passphrase's only check is the address being on screen first. A slower
  // answer must not overwrite the one for the latest input.
  let isPreviewSettled = true;
  let latestPreview = 0;
  let latestValidation = 0;

  const typedMnemonic = () => mnemonicInput.value.trim().toLowerCase().replace(/\s+/g, ' ');
  const selectedScheme = () => schemeInputs.find((input) => input.checked);

  /** The path the form asks for: null for none, '' while it isn't complete yet. */
  const selectedPath = () => {
    const { value } = selectedScheme();
    if (value === 'default') return null;
    if (value === 'custom') return pathCustom.value.trim();
    return presetWalletPath(value, pathIndex.value);
  };

  const fillPreview = (section, caption, address = '', path = '') => {
    section.querySelector('.onboarding-caption').textContent = caption;
    const [addressEl, pathEl] = section.querySelectorAll('.onboarding-address');
    addressEl.textContent = address;
    pathEl.textContent = path;
    section.classList.remove('hidden');
  };

  const setPathError = (message) => {
    pathError.textContent = message;
    advancedError.textContent = message;
    pathStatus.classList.toggle('bad', Boolean(message));
    if (message) {
      pathStatus.textContent = 'Refused';
      pathStatus.classList.remove('on');
    }
  };

  const renderPathControls = () => {
    const scheme = selectedScheme();
    const isPreset = scheme.value !== 'default' && scheme.value !== 'custom';
    pathIndexRow.classList.toggle('hidden', !isPreset);
    pathCustomRow.classList.toggle('hidden', scheme.value !== 'custom');
    pathMinus.disabled = !(Number(pathIndex.value) > 0);

    if (scheme.value === 'default') pathStatus.textContent = 'Default';
    else if (scheme.value === 'custom') pathStatus.textContent = 'Custom';
    else pathStatus.textContent = `${scheme.dataset.label}, account ${pathIndex.value}`;
    pathStatus.classList.toggle('on', scheme.value !== 'default');
  };

  const updateImportPreview = async () => {
    const request = ++latestPreview;
    const walletPath = selectedPath();
    const typedPassphrase = passphrase.value();

    renderPathControls();
    setPathError('');
    [importPreview, passphrasePreview, pathPreview].forEach((section) => {
      section.classList.add('hidden');
    });
    isPreviewSettled = walletPath === null && typedPassphrase === '';
    validateForm();

    if (walletPath === '' || !passphrase.isValid()) return;

    if (!isMnemonicValid) {
      // Creating a wallet has no words yet, and so no address to wait for.
      if (!isImportFlow) return;
      const caption = 'Enter your recovery phrase to see this address.';
      if (typedPassphrase) fillPreview(passphrasePreview, caption);
      fillPreview(pathPreview, caption);
      return;
    }

    let result;
    try {
      result = await window.identity.previewImport(typedMnemonic(), {
        passphrase: typedPassphrase,
        path: walletPath,
      });
    } catch (err) {
      result = { success: false, error: err.message };
    }
    if (request !== latestPreview) return;

    if (!result.success) {
      setPathError(result.error);
      return;
    }

    const caption = result.isMainWallet
      ? 'Your main wallet'
      : 'Added next to your main wallet, and made active';
    fillPreview(pathPreview, caption, result.address, result.path);
    if (typedPassphrase) {
      fillPreview(passphrasePreview, caption, result.address, result.path);
    }
    // The address only earns its space here once Advanced has changed it.
    if (typedPassphrase || walletPath !== null) {
      fillPreview(importPreview, caption, result.address, result.path);
    }
    isPreviewSettled = true;
    validateForm();
  };

  const validateMnemonic = async () => {
    const request = ++latestValidation;
    const mnemonic = typedMnemonic();
    const wordCount = mnemonic.split(' ').filter(w => w).length;

    // Until main answers, anything on screen describes the previous words.
    isMnemonicValid = false;
    updateImportPreview();

    if (wordCount === 0) {
      hint.textContent = '';
      hint.className = 'onboarding-group-footer';
    } else if (wordCount !== 12 && wordCount !== 24) {
      hint.textContent = `${wordCount} words entered. Need 12 or 24 words.`;
      hint.className = 'onboarding-group-footer bad';
    } else {
      // Validate with backend
      const result = await window.identity.validateMnemonic(mnemonic);
      if (request !== latestValidation) return;
      if (result.valid) {
        hint.textContent = `Valid ${wordCount}-word phrase`;
        hint.className = 'onboarding-group-footer good';
        isMnemonicValid = true;
      } else {
        hint.textContent = 'Invalid recovery phrase';
        hint.className = 'onboarding-group-footer bad';
      }
    }

    updateImportPreview();
  };

  const validateForm = () => {
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    const passwordValid = password.length >= 8 && password === confirm;

    renderPasswordNote(strengthFill, passwordNote, password, confirm);
    importBtn.disabled =
      !isMnemonicValid || !passwordValid || !passphrase.isValid() || !isPreviewSettled;
  };

  const resetForm = () => {
    mnemonicInput.value = '';
    passwordInput.value = '';
    confirmInput.value = '';
    hint.textContent = '';
    hint.className = 'onboarding-group-footer';
    latestValidation += 1;
    isMnemonicValid = false;
    passphrase.reset();
    schemeInputs.forEach((input) => {
      input.checked = input.value === 'default';
    });
    pathIndex.value = '0';
    pathCustom.value = '';
    updateImportPreview();
  };
  formResets.push(resetForm);

  const stepAccount = (delta) => {
    const index = Number(pathIndex.value);
    pathIndex.value = String(Math.max(0, (Number.isFinite(index) ? index : 0) + delta));
    updateImportPreview();
  };

  mnemonicInput.addEventListener('input', validateMnemonic);
  passwordInput.addEventListener('input', validateForm);
  confirmInput.addEventListener('input', validateForm);
  passphrase.onChange(updateImportPreview);
  schemeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      updateImportPreview();
      if (input.value === 'custom') pathCustom.focus({ preventScroll: true });
    });
  });
  pathIndex.addEventListener('input', updateImportPreview);
  pathMinus.addEventListener('click', () => stepAccount(-1));
  pathPlus.addEventListener('click', () => stepAccount(1));
  pathCustom.addEventListener('input', updateImportPreview);

  steps.import
    .querySelector('[data-action="open-passphrase"]')
    .addEventListener('click', () => nav.push('passphrase'));
  steps.import
    .querySelector('[data-action="open-path"]')
    .addEventListener('click', () => nav.push('path'));

  updateImportPreview();

  importBtn.addEventListener('click', async () => {
    const mnemonic = typedMnemonic();
    const password = passwordInput.value;

    currentMnemonic = mnemonic;
    currentPassword = password;

    showLoading('Importing your identity…');

    try {
      // Import flow - user provides their own password, so they know it
      const result = await window.identity.importMnemonic(password, mnemonic, true, {
        passphrase: passphrase.value(),
        path: selectedPath(),
      });
      if (result.success) {
        importedWalletAddress = result.wallet?.address ?? null;
        hideLoading();
        // Offer Touch ID if available, otherwise finish directly
        if (touchIdAvailable) {
          nav.push('touchId');
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
      showLoading('Saving your identity vault…');
      // Save the vault with the mnemonic (user knows this password)
      const vaultResult = await window.identity.importMnemonic(
        currentPassword,
        currentMnemonic,
        true,
        { passphrase: currentPassphrase }
      );
      if (!vaultResult.success) {
        hideLoading();
        alert('Failed to save vault: ' + vaultResult.error);
        return;
      }
    }

    // Inject identities into nodes
    // Check if nodes already have identities (user may have skipped setup initially)
    showLoading('Setting up node identities…');
    const status = await window.identity.getStatus();
    const nodesHaveIdentities = status.beeInjected || status.ipfsInjected || status.radicleInjected;

    const result = await window.identity.injectAll('FreedomBrowser', nodesHaveIdentities);

    if (result.success) {
      // Restart nodes that were reinjected
      if (result.needsRestart && result.needsRestart.length > 0) {
        showLoading('Restarting nodes with new identity…');
        await restartNodes(result.needsRestart);
      }
      hideLoading();
      displayIdentitySummary(result);
      nav.push('complete');
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

  // User Wallet (shown in full - it's the primary identity). An account the
  // user imported at a chosen path is the one they recognise, and it's active.
  const walletAddress = importedWalletAddress ?? result.userWallet?.address;
  if (walletAddress) {
    walletEl.textContent = walletAddress;
    walletEl.title = walletAddress;
  }

  // Node identities (truncated)
  if (result.bee?.address) {
    const addr = result.bee.address;
    ethEl.textContent = addr.slice(0, 10) + '…' + addr.slice(-8);
    ethEl.title = addr;
  }

  if (result.ipfs?.peerId) {
    const peerId = result.ipfs.peerId;
    ipfsEl.textContent = peerId.slice(0, 12) + '…' + peerId.slice(-8);
    ipfsEl.title = peerId;
  } else if (result.ipfs?.mode === 'ephemeral' || result.ipfs?.stableIdentitySupported === false) {
    ipfsEl.textContent = IPFS_EPHEMERAL_LABEL;
    ipfsEl.title = IPFS_EPHEMERAL_TITLE;
  } else {
    ipfsEl.textContent = '--';
    ipfsEl.title = '';
  }

  if (result.radicle?.did) {
    const did = result.radicle.did;
    // Extract just the key part after did:key:
    const keyPart = did.replace('did:key:', '');
    radicleEl.textContent = keyPart.slice(0, 12) + '…' + keyPart.slice(-8);
    radicleEl.title = did;
  }
}

async function startNodesFromSettings() {
  try {
    const settings = await window.electronAPI.getSettings();

    if (settings.startAntAtLaunch) {
      window.ant.start();
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
