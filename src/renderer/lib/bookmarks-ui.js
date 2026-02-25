// Bookmarks bar and modal UI
import { pushDebug } from './debug.js';
import { getActiveTab, hideTabContextMenu } from './tabs.js';
import { closeMenus } from './menus.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';

const electronAPI = window.electronAPI;

// Check if a URL is bookmarkable
const isBookmarkableUrl = (url) => {
  if (!url) return false;
  return (
    url.startsWith('bzz://') ||
    url.startsWith('ipfs://') ||
    url.startsWith('ipns://') ||
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

// Create a bookmark button element
const createBookmarkButton = (item, isOverflowItem = false) => {
  const button = document.createElement('button');
  button.className = isOverflowItem ? 'bookmarks-overflow-item' : 'bookmark';
  button.dataset.hash = item.target;

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
    overflowMenu.className = 'bookmarks-overflow-menu hidden';
    document.body.appendChild(overflowMenu);

    // Position the overflow menu relative to the button
    const positionOverflowMenu = () => {
      if (!overflowBtn || !overflowMenu) return;
      const btnRect = overflowBtn.getBoundingClientRect();
      overflowMenu.style.top = `${btnRect.bottom + 4}px`;
      overflowMenu.style.right = `${window.innerWidth - btnRect.right}px`;
    };

    // Handle overflow button click
    overflowBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenus();
      hideTabContextMenu();
      onContextMenuOpening?.();

      if (overflowMenu.classList.contains('hidden')) {
        positionOverflowMenu();
        showMenuBackdrop();
        overflowMenu.classList.remove('hidden');
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

  // Handle click on bookmarks (both bar and overflow menu)
  const handleBookmarkClick = async (event) => {
    try {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      // Find the bookmark button (could be clicked on child elements)
      const bookmarkBtn = target.closest('.bookmark, .bookmarks-overflow-item');
      const hash = bookmarkBtn?.dataset?.hash;
      if (hash && onLoadTarget) {
        addressInput.value = hash;
        onLoadTarget(hash);
        hideOverflowMenu();
      }
    } catch (err) {
      console.error('Bookmark action failed', err);
      pushDebug(`Bookmark action failed: ${err.message}`);
    }
  };

  bookmarksInner?.addEventListener('click', handleBookmarkClick);
  overflowMenu?.addEventListener('click', handleBookmarkClick);

  // Create context menu
  contextMenu = document.createElement('div');
  contextMenu.className = 'context-menu hidden';
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
  // Close when webview gets focus or is clicked
  const webviewElement = document.getElementById('bzz-webview');
  webviewElement?.addEventListener('focus', hideAllBookmarkMenus);
  webviewElement?.addEventListener('mousedown', hideAllBookmarkMenus);
  window.addEventListener('blur', hideAllBookmarkMenus);

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
      contextMenu.style.left = `${event.clientX}px`;
      contextMenu.style.top = `${event.clientY}px`;
      contextMenu.classList.remove('hidden');

      // Adjust if menu goes off screen
      const rect = contextMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        contextMenu.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
      if (rect.bottom > window.innerHeight) {
        contextMenu.style.top = `${window.innerHeight - rect.height - 8}px`;
      }
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
};
