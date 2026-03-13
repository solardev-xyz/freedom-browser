export const extractRootDomain = (url) => {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    }

    if (url.startsWith('bzz://') || url.startsWith('ipfs://') || url.startsWith('ipns://')) {
      const match = url.match(/^([a-z]+:\/\/[^\/]+)/);
      return match ? match[1] : null;
    }

    if (url.includes('.eth') || url.includes('.box')) {
      const match = url.match(/^([a-zA-Z0-9-]+\.(?:eth|box))/);
      return match ? match[1] : null;
    }

    return null;
  } catch {
    return null;
  }
};

export const detectSuggestionProtocol = (url) => {
  if (!url) return 'http';
  if (url.startsWith('bzz://') || url.includes('.eth') || url.includes('.box')) return 'swarm';
  if (url.startsWith('ipfs://')) return 'ipfs';
  if (url.startsWith('ipns://')) return 'ipns';
  if (url.startsWith('https://')) return 'https';
  return 'http';
};

export const scoreSuggestion = (item, query) => {
  const url = (item.url || item.target || '').toLowerCase();
  const title = (item.title || item.label || '').toLowerCase();
  const q = query.toLowerCase();

  let score = 0;

  if (url.startsWith(q)) score += 100;
  else if (url.includes(q)) score += 50;

  if (title.startsWith(q)) score += 80;
  else if (title.includes(q)) score += 30;

  if (item.visit_count) {
    score += Math.min(Math.log(item.visit_count + 1) * 10, 50);
  }

  if (item.isBookmark) score += 20;

  return score;
};

export const generateSuggestions = (
  query,
  { openTabs = [], historyItems = [], bookmarks = [] } = {}
) => {
  if (!query || query.length < 1) return [];

  const q = query.toLowerCase();
  const results = new Map();
  const rootDomains = new Set();

  for (const tab of openTabs) {
    const url = tab.url || '';
    const title = tab.title || '';

    if (!url || url.includes('/pages/home.html') || url.includes('/pages/')) continue;

    if (url.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      const score = 200 + scoreSuggestion({ url, title }, query);
      results.set(url, {
        url,
        title,
        protocol: detectSuggestionProtocol(url),
        score,
        type: 'tab',
        tabId: tab.id,
        isActive: tab.isActive,
      });
    }
  }

  for (const item of historyItems) {
    const url = item.url || '';
    const title = item.title || '';

    if (url.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      const score = scoreSuggestion(item, query);
      if (score > 0) {
        if (!results.has(url)) {
          results.set(url, {
            url,
            title,
            protocol: detectSuggestionProtocol(url),
            score,
            type: 'history',
            visit_count: item.visit_count || 1,
          });
        }

        const root = extractRootDomain(url);
        if (root && root !== url && !rootDomains.has(root)) {
          rootDomains.add(root);
          if (root.toLowerCase().includes(q) && !results.has(root)) {
            results.set(root, {
              url: root,
              title: root,
              protocol: detectSuggestionProtocol(root),
              score: score * 0.8,
              type: 'history',
              visit_count: item.visit_count || 1,
            });
          }
        }
      }
    }
  }

  for (const item of bookmarks) {
    const url = item.target || '';
    const title = item.label || '';

    if (url.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      const score = scoreSuggestion({ ...item, url, title, isBookmark: true }, query);
      const existing = results.get(url);
      if (!existing || (existing.type !== 'tab' && existing.score < score)) {
        results.set(url, {
          url,
          title,
          protocol: detectSuggestionProtocol(url),
          score,
          type: existing?.type === 'tab' ? 'tab' : 'bookmark',
          tabId: existing?.tabId,
        });
      }
    }
  }

  return Array.from(results.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
};

export const getPlaceholderLetter = (url) => {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const host = new URL(url).host;
      return host
        .replace(/^www\./, '')
        .charAt(0)
        .toUpperCase();
    }

    return url.charAt(0).toUpperCase();
  } catch {
    return '?';
  }
};
