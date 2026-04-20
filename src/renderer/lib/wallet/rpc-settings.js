/**
 * RPC Settings Module
 *
 * RPC provider list, API key management.
 */

import { createTab } from '../tabs.js';
import { escapeHtml } from './wallet-utils.js';

// Local state
let currentRpcProviderId = null;
let currentCustomUrlId = null; // null = add mode, string = edit mode

export function initRpcSettings() {
  setupRpcApiKeyListeners();
  setupRpcCustomListeners();
  renderRpcProviders();
}

/**
 * Render the RPC providers list in settings
 */
export async function renderRpcProviders() {
  const container = document.getElementById('rpc-providers-list');
  if (!container) return;

  try {
    const [providersResult, configuredResult, customResult, chains] = await Promise.all([
      window.rpcManager.getProviders(),
      window.rpcManager.getConfiguredProviders(),
      window.rpcManager.listCustomUrls(),
      getChainMap(),
    ]);

    if (!providersResult.success) {
      container.innerHTML = '<div class="rpc-provider-error">Failed to load providers</div>';
      return;
    }

    const providers = providersResult.providers;
    const configuredIds = new Set(configuredResult.success ? configuredResult.providers : []);
    const customEntries = customResult?.success ? customResult.entries : [];

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

    // Configured custom endpoints render as regular rows above the Add URL card.
    for (const entry of customEntries) {
      const chain = chains[String(entry.chainId)];
      const chainName = chain?.name || `Chain ${entry.chainId}`;
      const title = entry.label
        ? `${escapeHtml(entry.label)} (${escapeHtml(chainName)})`
        : escapeHtml(chainName);

      html += `
        <div class="rpc-provider-item" data-entry-id="${escapeHtml(entry.id)}">
          <div class="rpc-provider-info">
            <span class="rpc-provider-name">${title}</span>
            <span class="rpc-provider-status configured">${escapeHtml(truncateUrl(entry.url))}</span>
          </div>
          <div class="rpc-provider-actions">
            <button type="button" class="rpc-provider-btn" data-action="edit-custom" data-entry-id="${escapeHtml(entry.id)}">Edit</button>
            <button type="button" class="rpc-provider-btn remove" data-action="remove-custom" data-entry-id="${escapeHtml(entry.id)}">Remove</button>
          </div>
        </div>
      `;
    }

    // "Custom RPC" add-URL card at the bottom of the list.
    html += `
      <div class="rpc-provider-item" data-provider="__custom__">
        <div class="rpc-provider-info">
          <span class="rpc-provider-name">Custom RPC</span>
          <span class="rpc-provider-status">Add your own endpoint</span>
        </div>
        <div class="rpc-provider-actions">
          <button type="button" class="rpc-provider-btn" data-action="add-custom">Add URL</button>
        </div>
      </div>
    `;

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
  const entryId = btn.dataset.entryId;

  console.log('[WalletUI] RPC provider action:', action, providerId || entryId);

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
  } else if (action === 'add-custom') {
    openCustomRpcScreen(null);
  } else if (action === 'edit-custom') {
    openCustomRpcScreen(entryId);
  } else if (action === 'remove-custom') {
    if (!confirm('Remove this custom RPC endpoint?')) return;
    try {
      const result = await window.rpcManager.removeCustomUrl(entryId);
      if (!result.success) {
        alert(result.error || 'Failed to remove endpoint');
      }
      renderRpcProviders();
    } catch (err) {
      alert(`Failed to remove endpoint: ${err.message}`);
    }
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

// ============================================
// Custom RPC endpoints
// ============================================

function truncateUrl(url, max = 40) {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + '…';
}

async function getChainMap() {
  try {
    const result = await window.chainRegistry.getChains();
    if (result?.success && result.chains) return result.chains;
  } catch (err) {
    console.error('[WalletUI] Failed to load chains:', err);
  }
  return {};
}

async function populateChainSelect() {
  const select = document.getElementById('rpc-custom-chain-select');
  if (!select) return;

  const chains = await getChainMap();
  const ids = Object.keys(chains)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);

  let html = '';
  for (const id of ids) {
    const chain = chains[String(id)];
    const name = chain?.name || `Chain ${id}`;
    html += `<option value="${id}">${escapeHtml(name)} (${id})</option>`;
  }
  select.innerHTML = html;
}

async function openCustomRpcScreen(entryId = null) {
  currentCustomUrlId = entryId;

  const titleEl = document.getElementById('rpc-custom-title');
  const urlEl = document.getElementById('rpc-custom-url-input');
  const labelEl = document.getElementById('rpc-custom-label-input');
  const chainEl = document.getElementById('rpc-custom-chain-select');
  const statusEl = document.getElementById('rpc-custom-test-status');

  if (titleEl) titleEl.textContent = entryId ? 'Edit custom endpoint' : 'Add custom endpoint';
  if (statusEl) {
    statusEl.classList.add('hidden');
    statusEl.classList.remove('success', 'error', 'testing');
    statusEl.textContent = '';
  }

  await populateChainSelect();

  if (entryId) {
    const result = await window.rpcManager.listCustomUrls();
    const entry = result?.success
      ? result.entries.find((e) => e.id === entryId)
      : null;
    if (!entry) {
      alert('Entry not found');
      renderRpcProviders();
      return;
    }
    if (urlEl) urlEl.value = entry.url;
    if (labelEl) labelEl.value = entry.label || '';
    if (chainEl) chainEl.value = String(entry.chainId);
  } else {
    if (urlEl) urlEl.value = '';
    if (labelEl) labelEl.value = '';
  }

  const subscreen = document.getElementById('sidebar-rpc-custom');
  const identityView = document.getElementById('sidebar-identity');

  if (identityView) identityView.classList.add('hidden');
  if (subscreen) subscreen.classList.remove('hidden');
}

export function closeCustomRpcScreen() {
  const subscreen = document.getElementById('sidebar-rpc-custom');
  const identityView = document.getElementById('sidebar-identity');

  if (subscreen) subscreen.classList.add('hidden');
  if (identityView) identityView.classList.remove('hidden');

  currentCustomUrlId = null;
}

async function testCustomRpc() {
  const urlEl = document.getElementById('rpc-custom-url-input');
  const chainEl = document.getElementById('rpc-custom-chain-select');
  const statusEl = document.getElementById('rpc-custom-test-status');

  if (!urlEl || !chainEl || !statusEl) return;

  const url = urlEl.value.trim();
  const chainId = parseInt(chainEl.value, 10);

  if (!url) {
    statusEl.textContent = 'Please enter a URL';
    statusEl.classList.remove('hidden', 'success', 'testing');
    statusEl.classList.add('error');
    return;
  }

  statusEl.textContent = 'Testing connection...';
  statusEl.classList.remove('hidden', 'success', 'error');
  statusEl.classList.add('testing');

  try {
    const result = await window.rpcManager.testCustomUrl(url, chainId);
    if (result.success) {
      statusEl.textContent = `Connection successful (chainId ${result.chainId})`;
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

async function saveCustomRpc() {
  const urlEl = document.getElementById('rpc-custom-url-input');
  const labelEl = document.getElementById('rpc-custom-label-input');
  const chainEl = document.getElementById('rpc-custom-chain-select');

  if (!urlEl || !labelEl || !chainEl) return;

  const url = urlEl.value.trim();
  const label = labelEl.value.trim();
  const chainId = parseInt(chainEl.value, 10);

  if (!url) {
    alert('Please enter a URL');
    return;
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    alert('Please select a chain');
    return;
  }

  try {
    const result = currentCustomUrlId
      ? await window.rpcManager.updateCustomUrl(currentCustomUrlId, { chainId, url, label })
      : await window.rpcManager.addCustomUrl({ chainId, url, label });

    if (result.success) {
      closeCustomRpcScreen();
      renderRpcProviders();
    } else {
      alert(result.error || 'Failed to save endpoint');
    }
  } catch (err) {
    alert(`Failed to save endpoint: ${err.message}`);
  }
}

function setupRpcCustomListeners() {
  const backBtn = document.getElementById('rpc-custom-back');
  const cancelBtn = document.getElementById('rpc-custom-cancel');
  const saveBtn = document.getElementById('rpc-custom-save');
  const testBtn = document.getElementById('rpc-custom-test');

  if (backBtn) backBtn.addEventListener('click', closeCustomRpcScreen);
  if (cancelBtn) cancelBtn.addEventListener('click', closeCustomRpcScreen);
  if (saveBtn) saveBtn.addEventListener('click', saveCustomRpc);
  if (testBtn) testBtn.addEventListener('click', testCustomRpc);
}
