/**
 * RPC settings — relocated to the RPC Providers settings page.
 *
 * RPC provider API keys are managed on the unified RPC Providers settings
 * page. The wallet sidebar keeps a single deep-link there.
 */

import { createTab } from '../tabs.js';

export function initRpcSettings() {
  const container = document.getElementById('rpc-providers-list');
  if (!container) return;

  container.innerHTML = `
    <p style="font-size: 12px; color: var(--muted); margin: 0 0 8px">
      RPC provider API keys are managed on the RPC Providers settings page.
    </p>
    <button type="button" id="rpc-open-providers" class="rpc-provider-btn" style="width: 100%">
      Open RPC Providers settings
    </button>`;

  const btn = document.getElementById('rpc-open-providers');
  if (btn) {
    btn.addEventListener('click', () => createTab('freedom://settings/rpc'));
  }
}
