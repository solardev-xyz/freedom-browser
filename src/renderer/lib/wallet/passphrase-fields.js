/**
 * Passphrase Fields
 *
 * The onboarding screen for a BIP-39 passphrase. The value is used exactly as
 * typed: a stray space or a capital letter gives a different wallet, and nothing
 * can flag that afterwards.
 */

const EXPLANATIONS = {
  create:
    "Adds a secret to your recovery phrase, so the words alone won't open this wallet. It's not your password, and nothing can recover a lost passphrase.",
  import:
    "Only if this wallet uses one elsewhere, sometimes called a 25th word. It's not your password.",
};

/**
 * @param {string} passphrase
 * @returns {boolean} Whether a space at either end would be easy to miss
 */
export function hasEdgeSpace(passphrase) {
  return passphrase !== passphrase.trim();
}

/**
 * @param {boolean} enabled - The screen's switch
 * @param {string} passphrase
 * @param {string} confirm
 * @returns {'off'|'on'|'mismatch'} Switched on with nothing typed counts as off.
 */
export function passphraseStatus(enabled, passphrase, confirm) {
  if (!enabled || (!passphrase && !confirm)) return 'off';
  return passphrase === confirm ? 'on' : 'mismatch';
}

/**
 * What to say under the two fields.
 * @param {string} passphrase
 * @param {string} confirm
 * @returns {{text: string, bad: boolean}}
 */
export function passphraseNote(passphrase, confirm) {
  if (confirm && passphrase !== confirm) {
    return { text: "Passphrases don't match.", bad: true };
  }
  if (hasEdgeSpace(passphrase)) {
    return { text: 'Spaces at the start or end count as part of the passphrase.', bad: false };
  }
  return { text: 'Capitals and spaces count, exactly as typed.', bad: false };
}

/**
 * What to say next to a passphrase shown for backup.
 * @param {string} passphrase
 * @returns {string}
 */
export function passphraseBackupNote(passphrase) {
  const note =
    'You need this and your recovery phrase to restore this wallet. Without it, the words open a different, empty wallet.';
  return hasEdgeSpace(passphrase) ? `${note} It starts or ends with a space, which counts.` : note;
}

/**
 * Wire up the passphrase screen, and every row elsewhere that shows its state.
 * @returns {{
 *   status: () => ('off'|'on'|'mismatch'),
 *   isValid: () => boolean,
 *   value: () => string,
 *   reset: () => void,
 *   setMode: (mode: 'create'|'import') => void,
 *   onChange: (listener: () => void) => void,
 * }}
 */
export function setupPassphraseFields() {
  const enabled = document.getElementById('passphrase-enabled');
  const input = document.getElementById('passphrase-input');
  const confirm = document.getElementById('passphrase-confirm');
  const fields = document.getElementById('passphrase-fields');
  const note = document.getElementById('passphrase-note');
  const explanation = document.getElementById('passphrase-explanation');
  const toggle = document.getElementById('passphrase-toggle');
  const statusRows = document.querySelectorAll('.passphrase-status');
  const listeners = [];

  const status = () => passphraseStatus(enabled.checked, input.value, confirm.value);

  const setShown = (shown) => {
    input.type = shown ? 'text' : 'password';
    confirm.type = input.type;
    toggle.setAttribute('aria-label', shown ? 'Hide passphrase' : 'Show passphrase');
  };

  const render = () => {
    fields.classList.toggle('hidden', !enabled.checked);

    const { text, bad } = passphraseNote(input.value, confirm.value);
    note.textContent = text;
    note.classList.toggle('bad', bad);

    const current = status();
    statusRows.forEach((row) => {
      row.textContent = { off: 'Off', on: 'On', mismatch: "Doesn't match" }[current];
      row.classList.toggle('bad', current === 'mismatch');
      row.classList.toggle('on', current === 'on');
    });
  };

  const changed = () => {
    render();
    listeners.forEach((listener) => listener());
  };

  enabled.addEventListener('change', () => {
    if (enabled.checked) {
      input.focus({ preventScroll: true });
    } else {
      input.value = '';
      confirm.value = '';
    }
    changed();
  });
  input.addEventListener('input', changed);
  confirm.addEventListener('input', changed);
  toggle.addEventListener('click', () => setShown(input.type === 'password'));

  render();

  return {
    status,
    isValid: () => status() !== 'mismatch',
    value: () => (status() === 'on' ? input.value : ''),
    reset() {
      enabled.checked = false;
      input.value = '';
      confirm.value = '';
      setShown(false);
      render();
    },
    setMode(mode) {
      explanation.textContent = EXPLANATIONS[mode];
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}
