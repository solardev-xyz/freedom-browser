// Autocomplete module for address bar suggestions
import { pushDebug } from './debug.js';
import { getOpenTabs, switchTab, hideTabContextMenu } from './tabs.js';
import { closeMenus } from './menus.js';
import { hideBookmarkContextMenu } from './bookmarks-ui.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';

const electronAPI = window.electronAPI;

// Cache for suggestions data
let historyCache = [];
let bookmarksCache = [];

// DOM elements
let dropdown = null;
let addressInput = null;

// State
let selectedIndex = -1;
let currentSuggestions = [];
let debounceTimer = null;
let isOpen = false;

// Callbacks
let onNavigate = null;

/**
 * Set the navigation callback
 */
export const setOnNavigate = (callback) => {
  onNavigate = callback;
};

/**
 * Load history and bookmarks into cache
 */
export const refreshCache = async () => {
  try {
    const [history, bookmarks] = await Promise.all([
      electronAPI?.getHistory?.() || [],
      electronAPI?.getBookmarks?.() || [],
    ]);
    historyCache = history;
    bookmarksCache = bookmarks;
    pushDebug(
      `[Autocomplete] Cache refreshed: ${history.length} history, ${bookmarks.length} bookmarks`
    );
  } catch (err) {
    console.error('[Autocomplete] Failed to refresh cache:', err);
  }
};

/**
 * Extract root domain from a URL
 */
const extractRootDomain = (url) => {
  try {
    // Handle protocol-prefixed URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}`;
    }
    // Handle bzz://, ipfs://, ipns://
    if (url.startsWith('bzz://') || url.startsWith('ipfs://') || url.startsWith('ipns://')) {
      const match = url.match(/^([a-z]+:\/\/[^\/]+)/);
      return match ? match[1] : null;
    }
    // Handle .eth and .box domains (ENS)
    if (url.includes('.eth') || url.includes('.box')) {
      const match = url.match(/^([a-zA-Z0-9-]+\.(?:eth|box))/);
      return match ? match[1] : null;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Detect protocol from URL for icon display
 */
const detectProtocol = (url) => {
  if (!url) return 'http';
  if (url.startsWith('bzz://') || url.includes('.eth') || url.includes('.box')) return 'swarm';
  if (url.startsWith('ipfs://')) return 'ipfs';
  if (url.startsWith('ipns://')) return 'ipns';
  if (url.startsWith('https://')) return 'https';
  return 'http';
};

/**
 * Score and rank suggestions based on query match
 */
const scoreSuggestion = (item, query) => {
  const url = (item.url || item.target || '').toLowerCase();
  const title = (item.title || item.label || '').toLowerCase();
  const q = query.toLowerCase();

  let score = 0;

  // URL matching
  if (url.startsWith(q)) score += 100;
  else if (url.includes(q)) score += 50;

  // Title matching
  if (title.startsWith(q)) score += 80;
  else if (title.includes(q)) score += 30;

  // Visit count bonus (for history items)
  if (item.visit_count) {
    score += Math.min(Math.log(item.visit_count + 1) * 10, 50);
  }

  // Bookmark bonus
  if (item.isBookmark) score += 20;

  return score;
};

/**
 * Generate suggestions from query
 */
const generateSuggestions = (query) => {
  if (!query || query.length < 1) return [];

  const q = query.toLowerCase();
  const results = new Map(); // Use Map to dedupe by URL
  const rootDomains = new Set(); // Track which root domains we've added

  // Process open tabs first (highest priority)
  const openTabs = getOpenTabs();
  for (const tab of openTabs) {
    const url = tab.url || '';
    const title = tab.title || '';

    // Skip home page and internal pages
    if (!url || url.includes('/pages/home.html') || url.includes('/pages/')) continue;

    if (url.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      const score = 200 + scoreSuggestion({ url, title }, query); // High base score for tabs
      results.set(url, {
        url,
        title,
        protocol: detectProtocol(url),
        score,
        type: 'tab',
        tabId: tab.id,
        isActive: tab.isActive,
      });
    }
  }

  // Process history
  for (const item of historyCache) {
    const url = item.url || '';
    const title = item.title || '';

    // Check if matches
    if (url.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      const score = scoreSuggestion(item, query);
      if (score > 0) {
        // Don't overwrite tab entries
        if (!results.has(url)) {
          results.set(url, {
            url,
            title,
            protocol: detectProtocol(url),
            score,
            type: 'history',
            visit_count: item.visit_count || 1,
          });
        }

        // Extract and add root domain if this is a deeplink
        const root = extractRootDomain(url);
        if (root && root !== url && !rootDomains.has(root)) {
          rootDomains.add(root);
          // Only add root if it also matches the query
          if (root.toLowerCase().includes(q) && !results.has(root)) {
            results.set(root, {
              url: root,
              title: root,
              protocol: detectProtocol(root),
              score: score * 0.8, // Slightly lower than the deeplink
              type: 'history',
              visit_count: item.visit_count || 1,
            });
          }
        }
      }
    }
  }

  // Process bookmarks
  for (const item of bookmarksCache) {
    const url = item.target || '';
    const title = item.label || '';

    if (url.toLowerCase().includes(q) || title.toLowerCase().includes(q)) {
      const score = scoreSuggestion({ ...item, url, title, isBookmark: true }, query);
      const existing = results.get(url);
      // Only add if no tab/history entry or if this scores higher
      if (!existing || (existing.type !== 'tab' && existing.score < score)) {
        results.set(url, {
          url,
          title,
          protocol: detectProtocol(url),
          score,
          type: existing?.type === 'tab' ? 'tab' : 'bookmark', // Preserve tab type
          tabId: existing?.tabId,
        });
      }
    }
  }

  // Sort by score (highest first) and limit to 8
  return Array.from(results.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
};

/**
 * Get badge for item type
 */
const getTypeBadge = (item) => {
  if (item.type === 'tab') {
    return '<span class="autocomplete-type tab-badge">Tab</span>';
  }
  if (item.type === 'bookmark') {
    return '<span class="autocomplete-type">★</span>';
  }
  return '';
};

/**
 * Get first letter for placeholder
 */
const getPlaceholderLetter = (url) => {
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

/**
 * Render suggestions to dropdown
 */
const renderSuggestions = (suggestions) => {
  if (!dropdown) return;

  currentSuggestions = suggestions;
  selectedIndex = -1;

  if (suggestions.length === 0) {
    hide();
    return;
  }

  dropdown.innerHTML = suggestions
    .map(
      (item, index) => `
    <div class="autocomplete-item" data-index="${index}" data-url="${item.url}" ${item.tabId ? `data-tab-id="${item.tabId}"` : ''}>
      <div class="autocomplete-icon-container" data-favicon-url="${item.url}">
        <div class="autocomplete-icon-placeholder">${getPlaceholderLetter(item.url)}</div>
        <span class="autocomplete-protocol-badge protocol-${item.protocol}">${item.protocol.slice(0, 3)}</span>
      </div>
      <div class="autocomplete-text">
        <div class="autocomplete-title">${escapeHtml(item.title || item.url)}</div>
        <div class="autocomplete-url">${escapeHtml(item.url)}</div>
      </div>
      ${getTypeBadge(item)}
    </div>
  `
    )
    .join('');

  show();

  // Load favicons asynchronously
  loadFavicons();
};

/**
 * Load favicons for suggestions
 */
const loadFavicons = async () => {
  if (!electronAPI?.getCachedFavicon) return;

  const containers = dropdown.querySelectorAll('.autocomplete-icon-container');
  for (const container of containers) {
    const url = container.dataset.faviconUrl;
    if (!url) continue;

    try {
      const favicon = await electronAPI.getCachedFavicon(url);
      if (favicon && isOpen) {
        // Only update if dropdown still open
        const placeholder = container.querySelector('.autocomplete-icon-placeholder');
        const protocolBadge = container.querySelector('.autocomplete-protocol-badge');

        if (placeholder) {
          const img = document.createElement('img');
          img.className = 'autocomplete-favicon';
          img.src = favicon;
          img.alt = '';
          img.onerror = () => {
            img.replaceWith(placeholder);
            if (protocolBadge) protocolBadge.style.display = 'block';
          };
          placeholder.replaceWith(img);

          // Hide protocol badge for HTTP/HTTPS when favicon present
          if (protocolBadge) {
            const isHttpProtocol =
              protocolBadge.classList.contains('protocol-http') ||
              protocolBadge.classList.contains('protocol-https');
            if (isHttpProtocol) {
              protocolBadge.style.display = 'none';
            }
          }
        }
      }
    } catch {
      // Keep placeholder on error
    }
  }
};

/**
 * Escape HTML to prevent XSS
 */
const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

/**
 * Show dropdown
 */
const show = () => {
  if (!dropdown) return;
  // Close other menus first
  closeMenus();
  hideTabContextMenu();
  hideBookmarkContextMenu();
  showMenuBackdrop();
  dropdown.classList.remove('hidden');
  isOpen = true;
};

/**
 * Hide dropdown
 */
export const hide = () => {
  if (!dropdown) return;
  const wasOpen = isOpen;
  dropdown.classList.add('hidden');
  isOpen = false;
  selectedIndex = -1;
  currentSuggestions = [];
  if (wasOpen) {
    hideMenuBackdrop();
  }
};

/**
 * Update selection highlight
 */
const updateSelection = () => {
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.autocomplete-item');
  items.forEach((item, index) => {
    item.classList.toggle('selected', index === selectedIndex);
  });

  // Scroll selected item into view
  if (selectedIndex >= 0 && items[selectedIndex]) {
    items[selectedIndex].scrollIntoView({ block: 'nearest' });
  }
};

/**
 * Handle input changes
 */
const handleInput = () => {
  const query = addressInput?.value?.trim() || '';

  // Clear previous timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  if (query.length < 1) {
    hide();
    return;
  }

  // Debounce
  debounceTimer = setTimeout(() => {
    const suggestions = generateSuggestions(query);
    renderSuggestions(suggestions);
  }, 80);
};

/**
 * Handle keyboard navigation
 */
const handleKeyDown = (e) => {
  if (!isOpen) {
    // Open on arrow down if input has value
    if (e.key === 'ArrowDown' && addressInput?.value) {
      handleInput();
      e.preventDefault();
    }
    return;
  }

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % currentSuggestions.length;
      updateSelection();
      break;

    case 'ArrowUp':
      e.preventDefault();
      selectedIndex = selectedIndex <= 0 ? currentSuggestions.length - 1 : selectedIndex - 1;
      updateSelection();
      break;

    case 'Enter':
      if (selectedIndex >= 0 && currentSuggestions[selectedIndex]) {
        e.preventDefault();
        const suggestion = currentSuggestions[selectedIndex];
        hide();

        // If it's an open tab, switch to it
        if (suggestion.type === 'tab' && suggestion.tabId) {
          switchTab(suggestion.tabId);
          addressInput.blur();
        } else if (onNavigate) {
          addressInput.value = suggestion.url;
          onNavigate(suggestion.url);
          addressInput.blur();
        }
      } else {
        // Nothing selected - hide autocomplete and let normal form submit handle it
        hide();
      }
      break;

    case 'Escape':
      e.preventDefault();
      hide();
      break;

    case 'Tab':
      if (selectedIndex >= 0 && currentSuggestions[selectedIndex]) {
        e.preventDefault();
        addressInput.value = currentSuggestions[selectedIndex].url;
        hide();
      }
      break;
  }
};

/**
 * Handle click on suggestion
 */
const handleClick = (e) => {
  const item = e.target.closest('.autocomplete-item');
  if (!item) return;

  const url = item.dataset.url;
  const tabId = item.dataset.tabId;

  hide();

  // If it's an open tab, switch to it
  if (tabId) {
    switchTab(parseInt(tabId, 10));
    addressInput.blur();
  } else if (url && onNavigate) {
    addressInput.value = url;
    onNavigate(url);
    addressInput.blur();
  }
};

/**
 * Initialize autocomplete
 */
export const initAutocomplete = () => {
  dropdown = document.getElementById('autocomplete-dropdown');
  addressInput = document.getElementById('address-input');
  const webviewElement = document.getElementById('bzz-webview');

  if (!dropdown || !addressInput) {
    console.error('[Autocomplete] Required elements not found');
    return;
  }

  // Event listeners
  addressInput.addEventListener('input', handleInput);
  addressInput.addEventListener('keydown', handleKeyDown);
  dropdown.addEventListener('click', handleClick);

  // Close on webview interaction or window blur
  webviewElement?.addEventListener('focus', hide);
  webviewElement?.addEventListener('mousedown', hide);
  window.addEventListener('blur', hide);

  // Load initial cache
  refreshCache();

  pushDebug('[Autocomplete] Initialized');
};
