const {
  SHORTCUTS,
  parseAccelerator,
  eventMatchesAccelerator,
  getShortcutById,
  getDefaultAccelerator,
  getAliasAccelerators,
} = require('./shortcuts');

const PLATFORMS = ['darwin', 'win32', 'linux'];

const keyEvent = (overrides = {}) => ({
  key: 'a',
  code: 'KeyA',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
});

describe('shortcut registry', () => {
  test('ids are unique and entries carry the required fields', () => {
    const ids = SHORTCUTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of SHORTCUTS) {
      expect(typeof entry.id).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
      expect(['menu', 'renderer', 'both']).toContain(entry.context);
      expect(typeof entry.category).toBe('string');
      expect(typeof entry.editable).toBe('boolean');
    }
  });

  test('every default accelerator parses on every platform', () => {
    for (const entry of SHORTCUTS) {
      for (const platform of PLATFORMS) {
        const accelerator = getDefaultAccelerator(entry, platform);
        expect(accelerator).toBeTruthy();
        expect(parseAccelerator(accelerator, platform)).not.toBeNull();
      }
    }
  });

  test('every alias accelerator parses on its platforms', () => {
    for (const entry of SHORTCUTS) {
      for (const platform of PLATFORMS) {
        for (const alias of getAliasAccelerators(entry, platform)) {
          expect(parseAccelerator(alias, platform)).not.toBeNull();
        }
      }
    }
  });

  test('getShortcutById resolves known ids and rejects unknown ones', () => {
    expect(getShortcutById('tab.new')?.description).toBe('New Tab');
    expect(getShortcutById('nope')).toBeNull();
  });

  test('platform-map defaults resolve per platform with `other` fallback', () => {
    expect(getDefaultAccelerator('history.showAll', 'darwin')).toBe('Cmd+Y');
    expect(getDefaultAccelerator('history.showAll', 'win32')).toBe('Ctrl+H');
    expect(getDefaultAccelerator('history.showAll', 'linux')).toBe('Ctrl+H');
  });

  test('aliases filter by platform', () => {
    expect(getAliasAccelerators('tab.close', 'win32')).toEqual(['Ctrl+F4']);
    expect(getAliasAccelerators('tab.close', 'linux')).toEqual(['Ctrl+F4']);
    expect(getAliasAccelerators('tab.close', 'darwin')).toEqual([]);
    expect(getAliasAccelerators('tab.next', 'darwin')).toEqual(['Ctrl+Tab', 'Cmd+Shift+]']);
    expect(getAliasAccelerators('tab.next', 'linux')).toEqual(['Ctrl+Tab']);
  });
});

describe('parseAccelerator', () => {
  test('resolves CmdOrCtrl to meta on macOS and ctrl elsewhere', () => {
    expect(parseAccelerator('CmdOrCtrl+T', 'darwin')).toEqual({
      key: 't',
      ctrl: false,
      alt: false,
      shift: false,
      meta: true,
    });
    expect(parseAccelerator('CmdOrCtrl+T', 'linux')).toEqual({
      key: 't',
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
    });
    expect(parseAccelerator('CommandOrControl+T', 'win32').ctrl).toBe(true);
  });

  test('parses multi-modifier combos and named keys', () => {
    expect(parseAccelerator('Ctrl+Shift+PageDown', 'linux')).toEqual({
      key: 'PageDown',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
    });
    expect(parseAccelerator('Cmd+Alt+I', 'darwin')).toEqual({
      key: 'i',
      ctrl: false,
      alt: true,
      shift: false,
      meta: true,
    });
    expect(parseAccelerator('F11', 'win32')).toEqual({
      key: 'F11',
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  });

  test('rejects malformed accelerators', () => {
    expect(parseAccelerator('', 'linux')).toBeNull();
    expect(parseAccelerator('Ctrl+', 'linux')).toBeNull();
    expect(parseAccelerator('Ctrl+K+J', 'linux')).toBeNull();
    expect(parseAccelerator('Ctrl+Shift', 'linux')).toBeNull();
    expect(parseAccelerator(null, 'linux')).toBeNull();
  });
});

describe('eventMatchesAccelerator', () => {
  test('maps CmdOrCtrl per platform', () => {
    const cmdT = keyEvent({ key: 't', code: 'KeyT', metaKey: true });
    const ctrlT = keyEvent({ key: 't', code: 'KeyT', ctrlKey: true });

    expect(eventMatchesAccelerator(cmdT, 'CmdOrCtrl+T', 'darwin')).toBe(true);
    expect(eventMatchesAccelerator(ctrlT, 'CmdOrCtrl+T', 'darwin')).toBe(false);
    expect(eventMatchesAccelerator(ctrlT, 'CmdOrCtrl+T', 'linux')).toBe(true);
    expect(eventMatchesAccelerator(cmdT, 'CmdOrCtrl+T', 'win32')).toBe(false);
  });

  test('is strict about extra modifiers (Cmd+Shift+W is not Cmd+W)', () => {
    const cmdShiftW = keyEvent({ key: 'W', code: 'KeyW', metaKey: true, shiftKey: true });
    expect(eventMatchesAccelerator(cmdShiftW, 'CmdOrCtrl+W', 'darwin')).toBe(false);
    expect(eventMatchesAccelerator(cmdShiftW, 'CmdOrCtrl+Shift+W', 'darwin')).toBe(true);

    const ctrlAltT = keyEvent({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true });
    expect(eventMatchesAccelerator(ctrlAltT, 'CmdOrCtrl+T', 'linux')).toBe(false);
  });

  test('matches letters case-insensitively (Shift produces uppercase keys)', () => {
    const upper = keyEvent({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true });
    expect(eventMatchesAccelerator(upper, 'Ctrl+Shift+T', 'linux')).toBe(true);
  });

  test('matches named keys and function keys', () => {
    expect(
      eventMatchesAccelerator(
        keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true }),
        'Ctrl+Tab',
        'linux'
      )
    ).toBe(true);
    expect(eventMatchesAccelerator(keyEvent({ key: 'F11', code: 'F11' }), 'F11', 'win32')).toBe(
      true
    );
    expect(
      eventMatchesAccelerator(
        keyEvent({ key: 'PageDown', code: 'PageDown', ctrlKey: true, shiftKey: true }),
        'Ctrl+Shift+PageDown',
        'darwin'
      )
    ).toBe(true);
  });

  test('matches shifted punctuation via the physical key code', () => {
    // On layouts where Shift+] produces '}', the physical code still says
    // BracketRight — Cmd+Shift+] must match either representation.
    const shifted = keyEvent({
      key: '}',
      code: 'BracketRight',
      metaKey: true,
      shiftKey: true,
    });
    const unshifted = keyEvent({
      key: ']',
      code: 'BracketRight',
      metaKey: true,
      shiftKey: true,
    });
    expect(eventMatchesAccelerator(shifted, 'Cmd+Shift+]', 'darwin')).toBe(true);
    expect(eventMatchesAccelerator(unshifted, 'Cmd+Shift+]', 'darwin')).toBe(true);
  });

  test('a bare modifier keydown matches nothing', () => {
    const bareShift = keyEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(eventMatchesAccelerator(bareShift, 'Shift+T', 'linux')).toBe(false);
  });

  test('handles missing code gracefully (synthetic events)', () => {
    const noCode = { key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(eventMatchesAccelerator(noCode, 'CmdOrCtrl+F', 'darwin')).toBe(true);
  });
});

const {
  normalizeAccelerator,
  acceleratorFromEvent,
  validateBinding,
  getEffectiveAccelerator,
  findConflict,
  sanitizeOverrides,
  formatAccelerator,
} = require('./shortcuts');

describe('normalizeAccelerator', () => {
  test('produces a canonical modifier order and key casing', () => {
    expect(normalizeAccelerator('Shift+Ctrl+u', 'linux')).toBe('Ctrl+Shift+U');
    expect(normalizeAccelerator('CmdOrCtrl+T', 'darwin')).toBe('Cmd+T');
    expect(normalizeAccelerator('CmdOrCtrl+T', 'win32')).toBe('Ctrl+T');
    expect(normalizeAccelerator('Ctrl+PageDown', 'linux')).toBe('Ctrl+PageDown');
    expect(normalizeAccelerator('nonsense+', 'linux')).toBeNull();
  });

  test('equates spellings of the same combo', () => {
    expect(normalizeAccelerator('Command+Shift+t', 'darwin')).toBe(
      normalizeAccelerator('CmdOrCtrl+Shift+T', 'darwin')
    );
  });
});

describe('acceleratorFromEvent (recording)', () => {
  test('builds a normalized accelerator from a keydown', () => {
    expect(
      acceleratorFromEvent(
        { key: 'u', code: 'KeyU', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
        'linux'
      )
    ).toBe('Ctrl+Shift+U');
    expect(
      acceleratorFromEvent(
        { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        'darwin'
      )
    ).toBe('Cmd+K');
  });

  test('waits while only modifiers are held', () => {
    expect(
      acceleratorFromEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, 'linux')
    ).toBeNull();
    expect(
      acceleratorFromEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true }, 'darwin')
    ).toBeNull();
  });

  test('prefers the physical key for shifted punctuation', () => {
    expect(
      acceleratorFromEvent(
        { key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true },
        'linux'
      )
    ).toBe('Ctrl+Shift+]');
  });

  test('records function keys without modifiers', () => {
    expect(acceleratorFromEvent({ key: 'F6', code: 'F6' }, 'win32')).toBe('F6');
  });
});

describe('validateBinding', () => {
  test('rejects key names Electron accelerators silently ignore', () => {
    // Dead keys / media keys / unmapped codes pass through canonicalKey
    // unchanged; Menu accepts and silently ignores such accelerators, so a
    // stored binding would look bound but never fire.
    for (const accel of ['Ctrl+Dead', 'Ctrl+AudioVolumeUp', 'Ctrl+IntlBackslash']) {
      expect(validateBinding('tab.new', accel, 'linux')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    // Known named keys and function keys stay bindable.
    expect(validateBinding('tab.new', 'Ctrl+PageDown', 'linux').ok).toBe(true);
    expect(validateBinding('tab.new', 'Ctrl+Up', 'linux').ok).toBe(true);
  });

  test('rejects Escape with or without modifiers, matching the recorder', () => {
    // The recorder cancels on Escape regardless of held modifiers, so no
    // Escape combo may validate through any other path either.
    for (const accel of ['Escape', 'Ctrl+Escape', 'Alt+Escape']) {
      expect(validateBinding('tab.new', accel, 'linux').ok).toBe(false);
    }
  });

  test('rejects reserved combos (quit, edit roles, F12)', () => {
    expect(validateBinding('tab.new', 'CmdOrCtrl+Q', 'darwin')).toEqual({
      ok: false,
      reason: 'reserved',
    });
    expect(validateBinding('tab.new', 'Cmd+C', 'darwin').reason).toBe('reserved');
    expect(validateBinding('tab.new', 'Ctrl+V', 'linux').reason).toBe('reserved');
    expect(validateBinding('tab.new', 'F12', 'win32').reason).toBe('reserved');
  });

  test('rejects bare characters for every scope — renderer-only included', () => {
    expect(validateBinding('tab.new', 'K', 'linux')).toEqual({
      ok: false,
      reason: 'needs-modifier',
    });
    expect(validateBinding('downloads.show', 'Shift+K', 'linux').reason).toBe('needs-modifier');
    // Renderer-only shortcuts listen globally too — bare W must not pass.
    expect(validateBinding('view.toggleSidebar', 'W', 'linux')).toEqual({
      ok: false,
      reason: 'needs-modifier',
    });
    expect(validateBinding('view.toggleSidebar', 'Shift+W', 'darwin').reason).toBe(
      'needs-modifier'
    );
    // Function keys are fine without modifiers…
    expect(validateBinding('tab.new', 'F6', 'linux').ok).toBe(true);
    expect(validateBinding('view.toggleSidebar', 'F5', 'win32').ok).toBe(true);
    // …and real modifiers make characters fine.
    expect(validateBinding('tab.new', 'Alt+K', 'linux').ok).toBe(true);
    expect(validateBinding('view.toggleSidebar', 'Ctrl+Shift+W', 'linux').ok).toBe(true);
  });

  test('rejects modifier-less named editing/navigation keys for every scope', () => {
    const namedKeys = [
      'Enter',
      'Space',
      'Backspace',
      'Delete',
      'Tab',
      'Up',
      'Down',
      'Left',
      'Right',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Insert',
    ];
    for (const id of ['tab.new', 'downloads.show', 'view.toggleSidebar']) {
      for (const key of namedKeys) {
        expect(validateBinding(id, key, 'linux')).toEqual({
          ok: false,
          reason: 'needs-modifier',
        });
      }
    }
    // Shift alone is not a real modifier…
    expect(validateBinding('view.toggleSidebar', 'Shift+Enter', 'linux').reason).toBe(
      'needs-modifier'
    );
    // …Escape is the universal cancel/dismiss key, not bindable at all now
    // (the recorder cancels on it, so validation rejects it outright)…
    expect(validateBinding('tab.new', 'Escape', 'linux').reason).toBe('invalid');
    // …but a real modifier makes named keys fine.
    expect(validateBinding('tab.new', 'Ctrl+Enter', 'linux').ok).toBe(true);
    expect(validateBinding('view.toggleSidebar', 'Alt+Delete', 'darwin').ok).toBe(true);
  });

  test('rejects non-editable and unknown shortcuts', () => {
    expect(validateBinding('devtools.toggle', 'Ctrl+Shift+U', 'linux').reason).toBe('not-editable');
    expect(validateBinding('nope', 'Ctrl+U', 'linux').reason).toBe('unknown-shortcut');
    expect(validateBinding('tab.new', 'garbage+', 'linux').reason).toBe('invalid');
  });
});

describe('override resolution', () => {
  test('effective accelerator is override ?? default', () => {
    expect(getEffectiveAccelerator('tab.new', { 'tab.new': 'Ctrl+Shift+U' }, 'linux')).toBe(
      'Ctrl+Shift+U'
    );
    expect(getEffectiveAccelerator('tab.new', {}, 'linux')).toBe('CmdOrCtrl+T');
    expect(getEffectiveAccelerator('tab.new', null, 'darwin')).toBe('CmdOrCtrl+T');
    // Unparsable overrides are ignored, not propagated.
    expect(getEffectiveAccelerator('tab.new', { 'tab.new': '+bad+' }, 'linux')).toBe('CmdOrCtrl+T');
  });

  test('sanitizeOverrides drops junk and keeps valid remaps normalized', () => {
    const cleaned = sanitizeOverrides(
      {
        'tab.new': 'Shift+Ctrl+u', // valid → normalized
        'tab.close': 'CmdOrCtrl+W', // no-op (equals default) → dropped
        'devtools.toggle': 'Ctrl+U', // not editable → dropped
        'page.reload': 'F12', // reserved → dropped
        unknown: 'Ctrl+U', // unknown id → dropped
        'page.findInPage': 42, // not a string → dropped
        'tab.next': 'bad+', // unparsable → dropped
        'view.toggleSidebar': 'W', // bare character → dropped
        'page.hardReload': 'Enter', // bare editing key → dropped
      },
      'linux'
    );
    expect(cleaned).toEqual({ 'tab.new': 'Ctrl+Shift+U' });

    expect(sanitizeOverrides(null, 'linux')).toEqual({});
    expect(sanitizeOverrides([], 'linux')).toEqual({});
    expect(sanitizeOverrides('junk', 'linux')).toEqual({});
  });
});

describe('findConflict', () => {
  test('detects collisions with effective primaries', () => {
    expect(findConflict('tab.new', 'CmdOrCtrl+W', {}, 'darwin')).toEqual({
      id: 'tab.close',
      description: 'Close Tab',
      fixed: false,
    });
    // Overrides shift what conflicts: tab.close remapped away frees Cmd+W.
    expect(findConflict('tab.new', 'Cmd+W', { 'tab.close': 'Cmd+Shift+X' }, 'darwin')).toBeNull();
  });

  test('collisions with fixed aliases and non-editable entries are fixed', () => {
    expect(findConflict('tab.new', 'Ctrl+Tab', {}, 'linux')).toEqual({
      id: 'tab.next',
      description: 'Next Tab',
      fixed: true,
    });
    expect(findConflict('tab.new', 'Ctrl+Alt+I', {}, 'linux')).toEqual({
      id: 'devtools.toggle',
      description: 'Developer Tools',
      fixed: true,
    });
    // Ctrl+F4 alias only exists on win/linux.
    expect(findConflict('tab.new', 'Ctrl+F4', {}, 'darwin')).toBeNull();
  });

  test('no conflict for a free combo or with itself', () => {
    expect(findConflict('tab.new', 'Ctrl+Shift+U', {}, 'linux')).toBeNull();
    expect(findConflict('tab.new', 'CmdOrCtrl+T', {}, 'linux')).toBeNull();
  });

  test('equates CmdOrCtrl defaults with concrete recorded combos', () => {
    expect(findConflict('tab.close', 'Cmd+T', {}, 'darwin')?.id).toBe('tab.new');
    expect(findConflict('tab.close', 'Ctrl+T', {}, 'win32')?.id).toBe('tab.new');
    expect(findConflict('tab.close', 'Ctrl+T', {}, 'darwin')).toBeNull();
  });
});

describe('formatAccelerator', () => {
  test('renders mac-style glyphs on darwin', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+K', 'darwin')).toBe('⇧⌘K');
    expect(formatAccelerator('Cmd+Alt+I', 'darwin')).toBe('⌥⌘I');
    expect(formatAccelerator('Ctrl+PageDown', 'darwin')).toBe('⌃PageDown');
    expect(formatAccelerator('F11', 'darwin')).toBe('F11');
  });

  test('renders Ctrl-style text elsewhere', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+K', 'linux')).toBe('Ctrl+Shift+K');
    expect(formatAccelerator('Ctrl+Tab', 'win32')).toBe('Ctrl+Tab');
    expect(formatAccelerator('F11', 'win32')).toBe('F11');
    expect(formatAccelerator('', 'win32')).toBe('');
  });
});
