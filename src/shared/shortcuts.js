/**
 * Keyboard Shortcut Registry
 *
 * Canonical source of truth for every keyboard shortcut the app implements,
 * plus the pure helpers that turn Electron accelerator strings into
 * per-platform KeyboardEvent matchers.
 *
 * Consumers:
 *   - src/main/menu.js builds all menu accelerators from this registry
 *     (a menu.test.js guard asserts menu.js carries no accelerator literals).
 *   - The renderer keydown handlers resolve through the ESM mirror in
 *     src/renderer/lib/shortcuts.js (ES modules cannot require() this file;
 *     keep both in sync — the mirror's test asserts equivalence).
 *
 * Entry shape:
 *   id                 stable identifier, also the key for user overrides
 *   description        user-facing label (Settings > Shortcuts)
 *   defaultAccelerator Electron accelerator string, or a per-platform map
 *                      ({ darwin, win32, linux, other }) when platforms
 *                      genuinely differ (e.g. Show All History)
 *   aliases            fixed secondary bindings that always stay active and
 *                      are never remapped ([{ accelerator, platforms? }])
 *   context            'menu' | 'renderer' | 'both' — where the binding is
 *                      enforced today (menu accelerator, renderer keydown
 *                      fallback, or both)
 *   category           Settings > Shortcuts group header
 *   editable           false for reserved bindings (DevTools F12 contract,
 *                      dev-only entries)
 *   warnOnEdit         show a caution when the user rebinds (Close Tab)
 */

// ── Registry ────────────────────────────────────────────────────────────

const SHORTCUTS = [
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
  // Zoom acts on the active <webview>, not the chrome — hence custom View
  // items rather than Electron's zoomIn/zoomOut/resetZoom roles, which
  // step zoomLevel on the focused webContents and would bypass both this
  // registry and the hamburger menu's zoom readout.
  //
  // Zoom is the first binding to sit on punctuation that is not reachable
  // unshifted on every layout, so it carries the aliases mainstream
  // browsers bind (see the alias notes on each entry). Aliases are hidden
  // View-menu rows, so the visible menu still shows one row per action.
  {
    id: 'page.zoomIn',
    description: 'Zoom In',
    defaultAccelerator: 'CmdOrCtrl+=',
    // `=` is a shifted key on many layouts (German, Spanish, Italian, Swiss
    // and the Nordic ones all put it on Shift+0 — French does not: there `=`
    // is unshifted and the *digits* are shifted, which `Digit0` already
    // covers), and
    // eventMatchesAccelerator demands an exact modifier match, so the bare
    // `CmdOrCtrl+=` binding can never fire there. `CmdOrCtrl+Shift+=` is
    // also the chord a US-layout user presses for a literal `+`. `Plus`
    // covers layouts where `+` is unshifted (Nordic), and `numadd` the
    // numeric keypad, which Electron treats as a distinct key.
    aliases: [
      { accelerator: 'CmdOrCtrl+Shift+=' },
      { accelerator: 'CmdOrCtrl+Plus' },
      { accelerator: 'CmdOrCtrl+numadd' },
    ],
    context: 'both',
    category: 'Page',
    editable: true,
  },
  {
    id: 'page.zoomOut',
    description: 'Zoom Out',
    defaultAccelerator: 'CmdOrCtrl+-',
    // Keypad minus is a distinct key to Electron's accelerator parser, so
    // the main-row binding above does not cover it.
    aliases: [{ accelerator: 'CmdOrCtrl+numsub' }],
    context: 'both',
    category: 'Page',
    editable: true,
  },
  {
    id: 'page.zoomReset',
    description: 'Actual Size',
    defaultAccelerator: 'CmdOrCtrl+0',
    // Keypad zero, for the same reason as Zoom Out's keypad alias.
    aliases: [{ accelerator: 'CmdOrCtrl+num0' }],
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
    // accelerator never reaches the app.
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

// ── Accelerator parsing / matching ──────────────────────────────────────

// Electron modifier tokens → the KeyboardEvent modifier they assert.
// 'cmdorctrl' is resolved per platform in parseAccelerator.
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

// Numeric-keypad KeyboardEvent.code → Electron's own accelerator spelling
// for that key. The keypad is a separate physical key set as far as the
// accelerator parser is concerned: a `CmdOrCtrl+-` menu accelerator never
// fires for keypad minus, so bindings that want both carry a `num*` alias
// next to the main-row one.
const NUMPAD_CODE_KEYS = {
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  Numpad0: 'num0',
  Numpad1: 'num1',
  Numpad2: 'num2',
  Numpad3: 'num3',
  Numpad4: 'num4',
  Numpad5: 'num5',
  Numpad6: 'num6',
  Numpad7: 'num7',
  Numpad8: 'num8',
  Numpad9: 'num9',
};

// Electron/legacy key spellings → canonical names used for comparison.
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
  // Keypad keys keep Electron's own spelling; listed here so canonicalKey
  // normalizes their case and isRecognizedKey accepts them.
  ...Object.fromEntries(Object.values(NUMPAD_CODE_KEYS).map((key) => [key, key])),
};

// KeyboardEvent.code → the base (unshifted, US-layout) character. Used both
// to match shifted punctuation (Cmd+Shift+] arrives as key '}' on some
// layouts) and to record layout-stable overrides.
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

function canonicalKey(rawKey) {
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

/**
 * Parse an Electron accelerator string into { key, ctrl, alt, shift, meta }.
 * CmdOrCtrl resolves per `platform` ('darwin' → meta, otherwise ctrl).
 * Returns null when the string is not a usable accelerator (no key, more
 * than one key, unknown modifier arrangement).
 */
function parseAccelerator(accelerator, platform) {
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

// Candidate canonical keys for a KeyboardEvent: the layout-produced key plus
// the physical-code base character (so Shift'ed punctuation still matches).
function eventKeyCandidates(event) {
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
    } else if (NUMPAD_CODE_KEYS[code]) {
      candidates.add(NUMPAD_CODE_KEYS[code]);
    }
  }
  return candidates;
}

/**
 * Strict accelerator ↔ KeyboardEvent match: every modifier must agree
 * (Cmd+W does not match Cmd+Shift+W) and the key must match either the
 * event's produced key or its physical base key.
 */
function eventMatchesAccelerator(event, accelerator, platform) {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed || !event) return false;

  if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  if (Boolean(event.metaKey) !== parsed.meta) return false;

  return eventKeyCandidates(event).has(parsed.key);
}

// ── Registry lookups ────────────────────────────────────────────────────

function getShortcutById(id) {
  return SHORTCUTS.find((entry) => entry.id === id) || null;
}

/**
 * Default accelerator for an entry on `platform`. Accepts an entry object
 * or an id. Platform-map defaults fall back to `other`.
 */
function getDefaultAccelerator(entryOrId, platform) {
  const entry = typeof entryOrId === 'string' ? getShortcutById(entryOrId) : entryOrId;
  if (!entry) return null;
  const def = entry.defaultAccelerator;
  if (typeof def === 'string') return def;
  if (def && typeof def === 'object') return def[platform] || def.other || null;
  return null;
}

/**
 * Fixed (non-remappable) secondary accelerators for an entry on `platform`.
 */
function getAliasAccelerators(entryOrId, platform) {
  const entry = typeof entryOrId === 'string' ? getShortcutById(entryOrId) : entryOrId;
  if (!entry || !Array.isArray(entry.aliases)) return [];
  return entry.aliases
    .filter((alias) => !alias.platforms || alias.platforms.includes(platform))
    .map((alias) => alias.accelerator);
}

// ── Overrides / validation / conflicts ──────────────────────────────────

// Bindings that may never be reassigned to a shortcut: quit, the standard
// edit-role clipboard set (they come from Electron menu roles, not this
// registry), and the F12 DevTools contract.
const RESERVED_ACCELERATORS = [
  'CmdOrCtrl+Q',
  'CmdOrCtrl+C',
  'CmdOrCtrl+V',
  'CmdOrCtrl+X',
  'CmdOrCtrl+A',
  'CmdOrCtrl+Z',
  'CmdOrCtrl+Shift+Z',
  'F12',
];

/**
 * Canonical string form of an accelerator on `platform`, for storage and
 * equality comparison: modifiers in fixed order (Ctrl, Alt, Shift, then
 * Cmd/Super), single-character keys uppercased. Returns null when the
 * accelerator does not parse.
 */
function normalizeAccelerator(accelerator, platform) {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed) return null;
  const parts = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  if (parsed.meta) parts.push(platform === 'darwin' ? 'Cmd' : 'Super');
  parts.push(parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return parts.join('+');
}

function isReservedAccelerator(accelerator, platform) {
  const normalized = normalizeAccelerator(accelerator, platform);
  if (!normalized) return false;
  return RESERVED_ACCELERATORS.some(
    (reserved) => normalizeAccelerator(reserved, platform) === normalized
  );
}

const isModifierEventKey = (key) =>
  ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(String(key));

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
function acceleratorNeedsModifier(accelerator, platform) {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed) return false;
  if (parsed.ctrl || parsed.alt || parsed.meta) return false;
  return !SAFE_BARE_KEY_RE.test(parsed.key);
}

/**
 * Build a normalized accelerator from a keydown event (Settings recording
 * mode). Prefers the physical key code so the stored binding is stable
 * across keyboard layouts. Returns null while only modifiers are held.
 */
function acceleratorFromEvent(event, platform) {
  if (!event || isModifierEventKey(event.key)) return null;

  // Prefer the code-derived base key (layout-stable), fall back to key.
  const candidates = eventKeyCandidates(event);
  let key = null;
  const code = event.code;
  if (typeof code === 'string') {
    if (CODE_BASE_KEYS[code]) key = CODE_BASE_KEYS[code];
    else if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
  }
  if (!key) key = candidates.values().next().value || null;
  if (!key) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push(platform === 'darwin' ? 'Cmd' : 'Super');
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

// Named keys Electron's accelerator parser actually accepts. canonicalKey
// passes unknown names through untouched (media keys, 'Dead' from intl
// dead-key layouts) and Menu silently ignores accelerators built from them
// — the binding would look bound in settings but never fire. Reject those
// at validation instead. Escape is excluded here on purpose: the recorder
// cancels on Escape (with or without modifiers), so accepting it from any
// other path would create bindings the recorder can never produce.
const KNOWN_NAMED_KEYS = new Set(
  Object.values(KEY_ALIASES).filter((key) => key !== 'Escape')
);
function isRecognizedKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (key.length === 1) return true;
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return true;
  return KNOWN_NAMED_KEYS.has(key);
}

/**
 * Whether `accelerator` is assignable to `entry` on `platform`.
 * Returns { ok: true } or { ok: false, reason }, with reason one of
 * 'unknown-shortcut', 'not-editable', 'invalid', 'reserved',
 * 'needs-modifier'. Conflicts with other shortcuts are a separate check
 * (findConflict) so the UI can offer a swap.
 */
function validateBinding(entryOrId, accelerator, platform) {
  const entry = typeof entryOrId === 'string' ? getShortcutById(entryOrId) : entryOrId;
  if (!entry) return { ok: false, reason: 'unknown-shortcut' };
  if (entry.editable === false) return { ok: false, reason: 'not-editable' };

  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed) return { ok: false, reason: 'invalid' };
  if (!isRecognizedKey(parsed.key)) return { ok: false, reason: 'invalid' };
  if (isReservedAccelerator(accelerator, platform)) return { ok: false, reason: 'reserved' };

  // Every scope must carry a real modifier for typing/editing keys: a bare
  // (or shift-only) character, Enter, Space, Backspace, Delete, … would
  // fire while typing in any text field — renderer-only actions included.
  // Only function keys are safe bare (see SAFE_BARE_KEY_RE).
  if (acceleratorNeedsModifier(accelerator, platform)) {
    return { ok: false, reason: 'needs-modifier' };
  }

  return { ok: true };
}

/**
 * Effective primary accelerator: user override ?? registry default.
 */
function getEffectiveAccelerator(entryOrId, overrides, platform) {
  const entry = typeof entryOrId === 'string' ? getShortcutById(entryOrId) : entryOrId;
  if (!entry) return null;
  const override = overrides ? overrides[entry.id] : undefined;
  if (typeof override === 'string' && parseAccelerator(override, platform)) return override;
  return getDefaultAccelerator(entry, platform);
}

/**
 * First shortcut whose effective binding collides with `accelerator`,
 * excluding `entryOrId` itself. Returns null or
 * { id, description, fixed } — `fixed: true` means the collision is with
 * a fixed alias (or a non-editable entry) and cannot be swapped away.
 */
function findConflict(entryOrId, accelerator, overrides, platform) {
  const self = typeof entryOrId === 'string' ? entryOrId : entryOrId?.id;
  const normalized = normalizeAccelerator(accelerator, platform);
  if (!normalized) return null;

  for (const entry of SHORTCUTS) {
    if (entry.id === self) continue;
    const effective = getEffectiveAccelerator(entry, overrides, platform);
    if (effective && normalizeAccelerator(effective, platform) === normalized) {
      return { id: entry.id, description: entry.description, fixed: entry.editable === false };
    }
    for (const alias of getAliasAccelerators(entry, platform)) {
      if (normalizeAccelerator(alias, platform) === normalized) {
        return { id: entry.id, description: entry.description, fixed: true };
      }
    }
  }
  return null;
}

/**
 * Defensive cleanup for a stored/incoming overrides map: drops unknown or
 * non-editable ids, non-string and unparsable values, reserved combos,
 * modifier-less typing/editing keys, and no-op overrides equal to the
 * default. Values are normalized. Never throws — malformed input
 * yields {}.
 *
 * A second pass then applies the same conflict rule Settings > Shortcuts
 * enforces interactively (see setOverride in src/main/shortcuts-ipc.js): a
 * binding already taken by another entry's effective accelerator or fixed
 * alias is refused, and a fixed-alias collision can never be swapped away.
 * Without it, an override recorded while a chord was free — legal then —
 * survives a release that gives that chord to a new default and both fire
 * on one press (e.g. a `Ctrl+0` remap made before `page.zoomReset` existed).
 * Pass `onDrop({ id, accelerator, conflict })` to observe those drops; the
 * settings store logs them and surfaces them as reverted.
 */
function sanitizeOverrides(raw, platform, { onDrop } = {}) {
  const clean = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  for (const [id, value] of Object.entries(raw)) {
    const entry = getShortcutById(id);
    if (!entry || entry.editable === false) continue;
    if (typeof value !== 'string') continue;
    const normalized = normalizeAccelerator(value, platform);
    if (!normalized) continue;
    if (isReservedAccelerator(normalized, platform)) continue;
    if (acceleratorNeedsModifier(normalized, platform)) continue;
    if (normalized === normalizeAccelerator(getDefaultAccelerator(entry, platform), platform)) {
      continue;
    }
    clean[id] = normalized;
  }

  // Conflict pass, walked in registry order so the result never depends on
  // the key order of the stored JSON. Each override is checked against the
  // bindings still standing at that point, and a dropped one falls back to
  // its default straight away — so two overrides that collide only with
  // each other (hand-edited file; the UI cannot produce it) lose exactly
  // one side, not both. A legitimate swap pair, where each override sits on
  // the other entry's freed default, matches nothing and is left alone.
  //
  // Repeated to a fixpoint: a drop reverts that entry to its default, which
  // can collide with an override on an entry *earlier* in registry order
  // that was already checked against the pre-drop state (remap A onto B's
  // chord, then B onto a chord a later release claims — dropping B hands
  // its default back and A now doubles it). Each pass only removes
  // overrides, so at most one pass per override runs before it settles.
  for (let pass = Object.keys(clean).length; pass > 0; pass -= 1) {
    let dropped = false;
    for (const entry of SHORTCUTS) {
      const accelerator = clean[entry.id];
      if (!accelerator) continue;
      const conflict = findConflict(entry, accelerator, clean, platform);
      if (!conflict) continue;
      delete clean[entry.id];
      dropped = true;
      if (typeof onDrop === 'function') onDrop({ id: entry.id, accelerator, conflict });
    }
    if (!dropped) break;
  }

  return clean;
}

// ── Display formatting ──────────────────────────────────────────────────

const MAC_MODIFIER_GLYPHS = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const MAC_KEY_GLYPHS = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
  Tab: '⇥',
  Plus: '+',
};

// Electron's `num*` key codes read like internals in Settings > Shortcuts,
// so show them the way keyboards label them: 'Num +', 'Num 0', …
const NUMPAD_SYMBOLS = { add: '+', sub: '-', mult: '*', div: '/', dec: '.' };
function numpadKeyLabel(key) {
  const match = /^num(\d|add|sub|mult|div|dec)$/.exec(key);
  if (!match) return null;
  return `Num ${NUMPAD_SYMBOLS[match[1]] || match[1]}`;
}

/**
 * Human-readable binding: mac-style glyph run ('⌘⇧K') on darwin,
 * 'Ctrl+Shift+K' elsewhere. Returns '' for unparsable input.
 */
function formatAccelerator(accelerator, platform) {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed) return '';
  const key =
    numpadKeyLabel(parsed.key) || (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);

  if (platform === 'darwin') {
    let out = '';
    if (parsed.ctrl) out += MAC_MODIFIER_GLYPHS.ctrl;
    if (parsed.alt) out += MAC_MODIFIER_GLYPHS.alt;
    if (parsed.shift) out += MAC_MODIFIER_GLYPHS.shift;
    if (parsed.meta) out += MAC_MODIFIER_GLYPHS.meta;
    return out + (MAC_KEY_GLYPHS[key] || key);
  }

  const parts = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  if (parsed.meta) parts.push('Super');
  parts.push(key === 'Plus' ? '+' : key);
  return parts.join('+');
}

module.exports = {
  SHORTCUTS,
  canonicalKey,
  parseAccelerator,
  eventKeyCandidates,
  eventMatchesAccelerator,
  getShortcutById,
  getDefaultAccelerator,
  getAliasAccelerators,
  normalizeAccelerator,
  isReservedAccelerator,
  acceleratorNeedsModifier,
  acceleratorFromEvent,
  validateBinding,
  getEffectiveAccelerator,
  findConflict,
  sanitizeOverrides,
  formatAccelerator,
};
