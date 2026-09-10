// Address-bar search providers. Used by the loadTarget fallback in
// navigation.js when typed input matches no protocol, hash, name, or domain.
// The freedom://settings dropdown mirrors this map by hand (its inline script
// cannot import ES modules); a parity test in search-utils.test.js keeps the
// two in sync.
export const SEARCH_PROVIDERS = {
  google: {
    label: 'Google',
    searchUrlTemplate: 'https://www.google.com/search?q={searchTerms}',
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    searchUrlTemplate: 'https://duckduckgo.com/?q={searchTerms}',
  },
  bing: { label: 'Bing', searchUrlTemplate: 'https://www.bing.com/search?q={searchTerms}' },
  brave: {
    label: 'Brave Search',
    searchUrlTemplate: 'https://search.brave.com/search?q={searchTerms}',
  },
  ecosia: {
    label: 'Ecosia',
    searchUrlTemplate: 'https://www.ecosia.org/search?q={searchTerms}',
  },
  startpage: {
    label: 'Startpage',
    searchUrlTemplate: 'https://www.startpage.com/sp/search?query={searchTerms}',
  },
};

export const DEFAULT_SEARCH_PROVIDER = 'duckduckgo';
export const CUSTOM_SEARCH_PROVIDER_PREFIX = 'custom:';

const SEARCH_TERMS_PLACEHOLDER = '{searchTerms}';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Canonicalize the familiar `%s` alias to OpenSearch's `{searchTerms}` form,
// then validate that the template can only navigate to a web search endpoint.
export const normalizeSearchUrlTemplate = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  const openSearchCount = trimmed.split(SEARCH_TERMS_PLACEHOLDER).length - 1;
  const percentCount = trimmed.split('%s').length - 1;
  if (openSearchCount + percentCount !== 1) return null;

  const normalized = percentCount === 1 ? trimmed.replace('%s', SEARCH_TERMS_PLACEHOLDER) : trimmed;

  try {
    const parsed = new URL(normalized.replace(SEARCH_TERMS_PLACEHOLDER, 'test'));
    const secure = parsed.protocol === 'https:';
    const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
    if ((!secure && !loopbackHttp) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }

  return normalized;
};

const resolveCustomProvider = (providerId, customProviders) => {
  if (typeof providerId !== 'string' || !providerId.startsWith(CUSTOM_SEARCH_PROVIDER_PREFIX)) {
    return null;
  }
  if (!Array.isArray(customProviders)) return null;

  const id = providerId.slice(CUSTOM_SEARCH_PROVIDER_PREFIX.length);
  const provider = customProviders.find((candidate) => candidate?.id === id);
  const searchUrlTemplate = normalizeSearchUrlTemplate(provider?.searchUrlTemplate);
  if (!searchUrlTemplate) return null;
  const label = typeof provider?.name === 'string' ? provider.name.trim() : '';
  // A nameless entry is refused whole, not labelled with the default engine's
  // name: naming one engine while `buildSearchUrl` searches with another
  // provider's template is exactly the disagreement this helper exists to
  // prevent. Refusing sends both the label and the URL to the default.
  // (settings-store's normalizeCustomSearchProviders already drops a nameless
  // provider on load and on save, so this only guards a value that never
  // reached the store.)
  if (!label) return null;
  return { label, searchUrlTemplate };
};

// Own-property lookup only: settings-store validates customSearchProviders but
// not `searchProvider` itself, so a hand-edited settings.json can carry an id
// like `constructor` or `toString`. A bare index would return the prototype's
// value for those, which has no `label` (the row renders `Search undefined
// for …`) and no `searchUrlTemplate` (buildSearchUrl throws) instead of
// falling back to the default engine.
const resolveBuiltInProvider = (providerId) =>
  typeof providerId === 'string' && Object.hasOwn(SEARCH_PROVIDERS, providerId)
    ? SEARCH_PROVIDERS[providerId]
    : null;

// The provider `providerId` actually resolves to. Kept alongside buildSearchUrl
// so the two can never disagree: whatever engine a search runs against is the
// engine chrome names for it (the page context menu's `Search <Engine> for …`).
const resolveProvider = (providerId, customProviders) =>
  resolveBuiltInProvider(providerId) ||
  resolveCustomProvider(providerId, customProviders) ||
  SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER];

// Display name of the configured engine — a built-in's label, a custom
// provider's name, or the default's label for an unknown/stale id.
export const getSearchProviderLabel = (providerId, customProviders = []) =>
  resolveProvider(providerId, customProviders).label;

// Returns the provider's results URL for `query`, or null for empty input.
// Unknown provider ids fall back to the default so a stale persisted setting
// can never break address-bar search.
export const buildSearchUrl = (query, providerId, customProviders = []) => {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) return null;
  const provider = resolveProvider(providerId, customProviders);
  return provider.searchUrlTemplate.replace(SEARCH_TERMS_PLACEHOLDER, encodeURIComponent(trimmed));
};

// How much of a selection the context-menu item shows before eliding — the
// budget #330 asks for, wide enough for a phrase without stretching the menu
// past the toolbar surfaces beside it.
export const SEARCH_MENU_SELECTION_MAX = 32;

// How much of a selection a selection search actually sends — the same 1024
// Chrome caps its own context-menu selection text at (`kMaxSelectionTextLength`
// in content/browser/renderer_host/render_frame_host_impl.cc), counted in code
// points here rather than UTF-16 units. The cap is not cosmetic: an uncapped
// select-all search on a long article or log builds a query string the size of
// the page, which is navigated to and written verbatim into the history DB —
// where it then sits in the history page and in autocomplete. Past Chromium's
// own maximum URL length the navigation is dropped with no error page at all,
// leaving a blank tab, and real engines answer 414 far below that anyway.
export const SEARCH_SELECTION_MAX = 1024;

// Refuse to cut a clamped selection down to a scrap: below this share of the
// budget the word boundary is worse than a hard cut mid-token.
const SEARCH_SELECTION_MIN_BOUNDARY = SEARCH_SELECTION_MAX / 2;

// The query a `Search <Engine> for "…"` click sends, clamped to the cap above.
// Counted by code point so an astral character is never cut through the middle
// of its surrogate pair, and cut on the last whitespace run inside the budget
// so the query does not end mid-word. A selection short enough to send whole is
// returned untouched — `buildSearchUrl` still trims and encodes it.
export const clampSearchSelection = (selection) => {
  if (typeof selection !== 'string') return '';
  // A code point is never fewer than one UTF-16 unit, so a string this short
  // cannot exceed the cap — and this is the case every ordinary selection
  // takes, which keeps the code-point split below off the common path.
  if (selection.length <= SEARCH_SELECTION_MAX) return selection;

  const characters = [...selection];
  if (characters.length <= SEARCH_SELECTION_MAX) return selection;

  const head = characters.slice(0, SEARCH_SELECTION_MAX).join('');
  // The budget ran out exactly on a break: the head already ends on a whole
  // word, so there is nothing to cut back to.
  if (/\s/u.test(characters[SEARCH_SELECTION_MAX])) return head.trimEnd();

  // Otherwise the head ends mid-word — drop back to the last break inside it,
  // unless that would leave a scrap (a selection with no break in the whole
  // budget: a hash, a base64 blob), in which case cut it hard.
  const trimmed = head.trimEnd();
  const boundary = trimmed.search(/\s+\S*$/u);
  return boundary >= SEARCH_SELECTION_MIN_BOUNDARY ? trimmed.slice(0, boundary) : head;
};

// Bidi controls (`\p{Bidi_Control}`: LRM/RLM/ALM, the LRE…RLO embeddings and
// overrides, and the LRI…PDI isolates) reorder every character after them for
// the rest of the run they open. The selection is page-controlled text painted
// into a chrome menu row, so one RLO in it flips the quoted text and the
// closing quote itself, spilling attacker-chosen prose outside the quotes:
// a selection of U+202E followed by 'safe elbatsurt si etis siht' renders the
// row as `for ""this site is trustable efas`. Stripped rather than escaped —
// a chrome label has no use for them. ZWJ/ZWNJ and the other `\p{Cf}` joiners
// are deliberately kept: they carry meaning inside emoji sequences and
// Persian/Indic text and do not reorder anything. (Spelled out as `U+202E`
// here on purpose: a literal control in this comment would reverse the comment
// itself in an editor.)
const BIDI_CONTROLS = /\p{Bidi_Control}/gu;

// Refuse to elide the menu label down to a scrap, the same way
// clampSearchSelection refuses for the query: below this share of the budget
// the word boundary tells the user less about what will be searched than a
// hard cut mid-token does ('id 0x<hash>' would otherwise show as 'id…').
const SEARCH_MENU_SELECTION_MIN_BOUNDARY = SEARCH_MENU_SELECTION_MAX / 2;

// The quoted part of that item: bidi controls stripped, whitespace collapsed
// to single spaces (a selection spanning several lines must stay one menu row)
// and elided with a single-character ellipsis once it runs past the budget.
// Returns '' for a selection that is empty or only whitespace, which is what
// suppresses the item entirely.
export const formatSearchMenuSelection = (selection) => {
  const collapsed =
    typeof selection === 'string'
      ? selection.replace(BIDI_CONTROLS, '').replace(/\s+/gu, ' ').trim()
      : '';
  if (!collapsed) return '';
  // Count by code point, so a selection of emoji or other astral characters is
  // never cut through the middle of a surrogate pair.
  const characters = [...collapsed];
  if (characters.length <= SEARCH_MENU_SELECTION_MAX) return collapsed;

  let head = characters.slice(0, SEARCH_MENU_SELECTION_MAX).join('');
  // Elide on a word boundary, unless the budget runs out inside the very first
  // word (a long hash, a URL) or leaves only a scrap in front of the ellipsis
  // — then cut it hard rather than show an ellipsis with nothing useful in
  // front of it.
  if (characters[SEARCH_MENU_SELECTION_MAX] !== ' ') {
    const lastSpace = head.lastIndexOf(' ');
    if (lastSpace >= SEARCH_MENU_SELECTION_MIN_BOUNDARY) head = head.slice(0, lastSpace);
  }
  return `${head.trimEnd()}…`;
};
