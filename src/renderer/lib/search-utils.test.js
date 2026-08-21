import fs from 'fs';
import path from 'path';
import {
  SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER,
  buildSearchUrl,
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
});
