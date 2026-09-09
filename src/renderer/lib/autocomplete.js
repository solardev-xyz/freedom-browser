// Autocomplete module for address bar suggestions
import { pushDebug } from './debug.js';
import { getOpenTabs, switchTab, hideTabContextMenu } from './tabs.js';
import { closeMenus } from './menus.js';
import { hideBookmarkContextMenu } from './bookmarks-ui.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { boundPopoverToViewport } from './popover-bounds.js';
import { onWindowDeactivated } from './window-deactivation.js';
import {
  generateSuggestions as generateAutocompleteSuggestions,
  getPlaceholderLetter,
} from './autocomplete-utils.js';
import {
  applyInputSelection,
  captureInputSelection,
  clearAddressBarEdit,
  setAddressBarEdit,
} from './address-bar-edit.js';

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
// The text the user typed, restored whenever the highlight comes back to
// "row 0" — arrowing off either end of the list, or the first Escape.
// `originalSelection` keeps the caret/selection that went with it.
let originalQuery = '';
let originalSelection = null;
// True once a keyboard preview has written a suggestion's URL over the typed
// text (mouse hover only moves the highlight). It's what makes the first
// Escape this module's to own — there is something to restore. See #310/#313.
let previewWroteInput = false;

// Callbacks
let onNavigate = null;

// Picking a suggestion *is* the user committing the omnibox, exactly like a
// form submit — not a menu item or a bookmark that navigates for an unrelated
// reason. `loadTarget` needs the distinction for a `freedom://` page answered
// by another tab: the committed text must stop being the leaving tab's draft,
// while an unrelated one is held. See `loadTarget`'s `commitsAddressBar`.
const COMMIT_OPTIONS = { commitsAddressBar: true };

/**
 * Set the navigation callback. Called as `(url, options)`; the options are
 * `loadTarget`'s, so the navigate branches below can say what kind of
 * navigation a picked suggestion is (see `COMMIT_OPTIONS`).
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

const generateSuggestions = (query) =>
  generateAutocompleteSuggestions(query, {
    openTabs: getOpenTabs(),
    historyItems: historyCache,
    bookmarks: bookmarksCache,
  });

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
  // The list has its own 360 px cap, but on a short window even that reaches
  // past the bottom edge: bound it to the viewport like every other chrome
  // popover (#324).
  dropdown.scrollTop = 0;
  boundPopoverToViewport(dropdown);
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
  previewWroteInput = false;
  currentSuggestions = [];
  originalQuery = '';
  originalSelection = null;
  if (wasOpen) {
    hideMenuBackdrop();
  }
};

/**
 * True while the address bar shows a *previewed* suggestion rather than the
 * user's own text. That is exactly the state in which this module owns the
 * Escape press (it returns to the typed text); navigation.js reads it to
 * stand down for that one press and take over from the next. See #310.
 *
 * Keyed on whether a preview actually rewrote the input, not on the highlight:
 * mouse hover moves the highlight without touching the bar's text, so an
 * Escape after a mere hover has nothing to restore and must not cost the user
 * an extra press — Chrome closes the list and reverts in one.
 */
export const isSuggestionPreviewActive = () => isOpen && previewWroteInput;

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
 * Remember the text the user typed before the highlight left "row 0", so any
 * path back to it (ArrowUp off the first suggestion, Escape) can restore both
 * the string and the caret.
 */
const captureTypedText = () => {
  originalQuery = addressInput.value;
  originalSelection = captureInputSelection(addressInput);
};

/** Put the user's typed text (and caret) back, with nothing highlighted. */
const restoreTypedText = () => {
  selectedIndex = -1;
  previewWroteInput = false;
  updateSelection();
  addressInput.value = originalQuery;
  applyInputSelection(addressInput, originalSelection);
  setAddressBarEdit(originalQuery, originalSelection);
};

/**
 * Keyboard selection: highlight a row and preview its URL in the address bar.
 * `index === -1` means the typed-text row, which is a real row here (Chrome's
 * default match) rather than a wrap-around target. See #313.
 */
const previewRow = (index) => {
  if (selectedIndex === -1) captureTypedText();
  if (index < 0) {
    restoreTypedText();
    return;
  }
  selectedIndex = index;
  updateSelection();
  addressInput.value = currentSuggestions[selectedIndex]?.url || '';
  previewWroteInput = true;
  // A previewed suggestion is still an uncommitted edit of this tab's address
  // bar: it survives page commits (#305) and tab switches (#314).
  setAddressBarEdit(addressInput.value, null);
};

/**
 * Mouse hover: move the highlight without rewriting the address bar (Chrome
 * previews on keyboard selection only), so Enter commits the row under the
 * cursor instead of the typed text. See #313.
 */
const highlightRow = (index) => {
  if (index === selectedIndex || !currentSuggestions[index]) return;
  if (selectedIndex === -1) captureTypedText();
  selectedIndex = index;
  updateSelection();
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
      return;
    }
    // User committed before the 80 ms debounce fired. Cancel the
    // pending suggestion render so the dropdown doesn't pop open
    // after the navigation has already started.
    if ((e.key === 'Enter' || e.key === 'Escape') && debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return;
  }

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      // The list stops at its last row — no wrap back to the top. #313.
      if (selectedIndex < currentSuggestions.length - 1) {
        previewRow(selectedIndex + 1);
      }
      break;

    case 'ArrowUp':
      e.preventDefault();
      // Row -1 *is* the user's typed text (Chrome's default match), so
      // ArrowUp off the first suggestion returns to it — and stops there
      // rather than wrapping to the bottom of the list. #313.
      if (selectedIndex >= 0) {
        previewRow(selectedIndex - 1);
      }
      break;

    case 'Enter':
      if (selectedIndex >= 0 && currentSuggestions[selectedIndex]) {
        e.preventDefault();
        const suggestion = currentSuggestions[selectedIndex];
        hide();

        // If it's an open tab, switch to it
        if (suggestion.type === 'tab' && suggestion.tabId) {
          // Picking a suggestion commits the omnibox: the tab we're leaving
          // no longer has an edit in progress. `loadTarget` does this for the
          // navigating branch below (`COMMIT_OPTIONS` makes that hold even
          // when the target routes into another tab); the tab-switch branch
          // has to do it here.
          // `fromAddressBarCommit` tells the tab-switch handler not to adopt
          // the bar's leftover text (the previewed target URL, or the query)
          // as the leaving tab's page display.
          clearAddressBarEdit();
          switchTab(suggestion.tabId, { fromAddressBarCommit: true });
          addressInput.blur();
        } else if (onNavigate) {
          addressInput.value = suggestion.url;
          onNavigate(suggestion.url, COMMIT_OPTIONS);
          addressInput.blur();
        }
      } else {
        // Nothing selected - hide autocomplete and let normal form submit handle it
        hide();
      }
      break;

    case 'Escape':
      // The dropdown owns the first Escape: come back to the text the user
      // typed, keep focus in the bar, and close the list. navigation.js takes
      // the next press (revert to the page URL, still focused) and the one
      // after that (focus the page). #310.
      e.preventDefault();
      e.stopPropagation();
      // Only a keyboard preview rewrote the bar; a hovered row left the typed
      // text alone, so there is nothing to restore and navigation.js' handler
      // (which ran first, having stood down only for a real preview) already
      // reverted to the page URL. Writing `originalQuery` back here would undo
      // that revert. #310.
      if (previewWroteInput) {
        restoreTypedText();
      }
      hide();
      break;

    case 'Tab':
      if (selectedIndex >= 0 && currentSuggestions[selectedIndex]) {
        e.preventDefault();
        addressInput.value = currentSuggestions[selectedIndex].url;
        // Completed into the bar but not submitted: still an uncommitted edit.
        setAddressBarEdit(addressInput.value, null);
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
    // Committing by mouse ends the edit for the tab we're leaving, same as
    // the keyboard path — including the "don't adopt the bar's text" flag.
    clearAddressBarEdit();
    switchTab(parseInt(tabId, 10), { fromAddressBarCommit: true });
    addressInput.blur();
  } else if (url && onNavigate) {
    addressInput.value = url;
    onNavigate(url, COMMIT_OPTIONS);
    addressInput.blur();
  }
};

/**
 * Handle mouse hover over a suggestion
 */
const handleMouseMove = (e) => {
  const item = e.target?.closest?.('.autocomplete-item');
  if (!item) return;
  const index = Number.parseInt(item.dataset.index, 10);
  if (Number.isNaN(index)) return;
  highlightRow(index);
};

/**
 * Initialize autocomplete
 */
export const initAutocomplete = () => {
  dropdown = document.getElementById('autocomplete-dropdown');
  addressInput = document.getElementById('address-input');

  if (!dropdown || !addressInput) {
    console.error('[Autocomplete] Required elements not found');
    return;
  }

  // Event listeners
  addressInput.addEventListener('input', handleInput);
  addressInput.addEventListener('keydown', handleKeyDown);
  dropdown.addEventListener('click', handleClick);
  // Mouse hover moves the highlight, so Enter commits the row under the
  // cursor rather than the typed text. #313.
  dropdown.addEventListener('mousemove', handleMouseMove);

  // Close on webview interaction or window blur
  // (The `focus`/`mousedown` dismissal that used to hang off
  // `document.getElementById('bzz-webview')` is gone: webviews are created
  // id-less, so that lookup was always null and the listeners never existed.
  // `#menu-backdrop` covers the window while the dropdown is open, so a click into
  // the page dismisses it through the document listener above. See #306.)
  // Window deactivation only: a `<webview>` guest taking the keyboard raises
  // the same event while the window is still active (#328).
  onWindowDeactivated(hide);

  // Load initial cache
  refreshCache();

  pushDebug('[Autocomplete] Initialized');
};
