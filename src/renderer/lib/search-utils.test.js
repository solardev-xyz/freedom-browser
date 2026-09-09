import fs from 'fs';
import path from 'path';
import {
  SEARCH_PROVIDERS,
  SEARCH_MENU_SELECTION_MAX,
  SEARCH_SELECTION_MAX,
  DEFAULT_SEARCH_PROVIDER,
  buildSearchUrl,
  clampSearchSelection,
  formatSearchMenuSelection,
  getSearchProviderLabel,
  normalizeSearchUrlTemplate,
} from './search-utils.js';

describe('search-utils', () => {
  test('the settings.html provider dropdown mirrors SEARCH_PROVIDERS', () => {
    // The settings page's inline script cannot import this module, so its
    // <select id="search-provider"> hardcodes the ids and labels. This parity
    // check is what keeps the two lists from drifting apart.
    const html = fs.readFileSync(path.join(__dirname, '../pages/settings.html'), 'utf-8');
    const select = html.match(/<select id="search-provider">([\s\S]*?)<\/select>/);
    expect(select).not.toBeNull();
    const options = [...select[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(
      (m) => [m[1], m[2]]
    );

    expect(options).toEqual(
      Object.entries(SEARCH_PROVIDERS).map(([id, provider]) => [id, provider.label])
    );
  });

  test('default provider is DuckDuckGo', () => {
    expect(DEFAULT_SEARCH_PROVIDER).toBe('duckduckgo');
    expect(SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER]).toBeDefined();
  });

  test('builds a search URL for the given provider', () => {
    expect(buildSearchUrl('hello world', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=hello%20world'
    );
    expect(buildSearchUrl('weather', 'google')).toBe('https://www.google.com/search?q=weather');
  });

  test('falls back to the default provider for unknown or missing provider ids', () => {
    expect(buildSearchUrl('cats', 'not-a-provider')).toBe('https://duckduckgo.com/?q=cats');
    expect(buildSearchUrl('cats', undefined)).toBe('https://duckduckgo.com/?q=cats');
    expect(buildSearchUrl('cats', null)).toBe('https://duckduckgo.com/?q=cats');
  });

  test('builds a URL for a configured custom provider', () => {
    const customProviders = [
      {
        id: 'private-search',
        name: 'Private Search',
        searchUrlTemplate: 'https://search.example/results?q={searchTerms}&source=freedom',
      },
    ];

    expect(buildSearchUrl('cats & dogs', 'custom:private-search', customProviders)).toBe(
      'https://search.example/results?q=cats%20%26%20dogs&source=freedom'
    );
  });

  test('falls back safely when a selected custom provider is missing or malformed', () => {
    expect(buildSearchUrl('cats', 'custom:missing', [])).toBe('https://duckduckgo.com/?q=cats');
    expect(
      buildSearchUrl('cats', 'custom:unsafe', [
        { id: 'unsafe', name: 'Unsafe', searchUrlTemplate: 'javascript:{searchTerms}' },
      ])
    ).toBe('https://duckduckgo.com/?q=cats');
  });

  test('normalizes supported templates and rejects unsafe endpoints', () => {
    expect(normalizeSearchUrlTemplate('https://search.example/?q=%s')).toBe(
      'https://search.example/?q={searchTerms}'
    );
    expect(normalizeSearchUrlTemplate('http://localhost:8080/?q={searchTerms}')).toBe(
      'http://localhost:8080/?q={searchTerms}'
    );
    expect(normalizeSearchUrlTemplate('http://search.example/?q={searchTerms}')).toBeNull();
    expect(normalizeSearchUrlTemplate('javascript:{searchTerms}')).toBeNull();
    expect(normalizeSearchUrlTemplate('https://user:pass@example.com/?q={searchTerms}')).toBeNull();
    expect(
      normalizeSearchUrlTemplate('https://example.com/?q={searchTerms}&copy={searchTerms}')
    ).toBeNull();
    expect(normalizeSearchUrlTemplate('https://example.com/search')).toBeNull();
  });

  test('trims the query and returns null for empty input', () => {
    expect(buildSearchUrl('  padded query  ', 'google')).toBe(
      'https://www.google.com/search?q=padded%20query'
    );
    expect(buildSearchUrl('', 'google')).toBeNull();
    expect(buildSearchUrl('   ', 'google')).toBeNull();
    expect(buildSearchUrl(null, 'google')).toBeNull();
    expect(buildSearchUrl(undefined, 'google')).toBeNull();
  });

  test('percent-encodes reserved characters in the query', () => {
    expect(buildSearchUrl('a&b=c?d#e', 'google')).toBe(
      'https://www.google.com/search?q=a%26b%3Dc%3Fd%23e'
    );
  });

  // #330 — the page context menu names the engine it is about to search.
  describe('getSearchProviderLabel', () => {
    test('names built-in providers, and the default for unknown ids', () => {
      expect(getSearchProviderLabel('google')).toBe('Google');
      expect(getSearchProviderLabel('brave')).toBe('Brave Search');
      expect(getSearchProviderLabel('not-a-provider')).toBe('DuckDuckGo');
      expect(getSearchProviderLabel(null)).toBe('DuckDuckGo');
      expect(getSearchProviderLabel(undefined)).toBe('DuckDuckGo');
    });

    test('names a custom provider by the name the user gave it', () => {
      const customProviders = [
        {
          id: 'private-search',
          name: 'Private Search',
          searchUrlTemplate: 'https://search.example/results?q={searchTerms}',
        },
      ];
      expect(getSearchProviderLabel('custom:private-search', customProviders)).toBe(
        'Private Search'
      );
      // A label always agrees with the URL the same id builds — a custom entry
      // that fails validation falls back on both counts, never one of the two.
      expect(getSearchProviderLabel('custom:missing', customProviders)).toBe('DuckDuckGo');
      expect(buildSearchUrl('cats', 'custom:missing', customProviders)).toBe(
        'https://duckduckgo.com/?q=cats'
      );
      // A nameless entry (impossible through the store, only through a
      // hand-edited settings.json) is refused on both counts rather than
      // wearing the default engine's name over the custom template's URL.
      const nameless = [
        { id: 'nameless', searchUrlTemplate: 'https://search.example/?q={searchTerms}' },
      ];
      expect(getSearchProviderLabel('custom:nameless', nameless)).toBe('DuckDuckGo');
      expect(buildSearchUrl('cats', 'custom:nameless', nameless)).toBe(
        'https://duckduckgo.com/?q=cats'
      );
    });
  });

  describe('formatSearchMenuSelection', () => {
    test('returns the selection unchanged when it fits', () => {
      expect(formatSearchMenuSelection('freedom browser')).toBe('freedom browser');
      expect(formatSearchMenuSelection('  padded  ')).toBe('padded');
      // Exactly the budget, so still no ellipsis.
      expect(formatSearchMenuSelection('a'.repeat(SEARCH_MENU_SELECTION_MAX))).toBe(
        'a'.repeat(SEARCH_MENU_SELECTION_MAX)
      );
    });

    test('collapses whitespace so a multi-line selection stays one row', () => {
      expect(formatSearchMenuSelection('two\nlines\there')).toBe('two lines here');
    });

    test('elides past the budget, on a word boundary where there is one', () => {
      expect(formatSearchMenuSelection('the quick brown fox jumps over the lazy dog')).toBe(
        'the quick brown fox jumps over…'
      );
      // A single unbroken token (a hash, a URL) is cut hard rather than
      // collapsing to just an ellipsis.
      expect(formatSearchMenuSelection('x'.repeat(80))).toBe(
        `${'x'.repeat(SEARCH_MENU_SELECTION_MAX)}…`
      );
      // A break exactly at the budget keeps the whole last word.
      expect(formatSearchMenuSelection('123456789 123456789 1234567890 tail')).toBe(
        '123456789 123456789 1234567890…'
      );
    });

    test('never cuts through a surrogate pair', () => {
      const elided = formatSearchMenuSelection('🦦'.repeat(40));
      expect([...elided]).toHaveLength(SEARCH_MENU_SELECTION_MAX + 1);
      expect(elided.endsWith('…')).toBe(true);
      expect(elided).not.toContain('�');
      expect([...elided].every((ch) => ch === '🦦' || ch === '…')).toBe(true);
    });

    test('returns an empty string for nothing worth searching for', () => {
      expect(formatSearchMenuSelection('')).toBe('');
      expect(formatSearchMenuSelection('   \n\t ')).toBe('');
      expect(formatSearchMenuSelection(null)).toBe('');
      expect(formatSearchMenuSelection(undefined)).toBe('');
    });
  });

  describe('clampSearchSelection', () => {
    test('returns a selection that fits the cap untouched', () => {
      expect(clampSearchSelection('otters')).toBe('otters');
      // Newlines and runs of whitespace survive: only the length is capped.
      expect(clampSearchSelection('two\nlines  here')).toBe('two\nlines  here');
      expect(clampSearchSelection('a'.repeat(SEARCH_SELECTION_MAX))).toBe(
        'a'.repeat(SEARCH_SELECTION_MAX)
      );
    });

    test('clamps a select-all sized selection to the cap', () => {
      // The shape the finding reproduced: right-click after Ctrl+A on a long
      // article or log, which built a 1.5 MB URL that went into history — and
      // past Chromium's maximum URL length was dropped with no error page.
      const huge = 'the otter carried a smooth stone. '.repeat(50_000);
      const clamped = clampSearchSelection(huge);
      expect(clamped.length).toBeLessThanOrEqual(SEARCH_SELECTION_MAX);
      expect(huge.startsWith(clamped)).toBe(true);
      // Cut on a word boundary, and not down to a scrap.
      expect(clamped.endsWith('stone.')).toBe(true);
      expect(clamped.length).toBeGreaterThan(SEARCH_SELECTION_MAX / 2);
    });

    test('cuts a single unbroken token hard rather than down to a scrap', () => {
      // No whitespace at all: there is no boundary to prefer.
      expect(clampSearchSelection('x'.repeat(SEARCH_SELECTION_MAX * 3))).toBe(
        'x'.repeat(SEARCH_SELECTION_MAX)
      );
      // One boundary, but far too early — cutting there would send three
      // characters instead of the kilobyte the user selected.
      const earlyBreak = `abc ${'y'.repeat(SEARCH_SELECTION_MAX * 3)}`;
      expect(clampSearchSelection(earlyBreak)).toBe(earlyBreak.slice(0, SEARCH_SELECTION_MAX));
    });

    test('never cuts through a surrogate pair', () => {
      const clamped = clampSearchSelection('🦦'.repeat(SEARCH_SELECTION_MAX * 2));
      expect([...clamped]).toHaveLength(SEARCH_SELECTION_MAX);
      expect(clamped).not.toContain('�');
    });

    test('returns an empty string for a non-string selection', () => {
      expect(clampSearchSelection(null)).toBe('');
      expect(clampSearchSelection(undefined)).toBe('');
      expect(clampSearchSelection(12)).toBe('');
    });

    test('bounds the URL a selection search can build', () => {
      const url = buildSearchUrl(
        clampSearchSelection('otter '.repeat(500_000)),
        DEFAULT_SEARCH_PROVIDER
      );
      // Well inside every engine's request-line limit, and inside Chromium's
      // own maximum URL length by three orders of magnitude.
      expect(url.length).toBeLessThan(4096);
      expect(url.startsWith('https://duckduckgo.com/?q=otter')).toBe(true);
    });
  });
});
