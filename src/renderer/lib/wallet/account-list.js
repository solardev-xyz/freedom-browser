/**
 * Account list export and import (#1037): the Accounts section of the
 * sidebar's Settings tab and its two sub-screens.
 *
 * Main does the work. It builds and saves the file, reads the file the user
 * picks, and works out what importing it would change; this module shows
 * that plan, unlocks the vault when recovery-phrase accounts need checking,
 * and reports what was done. The file never passes through here: the import
 * screen only holds main's token for it.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { loadDerivedWallets } from './wallet-selector.js';
import { truncateAddress } from './wallet-utils.js';

const TYPE_LABELS = {
  mnemonic: 'Software wallet',
  ledger: 'Ledger',
  remote: 'Phone',
  safe: 'Safe',
};

const INVALID_FILE =
  "This file isn't an account list from Freedom, so nothing was imported. Choose a file made with Export Account List.";

// Reasons an account can't be added that another device or owner, or the
// vault, would fix.
const FIXABLE_LATER = new Set(['ledger', 'remote', 'owners', 'owners-locked', 'locked']);

const GROUPS = [
  { kind: 'rename', title: 'Will be renamed', dot: 'ok' },
  { kind: 'add', title: 'Will be added', dot: 'ok' },
  { kind: 'skip', title: "Can't be added yet", dot: 'no' },
  { kind: 'same', title: 'Already up to date', dot: '' },
];

let switchTabFn = null;

let exportScreen;
let importScreen;

// Import state: main's token for the opened file, and what it said last.
let importToken = null;
let importFileLine = '';
let importChanged = false;
// Moves on whenever the import screen changes hands, so a slow answer for an
// earlier file or view can't paint over the current one.
let importRequest = 0;
// The same for the export screen: a slow save or list must not land on a
// screen that was closed or opened again since.
let exportRequest = 0;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const show = (node, visible) => node?.classList.toggle('hidden', !visible);

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Ledger", "Safe · 1 of 2", "Software wallet". */
export function typeLabel(account) {
  if (account.type === 'safe' && account.threshold && account.ownerCount) {
    return `Safe · ${account.threshold} of ${account.ownerCount}`;
  }
  return TYPE_LABELS[account.type] || 'Account';
}

/** The line under an account that can't be added, or one that will be. */
export function rowNote(row) {
  const owners = (row.missingOwners || []).map(
    (owner) => owner.name || truncateAddress(owner.address)
  );
  const ownerWord = owners.length === 1 ? 'owner' : 'owners';
  switch (row.reason) {
    case 'not-from-seed':
      return "Not from this wallet's recovery phrase. If it used a passphrase, check it was entered when the wallet was set up.";
    case 'ledger':
      return 'Connect this Ledger and add its account, then import again to restore the name.';
    case 'remote':
      return 'Pair this phone and add its account, then import again to restore the name.';
    case 'owners':
      return `Needs ${ownerWord} ${joinNames(owners)}. Add ${owners.length === 1 ? 'it' : 'them'}, then import again.`;
    case 'owners-locked':
      return `Needs ${ownerWord} ${joinNames(owners)}, which can be added once you unlock.`;
    case 'owner-is-safe':
      return "A Safe can't be owned by another Safe.";
    case 'safe-mismatch':
      return "This Safe's address doesn't match its owners, so it can't be added.";
    case 'safe-unchecked':
      return "Couldn't check this Safe's address. Check your connection, then import again.";
    default:
      break;
  }
  if (row.kind === 'add' && row.ownerNames?.length) {
    return `Owners ${joinNames(row.ownerNames)} are here, and the Safe address checks out.`;
  }
  return '';
}

/** "2 renamed, 1 added. Nothing is deleted." */
export function importSummary(rows) {
  const renamed = rows.filter((row) => row.kind === 'rename').length;
  const added = rows.filter((row) => row.kind === 'add').length;
  const parts = [];
  if (renamed) parts.push(`${renamed} renamed`);
  if (added) parts.push(`${added} added`);
  return parts.length ? `${parts.join(', ')}. Nothing is deleted.` : 'Nothing to change.';
}

/** What the done screen says after an import. */
export function importResult(rows) {
  const renamed = rows.filter((row) => row.kind === 'rename').length;
  const added = rows.filter((row) => row.kind === 'add').length;
  const skipped = rows.filter((row) => row.kind === 'skip');

  let done;
  if (renamed && added) {
    done = `Renamed ${renamed} and added ${plural(added, 'account', 'accounts')}.`;
  } else if (renamed) {
    done = `Renamed ${plural(renamed, 'account', 'accounts')}.`;
  } else if (added) {
    done = `Added ${plural(added, 'account', 'accounts')}.`;
  } else {
    done = 'Nothing was changed.';
  }

  let left = '';
  if (skipped.length) {
    left = `${skipped.length} ${skipped.length === 1 ? "wasn't" : "weren't"} added.`;
    if (skipped.some((row) => FIXABLE_LATER.has(row.reason))) {
      left +=
        ' Add the missing Ledger, phone or owners, then import the same file again to restore their names.';
    }
  }
  return { done, left };
}

function accountRow(account, { from, note } = {}) {
  const row = el('div', 'account-list-row');
  row.dataset.address = account.address;
  const name = el('span', 'account-list-row-name');
  if (from !== undefined) {
    name.append(
      el('span', 'account-list-row-from', `${from} → `),
      document.createTextNode(account.name)
    );
    name.title = `${from} → ${account.name}`;
  } else {
    name.textContent = account.name;
    name.title = account.name;
  }
  row.append(
    name,
    el('span', 'account-list-row-type', typeLabel(account)),
    el('code', 'account-list-row-address', truncateAddress(account.address))
  );
  if (note) row.append(el('span', 'account-list-row-note', note));
  return row;
}

function openSubscreen(screen) {
  walletState.identityView?.classList.add('hidden');
  show(screen, true);
}

function closeSubscreen(screen) {
  show(screen, false);
  walletState.identityView?.classList.remove('hidden');
}

// ============================================
// Export
// ============================================

function showExportStep(step) {
  show($('export-accounts-list'), step === 'list');
  show($('export-accounts-save'), step === 'list');
  show($('export-accounts-done'), step === 'done');
  show($('export-accounts-finish'), step === 'done');
}

function showExportError(message) {
  const error = $('export-accounts-error');
  if (!error) return;
  error.textContent = message || '';
  show(error, Boolean(message));
}

async function openExportAccounts() {
  if (refuseSubscreenWhileInFlight('Export account list screen')) return;
  resetExport();
  const request = exportRequest;
  openSubscreen(exportScreen);
  showExportStep('list');

  const save = $('export-accounts-save');
  const rows = $('export-accounts-rows');
  if (save) save.disabled = true;

  const result = await window.wallet.getDerivedWallets();
  if (request !== exportRequest) return;
  const wallets = (result?.wallets || []).filter((wallet) => wallet.address);
  if (!result?.success || wallets.length === 0) {
    showExportError(result?.error || 'There are no accounts to export.');
    return;
  }
  $('export-accounts-intro').textContent =
    `Saves the names and addresses of ${wallets.length === 1 ? 'this account' : `these ${wallets.length} accounts`} ` +
    'to a file, so you can restore them on another computer or after a reinstall.';
  rows?.replaceChildren(
    ...wallets.map((wallet) => accountRow({ ...wallet, ownerCount: wallet.owners?.length }))
  );
  if (save) save.disabled = false;
}

async function saveAccountList() {
  const save = $('export-accounts-save');
  if (save?.disabled) return;
  if (save) save.disabled = true;
  showExportError('');
  const request = exportRequest;
  let result;
  try {
    result = await window.wallet.exportAccountList();
  } catch (err) {
    result = { success: false, error: err.message };
  }
  if (request !== exportRequest) return;
  if (save) save.disabled = false;
  if (!result?.success) {
    showExportError(result?.error || "Couldn't save the account list");
    return;
  }
  if (result.canceled) return;
  $('export-accounts-done-count').textContent =
    `${plural(result.count, 'account', 'accounts')} saved to`;
  $('export-accounts-done-file').textContent = result.fileName;
  showExportStep('done');
}

/** Clear the list and drop answers still on their way. */
function resetExport() {
  exportRequest += 1;
  $('export-accounts-rows')?.replaceChildren();
  showExportError('');
}

export function closeExportAccounts() {
  resetExport();
  if (exportScreen && !exportScreen.classList.contains('hidden')) closeSubscreen(exportScreen);
}

// ============================================
// Import
// ============================================

function showImportStep(step) {
  for (const name of ['loading', 'invalid', 'preview', 'done']) {
    show($(`import-accounts-${name}`), step === name);
  }
  show($('import-accounts-footer'), step !== 'loading');
  show($('import-accounts-summary'), step === 'preview');
  show($('import-accounts-cancel'), step === 'invalid' || step === 'preview');
  show($('import-accounts-submit'), step === 'preview');
  show($('import-accounts-choose'), step === 'invalid');
  show($('import-accounts-finish'), step === 'done');
}

function showImportInvalid(message) {
  $('import-accounts-invalid-text').textContent = message;
  showImportStep('invalid');
}

function showImportError(message) {
  const error = $('import-accounts-error');
  if (!error) return;
  error.textContent = message || '';
  show(error, Boolean(message));
}

function showUnlockError(message) {
  const error = $('import-accounts-unlock-error');
  if (!error) return;
  error.textContent = message || '';
  show(error, Boolean(message));
}

/**
 * Ask main for a file and preview it. Canceling the open dialog leaves the
 * sidebar where it was.
 */
async function chooseAccountListFile() {
  if (refuseSubscreenWhileInFlight('Import account list screen')) return;
  const request = ++importRequest;
  const result = await window.wallet.openAccountList();
  if (request !== importRequest) return;
  if (result?.success && result.canceled) return;

  openSubscreen(importScreen);
  if (!result?.success) {
    importToken = null;
    showImportInvalid(
      result?.code === 'INVALID_ACCOUNT_LIST' ? INVALID_FILE : result?.error || INVALID_FILE
    );
    return;
  }
  importToken = result.token;
  importFileLine = `${result.fileName} · ${plural(result.count, 'account', 'accounts')}`;
  await refreshImportPreview();
}

async function refreshImportPreview() {
  const request = ++importRequest;
  showImportStep('loading');
  const result = await window.wallet.previewAccountListImport(importToken);
  if (request !== importRequest) return;
  if (!result?.success) {
    showImportInvalid(result?.error || INVALID_FILE);
    return;
  }
  renderImportPreview(result.rows);
  showImportStep('preview');
}

function renderImportPreview(rows) {
  $('import-accounts-file').textContent = importFileLine;
  showImportError('');

  // Recovery-phrase accounts wait for the vault; until then they aren't
  // shown as anything, only counted on the unlock card.
  const waiting = rows.filter((row) => row.reason === 'locked');
  const shown = rows.filter((row) => row.reason !== 'locked');
  show($('import-accounts-unlock'), waiting.length > 0);
  if (waiting.length) {
    $('import-accounts-unlock-text').textContent =
      `Unlock to check ${plural(waiting.length, 'software-wallet account', 'software-wallet accounts')} ` +
      `against your recovery phrase. Until then ${waiting.length === 1 ? 'it' : 'they'} can't be added.`;
    configureUnlock();
  }

  const groups = GROUPS.map(({ kind, title, dot }) => {
    const members = shown.filter((row) => row.kind === kind);
    if (members.length === 0) return null;
    const section = el('div', 'account-list-section');
    section.dataset.kind = kind;
    const heading = el('span', 'sidebar-section-title');
    heading.append(el('span', `account-list-dot ${dot}`.trim()), document.createTextNode(title));
    const head = el('div', 'account-list-section-head');
    head.append(heading, el('span', 'account-list-count', String(members.length)));
    const group = el('div', 'account-list-group');
    group.append(
      ...members.map((row) =>
        accountRow(row, { from: kind === 'rename' ? row.from : undefined, note: rowNote(row) })
      )
    );
    section.append(head, group);
    return section;
  }).filter(Boolean);
  $('import-accounts-groups').replaceChildren(...groups);

  importChanged = rows.some((row) => row.kind === 'rename' || row.kind === 'add');
  $('import-accounts-summary').textContent = importSummary(rows);
  $('import-accounts-submit').disabled = !importChanged;
}

async function configureUnlock() {
  showUnlockError('');
  const password = $('import-accounts-password');
  if (password) password.value = '';
  try {
    const [canUseTouchId, touchIdEnabled, vaultMeta] = await Promise.all([
      window.quickUnlock.canUseTouchId(),
      window.quickUnlock.isEnabled(),
      window.identity.getVaultMeta(),
    ]);
    show($('import-accounts-touchid-btn'), canUseTouchId && touchIdEnabled);
    show($('import-accounts-password-section'), vaultMeta?.userKnowsPassword ?? true);
  } catch (err) {
    console.error('[WalletUI] Failed to configure account list unlock:', err);
    show($('import-accounts-password-section'), true);
  }
}

async function unlockWith(unlock) {
  showUnlockError('');
  // Import, Back or another screen can move on while the vault unlocks; a
  // late unlock must not repaint over what came after it.
  const request = importRequest;
  try {
    const result = await unlock();
    if (!result?.success) throw new Error(result?.error || 'Unlock failed');
  } catch (err) {
    if (request === importRequest && err.message !== 'Touch ID cancelled') {
      showUnlockError(err.message);
    }
    return;
  }
  if (request !== importRequest) return;
  await refreshImportPreview();
}

function handleTouchIdUnlock() {
  return unlockWith(() => window.quickUnlock.unlock());
}

function handlePasswordUnlock() {
  const password = $('import-accounts-password')?.value;
  if (!password) {
    showUnlockError('Please enter your password');
    return;
  }
  return unlockWith(() => window.identity.unlock(password));
}

async function submitImport() {
  const submit = $('import-accounts-submit');
  if (!importChanged || submit?.disabled) return;
  const request = ++importRequest;
  submit.disabled = true;
  showImportError('');
  let result;
  try {
    result = await window.wallet.importAccountList(importToken);
  } catch (err) {
    result = { success: false, error: err.message };
  }
  // The list changed even if the screen has moved on since.
  if (result?.success) await loadDerivedWallets();
  if (request !== importRequest) return;
  if (!result?.success) {
    showImportError(result?.error || "Couldn't import the account list");
    submit.disabled = false;
    return;
  }
  importToken = null;
  const { done, left } = importResult(result.rows);
  $('import-accounts-done-text').textContent = done;
  $('import-accounts-done-left').textContent = left;
  show($('import-accounts-done-left'), Boolean(left));
  showImportStep('done');
}

/** Forget the opened file and anything typed, and drop answers still on their way. */
function resetImport() {
  importRequest += 1;
  importToken = null;
  importChanged = false;
  $('import-accounts-groups')?.replaceChildren();
  const password = $('import-accounts-password');
  if (password) password.value = '';
  showUnlockError('');
  showImportError('');
}

export function closeImportAccounts() {
  // Even when hidden: a file picked a moment ago may still be on its way.
  resetImport();
  if (importScreen && !importScreen.classList.contains('hidden')) closeSubscreen(importScreen);
}

function backToSettings(close) {
  return () => {
    close();
    switchTabFn?.('settings');
  };
}

export function initAccountList(switchTab) {
  switchTabFn = switchTab;
  exportScreen = $('sidebar-export-accounts');
  importScreen = $('sidebar-import-accounts');

  // Another screen taking over the sidebar (a dApp approval) never goes
  // through the close functions, and the identity view must stay hidden
  // under it, so the screens are cleared here: no password left in the page.
  registerScreenHider(() => {
    resetExport();
    resetImport();
    show(exportScreen, false);
    show(importScreen, false);
  });

  $('sidebar-export-accounts-btn')?.addEventListener('click', openExportAccounts);
  $('export-accounts-back')?.addEventListener('click', backToSettings(closeExportAccounts));
  $('export-accounts-save')?.addEventListener('click', saveAccountList);
  $('export-accounts-finish')?.addEventListener('click', backToSettings(closeExportAccounts));

  $('sidebar-import-accounts-btn')?.addEventListener('click', chooseAccountListFile);
  $('import-accounts-back')?.addEventListener('click', backToSettings(closeImportAccounts));
  $('import-accounts-cancel')?.addEventListener('click', backToSettings(closeImportAccounts));
  $('import-accounts-finish')?.addEventListener('click', backToSettings(closeImportAccounts));
  $('import-accounts-choose')?.addEventListener('click', chooseAccountListFile);
  $('import-accounts-submit')?.addEventListener('click', submitImport);
  $('import-accounts-touchid-btn')?.addEventListener('click', handleTouchIdUnlock);
  $('import-accounts-password-submit')?.addEventListener('click', handlePasswordUnlock);
  $('import-accounts-password')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handlePasswordUnlock();
  });
}
