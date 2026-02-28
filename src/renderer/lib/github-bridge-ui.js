import { state } from './state.js';

// DOM references
let bridgeBtn = null;
let panel = null;
let closeBtn = null;
let importBtn = null;
let browseBtn = null;
let retryBtn = null;
let copyBtn = null;
let repoNameEl = null;
let ridEl = null;
let errorDetailEl = null;
let prereqTextEl = null;

// State sections
let prereqErrorState = null;
let readyState = null;
let importingState = null;
let successState = null;
let errorState = null;

// Callbacks
let onOpenRadicleUrl = null;
let progressCleanup = null;

// Panel state
let panelOpen = false;
let currentUrl = '';
let lastRid = '';

/**
 * Check if a URL matches a GitHub repository page.
 * Matches: https://github.com/owner/repo and subpaths.
 * Does NOT match: https://github.com/owner (user/org page only).
 */
function isGitHubRepoUrl(url) {
  return /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(url);
}

/**
 * Extract owner/repo from a GitHub URL.
 */
function parseGitHubUrl(url) {
  const match = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/
  );
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * Show a specific panel state, hide all others.
 */
function showState(stateName) {
  prereqErrorState?.classList.toggle('hidden', stateName !== 'prereq-error');
  readyState?.classList.toggle('hidden', stateName !== 'ready');
  importingState?.classList.toggle('hidden', stateName !== 'importing');
  successState?.classList.toggle('hidden', stateName !== 'success');
  errorState?.classList.toggle('hidden', stateName !== 'error');
}

/**
 * Reset all step indicators to pending.
 */
function resetSteps() {
  const steps = panel?.querySelectorAll('.ghb-step');
  steps?.forEach((step) => {
    step.classList.remove('active', 'done', 'error');
  });
}

/**
 * Update step indicators based on progress event.
 */
function updateStepProgress(stepName) {
  const stepOrder = ['cloning', 'initializing', 'pushing'];
  const currentIdx = stepOrder.indexOf(stepName);
  if (currentIdx === -1) return;

  const steps = panel?.querySelectorAll('.ghb-step');
  steps?.forEach((step) => {
    const name = step.dataset.step;
    const idx = stepOrder.indexOf(name);
    step.classList.remove('active', 'done', 'error');
    if (idx < currentIdx) {
      step.classList.add('done');
    } else if (idx === currentIdx) {
      step.classList.add('active');
    }
  });
}

/**
 * Mark a step as failed.
 */
function markStepError(stepName) {
  const step = panel?.querySelector(`.ghb-step[data-step="${stepName}"]`);
  if (step) {
    step.classList.remove('active');
    step.classList.add('error');
  }
}

/**
 * Mark all steps as done (on success).
 */
function markAllStepsDone() {
  const steps = panel?.querySelectorAll('.ghb-step');
  steps?.forEach((step) => {
    step.classList.remove('active', 'error');
    step.classList.add('done');
  });
}

/**
 * Open the panel and check prerequisites.
 */
async function openPanel() {
  if (!panel) return;

  panelOpen = true;
  panel.classList.remove('hidden');
  resetSteps();

  // Check prerequisites
  const radicleStatus = state.currentRadicleStatus;
  if (radicleStatus !== 'running') {
    showState('prereq-error');
    if (prereqTextEl) {
      prereqTextEl.textContent = 'Radicle node is not running. Enable it from the Nodes menu in the toolbar.';
    }
    return;
  }

  // Check git availability
  try {
    const gitCheck = await window.githubBridge.checkGit();
    if (!gitCheck.available) {
      showState('prereq-error');
      if (prereqTextEl) {
        prereqTextEl.textContent = 'Git is not installed or not found in PATH. Please install Git to use this feature.';
      }
      return;
    }
  } catch {
    showState('prereq-error');
    if (prereqTextEl) {
      prereqTextEl.textContent = 'Could not verify Git availability.';
    }
    return;
  }

  // Parse repo info from current URL
  const parsed = parseGitHubUrl(currentUrl);
  if (parsed && repoNameEl) {
    repoNameEl.textContent = `${parsed.owner}/${parsed.repo}`;
  }

  showState('ready');
}

/**
 * Close the panel.
 */
function closePanel() {
  if (!panel) return;
  panelOpen = false;
  panel.classList.add('hidden');
}

/**
 * Start the import process.
 */
async function startImport() {
  showState('importing');
  resetSteps();

  // Listen for progress events
  if (progressCleanup) {
    progressCleanup();
    progressCleanup = null;
  }

  progressCleanup = window.githubBridge.onProgress((data) => {
    if (!data || !data.step) return;

    switch (data.step) {
      case 'cloning':
      case 'initializing':
      case 'pushing':
        updateStepProgress(data.step);
        break;
      case 'success':
        markAllStepsDone();
        break;
      case 'error':
        // Error handled in the import result below
        break;
    }
  });

  try {
    const result = await window.githubBridge.import(currentUrl);

    if (progressCleanup) {
      progressCleanup();
      progressCleanup = null;
    }

    if (result.success) {
      markAllStepsDone();
      lastRid = result.rid || '';
      if (ridEl) {
        ridEl.textContent = lastRid ? `rad:${lastRid}` : 'Unknown RID';
      }
      showState('success');
    } else {
      // Determine which step failed based on the error
      const failedStep = result.step || detectFailedStep(result.error);
      if (failedStep) {
        markStepError(failedStep);
      }
      if (errorDetailEl) {
        errorDetailEl.textContent = result.error || 'Unknown error';
      }
      showState('error');
    }
  } catch (err) {
    if (progressCleanup) {
      progressCleanup();
      progressCleanup = null;
    }
    if (errorDetailEl) {
      errorDetailEl.textContent = err.message || 'Unknown error';
    }
    showState('error');
  }
}

/**
 * Try to detect which step failed from the error message.
 */
function detectFailedStep(errorMsg) {
  if (!errorMsg) return null;
  const lower = errorMsg.toLowerCase();
  if (lower.includes('clone') || lower.includes('repository not found')) return 'cloning';
  if (lower.includes('init') || lower.includes('rad init')) return 'initializing';
  if (lower.includes('push') || lower.includes('remote')) return 'pushing';
  return 'cloning'; // default to first step
}

/**
 * Update bridge icon visibility based on current address bar URL.
 * Called from navigation.js whenever the URL changes.
 */
export function updateGithubBridgeIcon() {
  if (!bridgeBtn) return;

  const addressInput = document.getElementById('address-input');
  const url = addressInput?.value || '';

  if (isGitHubRepoUrl(url)) {
    currentUrl = url;
    bridgeBtn.classList.remove('hidden');
  } else {
    bridgeBtn.classList.add('hidden');
    // Close panel if URL changes away from GitHub
    if (panelOpen) {
      closePanel();
    }
  }
}

/**
 * Set callback for navigating to a rad:// URL.
 */
export function setOnOpenRadicleUrl(callback) {
  onOpenRadicleUrl = callback;
}

/**
 * Initialize the GitHub bridge UI.
 */
export function initGithubBridgeUi() {
  bridgeBtn = document.getElementById('github-bridge-btn');
  panel = document.getElementById('github-bridge-panel');
  closeBtn = document.getElementById('ghb-close');
  importBtn = document.getElementById('ghb-import-btn');
  browseBtn = document.getElementById('ghb-browse-btn');
  retryBtn = document.getElementById('ghb-retry-btn');
  copyBtn = document.getElementById('ghb-copy-rid');
  repoNameEl = document.getElementById('ghb-repo-name');
  ridEl = document.getElementById('ghb-rid');
  errorDetailEl = document.getElementById('ghb-error-detail');
  prereqTextEl = document.getElementById('ghb-prereq-text');

  // State sections
  prereqErrorState = document.getElementById('ghb-prereq-error');
  readyState = document.getElementById('ghb-ready');
  importingState = document.getElementById('ghb-importing');
  successState = document.getElementById('ghb-success');
  errorState = document.getElementById('ghb-error');

  // Bridge icon click — toggle panel
  bridgeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panelOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  // Close button
  closeBtn?.addEventListener('click', () => closePanel());

  // Import button
  importBtn?.addEventListener('click', () => startImport());

  // Browse button (success state)
  browseBtn?.addEventListener('click', () => {
    if (lastRid && onOpenRadicleUrl) {
      closePanel();
      onOpenRadicleUrl(`rad://${lastRid}`);
    }
  });

  // Retry button (error state)
  retryBtn?.addEventListener('click', () => {
    showState('ready');
    resetSteps();
  });

  // Copy RID button
  copyBtn?.addEventListener('click', () => {
    if (lastRid) {
      navigator.clipboard.writeText(`rad:${lastRid}`).catch(() => {
        // Fallback: try the electronAPI method
        window.electronAPI?.copyText?.(`rad:${lastRid}`);
      });
      // Brief visual feedback
      copyBtn.style.color = 'var(--text)';
      setTimeout(() => { copyBtn.style.color = ''; }, 1000);
    }
  });

  // Close panel on click outside
  document.addEventListener('click', (e) => {
    if (panelOpen && panel && !panel.contains(e.target) && e.target !== bridgeBtn) {
      closePanel();
    }
  });

  // Close panel on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) {
      closePanel();
    }
  });
}
