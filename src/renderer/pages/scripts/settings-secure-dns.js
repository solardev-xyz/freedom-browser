// Settings → Privacy and security → Secure DNS (#472). Saves on change, as
// every Settings row does, and the main process applies a save at once
// (src/main/secure-dns.js). Main also refuses an invalid value on its own;
// the checks here decide what the page says inline, and keep a half-entered
// custom provider from being saved (choosing "Custom" waits for a valid
// address, and the provider in use until then stays in use).
//
// Classic page script, loaded after settings.js. The helpers are also
// exported for Jest (settings-secure-dns.test.js); in the page `module` is
// undefined and only the IIFE at the bottom runs.

const SECURE_DNS_MODE_HELP = {
  automatic:
    "If the provider can't be reached, Freedom uses your network's DNS, so Wi-Fi sign-in pages keep working.",
  secure: "Sites won't load while the provider can't be reached, Wi-Fi sign-in pages included.",
  off: "Sites are looked up through your network's DNS, which your network provider can see.",
};

const SECURE_DNS_PROVIDER_LABELS = {
  quad9: 'Quad9',
  cloudflare: 'Cloudflare',
  mullvad: 'Mullvad',
  custom: 'The saved address',
};

const SECURE_DNS_DEFAULT_MODE = 'automatic';
const SECURE_DNS_DEFAULT_PROVIDER = 'quad9';

// The page's copy of the main process's check (normalizeDohTemplate in
// src/main/secure-dns.js): an https:// URL with a host, no credentials,
// fragment or whitespace, and no template variable but RFC 8484's `{?dns}`.
// settings-secure-dns.test.js holds the two to the same answers.
function isValidDohTemplate(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return false;
  if (/[{}]/.test(trimmed.replace('{?dns}', ''))) return false;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !url.hostname) return false;
  return !url.username && !url.password && !url.hash;
}

// What the panel shows for the stored settings, plus an unsaved choice of
// "Custom" (`draftCustom`) that is waiting for its address.
function secureDnsView(settings, { draftCustom = false } = {}) {
  const mode = Object.prototype.hasOwnProperty.call(SECURE_DNS_MODE_HELP, settings?.secureDnsMode)
    ? settings.secureDnsMode
    : SECURE_DNS_DEFAULT_MODE;
  const storedProvider = Object.prototype.hasOwnProperty.call(
    SECURE_DNS_PROVIDER_LABELS,
    settings?.secureDnsProvider
  )
    ? settings.secureDnsProvider
    : SECURE_DNS_DEFAULT_PROVIDER;
  const provider = draftCustom ? 'custom' : storedProvider;
  const off = mode === 'off';
  return {
    mode,
    modeHelp: SECURE_DNS_MODE_HELP[mode],
    provider,
    // The provider in use while a custom address is being entered or fixed.
    inUse: SECURE_DNS_PROVIDER_LABELS[storedProvider],
    providerDisabled: off,
    customVisible: provider === 'custom',
    customTemplate:
      typeof settings?.secureDnsCustomTemplate === 'string' ? settings.secureDnsCustomTemplate : '',
  };
}

// `keepCustomInput`: the address field has focus, so a repaint (a broadcast
// landing mid-edit) leaves what the user is typing alone.
function renderSecureDns(els, view, { keepCustomInput = false } = {}) {
  els.mode.value = view.mode;
  els.modeHelp.textContent = view.modeHelp;
  els.provider.value = view.provider;
  els.provider.disabled = view.providerDisabled;
  els.providerRow.classList.toggle('disabled', view.providerDisabled);
  els.customRow.hidden = !view.customVisible;
  els.customRow.classList.toggle('disabled', view.providerDisabled);
  els.custom.disabled = view.providerDisabled;
  if (!keepCustomInput) els.custom.value = view.customTemplate;
  return view;
}

const secureDnsWaitingMessage = (view) =>
  `Enter the provider's address to switch to it. ${view.inUse} stays in use until then.`;

const secureDnsInvalidMessage = (view) =>
  `That isn't an https:// address Freedom can use. ${view.inUse} stays in use.`;

if (typeof module === 'object' && module.exports) {
  module.exports = {
    SECURE_DNS_MODE_HELP,
    isValidDohTemplate,
    secureDnsView,
    renderSecureDns,
    secureDnsWaitingMessage,
    secureDnsInvalidMessage,
  };
} else {
  (() => {
    const byId = (id) => document.getElementById(id);
    const els = {
      mode: byId('secure-dns-mode'),
      modeHelp: byId('secure-dns-mode-help'),
      provider: byId('secure-dns-provider'),
      providerRow: byId('secure-dns-provider-row'),
      customRow: byId('secure-dns-custom-row'),
      custom: byId('secure-dns-custom'),
      status: byId('secure-dns-custom-status'),
    };
    if (Object.values(els).some((el) => !el)) return;

    let stored = null;
    let draftCustom = false;

    const setStatus = (message, kind) => {
      els.status.textContent = message || '';
      els.status.className = kind ? `rpc-status ${kind}` : 'rpc-status';
    };
    const view = () => secureDnsView(stored, { draftCustom });
    const paint = () => {
      if (!stored) return;
      renderSecureDns(els, view(), { keepCustomInput: document.activeElement === els.custom });
    };

    const save = async (patch) => {
      let ok;
      try {
        ok = await freedomAPI.saveSettings(patch);
      } catch {
        ok = false;
      }
      if (!ok) setStatus("Couldn't save the change. Try again.", 'error');
      // Read back what main kept: it leaves an invalid value out, and an
      // unchanged save broadcasts nothing.
      try {
        stored = await freedomAPI.getSettings();
      } catch {
        // Keep the last known settings; the next broadcast repaints.
      }
      paint();
      return ok;
    };

    els.mode.addEventListener('change', () => {
      save({ secureDnsMode: els.mode.value });
    });

    els.provider.addEventListener('change', () => {
      const choice = els.provider.value;
      els.custom.removeAttribute('aria-invalid');
      setStatus('');
      if (choice !== 'custom') {
        draftCustom = false;
        save({ secureDnsProvider: choice });
        return;
      }
      if (isValidDohTemplate(stored?.secureDnsCustomTemplate)) {
        draftCustom = false;
        save({ secureDnsProvider: 'custom' });
        return;
      }
      draftCustom = true;
      paint();
      setStatus(secureDnsWaitingMessage(view()));
      els.custom.focus();
    });

    // `change`: on Enter, or when the field loses focus after an edit.
    els.custom.addEventListener('change', () => {
      const value = els.custom.value.trim();
      if (!isValidDohTemplate(value)) {
        els.custom.setAttribute('aria-invalid', 'true');
        setStatus(secureDnsInvalidMessage(view()), 'error');
        return;
      }
      els.custom.removeAttribute('aria-invalid');
      setStatus('');
      draftCustom = false;
      els.custom.value = value;
      save({ secureDnsProvider: 'custom', secureDnsCustomTemplate: value });
    });

    freedomAPI.onSettingsUpdated?.((settings) => {
      if (!settings) return;
      stored = settings;
      paint();
    });

    freedomAPI
      .getSettings()
      .then((settings) => {
        // A broadcast that landed while this was in flight is newer.
        if (!stored) stored = settings;
        paint();
      })
      .catch((err) => console.error('[settings] could not read the Secure DNS setting:', err));
  })();
}
