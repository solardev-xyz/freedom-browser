/**
 * RPC Settings Module
 *
 * RPC provider list, API key management.
 */

import { createTab } from '../tabs.js';

// Local state
let currentRpcProviderId = null;

export function initRpcSettings() {
  setupRpcApiKeyListeners();
  renderRpcProviders();
}

/**
 * Render the RPC providers list in settings
 */
export async function renderRpcProviders() {
  const container = document.getElementById('rpc-providers-list');
  if (!container) return;

  try {
    const providersResult = await window.rpcManager.getProviders();
    const configuredResult = await window.rpcManager.getConfiguredProviders();

    if (!providersResult.success) {
      container.innerHTML = '<div class="rpc-provider-error">Failed to load providers</div>';
      return;
    }

    const providers = providersResult.providers;
    const configuredIds = new Set(configuredResult.success ? configuredResult.providers : []);

    let html = '';
    for (const [providerId, provider] of Object.entries(providers)) {
      const isConfigured = configuredIds.has(providerId);
      const statusClass = isConfigured ? 'configured' : '';
      const statusText = isConfigured ? 'Configured' : 'Not configured';

      html += `
        <div class="rpc-provider-item" data-provider="${providerId}">
          <div class="rpc-provider-info">
            <span class="rpc-provider-name">${provider.name}</span>
            <span class="rpc-provider-status ${statusClass}">${statusText}</span>
          </div>
          <div class="rpc-provider-actions">
            ${isConfigured
              ? `<button type="button" class="rpc-provider-btn" data-action="edit" data-provider="${providerId}">Edit</button>
                 <button type="button" class="rpc-provider-btn remove" data-action="remove" data-provider="${providerId}">Remove</button>`
              : `<button type="button" class="rpc-provider-btn" data-action="add" data-provider="${providerId}">Add Key</button>`
            }
          </div>
        </div>
      `;
    }

    container.innerHTML = html;

    container.querySelectorAll('.rpc-provider-btn').forEach(btn => {
      btn.addEventListener('click', handleRpcProviderAction);
    });
  } catch (err) {
    console.error('[WalletUI] Failed to render RPC providers:', err);
    container.innerHTML = '<div class="rpc-provider-error">Failed to load providers</div>';
  }
}

async function handleRpcProviderAction(event) {
  const btn = event.currentTarget;
  const action = btn.dataset.action;
  const providerId = btn.dataset.provider;

  console.log('[WalletUI] RPC provider action:', action, providerId);

  if (action === 'remove') {
    if (confirm(`Remove API key for ${providerId}?`)) {
      try {
        await window.rpcManager.removeApiKey(providerId);
        renderRpcProviders();
      } catch (err) {
        console.error('[WalletUI] Failed to remove API key:', err);
        alert(`Failed to remove API key: ${err.message}`);
      }
    }
  } else if (action === 'add' || action === 'edit') {
    openRpcApiKeyScreen(providerId, action === 'edit');
  }
}

// ============================================
// RPC API Key Subscreen
// ============================================

async function openRpcApiKeyScreen(providerId, isEdit = false) {
  currentRpcProviderId = providerId;

  const providersResult = await window.rpcManager.getProviders();
  if (!providersResult.success) {
    alert('Failed to load provider info');
    return;
  }

  const provider = providersResult.providers[providerId];
  if (!provider) {
    alert('Provider not found');
    return;
  }

  const titleEl = document.getElementById('rpc-apikey-title');
  const linkEl = document.getElementById('rpc-apikey-website-link');
  const inputEl = document.getElementById('rpc-apikey-input');
  const statusEl = document.getElementById('rpc-apikey-test-status');

  if (titleEl) titleEl.textContent = provider.name;
  if (linkEl) {
    linkEl.href = provider.website || '#';
    linkEl.textContent = `Get an API key from ${provider.name}`;
  }
  if (inputEl) {
    inputEl.value = '';
    inputEl.type = 'password';
  }
  if (statusEl) {
    statusEl.classList.add('hidden');
    statusEl.classList.remove('success', 'error', 'testing');
  }

  if (isEdit) {
    if (inputEl) inputEl.placeholder = 'Enter new API key (leave blank to keep current)';
  } else {
    if (inputEl) inputEl.placeholder = 'Enter API key';
  }

  const subscreen = document.getElementById('sidebar-rpc-apikey');
  const identityView = document.getElementById('sidebar-identity');

  if (identityView) identityView.classList.add('hidden');
  if (subscreen) subscreen.classList.remove('hidden');
}

export function closeRpcApiKeyScreen() {
  const subscreen = document.getElementById('sidebar-rpc-apikey');
  const identityView = document.getElementById('sidebar-identity');

  if (subscreen) subscreen.classList.add('hidden');
  if (identityView) identityView.classList.remove('hidden');

  currentRpcProviderId = null;
}

function toggleRpcApiKeyVisibility() {
  const inputEl = document.getElementById('rpc-apikey-input');
  if (inputEl) {
    inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
  }
}

async function testRpcApiKey() {
  const inputEl = document.getElementById('rpc-apikey-input');
  const statusEl = document.getElementById('rpc-apikey-test-status');

  if (!inputEl || !statusEl || !currentRpcProviderId) return;

  const apiKey = inputEl.value.trim();
  if (!apiKey) {
    statusEl.textContent = 'Please enter an API key';
    statusEl.classList.remove('hidden', 'success', 'testing');
    statusEl.classList.add('error');
    return;
  }

  statusEl.textContent = 'Testing connection...';
  statusEl.classList.remove('hidden', 'success', 'error');
  statusEl.classList.add('testing');

  try {
    const result = await window.rpcManager.testApiKey(currentRpcProviderId, apiKey);

    if (result.success) {
      statusEl.textContent = 'Connection successful!';
      statusEl.classList.remove('testing', 'error');
      statusEl.classList.add('success');
    } else {
      statusEl.textContent = result.error || 'Connection failed';
      statusEl.classList.remove('testing', 'success');
      statusEl.classList.add('error');
    }
  } catch (err) {
    statusEl.textContent = err.message || 'Connection failed';
    statusEl.classList.remove('testing', 'success');
    statusEl.classList.add('error');
  }
}

async function saveRpcApiKey() {
  const inputEl = document.getElementById('rpc-apikey-input');

  if (!inputEl || !currentRpcProviderId) return;

  const apiKey = inputEl.value.trim();
  if (!apiKey) {
    alert('Please enter an API key');
    return;
  }

  try {
    const result = await window.rpcManager.setApiKey(currentRpcProviderId, apiKey);

    if (result.success) {
      closeRpcApiKeyScreen();
      renderRpcProviders();
    } else {
      alert(result.error || 'Failed to save API key');
    }
  } catch (err) {
    alert(`Failed to save API key: ${err.message}`);
  }
}

function setupRpcApiKeyListeners() {
  const backBtn = document.getElementById('rpc-apikey-back');
  const cancelBtn = document.getElementById('rpc-apikey-cancel');
  const saveBtn = document.getElementById('rpc-apikey-save');
  const testBtn = document.getElementById('rpc-apikey-test');
  const toggleBtn = document.getElementById('rpc-apikey-toggle');
  const websiteLink = document.getElementById('rpc-apikey-website-link');

  if (backBtn) backBtn.addEventListener('click', closeRpcApiKeyScreen);
  if (cancelBtn) cancelBtn.addEventListener('click', closeRpcApiKeyScreen);
  if (saveBtn) saveBtn.addEventListener('click', saveRpcApiKey);
  if (testBtn) testBtn.addEventListener('click', testRpcApiKey);
  if (toggleBtn) toggleBtn.addEventListener('click', toggleRpcApiKeyVisibility);

  if (websiteLink) {
    websiteLink.addEventListener('click', (e) => {
      e.preventDefault();
      const url = websiteLink.href;
      if (url && url !== '#') {
        createTab(url);
      }
    });
  }
}
