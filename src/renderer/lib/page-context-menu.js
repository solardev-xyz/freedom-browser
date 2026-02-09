// Page context menu handler
import { state } from './state.js';
import { pushDebug } from './debug.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { deriveDisplayValue, applyEnsNamePreservation } from './url-utils.js';

const electronAPI = window.electronAPI;

// DOM elements (initialized in initPageContextMenu)
let pageContextMenu = null;

// Current context from webview
let currentContext = null;

// Convert internal gateway URL to dweb URL for display/copying
const toDwebUrl = (url) => {
  if (!url) return url;

  // Get display value (converts gateway URLs to protocol URLs)
  let display = deriveDisplayValue(
    url,
    state.bzzRoutePrefix,
    '', // homeUrlNormalized - empty to not match
    state.ipfsRoutePrefix,
    state.ipnsRoutePrefix
  );

  // Apply ENS name preservation
  display = applyEnsNamePreservation(display, state.knownEnsNames);

  return display || url;
};

// Show context menu for the given context
export const showPageContextMenu = (x, y, context) => {
  if (!pageContextMenu) return;

  currentContext = context;

  // Hide all groups first
  const groups = pageContextMenu.querySelectorAll('.context-menu-group');
  groups.forEach((g) => g.classList.remove('visible'));

  // Determine which groups to show based on context
  // Priority: image > link > selection > page

  if (context.imageSrc) {
    // Image context - show image menu
    const imageGroup = pageContextMenu.querySelector('[data-group="image"]');
    if (imageGroup) imageGroup.classList.add('visible');
  } else if (context.linkUrl) {
    // Link context - show link menu
    const linkGroup = pageContextMenu.querySelector('[data-group="link"]');
    if (linkGroup) linkGroup.classList.add('visible');
  } else if (context.selectedText) {
    // Selection context - show selection menu
    const selectionGroup = pageContextMenu.querySelector('[data-group="selection"]');
    if (selectionGroup) selectionGroup.classList.add('visible');
  } else {
    // Page context - show page menu
    const pageGroup = pageContextMenu.querySelector('[data-group="page"]');
    if (pageGroup) pageGroup.classList.add('visible');
  }

  // Update navigation button states
  const backBtn = pageContextMenu.querySelector('[data-action="back"]');
  const forwardBtn = pageContextMenu.querySelector('[data-action="forward"]');

  // Get the webview from the active tab
  const webviewContainer = document.getElementById('webview-container');
  const activeWebview = webviewContainer?.querySelector('webview:not(.hidden)');

  if (backBtn && activeWebview) {
    try {
      backBtn.disabled = !activeWebview.canGoBack();
    } catch {
      backBtn.disabled = true;
    }
  }

  if (forwardBtn && activeWebview) {
    try {
      forwardBtn.disabled = !activeWebview.canGoForward();
    } catch {
      forwardBtn.disabled = true;
    }
  }

  showMenuBackdrop();

  // Position the menu
  pageContextMenu.style.left = `${x}px`;
  pageContextMenu.style.top = `${y}px`;
  pageContextMenu.classList.remove('hidden');

  // Adjust position if menu goes off screen
  requestAnimationFrame(() => {
    const rect = pageContextMenu.getBoundingClientRect();
    let newX = x;
    let newY = y;

    if (rect.right > window.innerWidth) {
      newX = window.innerWidth - rect.width - 8;
    }
    if (rect.bottom > window.innerHeight) {
      newY = window.innerHeight - rect.height - 8;
    }
    if (newX < 8) newX = 8;
    if (newY < 8) newY = 8;

    pageContextMenu.style.left = `${newX}px`;
    pageContextMenu.style.top = `${newY}px`;
  });
};

// Hide the context menu
export const hidePageContextMenu = () => {
  if (pageContextMenu) {
    const wasVisible = !pageContextMenu.classList.contains('hidden');
    pageContextMenu.classList.add('hidden');
    if (wasVisible) {
      hideMenuBackdrop();
    }
  }
  currentContext = null;
};

// Handle context menu action
const handleAction = async (action) => {
  if (!currentContext) return;

  const webviewContainer = document.getElementById('webview-container');
  const activeWebview = webviewContainer?.querySelector('webview:not(.hidden)');

  switch (action) {
    case 'back':
      if (activeWebview?.canGoBack()) {
        activeWebview.goBack();
      }
      break;

    case 'forward':
      if (activeWebview?.canGoForward()) {
        activeWebview.goForward();
      }
      break;

    case 'reload':
      activeWebview?.reloadIgnoringCache();
      break;

    case 'view-source':
      if (currentContext.pageUrl) {
        // Pass the raw gateway URL - the address bar will derive the display value
        const viewSourceUrl = `view-source:${currentContext.pageUrl}`;
        pushDebug(`Opening view source: ${viewSourceUrl}`);
        document.dispatchEvent(
          new CustomEvent('open-url-new-tab', {
            detail: { url: viewSourceUrl },
          })
        );
      }
      break;

    case 'inspect':
      activeWebview?.openDevTools();
      break;

    case 'open-link-new-tab':
      if (currentContext.linkUrl) {
        // Use original URL for loading (webview can't handle dweb:// protocols directly)
        pushDebug(`Opening link in new tab: ${currentContext.linkUrl}`);
        document.dispatchEvent(
          new CustomEvent('open-url-new-tab', {
            detail: { url: currentContext.linkUrl },
          })
        );
      }
      break;

    case 'open-link-new-window':
      if (currentContext.linkUrl) {
        // Use dweb URL - the new window's loadTarget will resolve it properly
        const dwebUrl = toDwebUrl(currentContext.linkUrl);
        pushDebug(`Opening link in new window: ${dwebUrl}`);
        electronAPI?.openUrlInNewWindow?.(dwebUrl);
      }
      break;

    case 'copy-link':
      if (currentContext.linkUrl) {
        const dwebUrl = toDwebUrl(currentContext.linkUrl);
        electronAPI?.copyText?.(dwebUrl);
        pushDebug(`Copied link: ${dwebUrl}`);
      }
      break;

    case 'copy':
      if (currentContext.selectedText) {
        try {
          await navigator.clipboard.writeText(currentContext.selectedText);
          pushDebug('Copied selected text');
        } catch {
          // Fall back to webview copy command
          activeWebview?.send?.('context-menu-action', 'copy');
        }
      }
      break;

    case 'open-image-new-tab':
      if (currentContext.imageSrc) {
        // Use original URL for loading (webview can't handle dweb:// protocols directly)
        pushDebug(`Opening image in new tab: ${currentContext.imageSrc}`);
        document.dispatchEvent(
          new CustomEvent('open-url-new-tab', {
            detail: { url: currentContext.imageSrc },
          })
        );
      }
      break;

    case 'save-image':
      if (currentContext.imageSrc) {
        pushDebug(`Saving image: ${currentContext.imageSrc}`);
        const result = await electronAPI?.saveImage?.(currentContext.imageSrc);
        if (result?.success) {
          pushDebug(`Image saved to: ${result.filePath}`);
        } else if (result?.error) {
          console.error('Failed to save image:', result.error);
        }
      }
      break;

    case 'copy-image':
      if (currentContext.imageSrc) {
        const result = await electronAPI?.copyImageFromUrl?.(currentContext.imageSrc);
        if (result?.success) {
          pushDebug('Copied image to clipboard');
        } else if (result?.error) {
          console.error('Failed to copy image:', result.error);
        }
      }
      break;

    case 'copy-image-address':
      if (currentContext.imageSrc) {
        const dwebUrl = toDwebUrl(currentContext.imageSrc);
        electronAPI?.copyText?.(dwebUrl);
        pushDebug(`Copied image address: ${dwebUrl}`);
      }
      break;
  }

  hidePageContextMenu();
};

// Initialize the page context menu
export const initPageContextMenu = async () => {
  pageContextMenu = document.getElementById('page-context-menu');

  // Handle menu item clicks
  if (pageContextMenu) {
    pageContextMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.context-menu-item');
      if (!item || item.disabled) return;

      const action = item.dataset.action;
      if (action) {
        handleAction(action);
      }
    });
  }

  // Hide context menu on click elsewhere
  document.addEventListener('click', (e) => {
    if (pageContextMenu && !pageContextMenu.contains(e.target)) {
      hidePageContextMenu();
    }
  });

  // Hide on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hidePageContextMenu();
    }
  });

  // Hide when window loses focus
  window.addEventListener('blur', hidePageContextMenu);

  pushDebug('[PageContextMenu] Initialized');
};

// Setup context menu listener for a webview
export const setupWebviewContextMenu = (webview) => {
  if (!webview) return;

  // Listen for context-menu events from the webview
  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'context-menu') {
      const context = event.args[0];
      if (context) {
        // Convert webview coordinates to window coordinates
        const rect = webview.getBoundingClientRect();
        const x = rect.left + context.x;
        const y = rect.top + context.y;

        showPageContextMenu(x, y, context);
      }
    }
  });
};
