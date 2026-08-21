// Renderer process entry point
import {
  updateRegistry,
  applySettingsToState,
} from './lib/state.js';
import { initAntUi, updateAntStatusLine, updateAntToggleState } from './lib/ant-ui.js';
import { initIpfsUi, updateIpfsStatusLine, updateIpfsToggleState } from './lib/ipfs-ui.js';
import { initMyotisUi } from './lib/myotis-ui.js';
import {
  initRadicleUi,
  updateRadicleStatusLine,
  updateRadicleToggleState,
} from './lib/radicle-ui.js';
import { initTorUi, updateTorStatusLine } from './lib/tor-ui.js';
import {
  initMenus,
  setOnOpenHistory,
  setOnNewTab,
  setOnMenuOpening,
  closeMenus,
} from './lib/menus.js';
import { initSettingsEffects, initTheme } from './lib/settings-ui.js';
import {
  initBookmarks,
  loadBookmarks,
  setOnLoadTarget,
  hideBookmarkContextMenu,
  setOnBookmarkContextMenuOpening,
} from './lib/bookmarks-ui.js';
import {
  initTabs,
  setLoadTargetHandler,
  setReloadHandler,
  setHardReloadHandler,
  hideTabContextMenu,
  setOnContextMenuOpening as setOnTabContextMenuOpening,
  createTab,
  openOrFocusInternalPage,
  getActiveWebview,
} from './lib/tabs.js';
import {
  initNavigation,
  loadTarget,
  reloadPage,
  hardReloadPage,
  onSettingsChanged,
  setOnHistoryRecorded,
  closeTrustPopover,
} from './lib/navigation.js';
import {
  initAutocomplete,
  setOnNavigate,
  refreshCache as refreshAutocompleteCache,
  hide as hideAutocomplete,
} from './lib/autocomplete.js';
import { initGithubBridgeUi, setOnOpenRadicleUrl } from './lib/github-bridge-ui.js';
import { initDownloadsUi } from './lib/downloads-ui.js';
import { initMenuBackdrop } from './lib/menu-backdrop.js';
import { initLinkStatus } from './lib/link-status.js';
import { initSitePermissionsUi } from './lib/site-permissions-ui.js';
import { initFindBar } from './lib/find-bar.js';
import { initPageContextMenu, hidePageContextMenu } from './lib/page-context-menu.js';
import {
  initChromeInputContextMenu,
  hideChromeInputContextMenu,
} from './lib/chrome-input-context-menu.js';
import { pushDebug } from './lib/debug.js';
import { initOnboarding } from './lib/onboarding.js';
import { initSidebar } from './lib/sidebar.js';
import { initRadicleConsent } from './lib/radicle-consent.js';
import { initRadicleAlias } from './lib/radicle-alias.js';
import { initWalletUi, openPublishSetupFlow } from './lib/wallet-ui.js';
import { attachSubmenuHover } from './lib/submenu-hover.js';
import { isPrivateWindow } from './lib/private-mode.js';
import { bindHoverTooltip } from './lib/hover-tooltip.js';
import { initShortcuts } from './lib/shortcuts.js';

const electronAPI = window.electronAPI;

// Apply theme early to avoid flash
initTheme();

// Private windows get their distinct dark chrome + "Private" badge before
// first paint. The flag comes from the privatePartition query parameter
// (src/renderer/lib/private-mode.js).
if (isPrivateWindow()) {
  document.body.classList.add('private-window');
  const privateBadge = document.getElementById('private-badge');
  if (privateBadge) privateBadge.hidden = false;
}

let closeProfileMenu = () => {};
let externalNodeCandidatesHandler = null;
const queuedExternalNodeCandidatePayloads = [];

electronAPI.onExternalNodeCandidates?.((payload) => {
  if (externalNodeCandidatesHandler) {
    externalNodeCandidatesHandler(payload);
  } else {
    queuedExternalNodeCandidatePayloads.push(payload);
  }
});

// Listen for service registry updates from main process
window.serviceRegistry?.onUpdate?.((registry) => {
  pushDebug(`[ServiceRegistry] Update received: ${JSON.stringify(registry)}`);
  updateRegistry(registry);
  updateAntStatusLine();
  updateAntToggleState();
  updateIpfsStatusLine();
  updateIpfsToggleState();
  updateRadicleStatusLine();
  updateRadicleToggleState();
  updateTorStatusLine();
});

// Fetch initial registry state
window.serviceRegistry?.getRegistry?.().then((registry) => {
  if (registry) {
    pushDebug(`[ServiceRegistry] Initial state: ${JSON.stringify(registry)}`);
    updateRegistry(registry);
  }
});

// Wire up cross-module callbacks
initSettingsEffects(onSettingsChanged);
setOnLoadTarget(loadTarget);
setLoadTargetHandler(loadTarget);
setReloadHandler(reloadPage);
setHardReloadHandler(hardReloadPage);
setOnNavigate(loadTarget);
setOnHistoryRecorded(refreshAutocompleteCache);
setOnOpenHistory(() => loadTarget('freedom://history'));
setOnNewTab(() => createTab());
setOnOpenRadicleUrl((url) => loadTarget(url));
// When any popover/menu opens, dismiss other transient surfaces so we
// don't end up with the autocomplete dropdown or the ENS trust popover
// stacked on top of the nodes/main menu.
const onAnyMenuOpening = () => {
  hideAutocomplete();
  closeTrustPopover();
};
setOnMenuOpening(onAnyMenuOpening);
setOnTabContextMenuOpening(onAnyMenuOpening);
setOnBookmarkContextMenuOpening(onAnyMenuOpening);

// Initialize platform-specific UI adjustments
async function initPlatformUI() {
  const platform = await electronAPI.getPlatform();

  if (platform === 'linux') {
    // platform-linux governs the titlebar spacer width (shrinks the 76px macOS
    // traffic-light gap to 12px), so it applies to Linux regardless of framing.
    document.body.classList.add('platform-linux');

    // The window is only frameless when the user opts in to tabs-in-titlebar;
    // with the OS frame the system provides the controls, so skip the custom ones.
    const settings = await electronAPI.getSettings().catch(() => ({}));
    if (settings.tabsInTitlebar !== true) return;

    // Frameless on Linux: show + wire the in-app window controls
    document.getElementById('window-controls')?.classList.add('visible');

    // Respect the desktop's button layout (GNOME defaults to close-only). Drop
    // buttons the layout omits. Use .remove() — .window-control-btn's display:flex
    // overrides the [hidden] attribute. null layout (non-GNOME) keeps all three.
    const layout = await electronAPI.getWindowButtonLayout().catch(() => null);
    if (layout) {
      if (!layout.minimize) document.getElementById('minimize-btn')?.remove();
      if (!layout.maximize) document.getElementById('maximize-btn')?.remove();
    }

    document
      .getElementById('minimize-btn')
      ?.addEventListener('click', () => electronAPI.minimizeWindow());
    document
      .getElementById('maximize-btn')
      ?.addEventListener('click', () => electronAPI.maximizeWindow());
    document
      .getElementById('close-btn')
      ?.addEventListener('click', () => electronAPI.closeWindow());

    // Double-click the bare titlebar to toggle maximize (native behavior)
    document.querySelector('.title-bar')?.addEventListener('dblclick', (e) => {
      if (e.target.closest('.no-drag, button, .tab')) return; // ponytail: only bare titlebar
      electronAPI.maximizeWindow();
    });
  }
}

function initExternalNodeCandidatesModal() {
  const modal = document.getElementById('external-node-candidates-modal');
  const list = document.getElementById('external-node-candidates-list');
  const submitBtn = document.getElementById('external-node-candidates-submit');
  const managedBtn = document.getElementById('external-node-candidates-managed');
  const closeBtn = document.getElementById('external-node-candidates-close');
  if (!modal || !list) return;

  let currentRequestId = null;
  let currentCandidates = [];
  let hasResponded = false;
  let promptActive = false;
  const pendingRequests = [];

  const closeModal = () => {
    if (modal.open && typeof modal.close === 'function') {
      modal.close();
    } else {
      modal.removeAttribute('open');
    }
  };

  const choicesForAll = (choice) =>
    Object.fromEntries(currentCandidates.map((candidate) => [candidate.protocol, choice]));

  const showNextPrompt = () => {
    if (promptActive || !pendingRequests.length) return;
    openPrompt(pendingRequests.shift());
  };

  const resetPrompt = () => {
    currentRequestId = null;
    currentCandidates = [];
    hasResponded = false;
    promptActive = false;
    setTimeout(showNextPrompt, 0);
  };

  const sendDecision = (choices) => {
    if (!currentRequestId || hasResponded) return;
    hasResponded = true;
    electronAPI.resolveExternalNodeCandidates?.({
      requestId: currentRequestId,
      choices,
    });
    closeModal();
    resetPrompt();
  };

  const keepManagedForAll = () => {
    sendDecision(choicesForAll('managed'));
  };

  const renderCandidates = (candidates) => {
    list.textContent = '';
    for (const candidate of candidates) {
      const row = document.createElement('div');
      row.className = 'external-node-row';
      row.dataset.protocol = candidate.protocol;

      const details = document.createElement('div');
      details.className = 'external-node-details';

      const name = document.createElement('p');
      name.className = 'external-node-name';
      name.textContent = candidate.label || candidate.protocol;

      const endpoints = document.createElement('div');
      endpoints.className = 'external-node-endpoints';
      for (const endpoint of candidate.endpoints || []) {
        const code = document.createElement('code');
        code.textContent = endpoint;
        endpoints.append(code);
      }

      const choice = document.createElement('div');
      choice.className = 'external-node-choice';
      choice.setAttribute('role', 'radiogroup');
      choice.setAttribute('aria-label', `${name.textContent} node choice`);

      const radioName = `external-node-${candidate.protocol}`;
      for (const option of [
        { value: 'managed', label: 'Keep Managed' },
        { value: 'external', label: 'Use External' },
      ]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = radioName;
        input.value = option.value;
        input.checked = option.value === 'managed';
        const text = document.createElement('span');
        text.textContent = option.label;
        label.append(input, text);
        choice.append(label);
      }

      details.append(name, endpoints);
      row.append(details, choice);
      list.append(row);
    }
  };

  const submitChoices = () => {
    const choices = {};
    for (const candidate of currentCandidates) {
      const checked = list.querySelector(
        `.external-node-row[data-protocol="${candidate.protocol}"] input:checked`
      );
      choices[candidate.protocol] = checked?.value === 'external' ? 'external' : 'managed';
    }
    sendDecision(choices);
  };

  function openPrompt(payload = {}) {
    promptActive = true;
    currentRequestId = payload.requestId || null;
    currentCandidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    hasResponded = false;
    if (!currentRequestId) {
      resetPrompt();
      return;
    }
    if (!currentCandidates.length) {
      sendDecision({});
      return;
    }
    renderCandidates(currentCandidates);
    if (!modal.open && typeof modal.showModal === 'function') {
      modal.showModal();
    } else {
      modal.setAttribute('open', '');
    }
  }

  const handleExternalNodeCandidates = (payload = {}) => {
    pendingRequests.push(payload);
    showNextPrompt();
  };

  externalNodeCandidatesHandler = handleExternalNodeCandidates;
  while (queuedExternalNodeCandidatePayloads.length) {
    handleExternalNodeCandidates(queuedExternalNodeCandidatePayloads.shift());
  }

  submitBtn?.addEventListener('click', submitChoices);
  managedBtn?.addEventListener('click', keepManagedForAll);
  closeBtn?.addEventListener('click', keepManagedForAll);
  modal.addEventListener('cancel', (event) => {
    event.preventDefault();
    keepManagedForAll();
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) keepManagedForAll();
  });
}

async function initProfileIndicator() {
  const indicator = document.getElementById('profile-menu-btn');
  const nameEl = document.getElementById('profile-current-name');
  const menuWrap = document.getElementById('profile-menu-wrap');
  const menu = document.getElementById('profile-menu');
  const profileList = document.getElementById('profile-menu-list');
  const createBtn = document.getElementById('profile-create-btn');
  const manageBtn = document.getElementById('profile-manage-btn');
  const menuStatus = document.getElementById('profile-menu-status');
  const createModal = document.getElementById('profile-create-modal');
  const createForm = document.getElementById('profile-create-form');
  const createNameInput = document.getElementById('profile-create-name');
  const createSubmitBtn = document.getElementById('profile-create-submit');
  const createCancelBtn = document.getElementById('profile-create-cancel');
  const createCloseBtn = document.getElementById('profile-create-close');
  const createStatus = document.getElementById('profile-create-status');
  if (!indicator || !nameEl) return;

  let activeProfile = null;
  let creatingProfile = false;

  const setMenuOpen = (open) => {
    if (!menu) return;
    menu.hidden = !open;
    indicator.setAttribute('aria-expanded', String(open));
  };

  const setMenuStatus = (message, kind = '') => {
    if (!menuStatus) return;
    menuStatus.textContent = message || '';
    menuStatus.className = 'menu-flyout-status' + (kind ? ` ${kind}` : '');
    menuStatus.hidden = !message;
  };

  const openProfilesManager = () => {
    closeAllMenus();
    // Open the manager in its own tab, or focus the tab that already has it.
    openOrFocusInternalPage('profiles');
  };

  const setCreateStatus = (message, kind = '') => {
    if (!createStatus) return;
    createStatus.textContent = message || '';
    createStatus.className = 'modal-status' + (kind ? ` ${kind}` : '');
    createStatus.hidden = !message;
  };

  const setCreateBusy = (busy) => {
    creatingProfile = busy;
    if (createSubmitBtn) createSubmitBtn.disabled = busy;
    if (createCancelBtn) createCancelBtn.disabled = busy;
    if (createCloseBtn) createCloseBtn.disabled = busy;
    if (createNameInput) createNameInput.disabled = busy;
  };

  const closeCreateModal = () => {
    if (creatingProfile || !createModal) return;
    if (createModal.open && typeof createModal.close === 'function') {
      createModal.close();
    } else {
      createModal.removeAttribute('open');
    }
  };

  const openCreateModal = () => {
    closeAllMenus();
    setCreateBusy(false);
    setCreateStatus('', '');
    if (createNameInput) createNameInput.value = '';
    if (createModal && !createModal.open && typeof createModal.showModal === 'function') {
      createModal.showModal();
    } else if (createModal) {
      createModal.setAttribute('open', '');
    }
    requestAnimationFrame(() => {
      createNameInput?.focus();
    });
  };

  const renderProfileList = (profiles = []) => {
    if (!profileList) return;
    profileList.textContent = '';

    const registeredProfiles = profiles.filter((profile) => profile?.isUnregistered !== true);
    const rows = registeredProfiles.length
      ? registeredProfiles
      : activeProfile
        ? [activeProfile]
        : [];

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'menu-flyout-empty';
      empty.textContent = 'No profiles available';
      profileList.append(empty);
      return;
    }

    for (const profile of rows) {
      const isCurrent = profile?.isActive === true || profile?.id === activeProfile?.id;
      const displayName = profile?.displayName || profile?.id || 'Unnamed profile';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.setAttribute('role', 'menuitem');
      button.disabled = isCurrent;
      if (isCurrent) button.setAttribute('aria-current', 'true');

      // Leading check gutter (reuses .menu-item-icon) so names align with the
      // hamburger's Profiles row; only the current profile shows the ✓.
      const check = document.createElement('span');
      check.className = 'menu-item-icon menu-item-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = isCurrent ? '✓' : '';

      const label = document.createElement('span');
      label.className = 'menu-item-label';
      label.textContent = displayName;
      // Recover the full name on hover when the label clips to "…", using the
      // app-wide hover tooltip (shared appear delay) rather than native `title`.
      bindHoverTooltip(label, (el) => (el.scrollWidth > el.clientWidth ? displayName : ''));

      button.append(check, label);

      if (!isCurrent) {
        button.addEventListener('click', async () => {
          // The disabled row is the in-progress feedback; deliberately no
          // "Opening…" status line — it renders as a stray item at the bottom
          // of the flyout and now lingers because the open awaits a real focus
          // ack. Only surface the error case below.
          button.disabled = true;
          try {
            const result = await electronAPI.openProfile?.(profile.id);
            if (!result?.success) {
              throw new Error(result?.error?.message || 'Profile could not be opened');
            }
            // Switching focuses/opens the target profile's own window; dismiss
            // the whole hamburger here rather than just collapsing the flyout.
            closeAllMenus();
          } catch (err) {
            setMenuStatus(err?.message || 'Profile could not be opened', 'error');
          } finally {
            // Always re-enable: on failure so the user can retry, on success so
            // the row isn't left stuck disabled when the menu is reopened.
            button.disabled = false;
          }
        });
      }

      profileList.append(button);
    }
  };

  const refreshProfileList = async () => {
    if (!profileList) return;
    setMenuStatus('', '');
    try {
      const result = await electronAPI.listProfiles?.();
      if (!result?.success) {
        throw new Error(result?.error?.message || 'Profile list unavailable');
      }
      renderProfileList(result.profiles || []);
    } catch (err) {
      renderProfileList(activeProfile ? [activeProfile] : []);
      setMenuStatus(err?.message || 'Profile list unavailable', 'error');
    }
  };

  // macOS-style submenu: open after a short hover delay. It deliberately does
  // NOT close on mouse-out — once open it stays until a click lands outside it
  // (handled below). The flyout is a child of #menu-dropdown, so the hamburger's
  // outside-click handler treats flyout clicks as inside — the hamburger stays
  // open with it. Timing lives in the shared attachSubmenuHover helper.
  const openFlyout = () => {
    // Don't open while the hamburger itself is closed (the dropdown — and thus
    // this wrapper — isn't rendered), e.g. if a hover open-timer fires just
    // after the menu was dismissed.
    if (!menuWrap || menuWrap.offsetParent === null) return;
    if (menu?.hidden !== false) {
      setMenuOpen(true);
      refreshProfileList();
    }
  };

  const flyoutHover = attachSubmenuHover(menuWrap, {
    open: openFlyout,
    closeOnLeave: false,
  });

  closeProfileMenu = () => {
    flyoutHover.cancel();
    setMenuOpen(false);
  };

  // Click opens immediately (keyboard/tap), bypassing the hover delay; it never
  // toggles closed while the cursor is over the row.
  indicator.addEventListener('click', flyoutHover.openNow);

  // The flyout no longer closes on mouse-out, so dismiss it on click-out: a
  // click inside the wrapper (trigger or flyout) keeps it open; a click on any
  // other hamburger row collapses just the flyout. Clicks fully outside the
  // hamburger are handled in menus.js, which hides the flyout when the dropdown
  // closes. Pointerdown (not click) so the dismissal isn't pre-empted by a row
  // that closes the whole menu on click.
  document.addEventListener('pointerdown', (event) => {
    if (menu?.hidden !== false) return;
    if (menuWrap?.contains(event.target)) return;
    flyoutHover.cancel();
    setMenuOpen(false);
  });

  // Also dismiss when the window loses focus (e.g. alt-tab), matching the app's
  // other transient menus (bookmarks, tab/context menus, autocomplete) and the
  // old profile menu's behaviour — the flyout shouldn't linger over an inactive
  // window.
  window.addEventListener('blur', () => {
    if (menu?.hidden !== false) return;
    closeProfileMenu();
  });

  createBtn?.addEventListener('click', openCreateModal);
  manageBtn?.addEventListener('click', openProfilesManager);
  createCancelBtn?.addEventListener('click', closeCreateModal);
  createCloseBtn?.addEventListener('click', closeCreateModal);
  createModal?.addEventListener('cancel', (event) => {
    if (creatingProfile) event.preventDefault();
  });
  createModal?.addEventListener('click', (event) => {
    if (event.target === createModal) closeCreateModal();
  });
  createForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (creatingProfile) return;

    const displayName = createNameInput?.value.trim();
    if (!displayName) {
      setCreateStatus('Enter a profile name.', 'error');
      createNameInput?.focus();
      return;
    }

    setCreateBusy(true);
    setCreateStatus('Creating profile...', 'success');
    try {
      const createResult = await electronAPI.createProfile?.({ displayName });
      if (!createResult?.success) {
        throw new Error(createResult?.error?.message || 'Profile could not be created');
      }

      const profile = createResult.profile;
      const profileId = profile?.id;
      if (!profileId) {
        throw new Error('Profile was created but no profile id was returned');
      }

      setCreateStatus(`Opening ${profile.displayName || displayName}...`, 'success');
      const openResult = await electronAPI.openProfile?.(profileId);
      if (!openResult?.success) {
        throw new Error(
          openResult?.error?.message || 'Profile was created but could not be opened'
        );
      }

      setCreateBusy(false);
      closeCreateModal();
      refreshProfileList();
    } catch (err) {
      setCreateStatus(err?.message || 'Profile could not be created', 'error');
      setCreateBusy(false);
      createNameInput?.focus();
    }
  });
  // The native menu and the manager page open this same create modal via a
  // main→renderer round trip, regardless of which tab/page is active.
  electronAPI.onShowCreateProfileModal?.(() => openCreateModal());

  const renderProfile = (profile) => {
    activeProfile = profile;
    const label = profile?.displayName || profile?.id;
    if (!label) return;

    nameEl.textContent = label;
    indicator.title = profile?.isDev ? `${label} (dev)` : label;
    if (menu?.hidden === false) refreshProfileList();
  };

  electronAPI.onProfileUpdated?.(renderProfile);

  try {
    const profile = await electronAPI.getActiveProfile?.();
    renderProfile(profile);
  } catch (err) {
    pushDebug(`[profile] Failed to load active profile: ${err?.message || err}`);
  }
}

// Close all menus and context menus
const closeAllMenus = () => {
  closeMenus();
  closeProfileMenu();
  hideTabContextMenu();
  hideBookmarkContextMenu();
  hidePageContextMenu();
  hideChromeInputContextMenu();
};

// Close everything including autocomplete (used by backdrop)
const closeAllOverlays = () => {
  closeAllMenus();
  hideAutocomplete();
};

// Listen for close menus from main process (e.g., system menu clicked)
// Don't close autocomplete here - mirrors browser behavior where address bar stays open
electronAPI.onCloseMenus?.(closeAllMenus);

// Internal pages can deep-link into the sidebar publish-setup checklist.
electronAPI.onOpenPublishSetup?.(openPublishSetupFlow);

// Initialize update notification toast
function initUpdateNotifications() {
  const toast = document.getElementById('update-toast');
  const message = document.getElementById('update-toast-message');
  const actionBtn = document.getElementById('update-toast-action');
  const closeBtn = document.getElementById('update-toast-close');

  if (!toast || !message || !actionBtn || !closeBtn) return;

  let autoHideTimeout = null;

  const showToast = (text, showAction = false, actionLabel = 'Install now') => {
    message.textContent = text;
    actionBtn.hidden = !showAction;
    actionBtn.textContent = actionLabel;
    actionBtn.disabled = false;
    toast.hidden = false;

    // Clear any existing timeout
    if (autoHideTimeout) clearTimeout(autoHideTimeout);

    // Auto-hide after 8 seconds (unless action button is shown)
    if (!showAction) {
      autoHideTimeout = setTimeout(() => hideToast(), 8000);
    }
  };

  const hideToast = () => {
    toast.hidden = true;
  };

  closeBtn.addEventListener('click', hideToast);

  actionBtn.addEventListener('click', () => {
    actionBtn.textContent = 'Installing…';
    actionBtn.disabled = true;
    electronAPI.restartAndInstallUpdate?.();
  });

  // Listen for update notifications from main process
  electronAPI.onUpdateNotification?.((data) => {
    pushDebug(`[update] Received notification: ${data.type}`);
    if (data.type === 'ready') {
      showToast(data.message, true, data.actionLabel || 'Install now');
    } else {
      // checking, downloading, up-to-date
      showToast(data.message, false);
    }
  });
}

// Listen for open-url-new-tab custom event from context menu
document.addEventListener('open-url-new-tab', (e) => {
  const url = e.detail?.url;
  if (url) {
    createTab(url);
  }
});

// Initialize all modules
window.addEventListener('DOMContentLoaded', async () => {
  try {
    applySettingsToState(await electronAPI.getSettings());
  } catch {
    applySettingsToState(null);
  }
  window.addEventListener('settings:updated', (event) => {
    applySettingsToState(event.detail);
  });

  initShortcuts(); // Live shortcut bindings — before any keydown consumers
  initMenuBackdrop(closeAllOverlays);
  initMenus();
  initAntUi();
  initIpfsUi();
  initMyotisUi();
  initRadicleUi();
  initTorUi();
  initGithubBridgeUi();
  document.getElementById('settings-btn')?.addEventListener('click', () => {
    closeMenus();
    loadTarget('freedom://settings');
  });
  initBookmarks();
  initNavigation(); // Sets up event handler with tabs module
  initSitePermissionsUi(); // Permission prompt + address-bar indicator
  initLinkStatus();
  initFindBar({ getActiveWebview }); // In-page find bar (Cmd/Ctrl+F)
  initTabs(); // Creates first tab and starts loading home page
  initAutocomplete(); // Address bar autocomplete
  initPageContextMenu(); // Page context menu for webviews
  initChromeInputContextMenu({ onOpening: onAnyMenuOpening }); // Address bar edit menu
  initOnboarding(); // Identity onboarding wizard
  initSidebar(); // Identity & wallet sidebar
  initWalletUi(); // Wallet & identity display in sidebar
  initRadicleConsent(); // Radicle provider consent subscreen (sidebar)
  initRadicleAlias(); // Radicle alias display/editing in the Nodes tab
  loadBookmarks();
  initExternalNodeCandidatesModal();
  initPlatformUI();
  initProfileIndicator();
  initUpdateNotifications();
  initDownloadsUi(); // Download shelf cards (bottom-right)
});
