import {
  detectSuggestionProtocol,
  extractRootDomain,
  generateSuggestions,
  getPlaceholderLetter,
  scoreSuggestion,
} from './autocomplete-utils.js';

describe('autocomplete-utils', () => {
  describe('extractRootDomain', () => {
    test('extracts the origin from http urls', () => {
      expect(extractRootDomain('https://example.com/docs/page')).toBe('https://example.com');
    });

    test('extracts protocol roots from dweb urls', () => {
      expect(extractRootDomain('ipfs://bafy123/path/to/file')).toBe('ipfs://bafy123');
      expect(extractRootDomain('bzz://abcdef/path')).toBe('bzz://abcdef');
    });

    test('extracts ens roots', () => {
      expect(extractRootDomain('vitalik.eth/about')).toBe('vitalik.eth');
      expect(extractRootDomain('name.box/docs')).toBe('name.box');
    });

    test('returns null for unsupported inputs', () => {
      expect(extractRootDomain('not a url')).toBeNull();
      expect(extractRootDomain('')).toBeNull();
    });
  });

  describe('detectSuggestionProtocol', () => {
    test('maps suggestion protocols for icons', () => {
      expect(detectSuggestionProtocol('bzz://hash')).toBe('swarm');
      expect(detectSuggestionProtocol('vitalik.eth')).toBe('swarm');
      expect(detectSuggestionProtocol('ipfs://cid')).toBe('ipfs');
      expect(detectSuggestionProtocol('ipns://name')).toBe('ipns');
      expect(detectSuggestionProtocol('https://example.com')).toBe('https');
      expect(detectSuggestionProtocol('http://example.com')).toBe('http');
    });
  });

  describe('scoreSuggestion', () => {
    test('prefers strong url matches, visit count, and bookmarks', () => {
      const plain = scoreSuggestion({ url: 'https://example.com/docs', title: 'Docs' }, 'exa');
      const bookmark = scoreSuggestion(
        {
          url: 'https://example.com/docs',
          title: 'Docs',
          visit_count: 20,
          isBookmark: true,
        },
        'exa'
      );

      expect(bookmark).toBeGreaterThan(plain);
    });
  });

  describe('generateSuggestions', () => {
    test('prioritizes open tabs over history and bookmarks', () => {
      const suggestions = generateSuggestions('exa', {
        openTabs: [
          {
            id: 7,
            url: 'https://example.com/tab',
            title: 'Example Tab',
            isActive: true,
          },
        ],
        historyItems: [
          {
            url: 'https://example.com/history',
            title: 'Example History',
            visit_count: 10,
          },
        ],
        bookmarks: [{ target: 'https://example.com/bookmark', label: 'Example Bookmark' }],
      });

      expect(suggestions[0]).toEqual(
        expect.objectContaining({
          type: 'tab',
          tabId: 7,
          url: 'https://example.com/tab',
        })
      );
    });

    test('adds root-domain suggestions for matching history deeplinks', () => {
      const suggestions = generateSuggestions('freedom', {
        historyItems: [
          {
            url: 'https://freedom.dev/docs/testing',
            title: 'Freedom docs',
            visit_count: 3,
          },
        ],
      });

      expect(suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ url: 'https://freedom.dev/docs/testing' }),
          expect.objectContaining({ url: 'https://freedom.dev' }),
        ])
      );
    });

    test('dedupes bookmark entries when history already contains the same url', () => {
      const suggestions = generateSuggestions('docs', {
        historyItems: [
          {
            url: 'https://example.com/docs',
            title: 'History Docs',
            visit_count: 1,
          },
        ],
        bookmarks: [
          {
            target: 'https://example.com/docs',
            label: 'Bookmarked Docs',
          },
        ],
      });

      expect(suggestions.filter((item) => item.url === 'https://example.com/docs')).toHaveLength(1);
      expect(suggestions[0]).toEqual(
        expect.objectContaining({
          type: 'bookmark',
          title: 'Bookmarked Docs',
        })
      );
    });

    test('skips internal page tabs and limits results to 8 entries', () => {
      const suggestions = generateSuggestions('match', {
        openTabs: [
          { id: 1, url: 'file:///app/pages/home.html', title: 'Home' },
          { id: 2, url: 'https://match.example/1', title: 'One' },
        ],
        historyItems: Array.from({ length: 10 }, (_, index) => ({
          url: `https://match.example/${index + 2}`,
          title: `Match ${index + 2}`,
          visit_count: index + 1,
        })),
      });

      expect(suggestions).toHaveLength(8);
      expect(suggestions.some((item) => item.url.includes('/pages/home.html'))).toBe(false);
    });
  });

  describe('getPlaceholderLetter', () => {
    test('uses host initials for http urls and raw first letters otherwise', () => {
      expect(getPlaceholderLetter('https://www.example.com/path')).toBe('E');
      expect(getPlaceholderLetter('ipfs://bafy123')).toBe('I');
      expect(getPlaceholderLetter('')).toBe('');
    });
  });
});
