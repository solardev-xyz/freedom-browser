/**
 * Chequebook Deposit Module
 *
 * Sidebar sub-screen for the node's chequebook deposit: the xBZZ its
 * chequebook holds to pay other nodes for bandwidth. The node keeps it at
 * its target by itself after each storage purchase; when it runs dry, the
 * top-up is paid in xDAI through the publish setup's pay step.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { openPublishSetup } from './publish-setup.js';

let depositScreen;
let depositBackBtn;
let currentBzzEl;
let targetBzzEl;
let depositText;
let depositBtn;

let isOpen = false;
let setupState = null;

export function initChequebookDeposit() {
  depositScreen = document.getElementById('sidebar-chequebook-deposit');
  depositBackBtn = document.getElementById('chequebook-deposit-back');
  currentBzzEl = document.getElementById('chequebook-current-bzz');
  targetBzzEl = document.getElementById('chequebook-target-bzz');
  depositText = document.getElementById('chequebook-deposit-text');
  depositBtn = document.getElementById('chequebook-deposit-btn');

  registerScreenHider(() => closeChequebookDeposit());

  depositBackBtn?.addEventListener('click', () => closeChequebookDeposit());
  depositBtn?.addEventListener('click', () => handleTopUp());

  window.publishSetup?.onState((state) => {
    setupState = state;
    if (isOpen) render();
  });
}

export async function openChequebookDeposit() {
  if (refuseSubscreenWhileInFlight('Chequebook deposit screen')) return;

  walletState.identityView?.classList.add('hidden');
  depositScreen?.classList.remove('hidden');
  isOpen = true;
  void window.publishSetup?.watch('chequebook-deposit', true);

  render();
  try {
    setupState = (await window.publishSetup?.getState()) || setupState;
  } catch {
    // The push subscription fills it in.
  }
  if (isOpen) render();
}

export function closeChequebookDeposit() {
  if (isOpen) void window.publishSetup?.watch('chequebook-deposit', false);
  isOpen = false;
  depositScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

function render() {
  const account = setupState?.account;
  const chequebook = account?.chequebook;

  if (currentBzzEl) {
    currentBzzEl.textContent = chequebook?.deposit ? `${chequebook.deposit} xBZZ` : '--';
  }
  if (targetBzzEl) {
    targetBzzEl.textContent = chequebook?.target ? `${chequebook.target} xBZZ` : '--';
  }

  let text;
  if (!account) {
    text = 'Checking the deposit…';
  } else if (!chequebook) {
    text =
      'Your node does not have a chequebook yet. Your first storage purchase creates it and funds the deposit.';
  } else if (chequebook.managed === false) {
    text = 'This node manages its chequebook deposit through its own configuration.';
  } else if (chequebook.needsTopUp) {
    text =
      'The deposit is used up, so uploads will stall. Top it up to keep publishing; you pay in xDAI, like for storage.';
  } else {
    text = 'The deposit is funded. Your node tops it up by itself when you buy storage.';
  }
  if (depositText) depositText.textContent = text;

  const canTopUp =
    Boolean(chequebook?.needsTopUp) && chequebook.managed !== false && setupState?.canBuy;
  depositBtn?.classList.toggle('hidden', !canTopUp);
}

async function handleTopUp() {
  if (depositBtn) depositBtn.disabled = true;
  let error = null;
  try {
    const result = await window.publishSetup?.arm({ kind: 'deposit' });
    if (result && !result.ok) error = result.error || 'Could not start the top-up.';
  } catch (err) {
    error = err?.message || 'Could not start the top-up.';
  } finally {
    if (depositBtn) depositBtn.disabled = false;
  }
  closeChequebookDeposit();
  openPublishSetup({ error });
}
