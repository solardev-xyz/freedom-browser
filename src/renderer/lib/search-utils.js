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

// The provider `providerId` actually resolves to. Kept alongside buildSearchUrl
// so the two can never disagree: whatever engine a search runs against is the
// engine chrome names for it (the page context menu's `Search <Engine> for …`).
const resolveProvider = (providerId, customProviders) =>
  SEARCH_PROVIDERS[providerId] ||
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

// The quoted part of that item: whitespace collapsed to single spaces (a
// selection spanning several lines must stay one menu row) and elided with a
// single-character ellipsis once it runs past the budget. Returns '' for a
// selection that is empty or only whitespace, which is what suppresses the
// item entirely.
export const formatSearchMenuSelection = (selection) => {
  const collapsed = typeof selection === 'string' ? selection.replace(/\s+/gu, ' ').trim() : '';
  if (!collapsed) return '';
  // Count by code point, so a selection of emoji or other astral characters is
  // never cut through the middle of a surrogate pair.
  const characters = [...collapsed];
  if (characters.length <= SEARCH_MENU_SELECTION_MAX) return collapsed;

  let head = characters.slice(0, SEARCH_MENU_SELECTION_MAX).join('');
  // Elide on a word boundary, unless the budget runs out inside the very first
  // word (a long hash, a URL) — then cut it hard rather than show an ellipsis
  // with nothing in front of it.
  if (characters[SEARCH_MENU_SELECTION_MAX] !== ' ') {
    const lastSpace = head.lastIndexOf(' ');
    if (lastSpace > 0) head = head.slice(0, lastSpace);
  }
  return `${head.trimEnd()}…`;
};
