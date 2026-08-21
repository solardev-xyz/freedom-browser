/**
 * Radicle alias display + inline editing in the sidebar Nodes tab.
 *
 * The alias is the label the node gossips to the whole network alongside
 * its Node ID (every peer caches it and shows it next to the user's
 * issues and comments). Editing writes node.alias into the active
 * RAD_HOME config and restarts a managed node so the new name is
 * announced immediately.
 */

const ALIAS_RULE = 'Aliases are 1–32 characters with no spaces.';

let displayRow;
let aliasEl;
let editBtn;
let editRow;
let inputEl;
let saveBtn;
let statusEl;

export function initRadicleAlias() {
  displayRow = document.getElementById('radicle-alias-display-row');
  aliasEl = document.getElementById('sidebar-radicle-alias');
  editBtn = document.getElementById('radicle-alias-edit-btn');
  editRow = document.getElementById('radicle-alias-edit-row');
  inputEl = document.getElementById('radicle-alias-input');
  saveBtn = document.getElementById('radicle-alias-save-btn');
  statusEl = document.getElementById('radicle-alias-status');

  if (!aliasEl || !window.radicle?.getAlias) return;

  editBtn?.addEventListener('click', startEdit);
  saveBtn?.addEventListener('click', save);
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') stopEdit();
  });

  document.addEventListener('sidebar-opened', refresh);
  refresh();
}

async function refresh() {
  try {
    const alias = await window.radicle.getAlias();
    aliasEl.textContent = alias || '--';
  } catch {
    aliasEl.textContent = '--';
  }
}

function setStatus(text) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle('hidden', !text);
}

function startEdit() {
  inputEl.value = aliasEl.textContent === '--' ? '' : aliasEl.textContent;
  displayRow.classList.add('hidden');
  editRow.classList.remove('hidden');
  setStatus(ALIAS_RULE);
  inputEl.focus();
  inputEl.select();
}

function stopEdit() {
  editRow.classList.add('hidden');
  displayRow.classList.remove('hidden');
  setStatus('');
}

async function save() {
  const alias = inputEl.value.trim();
  if (!alias || /\s/.test(alias)) {
    setStatus(ALIAS_RULE);
    return;
  }

  setStatus('Saving…');
  saveBtn.disabled = true;
  try {
    const result = await window.radicle.setAlias(alias);
    if (!result?.success) {
      setStatus(result?.error?.message || 'Could not save alias');
      return;
    }
    aliasEl.textContent = result.alias;
    stopEdit();
    if (result.restarted) {
      setStatus('Node restarted — the new alias is being announced.');
      setTimeout(() => setStatus(''), 5000);
    }
  } catch (err) {
    setStatus(err?.message || 'Could not save alias');
  } finally {
    saveBtn.disabled = false;
  }
}
