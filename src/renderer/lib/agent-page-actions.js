import { placePopoverAtPoint } from './popover-bounds.js';

const SEEN_KEY = 'freedom.page-actions.seen';
const PAGE_PROTOCOLS = new Set(['http:', 'https:', 'bzz:', 'ipfs:', 'ipns:']);

function pageKey(tab) {
  try {
    const url = new URL(tab?.url);
    return Number.isSafeInteger(tab?.id) && PAGE_PROTOCOLS.has(url.protocol)
      ? `${tab.id}:${tab.url}` : null;
  } catch { return null; }
}

function siteLabel(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

export function pageActionPrompt(action, url) {
  return `Help me use the ${JSON.stringify(action.name)} action on ${url}. Ask what I'd like to accomplish and what details you need, using anything I've already told you.`;
}

// Only the selected page is polled, including when the sidebar is closed. The
// main-process preview is isolated from agent discovery/approval references.
export function createPageActions({ host, hint, toggle, getTab, getState, discover, openPanel, onSelect, storage = window.localStorage }) {
  let key = null;
  let preview = null;
  let expanded = false;
  let pending = false;
  let pendingRequest = null;
  let selecting = false;
  let disposed = false;
  let hintSite = null;
  let signature = '';
  let seen = [];
  try {
    const saved = JSON.parse(storage.getItem(SEEN_KEY) || '[]');
    if (Array.isArray(saved)) seen = saved.filter((site) => typeof site === 'string').slice(-256);
  } catch { /* Storage can be unavailable; keep the window-local list. */ }

  function remember(site) {
    if (!seen.includes(site)) seen.push(site);
    seen = seen.slice(-256);
    try { storage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* Best effort. */ }
  }

  function hideHint() { hint.hidden = true; hintSite = null; }

  function render() {
    if (disposed) return;
    const state = getState();
    const tab = getTab();
    if (pageKey(tab) !== key) { preview = null; hideHint(); }
    const tools = preview?.tools || [];
    host.hidden = tools.length === 0;
    if (!tools.length) { hideHint(); return; }
    const site = siteLabel(tab.url);
    if (state.open || state.suppressed) hideHint();
    if (state.open && !seen.includes(site)) remember(site);
    if (!state.open && !state.suppressed && !seen.includes(site) && !hintSite) {
      const bounds = toggle.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        hint.hidden = false;
        hintSite = site;
        remember(site);
        placePopoverAtPoint(hint, bounds.right - 300, bounds.bottom + 8);
      }
    }
    const nextSignature = JSON.stringify([key, tools, expanded, state.busy, selecting, state.newChat, preview.truncated]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    host.replaceChildren();
    const header = document.createElement('div');
    header.className = 'agent-page-actions-heading';
    const title = document.createElement('span');
    title.textContent = 'Actions on this page';
    const source = document.createElement('span');
    source.className = 'agent-page-actions-site';
    source.textContent = new URL(tab.url).host;
    source.title = site;
    header.append(title, source);
    host.append(header);
    const list = document.createElement('div');
    list.className = 'agent-page-actions-list';
    const actionKey = key;
    for (const tool of tools.slice(0, expanded ? 64 : 3)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'agent-page-action';
      const label = tool.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
      button.textContent = label.charAt(0).toUpperCase() + label.slice(1);
      button.title = tool.description;
      button.disabled = state.busy || selecting;
      button.addEventListener('click', async () => {
        const selectedKey = actionKey;
        if (selecting || getState().busy || pageKey(getTab()) !== selectedKey) return;
        selecting = true;
        render();
        try {
          // Recheck the live descriptor before handing the action to chat.
          if (pendingRequest) await pendingRequest;
          if (disposed || pageKey(getTab()) !== selectedKey || getState().busy) return;
          const fresh = await discover(tab.id);
          if (disposed || pageKey(getTab()) !== selectedKey || getState().busy) return;
          if (!fresh?.ok || fresh.url !== tab.url || !fresh.tools?.some((entry) => entry.name === tool.name && entry.description === tool.description)) {
            preview = null;
            return;
          }
          await onSelect(tool, tab);
        } catch { preview = null; }
        finally { selecting = false; render(); }
      });
      list.append(button);
    }
    host.append(list);
    if (tools.length > 3) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'agent-page-actions-more';
      more.textContent = expanded ? 'Show less' : `Show all ${tools.length}`;
      more.setAttribute('aria-expanded', String(expanded));
      more.addEventListener('click', () => { expanded = !expanded; render(); });
      host.append(more);
    }
    if (state.newChat || preview.truncated) {
      const note = document.createElement('div');
      note.className = 'agent-page-actions-note';
      note.textContent = state.newChat ? 'Selecting an action starts a new chat for this page.' : 'Showing supported page actions.';
      host.append(note);
    }
  }

  async function refresh() {
    if (disposed) return;
    const tab = getTab();
    const nextKey = pageKey(tab);
    if (nextKey !== key) {
      key = nextKey;
      preview = null;
      expanded = false;
      signature = '';
      hideHint();
      render();
    }
    if (!key || pending || selecting || document.hidden) return;
    pending = true;
    const requestedKey = key;
    try {
      pendingRequest = discover(tab.id);
      const response = await pendingRequest;
      if (disposed || requestedKey !== pageKey(getTab())) return;
      preview = response?.ok && response.url === tab.url ? response : null;
      render();
    } catch { preview = null; render(); }
    finally { pending = false; pendingRequest = null; }
  }

  hint.querySelector('[data-page-actions-explore]').addEventListener('click', () => { hideHint(); openPanel(); render(); });
  hint.querySelector('[data-page-actions-dismiss]').addEventListener('click', hideHint);
  const escape = (event) => { if (event.key === 'Escape') hideHint(); };
  const resize = () => { if (!hint.hidden) { const bounds = toggle.getBoundingClientRect(); placePopoverAtPoint(hint, bounds.right - 300, bounds.bottom + 8); } };
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', resize);
  const interval = setInterval(() => { void refresh(); }, 3000);
  void refresh();
  return {
    refresh, render,
    dispose() { disposed = true; clearInterval(interval); document.removeEventListener('keydown', escape); window.removeEventListener('resize', resize); hideHint(); },
  };
}
