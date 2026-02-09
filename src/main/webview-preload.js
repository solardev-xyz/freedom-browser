/**
 * Preload script for webviews
 *
 * This runs in the context of all webviews:
 * - Exposes freedomAPI for internal pages (freedom://history, etc.)
 * - Handles context menu for all pages
 */

const { contextBridge, ipcRenderer } = require('electron');

// Internal pages list — canonical source is src/shared/internal-pages.json,
// served by the main process via sync IPC so preloads don't need require().
const internalPages = ipcRenderer.sendSync('internal:get-pages');

// Whitelist of all internal page files (routable + other like error.html)
const ALLOWED_FILES = [...Object.values(internalPages.routable), ...internalPages.other];

const isInternalPage = () => {
  const location = globalThis.location;
  if (!location || location.protocol !== 'file:') return false;
  const pathname = location.pathname || '';
  return ALLOWED_FILES.some((file) => pathname.endsWith(`/pages/${file}`));
};

const guardInternal =
  (name, fn) =>
  (...args) => {
    if (!isInternalPage()) {
      const url = globalThis.location?.href || 'unknown';
      console.warn(`[freedomAPI] blocked "${name}" on non-internal page: ${url}`);
      return Promise.reject(new Error('freedomAPI is only available on internal pages'));
    }
    return fn(...args);
  };

// Expose APIs to internal pages (guarded for safety)
contextBridge.exposeInMainWorld('freedomAPI', {
  // History
  getHistory: guardInternal('getHistory', (options) => ipcRenderer.invoke('history:get', options)),
  addHistory: guardInternal('addHistory', (entry) => ipcRenderer.invoke('history:add', entry)),
  removeHistory: guardInternal('removeHistory', (id) => ipcRenderer.invoke('history:remove', id)),
  clearHistory: guardInternal('clearHistory', () => ipcRenderer.invoke('history:clear')),

  // Settings (read-only for internal pages)
  getSettings: guardInternal('getSettings', () => ipcRenderer.invoke('settings:get')),

  // Bookmarks (read-only for internal pages)
  getBookmarks: guardInternal('getBookmarks', () => ipcRenderer.invoke('bookmarks:get')),

  // Navigation
  openInNewTab: guardInternal('openInNewTab', (url) =>
    ipcRenderer.invoke('internal:open-url-in-new-tab', url)
  ),

  // Favicons
  getCachedFavicon: guardInternal('getCachedFavicon', (url) =>
    ipcRenderer.invoke('favicon:get-cached', url)
  ),
});

// ============================================
// Context Menu Handler (works on all pages)
// ============================================

// Get context information when right-clicking
document.addEventListener(
  'contextmenu',
  (event) => {
    const context = {
      x: event.clientX,
      y: event.clientY,
      pageUrl: window.location.href,
      pageTitle: document.title,
      linkUrl: null,
      linkText: null,
      selectedText: null,
      imageSrc: null,
      imageAlt: null,
      isEditable: false,
      mediaType: null,
    };

    // Check for selected text
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      context.selectedText = selection.toString();
    }

    // Walk up the DOM tree to find links, images, etc.
    let element = event.target;
    while (element && element !== document.body) {
      // Check for links
      if (element.tagName === 'A' && element.href) {
        context.linkUrl = element.href;
        context.linkText = element.textContent?.trim() || '';
      }

      // Check for images
      if (element.tagName === 'IMG' && element.src) {
        context.imageSrc = element.src;
        context.imageAlt = element.alt || '';
        context.mediaType = 'image';
      }

      // Check for video
      if (element.tagName === 'VIDEO') {
        context.mediaType = 'video';
        if (element.src) {
          context.mediaSrc = element.src;
        } else if (element.querySelector('source')) {
          context.mediaSrc = element.querySelector('source').src;
        }
      }

      // Check for audio
      if (element.tagName === 'AUDIO') {
        context.mediaType = 'audio';
        if (element.src) {
          context.mediaSrc = element.src;
        } else if (element.querySelector('source')) {
          context.mediaSrc = element.querySelector('source').src;
        }
      }

      // Check if element is editable
      if (
        element.tagName === 'INPUT' ||
        element.tagName === 'TEXTAREA' ||
        element.isContentEditable
      ) {
        context.isEditable = true;
      }

      element = element.parentElement;
    }

    // Prevent the default context menu
    event.preventDefault();

    // Send context info to the host renderer
    ipcRenderer.sendToHost('context-menu', context);
  },
  true
);

// Handle context menu actions from the renderer
ipcRenderer.on('context-menu-action', (_event, action, data) => {
  switch (action) {
    case 'copy':
      document.execCommand('copy');
      break;
    case 'cut':
      document.execCommand('cut');
      break;
    case 'paste':
      document.execCommand('paste');
      break;
    case 'select-all':
      document.execCommand('selectAll');
      break;
    case 'copy-text':
      if (data?.text) {
        navigator.clipboard.writeText(data.text).catch(console.error);
      }
      break;
  }
});

console.log('[webview-preload] Loaded (freedomAPI + context menu)');
