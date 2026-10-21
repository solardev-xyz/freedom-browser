import { placePopoverAtPoint } from './popover-bounds.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { onWindowDeactivated } from './window-deactivation.js';

let dismissMenu = () => {};
export const closeAgentDictationMenu = () => dismissMenu();

export function createDictationMenu({ host, button, api, canOpen, onOpening = () => {}, openSettings, onError, onChosen = () => {} }) {
  let revision = 0;
  let rows = [];
  let saving = false;
  let recordAfterChoice = false;
  const close = (focus = false) => {
    revision += 1;
    if (!host.hidden) hideMenuBackdrop();
    host.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus === true) button.focus();
  };
  dismissMenu = close;
  const position = () => {
    const anchor = button.getBoundingClientRect();
    const rect = host.getBoundingClientRect();
    const below = window.innerHeight - anchor.bottom - 16;
    placePopoverAtPoint(host, anchor.right - rect.width, rect.height <= below ? anchor.bottom + 8 : anchor.top - 8);
  };
  const row = (label, detail, { checked, disabled = false, action, providerId } = {}) => {
    const item = document.createElement('button'); item.type = 'button';
    item.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
    if (checked !== undefined) item.setAttribute('aria-checked', String(checked));
    if (providerId) item.dataset.providerId = providerId;
    item.disabled = disabled;
    const mark = document.createElement('span'); mark.className = 'agent-dictation-menu-check';
    mark.textContent = checked ? '✓' : ''; mark.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span'); copy.className = 'agent-dictation-menu-copy';
    const title = document.createElement('strong'); title.textContent = label; copy.appendChild(title);
    if (detail) { const note = document.createElement('small'); note.textContent = detail; copy.appendChild(note); }
    item.appendChild(mark); item.appendChild(copy); host.appendChild(item); rows.push(item);
    item.addEventListener('click', () => { if (!saving && !item.disabled) action(); });
    return item;
  };
  const settings = (providerId) => { close(); openSettings(providerId); };
  const open = async (options = {}) => {
    if (saving || !canOpen()) return;
    if (!host.hidden) { close(true); return; }
    recordAfterChoice = options.recordAfterChoice === true;
    onOpening();
    const current = ++revision;
    host.hidden = false;
    rows = [];
    host.textContent = 'Loading dictation services…';
    button.setAttribute('aria-expanded', 'true');
    showMenuBackdrop(); position(); host.focus();
    try {
      const state = await api.getAgentDictationState();
      if (current !== revision) return;
      if (!canOpen()) { close(); return; }
      if (!state?.ok) throw new Error(state?.error?.message || 'Could not load dictation services.');
      host.replaceChildren(); rows = [];
      const selected = state.preferences.providerId || state.suggestedProviderId;
      for (const option of state.options) {
        row(option.name, !option.available ? `${option.blockedLabel || 'Unavailable with this connection'} · Review in Settings` : !option.ready ? 'Download local model in Settings' : option.model,
          { checked: option.providerId === selected, disabled: !option.available && option.providerId === 'local', providerId: option.providerId, action: async () => {
            if (!option.available) { settings(option.providerId); return; }
            if (!option.ready) { settings(); return; }
            if (state.preferences.providerId === option.providerId) { close(true); return; }
            saving = true; rows.forEach(item => { item.disabled = true; });
            try {
              const response = await api.chooseAgentDictation({ ...state.preferences, providerId: option.providerId });
              if (current !== revision) return;
              if (!response?.ok) throw new Error(response?.error?.message || 'Could not change dictation service.');
              close(true); onChosen(response, { recordAfterChoice });
            } catch (error) { if (current === revision) { close(true); onError(error.message); } }
            finally { saving = false; }
          } });
      }
      const separator = document.createElement('div'); separator.className = 'agent-dictation-menu-divider';
      separator.setAttribute('role', 'separator'); host.appendChild(separator);
      row('Voice dictation settings…', '', { action: () => settings() });
      position();
      (rows.find(item => item.getAttribute('aria-checked') === 'true' && !item.disabled) || rows.find(item => !item.disabled))?.focus();
    } catch (error) { if (current === revision) { close(true); onError(error.message); } }
  };
  const click = () => void open();
  const keydown = event => {
    if (!host.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const enabled = rows.filter(item => !item.disabled);
      const index = enabled.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    } else if (event.key === 'Escape' && !host.hidden) { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
  };
  const buttonKey = event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); void open(); }
  };
  button.addEventListener('click', click); button.addEventListener('keydown', buttonKey);
  host.addEventListener('keydown', keydown);
  onWindowDeactivated(() => { if (!host.hidden) close(); });
  window.addEventListener('resize', close);
  return { close, show: open, get open() { return !host.hidden; },
    dispose() {
      close(); button.removeEventListener('click', click); button.removeEventListener('keydown', buttonKey);
      host.removeEventListener('keydown', keydown); window.removeEventListener('resize', close);
      if (dismissMenu === close) dismissMenu = () => {};
    } };
}
