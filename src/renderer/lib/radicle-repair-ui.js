// Radicle's repair in the Nodes menu, on the freedom-radicled service
// (freedom-core design 0008, "The deadline" and "The escape", Main's view):
//
// - "Radicle is still repairing its data", with Retry: the node's start ran
//   out of time reconciling its data, and a retry continues where it left
//   off. Retry is the node's start; nothing restarts on its own.
// - "Radicle couldn't repair <name>", for each quarantined repository, with
//   the kind, the step and Remove. Remove asks first, since it deletes the
//   local copy, the user's own unshared issues and comments in it among it.
//   It passes back the entry main showed, its `rid` and `qid`, and main
//   refuses any pair it didn't show.
//
// Main sends the state (`window.radicle.onRepairUpdate`); under the add-on
// it is always empty. Names are the repositories' own data, so they are
// untrusted: every entry is built with createElement and textContent, never
// markup, and a name loses its control and bidi characters before it shows.
import { pushDebug } from './debug.js';

export const REPAIRING_TEXT = 'Radicle is still repairing its data';

const NAME_SHOWN = 64;
// C0/C1 controls and the bidi controls (`\p{Bidi_Control}`: LRM/RLM/ALM,
// the embeddings, overrides and isolates), which could reorder what a name
// shows around it.
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Bidi_Control}]/gu;

const KIND_LABELS = Object.freeze({
  cache: 'issue and patch cache',
  namespace: 'signed references',
});
const STEP_LABELS = Object.freeze({
  'ref-locks': 'stale lock removal',
  namespaces: 'signed reference check',
  cache: 'cache rebuild',
});

/** What an entry is called: its name, shown safely, or its ID. */
export const displayName = (entry) => {
  const name =
    typeof entry?.name === 'string'
      ? entry.name.replace(/\s+/gu, ' ').replace(HIDDEN_CHARACTERS, '').trim()
      : '';
  if (!name) return entry.rid;
  const characters = Array.from(name);
  return characters.length > NAME_SHOWN ? `${characters.slice(0, NAME_SHOWN - 1).join('')}…` : name;
};

export const couldntRepairText = (name) => `Radicle couldn't repair ${name}`;

export const detailText = (entry) =>
  `Kind: ${KIND_LABELS[entry.kind] ?? entry.kind} · Step: ${STEP_LABELS[entry.step] ?? entry.step}`;

export const removeWarningText = (name) =>
  `Remove deletes the local copy of ${name}, including your issues and comments in it that haven't been shared.`;

export const moreText = (more) =>
  `Radicle couldn't repair ${more} more ${more === 1 ? 'repository' : 'repositories'}`;

const EMPTY = Object.freeze({ repairing: false, count: 0, entries: [] });

let container = null;
let repairingMessage = null;
let retryButton = null;
let list = null;
let more = null;

// The last state main sent, and what the user is doing with its entries,
// each keyed by `rid qid`: the one whose Remove is being confirmed, those
// being removed, and the errors their removals answered.
let snapshot = EMPTY;
let confirming = null;
const removing = new Set();
const errors = new Map();

const keyOf = (entry) => `${entry.rid} ${entry.qid}`;

const isText = (value) => typeof value === 'string' && value.length > 0;

/** Main's state, with anything malformed left out. */
const normalize = (next) => {
  if (!next || typeof next !== 'object') return EMPTY;
  const entries = (Array.isArray(next.entries) ? next.entries : []).filter(
    (entry) =>
      entry &&
      isText(entry.rid) &&
      isText(entry.qid) &&
      isText(entry.kind) &&
      isText(entry.step) &&
      (entry.name === null || entry.name === undefined || typeof entry.name === 'string')
  );
  const count = Number.isSafeInteger(next.count)
    ? Math.max(next.count, entries.length)
    : entries.length;
  return { repairing: next.repairing === true, count, entries };
};

const element = (tag, className, text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const button = (label, className) => {
  const node = element('button', className, label);
  node.type = 'button';
  return node;
};

/**
 * One quarantined repository: the warning, its kind and step, and Remove.
 * Remove and the confirmation are both built, one hidden: a click shows the
 * other in place, so the clicked button stays in the menu (its document
 * click handler closes the menu on a click outside it).
 */
const buildEntry = (entry) => {
  const key = keyOf(entry);
  const name = displayName(entry);
  const item = element('li', 'radicle-quarantine-entry');

  const title = element('p', 'radicle-repair-message warning', couldntRepairText(name));
  title.setAttribute('title', entry.rid);
  const detail = element('p', 'radicle-quarantine-detail', detailText(entry));

  const remove = button('Remove', 'radicle-repair-button radicle-quarantine-remove');
  const confirm = element('div', 'radicle-quarantine-confirm');
  const warning = element('p', 'radicle-quarantine-warning', removeWarningText(name));
  const actions = element('div', 'radicle-quarantine-actions');
  const confirmRemove = button(
    'Remove',
    'radicle-repair-button radicle-quarantine-remove radicle-quarantine-confirm-remove'
  );
  const cancel = button('Cancel', 'radicle-repair-button');
  actions.appendChild(confirmRemove);
  actions.appendChild(cancel);
  confirm.appendChild(warning);
  confirm.appendChild(actions);

  const error = element('p', 'radicle-quarantine-error');
  error.setAttribute('role', 'alert');
  const message = errors.get(key);
  error.textContent = message || '';
  error.hidden = !message;

  const busy = removing.has(key);
  const asking = confirming === key || busy;
  remove.hidden = asking;
  confirm.hidden = !asking;
  confirmRemove.disabled = busy;
  cancel.disabled = busy;

  remove.addEventListener('click', () => {
    confirming = key;
    remove.hidden = true;
    confirm.hidden = false;
  });
  cancel.addEventListener('click', () => {
    if (confirming === key) confirming = null;
    confirm.hidden = true;
    remove.hidden = false;
  });
  confirmRemove.addEventListener('click', () => {
    if (removing.has(key)) return;
    removing.add(key);
    errors.delete(key);
    confirmRemove.disabled = true;
    cancel.disabled = true;
    error.hidden = true;
    void removeEntry(entry, key);
  });

  item.appendChild(title);
  item.appendChild(detail);
  item.appendChild(remove);
  item.appendChild(confirm);
  item.appendChild(error);
  return item;
};

/** Remove for `entry`, with the `rid` and `qid` main showed. Main lists
 * the quarantine again whatever the answer, and sends the new state. */
const removeEntry = async (entry, key) => {
  let result;
  try {
    result = await window.radicle.removeQuarantined(entry.rid, entry.qid);
  } catch (err) {
    result = { success: false, error: { message: err?.message } };
  }
  removing.delete(key);
  if (confirming === key) confirming = null;
  if (!result?.success && result?.error?.code !== 'NOT_QUARANTINED') {
    const message = isText(result?.error?.message)
      ? result.error.message
      : "Radicle couldn't remove it";
    errors.set(key, message);
    pushDebug(`Radicle couldn't remove a quarantined repository: ${message}`);
  }
  renderRadicleRepair(snapshot);
};

/** Shows main's repair state. */
export const renderRadicleRepair = (next) => {
  snapshot = normalize(next);
  const keys = new Set(snapshot.entries.map(keyOf));
  if (confirming && !keys.has(confirming)) confirming = null;
  for (const key of [...errors.keys()]) if (!keys.has(key)) errors.delete(key);
  if (!container) return;

  if (repairingMessage) repairingMessage.hidden = !snapshot.repairing;
  if (retryButton) retryButton.hidden = !snapshot.repairing;
  if (list) {
    list.replaceChildren(...snapshot.entries.map(buildEntry));
    list.hidden = snapshot.entries.length === 0;
  }
  const hidden = snapshot.count - snapshot.entries.length;
  if (more) {
    more.textContent = hidden > 0 ? moreText(hidden) : '';
    more.hidden = hidden <= 0;
  }
  container.hidden = !snapshot.repairing && snapshot.count === 0;
};

export const initRadicleRepairUi = () => {
  container = document.getElementById('radicle-repair');
  repairingMessage = document.getElementById('radicle-repairing-message');
  retryButton = document.getElementById('radicle-repair-retry');
  list = document.getElementById('radicle-quarantine-list');
  more = document.getElementById('radicle-quarantine-more');

  retryButton?.addEventListener('click', () => {
    if (!window.radicle?.start || retryButton.disabled) return;
    retryButton.disabled = true;
    pushDebug('User retried the Radicle repair');
    window.radicle
      .start()
      .catch((err) => pushDebug(`Failed to retry Radicle: ${err?.message}`))
      .finally(() => {
        retryButton.disabled = false;
      });
  });

  if (window.radicle?.onRepairUpdate) {
    window.radicle.onRepairUpdate((next) => renderRadicleRepair(next));
  }
};
