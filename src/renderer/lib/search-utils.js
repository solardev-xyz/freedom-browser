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
  return searchUrlTemplate ? { searchUrlTemplate } : null;
};

// Returns the provider's results URL for `query`, or null for empty input.
// Unknown provider ids fall back to the default so a stale persisted setting
// can never break address-bar search.
export const buildSearchUrl = (query, providerId, customProviders = []) => {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) return null;
  const provider =
    SEARCH_PROVIDERS[providerId] ||
    resolveCustomProvider(providerId, customProviders) ||
    SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER];
  return provider.searchUrlTemplate.replace(SEARCH_TERMS_PLACEHOLDER, encodeURIComponent(trimmed));
};
