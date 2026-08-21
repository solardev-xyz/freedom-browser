/**
 * Keyboard Shortcut Registry + matcher (Renderer)
 *
 * ESM mirror of src/shared/shortcuts.js plus the renderer-side state that
 * keydown handlers resolve through. The shared file is CommonJS and cannot
 * be imported directly by the renderer (script type="module" context with
 * no Node require). Both implementations MUST stay in sync; drift is
 * guarded against by src/renderer/lib/shortcuts.test.js which asserts the
 * registries are identical and the matchers agree across a battery of
 * accelerator/event/platform combinations.
 *
 * Renderer usage:
 *   initShortcuts();                      // once, at chrome startup
 *   matchesShortcut(event, 'tab.new');    // inside keydown handlers
 *
 * matchesShortcut checks the shortcut's effective primary accelerator
 * (user override, else registry default — kept live via settings:updated)
 * plus its fixed aliases.
 */

// ── Registry (mirror of src/shared/shortcuts.js — keep in sync) ─────────

export const SHORTCUTS = [
  // Tabs
  {
    id: 'tab.new',
    description: 'New Tab',
    defaultAccelerator: 'CmdOrCtrl+T',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.close',
    description: 'Close Tab',
    defaultAccelerator: 'CmdOrCtrl+W',
    aliases: [{ accelerator: 'Ctrl+F4', platforms: ['win32', 'linux'] }],
    context: 'both',
    category: 'Tabs',
    editable: true,
    // Cmd/Ctrl+W is deep muscle memory and doubles as the close-window
    // gesture elsewhere in the OS — rebinding deserves a caution.
    warnOnEdit: true,
  },
  {
    id: 'tab.reopenClosed',
    description: 'Reopen Closed Tab',
    defaultAccelerator: 'CmdOrCtrl+Shift+T',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.next',
    description: 'Next Tab',
    defaultAccelerator: 'Ctrl+PageDown',
    aliases: [{ accelerator: 'Ctrl+Tab' }, { accelerator: 'Cmd+Shift+]', platforms: ['darwin'] }],
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.previous',
    description: 'Previous Tab',
    defaultAccelerator: 'Ctrl+PageUp',
    aliases: [
      { accelerator: 'Ctrl+Shift+Tab' },
      { accelerator: 'Cmd+Shift+[', platforms: ['darwin'] },
    ],
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.moveRight',
    description: 'Move Tab Right',
    defaultAccelerator: 'Ctrl+Shift+PageDown',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.moveLeft',
    description: 'Move Tab Left',
    defaultAccelerator: 'Ctrl+Shift+PageUp',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },

  // Page
  {
    id: 'page.reload',
    description: 'Reload This Page',
    defaultAccelerator: 'CmdOrCtrl+R',
    context: 'both',
    category: 'Page',
    editable: true,
  },
  {
    id: 'page.hardReload',
    description: 'Force Reload This Page',
    defaultAccelerator: 'CmdOrCtrl+Shift+R',
    context: 'both',
    category: 'Page',
    editable: true,
  },
  {
    id: 'page.findInPage',
    description: 'Find in Page',
    defaultAccelerator: 'CmdOrCtrl+F',
    context: 'both',
    category: 'Page',
    editable: true,
  },

  // Navigation
  {
    id: 'view.focusAddressBar',
    description: 'Focus Address Bar',
    defaultAccelerator: 'CmdOrCtrl+L',
    context: 'both',
    category: 'Navigation',
    editable: true,
  },
  {
    id: 'history.showAll',
    description: 'Show All History',
    defaultAccelerator: { darwin: 'Cmd+Y', other: 'Ctrl+H' },
    context: 'menu',
    category: 'Navigation',
    editable: true,
  },
  {
    id: 'downloads.show',
    description: 'Downloads',
    defaultAccelerator: 'CmdOrCtrl+Shift+J',
    context: 'menu',
    category: 'Navigation',
    editable: true,
  },

  // Window
  {
    id: 'window.new',
    description: 'New Window',
    defaultAccelerator: 'CmdOrCtrl+N',
    context: 'menu',
    category: 'Window',
    editable: true,
  },
  {
    id: 'window.newPrivate',
    description: 'New Private Window',
    defaultAccelerator: 'CmdOrCtrl+Shift+N',
    // 'both': enforced by the native menu accelerator AND by the renderer
    // keydown fallback (tabs.js, via matchesShortcut) — the fallback exists
    // for the Linux frameless / auto-hidden-menu-bar setups where the menu
    // accelerator never reaches the app. Mirror of src/shared/shortcuts.js.
    context: 'both',
    category: 'Window',
    editable: true,
  },
  {
    id: 'view.fullscreen',
    description: 'Toggle Full Screen',
    defaultAccelerator: 'F11',
    context: 'both',
    category: 'Window',
    editable: true,
  },
  {
    id: 'view.toggleBookmarksBar',
    description: 'Toggle Bookmarks Bar',
    defaultAccelerator: 'CmdOrCtrl+Shift+B',
    context: 'menu',
    category: 'Window',
    editable: true,
  },
  {
    id: 'view.toggleSidebar',
    description: 'Toggle Wallet Sidebar',
    defaultAccelerator: 'CmdOrCtrl+Shift+W',
    context: 'renderer',
    category: 'Window',
    editable: true,
  },

  // Developer
  {
    id: 'devtools.toggle',
    description: 'Developer Tools',
    defaultAccelerator: 'CmdOrCtrl+Alt+I',
    aliases: [{ accelerator: 'Ctrl+Shift+I' }, { accelerator: 'F12' }],
    context: 'both',
    category: 'Developer',
    // F12 / DevTools bindings are part of the reserved set — not remappable.
    editable: false,
  },
  {
    id: 'devtools.toggleApp',
    description: 'App Developer Tools',
    defaultAccelerator: 'CmdOrCtrl+Shift+Alt+I',
    context: 'menu',
    category: 'Developer',
    // Dev-build-only menu entry; never shown as remappable and hidden
    // from the Shortcuts settings page in packaged builds.
    editable: false,
    devOnly: true,
  },
];

// ── Accelerator parsing / matching (mirror — keep in sync) ──────────────

const MODIFIER_TOKENS = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
};

const KEY_ALIASES = {
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  plus: 'Plus',
};

const CODE_BASE_KEYS = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
};

export function canonicalKey(rawKey) {
  if (rawKey === undefined || rawKey === null || rawKey === '') return null;
  const raw = String(rawKey);
  if (raw.length === 1) {
    if (raw === ' ') return 'Space';
    if (raw === '+') return 'Plus';
    return raw.toLowerCase();
  }
  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return lower.toUpperCase();
  // Unknown named key (media keys, etc.) — keep as-is so it still compares
  // consistently between accelerator strings and KeyboardEvent.key.
  return raw;
}

export function parseAccelerator(accelerator, platform) {
  if (typeof accelerator !== 'string' || accelerator.length === 0) return null;
  const parts = accelerator.split('+');
  const parsed = { key: null, ctrl: false, alt: false, shift: false, meta: false };

  for (const part of parts) {
    if (part === '') return null;
    const token = part.toLowerCase();
    if (token === 'cmdorctrl' || token === 'commandorcontrol') {
      if (platform === 'darwin') parsed.meta = true;
      else parsed.ctrl = true;
      continue;
    }
    if (MODIFIER_TOKENS[token]) {
      parsed[MODIFIER_TOKENS[token]] = true;
      continue;
    }
    if (parsed.key !== null) return null; // two non-modifier keys
    parsed.key = canonicalKey(part);
  }

  if (!parsed.key) return null;
  return parsed;
}

export function eventKeyCandidates(event) {
  const candidates = new Set();
  const fromKey = canonicalKey(event?.key);
  if (fromKey && !['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(String(event.key))) {
    candidates.add(fromKey);
  }
  const code = event?.code;
  if (typeof code === 'string') {
    if (CODE_BASE_KEYS[code]) {
      candidates.add(CODE_BASE_KEYS[code]);
    } else if (/^Key[A-Z]$/.test(code)) {
      candidates.add(code.slice(3).toLowerCase());
    } else if (/^Digit\d$/.test(code)) {
      candidates.add(code.slice(5));
    }
  }
  return candidates;
}

export function eventMatchesAccelerator(event, accelerator, platform) {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed || !event) return false;

  if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  if (Boolean(event.metaKey) !== parsed.meta) return false;

  return eventKeyCandidates(event).has(parsed.key);
}

// The only keys safe to bind without a real modifier: function keys never
// type or edit text, so a bare binding cannot fire mid-typing. Everything
// else — printable characters and named editing/navigation keys (Enter,
// Space, Backspace, Delete, Tab, arrows, Home/End/Page keys, …) — needs
// Ctrl/Alt/Cmd. Escape is deliberately not allowlisted: it is the
// universal cancel/dismiss gesture inside dialogs and text fields.
const SAFE_BARE_KEY_RE = /^F([1-9]|1\d|2[0-4])$/;

/**
 * True when `accelerator` would fire while the user is typing if bound
 * as-is: no real modifier (Ctrl/Alt/Cmd — Shift alone does not count) and
 * a key outside the safe-bare allowlist. Applies to every action scope;
 * renderer-only shortcuts listen globally too.
 */
export function acceleratorNeedsModifier(accelerator, platform) {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed) return false;
  if (parsed.ctrl || parsed.alt || parsed.meta) return false;
  return !SAFE_BARE_KEY_RE.test(parsed.key);
}

export function getShortcutById(id) {
  return SHORTCUTS.find((entry) => entry.id === id) || null;
}

export function getDefaultAccelerator(entryOrId, platform) {
  const entry = typeof entryOrId === 'string' ? getShortcutById(entryOrId) : entryOrId;
  if (!entry) return null;
  const def = entry.defaultAccelerator;
  if (typeof def === 'string') return def;
  if (def && typeof def === 'object') return def[platform] || def.other || null;
  return null;
}

export function getAliasAccelerators(entryOrId, platform) {
  const entry = typeof entryOrId === 'string' ? getShortcutById(entryOrId) : entryOrId;
  if (!entry || !Array.isArray(entry.aliases)) return [];
  return entry.aliases
    .filter((alias) => !alias.platforms || alias.platforms.includes(platform))
    .map((alias) => alias.accelerator);
}

// ── Renderer-side state ─────────────────────────────────────────────────

const detectPlatform = () => {
  const nav = globalThis.navigator;
  const probe = `${nav?.platform || ''} ${nav?.userAgent || ''}`.toLowerCase();
  if (probe.includes('mac')) return 'darwin';
  if (probe.includes('win')) return 'win32';
  return 'linux';
};

const state = {
  platform: null, // resolved lazily so tests can configure before first use
  overrides: {}, // shortcut id → accelerator string (user remaps)
};

const getPlatform = () => {
  if (!state.platform) state.platform = detectPlatform();
  return state.platform;
};

const applySettings = (settings) => {
  const raw = settings?.shortcutOverrides;
  state.overrides = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
};

/**
 * Configure the module explicitly (unit tests, or callers that already
 * know the platform). Any field may be omitted.
 */
export const configureShortcuts = ({ platform, overrides } = {}) => {
  if (platform) state.platform = platform;
  if (overrides !== undefined) applySettings({ shortcutOverrides: overrides });
};

/**
 * Load the current overrides and keep them live. Safe to call in
 * environments without electronAPI (overrides simply stay empty).
 */
export const initShortcuts = () => {
  window.electronAPI
    ?.getSettings?.()
    .then((settings) => applySettings(settings))
    .catch(() => {});
  // Preload re-dispatches main's settings:updated broadcast as a window
  // CustomEvent — remaps apply live, no restart needed.
  window.addEventListener?.('settings:updated', (event) => applySettings(event.detail));
};

/**
 * Effective primary accelerator for a shortcut: user override, else the
 * registry default for this platform.
 */
export const getEffectiveAccelerator = (id) => {
  const override = state.overrides[id];
  if (typeof override === 'string' && override) return override;
  return getDefaultAccelerator(id, getPlatform());
};

// True for events originating in editable UI — inputs, textareas, selects,
// contenteditable regions — where modifier-less bindings must never fire.
const isEditableEventTarget = (target) => {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

/**
 * True when a keydown event matches the shortcut's effective primary
 * accelerator or one of its fixed aliases. Keydown handlers resolve every
 * shortcut through this so user remaps apply without a restart.
 *
 * Defense in depth: validation and sanitizeOverrides already reject
 * modifier-less typing/editing keys, but should one still reach the
 * renderer (stale store, out-of-band settings edit), it is ignored while
 * the user is typing in an editable target.
 */
export const matchesShortcut = (event, id) => {
  const platform = getPlatform();
  const editable = isEditableEventTarget(event?.target);
  const matches = (accelerator) =>
    Boolean(accelerator) &&
    eventMatchesAccelerator(event, accelerator, platform) &&
    !(editable && acceleratorNeedsModifier(accelerator, platform));
  if (matches(getEffectiveAccelerator(id))) return true;
  return getAliasAccelerators(id, platform).some(matches);
};
