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
 *   description        menu-item label, Title Case (the macOS convention)
 *   settingsLabel      optional sentence-case label for Settings >
 *                      Shortcuts, where every other row label is sentence
 *                      case; falls back to `description` when absent
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
    settingsLabel: 'New tab',
    defaultAccelerator: 'CmdOrCtrl+T',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.close',
    description: 'Close Tab',
    settingsLabel: 'Close tab',
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
    settingsLabel: 'Reopen closed tab',
    defaultAccelerator: 'CmdOrCtrl+Shift+T',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.next',
    description: 'Next Tab',
    settingsLabel: 'Next tab',
    defaultAccelerator: 'Ctrl+PageDown',
    aliases: [{ accelerator: 'Ctrl+Tab' }, { accelerator: 'Cmd+Shift+]', platforms: ['darwin'] }],
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.previous',
    description: 'Previous Tab',
    settingsLabel: 'Previous tab',
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
    settingsLabel: 'Move tab right',
    defaultAccelerator: 'Ctrl+Shift+PageDown',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },
  {
    id: 'tab.moveLeft',
    description: 'Move Tab Left',
    settingsLabel: 'Move tab left',
    defaultAccelerator: 'Ctrl+Shift+PageUp',
    context: 'both',
    category: 'Tabs',
    editable: true,
  },

  // Page
  {
    id: 'page.reload',
    description: 'Reload This Page',
    settingsLabel: 'Reload this page',
    defaultAccelerator: 'CmdOrCtrl+R',
    context: 'both',
    category: 'Page',
    editable: true,
  },
  {
    id: 'page.hardReload',
    description: 'Force Reload This Page',
    settingsLabel: 'Force reload this page',
    defaultAccelerator: 'CmdOrCtrl+Shift+R',
    context: 'both',
    category: 'Page',
    editable: true,
  },
  {
    id: 'page.findInPage',
    description: 'Find in Page',
    settingsLabel: 'Find in page',
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
    settingsLabel: 'Zoom in',
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
    settingsLabel: 'Zoom out',
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
    settingsLabel: 'Actual size',
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
    settingsLabel: 'Focus address bar',
    defaultAccelerator: 'CmdOrCtrl+L',
    context: 'both',
    category: 'Navigation',
    editable: true,
  },
  {
    id: 'history.showAll',
    description: 'Show All History',
    settingsLabel: 'Show all history',
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
    settingsLabel: 'New window',
    defaultAccelerator: 'CmdOrCtrl+N',
    context: 'menu',
    category: 'Window',
    editable: true,
  },
  {
    id: 'window.newPrivate',
    description: 'New Private Window',
    settingsLabel: 'New private window',
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
    settingsLabel: 'Toggle full screen',
    defaultAccelerator: 'F11',
    context: 'both',
    category: 'Window',
    editable: true,
  },
  {
    id: 'view.toggleBookmarksBar',
    description: 'Toggle Bookmarks Bar',
    settingsLabel: 'Toggle bookmarks bar',
    defaultAccelerator: 'CmdOrCtrl+Shift+B',
    context: 'menu',
    category: 'Window',
    editable: true,
  },
  {
    id: 'view.toggleSidebar',
    description: 'Toggle Wallet Sidebar',
    settingsLabel: 'Toggle wallet sidebar',
    defaultAccelerator: 'CmdOrCtrl+Shift+W',
    context: 'renderer',
    category: 'Window',
    editable: true,
  },

  // Developer
  {
    id: 'devtools.toggle',
    description: 'Developer Tools',
    settingsLabel: 'Developer tools',
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
    settingsLabel: 'App developer tools',
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

// ── Physical-keypress model (conflict detection) ────────────────────────
//
// eventMatchesAccelerator accepts a press when the accelerator's key is in
// eventKeyCandidates — the layout-produced key *or* the physical code's
// base key. So two string-distinct accelerators can both fire on one press:
// on a German layout Shift+0 produces '=', and Ctrl+Shift+0 arrives as
// { key: '=', code: 'Digit0' }, matching both `Ctrl+Shift+0` and
// `CmdOrCtrl+Shift+=` (#205). Conflict checks therefore have to ask "is
// there a press both would match?", which needs to know what presses
// exist: which character each physical key produces, per layout and
// Shift state.
//
// US_LAYOUT is the base; LAYOUT_DIFFS lists only the keys each layout
// changes, as [unshifted, shifted] with null for a dead key (the browser
// reports key 'Dead'). Generated from the xkb symbol tables
// (/usr/share/X11/xkb/symbols, `pc+<layout>` compiled with xkbcomp), levels
// 1–2 of Group1 — not written from memory. Finnish is identical to Swedish
// on these keys and so is covered by `se`. Deliberately out of scope: the
// AltGr/Option levels (a Ctrl+Alt or macOS Option chord can produce yet
// another character) and layouts outside this list; extend the table if a
// new layout matters. Menu accelerators are matched by Electron's own
// native code, not by this model.
const US_SHIFTED_PUNCTUATION = {
  Minus: '_',
  Equal: '+',
  BracketLeft: '{',
  BracketRight: '}',
  Semicolon: ':',
  Quote: '"',
  Backquote: '~',
  Backslash: '|',
  Comma: '<',
  Period: '>',
  Slash: '?',
};
const US_SHIFTED_DIGITS = ')!@#$%^&*(';

const US_LAYOUT = {
  ...Object.fromEntries(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => [`Key${l}`, [l.toLowerCase(), l]])
  ),
  ...Object.fromEntries(
    US_SHIFTED_DIGITS.split('').map((shifted, digit) => [`Digit${digit}`, [String(digit), shifted]])
  ),
  ...Object.fromEntries(
    Object.entries(US_SHIFTED_PUNCTUATION).map(([code, shifted]) => [
      code,
      [CODE_BASE_KEYS[code], shifted],
    ])
  ),
};

const LAYOUT_DIFFS = {
  // UK (gb)
  gb: {
    Digit2: ['2', '"'],
    Digit3: ['3', '£'],
    Quote: ["'", '@'],
    Backquote: ['`', '¬'],
    Backslash: ['#', '~'],
  },
  // German (de)
  de: {
    Digit2: ['2', '"'],
    Digit3: ['3', '§'],
    Digit6: ['6', '&'],
    Digit7: ['7', '/'],
    Digit8: ['8', '('],
    Digit9: ['9', ')'],
    Digit0: ['0', '='],
    Minus: ['ß', '?'],
    Equal: [null, null],
    KeyY: ['z', 'Z'],
    BracketLeft: ['ü', 'Ü'],
    BracketRight: ['+', '*'],
    Semicolon: ['ö', 'Ö'],
    Quote: ['ä', 'Ä'],
    Backquote: [null, '°'],
    Backslash: ['#', "'"],
    KeyZ: ['y', 'Y'],
    Comma: [',', ';'],
    Period: ['.', ':'],
    Slash: ['-', '_'],
  },
  // Swiss German (ch)
  ch: {
    Digit1: ['1', '+'],
    Digit2: ['2', '"'],
    Digit3: ['3', '*'],
    Digit4: ['4', 'ç'],
    Digit6: ['6', '&'],
    Digit7: ['7', '/'],
    Digit8: ['8', '('],
    Digit9: ['9', ')'],
    Digit0: ['0', '='],
    Minus: ["'", '?'],
    Equal: [null, null],
    KeyY: ['z', 'Z'],
    BracketLeft: ['ü', 'è'],
    BracketRight: [null, '!'],
    Semicolon: ['ö', 'é'],
    Quote: ['ä', 'à'],
    Backquote: ['§', '°'],
    Backslash: ['$', '£'],
    KeyZ: ['y', 'Y'],
    Comma: [',', ';'],
    Period: ['.', ':'],
    Slash: ['-', '_'],
  },
  // French AZERTY (fr)
  fr: {
    Digit1: ['&', '1'],
    Digit2: ['é', '2'],
    Digit3: ['"', '3'],
    Digit4: ["'", '4'],
    Digit5: ['(', '5'],
    Digit6: ['-', '6'],
    Digit7: ['è', '7'],
    Digit8: ['_', '8'],
    Digit9: ['ç', '9'],
    Digit0: ['à', '0'],
    Minus: [')', '°'],
    KeyQ: ['a', 'A'],
    KeyW: ['z', 'Z'],
    BracketLeft: [null, null],
    BracketRight: ['$', '£'],
    KeyA: ['q', 'Q'],
    Semicolon: ['m', 'M'],
    Quote: ['ù', '%'],
    Backquote: ['²', '~'],
    Backslash: ['*', 'µ'],
    KeyZ: ['w', 'W'],
    KeyM: [',', '?'],
    Comma: [';', '.'],
    Period: [':', '/'],
    Slash: ['!', '§'],
  },
  // Spanish (es)
  es: {
    Digit2: ['2', '"'],
    Digit3: ['3', '·'],
    Digit6: ['6', '&'],
    Digit7: ['7', '/'],
    Digit8: ['8', '('],
    Digit9: ['9', ')'],
    Digit0: ['0', '='],
    Minus: ["'", '?'],
    Equal: ['¡', '¿'],
    BracketLeft: [null, null],
    BracketRight: ['+', '*'],
    Semicolon: ['ñ', 'Ñ'],
    Quote: [null, null],
    Backquote: ['º', 'ª'],
    Backslash: ['ç', 'Ç'],
    Comma: [',', ';'],
    Period: ['.', ':'],
    Slash: ['-', '_'],
  },
  // Italian (it)
  it: {
    Digit2: ['2', '"'],
    Digit3: ['3', '£'],
    Digit6: ['6', '&'],
    Digit7: ['7', '/'],
    Digit8: ['8', '('],
    Digit9: ['9', ')'],
    Digit0: ['0', '='],
    Minus: ["'", '?'],
    Equal: ['ì', '^'],
    BracketLeft: ['è', 'é'],
    BracketRight: ['+', '*'],
    Semicolon: ['ò', 'ç'],
    Quote: ['à', '°'],
    Backquote: ['\\', '|'],
    Backslash: ['ù', '§'],
    Comma: [',', ';'],
    Period: ['.', ':'],
    Slash: ['-', '_'],
  },
  // Swedish / Finnish (se)
  se: {
    Digit2: ['2', '"'],
    Digit4: ['4', '¤'],
    Digit6: ['6', '&'],
    Digit7: ['7', '/'],
    Digit8: ['8', '('],
    Digit9: ['9', ')'],
    Digit0: ['0', '='],
    Minus: ['+', '?'],
    Equal: [null, null],
    BracketLeft: ['å', 'Å'],
    BracketRight: [null, null],
    Semicolon: ['ö', 'Ö'],
    Quote: ['ä', 'Ä'],
    Backquote: ['§', '½'],
    Backslash: ["'", '*'],
    Comma: [',', ';'],
    Period: ['.', ':'],
    Slash: ['-', '_'],
  },
  // Norwegian (no)
  no: {
    Digit2: ['2', '"'],
    Digit4: ['4', '¤'],
    Digit6: ['6', '&'],
    Digit7: ['7', '/'],
    Digit8: ['8', '('],
    Digit9: ['9', ')'],
    Digit0: ['0', '='],
    Minus: ['+', '?'],
    Equal: ['\\', null],
    BracketLeft: ['å', 'Å'],
    BracketRight: [null, null],
    Semicolon: ['ø', 'Ø'],
    Quote: ['æ', 'Æ'],
    Backquote: ['|', '§'],
    Backslash: ["'", '*'],
    Comma: [',', ';'],
    Period: ['.', ':'],
    Slash: ['-', '_'],
  },
  // Danish (dk)
  dk: {
    Digit2: ['2', '"'],
    Digit4: ['4', '¤'],
    Digit6: ['6', '&'],
    Digit7: ['7', '/'],
    Digit8: ['8', '('],
    Digit9: ['9', ')'],
    Digit0: ['0', '='],
    Minus: ['+', '?'],
    Equal: [null, null],
    BracketLeft: ['å', 'Å'],
    BracketRight: [null, null],
    Semicolon: ['æ', 'Æ'],
    Quote: ['ø', 'Ø'],
    Backquote: ['½', '§'],
    Backslash: ["'", '*'],
    Comma: [',', ';'],
    Period: ['.', ':'],
    Slash: ['-', '_'],
  },
};

// Keypad keys produce their NumLock-on character or, NumLock off, a
// navigation key — both states are live presses, in either Shift state.
const NUMPAD_PRODUCED_KEYS = {
  Numpad0: ['0', 'Insert'],
  Numpad1: ['1', 'End'],
  Numpad2: ['2', 'ArrowDown'],
  Numpad3: ['3', 'PageDown'],
  Numpad4: ['4', 'ArrowLeft'],
  Numpad5: ['5', 'Clear'],
  Numpad6: ['6', 'ArrowRight'],
  Numpad7: ['7', 'Home'],
  Numpad8: ['8', 'ArrowUp'],
  Numpad9: ['9', 'PageUp'],
  NumpadDecimal: ['.', ',', 'Delete'],
  NumpadAdd: ['+'],
  NumpadSubtract: ['-'],
  NumpadMultiply: ['*'],
  NumpadDivide: ['/'],
};

let keyCollisionCache = null;

// For each Shift state, canonical key → every other canonical key that
// some modelled press reports alongside it in eventKeyCandidates.
function keyCollisions() {
  if (keyCollisionCache) return keyCollisionCache;
  const collisions = { false: new Map(), true: new Map() };
  const addPress = (shift, key, code) => {
    const candidates = [...eventKeyCandidates({ key: key ?? 'Dead', code })];
    for (const a of candidates) {
      for (const b of candidates) {
        if (a === b) continue;
        if (!collisions[shift].has(a)) collisions[shift].set(a, new Set());
        collisions[shift].get(a).add(b);
      }
    }
  };
  for (const diffs of [{}, ...Object.values(LAYOUT_DIFFS)]) {
    const layout = { ...US_LAYOUT, ...diffs };
    for (const [code, [unshifted, shifted]] of Object.entries(layout)) {
      addPress(false, unshifted, code);
      addPress(true, shifted, code);
    }
  }
  for (const [code, keys] of Object.entries(NUMPAD_PRODUCED_KEYS)) {
    for (const key of keys) {
      addPress(false, key, code);
      addPress(true, key, code);
    }
  }
  keyCollisionCache = collisions;
  return collisions;
}

/**
 * True when one physical keypress (on a modelled layout) would satisfy
 * eventMatchesAccelerator for both accelerators — i.e. binding both would
 * double-fire. Identical accelerators trivially collide.
 */
function acceleratorsCollide(a, b, platform) {
  const pa = parseAccelerator(a, platform);
  const pb = parseAccelerator(b, platform);
  if (!pa || !pb) return false;
  if (pa.ctrl !== pb.ctrl || pa.alt !== pb.alt || pa.shift !== pb.shift || pa.meta !== pb.meta) {
    return false;
  }
  if (pa.key === pb.key) return true;
  return Boolean(keyCollisions()[pa.shift].get(pa.key)?.has(pb.key));
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
const KNOWN_NAMED_KEYS = new Set(Object.values(KEY_ALIASES).filter((key) => key !== 'Escape'));
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
 * A shortcut whose effective binding or fixed alias collides with
 * `accelerator`, excluding `entryOrId` itself. "Collides" means one physical
 * keypress would fire both (acceleratorsCollide), not string equality — the
 * keydown matcher accepts layout-produced keys, so string-distinct chords
 * can double-fire (#205). Returns null or { id, settingsLabel, fixed } —
 * `fixed: true` means a swap cannot clear it: the collision is with a fixed
 * alias, a non-editable entry, or more than one binding at once, or the
 * swapped state would itself collide (the binding handed over fires on the
 * same press as the new one).
 *
 * Every consumer of this name is a Settings > Shortcuts surface (the
 * conflict banner, the reverted-remap row notice), which labels its rows
 * `settingsLabel`, so the conflict names the colliding shortcut the same
 * way — carrying `description` here is what put one shortcut on screen in
 * two casings at once (#277).
 */
function findConflict(entryOrId, accelerator, overrides, platform) {
  return collectConflict(entryOrId, accelerator, overrides, platform, true);
}

function collectConflict(entryOrId, accelerator, overrides, platform, checkSwap) {
  const self = typeof entryOrId === 'string' ? entryOrId : entryOrId?.id;
  const normalized = normalizeAccelerator(accelerator, platform);
  if (!normalized) return null;

  const conflict = (entry, fixed) => ({
    id: entry.id,
    settingsLabel: entry.settingsLabel || entry.description,
    fixed,
  });

  // Collect every colliding entry before answering: since conflicts are
  // judged per keypress (acceleratorsCollide), one chord can collide with
  // several bindings at once — e.g. keypad minus with Zoom Out's main-row
  // default *and* its fixed `numsub` alias. A swap hands exactly one entry
  // this shortcut's old binding, so it only resolves the conflict when a
  // single swappable binding collides; anything else is reported as fixed.
  //
  // Collisions the registry itself ships between two entries' *built-in*
  // bindings are not the user's doing and are resolved by dispatch order
  // (the Nordic Ctrl++ press matching both Zoom In's `Plus` alias and Zoom
  // Out's `-` default; see shortcuts.test.js, which pins that list). Putting
  // a shortcut back on its own default must not be refused over one.
  const selfEntry = getShortcutById(self);
  const selfDefault = selfEntry ? getDefaultAccelerator(selfEntry, platform) : null;
  const isOwnDefault =
    Boolean(selfDefault) && normalizeAccelerator(selfDefault, platform) === normalized;
  const collides = (binding) =>
    Boolean(binding) && acceleratorsCollide(binding, normalized, platform);

  const hits = [];
  for (const entry of SHORTCUTS) {
    if (entry.id === self) continue;
    const effective = getEffectiveAccelerator(entry, overrides, platform);
    const effectiveIsDefault =
      normalizeAccelerator(effective, platform) ===
      normalizeAccelerator(getDefaultAccelerator(entry, platform), platform);
    if (!isOwnDefault && getAliasAccelerators(entry, platform).some(collides)) {
      hits.push({ entry, fixed: true });
    } else if (!(isOwnDefault && effectiveIsDefault) && collides(effective)) {
      hits.push({ entry, fixed: entry.editable === false });
    }
  }
  if (hits.length === 0) return null;
  const firstFixed = hits.find((hit) => hit.fixed);
  if (firstFixed) return conflict(firstFixed.entry, true);
  if (hits.length > 1) return conflict(hits[0].entry, true);

  // One swappable binding collides. A swap hands it this shortcut's
  // previous binding, which is only a resolution if the swapped state is
  // itself conflict-free: per keypress, that previous binding can collide
  // with the *new* one (Ctrl+Alt+Shift+0 and Ctrl+Alt+Shift+= are one German
  // press), and sanitizeOverrides would then drop the remap the user just
  // made. Simulate the swap exactly as setOverride applies it and offer it
  // only when both sides stand.
  const other = hits[0].entry;
  if (checkSwap && selfEntry) {
    const previous = normalizeAccelerator(
      getEffectiveAccelerator(selfEntry, overrides, platform),
      platform
    );
    const swapped = { ...(overrides || {}), [other.id]: previous, [self]: normalized };
    if (
      !previous ||
      collectConflict(selfEntry, normalized, swapped, platform, false) ||
      collectConflict(other, previous, swapped, platform, false)
    ) {
      return conflict(other, true);
    }
  }
  return conflict(other, false);
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
      // No swap is offered here, so skip findConflict's swap simulation:
      // only whether (and with what) the override collides matters.
      const conflict = collectConflict(entry, accelerator, clean, platform, false);
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
  acceleratorsCollide,
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
