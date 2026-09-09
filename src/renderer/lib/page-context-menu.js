// Page context menu handler
import { state } from './state.js';
import { pushDebug } from './debug.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { isModalDialogOpen } from './modal-dialog.js';
import { deriveDisplayValue, applyEnsNamePreservation } from './url-utils.js';
import { isTrustInterstitialPageUrl } from './page-urls.js';
import {
  buildSearchUrl,
  clampSearchSelection,
  formatSearchMenuSelection,
  getSearchProviderLabel,
} from './search-utils.js';
import { placePopoverAtPoint } from './popover-bounds.js';
import { onWindowDeactivated } from './window-deactivation.js';

const electronAPI = window.electronAPI;

// DOM elements (initialized in initPageContextMenu)
let pageContextMenu = null;

// Current context from webview
let currentContext = null;

// The webview the menu was opened over, captured when it is shown so the
// keyboard can be handed back to exactly that page on dismissal — and never
// to a different tab an action opened in the meantime.
let menuWebview = null;

// The URL that webview was showing when the menu was raised. A context menu
// describes one document: every item on it (the link, the image, the
// selection, even Back/Forward's enabled state) was read off that page, so the
// moment the page changes underneath, the whole menu is stale. #308.
let menuPageUrl = null;

const currentUrlOf = (webview) => {
  try {
    return webview?.getURL?.() || null;
  } catch {
    return null;
  }
};

// The active (foreground) guest, or null.
const getActiveWebview = () =>
  document.getElementById('webview-container')?.querySelector('webview:not(.hidden)') || null;

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

// Write `Search <Engine> for "<selection>"` onto the selection group's search
// item, or hide it when there is nothing to search for. The engine name comes
// from the same provider the address bar searches with (Settings > Search,
// built-in or custom), so the two can never name different engines. #330.
const updateSearchSelectionItem = (context) => {
  const searchBtn = pageContextMenu?.querySelector('[data-action="search-selection"]');
  if (!searchBtn) return;

  // A password field's "selection" is the masking bullets (see
  // webview-preload.js), never worth quoting on a menu or sending to an engine.
  const selection = context?.isPasswordField
    ? ''
    : formatSearchMenuSelection(context?.selectedText);
  searchBtn.classList.toggle('hidden', !selection);
  if (!selection) return;

  const engine = getSearchProviderLabel(state.searchProvider, state.customSearchProviders);
  searchBtn.textContent = `Search ${engine} for "${selection}"`;
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

  // A browser-owned trust interstitial has no source worth showing: the
  // bytes are the shell's own bundled page, and its `file://` URL is the one
  // thing chrome must never publish — the onchain gate carries the
  // single-use approval token in a query param, and `view-source:<that URL>`
  // would land verbatim in the new tab's address bar, tab title and window
  // title. Drop the item rather than offering an action we then refuse.
  // See issue #235.
  const viewSourceBtn = pageContextMenu.querySelector('[data-action="view-source"]');
  if (viewSourceBtn) {
    viewSourceBtn.classList.toggle('hidden', isTrustInterstitialPageUrl(context.pageUrl));
  }

  updateSearchSelectionItem(context);

  // Update navigation button states
  const backBtn = pageContextMenu.querySelector('[data-action="back"]');
  const forwardBtn = pageContextMenu.querySelector('[data-action="forward"]');

  // Get the webview from the active tab
  const activeWebview = getActiveWebview();
  menuWebview = activeWebview;
  menuPageUrl = currentUrlOf(activeWebview) || context.pageUrl || null;

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

  // Lay the menu out without painting it. `placePopoverAtPoint` has to measure
  // it to decide the clamp and the flip, and the measurement is deferred a
  // frame because the visible groups were only just switched, so the height is
  // not final yet — but the menu must not be *seen* at the raw pointer for
  // that frame: near an edge it renders once hanging off the window, which the
  // pinned document now clips rather than scrolls (#328). `visibility: hidden`
  // still generates boxes, so the measurement is the real one; the `hidden`
  // class (`display: none`) would not.
  pageContextMenu.style.visibility = 'hidden';
  pageContextMenu.style.left = `${x}px`;
  pageContextMenu.style.top = `${y}px`;
  pageContextMenu.classList.remove('hidden');

  requestAnimationFrame(() => {
    // Dismissed inside the frame we waited for (a navigation, Escape, a click
    // on the backdrop): nothing to place, and `visibility` must not be cleared
    // on a menu that is hidden again.
    if (pageContextMenu.classList.contains('hidden')) return;
    // Clamp into the viewport, flipping up when the space below the pointer is
    // too small and scrolling inside when neither side fits — the shared rule
    // every chrome popover follows (#324).
    placePopoverAtPoint(pageContextMenu, x, y);
    pageContextMenu.style.visibility = '';

    // An open menu owns the keyboard. This is the one chrome surface raised
    // from *inside* the guest page, so it is the only one that can be up while
    // the `<webview>` still holds focus — and a keypress that lands in the
    // guest never reaches the shell's own `keydown` handler, so Escape would
    // not dismiss it. (Focusing the guest on every tab activation, #304,
    // turned that from a rare state into the normal one.) Take focus here and
    // hand it back to the page in `hidePageContextMenu`, the way a native menu
    // does — after the reveal, since a `visibility: hidden` element cannot
    // take focus at all.
    pageContextMenu.focus?.();
  });
};

// Hide the context menu.
//
// `restoreFocus` hands the keyboard back to the page the menu was opened over
// (see `showPageContextMenu`); pass `false` from paths that fire while the
// window is already losing focus, so dismissal never pulls focus back in.
export const hidePageContextMenu = ({ restoreFocus = true } = {}) => {
  if (pageContextMenu) {
    const wasVisible = !pageContextMenu.classList.contains('hidden');
    // Only give the keyboard back when the menu still holds it: a click that
    // moved focus elsewhere in chrome (the address bar, say) dismisses the
    // menu too, and grabbing focus back for the page would undo that click.
    const heldFocus = wasVisible && pageContextMenu.contains(document.activeElement);
    pageContextMenu.classList.add('hidden');
    if (wasVisible) {
      hideMenuBackdrop();
    }
    // Never focus a *different* page: an action that opened a new tab has
    // already moved the foreground on, and that tab owns its own focus
    // (address bar on this window's new-tab page, #312).
    if (restoreFocus && heldFocus && menuWebview && menuWebview === getActiveWebview()) {
      menuWebview.focus?.();
    }
  }
  currentContext = null;
  menuWebview = null;
  menuPageUrl = null;
};

// True when the menu is up but the page it describes is gone — the tab
// navigated (a redirect, a slow load finishing, Back, a reload) or the
// foreground moved to another tab. Chrome's context menu never outlives its
// document; this is the belt to the navigation braces below, so even a
// navigation nobody reported to us can't be acted on. #308.
const contextIsStale = () => {
  if (!menuWebview) return false;
  if (menuWebview !== getActiveWebview()) return true;
  const url = currentUrlOf(menuWebview);
  return Boolean(menuPageUrl && url && url !== menuPageUrl);
};

// A navigation in `webview` (or in whichever tab owns the menu, when called
// without one) dismisses the menu. Wired from the same per-tab navigation path
// the find bar uses, tabs.js — a menu raised on page A must not still be
// offering "Open Link in New Tab" over page B. #308.
export const notifyPageContextMenuNavigated = (webview) => {
  if (!pageContextMenu || pageContextMenu.classList.contains('hidden')) return;
  if (webview && menuWebview && webview !== menuWebview) return;
  // The page the keyboard would go back to is the one that just went away, so
  // let the incoming document take focus on its own terms.
  hidePageContextMenu({ restoreFocus: false });
};

// Handle context menu action.
//
// `background` carries the Ctrl/Cmd the item was activated with: Chrome opens
// a context-menu search in the foreground on a plain click and behind the
// current tab when the click is modified.
const handleAction = async (action, { background = false } = {}) => {
  // A context that went missing (a window blur nulls it while the menu can
  // still be on screen) means the action is a no-op — but the menu must come
  // down all the same. Returning early used to leave it up with every item
  // still live.
  if (!currentContext) {
    hidePageContextMenu();
    return;
  }

  // The page moved on since the menu was raised (a navigation that reached us
  // through no event, a tab switch). Every item here refers to a document that
  // is no longer on screen — opening its link, copying its address or
  // view-sourcing it would act on a page the user is no longer looking at, so
  // take the menu down and do nothing. #308.
  if (contextIsStale()) {
    pushDebug('[PageContextMenu] Dropping an action for a page that has navigated away');
    hidePageContextMenu({ restoreFocus: false });
    return;
  }

  const activeWebview = getActiveWebview();

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
        // The item is hidden on trust interstitials (see showPageContextMenu);
        // refuse here too so a stale context can't smuggle the gate's
        // token-bearing file:// URL into a new tab's chrome. See issue #235.
        if (isTrustInterstitialPageUrl(currentContext.pageUrl)) {
          pushDebug('Refusing view source for a browser-owned trust interstitial');
          break;
        }
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

    case 'search-selection': {
      // The item is hidden over a password field (see showPageContextMenu);
      // refuse here too, so a stale context or a scripted click can't send the
      // masked value to a search engine.
      if (currentContext.isPasswordField) {
        pushDebug('Refusing to search the selection in a password field');
        break;
      }
      // The selection is the query, clamped to SEARCH_SELECTION_MAX the way
      // Chrome clamps its own context-menu selection text — a select-all on a
      // long page must not build a query the size of the document, which would
      // be navigated to and stored in history verbatim (and silently dropped
      // once it runs past Chromium's maximum URL length). The elision in the
      // label is separate, and only what the menu row shows. buildSearchUrl
      // then trims and encodes it, the same call the address bar makes for
      // typed input that is not a URL. #330.
      const searchUrl = buildSearchUrl(
        clampSearchSelection(currentContext.selectedText),
        state.searchProvider,
        state.customSearchProviders
      );
      if (searchUrl) {
        pushDebug(`Searching for the selection${background ? ' in a background tab' : ''}`);
        document.dispatchEvent(
          new CustomEvent('open-url-new-tab', {
            detail: { url: searchUrl, background },
          })
        );
      }
      break;
    }

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
          pushDebug(`Failed to save image: ${result.error}`);
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
          pushDebug(`Failed to copy image: ${result.error}`);
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
        handleAction(action, { background: e.ctrlKey === true || e.metaKey === true });
      }
    });
  }

  // Hide context menu on click elsewhere
  document.addEventListener('click', (e) => {
    if (pageContextMenu && !pageContextMenu.contains(e.target)) {
      hidePageContextMenu();
    }
  });

  // Hide on escape. A press that actually closes the menu is consumed
  // (`preventDefault`), so navigation.js's window-level Escape doesn't also
  // stop an in-flight page load — Chrome closes the innermost surface only.
  // See #306.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!pageContextMenu || pageContextMenu.classList.contains('hidden')) return;
    // A modal <dialog> raised over the menu owns the press and cannot mark it
    // — see `isModalDialogOpen`.
    if (isModalDialogOpen()) return;
    e.preventDefault();
    hidePageContextMenu();
  });

  // Hide when the window is deactivated — without the focus hand-back, which
  // would pull the keyboard back into a window that is on its way out. A
  // `<webview>` guest taking the keyboard raises the same `blur` while the
  // window is still active and must not close the menu (#328).
  onWindowDeactivated(() => hidePageContextMenu({ restoreFocus: false }));

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
