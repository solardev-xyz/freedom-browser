/**
 * Permission Management Subscreens
 *
 * Per-site permission management for wallet and Swarm connections.
 * Accessible by clicking the connection banner info area.
 */

import { walletState, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { updateConnectionBanner, disconnectDapp } from './dapp-connect.js';
import { updateSwarmConnectionBanner, disconnectSwarmApp } from './swarm-connect.js';

// Wallet permission management
let dappPermsScreen;
let dappPermsBack;
let dappPermsSite;
let dappPermsSigningToggle;
let dappPermsTxList;
let dappPermsDisconnect;
let dappPermsKey = null;

// Swarm permission management
let swarmPermsScreen;
let swarmPermsBack;
let swarmPermsSite;
let swarmPermsPublishToggle;
let swarmPermsFeedsToggle;
let swarmPermsDisconnect;
let swarmPermsKey = null;

export function initPermissionManage() {
  // Wallet permission screen
  dappPermsScreen = document.getElementById('sidebar-dapp-permissions');
  dappPermsBack = document.getElementById('dapp-perms-back');
  dappPermsSite = document.getElementById('dapp-perms-site');
  dappPermsSigningToggle = document.getElementById('dapp-perms-signing-toggle');
  dappPermsTxList = document.getElementById('dapp-perms-tx-list');
  dappPermsDisconnect = document.getElementById('dapp-perms-disconnect');

  dappPermsBack?.addEventListener('click', closeDappPerms);
  dappPermsDisconnect?.addEventListener('click', handleDappDisconnect);
  dappPermsSigningToggle?.addEventListener('change', async () => {
    if (dappPermsKey) {
      await window.dappPermissions.setSigningAutoApprove(dappPermsKey, dappPermsSigningToggle.checked);
      updateConnectionBanner(dappPermsKey);
    }
  });

  // Swarm permission screen
  swarmPermsScreen = document.getElementById('sidebar-swarm-permissions');
  swarmPermsBack = document.getElementById('swarm-perms-back');
  swarmPermsSite = document.getElementById('swarm-perms-site');
  swarmPermsPublishToggle = document.getElementById('swarm-perms-publish-toggle');
  swarmPermsFeedsToggle = document.getElementById('swarm-perms-feeds-toggle');
  swarmPermsDisconnect = document.getElementById('swarm-perms-disconnect');

  swarmPermsBack?.addEventListener('click', closeSwarmPerms);
  swarmPermsDisconnect?.addEventListener('click', handleSwarmDisconnect);
  swarmPermsPublishToggle?.addEventListener('change', async () => {
    if (swarmPermsKey) {
      await window.swarmPermissions.setAutoApprove(swarmPermsKey, 'publish', swarmPermsPublishToggle.checked);
      updateSwarmConnectionBanner(swarmPermsKey);
    }
  });
  swarmPermsFeedsToggle?.addEventListener('change', async () => {
    if (swarmPermsKey) {
      await window.swarmPermissions.setAutoApprove(swarmPermsKey, 'feeds', swarmPermsFeedsToggle.checked);
      updateSwarmConnectionBanner(swarmPermsKey);
    }
  });
}

export async function showDappPermissions(permissionKey) {
  dappPermsKey = permissionKey;
  if (dappPermsSite) dappPermsSite.textContent = permissionKey;

  const permission = await window.dappPermissions.getPermission(permissionKey);
  if (!permission) return;

  if (dappPermsSigningToggle) {
    dappPermsSigningToggle.checked = permission.autoApprove?.signing === true;
  }

  renderTxRules(permission.autoApprove?.transactions || []);

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  dappPermsScreen?.classList.remove('hidden');
  openSidebarPanel();
}

function renderTxRules(rules) {
  if (!dappPermsTxList) return;

  if (!rules.length) {
    dappPermsTxList.innerHTML = '<div class="perms-empty">No auto-approved calls</div>';
    return;
  }

  dappPermsTxList.innerHTML = '';
  for (const rule of rules) {
    const row = document.createElement('div');
    row.className = 'perms-tx-rule';

    const info = document.createElement('div');
    info.className = 'perms-tx-info';

    const addr = document.createElement('code');
    addr.className = 'perms-tx-addr';
    addr.textContent = `${rule.to.slice(0, 10)}...${rule.to.slice(-6)}`;
    addr.title = rule.to;

    const sel = document.createElement('code');
    sel.className = 'perms-tx-selector';
    sel.textContent = rule.selector;

    const chain = document.createElement('span');
    chain.className = 'perms-tx-chain';
    chain.textContent = `chain ${rule.chainId}`;

    info.appendChild(addr);
    info.appendChild(sel);
    info.appendChild(chain);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'perms-tx-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await window.dappPermissions.removeTransactionAutoApprove(
        dappPermsKey, rule.to, rule.selector, rule.chainId
      );
      const updated = await window.dappPermissions.getPermission(dappPermsKey);
      renderTxRules(updated?.autoApprove?.transactions || []);
      updateConnectionBanner(dappPermsKey);
    });

    row.appendChild(info);
    row.appendChild(removeBtn);
    dappPermsTxList.appendChild(row);
  }
}

function closeDappPerms() {
  dappPermsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  dappPermsKey = null;
}

async function handleDappDisconnect() {
  if (!dappPermsKey) return;
  await disconnectDapp(dappPermsKey);
  closeDappPerms();
}

export async function showSwarmPermissions(permissionKey) {
  swarmPermsKey = permissionKey;
  if (swarmPermsSite) swarmPermsSite.textContent = permissionKey;

  const permission = await window.swarmPermissions.getPermission(permissionKey);
  if (!permission) return;

  if (swarmPermsPublishToggle) {
    swarmPermsPublishToggle.checked = permission.autoApprove?.publish === true;
  }
  if (swarmPermsFeedsToggle) {
    swarmPermsFeedsToggle.checked = permission.autoApprove?.feeds === true;
  }

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmPermsScreen?.classList.remove('hidden');
  openSidebarPanel();
}

function closeSwarmPerms() {
  swarmPermsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmPermsKey = null;
}

async function handleSwarmDisconnect() {
  if (!swarmPermsKey) return;
  await disconnectSwarmApp(swarmPermsKey);
  closeSwarmPerms();
}
