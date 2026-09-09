// Menu dropdown handling
import { state } from './state.js';
import { startAntInfoPolling, stopAntInfoPolling } from './ant-ui.js';
import { startIpfsInfoPolling, stopIpfsInfoPolling } from './ipfs-ui.js';
import { startMyotisInfoPolling, stopMyotisInfoPolling } from './myotis-ui.js';
import { startRadicleInfoUpdates, stopRadicleInfoUpdates } from './radicle-ui.js';
import { hideTabContextMenu, getActiveWebview } from './tabs.js';
import { hideBookmarkContextMenu, hideOverflowMenu } from './bookmarks-ui.js';
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';
import { isModalDialogOpen } from './modal-dialog.js';
import { formatAccelerator, matchesShortcut } from './shortcuts.js';
import { SUBMENU_CLOSE_DELAY_MS } from './submenu-hover.js';
import { boundPopoverToViewport, POPOVER_VIEWPORT_MARGIN } from './popover-bounds.js';

const electronAPI = window.electronAPI;

// DOM elements (initialized in initMenus)
let menuButton = null;
let menuDropdown = null;
let historyBtn = null;
let newTabMenuBtn = null;
let newWindowMenuBtn = null;
let newPrivateWindowMenuBtn = null;
let zoomOutBtn = null;
let zoomInBtn = null;
let zoomLevelDisplay = null;
let fullscreenBtn = null;
let printBtn = null;
let devtoolsBtn = null;
let aboutBtn = null;
let checkUpdatesBtn = null;

// Callback for opening history (set by external module)
let onOpenHistory = null;
export const setOnOpenHistory = (callback) => {
  onOpenHistory = callback;
};

// Callback for creating a new tab (set by external module)
let onNewTab = null;
export const setOnNewTab = (callback) => {
  onNewTab = callback;
};

// Callback for when any menu opens (to close other dropdowns like autocomplete)
let onMenuOpening = null;
export const setOnMenuOpening = (callback) => {
  onMenuOpening = callback;
};
let beeMenuButton = null;
let beeMenuDropdown = null;
let profileMenuWrap = null;

// --- Profiles flyout dismissal ---------------------------------------------
//
// Chrome's submenu model: only one submenu of a menu is open at a time, and it
// closes as soon as another row of that menu is hovered — with a short intent
// delay so a diagonal move from the parent row into the submenu isn't cut off
// (the Profiles flyout is anchored to the LEFT of the hamburger, so travelling
// into it from the Profiles row crosses the rows below it first).
//
// Opening the flyout lives with the flyout's own code (initProfileIndicator in
// index.js); hiding it is owned here, the same reason setMenuOpen(false)
// already collapsed it: the flyout is a child of #menu-dropdown and the
// hamburger's lifecycle governs it. #301.
let profileFlyoutCloseTimer = null;

const cancelProfileFlyoutClose = () => {
  if (profileFlyoutCloseTimer) {
    clearTimeout(profileFlyoutCloseTimer);
    profileFlyoutCloseTimer = null;
  }
};

// The one place the flyout is hidden (index.js routes its own close through
// here too), so the `hidden` attribute, the trigger's aria-expanded and the
// row's open highlight can never drift apart.
export const hideProfileFlyout = () => {
  cancelProfileFlyoutClose();
  const profileFlyout = document.getElementById('profile-menu');
  if (profileFlyout) profileFlyout.hidden = true;
  document.getElementById('profile-menu-wrap')?.classList.remove('flyout-open');
  document.getElementById('profile-menu-btn')?.setAttribute('aria-expanded', 'false');
};

const isProfileFlyoutOpen = () => document.getElementById('profile-menu')?.hidden === false;

// Anchor the open flyout to the Profiles row and bound it to the viewport.
//
// The flyout is a `position: fixed` child of #menu-dropdown (see
// styles/popovers.css): the hamburger is a scroll container now, and an
// absolutely positioned child would be clipped by it. Fixed positioning escapes
// that clip but not the anchoring, so the coordinates the CSS used to express
// as `top: -4px; right: 100%` are computed here instead — at open time, on
// every resize, and while the hamburger scrolls under it. #324.
export const anchorProfileFlyout = () => {
  const flyout = document.getElementById('profile-menu');
  const wrap = profileMenuWrap || document.getElementById('profile-menu-wrap');
  if (!flyout || !wrap || flyout.hidden) return;
  const row = wrap.getBoundingClientRect();
  flyout.style.right = `${Math.max(POPOVER_VIEWPORT_MARGIN, window.innerWidth - row.left)}px`;
  flyout.style.top = `${Math.max(POPOVER_VIEWPORT_MARGIN, row.top - 4)}px`;
  boundPopoverToViewport(flyout);
};

// A pointer or focus landing anywhere in the hamburger that is not the
// Profiles row or its flyout dismisses the flyout. Pointer moves get the
// intent delay (SUBMENU_CLOSE_DELAY_MS — the same grace period
// attachSubmenuHover uses for the reverse direction); keyboard focus does not,
// since a Tab/arrow move is deliberate and leaving the flyout up would cover
// the row that just took focus.
const handleProfileFlyoutSibling = (target, { delay }) => {
  if (!isProfileFlyoutOpen()) return;
  // Inside the Profiles row or the flyout itself: not a sibling — this is the
  // diagonal move the delay exists for, so abort a pending close.
  if (profileMenuWrap?.contains(target)) {
    cancelProfileFlyoutClose();
    return;
  }
  if (!delay) {
    hideProfileFlyout();
    return;
  }
  // Keep the first schedule: the delay counts from entering the sibling row,
  // not from the last mousemove within it.
  if (profileFlyoutCloseTimer) return;
  profileFlyoutCloseTimer = setTimeout(() => {
    profileFlyoutCloseTimer = null;
    hideProfileFlyout();
  }, SUBMENU_CLOSE_DELAY_MS);
};

export const setMenuOpen = (open) => {
  state.menuOpen = open;
  if (menuDropdown) {
    menuDropdown.classList.toggle('open', open);
  }
  if (menuButton) {
    menuButton.setAttribute('aria-expanded', String(open));
  }
  if (open) {
    setAntMenuOpen(false);
    hideTabContextMenu();
    hideBookmarkContextMenu();
    hideOverflowMenu();
    onMenuOpening?.();
    showMenuBackdrop();
    // Chrome's model: the menu never grows past the window — it scrolls inside
    // itself and the chrome stays put (#324).
    if (menuDropdown) menuDropdown.scrollTop = 0;
    boundPopoverToViewport(menuDropdown);
  } else {
    // Collapse the Profiles flyout when the hamburger closes (the flyout is a
    // child of #menu-dropdown, so its lifecycle is governed by the hamburger).
    hideProfileFlyout();
    if (!state.antMenuOpen) {
      hideMenuBackdrop();
    }
  }
};

export const setAntMenuOpen = (open) => {
  state.antMenuOpen = open;
  beeMenuDropdown?.classList.toggle('open', open);
  beeMenuButton?.setAttribute('aria-expanded', String(open));
  if (open) {
    setMenuOpen(false);
    hideTabContextMenu();
    hideBookmarkContextMenu();
    hideOverflowMenu();
    onMenuOpening?.();
    showMenuBackdrop();
    // With every node enabled this menu is ~650 px tall: taller than the
    // window on a 1200x600 display, where it used to scroll the whole browser
    // chrome and push its last section (Tor) off screen (#324).
    if (beeMenuDropdown) beeMenuDropdown.scrollTop = 0;
    boundPopoverToViewport(beeMenuDropdown);
    startAntInfoPolling();
    startIpfsInfoPolling();
    startMyotisInfoPolling();
    startRadicleInfoUpdates();
  } else {
    if (!state.menuOpen) {
      hideMenuBackdrop();
    }
    // Each node's stop* owns resetting that node's readouts (peer counts,
    // Version row, info panel). Menus used to reset Ant's here as well, with
    // its own copy of the empty-state rules — the copy drifted and re-blanked
    // the Version row #253 had just moved to 'Unknown'.
    stopAntInfoPolling();
    stopIpfsInfoPolling();
    stopMyotisInfoPolling();
    stopRadicleInfoUpdates();
  }
};

export const closeMenus = () => {
  setMenuOpen(false);
  setAntMenuOpen(false);
};

// Update zoom level display for the active webview
export const updateZoomDisplay = () => {
  const webview = getActiveWebview();
  if (webview && zoomLevelDisplay) {
    try {
      const zoomFactor = webview.getZoomFactor();
      zoomLevelDisplay.textContent = `${Math.round(zoomFactor * 100)}%`;
    } catch {
      zoomLevelDisplay.textContent = '100%';
    }
  }
};

// Zoom bounds and step, matching the hamburger menu's − / + buttons.
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

// Single zoom code path shared by the hamburger buttons, the View-menu
// accelerators and the renderer keydown fallback, so the zoom-level readout
// never drifts from the webview's real factor. getZoomFactor throws on a
// webview that is not yet dom-ready — reachable now that a keystroke can
// zoom a tab the moment it opens — so the read is guarded the same way
// updateZoomDisplay guards it.
const applyZoomFactor = (next) => {
  const webview = getActiveWebview();
  if (!webview) return;
  try {
    webview.setZoomFactor(next(webview.getZoomFactor()));
  } catch {
    return;
  }
  updateZoomDisplay();
};

export const zoomIn = () => applyZoomFactor((current) => Math.min(ZOOM_MAX, current + ZOOM_STEP));
export const zoomOut = () => applyZoomFactor((current) => Math.max(ZOOM_MIN, current - ZOOM_STEP));
export const zoomReset = () => applyZoomFactor(() => 1);

// Initialize keyboard shortcuts based on platform.
//
// A hint here must name a binding the app actually implements — an item
// with no shortcut (Print) carries no hint at all. Where the two platforms
// differ (History is Cmd+Y on macOS, Ctrl+H elsewhere, per
// src/shared/shortcuts.js), `data-shortcut-other` carries the non-mac form.
//
// The zoom row is the one bound item deliberately left hintless: it is a
// − / readout / + stepper, not a labelled menu item, so it has no
// `.menu-item-shortcut` slot to fill and three bindings to name rather than
// one. Its accelerators are surfaced in the View menu and remain remappable
// under Settings > Shortcuts.
//
// The hints render through `formatAccelerator` — the same formatter
// Settings > Shortcuts uses — so one binding never reads two ways:
// 'Ctrl+Shift+N' on Linux/Windows, '⇧⌘N' on macOS, in both surfaces.
const initKeyboardShortcuts = async () => {
  const platform = await electronAPI?.getPlatform?.();
  const isMac = platform === 'darwin';

  document.querySelectorAll('.menu-item-shortcut[data-shortcut]').forEach((el) => {
    const shortcut = (!isMac && el.dataset.shortcutOther) || el.dataset.shortcut;
    el.textContent = formatAccelerator(shortcut, platform);
  });
};

export const initMenus = () => {
  // Initialize platform-specific keyboard shortcuts
  initKeyboardShortcuts();

  // Initialize DOM elements
  menuButton = document.getElementById('menu-button');
  menuDropdown = document.getElementById('menu-dropdown');
  historyBtn = document.getElementById('history-btn');
  newTabMenuBtn = document.getElementById('new-tab-menu-btn');
  newWindowMenuBtn = document.getElementById('new-window-menu-btn');
  newPrivateWindowMenuBtn = document.getElementById('new-private-window-menu-btn');
  zoomOutBtn = document.getElementById('zoom-out-btn');
  zoomInBtn = document.getElementById('zoom-in-btn');
  zoomLevelDisplay = document.getElementById('zoom-level');
  fullscreenBtn = document.getElementById('fullscreen-btn');
  printBtn = document.getElementById('print-btn');
  devtoolsBtn = document.getElementById('devtools-btn');
  aboutBtn = document.getElementById('about-btn');
  checkUpdatesBtn = document.getElementById('check-updates-btn');
  beeMenuButton = document.getElementById('bee-menu-button');
  beeMenuDropdown = document.getElementById('bee-menu-dropdown');
  profileMenuWrap = document.getElementById('profile-menu-wrap');

  // One submenu at a time: hovering or focusing any other hamburger row closes
  // the Profiles flyout (#301). `mouseover`/`focusin` rather than
  // `mouseenter`/`focus` because only the bubbling pair can be handled by a
  // single listener on the dropdown, which also covers rows rendered later.
  menuDropdown?.addEventListener('mouseover', (event) => {
    handleProfileFlyoutSibling(event.target, { delay: true });
  });
  menuDropdown?.addEventListener('focusin', (event) => {
    handleProfileFlyoutSibling(event.target, { delay: false });
  });

  // The flyout is anchored in viewport coordinates (see anchorProfileFlyout),
  // so it has to follow the Profiles row when the hamburger scrolls under it
  // or the window changes size.
  menuDropdown?.addEventListener('scroll', anchorProfileFlyout);
  window.addEventListener('resize', anchorProfileFlyout);

  menuButton?.addEventListener('click', () => {
    setMenuOpen(!state.menuOpen);
    if (state.menuOpen) {
      updateZoomDisplay();
    }
  });

  // New Tab button
  newTabMenuBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    onNewTab?.();
  });

  // New Window button
  newWindowMenuBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.newWindow?.();
  });

  // New Private Window button. Without it the feature is keyboard-only on
  // the Linux frameless / auto-hidden-menu-bar setups the renderer keydown
  // fallback exists for — i.e. undiscoverable in the UI.
  newPrivateWindowMenuBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.newPrivateWindow?.();
  });

  // History button
  historyBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    onOpenHistory?.();
  });

  // Zoom controls
  zoomOutBtn?.addEventListener('click', () => {
    zoomOut();
  });

  zoomInBtn?.addEventListener('click', () => {
    zoomIn();
  });

  // View-menu zoom accelerators arrive here so all entry points share one
  // code path (issue #88 — the shortcuts README documents were never wired).
  electronAPI?.onZoomIn?.(() => {
    zoomIn();
  });

  electronAPI?.onZoomOut?.(() => {
    zoomOut();
  });

  electronAPI?.onZoomReset?.(() => {
    zoomReset();
  });

  // Keyboard handling for the menus. Escape shares this listener with the zoom
  // fallback below rather than adding a second one (#306).
  //
  // Escape dismisses the innermost open surface first, exactly like Chrome's
  // menus: the Profiles flyout, then the hamburger it hangs off, then the Nodes
  // menu — and hands the keyboard back to the control that opened it, so the
  // next Tab continues from the toolbar rather than from the top of the
  // document. Every other dismissible surface in the chrome already closed on
  // Escape (tab and page context menus, bookmark menu, trust popover,
  // permission prompt, find bar); these two were the exception, and left the
  // full-window `#menu-backdrop` swallowing clicks with no keyboard way out.
  //
  // Closing a surface *consumes* the press: `preventDefault()` marks it, and
  // navigation.js's window-level Escape stands down on `defaultPrevented`.
  // Chrome only ever closes the innermost surface, so dismissing a menu over a
  // still-loading page must not also stop that load, repaint the address bar
  // and blur the focus we just handed back. `stopPropagation()` cannot do this
  // job: both listeners sit on `window`, and same-node listeners still run.
  //
  // Keyboard fallback for the zoom accelerators, resolved through the shared
  // shortcut registry so user remaps apply live. Needed on the Linux
  // frameless setups where menu accelerators never reach the app — the same
  // reason tabs.js and navigation.js carry keydown fallbacks.
  //
  // The order of this chain is load-bearing, and it must stay one if/else-if
  // chain rather than independent ifs: on the Nordic layouts (Swedish,
  // Norwegian, Danish, Finnish) `+` is the unshifted key at the US `Minus`
  // position, so Ctrl+`+` arrives as { key: '+', code: 'Minus' } and matches
  // *both* page.zoomIn (via the `CmdOrCtrl+Plus` alias) and page.zoomOut (via
  // the `-` its physical code implies). Zoom In is tested first so those
  // users zoom in, which is what they pressed. menus.test.js pins it.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // A modal <dialog> raised over these menus (the profile-create prompt
      // the flyout itself opens, the external-node prompt main can send at
      // any moment) is above them in the top layer and cannot mark the press
      // — see `isModalDialogOpen`. Its close comes first; the next press
      // reaches the menu behind it.
      if (isModalDialogOpen()) return;
      if (isProfileFlyoutOpen()) {
        event.preventDefault();
        hideProfileFlyout();
        document.getElementById('profile-menu-btn')?.focus?.();
      } else if (state.menuOpen) {
        event.preventDefault();
        setMenuOpen(false);
        menuButton?.focus?.();
      } else if (state.antMenuOpen) {
        event.preventDefault();
        setAntMenuOpen(false);
        beeMenuButton?.focus?.();
      }
      return;
    }
    if (matchesShortcut(event, 'page.zoomIn')) {
      event.preventDefault();
      zoomIn();
    } else if (matchesShortcut(event, 'page.zoomOut')) {
      event.preventDefault();
      zoomOut();
    } else if (matchesShortcut(event, 'page.zoomReset')) {
      event.preventDefault();
      zoomReset();
    }
  });

  // Fullscreen button
  fullscreenBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.toggleFullscreen?.();
  });

  // Print
  printBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    const webview = getActiveWebview();
    if (webview) {
      webview.print();
    }
  });

  // Developer Tools
  devtoolsBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    const webview = getActiveWebview();
    if (webview) {
      if (webview.isDevToolsOpened()) {
        webview.closeDevTools();
      } else {
        webview.openDevTools();
      }
    }
  });

  // About
  aboutBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.showAbout?.();
  });

  // Check for Updates
  checkUpdatesBtn?.addEventListener('click', () => {
    setMenuOpen(false);
    electronAPI?.checkForUpdates?.();
  });

  beeMenuButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    setAntMenuOpen(!state.antMenuOpen);
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (state.menuOpen && !menuButton?.contains(target) && !menuDropdown?.contains(target)) {
      setMenuOpen(false);
    }
    if (
      state.antMenuOpen &&
      !beeMenuButton?.contains(target) &&
      !beeMenuDropdown?.contains(target)
    ) {
      setAntMenuOpen(false);
    }
  });

  // (The `focus`/`mousedown` dismissal that used to hang off
  // `document.getElementById('bzz-webview')` is gone: webviews are created
  // id-less, so that lookup was always null and the listeners never existed.
  // `#menu-backdrop` covers the window while a menu is open, so a click into
  // the page dismisses it through the document listener above. See #306.)

  // Close menus when window loses focus (switching windows or backgrounding app)
  window.addEventListener('blur', closeMenus);
};
