// Bookmarks bar and modal UI
import { pushDebug } from './debug.js';
import { getActiveTab, hideTabContextMenu, openInNewTabWithTarget } from './tabs.js';
import { closeMenus } from './menus.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { isModalDialogOpen } from './modal-dialog.js';
import { normalizeLegacyEnsBookmarkUrl } from './url-utils.js';
import { boundPopoverToViewport, placePopoverAtPoint } from './popover-bounds.js';
import { onWindowDeactivated } from './window-deactivation.js';

const electronAPI = window.electronAPI;

// Bookmarks bar visibility state
let bookmarksBarVisible = false; // User preference for non-home pages
let isOnHomePage = true; // Track if we're on the home page

// Check if a URL is bookmarkable
const isBookmarkableUrl = (url) => {
  if (!url) return false;
  return (
    url.startsWith('bzz://') ||
    url.startsWith('ipfs://') ||
    url.startsWith('ipns://') ||
    url.startsWith('web3://') ||
    url.startsWith('rad://') ||
    url.startsWith('ens://') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('freedom://')
  );
};

// DOM elements (initialized in initBookmarks)
let bookmarksBar = null;
let bookmarksInner = null;
let overflowBtn = null;
let overflowMenu = null;
let addBookmarkBtn = null;
let addBookmarkModal = null;
let addBookmarkForm = null;
let closeAddBookmarkBtn = null;
let bookmarkLabelInput = null;
let bookmarkTargetInput = null;
let bookmarkModalTitle = null;
let bookmarkSubmitBtn = null;
let addressInput = null;
let contextMenu = null;
let contextMenuTarget = null;
export let hideBookmarkContextMenu = () => {};
export let hideOverflowMenu = () => {};

// Edit mode state
let isEditMode = false;
let editOriginalTarget = null;

// Callback for loading a target (set by navigation module)
let onLoadTarget = null;

export const setOnLoadTarget = (callback) => {
  onLoadTarget = callback;
};

// Callback for when context menu opens (to close other dropdowns like autocomplete)
let onContextMenuOpening = null;
export const setOnBookmarkContextMenuOpening = (callback) => {
  onContextMenuOpening = callback;
};

// Default globe icon for bookmarks without favicon
const BOOKMARK_GLOBE_SVG = `<svg class="bookmark-icon-default" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

// Store all bookmarks for overflow calculation
let allBookmarks = [];

// Which tab a bookmark activation should land in, from the mouse event that
// triggered it — Chrome's dispositions, and the same rules the tab strip and
// page links already follow (#303, #307):
//
//   Ctrl/Cmd+click, middle-click  -> background tab, current page untouched
//   +Shift                        -> the same tab, but foregrounded
//   Shift+click                   -> new window
//   plain click                   -> this tab
export const bookmarkDisposition = (event) => {
  const middle = event?.type === 'auxclick' && event.button === 1;
  if (middle || event?.ctrlKey || event?.metaKey) {
    return event?.shiftKey ? 'foreground-tab' : 'background-tab';
  }
  if (event?.shiftKey) return 'new-window';
  return 'current-tab';
};

// Drag state for bookmark reordering (mirrors the tab strip's, tabs.js).
let draggedBookmarkTarget = null;
let isDraggingBookmark = false;

// Create a bookmark button element
const createBookmarkButton = (item, isOverflowItem = false) => {
  const button = document.createElement('button');
  button.className = isOverflowItem ? 'bookmarks-overflow-item' : 'bookmark';
  button.dataset.hash = item.target;
  button.dataset.test = isOverflowItem ? 'bookmark-overflow-item' : 'bookmark-item';
  // Bar entries reorder by drag, like Chrome's bookmarks bar (#307). The
  // overflow menu is a transient popup — dragging inside it is not offered.
  if (!isOverflowItem) {
    button.draggable = true;
    attachBookmarkDragHandlers(button, item.target);
  }

  // Create icon container
  const iconContainer = document.createElement('span');
  iconContainer.className = 'bookmark-icon-container';
  iconContainer.innerHTML = BOOKMARK_GLOBE_SVG;

  // Create favicon image element
  const faviconEl = document.createElement('img');
  faviconEl.className = 'bookmark-favicon';
  faviconEl.alt = '';
  iconContainer.appendChild(faviconEl);

  // Create label element
  const labelEl = document.createElement('span');
  labelEl.className = 'bookmark-label';
  labelEl.textContent = item.label || item.target;

  button.appendChild(iconContainer);
  button.appendChild(labelEl);

  // Try to load cached favicon asynchronously
  if (electronAPI?.getCachedFavicon) {
    electronAPI
      .getCachedFavicon(item.target)
      .then((favicon) => {
        if (favicon) {
          faviconEl.src = favicon;
          iconContainer.dataset.state = 'favicon';
          faviconEl.onerror = () => {
            iconContainer.dataset.state = 'default';
          };
        }
      })
      .catch(() => {
        // Silently ignore favicon fetch failures
      });
  }

  return button;
};

// Check which bookmarks overflow and update the UI accordingly
const updateOverflowState = () => {
  if (!bookmarksInner || !overflowBtn || !overflowMenu) return;

  // Clear overflow menu
  overflowMenu.innerHTML = '';

  // Get all bookmark buttons in the bar
  const bookmarkButtons = bookmarksInner.querySelectorAll('.bookmark');
  if (bookmarkButtons.length === 0) {
    overflowBtn.classList.remove('visible');
    return;
  }

  // First, show all bookmarks and hide overflow button to measure
  for (const btn of bookmarkButtons) {
    btn.classList.remove('overflow-hidden');
  }
  overflowBtn.classList.remove('visible');

  // Measure total bookmarks width and available width without overflow button
  const barWidthWithoutBtn = bookmarksInner.getBoundingClientRect().width;
  let totalBookmarksWidth = 0;

  for (const btn of bookmarkButtons) {
    totalBookmarksWidth += btn.offsetWidth + 2; // Include margins
  }

  // If all bookmarks fit, we're done
  if (totalBookmarksWidth <= barWidthWithoutBtn) {
    return;
  }

  // Some bookmarks overflow - show button and re-measure available width
  overflowBtn.classList.add('visible');
  // The flex container automatically shrinks to accommodate the button
  const availableWidth = bookmarksInner.getBoundingClientRect().width;

  // Find where overflow starts
  let accumulatedWidth = 0;
  let firstOverflowIndex = -1;

  for (let i = 0; i < bookmarkButtons.length; i++) {
    const btn = bookmarkButtons[i];
    const btnWidth = btn.offsetWidth + 2; // Include margins
    accumulatedWidth += btnWidth;

    if (accumulatedWidth > availableWidth && firstOverflowIndex === -1) {
      firstOverflowIndex = i;
      break;
    }
  }

  // If somehow everything fits now (edge case), hide overflow
  if (firstOverflowIndex === -1) {
    overflowBtn.classList.remove('visible');
    return;
  }

  // Hide bookmarks that don't fit in the bar
  for (let i = firstOverflowIndex; i < bookmarkButtons.length; i++) {
    bookmarkButtons[i].classList.add('overflow-hidden');
  }

  // Populate overflow menu with bookmarks that don't fit
  for (let i = firstOverflowIndex; i < allBookmarks.length; i++) {
    const item = allBookmarks[i];
    if (!item?.target) continue;
    const menuItem = createBookmarkButton(item, true);
    overflowMenu.appendChild(menuItem);
  }
};

const renderBookmarks = async (items = []) => {
  if (!bookmarksInner) return;
  bookmarksInner.innerHTML = '';
  allBookmarks = items;

  if (!items.length) {
    if (overflowBtn) overflowBtn.classList.remove('visible');
    return;
  }

  for (const item of items) {
    if (!item?.target) continue;
    const button = createBookmarkButton(item, false);
    bookmarksInner.appendChild(button);
  }

  // Update overflow state after rendering
  // Use requestAnimationFrame to ensure DOM has updated
  requestAnimationFrame(() => {
    updateOverflowState();
  });
};

// Persist the bar's order after a drag. The store keeps bookmarks as an
// ordered list, so reordering is a single write of the new target order; the
// renderer paints the new order first (a drag that visibly snaps back while an
// IPC round-trips reads as a failed drag) and re-reads from the store if the
// write is refused.
const persistBookmarkOrder = async (ordered) => {
  try {
    const saved = await electronAPI?.reorderBookmarks?.(ordered.map((item) => item.target));
    if (saved === false) {
      pushDebug('Failed to save the new bookmark order');
      await loadBookmarks();
    }
  } catch (err) {
    console.error('Failed to save bookmark order', err);
    pushDebug(`Failed to save bookmark order: ${err.message}`);
    await loadBookmarks();
  }
};

// Move `fromTarget` next to `toTarget` and save. Insert semantics match the
// tab strip: the dragged item lands before the drop target when the pointer is
// on its left half, after it otherwise.
const moveBookmark = async (fromTarget, toTarget, insertBefore) => {
  if (!fromTarget || !toTarget || fromTarget === toTarget) return;
  const next = allBookmarks.map((item) => ({ ...item }));
  const fromIndex = next.findIndex((item) => item.target === fromTarget);
  if (fromIndex === -1) return;
  const [moved] = next.splice(fromIndex, 1);
  const targetIndex = next.findIndex((item) => item.target === toTarget);
  if (targetIndex === -1) return;
  next.splice(insertBefore ? targetIndex : targetIndex + 1, 0, moved);
  await renderBookmarks(next);
  await persistBookmarkOrder(next);
  pushDebug(`Reordered bookmark ${fromTarget}`);
};

// The tab strip's four drag handlers (tabs.js), applied to a bar entry.
const attachBookmarkDragHandlers = (button, target) => {
  const clearDropIndicators = () => {
    for (const el of bookmarksInner?.querySelectorAll('.bookmark') || []) {
      el.classList.remove('drag-over-left', 'drag-over-right');
    }
  };

  button.addEventListener('dragstart', (event) => {
    isDraggingBookmark = true;
    draggedBookmarkTarget = target;
    button.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', target);
    }
  });

  button.addEventListener('dragend', () => {
    draggedBookmarkTarget = null;
    button.classList.remove('dragging');
    clearDropIndicators();
    // Let the click that ends the drag gesture pass before re-arming
    // navigation, so a reorder never also opens the bookmark.
    setTimeout(() => {
      isDraggingBookmark = false;
    }, 0);
  });

  button.addEventListener('dragover', (event) => {
    if (draggedBookmarkTarget === null || draggedBookmarkTarget === target) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = button.getBoundingClientRect();
    const isLeft = event.clientX < rect.left + rect.width / 2;
    button.classList.toggle('drag-over-left', isLeft);
    button.classList.toggle('drag-over-right', !isLeft);
  });

  button.addEventListener('dragleave', () => {
    button.classList.remove('drag-over-left', 'drag-over-right');
  });

  button.addEventListener('drop', (event) => {
    event.preventDefault();
    const dragged = draggedBookmarkTarget;
    button.classList.remove('drag-over-left', 'drag-over-right');
    if (dragged === null || dragged === target) return;
    const rect = button.getBoundingClientRect();
    const insertBefore = event.clientX < rect.left + rect.width / 2;
    void moveBookmark(dragged, target, insertBefore);
  });
};

export const loadBookmarks = async () => {
  if (!bookmarksBar) return;
  try {
    const bookmarks = await electronAPI.getBookmarks();
    if (Array.isArray(bookmarks)) {
      renderBookmarks(bookmarks);
    } else {
      renderBookmarks();
    }
  } catch (err) {
    console.error('Failed to load bookmarks', err);
    pushDebug(`Failed to load bookmarks: ${err.message}`);
    renderBookmarks();
  }
};

export const updateBookmarkButtonVisibility = async () => {
  const activeTab = getActiveTab();
  if (activeTab?.isLoading) {
    addBookmarkBtn?.classList.add('hidden');
    return;
  }

  const currentDisplay = addressInput.value;
  if (isBookmarkableUrl(currentDisplay)) {
    addBookmarkBtn?.classList.remove('hidden');

    try {
      const bookmarks = await electronAPI.getBookmarks();
      const isBookmarked = bookmarks.some((b) => b.target === currentDisplay);
      if (isBookmarked) {
        addBookmarkBtn.classList.add('bookmarked');
      } else {
        addBookmarkBtn.classList.remove('bookmarked');
      }
    } catch (err) {
      console.error('Failed to check bookmark status', err);
      addBookmarkBtn.classList.remove('bookmarked');
    }
  } else {
    addBookmarkBtn?.classList.add('hidden');
  }
};

export const initBookmarks = () => {
  // Initialize DOM elements
  bookmarksBar = document.querySelector('.bookmarks');
  addBookmarkBtn = document.getElementById('add-bookmark-btn');
  addBookmarkModal = document.getElementById('add-bookmark-modal');
  addBookmarkForm = document.getElementById('add-bookmark-form');
  closeAddBookmarkBtn = document.getElementById('close-add-bookmark');
  bookmarkLabelInput = document.getElementById('bookmark-label');
  bookmarkTargetInput = document.getElementById('bookmark-target');
  bookmarkModalTitle = document.getElementById('bookmark-modal-title');
  bookmarkSubmitBtn = document.getElementById('bookmark-submit-btn');
  addressInput = document.getElementById('address-input');

  // Create inner container for bookmarks
  if (bookmarksBar) {
    bookmarksInner = document.createElement('div');
    bookmarksInner.className = 'bookmarks-inner';
    bookmarksBar.appendChild(bookmarksInner);

    // Create overflow button
    overflowBtn = document.createElement('button');
    overflowBtn.className = 'bookmarks-overflow-btn icon-btn';
    overflowBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m8 6 6 6-6 6"/>
      <path d="m14 6 6 6-6 6"/>
    </svg>`;
    overflowBtn.setAttribute('aria-label', 'More bookmarks');
    bookmarksBar.appendChild(overflowBtn);

    // Create overflow menu (appended to body to avoid overflow:hidden clipping)
    overflowMenu = document.createElement('div');
    overflowMenu.className = 'bookmarks-overflow-menu chrome-popover hidden';
    document.body.appendChild(overflowMenu);

    // Position the overflow menu relative to the button.
    //
    // Only ever called on a *visible* menu: `boundPopoverToViewport` measures
    // the menu's own top edge, and a `display: none` element measures at 0 —
    // which bounded the menu to the whole window height and hung its bottom
    // (and every entry down there) off the screen, where scrolling inside the
    // box cannot reach it (#328).
    const positionOverflowMenu = () => {
      if (!overflowBtn || !overflowMenu || overflowMenu.classList.contains('hidden')) return;
      const btnRect = overflowBtn.getBoundingClientRect();
      overflowMenu.style.top = `${btnRect.bottom + 4}px`;
      overflowMenu.style.right = `${window.innerWidth - btnRect.right}px`;
      boundPopoverToViewport(overflowMenu);
    };

    // Handle overflow button click
    overflowBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenus();
      hideTabContextMenu();
      onContextMenuOpening?.();

      if (overflowMenu.classList.contains('hidden')) {
        showMenuBackdrop();
        overflowMenu.classList.remove('hidden');
        // Shown first, then placed and bounded — see positionOverflowMenu.
        // Opens at the top, like every other chrome popover.
        overflowMenu.scrollTop = 0;
        positionOverflowMenu();
      } else {
        hideOverflowMenu();
      }
    });

    // Handle resize to update overflow state
    const resizeObserver = new ResizeObserver(() => {
      updateOverflowState();
    });
    resizeObserver.observe(bookmarksBar);
  }

  // Hide overflow menu function
  hideOverflowMenu = () => {
    const wasVisible = overflowMenu && !overflowMenu.classList.contains('hidden');
    if (overflowMenu) {
      overflowMenu.classList.add('hidden');
    }
    if (wasVisible) {
      hideMenuBackdrop();
    }
  };

  // Handle activation of a bookmark (both bar and overflow menu). `event` is
  // the click/auxclick that triggered it; its modifiers pick the disposition,
  // exactly as they do on a link in the page (#307).
  const handleBookmarkClick = async (event) => {
    try {
      const eventTarget = event.target;
      if (!(eventTarget instanceof HTMLElement)) return;

      // Find the bookmark button (could be clicked on child elements)
      const bookmarkBtn = eventTarget.closest('.bookmark, .bookmarks-overflow-item');
      const storedTarget = bookmarkBtn?.dataset?.hash;
      if (!storedTarget) return;
      // A drag that ends over the bar also fires a click; that gesture was a
      // reorder, not an activation.
      if (isDraggingBookmark) return;

      // Rewrite legacy ens://name.eth bookmarks to bare-name form so they
      // re-enter the same ENS resolution flow as a typed name and pick up
      // the new transport-aware display (e.g. bzz://name.eth, ipfs://name.eth).
      // Non-ENS bookmark targets pass through unchanged.
      const navigationTarget = normalizeLegacyEnsBookmarkUrl(storedTarget);
      const disposition = bookmarkDisposition(event);

      if (disposition === 'new-window') {
        electronAPI?.openUrlInNewWindow?.(navigationTarget);
        hideOverflowMenu();
        return;
      }

      if (disposition !== 'current-tab') {
        // Background/foreground tab: the page the user is on is untouched, so
        // the address bar must keep showing it rather than the bookmark.
        openInNewTabWithTarget(navigationTarget, null, {
          background: disposition === 'background-tab',
        });
        hideOverflowMenu();
        return;
      }

      if (onLoadTarget) {
        addressInput.value = navigationTarget;
        onLoadTarget(navigationTarget);
        hideOverflowMenu();
      }
    } catch (err) {
      console.error('Bookmark action failed', err);
      pushDebug(`Bookmark action failed: ${err.message}`);
    }
  };

  // Middle-click arrives as `auxclick`, never as `click` — without this the
  // gesture did nothing at all.
  const handleBookmarkAuxClick = (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    void handleBookmarkClick(event);
  };

  bookmarksInner?.addEventListener('click', handleBookmarkClick);
  overflowMenu?.addEventListener('click', handleBookmarkClick);
  bookmarksInner?.addEventListener('auxclick', handleBookmarkAuxClick);
  overflowMenu?.addEventListener('auxclick', handleBookmarkAuxClick);

  // Create context menu
  contextMenu = document.createElement('div');
  contextMenu.className = 'context-menu chrome-popover hidden';
  contextMenu.innerHTML = `
    <button class="context-menu-item" data-action="edit">Edit…</button>
    <button class="context-menu-item" data-action="delete">Delete</button>
  `;
  document.body.appendChild(contextMenu);

  // Hide context menu on click/mousedown elsewhere or Escape
  hideBookmarkContextMenu = () => {
    const wasVisible = !contextMenu.classList.contains('hidden');
    contextMenu.classList.add('hidden');
    contextMenuTarget = null;
    if (wasVisible) {
      hideMenuBackdrop();
    }
  };

  const anyBookmarkMenuOpen = () =>
    Boolean(
      (contextMenu && !contextMenu.classList.contains('hidden')) ||
        (overflowMenu && !overflowMenu.classList.contains('hidden'))
    );

  const hideAllBookmarkMenus = () => {
    hideBookmarkContextMenu();
    hideOverflowMenu();
  };

  document.addEventListener('mousedown', (event) => {
    if (
      !contextMenu.contains(event.target) &&
      !overflowBtn?.contains(event.target) &&
      !overflowMenu?.contains(event.target)
    ) {
      hideAllBookmarkMenus();
    } else if (!contextMenu.contains(event.target)) {
      hideBookmarkContextMenu();
    }
  });
  // A press that actually closes one of these menus is consumed
  // (`preventDefault`), so navigation.js's window-level Escape doesn't also
  // stop an in-flight page load — Chrome closes the innermost surface only.
  // See #306.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!anyBookmarkMenuOpen()) return;
    // A modal <dialog> raised over one of these menus owns the press and
    // cannot mark it — see `isModalDialogOpen`.
    if (isModalDialogOpen()) return;
    event.preventDefault();
    hideAllBookmarkMenus();
  });
  // (The `focus`/`mousedown` dismissal that used to hang off
  // `document.getElementById('bzz-webview')` is gone: webviews are created
  // id-less, so that lookup was always null and the listeners never existed.
  // `#menu-backdrop` covers the window while one of these menus is open, so a click into
  // the page dismisses it through the document listener above. See #306.)
  // Window deactivation only: a `<webview>` guest taking the keyboard raises
  // the same event while the window is still active (#328).
  onWindowDeactivated(hideAllBookmarkMenus);

  // Handle context menu actions
  contextMenu.addEventListener('click', async (event) => {
    const action = event.target.dataset.action;
    if (action === 'edit' && contextMenuTarget) {
      // Open edit modal
      try {
        const bookmarks = await electronAPI.getBookmarks();
        const bookmark = bookmarks.find((b) => b.target === contextMenuTarget);
        if (bookmark && addBookmarkModal) {
          isEditMode = true;
          editOriginalTarget = contextMenuTarget;
          bookmarkLabelInput.value = bookmark.label || '';
          bookmarkTargetInput.value = bookmark.target;
          bookmarkTargetInput.readOnly = false;
          bookmarkModalTitle.textContent = 'Edit Bookmark';
          bookmarkSubmitBtn.textContent = 'Save';
          addBookmarkModal.showModal();
          bookmarkLabelInput.focus();
          bookmarkLabelInput.select();
        }
      } catch (err) {
        console.error('Failed to load bookmark for editing', err);
        pushDebug(`Failed to load bookmark for editing: ${err.message}`);
      }
    } else if (action === 'delete' && contextMenuTarget) {
      await electronAPI.removeBookmark(contextMenuTarget);
      await loadBookmarks();
      updateBookmarkButtonVisibility();
    }
    contextMenu.classList.add('hidden');
    contextMenuTarget = null;
    hideMenuBackdrop();
  });

  // Handle context menu for both bookmarks bar and overflow menu
  const handleBookmarkContextMenu = (event) => {
    event.preventDefault();
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    // Find the bookmark button (could be right-clicked on child elements)
    const bookmarkBtn = target.closest('.bookmark, .bookmarks-overflow-item');
    const hash = bookmarkBtn?.dataset?.hash;
    if (hash) {
      // Close other menus first
      closeMenus();
      hideTabContextMenu();
      onContextMenuOpening?.();
      showMenuBackdrop();

      contextMenuTarget = hash;
      contextMenu.classList.remove('hidden');
      // Clamp / flip / bound, the shared rule for every chrome popover (#324).
      placePopoverAtPoint(contextMenu, event.clientX, event.clientY);
    }
  };

  bookmarksInner?.addEventListener('contextmenu', handleBookmarkContextMenu);
  overflowMenu?.addEventListener('contextmenu', handleBookmarkContextMenu);

  addBookmarkBtn?.addEventListener('click', async () => {
    try {
      const currentDisplay = addressInput.value;
      if (!isBookmarkableUrl(currentDisplay)) {
        alert('Cannot bookmark this page.');
        return;
      }

      const bookmarks = await electronAPI.getBookmarks();
      const existing = bookmarks.find((b) => b.target === currentDisplay);

      if (existing) {
        if (confirm(`Remove bookmark "${existing.label || existing.target}"?`)) {
          await electronAPI.removeBookmark(currentDisplay);
          await loadBookmarks();
          updateBookmarkButtonVisibility();
          pushDebug(`Bookmark removed: ${existing.label}`);
        }
        return;
      }

      if (addBookmarkModal && bookmarkLabelInput && bookmarkTargetInput) {
        const activeTab = getActiveTab();
        const title = activeTab?.title;
        const suggestedTitle = title && title !== 'New Tab' ? title : currentDisplay;
        // Set modal to add mode
        isEditMode = false;
        editOriginalTarget = null;
        bookmarkTargetInput.value = currentDisplay;
        bookmarkTargetInput.readOnly = true;
        bookmarkLabelInput.value = suggestedTitle;
        bookmarkModalTitle.textContent = 'Add Bookmark';
        bookmarkSubmitBtn.textContent = 'Add Bookmark';
        addBookmarkModal.showModal();
        bookmarkLabelInput.focus();
        bookmarkLabelInput.select();
      } else {
        const activeTab = getActiveTab();
        const title = activeTab?.title;
        const suggestedTitle = title && title !== 'New Tab' ? title : currentDisplay;
        const label = prompt('Enter a name for this bookmark:', suggestedTitle);
        if (label) {
          const success = await electronAPI.addBookmark({ label, target: currentDisplay });
          if (success) {
            pushDebug(`Bookmark added: ${label}`);
            loadBookmarks();
          } else {
            pushDebug(`Failed to add bookmark: ${label} (Duplicate or save error)`);
            alert('Failed to add bookmark. It might be a duplicate or storage is inaccessible.');
          }
        }
      }
    } catch (err) {
      console.error('Add bookmark failed', err);
      pushDebug(`Add bookmark failed: ${err.message}`);
    }
  });

  const resetModalState = () => {
    isEditMode = false;
    editOriginalTarget = null;
  };

  closeAddBookmarkBtn?.addEventListener('click', () => {
    addBookmarkModal?.close();
    resetModalState();
  });

  addBookmarkModal?.addEventListener('click', (event) => {
    if (event.target === addBookmarkModal) {
      addBookmarkModal.close();
      resetModalState();
    }
  });

  // Also reset when modal is closed via Escape key
  addBookmarkModal?.addEventListener('close', resetModalState);

  addBookmarkForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const label = bookmarkLabelInput.value.trim();
    const target = bookmarkTargetInput.value.trim();

    if (!label || !target) return;

    try {
      let success;
      if (isEditMode && editOriginalTarget) {
        // Edit existing bookmark
        success = await electronAPI.updateBookmark(editOriginalTarget, { label, target });
        if (success) {
          pushDebug(`Bookmark updated: ${label}`);
        } else {
          pushDebug(`Failed to update bookmark: ${label} (Duplicate target or save error)`);
          alert('Failed to update bookmark. The target URL might conflict with another bookmark.');
          return;
        }
      } else {
        // Add new bookmark
        success = await electronAPI.addBookmark({ label, target });
        if (success) {
          pushDebug(`Bookmark added: ${label}`);
        } else {
          pushDebug(`Failed to add bookmark: ${label} (Duplicate or save error)`);
          alert('Failed to add bookmark. It might be a duplicate or storage is inaccessible.');
          return;
        }
      }

      await loadBookmarks();
      addBookmarkModal?.close();
      updateBookmarkButtonVisibility();

      // Reset edit mode state
      isEditMode = false;
      editOriginalTarget = null;
    } catch (err) {
      console.error('Bookmark submission failed', err);
      pushDebug(`Bookmark submission failed: ${err.message}`);
      alert('An error occurred while saving the bookmark.');
    }
  });

  // Initialize bookmarks bar visibility from settings
  electronAPI?.getSettings?.().then((settings) => {
    bookmarksBarVisible = settings?.showBookmarkBar === true;
    updateBookmarksBarVisibility();
  });

  // Listen for bookmarks bar toggle from menu
  electronAPI?.onToggleBookmarksBar?.((visible) => {
    bookmarksBarVisible = visible;
    updateBookmarksBarVisibility();
  });
};

/**
 * Update bookmarks bar visibility based on current state
 * Shows if: on home page OR user preference is enabled
 */
const updateBookmarksBarVisibility = () => {
  if (bookmarksBar) {
    const shouldShow = isOnHomePage || bookmarksBarVisible;
    bookmarksBar.classList.toggle('hidden', !shouldShow);
  }
};

/**
 * Update bookmarks bar for current page
 * Called by navigation module when page changes
 */
export const updateBookmarksBarForPage = (onHomePage) => {
  isOnHomePage = onHomePage;
  updateBookmarksBarVisibility();
};

/**
 * Set bookmarks bar user preference (for non-home pages)
 */
export const setBookmarksBarVisible = (visible) => {
  bookmarksBarVisible = visible;
  updateBookmarksBarVisibility();
};

/**
 * Get bookmarks bar user preference
 */
export const isBookmarksBarVisible = () => bookmarksBarVisible;
