import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel } from '../sidebar.js';
import { createPromptQueue, setButtonsDisabled } from './prompt-queue.js';
import { registerPagePromptRenderer, pagePromptDisplaced } from '../page-prompt-renderers.js';

let screen;
let site;
let name;
let description;
let rows;
let identityNote;
let rejectBtn;
let individualBtn;
let allowBtn;

// The manifest sheet owns a single sidebar screen, so concurrent consent
// requests (two tabs on manifest-bearing apps) queue up like every other
// approval prompt instead of overwriting each other.
const manifestQueue = createPromptQueue(presentPermissionManifest, (armed) => {
  setButtonsDisabled([rejectBtn, individualBtn, allowBtn], !armed);
});

export function initPermissionManifest() {
  screen = document.getElementById('sidebar-swarm-manifest');
  site = document.getElementById('swarm-manifest-site');
  name = document.getElementById('swarm-manifest-name');
  description = document.getElementById('swarm-manifest-description');
  rows = document.getElementById('swarm-manifest-rows');
  identityNote = document.getElementById('swarm-manifest-identity-note');
  rejectBtn = document.getElementById('swarm-manifest-reject');
  individualBtn = document.getElementById('swarm-manifest-individual');
  allowBtn = document.getElementById('swarm-manifest-allow');

  rejectBtn?.addEventListener('click', () => settle('deny'));
  individualBtn?.addEventListener('click', () => settle('individual'));
  allowBtn?.addEventListener('click', () => settle('allow'));
  document.getElementById('swarm-manifest-back')?.addEventListener('click', () => settle('deny'));

  registerScreenHider(() => {
    // `presenting` means this queue is showing its own next request — the
    // hideAllSubscreens() inside present() is our transition, not a
    // dismissal (queued requests behind it must survive it).
    if (manifestQueue.presenting) return;
    const wasVisible = screen && !screen.classList.contains('hidden');
    screen?.classList.add('hidden');
    // Dismissing the sheet drops queued prompts too — the user never sees
    // them here, so main shows them again once the sidebar is free.
    if (wasVisible) {
      for (const pending of manifestQueue.drain()) pagePromptDisplaced(pending.handle);
    }
  });

  // Main's own consent prompt for a page's request (freedom-core design
  // 0011, PRQ-7b): main checked the manifest for the site it attested, holds
  // the consent's token, and decides it on this answer.
  registerPagePromptRenderer('swarm.manifest', {
    show: (prompt) => {
      if (manifestQueue.current?.handle === prompt.handle) return;
      const model = prompt.view?.model;
      if (!model || typeof model !== 'object') {
        decidePagePrompt(prompt.handle, false);
        return;
      }
      manifestQueue.show({
        handle: prompt.handle,
        model: { ...model, origin: prompt.site?.label || prompt.site?.key || model.origin },
        resolve: (outcome) =>
          decidePagePrompt(prompt.handle, outcome !== 'deny', outcome !== 'deny' ? { outcome } : {}),
      });
    },
    close: (handle) => {
      if (!manifestQueue.withdraw((entry) => entry.handle === handle)) return;
      screen?.classList.add('hidden');
      walletState.identityView?.classList.remove('hidden');
      manifestQueue.showNext();
    },
    isShowing: () =>
      manifestQueue.current?.handle && screen && !screen.classList.contains('hidden') ? manifestQueue.current.handle : null,
  });
}

async function decidePagePrompt(handle, approve, choices = {}) {
  try {
    return await window.pagePrompts?.decide?.(handle, approve, choices);
  } catch (err) {
    console.error('[PermissionManifest] The decision did not reach main:', err);
    return null;
  }
}

function presentPermissionManifest({ model }) {
  site.textContent = model.origin;
  name.textContent = model.name;
  description.textContent = model.description;
  description.classList.toggle('hidden', !model.description);
  rows.innerHTML = '';

  for (const capability of model.removed) {
    const row = document.createElement('div');
    row.className = 'swarm-manifest-row';
    const heading = document.createElement('div');
    heading.className = 'swarm-manifest-row-title';
    heading.textContent = `${capability.label} removed`;
    const detail = document.createElement('div');
    detail.className = 'swarm-manifest-row-detail';
    detail.textContent = 'The app no longer requests this capability. Manifest-managed access has been removed.';
    row.append(heading, detail);
    rows.appendChild(row);
  }

  for (const capability of model.changed) {
    const row = document.createElement('div');
    row.className = 'swarm-manifest-row';
    const heading = document.createElement('div');
    heading.className = 'swarm-manifest-row-title';
    heading.textContent = capability.label;
    const detail = document.createElement('div');
    detail.className = 'swarm-manifest-row-detail';
    detail.textContent = capability.why;
    row.append(heading, detail);
    rows.appendChild(row);
  }

  identityNote.classList.toggle('hidden', !model.createsIdentity && !model.preservedIdentity);
  identityNote.textContent = model.createsIdentity
    ? 'A new app-scoped signing identity will be created. Your vault still unlocks at signing time.'
    : model.preservedIdentity
      ? 'Your existing publisher identity will be kept.'
      : '';

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  openSidebarPanel();
}

// Every settling path claims the on-screen request first: claim() hands it
// out once, so a repeated click can neither settle it twice nor act on the
// request queued behind it.
function settle(outcome) {
  const pending = manifestQueue.claim();
  if (!pending) return;
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  pending.resolve(outcome);
  manifestQueue.settle();
}
