// Publish on Swarm — freedom://publish
//
// Uses freedomAPI.swarm.* (internal-only, guarded by webview preload)

const swarm = window.freedomAPI?.swarm;

const PROGRESS_POLL_MS = 2000;
const PROGRESS_TIMEOUT_MS = 600000; // 10 minutes max poll

// DOM refs
const statusBanner = document.getElementById('publish-status-banner');
const actionsSection = document.getElementById('publish-actions');
const publishFileBtn = document.getElementById('publish-file-btn');
const publishFolderBtn = document.getElementById('publish-folder-btn');
const publishTextBtn = document.getElementById('publish-text-btn');
const textInputSection = document.getElementById('publish-text-input');
const textArea = document.getElementById('publish-text-area');
const textSubmitBtn = document.getElementById('publish-text-submit');
const textCancelBtn = document.getElementById('publish-text-cancel');
const progressSection = document.getElementById('publish-progress');
const progressText = document.getElementById('publish-progress-text');
const progressFill = document.getElementById('publish-progress-fill');
const resultSection = document.getElementById('publish-result');
const resultUrl = document.getElementById('publish-result-url');
const resultRef = document.getElementById('publish-result-ref');
const copyUrlBtn = document.getElementById('publish-copy-url');
const copyRefBtn = document.getElementById('publish-copy-ref');
const openUrlBtn = document.getElementById('publish-open-url');
const publishAnotherBtn = document.getElementById('publish-another');
const errorSection = document.getElementById('publish-error');
const errorText = document.getElementById('publish-error-text');
const errorRetryBtn = document.getElementById('publish-error-retry');
const historyList = document.getElementById('publish-history-list');
const historyClearBtn = document.getElementById('publish-history-clear');

let progressPollTimeout = null;
let lastResult = null;

// ============================================
// Init
// ============================================

function init() {
  if (!swarm) {
    showBanner('Swarm publishing API is not available.', 'error');
    disableActions();
    return;
  }

  publishFileBtn?.addEventListener('click', handlePublishFile);
  publishFolderBtn?.addEventListener('click', handlePublishFolder);
  publishTextBtn?.addEventListener('click', showTextInput);
  textSubmitBtn?.addEventListener('click', handlePublishText);
  textCancelBtn?.addEventListener('click', resetToActions);
  publishAnotherBtn?.addEventListener('click', resetToActions);
  errorRetryBtn?.addEventListener('click', resetToActions);
  copyUrlBtn?.addEventListener('click', () => copyToClipboard(lastResult?.bzzUrl));
  copyRefBtn?.addEventListener('click', () => copyToClipboard(lastResult?.reference));
  openUrlBtn?.addEventListener('click', () => {
    if (lastResult?.bzzUrl) {
      window.freedomAPI?.openInNewTab?.(lastResult.bzzUrl);
    }
  });

  resultUrl?.addEventListener('click', (e) => {
    e.preventDefault();
    if (lastResult?.bzzUrl) {
      window.freedomAPI?.openInNewTab?.(lastResult.bzzUrl);
    }
  });

  historyClearBtn?.addEventListener('click', async () => {
    await swarm.clearPublishHistory();
    loadHistory();
  });

  // Load history on init
  loadHistory();

  // Clean up polling on page unload
  window.addEventListener('pagehide', () => stopProgressPoll());
}

// ============================================
// View management
// ============================================

function showView(view) {
  actionsSection?.classList.toggle('hidden', view !== 'actions');
  textInputSection?.classList.toggle('hidden', view !== 'text');
  progressSection?.classList.toggle('hidden', view !== 'progress');
  resultSection?.classList.toggle('hidden', view !== 'result');
  errorSection?.classList.toggle('hidden', view !== 'error');
}

function resetToActions() {
  stopProgressPoll();
  lastResult = null;
  if (textArea) textArea.value = '';
  showView('actions');
}

function showTextInput() {
  showView('text');
  textArea?.focus();
}

function showBanner(message, type) {
  if (statusBanner) {
    statusBanner.textContent = message;
    statusBanner.className = `publish-banner ${type}`;
    statusBanner.classList.remove('hidden');
  }
}

function disableActions() {
  [publishFileBtn, publishFolderBtn, publishTextBtn].forEach((btn) => {
    if (btn) btn.disabled = true;
  });
}

// ============================================
// Stamp check (deferred to publish time)
// ============================================

async function ensureStampsAvailable() {
  try {
    const result = await swarm.getStamps();
    if (!result?.success || !result.stamps?.some((s) => s.usable)) {
      showError('No usable postage stamps. Purchase stamps before publishing.');
      return false;
    }
    return true;
  } catch {
    // Can't check — let the publish attempt proceed and fail if needed
    return true;
  }
}

// ============================================
// Publish handlers
// ============================================

async function handlePublishFile() {
  try {
    const picked = await swarm.pickFileForPublish();
    if (!picked?.success && picked?.error) { showError(picked.error); return; }
    if (!picked?.path) return; // User cancelled

    if (!(await ensureStampsAvailable())) return;

    showView('progress');
    setProgress('Uploading file\u2026', 0);

    const result = await swarm.publishFilePath(picked.path);

    if (!result?.success) {
      showError(result?.error || 'Upload failed.');
      return;
    }

    if (result.tagUid) {
      await pollProgress(result.tagUid, 'Sending file\u2026');
    }

    showResult(result);
  } catch (err) {
    showError(err.message || 'Upload failed.');
  }
}

async function handlePublishFolder() {
  try {
    const picked = await swarm.pickDirectoryForPublish();
    if (!picked?.success && picked?.error) { showError(picked.error); return; }
    if (!picked?.path) return; // User cancelled

    if (!(await ensureStampsAvailable())) return;

    showView('progress');
    setProgress('Uploading folder\u2026', 0);

    const result = await swarm.publishDirectoryPath(picked.path);

    if (!result?.success) {
      showError(result?.error || 'Upload failed.');
      return;
    }

    if (result.tagUid) {
      await pollProgress(result.tagUid, 'Sending folder\u2026');
    }

    showResult(result);
  } catch (err) {
    showError(err.message || 'Upload failed.');
  }
}

async function handlePublishText() {
  const text = textArea?.value;
  if (!text) return;

  try {
    if (!(await ensureStampsAvailable())) return;

    showView('progress');
    setProgress('Publishing text\u2026', 0);

    const result = await swarm.publishData(text);

    if (!result?.success) {
      showError(result?.error || 'Publish failed.');
      return;
    }

    showResult(result);
  } catch (err) {
    showError(err.message || 'Publish failed.');
  }
}

// ============================================
// Progress polling
// ============================================

function setProgress(text, percent) {
  if (progressText) progressText.textContent = text;
  if (progressFill) progressFill.style.width = `${percent}%`;
}

async function pollProgress(tagUid, label) {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() - startTime > PROGRESS_TIMEOUT_MS) {
        stopProgressPoll();
        reject(new Error('Upload timed out.'));
        return;
      }

      try {
        const status = await swarm.getUploadStatus(tagUid);
        if (status?.success) {
          setProgress(`${label} ${status.progress}%`, status.progress);
          if (status.done) {
            resolve();
            return;
          }
        }
      } catch {
        // Keep polling
      }
      progressPollTimeout = setTimeout(poll, PROGRESS_POLL_MS);
    };
    poll();
  });
}

function stopProgressPoll() {
  if (progressPollTimeout) {
    clearTimeout(progressPollTimeout);
    progressPollTimeout = null;
  }
}

// ============================================
// Result display
// ============================================

function showResult(result) {
  lastResult = result;
  showView('result');
  loadHistory();

  if (resultUrl) {
    resultUrl.textContent = result.bzzUrl || '--';
    resultUrl.href = '#';
  }

  if (resultRef) {
    resultRef.textContent = result.reference || '--';
  }
}

function showError(message) {
  showView('error');
  if (errorText) errorText.textContent = message;
}

async function copyToClipboard(text) {
  if (!text) return;
  if (window.freedomAPI?.copyText) {
    await window.freedomAPI.copyText(text);
  }
}

// ============================================
// History
// ============================================

async function loadHistory() {
  if (!swarm?.getPublishHistory) return;

  try {
    const result = await swarm.getPublishHistory();
    if (result?.success) {
      renderHistory(result.entries || []);
    }
  } catch {
    // Non-critical
  }
}

function renderHistory(entries) {
  if (!historyList) return;

  historyClearBtn?.classList.toggle('hidden', entries.length === 0);

  if (entries.length === 0) {
    historyList.innerHTML = '<div class="publish-history-empty">No publishes yet.</div>';
    return;
  }

  historyList.innerHTML = '';

  entries.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'publish-history-item';

    const typeIcon = { data: '\u{1F4DD}', file: '\u{1F4C4}', directory: '\u{1F4C1}' }[entry.type] || '\u{1F4E6}';

    const header = document.createElement('div');
    header.className = 'publish-history-item-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'publish-history-item-name';
    nameEl.textContent = `${typeIcon} ${entry.name || 'Untitled'}`;
    header.appendChild(nameEl);

    const statusEl = document.createElement('span');
    statusEl.className = 'publish-history-item-status';
    statusEl.dataset.status = entry.status;
    statusEl.textContent = entry.status;
    header.appendChild(statusEl);

    item.appendChild(header);

    if (entry.bzzUrl && entry.status === 'completed') {
      const urlEl = document.createElement('a');
      urlEl.className = 'publish-history-item-url';
      urlEl.href = '#';
      urlEl.textContent = entry.bzzUrl;
      urlEl.addEventListener('click', (e) => {
        e.preventDefault();
        window.freedomAPI?.openInNewTab?.(entry.bzzUrl);
      });
      item.appendChild(urlEl);
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'publish-history-item-time';
    timeEl.textContent = formatTimestamp(entry.timestamp);
    item.appendChild(timeEl);

    historyList.appendChild(item);
  });
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ============================================
// Start
// ============================================

init();
