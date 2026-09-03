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

  // A remap is recorded against the registry of the release that recorded
  // it. When a later release binds that chord to a new default (the zoom
  // entries took CmdOrCtrl+0 / += / +- , all free before), the stored
  // override is still "valid" on its own terms and both bindings then fire
  // on one press. sanitizeOverrides applies the same rule the interactive
  // remap path does: a taken chord is refused, so the override reverts.
  describe('conflict pruning of stored overrides', () => {
    // Every registry entry a single keypress would fire, primaries and fixed
    // aliases alike — more than one means the double-fire bug is back.
    const matchingIds = (event, overrides, platform = 'linux') =>
      SHORTCUTS.filter((entry) =>
        [
          getEffectiveAccelerator(entry, overrides, platform),
          ...getAliasAccelerators(entry, platform),
        ].some((accelerator) => eventMatchesAccelerator(event, accelerator, platform))
      ).map((entry) => entry.id);

    test('drops an override that a newer default has since claimed', () => {
      const drops = [];
      const cleaned = sanitizeOverrides({ 'view.focusAddressBar': 'Ctrl+0' }, 'linux', {
        onDrop: (drop) => drops.push(drop),
      });
      expect(cleaned).toEqual({});
      expect(drops).toEqual([
        {
          id: 'view.focusAddressBar',
          accelerator: 'Ctrl+0',
          conflict: { id: 'page.zoomReset', description: 'Actual Size', fixed: false },
        },
      ]);
      // The other two chords this PR's zoom entries took, same story.
      expect(sanitizeOverrides({ 'view.focusAddressBar': 'Ctrl+=' }, 'linux')).toEqual({});
      expect(sanitizeOverrides({ 'view.focusAddressBar': 'Ctrl+-' }, 'linux')).toEqual({});
      expect(sanitizeOverrides({ 'view.focusAddressBar': 'Cmd+0' }, 'darwin')).toEqual({});
    });

    test('drops an override sitting on another entry’s fixed alias', () => {
      const drops = [];
      // CmdOrCtrl+Plus and CmdOrCtrl+numadd are Zoom In aliases: fixed, so
      // the interactive path cannot even swap them away.
      const cleaned = sanitizeOverrides({ 'tab.new': 'Ctrl+Plus' }, 'linux', {
        onDrop: (drop) => drops.push(drop),
      });
      expect(cleaned).toEqual({});
      expect(drops[0].conflict).toEqual({
        id: 'page.zoomIn',
        description: 'Zoom In',
        fixed: true,
      });
      expect(sanitizeOverrides({ 'tab.new': 'Ctrl+numadd' }, 'linux')).toEqual({});
    });

    test('keeps free remaps and legitimate swap pairs untouched', () => {
      const drops = [];
      const cleaned = sanitizeOverrides(
        {
          'tab.new': 'Ctrl+Shift+U', // free chord
          'page.reload': 'CmdOrCtrl+F', // swapped with…
          'page.findInPage': 'CmdOrCtrl+R', // …its partner
        },
        'linux',
        { onDrop: (drop) => drops.push(drop) }
      );
      expect(cleaned).toEqual({
        'tab.new': 'Ctrl+Shift+U',
        'page.reload': 'Ctrl+F',
        'page.findInPage': 'Ctrl+R',
      });
      expect(drops).toEqual([]);
      // An override on an entry whose old chord was freed by another
      // override is fine too: conflicts are judged on effective bindings.
      expect(
        sanitizeOverrides({ 'page.reload': 'Ctrl+Shift+U', 'tab.new': 'Ctrl+R' }, 'linux')
      ).toEqual({ 'page.reload': 'Ctrl+Shift+U', 'tab.new': 'Ctrl+R' });
    });

    test('two overrides colliding only with each other lose exactly one side', () => {
      // Only reachable by hand-editing the file — the UI refuses it. Walked
      // in registry order, so the outcome does not depend on JSON key order.
      const forward = sanitizeOverrides(
        { 'tab.new': 'Ctrl+Shift+U', 'tab.close': 'Ctrl+Shift+U' },
        'linux'
      );
      const reversed = sanitizeOverrides(
        { 'tab.close': 'Ctrl+Shift+U', 'tab.new': 'Ctrl+Shift+U' },
        'linux'
      );
      expect(forward).toEqual({ 'tab.close': 'Ctrl+Shift+U' });
      expect(reversed).toEqual(forward);
    });

    test('a pre-PR Ctrl+0 remap cannot leave two handlers on one press', () => {
      // The user-visible symptom: one Ctrl+0 press focusing the address bar
      // *and* resetting zoom, because two window keydown fallbacks matched.
      const platform = 'linux';
      const event = keyEvent({ key: '0', code: 'Digit0', ctrlKey: true });

      // Stored as-is (what the app did before this fix): two actions fire.
      expect(matchingIds(event, { 'view.focusAddressBar': 'Ctrl+0' })).toEqual([
        'page.zoomReset',
        'view.focusAddressBar',
      ]);
      // Loaded through sanitizeOverrides: exactly one.
      expect(
        matchingIds(event, sanitizeOverrides({ 'view.focusAddressBar': 'Ctrl+0' }, platform))
      ).toEqual(['page.zoomReset']);
    });

    test('a revert cascading onto an earlier-registry override drops that one too', () => {
      // Interactively legal before the zoom defaults existed: remap
      // view.focusAddressBar (registry 13) onto the then-free Ctrl+0, then
      // tab.new (registry 0) onto the Ctrl+L it freed. Dropping the first
      // hands Ctrl+L back, so a single pass — which checked tab.new before
      // the drop — would leave two handlers on one Ctrl+L press.
      const drops = [];
      const cleaned = sanitizeOverrides(
        { 'tab.new': 'Ctrl+L', 'view.focusAddressBar': 'Ctrl+0' },
        'linux',
        { onDrop: (drop) => drops.push(drop) }
      );
      expect(cleaned).toEqual({});
      expect(drops).toEqual([
        {
          id: 'view.focusAddressBar',
          accelerator: 'Ctrl+0',
          conflict: { id: 'page.zoomReset', description: 'Actual Size', fixed: false },
        },
        {
          id: 'tab.new',
          accelerator: 'Ctrl+L',
          conflict: {
            id: 'view.focusAddressBar',
            description: 'Focus Address Bar',
            fixed: false,
          },
        },
      ]);
      // Exactly one action left on the freed chord.
      expect(matchingIds(keyEvent({ key: 'l', code: 'KeyL', ctrlKey: true }), cleaned)).toEqual([
        'view.focusAddressBar',
      ]);
      // Registry order, not JSON key order, decides — the other key order
      // gives the identical result.
      expect(
        sanitizeOverrides({ 'view.focusAddressBar': 'Ctrl+0', 'tab.new': 'Ctrl+L' }, 'linux')
      ).toEqual(cleaned);
    });

    test('the mirror direction (collider later in the registry) also settles', () => {
      // page.reload (7) drops and reverts to Ctrl+R, which view.focusAddressBar
      // (13) was remapped onto — the ordering the single pass already handled.
      const drops = [];
      const cleaned = sanitizeOverrides(
        { 'page.reload': 'Ctrl+0', 'view.focusAddressBar': 'Ctrl+R' },
        'linux',
        { onDrop: (drop) => drops.push(drop) }
      );
      expect(cleaned).toEqual({});
      expect(drops.map((drop) => drop.id)).toEqual(['page.reload', 'view.focusAddressBar']);
      expect(matchingIds(keyEvent({ key: 'r', code: 'KeyR', ctrlKey: true }), cleaned)).toEqual([
        'page.reload',
      ]);
      expect(
        sanitizeOverrides({ 'view.focusAddressBar': 'Ctrl+R', 'page.reload': 'Ctrl+0' }, 'linux')
      ).toEqual(cleaned);
    });

    test('a three-entry cascade runs to a fixpoint', () => {
      // Each drop frees a default the next-earlier entry sits on:
      // view.focusAddressBar (13) → Ctrl+L → page.reload (7) → Ctrl+R →
      // tab.new (0). Three registry walks are needed, one per link.
      const drops = [];
      const cleaned = sanitizeOverrides(
        {
          'tab.new': 'Ctrl+R',
          'page.reload': 'Ctrl+L',
          'view.focusAddressBar': 'Ctrl+0',
        },
        'linux',
        { onDrop: (drop) => drops.push(drop) }
      );
      expect(cleaned).toEqual({});
      expect(drops.map((drop) => drop.id)).toEqual([
        'view.focusAddressBar',
        'page.reload',
        'tab.new',
      ]);
      for (const [event, id] of [
        [keyEvent({ key: '0', code: 'Digit0', ctrlKey: true }), 'page.zoomReset'],
        [keyEvent({ key: 'l', code: 'KeyL', ctrlKey: true }), 'view.focusAddressBar'],
        [keyEvent({ key: 'r', code: 'KeyR', ctrlKey: true }), 'page.reload'],
        [keyEvent({ key: 't', code: 'KeyT', ctrlKey: true }), 'tab.new'],
      ]) {
        expect(matchingIds(event, cleaned)).toEqual([id]);
      }
      // Same result from the reversed JSON key order.
      expect(
        sanitizeOverrides(
          {
            'view.focusAddressBar': 'Ctrl+0',
            'page.reload': 'Ctrl+L',
            'tab.new': 'Ctrl+R',
          },
          'linux'
        )
      ).toEqual(cleaned);
    });
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

describe('docs/features.md keyboard shortcut list', () => {
  const fs = require('fs');
  const path = require('path');

  // The "Keyboard Shortcuts" bullet in docs/features.md is a hand-written
  // mirror of the registry, so it drifts silently (it once advertised four
  // zoom/print bindings the app has never implemented). Pin both directions:
  // nothing documented that the registry does not bind, and nothing
  // user-facing in the registry left undocumented.
  const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'features.md');
  const DOC_PLATFORMS = ['darwin', 'win32'];

  // Bullet lines of the shortcut list: `- ` + backticked accelerators joined
  // by ` / `, then `: Description`. Only the part before the colon is read,
  // so prose in the description never looks like a binding.
  const docAccelerators = () => {
    const source = fs.readFileSync(DOC_PATH, 'utf-8');
    const lines = source.split('\n');
    const start = lines.findIndex((line) => line.startsWith('- **Keyboard Shortcuts**'));
    expect(start).toBeGreaterThan(-1);

    const found = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('  - ')) break; // end of the nested list
      const bindings = line.slice(4).split(':')[0];
      const tokens = bindings.match(/`([^`]+)`/g) || [];
      found.push(...tokens.map((token) => token.slice(1, -1)));
    }
    expect(found.length).toBeGreaterThan(0);
    return found;
  };

  const registryAccelerators = (platform) => {
    const set = new Set();
    for (const entry of SHORTCUTS) {
      if (entry.devOnly) continue;
      const def = getDefaultAccelerator(entry, platform);
      if (def) set.add(normalizeAccelerator(def, platform));
      for (const alias of getAliasAccelerators(entry, platform)) {
        set.add(normalizeAccelerator(alias, platform));
      }
    }
    return set;
  };

  test('every documented binding exists in the registry', () => {
    const registry = Object.fromEntries(
      DOC_PLATFORMS.map((platform) => [platform, registryAccelerators(platform)])
    );

    for (const accelerator of docAccelerators()) {
      const matched = DOC_PLATFORMS.some((platform) =>
        registry[platform].has(normalizeAccelerator(accelerator, platform))
      );
      // A failure here means the docs promise a binding nothing implements.
      expect({ accelerator, matched }).toEqual({ accelerator, matched: true });
    }
  });

  test('every user-facing registry default is documented', () => {
    const documented = Object.fromEntries(
      DOC_PLATFORMS.map((platform) => [
        platform,
        new Set(docAccelerators().map((acc) => normalizeAccelerator(acc, platform))),
      ])
    );

    for (const entry of SHORTCUTS) {
      if (entry.devOnly) continue;
      const documentedSomewhere = DOC_PLATFORMS.some((platform) =>
        documented[platform].has(
          normalizeAccelerator(getDefaultAccelerator(entry, platform), platform)
        )
      );
      expect({ id: entry.id, documented: documentedSomewhere }).toEqual({
        id: entry.id,
        documented: true,
      });
    }
  });
});

describe('hamburger menu shortcut hints', () => {
  const fs = require('fs');
  const path = require('path');

  // src/renderer/index.html hard-codes the hint text next to each hamburger
  // menu item. A hint for a binding the app never registers is a lie the
  // user can see (Print advertised Cmd/Ctrl+P for a shortcut that does not
  // exist, which is where docs/features.md got it from). Pin every hint to
  // the registry.
  test('every data-shortcut hint is a real registry binding', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf-8');
    const hints = [...html.matchAll(/data-shortcut(?:-other)?="([^"]+)"/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThan(0);

    for (const platform of ['darwin', 'win32']) {
      const registry = new Set();
      for (const entry of SHORTCUTS) {
        const def = getDefaultAccelerator(entry, platform);
        if (def) registry.add(normalizeAccelerator(def, platform));
        for (const alias of getAliasAccelerators(entry, platform)) {
          registry.add(normalizeAccelerator(alias, platform));
        }
      }
      for (const hint of hints) {
        const normalized = normalizeAccelerator(hint, platform);
        // A hint may be platform-specific (Cmd+Y is macOS-only), so it only
        // has to resolve on the platform whose modifier it names.
        const appliesHere = platform === 'darwin' ? !/^Ctrl\+/.test(hint) : !/^Cmd\+/.test(hint);
        if (!appliesHere) continue;
        expect({ hint, platform, known: registry.has(normalized) }).toEqual({
          hint,
          platform,
          known: true,
        });
      }
    }
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

  test('labels keypad keys the way keyboards do, not with Electron key codes', () => {
    expect(formatAccelerator('CmdOrCtrl+numadd', 'win32')).toBe('Ctrl+Num +');
    expect(formatAccelerator('CmdOrCtrl+numsub', 'linux')).toBe('Ctrl+Num -');
    expect(formatAccelerator('CmdOrCtrl+num0', 'darwin')).toBe('⌘Num 0');
    expect(formatAccelerator('CmdOrCtrl+Plus', 'win32')).toBe('Ctrl++');
  });
});

describe('zoom binding reachability across layouts and the keypad', () => {
  // Regression cover for the alias set on page.zoom*: `=` is a shifted key on
  // several common layouts, and eventMatchesAccelerator is deliberately strict
  // about modifiers, so the bare `CmdOrCtrl+=` default can never fire there.
  // The keypad is a separate physical key set for the same reason.
  const bindings = (id, platform) => [
    getDefaultAccelerator(id, platform),
    ...getAliasAccelerators(id, platform),
  ];
  const fires = (event, id, platform) =>
    bindings(id, platform).some((accelerator) =>
      eventMatchesAccelerator(event, accelerator, platform)
    );

  // German layout: `=` is Shift+0, so the browser reports key '=' with
  // shiftKey true on the physical Digit0 key.
  const germanEquals = (modifier) =>
    keyEvent({ key: '=', code: 'Digit0', shiftKey: true, ...modifier });
  // US layout: the same chord types a literal '+'.
  const usPlus = (modifier) => keyEvent({ key: '+', code: 'Equal', shiftKey: true, ...modifier });

  test('the primary CmdOrCtrl+= binding alone cannot fire on a shifted-= layout', () => {
    // The gap the aliases exist to close — assert it directly so a future
    // change that drops them fails here rather than silently regressing.
    expect(eventMatchesAccelerator(germanEquals({ ctrlKey: true }), 'CmdOrCtrl+=', 'linux')).toBe(
      false
    );
    expect(eventMatchesAccelerator(usPlus({ ctrlKey: true }), 'CmdOrCtrl+=', 'win32')).toBe(false);
  });

  test('zoom in fires for a shifted = on every platform', () => {
    expect(fires(germanEquals({ ctrlKey: true }), 'page.zoomIn', 'linux')).toBe(true);
    expect(fires(germanEquals({ ctrlKey: true }), 'page.zoomIn', 'win32')).toBe(true);
    expect(fires(germanEquals({ metaKey: true }), 'page.zoomIn', 'darwin')).toBe(true);
    expect(fires(usPlus({ ctrlKey: true }), 'page.zoomIn', 'win32')).toBe(true);
    expect(fires(usPlus({ metaKey: true }), 'page.zoomIn', 'darwin')).toBe(true);
  });

  test('a shifted = without the Cmd/Ctrl modifier still zooms nothing', () => {
    expect(fires(germanEquals(), 'page.zoomIn', 'linux')).toBe(false);
    expect(fires(germanEquals({ altKey: true, ctrlKey: true }), 'page.zoomIn', 'linux')).toBe(
      false
    );
  });

  test('the keypad drives all three zoom actions', () => {
    const cases = [
      ['page.zoomIn', { key: '+', code: 'NumpadAdd' }],
      ['page.zoomOut', { key: '-', code: 'NumpadSubtract' }],
      ['page.zoomReset', { key: '0', code: 'Numpad0' }],
    ];
    for (const [id, key] of cases) {
      expect(fires(keyEvent({ ...key, ctrlKey: true }), id, 'linux')).toBe(true);
      expect(fires(keyEvent({ ...key, metaKey: true }), id, 'darwin')).toBe(true);
    }
    // NumLock off relabels the keypad keys; the physical code still matches.
    expect(
      fires(keyEvent({ key: 'Insert', code: 'Numpad0', ctrlKey: true }), 'page.zoomReset', 'linux')
    ).toBe(true);
  });

  test('the keypad aliases do not collide with the main-row bindings', () => {
    for (const platform of PLATFORMS) {
      expect(normalizeAccelerator('CmdOrCtrl+numsub', platform)).not.toBe(
        normalizeAccelerator('CmdOrCtrl+-', platform)
      );
      expect(findConflict('page.zoomOut', 'CmdOrCtrl+numsub', {}, platform)).toBeNull();
      // …but they are real registry bindings, so nothing else may take them.
      expect(findConflict('tab.new', 'CmdOrCtrl+numsub', {}, platform)).toEqual({
        id: 'page.zoomOut',
        description: 'Zoom Out',
        fixed: true,
      });
    }
  });

  test('a Nordic Ctrl++ matches zoom in and zoom out, so handler order decides', () => {
    // Swedish/Norwegian/Danish/Finnish put `+` unshifted on the key the US
    // layout uses for `-`, so Ctrl+`+` reports { key: '+', code: 'Minus' }:
    // it matches page.zoomIn through the `CmdOrCtrl+Plus` alias *and*
    // page.zoomOut through the `-` its physical code implies. Nothing here
    // can tell them apart — the dispatcher does, by checking zoom in first
    // (menus.js, pinned by menus.test.js). Documented here so the ambiguity
    // is visible from the registry side too.
    const nordicPlus = keyEvent({ key: '+', code: 'Minus', ctrlKey: true });
    expect(fires(nordicPlus, 'page.zoomIn', 'linux')).toBe(true);
    expect(fires(nordicPlus, 'page.zoomOut', 'linux')).toBe(true);
    expect(fires(nordicPlus, 'page.zoomReset', 'linux')).toBe(false);
  });

  test('aliases survive a user remap of the primary binding', () => {
    const overrides = { 'page.zoomIn': 'Ctrl+Shift+U' };
    expect(getEffectiveAccelerator('page.zoomIn', overrides, 'linux')).toBe('Ctrl+Shift+U');
    expect(getAliasAccelerators('page.zoomIn', 'linux')).toEqual([
      'CmdOrCtrl+Shift+=',
      'CmdOrCtrl+Plus',
      'CmdOrCtrl+numadd',
    ]);
  });
});
