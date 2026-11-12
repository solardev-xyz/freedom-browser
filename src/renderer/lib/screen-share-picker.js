/**
 * Screen sharing picker (#951)
 *
 * A site's getDisplayMedia() makes main open this picker in the requesting
 * tab's window (src/main/permissions/screen-share.js). Like Chrome's, it has
 * three panes, a Freedom tab, a window and the entire screen, and the pick is
 * the consent: Share answers with the picked source, Cancel or Escape with
 * none. Nothing is remembered.
 *
 * A picker belongs to its tab: it shows only while that tab is the active
 * one, and is held when the user switches away, the same rule the anchored
 * permission prompt follows. Main withdraws it (`onPickerClose`) when the
 * tab navigates or closes.
 *
 * Main only accepts a source it listed for this picker, so the panes ask main
 * for their sources rather than naming any themselves.
 */

import { getActiveWebview, getTabs, switchTab } from './tabs.js';
import { pushDebug } from './debug.js';
import { showPermissionNotice } from './site-permissions-ui.js';

const KINDS = ['tab', 'window', 'screen'];

const COPY = {
  tab: { list: 'Tabs', none: 'No tabs to share', loading: 'Looking for tabs…' },
  window: { list: 'Windows', none: 'No windows to share', loading: 'Looking for windows…' },
  screen: { list: 'Screens', none: 'No screens to share', loading: 'Looking for screens…' },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

let dialog;
let originEl;
let paneEl;
let kindButtons = [];
let audioLabel;
let audioCheckbox;
let audioText;
let cancelBtn;
let shareBtn;

// Pickers waiting for their tab to become the active one.
let pending = [];
// The picker on screen: {payload, kind, sources: Map<id, source>, selectedId}.
let current = null;
// Bumped on every pane load and selection, so a late answer from main for a
// pane the user already left is dropped.
let loadToken = 0;

const api = () => window.screenShare;

const activeGuestId = () => {
  const webview = getActiveWebview();
  if (!webview || typeof webview.getWebContentsId !== 'function') return null;
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
};

// The webview of the tab whose webContents id is `guestId`, in this window.
const webviewOf = (guestId) => {
  if (typeof guestId !== 'number') return null;
  for (const tab of getTabs()) {
    try {
      if (tab.webview?.getWebContentsId() === guestId) return tab.webview;
    } catch {
      // Not attached yet
    }
  }
  return null;
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const svgIcon = (className, paths) => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
};

// A globe, for a tab without a cached favicon.
const globeIcon = (className) =>
  svgIcon(className, [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M3.6 9h16.8',
    'M3.6 15h16.8',
    'M12 3a14 14 0 0 1 0 18',
    'M12 3a14 14 0 0 0 0 18',
  ]);

// Which pane offers audio, and how its checkbox reads. A shared tab's audio is
// on by default, as in Chrome; the whole system's (Windows only) is off.
const audioFor = (kind) => {
  const offered = current?.payload?.audio || {};
  if (kind === 'tab' && offered.tab) return { text: 'Also share tab audio', checked: true };
  if (kind === 'screen' && offered.screen) {
    return { text: 'Also share system audio', checked: false };
  }
  return null;
};

const setShareEnabled = () => {
  if (shareBtn) shareBtn.disabled = !current?.selectedId;
};

const optionsInPane = () => [...(paneEl?.querySelectorAll('[role="option"]') || [])];

/** Mark `sourceId` as the pick, and move focus there when asked. */
const select = (sourceId, { focus = false } = {}) => {
  if (!current || !current.sources.has(sourceId)) return;
  current.selectedId = sourceId;
  for (const option of optionsInPane()) {
    const chosen = option.dataset.sourceId === sourceId;
    option.setAttribute('aria-selected', chosen ? 'true' : 'false');
    option.tabIndex = chosen ? 0 : -1;
    option.classList.toggle(option.dataset.selectedClass, chosen);
    if (chosen && focus) option.focus();
  }
  setShareEnabled();
};

const share = () => {
  if (!current?.selectedId) return;
  const { payload, selectedId } = current;
  const audio = Boolean(audioCheckbox && !audioLabel.hidden && audioCheckbox.checked);
  closeDialog();
  pushDebug(`[screen-share] sharing a ${selectedId.split(':')[0]} with ${payload.origin}`);
  api()
    ?.respond(payload.id, selectedId, audio)
    .catch((err) => pushDebug(`[screen-share] answer failed: ${err.message}`));
  setTimeout(showNext, 0);
};

const cancel = (reason) => {
  if (!current) return;
  const { payload } = current;
  closeDialog();
  pushDebug(`[screen-share] picker cancelled (${reason})`);
  api()
    ?.respond(payload.id, null, false)
    .catch((err) => pushDebug(`[screen-share] answer failed: ${err.message}`));
  setTimeout(showNext, 0);
};

/** Arrow keys move the pick within a pane, Home and End jump, Enter shares. */
const onOptionKeydown = (event) => {
  const options = optionsInPane();
  const index = options.indexOf(event.currentTarget);
  if (index === -1) return;
  const grid = current?.kind !== 'tab';
  const columns = grid
    ? Math.max(
        1,
        Math.round(paneEl.firstElementChild.clientWidth / (event.currentTarget.offsetWidth || 1))
      )
    : 1;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const sourceId = event.currentTarget.dataset.sourceId;
    if (event.key === 'Enter' && current?.selectedId === sourceId) share();
    else select(sourceId);
    return;
  }
  const moves = {
    ArrowDown: index + columns,
    ArrowUp: index - columns,
    ArrowRight: grid ? index + 1 : null,
    ArrowLeft: grid ? index - 1 : null,
    Home: 0,
    End: options.length - 1,
  };
  if (!(event.key in moves)) return;
  const next = moves[event.key];
  event.preventDefault();
  if (next === null) return;
  const target = options[Math.max(0, Math.min(options.length - 1, next))];
  select(target.dataset.sourceId, { focus: true });
};

const wireOption = (option, sourceId, selectedClass) => {
  option.setAttribute('role', 'option');
  option.setAttribute('aria-selected', 'false');
  option.tabIndex = -1;
  option.dataset.sourceId = sourceId;
  option.dataset.selectedClass = selectedClass;
  option.addEventListener('click', () => select(sourceId));
  option.addEventListener('dblclick', () => {
    select(sourceId);
    share();
  });
  option.addEventListener('keydown', onOptionKeydown);
};

const renderTabs = (sources) => {
  const list = el('div', 'screen-share-picker__tab-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', COPY.tab.list);
  for (const source of sources) {
    const row = el('div', 'ui-list-row ui-list-row--interactive');
    if (source.favicon) {
      const icon = el('img', 'ui-list-row__icon screen-share-picker__favicon');
      icon.src = source.favicon;
      icon.alt = '';
      row.appendChild(icon);
    } else {
      row.appendChild(globeIcon('ui-list-row__icon'));
    }
    const main = el('div', 'ui-list-row__main');
    main.appendChild(el('span', 'ui-list-row__title', source.name));
    if (source.detail) main.appendChild(el('span', 'ui-list-row__subtitle', source.detail));
    row.appendChild(main);
    if (source.current) row.appendChild(el('span', 'ui-list-row__meta ui-badge', 'This tab'));
    wireOption(row, source.id, 'ui-list-row--selected');
    list.appendChild(row);
  }
  return list;
};

const renderGrid = (kind, sources) => {
  const grid = el('div', 'screen-share-picker__grid');
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-label', COPY[kind].list);
  for (const source of sources) {
    const tile = el('div', 'ui-card ui-card--interactive screen-share-picker__source');
    const thumb = el('span', 'screen-share-picker__thumb');
    if (source.thumbnail) {
      const image = el('img');
      image.src = source.thumbnail;
      image.alt = '';
      thumb.appendChild(image);
    }
    const name = el('span', 'screen-share-picker__source-name');
    if (source.icon) {
      const icon = el('img', 'screen-share-picker__source-icon');
      icon.src = source.icon;
      icon.alt = '';
      name.appendChild(icon);
    }
    name.appendChild(el('span', '', source.name));
    tile.append(thumb, name);
    wireOption(tile, source.id, 'ui-card--selected');
    grid.appendChild(tile);
  }
  return grid;
};

const renderEmpty = (title, text) => {
  const empty = el('div', 'ui-empty-state');
  empty.appendChild(el('p', 'ui-empty-state__title', title));
  if (text) empty.appendChild(el('p', 'ui-empty-state__text', text));
  return empty;
};

const calloutIcon = () =>
  svgIcon('ui-callout__icon', [
    'M12 9v4',
    'M12 17h.01',
    'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  ]);

// macOS has not let Freedom record the screen. Tabs still work.
const renderScreenRecordingBlocked = () => {
  const callout = el('div', 'ui-callout ui-callout--warning');
  callout.appendChild(calloutIcon());
  const body = el('div', 'ui-callout__body');
  body.appendChild(el('p', 'ui-callout__title', 'macOS is not letting Freedom see your screen'));
  body.append(
    'Turn on Freedom under System Settings → Privacy & Security → Screen & System Audio ' +
      'Recording, then quit and reopen Freedom. Sharing a tab works without it.'
  );
  callout.appendChild(body);
  const open = el('button', 'ui-button ui-button--sm ui-callout__action', 'Open System Settings');
  open.type = 'button';
  open.addEventListener('click', () => {
    if (!current) return;
    api()
      ?.openSystemSettings(current.payload.id)
      .catch((err) => pushDebug(`[screen-share] System Settings failed: ${err.message}`));
  });
  callout.appendChild(open);
  return callout;
};

const renderListError = (kind) => {
  const callout = el('div', 'ui-callout ui-callout--danger');
  callout.appendChild(calloutIcon());
  const body = el('div', 'ui-callout__body');
  body.appendChild(el('p', 'ui-callout__title', `Freedom could not list your ${kind}s`));
  body.append('Switch panes and back to try again, or share a tab.');
  callout.appendChild(body);
  return callout;
};

/** Switch the picker to one of its panes and list what that pane offers. */
async function showKind(kind, { focusTab = false } = {}) {
  if (!current || !KINDS.includes(kind)) return;
  current.kind = kind;
  current.sources = new Map();
  current.selectedId = null;
  setShareEnabled();

  for (const button of kindButtons) {
    const selected = button.dataset.kind === kind;
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
    if (selected) {
      paneEl.setAttribute('aria-labelledby', button.id);
      if (focusTab) button.focus();
    }
  }

  const audio = audioFor(kind);
  audioLabel.hidden = !audio;
  if (audio) {
    audioText.textContent = audio.text;
    audioCheckbox.checked = audio.checked;
  }

  paneEl.textContent = '';
  paneEl.appendChild(el('p', 'screen-share-picker__loading', COPY[kind].loading));

  const token = ++loadToken;
  const id = current.payload.id;
  let result = null;
  try {
    result = await api()?.listSources(id, kind);
  } catch (err) {
    pushDebug(`[screen-share] listing ${kind}s failed: ${err.message}`);
  }
  if (token !== loadToken || current?.payload?.id !== id || current.kind !== kind) return;

  paneEl.textContent = '';
  if (!result) {
    paneEl.appendChild(renderListError(kind));
    return;
  }
  if (result.blocked === 'screen-recording') {
    paneEl.appendChild(renderScreenRecordingBlocked());
    return;
  }
  if (result.error) {
    paneEl.appendChild(renderListError(kind));
    return;
  }
  const sources = Array.isArray(result.sources) ? result.sources : [];
  for (const source of sources) current.sources.set(source.id, source);
  if (sources.length === 0) {
    paneEl.appendChild(renderEmpty(COPY[kind].none));
    return;
  }
  paneEl.appendChild(kind === 'tab' ? renderTabs(sources) : renderGrid(kind, sources));
  // The first option takes the focus stop, so Tab reaches the pane.
  const first = optionsInPane()[0];
  if (first) first.tabIndex = 0;
}

function closeDialog() {
  current = null;
  loadToken += 1;
  if (dialog?.open) dialog.close();
}

/** Show the next held picker whose tab is the active one. */
function showNext() {
  if (current || !dialog) return;
  // Another chrome dialog is up: wait for it, as the permission prompt does.
  if (document.querySelector('dialog[open]')) return;
  const guestId = activeGuestId();
  const index = pending.findIndex((payload) => payload.guestId === guestId);
  if (index === -1) return;
  const payload = pending.splice(index, 1)[0];
  current = { payload, kind: 'tab', sources: new Map(), selectedId: null };
  originEl.textContent = payload.origin || 'this site';
  dialog.showModal();
  showKind('tab', { focusTab: true });
  pushDebug(`[screen-share] picker for ${payload.origin}`);
}

/** Put the picker away while its tab is in the background. */
function holdForBackground() {
  if (!current) return;
  if (current.payload.guestId === activeGuestId()) return;
  pending.unshift(current.payload);
  closeDialog();
}

const onKindKeydown = (event) => {
  const index = kindButtons.indexOf(event.currentTarget);
  let next = null;
  if (event.key === 'ArrowRight') next = (index + 1) % kindButtons.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + kindButtons.length) % kindButtons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = kindButtons.length - 1;
  if (next === null) return;
  event.preventDefault();
  showKind(kindButtons[next].dataset.kind, { focusTab: true });
};

export const initScreenSharePicker = () => {
  dialog = document.getElementById('screen-share-picker');
  originEl = document.getElementById('screen-share-origin');
  paneEl = document.getElementById('screen-share-pane');
  kindButtons = [...(dialog?.querySelectorAll('[role="tab"][data-kind]') || [])];
  audioLabel = document.getElementById('screen-share-audio-label');
  audioCheckbox = document.getElementById('screen-share-audio');
  audioText = document.getElementById('screen-share-audio-text');
  cancelBtn = document.getElementById('screen-share-cancel');
  shareBtn = document.getElementById('screen-share-submit');

  const bridge = api();
  if (!bridge || !dialog || !paneEl) {
    pushDebug('[screen-share] picker unavailable (missing API or DOM)');
    return;
  }

  bridge.onPickerOpen((payload) => {
    if (!payload || typeof payload.id !== 'number') return;
    pending.push(payload);
    showNext();
  });

  bridge.onPickerClose((payload) => {
    const id = payload?.id;
    pending = pending.filter((entry) => entry.id !== id);
    if (current?.payload?.id === id) {
      pushDebug('[screen-share] picker withdrawn by main (tab navigated or closed)');
      closeDialog();
      setTimeout(showNext, 0);
    }
  });

  // A tab in this window is being shared: show it, as Chrome does, and keep
  // painting it under the active tab while another is in front (see
  // styles/screen-share.css), until main says the share ended.
  bridge.onTabShared((payload) => {
    const webview = webviewOf(payload?.guestId);
    if (!webview) return;
    webview.classList.add('is-screen-shared');
    const tab = getTabs().find((candidate) => candidate.webview === webview);
    if (tab && getActiveWebview() !== webview) switchTab(tab.id);
  });
  bridge.onTabUnshared((payload) => {
    webviewOf(payload?.guestId)?.classList.remove('is-screen-shared');
  });

  bridge.onBlocked((payload) => {
    showPermissionNotice({
      origin: payload?.origin || 'A page',
      text: 'was stopped: it tried to share your screen without Freedom’s picker.',
      note: 'Reload the page to use it again.',
    });
  });

  for (const button of kindButtons) {
    button.addEventListener('click', () => {
      if (current && current.kind !== button.dataset.kind) showKind(button.dataset.kind);
    });
    button.addEventListener('keydown', onKindKeydown);
  }

  cancelBtn?.addEventListener('click', () => cancel('cancel button'));
  shareBtn?.addEventListener('click', share);

  // Escape is the dialog's own close request: it answers "no share".
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel('escape');
  });
  // Any other close (another surface calling close()) without an answer
  // must not strand the page's request.
  dialog.addEventListener('close', () => {
    if (current) cancel('dialog closed');
  });

  document.addEventListener('active-tab-changed', () => {
    holdForBackground();
    // As the permission prompt does: show the incoming tab's held picker on
    // the next task, after the click that switched tabs has finished.
    setTimeout(showNext, 0);
  });

  // A chrome dialog that held a picker back has closed.
  document.addEventListener(
    'close',
    (event) => {
      if (event.target !== dialog && event.target?.tagName === 'DIALOG') {
        setTimeout(showNext, 0);
      }
    },
    true
  );
};

// Test-only: reset module state between cases.
export const _resetForTests = () => {
  pending = [];
  current = null;
  loadToken = 0;
};
